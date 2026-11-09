/** 出站动作把批准与实际执行分开保存；逐项隔离故障，票只消费一次，结果总能回到机器人的感知记录。 */
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import { z } from 'zod';
import type { HubContext } from '../engine/context.js';
import { parseInput } from '../engine/validation.js';
import { nonempty, text } from '../model/primitives.js';
import { OutboxActionSchema, type OutboxAction } from '../model/outreach.js';
import { newId } from '../util/ids.js';
import { optionalMessageText, truncateBytes } from '../util/text.js';
import { classifyToolCall } from './classify.js';
import { classifyPath, mostDangerous, resolveGatePath, within, type Classification } from './paths.js';
import { resolveRealTarget } from './real-path.js';
import { checkGitBoundaries } from './git-boundary.js';
import { decide } from './matrix.js';
import { gateContextFor, recordViolation } from './guard.js';
import { requestApproval, consumeTicket, approvalContentHash } from './approvals.js';
import { postThread } from '../outreach/thread.js';
import { requestPush } from '../outreach/push.js';
import { recordPercept } from '../perception/percept.js';
import { approvedOutboxResult, shortFailure, transportFailure } from '../util/outbox-text.js';
import { ownerActivityText } from '../util/owner-text.js';
import { stableStringify } from '../util/hash.js';
import { captureCommandFiles } from './command-files.js';

// 四种动作共用扁平字段清单；模型先看到全部字段，按 kind 的必填关系由后面的校验负责。
const payloadFields = {
  text: nonempty.refine(value => optionalMessageText(value) !== null, 'text 汇报不能为空、只有空白或 null 占位')
    .describe('仅 kind=notify_owner 时需要：给主人汇报的正文，必填，不能是空白或 null 占位'),
  importance: z.number().int('importance 必须是整数').min(1).max(10).describe('仅 kind=notify_owner 时需要：汇报重要度 1–10，可省略'),
  path: nonempty.describe('仅 kind=write_file 时需要：写入文件路径，必填'),
  content: text.describe('仅 kind=write_file 时需要：文件正文，必填，可以是空字符串'),
  url: z.url('url 必须是有效网址').refine(v => /^https?:\/\//.test(v), 'url 只支持 HTTP 或 HTTPS').describe('仅 kind=http_post 时需要：HTTP 或 HTTPS 地址，必填'),
  body: text.describe('仅 kind=http_post 时需要：请求正文，必填，可以是空字符串'),
  headers: z.record(text, text).describe('仅 kind=http_post 时需要：请求头键值对象，可省略'),
  cmd: nonempty.describe('仅 kind=run_command 时需要：命令程序名，必填'),
  args: z.array(text).describe('仅 kind=run_command 时需要：参数数组，必填，无参数时传空数组'),
  cwd: nonempty.refine(v => v.startsWith('/'), 'cwd 必须为绝对路径').describe('仅 kind=run_command 时需要：执行目录的绝对路径，必填'),
};
// 保留每种动作的严格字段集合，避免扁平展示使无关字段悄悄进入审批票或执行参数。
const payloadSchemas = {
  notify_owner: z.strictObject({ text: payloadFields.text, importance: payloadFields.importance.optional() }),
  write_file: z.strictObject({ path: payloadFields.path, content: payloadFields.content }),
  http_post: z.strictObject({ url: payloadFields.url, body: payloadFields.body, headers: payloadFields.headers.optional() }),
  run_command: z.strictObject({ cmd: payloadFields.cmd, args: payloadFields.args, cwd: payloadFields.cwd }),
};
export type OutboxInput = { [Kind in keyof typeof payloadSchemas]: {
  kind: Kind; why: string; payload: z.infer<(typeof payloadSchemas)[Kind]>;
} }[keyof typeof payloadSchemas];
export const OutboxInputSchema = z.strictObject({
  kind: z.enum(['notify_owner', 'write_file', 'http_post', 'run_command'], { error: 'kind 必须是 notify_owner、write_file、http_post 或 run_command' }),
  why: nonempty.trim().min(1, 'why 原因不能为空'),
  payload: z.strictObject(payloadFields).partial(),
}).superRefine((input, ctx) => {
  const parsed = payloadSchemas[input.kind].safeParse(input.payload);
  if (parsed.success) return;
  for (const issue of parsed.error.issues) {
    const field = issue.path[0];
    const missing = typeof field === 'string' && input.payload[field as keyof typeof input.payload] === undefined;
    ctx.addIssue({ ...issue, path: ['payload', ...issue.path], message: missing
      ? `kind=${input.kind} 时缺少 payload.${field}` : issue.message });
  }
// superRefine 已逐项通过对应的严格 payload schema，输出可安全按 kind 收窄，执行代码无需断言字段存在。
}) as z.ZodType<OutboxInput>;
const executing = new WeakMap<HubContext, Set<string>>();
/** 将出站参数交给统一动作分类，防止提交渠道绕开权限和复盘限制。 */
async function actionFor(ctx: HubContext, botId: string, input: OutboxInput): Promise<Classification> {
  const bot = ctx.store.table('bots').get(botId)!;
  const gctx = gateContextFor(ctx, bot);
  if (input.kind === 'notify_owner') return { cls: 'A', reason: '直接给主人汇报', subclass: 'hub_tool' };
  if (gctx.reflection && input.kind !== 'write_file') return { cls: 'C', reason: '复盘回合不执行对外出站动作', subclass: 'reflection_outbox' };
  if (input.kind === 'http_post') return classifyToolCall('web_fetch', { url: input.payload.url, method: 'POST' }, gctx);
  if (input.kind === 'write_file') {
    const original = resolveGatePath(input.payload.path, gctx);
    const real = await resolveRealTarget(ctx.fs, original);
    // macOS 的 /var 与 /private/var 等别名同样先解析根目录，避免合法家内文件被误判出界。
    const realContext = { ...gctx, homeDir: await resolveRealTarget(ctx.fs, bot.homeDir),
      rootDir: await resolveRealTarget(ctx.fs, gctx.rootDir), sharedDir: await resolveRealTarget(ctx.fs, gctx.sharedDir) };
    const action = mostDangerous([classifyPath(original, true, gctx), classifyPath(real, true, realContext)]);
    // 家内名称指向家外，不能借审批的原路径暗中扩大写入目标。
    if (within(original, bot.homeDir) && !within(real, realContext.homeDir)) return { cls: 'protected', reason: '出站文件符号链接指向家目录边界外，拒绝写入' };
    return action;
  }
  const action = await checkGitBoundaries(ctx.fs, classifyToolCall('run_command', input.payload, gctx), gctx);
  return action.cls === 'A' || action.cls === 'B'
    ? { ...action, cls: 'C', subclass: 'host_command', reason: '这条命令由中心在 DSH 沙箱外运行，要主人批准' } : action;
}
/** 批准只绑定动作与内容，说明文字变化不产生另一张票。 */
const ticketArgs = (input: Pick<OutboxAction, 'kind' | 'payload' | 'commandFiles'>) => ({ kind: input.kind, payload: input.payload,
  ...(input.kind === 'run_command' ? { commandFiles: input.commandFiles ?? [] } : {}) });
/** 宿主命令没有会话沙箱保护，L3 的任何子类授权也不能替代这一次主人的批准。 */
function outboxDecision(ctx: HubContext, botId: string, input: OutboxInput, action: Classification) {
  const bot = ctx.store.table('bots').get(botId)!;
  const decision = decide(action, bot.autonomy, bot.lifecycle, ctx.settings.l3Grants);
  return input.kind === 'run_command' && decision !== 'deny' ? 'approval' : decision;
}
/** 文件检查会让出执行权；同步记录权限上下文，检查完成后变化了就交给下一轮重新核验。 */
function permissionStamp(ctx: HubContext, botId: string): string {
  const bot = ctx.store.table('bots').get(botId);
  return stableStringify(bot ? { gate: gateContextFor(ctx, bot), lifecycle: bot.lifecycle, grants: ctx.settings.l3Grants } : null);
}
/** 不能拿检查前的出站快照覆盖主人在检查期间做出的停止或票据变更。 */
function stillCurrent(ctx: HubContext, row: OutboxAction, stamp: string): boolean {
  return permissionStamp(ctx, row.botId) === stamp && stableStringify(ctx.store.table('outbox').get(row.id)) === stableStringify(row);
}
/** 校验提交身份并去重，需审批的先存单，避免未经授权就产生副作用。 */
export async function submitOutbox(ctx: HubContext, botId: string, raw: unknown): Promise<OutboxAction> {
  parseInput(nonempty, botId, '出站 botId');
  const input = parseInput(OutboxInputSchema, raw, '出站动作');
  const bot = ctx.store.table('bots').get(botId);
  if (!bot) throw new Error('出站 botId 对应机器人不存在');
  const autonomy = bot.lifecycle === 'probation' ? 'L1' : bot.autonomy;
  if (autonomy === 'L0' || !['active', 'probation'].includes(bot.lifecycle)) throw new Error('当前机器人不能提交出站动作');
  const stamp = permissionStamp(ctx, botId);
  const action = await actionFor(ctx, botId, input);
  if (action.cls === 'protected' || action.subclass === 'work_data') {
    await recordViolation(ctx, botId, action.reason);
    throw new Error(action.reason);
  }
  if (gateContextFor(ctx, bot).reflection && action.cls !== 'A') throw new Error('复盘回合只允许写自己的 work、MEMORY.md 与 playbooks，不执行对外动作');
  const decision = outboxDecision(ctx, botId, input, action);
  if (decision === 'deny') throw new Error(`当前自主等级不允许：${action.reason}`);
  const boundInput = { ...input, ...(input.kind === 'run_command'
    ? { commandFiles: await captureCommandFiles(ctx, botId, input.payload) } : {}) };
  if (stamp !== permissionStamp(ctx, botId)) throw new Error('机器人状态或权限已变化，请重新提交出站动作');
  const hash = approvalContentHash('hub_outbox_execute', ticketArgs(boundInput));
  const existing = ctx.store.table('outbox').list(o => o.botId === botId && ['pending_approval', 'ready'].includes(o.status)
    && approvalContentHash('hub_outbox_execute', ticketArgs(o)) === hash)[0];
  if (existing) return existing;
  const now = ctx.clock.now();
  let row = parseInput(OutboxActionSchema, { id: newId('o', ctx.rng), botId, ...boundInput, actionClass: action.cls,
    approvalId: null, status: decision === 'approval' ? 'pending_approval' : 'ready', result: null, createdAt: now, doneAt: null }, '出站记录');
  ctx.store.table('outbox').put(row);
  if (decision === 'approval') {
    const approval = await requestApproval(ctx, botId, 'hub_outbox_execute', ticketArgs(row), action.cls === 'D' ? 'D' : 'C', `${action.reason}。申请理由：${input.why}`);
    row = ctx.store.table('outbox').patch(row.id, { approvalId: approval.id });
  } else if (input.kind === 'notify_owner') {
    const active = executing.get(ctx) ?? new Set<string>();
    executing.set(ctx, active);
    active.add(row.id);
    try {
      await executeOne(ctx, row);
    } finally {
      active.delete(row.id);
    }
    row = ctx.store.table('outbox').get(row.id)!;
  }
  ctx.emit(HUB_EVENT_SCOPES.bot, botId);
  return row;
}

/** 运行前再次检查生命周期、受保护路径和当前权限；批准不等于永久豁免。 */
export async function executeReadyOutbox(ctx: HubContext): Promise<void> {
  const active = executing.get(ctx) ?? new Set<string>();
  executing.set(ctx, active);
  for (let row of ctx.store.table('outbox').list(o => ['pending_approval', 'ready'].includes(o.status))) {
    if (active.has(row.id)) continue;
    active.add(row.id);
    try {
      // 拒绝和过期的收尾不依赖在岗状态；暂停也必须结束这张出站单，不能永远停在待批。
      const approval = row.approvalId ? ctx.store.table('approvals').get(row.approvalId) : null;
      if (approval && (['rejected', 'expired', 'used'].includes(approval.status) || approval.expiresAt <= ctx.clock.now())) {
        ctx.store.table('outbox').patch(row.id, { status: 'rejected', result: '审批已拒绝、过期或批准票已使用', executionStarted: false, doneAt: ctx.clock.now() });
        continue;
      }
      // 待主人决定时尚无执行资格；不能提前把之后可能恢复的环境变化写成已批准动作失败。
      const legacyCommand = row.kind === 'run_command' && row.commandFiles === undefined;
      if (approval?.status === 'pending' && !legacyCommand) continue;
      const bot = ctx.store.table('bots').get(row.botId);
      if (!bot || !['active', 'probation'].includes(bot.lifecycle)) continue;
      // 复盘只是暂时只读，不能消耗批准票或终结已批准动作；结束后再做完整权限复查。
      if (approval?.status === 'approved' && gateContextFor(ctx, bot).reflection) continue;
      const stamp = permissionStamp(ctx, row.botId);
      const input = parseInput(OutboxInputSchema, { kind: row.kind, payload: row.payload, why: row.why }, '出站执行');
      const action = await actionFor(ctx, row.botId, input);
      if (action.cls === 'protected' || action.subclass === 'work_data') throw new Error(action.reason);
      if (gateContextFor(ctx, bot).reflection && action.cls !== 'A') continue;
      const decision = outboxDecision(ctx, row.botId, input, action);
      if (decision === 'deny') throw new Error(`当前自主等级不允许：${action.reason}`);
      // 升级前的 ready 单和未绑定内容的旧批准票都重新采集、重新审批，绝不追认旧权限。
      if (input.kind === 'run_command' && (!row.approvalId || legacyCommand)) {
        const commandFiles = await captureCommandFiles(ctx, row.botId, input.payload);
        if (!stillCurrent(ctx, row, stamp)) continue;
        if (legacyCommand && approval) invalidateOutboxApproval(ctx, approval.id);
        row = ctx.store.table('outbox').patch(row.id, { commandFiles, actionClass: action.cls, approvalId: null });
      }
      if (!row.approvalId && decision === 'approval') {
        const requested = await requestApproval(ctx, row.botId, 'hub_outbox_execute', ticketArgs(row), action.cls === 'D' ? 'D' : 'C', `${action.reason}。申请理由：${row.why}`);
        ctx.store.table('outbox').patch(row.id, { status: 'pending_approval', actionClass: action.cls, approvalId: requested.id });
        continue;
      }
      if (input.kind === 'run_command') {
        // 比较整份新快照，删除、不可读、链接改向和批准后新建的脚本都不能沿用原票。
        let unchanged = false;
        try { unchanged = stableStringify(await captureCommandFiles(ctx, row.botId, input.payload)) === stableStringify(row.commandFiles ?? []); }
        catch { /* 不能确认内容时按变化拒绝，不把读取故障变成放行。 */ }
        if (!stillCurrent(ctx, row, stamp)) continue;
        if (!unchanged) {
          finish(ctx, row, false, '脚本在批准后被改动', false, '脚本在批准后被改动', 'rejected');
          if (row.approvalId) invalidateOutboxApproval(ctx, row.approvalId);
          continue;
        }
      }
      // 从最终同步核验到消费票、调用 ExecIO 之间没有 await，暂停、降级和复盘不会沿旧上下文漏过。
      if (!stillCurrent(ctx, row, stamp)) continue;
      if (row.approvalId && !consumeTicket(ctx, row.botId, 'hub_outbox_execute', ticketArgs(row), row.approvalId)) continue;
      await executeOne(ctx, row);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      finish(ctx, row, false, reason, false, shortFailure(reason, ctx.settings.c03.approvalOwnerParamsMaxChars));
    } finally {
      active.delete(row.id);
    }
  }
}
/** 内容失效或旧票迁移都使原票不可再用；不伪造主人拒绝或已执行的事实。 */
function invalidateOutboxApproval(ctx: HubContext, id: string): void {
  ctx.store.table('approvals').patch(id, { status: 'rejected' });
  for (const card of ctx.store.table('inbox').list(item => item.type === 'approval' && item.refId === id && item.status === 'open')) {
    ctx.store.table('inbox').patch(card.id, { status: 'withdrawn' });
  }
  ctx.emit(HUB_EVENT_SCOPES.inbox);
}
/** 执行一个已放行的动作，分别记录命令失败原因，错误只结束当前动作。 */
async function executeOne(ctx: HubContext, row: OutboxAction): Promise<void> {
  let executionStarted = false;
  let ownerFailureReason: string | undefined;
  try {
    const input = parseInput(OutboxInputSchema, { kind: row.kind, payload: row.payload, why: row.why }, '出站执行');
    let result: string;
    if (input.kind === 'notify_owner') {
      executionStarted = true;
      postThread(ctx, { thread: row.botId, from: row.botId, kind: 'report', text: input.payload.text, refId: row.id });
      if ((input.payload.importance ?? 1) >= ctx.settings.c03.reportPushImportance) {
        try {
          await requestPush(ctx, { botId: row.botId, level: 'P2', title: '机器人汇报', body: input.payload.text, subjectKey: `outbox:${row.id}` });
        } catch (error) {
          finish(ctx, row, true, `汇报已进入线程；单推失败：${error instanceof Error ? error.message : String(error)}`);
          return;
        }
      }
      result = '汇报已进入线程';
    } else if (input.kind === 'write_file') {
      const bot = ctx.store.table('bots').get(row.botId)!;
      const gctx = gateContextFor(ctx, bot);
      const action = await actionFor(ctx, row.botId, input);
      if (action.cls === 'protected' || action.subclass === 'work_data') throw new Error(action.reason);
      const actual = await resolveRealTarget(ctx.fs, resolveGatePath(input.payload.path, gctx));
      executionStarted = true;
      await ctx.fs.writeTextAtomic(actual, input.payload.content);
      result = `已写入 ${input.payload.path}`;
    } else if (input.kind === 'http_post') {
      executionStarted = true;
      const response = await ctx.net.post(input.payload.url, input.payload.body, { timeoutMs: ctx.settings.httpTimeoutMs, maxBytes: ctx.settings.httpMaxBytes, headers: input.payload.headers });
      if (response.status < 200 || response.status >= 300) {
        ownerFailureReason = `HTTP ${response.status}，请求未成功`;
        throw new Error(`HTTP ${response.status}：${response.text}`);
      }
      result = `HTTP ${response.status}：${response.text}`;
    } else {
      executionStarted = true;
      const response = await ctx.exec.run(input.payload.cmd, input.payload.args, { cwd: input.payload.cwd, timeoutMs: ctx.settings.scriptTimeoutMs, maxOutputBytes: ctx.settings.scriptMaxOutputBytes });
      // 软截断不改变真实退出结果；硬终止、超时和其他信号分别保留原因。
      ownerFailureReason = response.timedOut ? '命令超时' : response.killedForOutput ? '命令输出超过硬上限，已终止进程组'
        : response.code === null ? '命令被信号终止，未返回退出码' : response.code !== 0 ? `命令退出码 ${response.code}` : undefined;
      if (ownerFailureReason) throw new Error(`${ownerFailureReason}：${response.stderr}`);
      result = response.outputTruncated
        ? `命令执行完成（输出已截断）：${response.stdout}`
        : response.stdout || '命令执行完成';
    }
    finish(ctx, row, true, result, executionStarted);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const trusted = ownerFailureReason ?? (!executionStarted || row.kind === 'write_file'
      ? shortFailure(reason, ctx.settings.c03.approvalOwnerParamsMaxChars)
      : row.kind === 'http_post' || row.kind === 'run_command' ? transportFailure(reason, row.kind === 'http_post') : '通知未能完成');
    finish(ctx, row, false, reason, executionStarted, trusted);
  }
}
/** 保存有界结果并产生一次系统感知，让机器人知道动作实际完成或失败。 */
function finish(ctx: HubContext, row: OutboxAction, ok: boolean, text: string, executionStarted = true, ownerFailureReason?: string, failureStatus: 'failed' | 'rejected' = 'failed'): void {
  const result = truncateBytes(text, ctx.settings.c03.outboxResultMaxBytes);
  const updated = ctx.store.table('outbox').patch(row.id, { status: ok ? 'done' : failureStatus, result, executionStarted,
    ...(ownerFailureReason ? { ownerFailureReason } : {}), doneAt: ctx.clock.now() });
  // 主人批准的动作必须交回一条可读结果；HTTP 只展示状态码，外部正文仍留给唤醒包的不可信证据区。
  if (row.approvalId && ['approved', 'used'].includes(ctx.store.table('approvals').get(row.approvalId)?.status ?? '')) {
    postThread(ctx, { thread: row.botId, from: 'hub', kind: 'system',
      text: approvedOutboxResult(updated, ctx.settings.c03.actionCommandMaxChars), refId: row.id });
  }
  const bot = ctx.store.table('bots').get(row.botId);
  if (bot) ctx.store.table('bots').patch(bot.id, { activityText: ownerActivityText(ctx, bot) });
  recordPercept(ctx, { botId: row.botId, watchId: null, source: 'system', kind: 'outbox_done', summary: `出站动作 ${row.id} ${ok ? '完成' : '失败'}：${result}`,
    location: row.id, fingerprintMaterial: ['outbox_done', row.id], magnitude: 1, anomaly: false, untrusted: row.kind !== 'notify_owner', occurredAt: ctx.clock.now() });
  ctx.emit(HUB_EVENT_SCOPES.bot, row.botId);
}

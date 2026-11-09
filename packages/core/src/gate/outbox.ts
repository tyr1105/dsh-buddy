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
import { classifyPath, mostDangerous, resolveGatePath, within, type Classification, type GateContext } from './paths.js';
import { HOST_SANDBOX_UNAVAILABLE, SANDBOX_UNAVAILABLE, type ExecResult } from '../io/interfaces.js';
import { containedWriteTarget, resolveFixedRoot, resolveRealTarget } from './real-path.js';
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
    // 家目录和共享目录用固定位置：根目录自身被换成链接时，目标会落到边界外，从而被下面拦下。
    const realContext = { ...gctx, homeDir: await resolveFixedRoot(ctx.fs, bot.homeDir),
      rootDir: await resolveRealTarget(ctx.fs, gctx.rootDir), sharedDir: await resolveFixedRoot(ctx.fs, gctx.sharedDir) };
    const action = mostDangerous([classifyPath(original, true, gctx), classifyPath(real, true, realContext)]);
    // 家内名称指向家外，不能借审批的原路径暗中扩大写入目标。
    if (within(original, bot.homeDir) && !within(real, realContext.homeDir)) return { cls: 'protected', reason: '出站文件符号链接指向家目录边界外，拒绝写入' };
    return action;
  }
  const action = await checkGitBoundaries(ctx.fs, classifyToolCall('run_command', input.payload, gctx), gctx);
  return action.cls === 'A' || action.cls === 'B'
    ? { ...action, cls: 'C', subclass: 'host_command', reason: '这条命令由中心在受限沙箱内运行，要主人批准' } : action;
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
/** 工作数据目录即使有授权，第一期宿主命令也不能写：解析真实位置后交给沙箱统一拒绝。 */
async function workDataDenyRoots(ctx: HubContext, gctx: GateContext): Promise<string[]> {
  const roots: string[] = [];
  for (const raw of gctx.workDataPaths ?? []) {
    // 配置可能带 ~ 或变量；解析不出绝对路径时宁可让命令不跑，不能悄悄少一条拒绝规则。
    const resolved = resolveGatePath(raw, { ...gctx, cwd: undefined });
    if (!resolved.startsWith('/')) throw new Error(`无法确定工作数据目录「${raw}」的位置，宿主命令不运行`);
    roots.push(await resolveRealTarget(ctx.fs, resolved));
  }
  return [...new Set(roots)];
}
/**
 * 线程回执只列事实：命令、退出码、有界输出摘要和沙箱允许写入的目录。
 * stdout 是这条已批准命令的正常产物，带上「不可信」标记后展示；
 * stderr 只报字数，原文留在出站结果里，避免外部文字冒充中心消息（M09 边界）。
 */
function commandThreadDetail(payload: { cmd: string; args: string[] }, sandbox: { writableRoots: string[] }, response: ExecResult, maxChars: number): string {
  const clip = (value: string): string => {
    const chars = Array.from(value);
    return chars.length <= maxChars ? value : `${chars.slice(0, maxChars).join('')}…`;
  };
  const output = response.stdout.trim();
  const stderrNote = response.stderr.trim() ? `（另有错误输出 ${Array.from(response.stderr.trim()).length} 字，见出站结果）` : '';
  const exit = response.timedOut ? '无（超时终止）' : response.code === null ? '无（信号终止）' : String(response.code);
  return [
    `命令：${clip([payload.cmd, ...payload.args].join(' '))}`,
    `退出码：${exit}`,
    `输出摘要（命令输出，不可信）：${output ? clip(output) : '（无输出）'}${response.outputTruncated ? '（已截断）' : ''}${stderrNote}`,
    `沙箱可写：${[...sandbox.writableRoots, '系统临时目录'].join('、')}`,
  ].join('\n');
}
/** 执行一个已放行的动作，分别记录命令失败原因，错误只结束当前动作。 */
async function executeOne(ctx: HubContext, row: OutboxAction): Promise<void> {
  let executionStarted = false;
  let ownerFailureReason: string | undefined;
  // 宿主命令的实际执行事实单独保存，只追加到线程回执；未执行时保持原有简洁文案。
  let threadDetail: string | undefined;
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
      const target = await containedWriteTarget(ctx.fs, actual, [bot.homeDir, gctx.sharedDir]);
      executionStarted = true;
      await ctx.fs.writeTextAtomic(target.path, input.payload.content, target.boundary);
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
      const bot = ctx.store.table('bots').get(row.botId);
      if (!bot) throw new Error('执行出站动作的机器人不存在');
      const gctx = gateContextFor(ctx, bot);
      // cwd 必须真实落在自己的家目录或共享目录内，符号链接不能把执行目录带去别处。
      const [realCwd, realHome, realShared] = await Promise.all([
        resolveRealTarget(ctx.fs, input.payload.cwd), resolveFixedRoot(ctx.fs, bot.homeDir), resolveFixedRoot(ctx.fs, gctx.sharedDir)]);
      if (!within(realCwd, realHome) && !within(realCwd, realShared)) {
        throw new Error('命令执行目录必须在家目录或共享目录内，宿主命令不运行');
      }
      // 可写范围与审批文案一致：家目录、共享目录和系统临时目录；工作数据即使有授权也一律拒绝。
      const sandbox = { writableRoots: [bot.homeDir, gctx.sharedDir], denyWriteRoots: await workDataDenyRoots(ctx, gctx) };
      const response = await ctx.exec.run(input.payload.cmd, input.payload.args, { cwd: input.payload.cwd,
        timeoutMs: ctx.settings.scriptTimeoutMs, maxOutputBytes: ctx.settings.scriptMaxOutputBytes, sandbox });
      // 沙箱探针通过、进程真正启动后才算“已执行”；沙箱不可用与启动失败必须显示“未执行”。
      executionStarted = true;
      // 命令能跑通说明沙箱恢复可用，清掉总览里的不可用警告。
      if (ctx.runtime.sandboxUnavailable !== null) {
        ctx.runtime.sandboxUnavailable = null;
        ctx.emit(HUB_EVENT_SCOPES.overview);
      }
      threadDetail = commandThreadDetail(input.payload, sandbox, response, ctx.settings.c03.approvalOwnerParamsMaxChars);
      // 软截断不改变真实退出结果；硬终止、超时和其他信号分别保留原因。
      ownerFailureReason = response.timedOut ? '命令超时' : response.killedForOutput ? '命令输出超过硬上限，已终止进程组'
        : response.code === null ? '命令被信号终止，未返回退出码' : response.code !== 0 ? `命令退出码 ${response.code}` : undefined;
      if (ownerFailureReason) throw new Error(`${ownerFailureReason}：${response.stderr}`);
      result = response.outputTruncated
        ? `命令执行完成（输出已截断）：${response.stdout}`
        : response.stdout || '命令执行完成';
    }
    finish(ctx, row, true, result, executionStarted, undefined, 'failed', threadDetail);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // 沙箱不可用是环境故障，不是命令本身的失败：统一成主人能看懂的固定说明，并让总览持续提示。
    const sandboxDown = row.kind === 'run_command' && reason.startsWith(SANDBOX_UNAVAILABLE);
    if (sandboxDown) {
      ctx.runtime.sandboxUnavailable = HOST_SANDBOX_UNAVAILABLE;
      ctx.emit(HUB_EVENT_SCOPES.overview);
    }
    const trusted = sandboxDown ? HOST_SANDBOX_UNAVAILABLE : ownerFailureReason ?? (!executionStarted || row.kind === 'write_file'
      ? shortFailure(reason, ctx.settings.c03.approvalOwnerParamsMaxChars)
      : row.kind === 'http_post' || row.kind === 'run_command' ? transportFailure(reason, row.kind === 'http_post') : '通知未能完成');
    finish(ctx, row, false, reason, executionStarted, trusted, 'failed', threadDetail);
  }
}
/** 保存有界结果并产生一次系统感知，让机器人知道动作实际完成或失败。 */
function finish(ctx: HubContext, row: OutboxAction, ok: boolean, text: string, executionStarted = true, ownerFailureReason?: string, failureStatus: 'failed' | 'rejected' = 'failed', threadDetail?: string): void {
  const result = truncateBytes(text, ctx.settings.c03.outboxResultMaxBytes);
  const updated = ctx.store.table('outbox').patch(row.id, { status: ok ? 'done' : failureStatus, result, executionStarted,
    ...(ownerFailureReason ? { ownerFailureReason } : {}), doneAt: ctx.clock.now() });
  // 主人批准的动作必须交回一条可读结果；HTTP 只展示状态码，外部正文仍留给唤醒包的不可信证据区。
  if (row.approvalId && ['approved', 'used'].includes(ctx.store.table('approvals').get(row.approvalId)?.status ?? '')) {
    const message = approvedOutboxResult(updated, ctx.settings.c03.actionCommandMaxChars);
    postThread(ctx, { thread: row.botId, from: 'hub', kind: 'system',
      // 宿主命令追加执行事实；未执行时保持原有的简短回执，不伪造退出码或输出。
      text: threadDetail ? `${message}\n\n${threadDetail}` : message, refId: row.id });
  }
  const bot = ctx.store.table('bots').get(row.botId);
  if (bot) ctx.store.table('bots').patch(bot.id, { activityText: ownerActivityText(ctx, bot) });
  recordPercept(ctx, { botId: row.botId, watchId: null, source: 'system', kind: 'outbox_done', summary: `出站动作 ${row.id} ${ok ? '完成' : '失败'}：${result}`,
    location: row.id, fingerprintMaterial: ['outbox_done', row.id], magnitude: 1, anomaly: false, untrusted: row.kind !== 'notify_owner', occurredAt: ctx.clock.now() });
  ctx.emit(HUB_EVENT_SCOPES.bot, row.botId);
}

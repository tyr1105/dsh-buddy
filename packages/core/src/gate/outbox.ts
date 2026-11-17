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
import { chiefDeliverableMap, chiefDeliverableRefusal } from './chief-deliverable.js';
import { classifyPath, mostDangerous, resolveGatePath, within, type Classification, type GateContext } from './paths.js';
import { HOST_SANDBOX_UNAVAILABLE, SANDBOX_UNAVAILABLE, SandboxRootChanged, type ExecResult } from '../io/interfaces.js';
import { containedWriteTarget, resolveFixedRoot, resolveRealTarget } from './real-path.js';
import { checkGitBoundaries } from './git-boundary.js';
import { decide } from './matrix.js';
import { gateContextFor, recordViolation } from './guard.js';
import { requestApproval, consumeTicket, approvalContentHash, approvalAsksOf } from './approvals.js';
import { postThread } from '../outreach/thread.js';
import { recordPercept } from '../perception/percept.js';
import { approvedActionText, approvedOutboxResult, shortFailure, transportFailure } from '../util/outbox-text.js';
import { ownerActivityText } from '../util/owner-text.js';
import { stableStringify } from '../util/hash.js';
import { captureCommandFiles } from './command-files.js';
import { JOB_DEFAULTS } from '../config/defaults.js';
import { hasInvisibleChars, internalNameIn } from '../job/owner-text.js';
import { declineLaunchStep, executingJobOf, noteJobOf } from '../job/launch-approval.js';
import { launchEndedRefusal } from '../job/launch-cancel.js';
import { VOID_OWNER_TEXT, VOID_REASON_CHANGED, voidApproval } from './void-approval.js';
import { HOST_COMMAND_CWD_RULE, HOST_TMP_ROOT, hostSandboxRules, hostWriteRefusal, pathsOutsideHostWritable } from './host-writable.js';
import { launchJobOfOutbox, settleLaunchResult } from '../job/launch-result.js';
import { LOCAL_DIR_CHANGED_REASON, LocalDirChanged, agreedLocalDirOf, launchDirForSubmit, localDirForRun } from '../job/launch-local-dir.js';
import { wakeSubmitterWithResult } from './outbox-wake.js';
import { REPLACE_PARAM_DESCRIPTION, launchSingleGuard, pendingLaunchApprovalOf } from '../job/launch-replace.js';
import { sameLocalDirPath } from '../project/local-dir.js';
import { ApprovalNoteSchema } from '../model/job.js';
import type { Bot } from '../model/bot.js';

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
  cwd: nonempty.refine(v => v.startsWith('/'), 'cwd 必须为绝对路径').describe(`仅 kind=run_command 时需要：执行目录的绝对路径，必填；${HOST_COMMAND_CWD_RULE}`),
};
// 保留每种动作的严格字段集合，避免扁平展示使无关字段悄悄进入审批票或执行参数。
const payloadSchemas = {
  notify_owner: z.strictObject({ text: payloadFields.text, importance: payloadFields.importance.optional() }),
  write_file: z.strictObject({ path: payloadFields.path, content: payloadFields.content }),
  http_post: z.strictObject({ url: payloadFields.url, body: payloadFields.body, headers: payloadFields.headers.optional() }),
  run_command: z.strictObject({ cmd: payloadFields.cmd, args: payloadFields.args, cwd: payloadFields.cwd }),
};
/** 审批卡上的一行说明（费用、能否撤回、批准之后）：写给主人看，1 到 LAUNCH_NOTE_MAX_CHARS 字，单行，不含内部名称（P74g）。 */
function ownerNote(label: string) {
  return z.string({ error: `${label}：必须是文字` }).trim().min(1, `${label}：不能为空`)
    .refine(value => [...value].length <= JOB_DEFAULTS.LAUNCH_NOTE_MAX_CHARS, `${label}：不能超过 ${JOB_DEFAULTS.LAUNCH_NOTE_MAX_CHARS} 字`)
    .refine(value => !/[\r\n]/.test(value), `${label}：写成一句话，不要换行`)
    // P74r4a：零宽字符、文字方向控制字符能绕过内部名称检查、也能让主人看到的顺序与实际不同，一律拒绝。
    .refine(value => !hasInvisibleChars(value), `${label}：含有看不见的字符，请删掉后重写。`)
    // 这三行主人直接看到：工具名、内部编号、mode 的英文名等一律拒绝，让员工改成白话（补充要求第 2 节第 1 条）。
    .refine(value => internalNameIn(value) === null, `${label}：这句话主人直接看到，不能出现工具名、内部编号这类内部名称，请改成白话`);
}
export type OutboxInput = { [Kind in keyof typeof payloadSchemas]: {
  kind: Kind; why: string; payload: z.infer<(typeof payloadSchemas)[Kind]>;
  cost?: string; undo?: string; after?: string; replace?: boolean;
} }[keyof typeof payloadSchemas];
export const OutboxInputSchema = z.strictObject({
  kind: z.enum(['notify_owner', 'write_file', 'http_post', 'run_command'], { error: 'kind 必须是 notify_owner、write_file、http_post 或 run_command' }),
  why: nonempty.trim().min(1, 'why 原因不能为空'),
  payload: z.strictObject(payloadFields).partial(),
  cost: ownerNote('cost').optional().describe('对外发布、花钱的动作填：会不会产生费用、大约多少；主人在审批卡上看到，用白话写，不超过 80 字'),
  undo: ownerNote('undo').optional().describe('对外发布、不可撤回的动作填：做完之后能不能撤回、怎样撤回；主人在审批卡上看到，用白话写，不超过 80 字'),
  after: ownerNote('after').optional().describe('对外发布的动作填：批准之后多久生效、生效后会发生什么；主人在审批卡上看到，用白话写，不超过 80 字'),
  // P74r19：发布这一步同一时间只有一条命令在等批准；要用新的一条取代它时设为 true（见 job/launch-replace.ts）。
  replace: z.boolean({ error: 'replace 必须是布尔值' }).optional().describe(REPLACE_PARAM_DESCRIPTION),
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
// P74r18b：防重入的集合按存储（ctx.store）登记，不按上下文对象：Hub 为每次调用派生上下文对象时（同一个存储），
// 批准之后立刻触发的执行、巡检里的执行、手动调用共用同一个集合，同一条出站记录不会被两处同时执行。
const executing = new WeakMap<object, Set<string>>();
/** 复盘类回合里 notify_owner 被拒的文字（给模型看）。 */
export const REFLECTION_NOTIFY_REFUSAL = '复盘回合不向主人汇报；要说明的写进 note。';
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
    // P69：项目目录同样用固定位置（只解析上一级）：项目文件夹自己被换成指向别处的链接时，真实落点会出界，从而被下面拦下。
    const projectDirs = gctx.projectDirs ?? [];
    const realProjectDirs = await Promise.all(projectDirs.map(dir => resolveFixedRoot(ctx.fs, dir)));
    // realRootDir 置空：这份上下文里的各目录已经是真实路径，不能再把真实路径换回设置里的写法。
    const realContext = { ...gctx, realRootDir: undefined, homeDir: await resolveFixedRoot(ctx.fs, bot.homeDir),
      rootDir: await resolveRealTarget(ctx.fs, gctx.rootDir), sharedDir: await resolveFixedRoot(ctx.fs, gctx.sharedDir), projectDirs: realProjectDirs };
    const action = mostDangerous([classifyPath(original, true, gctx), classifyPath(real, true, realContext)]);
    // 家内名称指向家外，不能借审批的原路径暗中扩大写入目标。
    if (within(original, bot.homeDir) && !within(real, realContext.homeDir)) return { cls: 'protected', reason: '出站文件符号链接指向家目录边界外，拒绝写入' };
    // 项目文件夹同理：名字在项目文件夹里、真实落点却在外面，不能凭「写自己的项目」免审批，更不能借审批的原路径暗中改写别处。
    if (projectDirs.some((dir, index) => within(original, dir) && !within(real, realProjectDirs[index]!))) return { cls: 'protected', reason: '出站文件符号链接指向项目文件夹边界外，拒绝写入' };
    return action;
  }
  const action = await checkGitBoundaries(ctx.fs, classifyToolCall('run_command', input.payload, gctx), gctx);
  return action.cls === 'A' || action.cls === 'B'
    ? { ...action, cls: 'C', subclass: 'host_command', reason: '这条命令由中心在受限沙箱内运行，要主人批准' } : action;
}
/** P85：批准之后写文件的落点变了，不写入时给主人看的固定原因（完整路径只写进日志）。 */
export const WRITE_TARGET_CHANGED_REASON = '要写入的位置在批准之后变了，没有写入。';
/** 写文件的目标现在解析到的真实落点（不存在的尾部沿父目录解析，与执行时用同一个算法）。 */
async function realWriteTarget(ctx: HubContext, bot: Bot, path: string): Promise<string> {
  return resolveRealTarget(ctx.fs, resolveGatePath(path, gateContextFor(ctx, bot)));
}
/** P85：把写文件审批建单时的真实落点记进审批旁表（旁表已有就补一项，没有就建一行）。 */
function recordWriteRealPath(ctx: HubContext, approvalId: string, real: string, now: number): void {
  const notes = ctx.store.table('approvalNotes');
  if (notes.get(approvalId) !== null) notes.patch(approvalId, { writeRealPath: real });
  else notes.put(ApprovalNoteSchema.parse({ id: approvalId, cost: null, undo: null, after: null, jobId: null, writeRealPath: real, createdAt: now }));
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
/**
 * P74r17 第 3 节：以审批为准，把这位员工「审批已被拒绝或已过期、记录却还停在待批或就绪」的出站记录改成已拒绝。
 * 原因：审批被拒绝时只改审批单，出站记录要等下一轮定时执行（executeReadyOutbox）才改状态；
 * 这个空档里同一条命令原样再提交，去重会返回旧记录，文字仍是「等待主人批准」，而那张审批已经被拒绝。
 * 所以提交的入口先把记录与审批对齐：被拒绝或已过期的记录不再参与去重，同一条命令当作一次新的提交（或被发布把关拒绝）。
 * 只处理「已拒绝、已过期」：已使用（批准票刚被消费、正在执行）的不动，交给执行流程。写法与 executeReadyOutbox 里的一致。
 */
function reconcileDecidedOutbox(ctx: HubContext, botId: string): void {
  const now = ctx.clock.now();
  for (const row of ctx.store.table('outbox').list(o => o.botId === botId && ['pending_approval', 'ready'].includes(o.status) && o.approvalId !== null)) {
    const approval = ctx.store.table('approvals').get(row.approvalId!);
    if (approval && (approval.status === 'rejected' || approval.status === 'expired' || (approval.status === 'pending' && approval.expiresAt <= now))) {
      ctx.store.table('outbox').patch(row.id, { status: 'rejected', result: '审批已拒绝、过期或批准票已使用', executionStarted: false, doneAt: now });
    }
  }
}
/** 校验提交身份并去重，需审批的先存单，避免未经授权就产生副作用。 */
export async function submitOutbox(ctx: HubContext, botId: string, raw: unknown): Promise<OutboxAction> {
  return (await submitOutboxDetailed(ctx, botId, raw)).row;
}
/**
 * submitOutbox 的完整结果：除了出站记录，还告诉调用方这一次有没有「取代了原来在等批准的发布命令」（P74r19），
 * 工具据此在返回给模型的话末尾加一句。
 */
export async function submitOutboxDetailed(ctx: HubContext, botId: string, raw: unknown): Promise<{ row: OutboxAction; replaced: boolean }> {
  parseInput(nonempty, botId, '出站 botId');
  const input = parseInput(OutboxInputSchema, raw, '出站动作');
  const bot = ctx.store.table('bots').get(botId);
  if (!bot) throw new Error('出站 botId 对应机器人不存在');
  const autonomy = bot.lifecycle === 'probation' ? 'L1' : bot.autonomy;
  if (autonomy === 'L0' || !['active', 'probation'].includes(bot.lifecycle)) throw new Error('当前机器人不能提交出站动作');
  // P75r5a 第 1 节：复盘、核对、改写回合全程不打扰主人。notify_owner 会落私聊、还可能推送，所以在这里最先拒绝：
  // 不落私聊、不推送、不建审批、不记出站记录、不计越界（拒绝只是告诉员工把要说的话写进 note）。
  if (input.kind === 'notify_owner' && gateContextFor(ctx, bot).reflection) throw new Error(REFLECTION_NOTIFY_REFUSAL);
  // P75r6 第 1 节（复验 N1）：技能类回合里 hub_outbox_submit 整个拒绝（write_file 也不例外，原来复盘回合允许它写自己的 work）：
  // 读到的文字里一段注入的话，可以借它把内容写进共享目录。不建记录、不计越界；文字沿用原来的只读拒绝文字。
  if (input.kind !== 'notify_owner' && gateContextFor(ctx, bot).reflection) throw new Error('复盘回合只读，不执行对外动作');
  reconcileDecidedOutbox(ctx, botId);
  const stamp = permissionStamp(ctx, botId);
  const action = await actionFor(ctx, botId, input);
  if (action.cls === 'protected' || action.subclass === 'work_data') {
    await recordViolation(ctx, botId, action.reason);
    throw new Error(action.reason);
  }
  if (gateContextFor(ctx, bot).reflection && action.cls !== 'A') throw new Error('复盘回合只读，不执行对外动作');
  // P82：总管自己的文件写入（写文件、要写文件的命令）只能放在中心的数据目录里；要产出成品先约定、再派活。
  // 与原生工具同一规则（gate/guard.ts）；放在建审批之前，不能先建一张审批再让主人选「总管自己做」。
  if (bot.role === 'chief' && (input.kind === 'write_file' || input.kind === 'run_command')) {
    const refusal = chiefDeliverableRefusal(action.writePaths ?? [], chiefDeliverableMap(ctx, bot.id));
    if (refusal !== null) throw new Error(refusal);
  }
  const decision = outboxDecision(ctx, botId, input, action);
  if (decision === 'deny') throw new Error(`当前自主等级不允许：${action.reason}`);
  // P74r15：需要审批的命令，在这位员工做的那件事已经完成、发布这一步却已结束（或约定里没有发布）时被拒：
  // 不建审批、不在总管私聊落话（取消回合生效之前的空档里，回合仍可能提交）。
  if (decision === 'approval') {
    const refusal = launchEndedRefusal(ctx, botId);
    if (refusal !== null) throw new Error(refusal);
  }
  // P74r18b 第 4.3 节：预先核对。命令分析得出的要写的路径里，有不在「中心代为运行的可写范围」之内的（批准之后必然写不进去），
  // 不建审批、不落任何消息、不计越界，直接拒绝并写明可写范围。分析不出要写哪里的命令（含变量、~）照旧可以提交。
  // 受保护的位置、凭据、工作数据在上面已经按原分类处理，这里只管「不受保护、但在可写范围之外」的写入。
  if (input.kind === 'run_command' && decision === 'approval') {
    const gctx = gateContextFor(ctx, bot);
    // P81：这条命令是这件事的发布审批、约定里写了发布位置时，那一个文件夹之内的位置也算可写；其他命令照旧只有原来的范围。
    const outside = pathsOutsideHostWritable(action.writePaths ?? (action.readOnly ? [] : action.paths),
      { homeDir: bot.homeDir, sharedDir: gctx.sharedDir, projectDirs: gctx.projectDirs ?? [], localDir: launchDirForSubmit(ctx, botId) ?? undefined });
    if (outside.length > 0) throw new Error(hostWriteRefusal(outside));
  }
  // 费用、能否撤回、批准之后三行只给审批卡用，不属于出站动作本身，不进出站记录、不参与批准票的内容哈希。
  // replace 同样只是给发布审批用的标记，不进出站记录、不参与批准票的内容哈希。
  const { cost, undo, after, replace, ...actionInput } = input;
  const boundInput = { ...actionInput, ...(input.kind === 'run_command'
    ? { commandFiles: await captureCommandFiles(ctx, botId, input.payload) } : {}) };
  if (stamp !== permissionStamp(ctx, botId)) throw new Error('机器人状态或权限已变化，请重新提交出站动作');
  const hash = approvalContentHash('hub_outbox_execute', ticketArgs(boundInput));
  let replacing: string | null = null;
  const existing = ctx.store.table('outbox').list(o => o.botId === botId && ['pending_approval', 'ready'].includes(o.status)
    && approvalContentHash('hub_outbox_execute', ticketArgs(o)) === hash)[0];
  if (existing) {
    // P81r1（S6 第 3.4 节第 4 条）：同一条命令已经有一张等批准的发布审批、而它旁表记下的发布位置与约定里现在的不同
    // （包括一边有一边没有）时，不能把旧记录原样返回——主人看到的提示句会与实际要放开的位置不一致。
    // 作废旧卡，按「取代」继续建新卡（新卡带上现在的位置）。
    const job = executingJobOf(ctx, botId);
    const pending = job === null ? null : pendingLaunchApprovalOf(ctx, job);
    const noted = existing.approvalId === null ? null : ctx.store.table('approvalNotes').get(existing.approvalId)?.launchLocalDir ?? null;
    const launchDirMoved = job !== null && job.state === 'done' && pending !== null && existing.approvalId === pending.id
      && !sameLocalDirPath(noted, agreedLocalDirOf(ctx, job));
    if (!launchDirMoved) return { row: existing, replaced: false };
    // 先记下要取代的那张，按「取代」建新卡；旧卡在新卡建好之后才作废（gate/approvals.ts 的 replaced 路径），
    // 新卡建不成时旧卡原样保留。
    replacing = existing.approvalId!;
  }
  // P74r19 第 1 节：这件事已有一条发布命令在等主人批准时，同一时间只能有一条：没带 replace 直接拒绝（不建审批、不落消息、不计越界）；
  // 带了 replace（只对命令有效）才放行，建好新的发布审批之后原来那条作废（gate/approvals.ts）。放在去重之后：同一条命令原样再提交仍返回原记录。
  // P81r1：上面按位置变化作废旧卡的那种情形已经按「取代」处理，不再走这道拒绝。
  if (decision === 'approval' && replacing === null) {
    const guard = launchSingleGuard(ctx, executingJobOf(ctx, botId), { kind: input.kind, replace });
    if (guard !== null && 'refusal' in guard) throw new Error(guard.refusal);
    replacing = guard === null ? null : guard.replacing;
  }
  const now = ctx.clock.now();
  let row = parseInput(OutboxActionSchema, { id: newId('o', ctx.rng), botId, ...boundInput, actionClass: action.cls,
    approvalId: null, status: decision === 'approval' ? 'pending_approval' : 'ready', result: null, createdAt: now, doneAt: null }, '出站记录');
  ctx.store.table('outbox').put(row);
  if (decision === 'approval') {
    // P74g：三行说明随审批单一起写进旁表；这位员工正在做一件事时，审批还会与这件事衔接（见 job/launch-approval.ts）。
    let approval: Awaited<ReturnType<typeof requestApproval>>;
    try {
      approval = await requestApproval(ctx, botId, 'hub_outbox_execute', ticketArgs(row), action.cls === 'D' ? 'D' : 'C', `${action.reason}。申请理由：${input.why}`, approvalAsksOf(action), input.why, { cost, undo, after, replace: replacing !== null });
    } catch (error) {
      // 审批没有建成（例如这件事的发布状态没有记下）：出站记录一起撤回，不留下一张没有审批单的待批记录，工具返回失败。
      ctx.store.table('outbox').remove(row.id);
      throw error;
    }
    row = ctx.store.table('outbox').patch(row.id, { approvalId: approval.id });
    // P85（W9）：写文件审批把「批准时」解析到的真实落点记进旁表；批准之后执行之前重新解析并比较（executeOne）。
    // 否则员工可以在批准写 /tmp 下某处之后，把那一级换成指向别处的链接，借这一次批准写到别的位置。
    // 记不下就不留这条出站记录（与上面审批没有建成时的处理一致），不放行一个核对不了的写入。
    if (input.kind === 'write_file') {
      try { recordWriteRealPath(ctx, approval.id, await realWriteTarget(ctx, bot, input.payload.path), now); }
      catch (error) {
        ctx.store.table('outbox').remove(row.id);
        throw new Error(`审批没有记下要写入的位置：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } else if (input.kind === 'notify_owner') {
    const active = executing.get(ctx.store) ?? new Set<string>();
    executing.set(ctx.store, active);
    active.add(row.id);
    try {
      await executeOne(ctx, row);
    } finally {
      active.delete(row.id);
    }
    row = ctx.store.table('outbox').get(row.id)!;
  }
  ctx.emit(HUB_EVENT_SCOPES.bot, botId);
  // 取代是否真的发生：原来那条审批已被作废（审批单带 voided 标记）。
  const replaced = replacing !== null && ctx.store.table('approvals').get(replacing)?.voided === true;
  return { row, replaced };
}

/** 批准之后立刻触发、还在运行的那几次执行（P74r18b）：巡检和手动调用的 executeReadyOutbox 最后会等它们做完。 */
const approvedRuns = new WeakMap<object, Set<Promise<void>>>();
/**
 * P74r18b：主人批准一条由中心代为执行的出站动作之后，立刻开始一次执行（gate/approvals.ts 的 decideApproval 调用）。
 * 不等它做完：命令可能运行很久，主人点「批准」的命令不该为此卡住；做完会在出站记录、发布状态、叫醒里体现。
 * 与巡检里的执行不会重入（executeReadyOutbox 内部用同一个防重入集合）；员工正在复盘、已暂停时照现有规则跳过，留给巡检兜底。
 */
export function startApprovedRun(ctx: HubContext): void {
  const set = approvedRuns.get(ctx.store) ?? new Set<Promise<void>>();
  approvedRuns.set(ctx.store, set);
  const run: Promise<void> = runReadyOutbox(ctx)
    .catch(error => { ctx.logger.warn('批准之后立刻执行出站动作失败，留给下一次巡检', { error: String(error) }); })
    .finally(() => { set.delete(run); });
  set.add(run);
}

/** 界面命令入口在批准之后调用：这张审批是一条已批准的出站动作时，立刻开始一次执行；其余审批什么都不做。 */
export function startApprovedRunFor(ctx: HubContext, approvalId: string | null | undefined): void {
  if (!approvalId) return;
  const approval = ctx.store.table('approvals').get(approvalId);
  if (approval?.status === 'approved' && approval.tool === 'hub_outbox_execute') startApprovedRun(ctx);
}

/** 执行所有可执行的出站动作（巡检、手动调用）：先自己跑一遍，再等批准之后立刻触发的那几次做完。 */
export async function executeReadyOutbox(ctx: HubContext): Promise<void> {
  await runReadyOutbox(ctx);
  const pending = approvedRuns.get(ctx.store);
  if (pending !== undefined && pending.size > 0) await Promise.all([...pending]);
}

/** 运行前再次检查生命周期、受保护路径和当前权限；批准不等于永久豁免。 */
async function runReadyOutbox(ctx: HubContext): Promise<void> {
  const active = executing.get(ctx.store) ?? new Set<string>();
  executing.set(ctx.store, active);
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
        const requested = await requestApproval(ctx, row.botId, 'hub_outbox_execute', ticketArgs(row), action.cls === 'D' ? 'D' : 'C', `${action.reason}。申请理由：${row.why}`, approvalAsksOf(action), row.why);
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
/**
 * 内容失效或旧票迁移都使原票不可再用；不伪造主人拒绝或已执行的事实。
 * P74r4b-m1：作废的写法与发布这一步用满回合上限时统一（gate/void-approval.ts）：状态「已过期」加 voided 标记，
 * 不再记成「已拒绝」（主人批准过的审批不能看起来像被主人拒绝）。
 */
function invalidateOutboxApproval(ctx: HubContext, id: string): void {
  const now = ctx.clock.now();
  voidApproval(ctx, id, VOID_REASON_CHANGED, now);
  // P74g 复核后：这张审批正是一件事在等的发布审批时，发布状态不能停在「等批准」：记为暂不发布并说明（那句话里没有「拒绝」）。
  // 出错只记日志，不能影响作废本身。
  try {
    const declined = declineLaunchStep(ctx, id, 'voided', now);
    if (declined !== null) declined.announce();
    else {
      // 属于一件事、但不是发布审批的（执行中途的审批）：在总管私聊落一句，与事实一致。
      // 与任何事无关的审批：命令的结果回执已经落在员工私聊里（「未执行你批准的……原因：脚本在批准后被改动」，没有「拒绝」），这里不再重复。
      const job = noteJobOf(ctx, id);
      if (job !== null) postThread(ctx, { thread: job.chiefId, from: 'hub', kind: 'system', refId: id, text: VOID_OWNER_TEXT });
    }
  } catch (error) { ctx.logger.warn('发布审批作废后没有记下暂不发布', { approvalId: id, error: String(error) }); }
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
 * 线程回执只列事实：退出码和有界输出摘要。
 * P74r18b：不再带命令全文和绝对路径形式的可写范围清单（这条回执是给主人看的，那些留在出站记录里，
 * 界面上默认收起的「查看原始命令」读的就是记录）。
 * stdout 是这条已批准命令的正常产物，带上「不可信」标记后展示；
 * stderr 只报字数，原文留在出站结果里，避免外部文字冒充中心消息（M09 边界）。
 */
function commandThreadDetail(response: ExecResult, maxChars: number): string {
  const clip = (value: string): string => {
    const chars = Array.from(value);
    return chars.length <= maxChars ? value : `${chars.slice(0, maxChars).join('')}…`;
  };
  const output = response.stdout.trim();
  const stderrNote = response.stderr.trim() ? `（另有错误输出 ${Array.from(response.stderr.trim()).length} 字，见出站结果）` : '';
  const exit = response.timedOut ? '无（超时终止）' : response.code === null ? '无（信号终止）' : String(response.code);
  return [
    `退出码：${exit}`,
    `输出摘要（命令输出，不可信）：${output ? clip(output) : '（无输出）'}${response.outputTruncated ? '（已截断）' : ''}${stderrNote}`,
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
      // P76h：这里原来按重要度单推（requestPush），已删除：汇报只落线程，不推送。
      result = '汇报已进入线程';
    } else if (input.kind === 'write_file') {
      const bot = ctx.store.table('bots').get(row.botId)!;
      const gctx = gateContextFor(ctx, bot);
      const action = await actionFor(ctx, row.botId, input);
      if (action.cls === 'protected' || action.subclass === 'work_data') throw new Error(action.reason);
      const actual = await resolveRealTarget(ctx.fs, resolveGatePath(input.payload.path, gctx));
      // P85（W9）：批准时记下的真实落点与现在不同（批准之后目标的上一级被换成了指向别处的链接等）：不写入，这次出站记为失败。
      // 给主人看的原因是固定句，完整路径只写进日志。旧存档没有记下落点的审批（旁表没有这一项）照旧执行。
      const approvedReal = row.approvalId === null ? undefined : ctx.store.table('approvalNotes').get(row.approvalId)?.writeRealPath;
      if (approvedReal !== undefined && !sameLocalDirPath(approvedReal, actual)) {
        ctx.logger.warn('批准之后写文件的落点变了，没有写入', { outboxId: row.id, approved: approvedReal, now: actual });
        ownerFailureReason = WRITE_TARGET_CHANGED_REASON;
        throw new Error(WRITE_TARGET_CHANGED_REASON);
      }
      // P69：项目文件夹也是中心可以代写的根目录，写入时由文件层在根这一级拒绝符号链接。
      const target = await containedWriteTarget(ctx.fs, actual, [bot.homeDir, gctx.sharedDir, ...(gctx.projectDirs ?? [])]);
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
      // P74r18b：可写范围、审批卡上的提示句、工具说明从同一份清单来（gate/host-writable.ts）：
      // 家目录、共享目录、这位员工所在项目的项目文件夹、本机临时文件夹（/private/tmp，系统 $TMPDIR 由沙箱实现自动加入）；
      // 项目文件夹里由中心维护的文件和工作数据目录进拒绝清单（工作数据即使有授权也一律拒绝）。
      // 项目文件夹还不存在时不放进可写清单：沙箱要求每个可写根都是已存在的目录，否则整条命令都起不来。
      const projectDirs: string[] = [];
      for (const dir of gctx.projectDirs ?? []) if (await ctx.fs.lstat(dir) !== null) projectDirs.push(dir);
      // /private/tmp 同样先看存在才放进清单（给人和模型看的文字不变）。
      // P81：这条命令是某件事的发布审批、约定里有发布位置时，重新核对后把「实际路径」加进可写清单；核对不通过不运行命令。
      // 其他命令（普通审批、别的事的发布、没有发布位置的事）得到 null，可写清单与以前完全一致。
      let localDir: string | undefined;
      try { localDir = (await localDirForRun(ctx, row))?.actual; }
      catch (error) {
        if (!(error instanceof LocalDirChanged)) throw error;
        // 与「没有发布成功」那一句共用的原因：固定文字，不带路径。
        ownerFailureReason = LOCAL_DIR_CHANGED_REASON;
        throw error;
      }
      const sandbox = hostSandboxRules({ homeDir: bot.homeDir, sharedDir: gctx.sharedDir, projectDirs, localDir }, await workDataDenyRoots(ctx, gctx),
        await ctx.fs.lstat(HOST_TMP_ROOT) !== null);
      let response: ExecResult;
      try {
        response = await ctx.exec.run(input.payload.cmd, input.payload.args, { cwd: input.payload.cwd,
          timeoutMs: ctx.settings.scriptTimeoutMs, maxOutputBytes: ctx.settings.scriptMaxOutputBytes, sandbox });
      } catch (error) {
        // P81r1（S8）：规则生成时发现发布位置的真实路径与核对时不一致：与 LocalDirChanged 同样处理，
        // 命令不运行，给主人和员工看的原因用固定句（不带完整路径）；完整路径只写进日志。
        if (!(error instanceof SandboxRootChanged)) throw error;
        ctx.logger.warn('发布位置的真实路径在生成沙箱规则时不一致，命令没有运行', { outboxId: row.id, detail: error.detail });
        ownerFailureReason = LOCAL_DIR_CHANGED_REASON;
        throw new LocalDirChanged();
      }
      // 沙箱探针通过、进程真正启动后才算“已执行”；沙箱不可用与启动失败必须显示“未执行”。
      executionStarted = true;
      // 命令能跑通说明沙箱恢复可用，清掉总览里的不可用警告。
      if (ctx.runtime.sandboxUnavailable !== null) {
        ctx.runtime.sandboxUnavailable = null;
        ctx.emit(HUB_EVENT_SCOPES.overview);
      }
      threadDetail = commandThreadDetail(response, ctx.settings.c03.approvalOwnerParamsMaxChars);
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
  const approved = Boolean(row.approvalId) && ['approved', 'used'].includes(ctx.store.table('approvals').get(row.approvalId!)?.status ?? '');
  // P74r18b：这条命令是某件事正在等的发布审批：结果回到这件事上（发布状态、主题、总管私聊、叫醒执行者，见 job/launch-result.ts），
  // 执行者的私聊不再落那行带命令全文和路径的系统文字（主人不看那里），命令全文、退出码、错误输出留在出站记录里。
  // 出错只记日志，不影响出站记录本身。
  let launchHandled = false;
  if (approved) {
    try { launchHandled = launchJobOfOutbox(ctx, updated) !== null && settleLaunchResult(ctx, updated); }
    catch (error) { ctx.logger.warn('发布命令的结果没有回到这件事上', { outboxId: row.id, error: String(error) }); }
  }
  // 主人批准的动作必须交回一条可读结果；HTTP 只展示状态码，外部正文仍留给唤醒包的不可信证据区。
  if (approved && !launchHandled) {
    const message = approvedOutboxResult(updated, ctx.settings.c03.actionCommandMaxChars, approvedActionText(ctx, updated));
    postThread(ctx, { thread: row.botId, from: 'hub', kind: 'system',
      // 宿主命令追加执行事实（退出码、输出摘要）；未执行时保持原有的简短回执，不伪造退出码或输出。
      text: threadDetail ? `${message}\n\n${threadDetail}` : message, refId: row.id });
  }
  const bot = ctx.store.table('bots').get(row.botId);
  if (bot) ctx.store.table('bots').patch(bot.id, { activityText: ownerActivityText(ctx, bot) });
  const percept = recordPercept(ctx, { botId: row.botId, watchId: null, source: 'system', kind: 'outbox_done', summary: `出站动作 ${row.id} ${ok ? '完成' : '失败'}：${result}`,
    location: row.id, fingerprintMaterial: ['outbox_done', row.id], magnitude: 1, anomaly: false, untrusted: row.kind !== 'notify_owner', occurredAt: ctx.clock.now() });
  // P74r18b：主人批准过的动作，结果出来之后直接给提交它的员工排一条带结果的唤醒（不走普通感知的评分：显著性 0.5 单条永远叫不醒人）。
  // 发布命令已经由 settleLaunchResult 排过。没有运行的结果（'rejected'：脚本在批准后被改动、权限复查不过等）也要让员工知道，照失败的写法叫醒；
  // 只有「这是一件事的发布审批」的那种不叫醒：批准随后作废，发布这一步另有收尾（job/launch-approval.ts 的 declineLaunchStep）。
  // 排过唤醒的感知标成已评估，免得感知收集器再另建一条不带结果的候选，同一次结果叫醒两次。
  let woken = launchHandled;
  if (approved && !launchHandled && !(updated.status === 'rejected' && launchJobOfOutbox(ctx, updated) !== null)) {
    try { woken = wakeSubmitterWithResult(ctx, updated, percept?.id ?? null); }
    catch (error) { ctx.logger.warn('出站动作的结果唤醒没有排上', { outboxId: row.id, error: String(error) }); }
  }
  if (woken && percept !== null && percept.evaluatedAt === undefined) ctx.store.table('percepts').patch(percept.id, { evaluatedAt: ctx.clock.now() });
  ctx.emit(HUB_EVENT_SCOPES.bot, row.botId);
}

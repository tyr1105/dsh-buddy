/** 每个机器人尽量合并候选；审批与只读复盘分开排队，避免批准动作失去执行机会。 */
import { onDemandBlocks } from './on-demand.js';
import { ownerReasonSummary } from '../util/owner-text.js';
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import type { HubContext } from '../engine/context.js';
import type { QueueEntry, Variant } from '../model/index.js';
import { CandidateSchema } from '../appraisal/think.js';
import type { Candidate } from '../appraisal/think.js';
import { logAppraisal } from '../appraisal/log.js';
import { parseInput } from '../engine/validation.js';
import { newId } from '../util/ids.js';
import { hasApprovalDecision } from '../util/approval-candidate.js';
import { parseSkillKey } from '../skill/keys.js';

/** 特殊变体先到先保留；普通变体按工作量升级，不让轻复查覆盖正常工作。 */
function mergeVariant(old: Variant, next: Variant): Variant {
  const special: Variant[] = ['trial', 'teach', 'reflection'];
  if (special.includes(old)) return old;
  if (special.includes(next)) return next;
  const ranks: Variant[] = ['light_check', 'catch_up', 'regular'];
  return ranks.indexOf(old) >= ranks.indexOf(next) ? old : next;
}
/** 合并两条候选的 retryOfSelfWork：有 false 则 false（宁可不拦主人交代的事），否则有 true 则 true，都没有就不带这个键。 */
export function mergeRetryOrigin(a: boolean | undefined, b: boolean | undefined): { retryOfSelfWork?: boolean } {
  if (a === false || b === false) return { retryOfSelfWork: false };
  if (a === true || b === true) return { retryOfSelfWork: true };
  return {};
}
/** 兼容候选合并证据，最高分理由决定解释；审批与复盘各自保留到真正处理。 */
export function enqueue(ctx: HubContext, input: Candidate, opts: { directed?: boolean } = {}): QueueEntry | null {
  const candidate = parseInput(CandidateSchema, input, '排队候选');
  const candidateBot = ctx.store.table('bots').get(candidate.botId);
  if (!candidateBot) throw new Error(`机器人不存在：${candidate.botId}`);
  // P55：入队总闸兜底。时钟、内驱、感知这几条高频路径在源头就已跳过，这里不会刷屏。
  if (onDemandBlocks(candidateBot, candidate.reason.kind, candidate.subjectKey)) {
    logAppraisal(ctx, { botId: candidate.botId, perceptIds: candidate.reason.evidence, score: candidate.reason.score,
      threshold: candidate.reason.threshold, decision: 'suppressed', suppressedBy: null, text: '听吩咐：没有人点名或派活，不自己行动' });
    return null;
  }
  // 自动轻复查与运维控制有独立触发条件；普通感知、议程、内驱仍必须达到当时门槛。
  // P73r3 S1：directed（hub_send、派活（hub_job_manage）产生的、指名发给某位员工的同伴消息和交办）入队时一律不看思考门槛。
  // 「听吩咐」的含义是被点名或派活时行动，别人指名叫它，不该由「值不值得想」的门槛决定去留；P73a 起执行类员工一律是安静节奏，
  // 门槛（0.70 以上）高于交接的显著性上限（0.70），不放行的话员工之间的交接、员工回报总管都会在这里被悄悄丢掉。
  // 这一条取代了 P73d 给 chiefDispatch 单加的豁免（总管派活也是指名交接，已包含在内）。其余闸门（并发、预算、额度、静默、间隔、退避）不变；
  // 「同一事项冷却」和「最短思考间隔」仍只对 chiefDispatch 豁免（见 gates.ts）。
  const control = opts.directed === true
    || ['light_check', 'catch_up', 'retry', 'trial', 'teach', 'reflection', 'approval_decided', 'inbox_reply'].includes(candidate.reason.kind);
  if (!candidate.ownerInitiated && !control && candidate.reason.score < candidate.reason.threshold) {
    logAppraisal(ctx, { botId: candidate.botId, perceptIds: candidate.reason.evidence, score: candidate.reason.score,
      threshold: candidate.reason.threshold, decision: 'suppressed', suppressedBy: null,
      text: `${ownerReasonSummary(candidate.reason, ctx)}，思考分 ${candidate.reason.score.toFixed(2)} 低于门槛 ${candidate.reason.threshold.toFixed(2)}，暂不排队` });
    return null;
  }
  const table = ctx.store.table('queue');
  // 两种入队顺序都隔离；审批证据即使已并入主人消息，也不能再被复盘变体接管。
  const approval = hasApprovalDecision(ctx, candidate);
  // P63：按（队友, 主题）合并：不同主题各排各的，回复才能落回各自的主题；旧候选没有主题，按 null 算。
  // P74c：合并键再加上 jobId（都没有按 null 算）。不同的事各排各的，回复才能落回各自的主题，
  // 每件事的回合上限也才能分别计数；一件事的唤醒不和主人私聊的唤醒合并（否则执行链的归属会被吞掉，或把主人的话当成执行链回合）。
  const existing = table.list(row => row.botId === candidate.botId
    && (row.topicId ?? null) === (candidate.topicId ?? null)
    && (row.jobId ?? null) === (candidate.jobId ?? null)
    // P75g：技能类回合（复盘、技能核对、整理）各排各的：只有事项键完全相同的才合并（重复排同一件事），
    // 其余候选（包括同一员工的普通候选、别的复盘记录的技能类候选）都不并入。并入的话，合并结果沿用「更强的」一方的
    // 事项键，技能类的三道闸（所属记录、回合上限、过期）会认错对象，普通候选也会被「复盘」变体接管。
    && (parseSkillKey(row.subjectKey) === null && parseSkillKey(candidate.subjectKey) === null || row.subjectKey === candidate.subjectKey)
    && !(candidate.variant === 'reflection' && hasApprovalDecision(ctx, row))
    && !(row.variant === 'reflection' && approval))[0];
  let row: QueueEntry;
  if (!existing) row = { ...candidate, id: newId('q', ctx.rng), enqueuedAt: ctx.clock.now() };
  else {
    const stronger = candidate.priority > existing.priority
      || (candidate.priority === existing.priority && candidate.reason.score > existing.reason.score) ? candidate : existing;
    row = { ...existing, reason: { ...stronger.reason, evidence: [...new Set([...existing.reason.evidence, ...candidate.reason.evidence])] },
      subjectKey: stronger.subjectKey, priority: Math.max(existing.priority, candidate.priority),
      urgent: existing.urgent || candidate.urgent, ownerInitiated: existing.ownerInitiated || candidate.ownerInitiated,
      variant: mergeVariant(existing.variant, candidate.variant), notBefore: Math.min(existing.notBefore, candidate.notBefore),
      // P72l：任一方是总管派活就保留这个标记，否则合并会把派活的豁免吞掉。
      ...(existing.chiefDispatch || candidate.chiefDispatch ? { chiefDispatch: true } : {}),
      // P76r1：同理保留「主人亲手作出决定之后的接续」标记（它只在唤醒原因是审批结果或重试时才生效，合并后换成别的原因时自然失效）。
      ...(existing.ownerDecided || candidate.ownerDecided ? { ownerDecided: true } : {}),
      // P76r1 小修：任何一条的「重试原回合是不是自己发起」是 false，合并结果就是 false；否则有 true 就是 true；都没有就不带。
      ...mergeRetryOrigin(existing.retryOfSelfWork, candidate.retryOfSelfWork),
      // P74：合并时保留这是哪件事的唤醒（上面的合并条件保证两边的 jobId 相同或都没有）。
      ...((candidate.jobId ?? existing.jobId) ? { jobId: (candidate.jobId ?? existing.jobId)! } : {}) };
  }
  table.put(row);
  const bot = ctx.store.table('bots').get(row.botId)!;
  if (['active', 'probation'].includes(bot.lifecycle) && !['thinking', 'reflecting', 'catching_up', 'resting', 'waiting_owner'].includes(bot.activity)) {
    ctx.store.table('bots').patch(bot.id, { activity: 'queued', activityText: ownerReasonSummary(row.reason, ctx), updatedAt: ctx.clock.now() });
  }
  const logKey = `queued:${row.botId}:${row.id}`;
  const lastLog = ctx.runtime.suppressionLogAt.get(logKey);
  if (lastLog === undefined || ctx.clock.now() - lastLog >= ctx.settings.c02.suppressionLogMs) {
    logAppraisal(ctx, { botId: row.botId, perceptIds: row.reason.evidence, score: row.reason.score, threshold: row.reason.threshold,
      decision: 'queued', suppressedBy: null, text: `${ownerReasonSummary(row.reason, ctx)}，思考分 ${row.reason.score.toFixed(2)}，门槛 ${row.reason.threshold.toFixed(2)}，排队` });
    ctx.runtime.suppressionLogAt.set(logKey, ctx.clock.now());
  }
  ctx.emit(HUB_EVENT_SCOPES.bot, row.botId);
  return row;
}
/** 移除指定候选并通知界面，供放行或失效清理使用。 */
export function removeEntry(ctx: HubContext, entryId: string): void {
  const row = ctx.store.table('queue').get(entryId);
  if (row) {
    ctx.store.table('queue').remove(entryId);
    const bot = ctx.store.table('bots').get(row.botId);
    // 两类候选可同时存在，移出一个不能抹掉另一个仍在排队的状态；已经开始思考的状态不变。
    const next = listQueue(ctx).find(entry => entry.botId === row.botId);
    if (bot?.activity === 'queued') ctx.store.table('bots').patch(bot.id, {
      activity: next ? 'queued' : 'watching', activityText: next ? ownerReasonSummary(next.reason, ctx) : '继续关注变化', updatedAt: ctx.clock.now(),
    });
    ctx.emit(HUB_EVENT_SCOPES.bot, row.botId);
  }
}
/** 按优先级和入队时间返回队列，保证同分先到先处理。 */
export function listQueue(ctx: HubContext): QueueEntry[] {
  return ctx.store.table('queue').list().sort((a, b) => b.priority - a.priority || a.enqueuedAt - b.enqueuedAt);
}

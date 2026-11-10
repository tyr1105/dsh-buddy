/** 统一构造候选及事项键：分数、证据与门槛一起流入队列，后续调度不需要猜测唤醒理由。 */
import { z } from 'zod';
import type { HubContext } from '../engine/context.js';
import { parseInput } from '../engine/validation.js';
import { botBudgetFor, resolveSettings, thresholdFor } from '../config/defaults.js';
import { QueueEntrySchema } from '../model/wake.js';
import type { AgendaItem, QueueEntry, Settings } from '../model/index.js';
import { WakeKindSchema, VariantSchema } from '../model/enums.js';
import { bool, nonempty, ratio, timestamp } from '../model/primitives.js';
import { priorityFor } from '../scheduler/priority.js';
import { startOfLocalDay } from '../util/time.js';
import { roundScore } from './salience.js';
import { ownerPerceptSummary } from '../util/owner-text.js';
import { botMbti } from '../personality/profile.js';
import { personalityBehavior, personalityThreshold } from '../personality/behavior.js';
export { thresholdFor } from '../config/defaults.js';

export const CandidateSchema = QueueEntrySchema.omit({ id: true, enqueuedAt: true });
export type Candidate = Omit<QueueEntry, 'id' | 'enqueuedAt'>;
const InputSchema = z.strictObject({
  botId: nonempty, kind: WakeKindSchema, score: ratio, summary: nonempty, ownerSummary: nonempty.optional(), evidence: z.array(nonempty).optional(),
  subjectKey: nonempty.optional(), watchId: nonempty.nullable().optional(), source: nonempty.optional(), perceptKind: nonempty.optional(),
  agendaId: nonempty.optional(), driveName: nonempty.optional(), goalId: nonempty.nullable().optional(), messageId: nonempty.optional(), inboxId: nonempty.optional(),
  variant: VariantSchema.optional(), urgent: bool.optional(), ownerInitiated: bool.optional(), anomaly: bool.optional(), toOwner: bool.optional(),
  notBefore: timestamp.optional(), now: timestamp.optional(),
  // P63：这次唤醒属于哪个项目主题；不属于主题的候选不带这一项。
  topicId: nonempty.optional(),
});
export type CandidateInput = z.infer<typeof InputSchema>;

/** 已关闭议程不再催促；到期以真实时间判断，临近一小时包含恰好一小时的边界。 */
export function agendaUrgency(item: AgendaItem, now: number, settings: Settings = resolveSettings()): number {
  if (item.status !== 'open' || item.dueAt === null) return 0;
  if (item.dueAt <= now) return item.toOwner ? settings.c02.agendaOwnerDueScore : settings.c02.agendaDueScore;
  return item.dueAt - now <= settings.c02.agendaSoonMs ? settings.c02.agendaSoonScore : 0;
}
/** 取所有候选分中的最高值，避免不同理由相加造成虚高。 */
export function thinkScore(...scores: Array<number | readonly number[]>): number {
  const values = scores.flatMap(value => typeof value === 'number' ? [value] : [...value]);
  return Math.max(0, ...values.map(value => parseInput(ratio, value, '思考分')));
}

/** 主人发起回合不消耗自主预算；以已有唤醒单识别，未找到唤醒单的账项保守计入。 */
export function fatigueFor(ctx: HubContext, botId: string, now: number): number {
  const bot = ctx.store.table('bots').get(botId);
  if (!bot) throw new Error(`机器人不存在：${botId}`);
  const budget = botBudgetFor(bot.lifecycle, ctx.settings).dailyTurns;
  const turns = ctx.store.log('ledger').since(startOfLocalDay(now, ctx.settings.timezone), row => row.at <= now && row.who === botId && row.kind === 'turn')
    .filter(row => !row.wakeId || !ctx.store.table('wakes').get(row.wakeId)?.ownerInitiated).length;
  return budget === 0 ? 1 : Math.min(1, turns / budget);
}

/** 感知日志与候选共用门槛；只影响普通自主理由，不推迟主人、异常或承诺。 */
export function thresholdForCandidate(ctx: HubContext, input: Pick<CandidateInput,
  'botId' | 'kind' | 'score' | 'ownerInitiated' | 'urgent' | 'anomaly' | 'toOwner' | 'driveName' | 'variant'>, now: number): number {
  const bot = ctx.store.table('bots').get(input.botId);
  if (!bot) throw new Error(`机器人不存在：${input.botId}`);
  const base = thresholdFor(fatigueFor(ctx, bot.id, now), bot.pace, ctx.settings);
  const ordinary = ['percept', 'pile', 'peer_message', 'agenda_due', 'next_think', 'drive'].includes(input.kind);
  const exempt = !ordinary || (input.variant ?? 'regular') !== 'regular' || input.ownerInitiated === true
    || input.urgent === true || input.score >= ctx.settings.salienceUrgent || input.anomaly === true
    || input.toOwner === true || input.driveName === 'obligation';
  return personalityThreshold(base, personalityBehavior(botMbti(ctx, bot.id), ctx.settings), exempt);
}

/** 统一补齐门槛、证据、优先级与事项键，供后续调度去重和解释。 */
export function buildCandidate(ctx: HubContext, input: CandidateInput): Candidate {
  const value = parseInput(InputSchema, input, '候选');
  const bot = ctx.store.table('bots').get(value.botId);
  if (!bot) throw new Error(`机器人不存在：${value.botId}`);
  const now = value.now ?? ctx.clock.now();
  const evidence = [...new Set(value.evidence ?? [])];
  const ownerInitiated = value.ownerInitiated === true || value.kind === 'owner_message';
  const percepts = evidence.map(id => ctx.store.table('percepts').get(id)).filter(item => item !== null);
  const inferredPercept = percepts[0];
  const inbox = value.inboxId ? ctx.store.table('inbox').get(value.inboxId)
    : evidence.map(id => ctx.store.table('inbox').get(id)).find(item => item !== null)
      ?? (inferredPercept?.source === 'inbox' && inferredPercept.location ? ctx.store.table('inbox').get(inferredPercept.location) : null);
  const watchId = value.watchId ?? inferredPercept?.watchId;
  // 真实证据的异常和议程承诺优先，不能靠省略输入字段套上普通性格门槛。
  const anomaly = value.anomaly === true || percepts.some(p => p.anomaly);
  const toOwner = value.toOwner === true || (value.agendaId ? ctx.store.table('agenda').get(value.agendaId)?.toOwner === true : false)
    || (value.kind === 'agenda_due' && evidence.some(id => ctx.store.table('agenda').get(id)?.toOwner === true));
  const threshold = thresholdForCandidate(ctx, { ...value, ownerInitiated, anomaly, toOwner }, now);
  let subjectKey = value.subjectKey ?? inbox?.subjectKey;
  if (!subjectKey) {
    if (value.kind === 'owner_message') subjectKey = `owner:${value.messageId ?? inferredPercept?.location ?? evidence[0] ?? bot.id}`;
    else if (value.agendaId || value.kind === 'agenda_due') subjectKey = `agenda:${value.agendaId ?? evidence[0] ?? bot.id}`;
    else if (value.kind === 'drive') subjectKey = `drive:${value.driveName ?? 'unknown'}${value.goalId ? `:${value.goalId}` : ''}`;
    else if (watchId) subjectKey = `watch:${watchId}`;
    else subjectKey = `src:${value.source ?? inferredPercept?.source ?? 'system'}:${value.perceptKind ?? inferredPercept?.kind ?? value.kind}`;
  }
  return { botId: bot.id, variant: value.variant ?? 'regular',
    reason: { kind: value.kind, score: roundScore(value.score), threshold, summary: value.summary, evidence,
      ...(value.ownerSummary ? { ownerSummary: value.ownerSummary } : inferredPercept && ['approval_decided', 'inbox_reply', 'outbox_done'].includes(inferredPercept.kind)
        ? { ownerSummary: ownerPerceptSummary(ctx, inferredPercept) } : {}) },
    // urgent 只表示感知显著性；到期承诺和内驱的高分不能冒充紧急感知。
    subjectKey, urgent: ['percept', 'pile', 'peer_message', 'owner_message', 'inbox_reply', 'approval_decided'].includes(value.kind)
      && roundScore(value.score) >= ctx.settings.salienceUrgent && value.urgent !== false, ownerInitiated,
    priority: priorityFor({ ...value, anomaly, ownerInitiated }, ctx.settings), notBefore: value.notBefore ?? now,
    ...(value.topicId ? { topicId: value.topicId } : {}) };
}

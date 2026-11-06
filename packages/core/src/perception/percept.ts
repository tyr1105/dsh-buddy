/** 把不同来源的变化转成同一感知记录；先去重再评分，避免重复内容消耗机器人的思考预算。 */
import { z } from 'zod';
import type { HubContext } from '../engine/context.js';
import { parseInput } from '../engine/validation.js';
import { ExpectationDueTimesSchema, PerceptSchema, type Percept } from '../model/perception.js';
import { PerceptSourceSchema } from '../model/enums.js';
import { bool, nonempty, ratio, text, timestamp } from '../model/primitives.js';
import { fingerprint } from '../util/hash.js';
import { newId } from '../util/ids.js';
import { computeSalience, tierFor, roundScore } from '../appraisal/salience.js';
import { logAppraisal } from '../appraisal/log.js';
import { fatigueFor, thresholdFor } from '../appraisal/think.js';
import { ownerPerceptSummary } from '../util/owner-text.js';
import { matchesWatchFilter } from './filter.js';

export const PerceptInputSchema = z.strictObject({
  botId: nonempty, watchId: nonempty.nullable(), source: PerceptSourceSchema, kind: nonempty,
  summary: text, location: text.nullable(), fingerprintMaterial: z.unknown().refine(v => v !== undefined, '指纹原料不能为空'),
  magnitude: ratio, anomaly: bool, untrusted: bool, occurredAt: timestamp,
  dueAt: timestamp.optional(),
  dueAts: ExpectationDueTimesSchema.optional(),
});
export type PerceptInput = z.infer<typeof PerceptInputSchema>;

/** 校验来源、去重并计算显著性，一并保存感知和可追溯的决策日志。 */
export function recordPercept(ctx: HubContext, raw: PerceptInput): Percept | null {
  const input = parseInput(PerceptInputSchema, raw, '感知参数');
  const now = ctx.clock.now();
  const rules = ctx.settings.c02;
  const bot = ctx.store.table('bots').get(input.botId);
  if (!bot) throw new Error(`感知 botId 对应的机器人不存在：${input.botId}`);
  const watch = input.watchId === null ? null : ctx.store.table('watches').get(input.watchId);
  if (input.watchId && (!watch || watch.botId !== input.botId)) throw new Error('感知 watchId 不存在或不属于该机器人');
  const mark = fingerprint(input.fingerprintMaterial);
  const history = ctx.store.table('percepts').list(p => p.botId === input.botId && p.createdAt <= now);
  const recent = history.filter(p => p.createdAt > now - ctx.settings.dedupWindowMs);
  // 疲劳直接由今天的实际回合账本计算，避免内驱快照尚未刷新时使用旧门槛。
  const threshold = thresholdFor(fatigueFor(ctx, input.botId, now), bot.pace, ctx.settings);
  if (recent.some(p => p.fingerprint === mark)) {
    logAppraisal(ctx, { botId: input.botId, at: now, perceptIds: [], score: 0, threshold,
      decision: 'record_only', suppressedBy: 'dedup', text: '相同内容在去重窗口内已出现，本次只记录，不重复产生感知' });
    return null;
  }
  // 明确引用的目标优先；没有引用时使用机器人当前目标的重要度。
  const goals = ctx.store.table('goals').list(g => g.botId === input.botId);
  const referenced = goals.filter(g => watch?.why.includes(g.id));
  const relevantGoals = referenced.length ? referenced : goals.filter(g => g.status === 'active');
  const importance = relevantGoals.length ? Math.max(...relevantGoals.map(g => g.importance)) : rules.defaultImportance;
  const relevance = (watch?.relevance ?? ctx.settings.watchRelevanceByCreator.hub)
    * (matchesWatchFilter(watch?.filter ?? null, input.summary, ctx.settings) ? 1 : rules.unmatchedFilterMultiplier);
  // 新奇度与指纹去重使用独立窗口，缩短去重配置不会意外消除同关注项的近期历史。
  const novelty = watch && history.some(p => p.watchId === watch.id && p.createdAt > now - rules.noveltyWindowMs)
    ? rules.repeatedNovelty : 1;
  const age = Math.max(0, now - input.occurredAt);
  const urgency = input.kind === 'expectation_missed' || age <= rules.recentUrgencyMs ? rules.urgencyRecent
    : age <= rules.middleUrgencyMs ? rules.urgencyMiddle : rules.urgencyOld;
  const parts = { relevance, novelty, magnitude: input.magnitude, importance, urgency, anomaly: input.anomaly };
  let { salience } = computeSalience(parts, ctx.settings);
  if (input.kind === 'owner_message') salience = rules.ownerSalience;
  else if (input.kind === 'inbox_reply' || input.kind === 'approval_decided') salience = rules.replySalience;
  else if (input.kind === 'peer_message' || input.kind === 'handoff') salience = Math.min(rules.peerSalienceMax, salience);
  else if (input.source === 'system' && input.kind === 'downtime') salience = rules.downtimeSalience;
  else if (input.source === 'system' && input.kind === 'outbox_done') salience = ctx.settings.c03.outboxDoneSalience;
  else if (input.source === 'system' && input.kind === 'team_attention') salience = ctx.settings.salienceCandidate;
  // 特殊来源的可覆盖分值也统一四位小数，再进入分档与日志。
  salience = roundScore(salience);
  // 模型的摘要限额按 UTF-16 字符计数；不在代理对中间截断。
  let summary = input.summary.slice(0, rules.summaryMaxChars);
  if (/[\uD800-\uDBFF]$/.test(summary)) summary = summary.slice(0, -1);
  const percept = PerceptSchema.parse({ id: newId('p', ctx.rng), botId: input.botId, watchId: input.watchId,
    source: input.source, kind: input.kind, summary, location: input.location, fingerprint: mark,
    ...parts, salience, untrusted: input.untrusted, tier: tierFor(salience, ctx.settings), consumedByWake: null,
    ...(input.dueAt === undefined ? {} : { dueAt: input.dueAt }),
    ...(input.dueAts === undefined ? {} : { dueAts: input.dueAts }), createdAt: now });
  ctx.store.table('percepts').put(percept);
  if (salience >= ctx.settings.noChangeResetSalience && bot.noChangeStreak !== 0) ctx.store.table('bots').patch(bot.id, { noChangeStreak: 0, updatedAt: now });
  const decision = percept.tier === 'pile' ? 'pile' : percept.tier === 'record' ? 'record_only' : 'queued';
  logAppraisal(ctx, { botId: input.botId, at: now, perceptIds: [percept.id], score: salience, threshold, decision,
    suppressedBy: null, text: `${ownerPerceptSummary(ctx, percept)}，显著性 ${salience.toFixed(2)}，${decision === 'pile' ? '进入待处理堆' : decision === 'queued' ? '等待候选评估' : '只记录'}` });
  // 日志写入已发出变化通知，同一条感知不再重复通知界面。
  return percept;
}

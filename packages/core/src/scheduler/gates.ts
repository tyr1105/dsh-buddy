/** 九道闸按规格顺序执行：紧急只越过冷却与节奏，预算和额度始终保留最终保护。 */
import type { QueueEntry, Settings } from '../model/index.js';
import type { SuppressedBy } from '../appraisal/log.js';
import type { GateSnapshot } from './snapshot.js';
import { botBudgetFor, dailyThinkCapFor } from '../config/defaults.js';
import { effectivePaceMinMs } from './pacing.js';
import { nextLocalTime } from '../util/time.js';
export { buildSnapshot } from './snapshot.js';
export type { GateSnapshot } from './snapshot.js';
export type GateResult = { pass: true } | { pass: false; by: SuppressedBy; until: number | null; drop: boolean };
const blocked = (by: SuppressedBy, until: number | null = null, drop = false): GateResult => ({ pass: false, by, until, drop });

/** 按规格顺序执行九道放行检查，返回首个拦截原因和恢复时刻供审计。 */
export function evaluateGates(entry: QueueEntry, snapshot: GateSnapshot, now: number, settings: Settings): GateResult {
  const s = snapshot;
  const bot = s.bot;
  // 1–3：先处理生命周期、同机器人互斥和正在等主人回答的同一事项。
  if (!bot || !['active', 'probation'].includes(bot.lifecycle)) return blocked('paused', null, true);
  if (s.running) return blocked('concurrency');
  const hasOwnerInput = entry.ownerInitiated || ['owner_message', 'inbox_reply'].includes(entry.reason.kind)
    || entry.reason.evidence.some(id => s.ownerEvidenceIds?.has(id));
  if (s.openQuestionSubjects.has(entry.subjectKey) && !hasOwnerInput) return blocked('waiting_owner_same_subject', null, true);
  // 4–5：紧急与审批可越过节奏；主人主动发起也不用等最短间隔。
  const previous = s.subjectWakeAt.get(entry.subjectKey);
  if (previous !== undefined && now < previous + settings.subjectCooldownMs && !entry.urgent && !entry.ownerInitiated && !['owner_message', 'approval_decided'].includes(entry.reason.kind)) {
    return blocked('cooldown', previous + settings.subjectCooldownMs);
  }
  if (!entry.urgent && !entry.ownerInitiated && entry.reason.kind !== 'approval_decided' && bot.lastThinkAt !== null) {
    const until = bot.lastThinkAt + effectivePaceMinMs(bot, settings, s.quota.light);
    if (now < until) return blocked('pace_min', until);
  }
  // 6：自主预算仅统计自主回合；窗口预算等到窗口结束，日预算等本地次日。
  if (!entry.ownerInitiated) {
    const tomorrow = nextLocalTime('00:00', now, settings.timezone);
    if (s.todayTurns >= dailyThinkCapFor(bot.autonomy, bot.lifecycle, settings)) return blocked('daily_cap', tomorrow);
    const budget = botBudgetFor(bot.lifecycle, settings);
    if (s.todayTurns >= budget.dailyTurns || s.todayTokens >= budget.dailyTokens) return blocked('bot_budget', tomorrow);
    if (s.windowTurns >= budget.windowTurns) return blocked('bot_budget', Math.max(now, s.quota.windowStartAt + settings.quotaWindowMs));
  }
  // 7：鉴权直到人工确认；红灯只有已授予的一次探针可进入后续闸门。
  if (s.authBlocked) return blocked('quota');
  if (s.quota.light === 'red' && !s.quota.probeAllowed) return blocked('quota', s.quota.redUntil);
  if (s.quota.light === 'orange' && !entry.urgent && !entry.ownerInitiated) return blocked('quota', s.quota.windowStartAt + settings.quotaWindowMs);
  // 8：主人主动发起豁免启动静默与全局间隔，但不豁免并发。
  if (!entry.ownerInitiated && now < s.startedAt + settings.startupQuietMs) return blocked('startup_quiet', s.startedAt + settings.startupQuietMs);
  if (!entry.ownerInitiated && s.lastDispatchAt !== null && now < s.lastDispatchAt + settings.dispatchGapMs) return blocked('dispatch_gap', s.lastDispatchAt + settings.dispatchGapMs);
  const ownerPresent = s.ownerActiveAt !== null && s.ownerActiveAt <= now && now - s.ownerActiveAt < settings.ownerAwayAfterMs;
  if (s.runningCount >= (ownerPresent ? settings.ownerActiveConcurrentThinks : settings.maxConcurrentThinks)) return blocked('concurrency');
  // 9：notBefore 也是明确的最早执行时间，不允许高优先级绕过未到时的重排。
  const retryAt = Math.max(s.retryAt ?? now, entry.notBefore);
  if (retryAt > now) return blocked('retry_backoff', retryAt);
  return { pass: true };
}

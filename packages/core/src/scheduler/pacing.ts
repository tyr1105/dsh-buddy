/** 无变化时延长下次思考间隔；进展或高显著性感知恢复基础节奏，黄色额度额外减速。 */
import { paceMinMsFor } from '../config/defaults.js';
import type { Bot, Outcome, QuotaState, Settings } from '../model/index.js';
/** 叠加无变化退避与额度灯倍率，计算当前最短思考间隔。 */
export function effectivePaceMinMs(bot: Bot, settings: Settings, quotaLight: QuotaState['light']): number {
  const base = paceMinMsFor(bot.role, bot.pace, settings);
  const backoff = Math.min(settings.noChangeBackoffMaxMs, base * settings.noChangeBackoffMultiplier ** bot.noChangeStreak);
  return backoff * (quotaLight === 'yellow' ? settings.quotaYellowPaceMultiplier : 1);
}
/** 根据交账结果更新退避次数，取得进展时恢复正常节奏。 */
export function afterOutcome(bot: Bot, outcome: Outcome, hadHighPercept: boolean): Partial<Bot> {
  if (outcome === 'progress' || outcome === 'done' || hadHighPercept) return { noChangeStreak: 0 };
  if (outcome === 'no_change') return { noChangeStreak: bot.noChangeStreak + 1 };
  return { noChangeStreak: bot.noChangeStreak };
}

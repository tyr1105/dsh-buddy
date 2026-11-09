/** 决策日志把机器分数转成主人可读的解释；不触发通知，只追加可追溯记录。 */
import { ownerReasonSummary } from '../util/owner-text.js';
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import type { HubContext } from '../engine/context.js';
import { parseInput } from '../engine/validation.js';
import { AppraisalLogSchema } from '../model/operations.js';
import type { AppraisalLog, QueueEntry } from '../model/index.js';
import { newId } from '../util/ids.js';
import { formatShort } from '../util/time.js';
export type SuppressedBy = NonNullable<AppraisalLog['suppressedBy']>;
/** 校验并追加决策证据，再通知界面刷新，便于追溯为何醒或未醒。 */
export function logAppraisal(ctx: HubContext, entry: Omit<AppraisalLog, 'id' | 'at'> & { at?: number }): AppraisalLog {
  const row = parseInput(AppraisalLogSchema, { ...entry, at: entry.at ?? ctx.clock.now(), id: newId('ev', ctx.rng) }, '评估日志');
  ctx.store.log('appraisals').append(row);
  ctx.emit(HUB_EVENT_SCOPES.bot, row.botId);
  return row;
}
/** 把闸门原因与恢复时刻转成中文，给主人可读的等待依据。 */
export function explainSuppression(entry: QueueEntry, by: SuppressedBy, until: number | null, now: number, timezone: string, turns?: number, ownerSummary?: string): string {
  const resume = until === null ? '' : `，等到${formatShort(until, now, timezone)}`;
  const reasons: Record<SuppressedBy, string> = {
    paused: '机器人尚未在岗，移出队列', waiting_owner_same_subject: '在等你回复同一件事，不再叫醒',
    waiting_owner: '有提问或审批在等你回复，先不自己找事做',
    cooldown: '同一件事仍在冷却期', pace_min: '距上次思考太近，按当前节奏稍后再想',
    daily_cap: `今天已想了 ${turns ?? 0} 次，到上限`, bot_budget: '已达到机器人回合或 token 预算',
    quota: '额度或鉴权保护，暂停放行', concurrency: '已有机器人正在思考，等待空位',
    dispatch_gap: '距上次放行太近，稍后再放行', startup_quiet: '中心正在启动对账',
    dedup: '同一指纹已经记录，不重复处理', retry_backoff: '上次出错，等待重排时间',
  };
  return `${ownerSummary ?? ownerReasonSummary(entry.reason)}：${reasons[by]}${resume}`;
}

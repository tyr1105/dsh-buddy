/** 期望落空按本地自然日限报一次；使用注入的 now，停机后也能检查真实期限。 */
import type { HubContext } from '../engine/context.js';
import type { Percept } from '../model/perception.js';
import { localDateKey, parseLocalDateTime } from '../util/time.js';
import { expectationPeriodStart, isExpectationCheckDay } from '../util/expectation-calendar.js';
import { formatExpectation } from '../util/expectation-text.js';
import { expectationEffectiveAt } from '../util/expectation-effective.js';
import { recordPercept } from './percept.js';

/** 按周期或本地钟点发现期望落空，同日同关注项只报一次。 */
export function checkExpectations(ctx: HubContext, now: number): Percept[] {
  const day = localDateKey(now, ctx.settings.timezone);
  const result: Percept[] = [];
  for (const watch of ctx.store.table('watches').list(w => w.status === 'active' && w.expectation !== null)) {
    const expectation = watch.expectation!;
    const effectiveAt = expectationEffectiveAt(watch);
    if (now < effectiveAt) continue;
    // 非检查日只跳过落空判断，不改满足事实或上次落空时间。
    if (!isExpectationCheckDay(expectation.weekdays, now, ctx.settings.timezone)) continue;
    if (expectation.lastMissedAt !== null && expectation.lastMissedAt >= effectiveAt
      && localDateKey(expectation.lastMissedAt, ctx.settings.timezone) === day) continue;
    // 文件已经变化，只是在等待两分钟合批；先等批次确认，不能抢先宣布未出现。
    if (ctx.runtime.pendingFileEvents.has(watch.id)) continue;
    // 休息日不能累计为欠期；连续检查日内则继续使用原起点，不能每天重置。
    const periodStart = expectation.everyMs !== null
      ? expectationPeriodStart(expectation.weekdays, now, ctx.settings.timezone) : null;
    const since = Math.max(expectation.lastSatisfiedAt ?? watch.createdAt, effectiveAt, periodStart ?? -Infinity);
    const elapsed = expectation.everyMs !== null && now - since > expectation.everyMs;
    const deadline = expectation.byLocalTime === null ? null : parseLocalDateTime(`${day} ${expectation.byLocalTime}`, ctx.settings.timezone);
    // 当日期限已经过去才设立期望时，不追溯补报；修改之前的满足也不能代替新期望的结果。
    const missedTime = deadline !== null && deadline >= effectiveAt && now > deadline
      && (expectation.lastSatisfiedAt === null || expectation.lastSatisfiedAt < effectiveAt
        || localDateKey(expectation.lastSatisfiedAt, ctx.settings.timezone) !== day);
    if (!elapsed && !missedTime) continue;
    // 单条感知仍每天最多一次；双期限可能分属两天，必须同时保留以免后来的满足抹掉另一日的落空。
    // everyMs 的原入口允许小数；是否逾期仍精确比较，仅把存档日期投影到模型的整数毫秒精度。
    const dueAts = [...new Set([...(elapsed ? [Math.floor(since + expectation.everyMs!)] : []), ...(missedTime ? [deadline!] : [])])].sort((a, b) => a - b);
    const dueAt = dueAts[0]!;
    const percept = recordPercept(ctx, { botId: watch.botId, watchId: watch.id, source: watch.kind, kind: 'expectation_missed',
      summary: `期望落空：${expectation.weekdays == null ? expectation.text : formatExpectation(expectation)}`, location: watch.target,
      // 同日修改期望或恢复后属于新的检查阶段，不能被旧阶段的落空指纹吞掉。
      fingerprintMaterial: [watch.id, 'expectation_missed', day, effectiveAt],
      magnitude: 1, anomaly: true, untrusted: false, occurredAt: dueAt, dueAt, dueAts });
    ctx.store.table('watches').patch(watch.id, { expectation: { ...expectation, lastMissedAt: now, lastMissedDueAt: dueAt, lastMissedDueAts: dueAts }, updatedAt: now });
    if (percept) result.push(percept);
  }
  return result;
}

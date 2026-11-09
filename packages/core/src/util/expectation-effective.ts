/** 期望只从设置或恢复生效后开始检查；检查器与日报复用相同边界，旧档回退关注项创建时间。 */
import type { Watch } from '../model/perception.js';
import { localDateKey, parseLocalDateTime } from './time.js';
import { expectationPeriodStart } from './expectation-calendar.js';

/** effectiveAt 保存最近一次设置或转为 active 的较晚时刻；旧字段缺省不能取 updatedAt。 */
export function expectationEffectiveAt(watch: Watch): number {
  return watch.expectation?.effectiveAt ?? watch.createdAt;
}

/** 判断该统计日是否已有到期点；星期资格由调用方判断，双期限任一到期即可检查。 */
export function isExpectationStartedOnDay(watch: Watch, dayTimestamp: number, timezone: string): boolean {
  const expectation = watch.expectation;
  if (!expectation) return false;
  const effectiveAt = expectationEffectiveAt(watch);
  // 首次到期必须落在该日结束前；比较本地日期避免把夏令时自然日误当固定 24 小时。
  if (expectation.everyMs !== null) {
    const periodStart = expectationPeriodStart(expectation.weekdays, dayTimestamp, timezone);
    const firstDueAt = Math.max(effectiveAt, periodStart ?? effectiveAt) + expectation.everyMs;
    if (localDateKey(firstDueAt, timezone) <= localDateKey(dayTimestamp, timezone)) return true;
  }
  return expectation.byLocalTime !== null
    && parseLocalDateTime(`${localDateKey(dayTimestamp, timezone)} ${expectation.byLocalTime}`, timezone) >= effectiveAt;
}

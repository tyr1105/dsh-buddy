/** 期望日历只计算检查资格与连续日的边界；显式传入时刻、时区，不读取机器时钟。 */
import { localParts, startOfLocalDay } from './time.js';

/** 周日与周一相邻；最多走两个星期，就能找到跨周的最长连续检查段。 */
export function longestExpectationCheckSpan(weekdays: readonly number[]): number {
  const days = new Set(weekdays);
  let longest = 0;
  let current = 0;
  for (let index = 0; index < 14; index += 1) {
    current = days.has(index % 7 + 1) ? current + 1 : 0;
    longest = Math.max(longest, Math.min(current, 7));
  }
  return longest;
}

/** 日历工具把周日记为 0，期望协议把周日记为 7；转换后再判断本地检查日。 */
export function isExpectationCheckDay(weekdays: readonly number[] | null | undefined, now: number, timezone: string): boolean {
  return weekdays == null || weekdays.includes(localParts(now, timezone).weekday || 7);
}

/**
 * 找到本段连续检查日的第一天。每天检查没有中断边界，返回 null，保留原周期起点。
 * 从本地午夜前一毫秒回退一天，避免把夏令时的本地日错误地当作固定 24 小时。
 */
export function expectationPeriodStart(weekdays: readonly number[] | null | undefined, now: number, timezone: string): number | null {
  if (weekdays == null || !isExpectationCheckDay(weekdays, now, timezone)) return null;
  const days = new Set(weekdays);
  // 全七天与每天等价，不人为制造每周重置，也避免沿连续日无限回退。
  if (days.size === 7) return null;
  let start = startOfLocalDay(now, timezone);
  for (let offset = 1; offset < days.size; offset += 1) {
    const previous = start - 1;
    if (!isExpectationCheckDay(weekdays, previous, timezone)) break;
    start = startOfLocalDay(previous, timezone);
  }
  return start;
}

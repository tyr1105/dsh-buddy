/** 期望的日程文案统一在这里生成，让详情、日报和唤醒理由对检查日期使用同一种说法。 */
import type { Expectation } from '../model/perception.js';
import { formatDuration } from './time.js';

/** 常见日程使用短称；其他组合逐日列明，避免把指定星期误说成每天。 */
export function expectationWeekdaysText(weekdays: readonly number[] | null | undefined): string {
  if (weekdays == null) return '';
  const days = [...new Set(weekdays)].sort((a, b) => a - b);
  const key = days.join(',');
  if (key === '1,2,3,4,5') return '工作日';
  if (key === '6,7') return '周末';
  const labels = ['一', '二', '三', '四', '五', '六', '日'];
  return `每周${days.map(day => labels[day - 1]).join('、')}`;
}

/** 保留每日期望原有文案，仅在指定星期时补出日期范围与对应期限。 */
export function formatExpectation(expectation: Expectation): string {
  const days = expectationWeekdaysText(expectation.weekdays);
  const schedule: string[] = [];
  if (expectation.byLocalTime !== null) {
    const daily = days.startsWith('每周') ? days : `${days}每天`;
    schedule.push(`${daily} ${expectation.byLocalTime} 前`);
  }
  if (expectation.everyMs !== null) {
    const prefix = days && expectation.byLocalTime === null ? `${days}，` : '';
    schedule.push(`${prefix}每 ${formatDuration(expectation.everyMs)}`);
  }
  if (schedule.length === 0 && days) schedule.push(days);
  return [expectation.text, ...schedule].join('，');
}

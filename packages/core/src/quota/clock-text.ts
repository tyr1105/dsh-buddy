/**
 * 额度相关文字里的时刻写法（P76d，任务卡 4.7）：按设置的时区写「HH:mm」；不是今天的，写「{M}月{D}日 HH:mm」。
 *
 * 为什么单独一个文件：员工的活动文字、进度行、额度视图、中心落的话都要写同一个时刻，
 * 写法只放一处，几处文字才不会各说各话（例如恢复时间一个写 18:25、一个写 6:25）。纯函数，不读时钟。
 */
import { localParts } from '../util/time.js';

const pad = (value: number): string => String(value).padStart(2, '0');

/** 把时刻写成给主人看的文字；与 now 同一天的只写钟点，跨日的带上月日。 */
export function quotaClockText(at: number, now: number, timezone: string): string {
  const target = localParts(at, timezone);
  const today = localParts(now, timezone);
  const clock = `${pad(target.hour)}:${pad(target.minute)}`;
  const sameDay = target.year === today.year && target.month === today.month && target.day === today.day;
  return sameDay ? clock : `${target.month}月${target.day}日 ${clock}`;
}

/**
 * 从额度用完的报错正文里取出「什么时候恢复」（P76d，方案 7.1，P76a 的裁定：正文完整到达，调用它）。
 *
 * 为什么要有：宿主报给中心的只有模型服务那一句话，恢复时刻就在这句话里，例如
 * 「已达到 5 小时的使用上限，将于 15:53 恢复」「已达到 5 小时的使用上限，将在 2026-11-13 16:14:31 重置」。
 * 按这个时刻等，比按「窗口起点加 5 小时」估计准。
 *
 * 这是纯函数：时间、时区都由参数给出，不读时钟。
 *
 * 认的写法，按下面的顺序找，取第一个解析成功的：
 * 1. 带日期的完整时刻：「2026-11-13T07:53:00+08:00」这类带时区的，以及「2026-11-13 16:14:31」这类空格分隔、不带时区的
 *    （后者按设置的时区理解）。必须先认它：否则「2026-11-13 16:14:31」里的「16:14」会被当成「今天的 16:14」。
 * 2. 单独的「HH:mm」：取今天这个时刻，已经过了就取明天。
 * 3. 「N 分钟后」「N 小时后」「in N minutes」「in N hours」。
 * 解析出的时刻必须在 (now, now + RESET_TEXT_MAX_AHEAD_MS] 之间，否则返回 null（宁可退回估计，也不信一个不合理的时刻）。
 * 第一个解析成功的结果不在范围里时直接返回 null，不再往后找别的写法：后面的写法更含糊，拿来顶替会更不可靠。
 */
import { BUDGET_DEFAULTS } from '../config/defaults.js';
import { nextLocalTime, parseFlexibleTime, parseLocalDateTime } from '../util/time.js';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** 带日期的时刻（带不带时区、带不带秒都认）。用于第 1 种写法，也用来在找「HH:mm」之前把它们从正文里去掉。 */
const DATE_TIME = /(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:\s?([Zz]|[+-]\d{2}:?\d{2}))?/g;

/** 第 1 种：带日期的完整时刻；找不到或不是合法日期返回 null。 */
function parseDated(text: string, timezone: string): number | null {
  for (const match of text.matchAll(DATE_TIME)) {
    const [, year, month, day, hour, minute, second, zone] = match;
    if (zone !== undefined) {
      // 带时区：交给通用解析（要求「T」分隔、秒可省）；统一补成它认的写法。
      const iso = `${year}-${month}-${day}T${hour}:${minute}:${second ?? '00'}${zone.replace(/^([+-]\d{2})(\d{2})$/, '$1:$2')}`;
      const value = parseFlexibleTime(iso, timezone);
      if (value !== null) return value;
      continue;
    }
    try {
      // 不带时区：按设置的时区理解；parseLocalDateTime 只到分钟，秒另外加。
      return parseLocalDateTime(`${year}-${month}-${day} ${hour}:${minute}`, timezone) + Number(second ?? 0) * 1000;
    } catch { /* 不存在的日期，试下一处。 */ }
  }
  return null;
}

/** 第 2 种：单独的「HH:mm」或「H:mm」；已经过了就取明天。 */
function parseClock(text: string, now: number, timezone: string): number | null {
  // 先把带日期的时刻整段去掉，免得拿到它里面的钟点。
  const rest = text.replace(DATE_TIME, ' ');
  for (const match of rest.matchAll(/(?<![\d:])(\d{1,2}):(\d{2})(?![\d:])/g)) {
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour > 23 || minute > 59) continue;
    try { return nextLocalTime(`${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`, now, timezone); }
    catch { /* 这个钟点在该时区不存在（夏令时），试下一处。 */ }
  }
  return null;
}

/** 第 3 种：「N 分钟后」「N 小时后」「in N minutes」「in N hours」。 */
function parseRelative(text: string, now: number): number | null {
  const hoursZh = /(\d+)\s*个?\s*小时(?:\s*(\d+)\s*分钟?)?\s*(?:之)?后/.exec(text);
  if (hoursZh) return now + Number(hoursZh[1]) * HOUR_MS + Number(hoursZh[2] ?? 0) * MINUTE_MS;
  const minutesZh = /(\d+)\s*分钟\s*(?:之)?后/.exec(text);
  if (minutesZh) return now + Number(minutesZh[1]) * MINUTE_MS;
  const hoursEn = /\bin\s+(\d+)\s*(?:hours?|hrs?)\b(?:\s*(?:and\s+)?(\d+)\s*(?:minutes?|mins?)\b)?/i.exec(text);
  if (hoursEn) return now + Number(hoursEn[1]) * HOUR_MS + Number(hoursEn[2] ?? 0) * MINUTE_MS;
  const minutesEn = /\bin\s+(\d+)\s*(?:minutes?|mins?)\b/i.exec(text);
  if (minutesEn) return now + Number(minutesEn[1]) * MINUTE_MS;
  return null;
}

/** 从报错正文取恢复时刻（毫秒时间戳）；取不到或不合理返回 null。 */
export function parseResetAt(text: string, now: number, timezone: string): number | null {
  const found = parseDated(text, timezone) ?? parseClock(text, now, timezone) ?? parseRelative(text, now);
  if (found === null) return null;
  return found > now && found <= now + BUDGET_DEFAULTS.RESET_TEXT_MAX_AHEAD_MS ? found : null;
}

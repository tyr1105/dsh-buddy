/**
 * 显式时区的时间工具：所有时刻都来自调用方，避免测试和真实运行依赖机器所在时区。
 * 本地时间先校验日历，再通过 Intl 反查时区偏移；夏令时缺失时刻拒绝，重复时刻取较早者。
 */
import { TIME_CACHE_LIMIT } from '../config/defaults.js';

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
}

const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const formatters = new Map<string, Intl.DateTimeFormat>();
const partsCache = new Map<string, LocalParts>();
const candidatesCache = new Map<string, number[]>();
const dayCache = new Map<string, number>();
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const;

/** 仅缓存纯函数结果，达到容量时淘汰最早项，长期运行不会无限增长。 */
function remember<T>(cache: Map<string, T>, key: string, value: T): T {
  if (cache.size >= TIME_CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  cache.set(key, value);
  return value;
}

/** 缓存只影响计算开销，不参与结果；时区无效时给出可定位的中文错误。 */
function formatter(tz: string): Intl.DateTimeFormat {
  const cached = formatters.get(tz);
  if (cached) return cached;
  try {
    const value = new Intl.DateTimeFormat('en-US-u-ca-iso8601-nu-latn', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    });
    formatters.set(tz, value);
    return value;
  } catch {
    throw new Error(`时区不正确：${tz}`);
  }
}

/** 用 UTC 日历容器运算年月日；显式设完整年份，避免 0–99 年被当作 1900 年代。 */
function civilMs(year: number, month: number, day: number, hour = 0, minute = 0, second = 0): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  return date.getTime();
}

/** 先验证时间可由日历表示，防止后续格式化产生隐晦异常。 */
function assertTimestamp(ms: number): void {
  if (!Number.isFinite(ms) || Number.isNaN(new Date(ms).getTime())) {
    throw new Error('时间戳必须是有效的 Unix 毫秒数');
  }
}

/** 拆出指定时区的日历字段；星期按该本地日期计算，与宿主时区无关。 */
export function localParts(ms: number, tz: string): LocalParts {
  assertTimestamp(ms);
  const key = `${tz}:${ms}`;
  const cached = partsCache.get(key);
  if (cached) return { ...cached };
  const parts = formatter(tz).formatToParts(ms);
  const pick = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((part) => part.type === type)?.value);
  const year = pick('year');
  const month = pick('month');
  const day = pick('day');
  const value = {
    year, month, day, hour: pick('hour'), minute: pick('minute'), second: pick('second'),
    weekday: new Date(civilMs(year, month, day)).getUTCDay(),
  };
  remember(partsCache, key, value);
  return { ...value };
}

const pad = (value: number): string => String(value).padStart(2, '0');
const dateKey = (p: Pick<LocalParts, 'year' | 'month' | 'day'>): string => `${String(p.year).padStart(4, '0')}-${pad(p.month)}-${pad(p.day)}`;

/** 生成指定时区的日期键，使日志分日与预算重置保持一致。 */
export function localDateKey(ms: number, tz: string): string {
  return dateKey(localParts(ms, tz));
}

/** 拒绝不存在的日历日期和自动溢出的小时，避免 2 月 30 日悄悄变成 3 月。 */
function validCivil(year: number, month: number, day: number, hour: number, minute: number, second = 0): boolean {
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31 || hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) return false;
  const date = new Date(civilMs(year, month, day, hour, minute, second));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** 探测目标前后可能的偏移，并逐一往返校验，涵盖换日线和非整小时夏令时。 */
function localCandidates(year: number, month: number, day: number, hour: number, minute: number, tz: string): number[] {
  const key = `${tz}:${year}:${month}:${day}:${hour}:${minute}`;
  const cached = candidatesCache.get(key);
  if (cached) return [...cached];
  const local = civilMs(year, month, day, hour, minute);
  const offsets = new Set<number>();
  for (let delta = -48; delta <= 48; delta += 6) {
    const sample = local + delta * HOUR_MS;
    const p = localParts(sample, tz);
    offsets.add(civilMs(p.year, p.month, p.day, p.hour, p.minute, p.second) - sample);
  }
  const result = [...offsets].map((offset) => local - offset).filter((candidate) => {
    const p = localParts(candidate, tz);
    return p.year === year && p.month === month && p.day === day && p.hour === hour && p.minute === minute && p.second === 0;
  }).sort((a, b) => a - b);
  remember(candidatesCache, key, result);
  return [...result];
}

/** 严格解析本地日期并反查真实时刻，拒绝不存在的日期或夏令时钟点。 */
export function parseLocalDateTime(text: string, tz: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(text);
  if (!match) throw new Error('本地时间格式不正确，应为 YYYY-MM-DD HH:mm');
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [number, number, number, number, number];
  if (!validCivil(year, month, day, hour, minute)) throw new Error(`本地日期或时刻不正确：${text}`);
  const result = localCandidates(year, month, day, hour, minute, tz)[0];
  if (result === undefined) throw new Error(`该本地时刻在时区 ${tz} 不存在：${text}`);
  return result;
}

/** 只接受明确带时区的 ISO 时间或指定本地格式，避免系统猜测日期格式与时区。 */
export function parseFlexibleTime(text: string, tz: string): number | null {
  try {
    const value = text.trim();
    formatter(tz);
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(value)) return parseLocalDateTime(value, tz);
    const iso = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?([Zz]|[+-]\d{2}:?\d{2})$/.exec(value);
    if (!iso) return null;
    const [year, month, day, hour, minute] = iso.slice(1, 6).map(Number) as [number, number, number, number, number];
    const second = Number(iso[6] ?? 0);
    if (!validCivil(year, month, day, hour, minute, second)) return null;
    const zone = iso[8]!;
    const offset = zone.toUpperCase() === 'Z' ? null : /^([+-])(\d{2}):?(\d{2})$/.exec(zone);
    if (offset && (Number(offset[2]) > 23 || Number(offset[3]) > 59)) return null;
    const offsetMinutes = offset ? (Number(offset[2]) * 60 + Number(offset[3])) * (offset[1] === '+' ? 1 : -1) : 0;
    const fraction = Number((iso[7] ?? '').slice(0, 3).padEnd(3, '0'));
    return civilMs(year, month, day, hour, minute, second) + fraction - offsetMinutes * MINUTE_MS;
  } catch {
    return null;
  }
}

/** 将合法钟点换成日内分钟，便于比较跨午夜免打扰区间。 */
function clockMinutes(text: string): number {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(text)) throw new Error(`钟点格式不正确，应为 HH:mm：${text}`);
  return Number(text.slice(0, 2)) * 60 + Number(text.slice(3));
}

/** 免打扰采用左闭右开区间；跨午夜时拆成晚间和次日清晨两段。 */
export function isInQuietHours(ms: number, quietHours: { start: string; end: string }, tz: string): boolean {
  const start = clockMinutes(quietHours.start);
  const end = clockMinutes(quietHours.end);
  const p = localParts(ms, tz);
  const current = p.hour * 60 + p.minute;
  if (start === end) return false;
  return start < end ? current >= start && current < end : current >= start || current < end;
}

/** 找严格晚于给定时刻的下一个钟点；跳过夏令时不存在的钟点或整日。 */
export function nextLocalTime(time: string, afterMs: number, tz: string): number {
  const minutes = clockMinutes(time);
  const p = localParts(afterMs, tz);
  const dayStart = civilMs(p.year, p.month, p.day);
  for (let dayOffset = 0; dayOffset <= 370; dayOffset += 1) {
    const date = new Date(dayStart + dayOffset * DAY_MS);
    const candidates = localCandidates(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), Math.floor(minutes / 60), minutes % 60, tz);
    const result = candidates.find((candidate) => candidate > afterMs);
    if (result !== undefined) return result;
  }
  throw new Error(`无法找到时区 ${tz} 的下一个钟点：${time}`);
}

/** 午夜若因夏令时被跳过，则本地日从当天第一个真实存在的分钟开始。 */
export function startOfLocalDay(ms: number, tz: string): number {
  const p = localParts(ms, tz);
  const key = `${tz}:${dateKey(p)}`;
  const cached = dayCache.get(key);
  if (cached !== undefined) return cached;
  for (let minute = 0; minute < 24 * 60; minute += 1) {
    const candidate = localCandidates(p.year, p.month, p.day, Math.floor(minute / 60), minute % 60, tz)[0];
    if (candidate !== undefined) return remember(dayCache, key, candidate);
  }
  throw new Error(`无法找到本地日期的开始：${dateKey(p)}`);
}

/** 按本地日历比较昨天/明天，不能用 24 小时差判断夏令时附近的日期。 */
export function formatShort(ms: number, nowMs: number, tz: string): string {
  const p = localParts(ms, tz);
  const now = localParts(nowMs, tz);
  const days = (civilMs(p.year, p.month, p.day) - civilMs(now.year, now.month, now.day)) / DAY_MS;
  const clock = `${pad(p.hour)}:${pad(p.minute)}`;
  const relative = days === 0 ? '今天' : days === -1 ? '昨天' : days === 1 ? '明天' : null;
  if (relative) return `${relative} ${clock}`;
  return `${p.year === now.year ? '' : `${p.year}年`}${p.month}月${p.day}日 ${clock}`;
}

/** 按显式当前时间生成多久以前或以后的短文案，不读取系统时钟。 */
export function formatAgo(ms: number, nowMs: number): string {
  assertTimestamp(ms);
  assertTimestamp(nowMs);
  const delta = Math.abs(nowMs - ms);
  if (delta < MINUTE_MS) return '刚刚';
  const suffix = ms > nowMs ? '后' : '前';
  if (delta < HOUR_MS) return `${Math.floor(delta / MINUTE_MS)} 分钟${suffix}`;
  if (delta < DAY_MS) return `${Math.floor(delta / HOUR_MS)} 小时${suffix}`;
  return `${Math.floor(delta / DAY_MS)} 天${suffix}`;
}

/** 小于一小时显示分钟或秒，长时长保留小时和剩余分钟。 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) throw new Error('时长必须是非负的毫秒数');
  const hours = Math.floor(ms / HOUR_MS);
  const minutes = Math.floor(ms / MINUTE_MS) % 60;
  if (hours > 0) return minutes > 0 ? `${hours} 小时 ${minutes} 分` : `${hours} 小时`;
  if (minutes > 0) return `${minutes} 分钟`;
  return `${Math.floor(ms / SECOND_MS)} 秒`;
}

/** 把日历星期值转成中文，非法下标明确报错。 */
export function weekdayLabel(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > 6) throw new Error('星期必须是 0（周日）到 6（周六）的整数');
  return WEEKDAYS[n]!;
}

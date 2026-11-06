/** 时间验收全部使用固定时刻，验证上海日期边界及夏令时，不依赖测试机器的时区或当前日期。 */
import { describe, expect, it } from 'vitest';
import { FakeClock } from '../src/io/testing/fake-clock.js';
import {
  formatAgo, formatDuration, formatShort, isInQuietHours, localDateKey, localParts,
  nextLocalTime, parseFlexibleTime, parseLocalDateTime, startOfLocalDay, weekdayLabel,
} from '../src/util/time.js';

const SHANGHAI = 'Asia/Shanghai';
const local = (text: string): number => parseLocalDateTime(text, SHANGHAI);
const NOW = local('2026-11-05 12:00');

describe('本地日期和解析', () => {
  it('完整返回上海本地字段与星期', () => {
    expect(localParts(Date.parse('2026-11-05T05:04:03Z'), SHANGHAI)).toEqual({ year: 2026, month: 11, day: 5, hour: 13, minute: 4, second: 3, weekday: 4 });
  });
  it.each([
    ['2026-11-05T15:59:59.999Z', '2026-11-05'],
    ['2026-11-05T16:00:00.000Z', '2026-11-06'],
  ])('UTC 16 点附近的上海日期：%s', (iso, key) => {
    expect(localDateKey(Date.parse(iso), SHANGHAI)).toBe(key);
  });
  it('本地午夜使用 00 点而不是 24 点', () => {
    expect(localParts(local('2026-11-05 00:00'), SHANGHAI).hour).toBe(0);
  });
  it('按显式时区解析本地日期', () => {
    expect(local('2026-11-05 12:00')).toBe(Date.parse('2026-11-05T04:00:00Z'));
    expect(parseLocalDateTime('2026-11-05 12:00', 'UTC')).toBe(Date.parse('2026-11-05T12:00:00Z'));
  });
  it.each(['2026-02-29 12:00', '2026-02-30 12:00', '2026-13-01 12:00', '2026-11-05 24:00', '2026-11-05 00:60', '2026/11/05 12:00'])('拒绝非法本地时间：%s', (text) => {
    expect(() => local(text)).toThrow(/日期|时刻|格式/);
  });
  it('接受有效闰日', () => {
    expect(localDateKey(local('2024-02-29 12:00'), SHANGHAI)).toBe('2024-02-29');
  });
  it.each([
    ['2026-11-05 12:00', '2026-11-05T04:00:00Z'],
    ['2026-11-05T12:00:00+08:00', '2026-11-05T04:00:00Z'],
    ['2026-11-05T12:00+0800', '2026-11-05T04:00:00Z'],
    ['2026-11-05T04:00:00Z', '2026-11-05T04:00:00Z'],
    ['2026-11-05T04:00:00.123Z', '2026-11-05T04:00:00.123Z'],
  ])('灵活解析明确格式：%s', (input, expected) => {
    expect(parseFlexibleTime(input, SHANGHAI)).toBe(Date.parse(expected));
  });
  it.each(['', '明天中午', '2026-11-05', '2026-11-05T12:00:00', '2026-02-30T12:00:00Z', '2026-11-05T12:00:00+24:00', '2026-11-05T12:00:00+08:60', '2026-11-05T12:00:60Z'])('灵活解析非法输入返回 null：%s', (input) => {
    expect(parseFlexibleTime(input, SHANGHAI)).toBeNull();
  });
  it('非法时区不会回退到宿主时区', () => {
    expect(() => localParts(NOW, 'Invalid/Zone')).toThrow('时区');
    expect(parseFlexibleTime('2026-11-05T04:00Z', 'Invalid/Zone')).toBeNull();
  });
  it('非法时间戳抛中文错误', () => {
    expect(() => localParts(Number.NaN, SHANGHAI)).toThrow('时间戳');
  });
});

describe('免打扰和下个钟点', () => {
  it.each([['22:59', false], ['23:00', true], ['07:59', true], ['08:00', false]] as const)('跨午夜边界 %s', (clock, expected) => {
    expect(isInQuietHours(local(`2026-11-05 ${clock}`), { start: '23:00', end: '08:00' }, SHANGHAI)).toBe(expected);
  });
  it('开始与结束相同表示不启用', () => {
    expect(isInQuietHours(local('2026-11-05 08:00'), { start: '08:00', end: '08:00' }, SHANGHAI)).toBe(false);
  });
  it('支持同一天内的免打扰区间', () => {
    const range = { start: '12:00', end: '14:00' };
    expect(isInQuietHours(NOW, range, SHANGHAI)).toBe(true);
    expect(isInQuietHours(local('2026-11-05 14:00'), range, SHANGHAI)).toBe(false);
  });
  it('拒绝非法钟点', () => {
    expect(() => nextLocalTime('25:00', NOW, SHANGHAI)).toThrow('钟点');
    expect(() => isInQuietHours(NOW, { start: '8:00', end: '09:00' }, SHANGHAI)).toThrow('钟点');
  });
  it('当天尚未到点直接返回当天', () => {
    expect(nextLocalTime('13:00', NOW, SHANGHAI)).toBe(local('2026-11-05 13:00'));
  });
  it('刚好到点选择次日，跨年正确', () => {
    expect(nextLocalTime('08:30', local('2026-12-31 08:30'), SHANGHAI)).toBe(local('2027-01-01 08:30'));
  });
  it('取得上海当天零点', () => {
    expect(startOfLocalDay(NOW, SHANGHAI)).toBe(Date.parse('2026-11-04T16:00:00Z'));
  });
  it('夏令时春季缺失钟点拒绝解析，并顺延到下一天的有效钟点', () => {
    const zone = 'America/New_York';
    expect(() => parseLocalDateTime('2026-03-08 02:30', zone)).toThrow('不存在');
    expect(parseFlexibleTime('2026-03-08 02:30', zone)).toBeNull();
    expect(nextLocalTime('02:30', Date.parse('2026-03-08T05:00Z'), zone)).toBe(Date.parse('2026-03-09T06:30Z'));
  });
  it('秋季重复钟点解析选较早者，下次钟点可选第二次', () => {
    const zone = 'America/New_York';
    expect(parseLocalDateTime('2026-11-01 01:30', zone)).toBe(Date.parse('2026-11-01T05:30Z'));
    expect(nextLocalTime('01:30', Date.parse('2026-11-01T05:30Z'), zone)).toBe(Date.parse('2026-11-01T06:30Z'));
  });
  it('跨换日线跳过不存在的一整天', () => {
    expect(nextLocalTime('08:00', Date.parse('2011-12-29T20:00Z'), 'Pacific/Apia')).toBe(Date.parse('2011-12-30T18:00Z'));
  });
  it('午夜因夏令时缺失时返回该日第一个存在时刻', () => {
    expect(startOfLocalDay(Date.parse('2018-11-04T15:00Z'), 'America/Sao_Paulo')).toBe(Date.parse('2018-11-04T03:00Z'));
  });
});

describe('中文显示', () => {
  it('注入假时钟推进后相对时间跟随调用方变化', () => {
    const clock = new FakeClock(NOW);
    expect(formatAgo(NOW, clock.now())).toBe('刚刚');
    clock.advance(3 * 60_000);
    expect(formatAgo(NOW, clock.now())).toBe('3 分钟前');
  });
  it.each([
    ['2026-11-05 14:05', '今天 14:05'], ['2026-11-04 09:30', '昨天 09:30'],
    ['2026-11-06 08:00', '明天 08:00'], ['2026-11-03 08:00', '11月3日 08:00'],
    ['2025-12-01 08:00', '2025年12月1日 08:00'],
  ])('短日期 %s', (time, expected) => {
    expect(formatShort(local(time), NOW, SHANGHAI)).toBe(expected);
  });
  it('夏令时跨日仍按日历显示昨天', () => {
    expect(formatShort(Date.parse('2026-03-07T17:00Z'), Date.parse('2026-03-08T16:00Z'), 'America/New_York')).toBe('昨天 12:00');
  });
  it.each([
    [-59_999, '刚刚'], [-3 * 60_000, '3 分钟前'], [-2 * 3_600_000, '2 小时前'],
    [-5 * 86_400_000, '5 天前'], [3 * 3_600_000, '3 小时后'], [59_999, '刚刚'],
  ])('相对时间差 %s', (delta, expected) => {
    expect(formatAgo(NOW + delta, NOW)).toBe(expected);
  });
  it.each([[16_200_000, '4 小时 30 分'], [2_700_000, '45 分钟'], [20_000, '20 秒'], [0, '0 秒'], [3_600_000, '1 小时']])('时长 %s', (duration, expected) => {
    expect(formatDuration(duration)).toBe(expected);
  });
  it('负数时长拒绝处理', () => {
    expect(() => formatDuration(-1)).toThrow('时长');
  });
  it('星期标签完整且拒绝越界', () => {
    expect(Array.from({ length: 7 }, (_, day) => weekdayLabel(day))).toEqual(['周日', '周一', '周二', '周三', '周四', '周五', '周六']);
    expect(() => weekdayLabel(7)).toThrow('星期');
  });
});

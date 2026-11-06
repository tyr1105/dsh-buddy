/** M08 用注入时钟验证检查日、连续日与落空去重；每条边界都检查持久事实，不等待真实时间。 */
import { describe, expect, it } from 'vitest';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { FakeClock } from '../src/io/testing/fake-clock.js';
import { resolveSettings } from '../src/config/defaults.js';
import { checkExpectations } from '../src/perception/expectations.js';
import { markWatchSatisfied } from '../src/perception/satisfaction.js';
import { createHub } from '../src/engine/hub.js';
import type { Expectation } from '../src/model/perception.js';
import { expectationPeriodStart, isExpectationCheckDay } from '../src/util/expectation-calendar.js';
import { parseLocalDateTime } from '../src/util/time.js';
import { botFixture, watchFixture } from './model-fixtures.js';

const zone = 'Asia/Shanghai';
const hour = 3_600_000;
const workdays = [1, 2, 3, 4, 5];
const local = (text: string) => parseLocalDateTime(text, zone);

/** 创建一个早于本周末的关注项；所有运行时间来自同一个假时钟。 */
function fixture(patch: Partial<Expectation> = {}, created = '2026-11-06 00:00') {
  const ctx = createTestContext({ clock: new FakeClock(local(created)), settings: resolveSettings({ rootDir: '/hub', timezone: zone }) });
  ctx.store.table('bots').put({ ...botFixture, createdAt: ctx.clock.now(), updatedAt: ctx.clock.now() });
  ctx.store.table('watches').put({ ...watchFixture, kind: 'session', target: '早盘日志', createdAt: ctx.clock.now(), updatedAt: ctx.clock.now(),
    expectation: { text: '早盘日志出现', everyMs: null, byLocalTime: '08:20', weekdays: workdays,
      lastSatisfiedAt: null, lastMissedAt: null, ...patch } });
  return ctx;
}

/** 推进到指定本地时刻，检查函数只接受注入时钟给出的 now。 */
function checkAt(ctx: ReturnType<typeof fixture>, time: string) {
  ctx.clock.set(local(time));
  return checkExpectations(ctx, ctx.clock.now());
}

describe('M08 byLocalTime 按本地检查日判断', () => {
  it.each(['2026-11-07 09:00', '2026-11-08 09:00'])('工作日 08:20 期望在 %s 不报且不改落空记录', time => {
    const ctx = fixture();
    const before = ctx.store.table('watches').get(watchFixture.id);
    expect(checkAt(ctx, time)).toEqual([]);
    expect(ctx.store.table('watches').get(watchFixture.id)).toEqual(before);
    expect(ctx.store.table('percepts').count()).toBe(0);
  });

  it('周一到点不报，08:21 未满足报一次，同一本地日不重复，次日可报', () => {
    const ctx = fixture();
    expect(checkAt(ctx, '2026-11-09 08:20')).toEqual([]);
    expect(checkAt(ctx, '2026-11-09 08:21')).toEqual([expect.objectContaining({ kind: 'expectation_missed', anomaly: true })]);
    expect(checkAt(ctx, '2026-11-09 23:59')).toEqual([]);
    expect(ctx.store.table('watches').get(watchFixture.id)?.expectation?.lastMissedAt).toBe(local('2026-11-09 08:21'));
    expect(checkAt(ctx, '2026-11-10 08:21')).toHaveLength(1);
  });

  it('周一 08:15 真实满足后 08:21 不报，周日的满足不能代替周一', () => {
    const ctx = fixture({ lastSatisfiedAt: local('2026-11-08 08:15') });
    expect(checkAt(ctx, '2026-11-09 08:21')).toHaveLength(1);
    const satisfied = fixture();
    satisfied.clock.set(local('2026-11-09 08:15'));
    markWatchSatisfied(satisfied, watchFixture.id, satisfied.clock.now());
    expect(checkAt(satisfied, '2026-11-09 08:21')).toEqual([]);
  });

  it.each([
    [[6, 7], '2026-11-07 09:00', 1], [[6, 7], '2026-11-09 09:00', 0],
    [[1, 3, 5], '2026-11-10 09:00', 0], [[1, 3, 5], '2026-11-11 09:00', 1],
  ] as const)('星期 %j 在 %s 的结果为 %s', (weekdays, time, count) => {
    expect(checkAt(fixture({ weekdays: [...weekdays] }), time)).toHaveLength(count);
  });

  it('星期以 settings.timezone 为准，同一时刻上海周一而 UTC 仍周日', () => {
    const ctx = fixture({ weekdays: [1], byLocalTime: '00:10' });
    ctx.clock.set(Date.parse('2026-11-08T16:11:00Z'));
    expect(isExpectationCheckDay([1], ctx.clock.now(), zone)).toBe(true);
    expect(isExpectationCheckDay([1], ctx.clock.now(), 'UTC')).toBe(false);
    expect(checkExpectations(ctx, ctx.clock.now())).toHaveLength(1);
    const utc = fixture({ weekdays: [1], byLocalTime: '00:10' });
    utc.settings = resolveSettings({ rootDir: '/hub', timezone: 'UTC' });
    utc.clock.set(ctx.clock.now());
    expect(checkExpectations(utc, utc.clock.now())).toEqual([]);
    // 换时区后再走到 UTC 的周一截止点，保证不是只验证辅助函数或上海的旧落空去重。
    utc.clock.set(Date.parse('2026-11-09T00:10:00Z'));
    expect(checkExpectations(utc, utc.clock.now())).toEqual([]);
    utc.clock.advance(60_000);
    expect(checkExpectations(utc, utc.clock.now())).toHaveLength(1);
  });
});

describe('M08 everyMs 从连续检查段重新起算', () => {
  it('settings.timezone 改成 UTC 后，间隔从 UTC 周一零点起算', () => {
    const ctx = fixture({ everyMs: hour, byLocalTime: null, lastSatisfiedAt: local('2026-11-06 22:00') });
    ctx.settings = resolveSettings({ rootDir: '/hub', timezone: 'UTC' });
    ctx.clock.set(Date.parse('2026-11-08T16:30:00Z'));
    expect(checkExpectations(ctx, ctx.clock.now())).toEqual([]);
    ctx.clock.set(Date.parse('2026-11-09T00:30:00Z'));
    expect(checkExpectations(ctx, ctx.clock.now())).toEqual([]);
    expect(expectationPeriodStart(workdays, ctx.clock.now(), ctx.settings.timezone)).toBe(Date.parse('2026-11-09T00:00:00Z'));
    ctx.clock.set(Date.parse('2026-11-09T01:01:00Z'));
    expect(checkExpectations(ctx, ctx.clock.now())).toHaveLength(1);
  });
  it('周五 22:00 满足后周末不报，周一 00:30 与 01:00 不报，01:01 报', () => {
    const ctx = fixture({ everyMs: hour, byLocalTime: null, lastSatisfiedAt: local('2026-11-06 22:00') });
    for (const time of ['2026-11-07 09:00', '2026-11-08 09:00', '2026-11-09 00:30', '2026-11-09 01:00']) {
      expect(checkAt(ctx, time)).toEqual([]);
    }
    expect(checkAt(ctx, '2026-11-09 01:01')).toHaveLength(1);
    expect(checkAt(ctx, '2026-11-09 02:02')).toEqual([]);
  });

  it('从未满足的旧关注项也从周一零点起算', () => {
    const ctx = fixture({ everyMs: hour, byLocalTime: null });
    expect(checkAt(ctx, '2026-11-09 00:30')).toEqual([]);
    expect(checkAt(ctx, '2026-11-09 01:01')).toHaveLength(1);
  });

  it.each(['created', 'satisfied'] as const)('段内较晚的 %s 时间优先于周一零点', kind => {
    const ctx = fixture({ everyMs: hour, byLocalTime: null,
      lastSatisfiedAt: kind === 'satisfied' ? local('2026-11-09 00:40') : null },
    kind === 'created' ? '2026-11-09 00:40' : '2026-11-06 00:00');
    expect(checkAt(ctx, '2026-11-09 01:01')).toEqual([]);
    expect(checkAt(ctx, '2026-11-09 01:41')).toHaveLength(1);
  });

  it('连续工作日不在每天零点重置，周二 00:30 仍会发现周一漏更', () => {
    const ctx = fixture({ everyMs: hour, byLocalTime: null, lastSatisfiedAt: local('2026-11-09 22:00') });
    expect(expectationPeriodStart(workdays, local('2026-11-10 00:30'), zone)).toBe(local('2026-11-09 00:00'));
    expect(checkAt(ctx, '2026-11-10 00:30')).toHaveLength(1);
  });

  it('跨周连续日 [6,7,1] 从周六零点起算，周一不重置', () => {
    const ctx = fixture({ weekdays: [6, 7, 1], everyMs: hour, byLocalTime: null, lastSatisfiedAt: local('2026-11-08 22:00') });
    expect(expectationPeriodStart([6, 7, 1], local('2026-11-09 00:30'), zone)).toBe(local('2026-11-07 00:00'));
    expect(checkAt(ctx, '2026-11-09 00:30')).toHaveLength(1);
  });

  it('不连续星期每段独立重置；周二免查，周三零点重新给满一小时', () => {
    const ctx = fixture({ weekdays: [1, 3, 5], everyMs: hour, byLocalTime: null, lastSatisfiedAt: local('2026-11-09 22:00') });
    expect(checkAt(ctx, '2026-11-10 09:00')).toEqual([]);
    expect(checkAt(ctx, '2026-11-11 00:30')).toEqual([]);
    expect(checkAt(ctx, '2026-11-11 01:01')).toHaveLength(1);
  });

  it.each([{ weekdays: null }, { weekdays: [1, 2, 3, 4, 5, 6, 7] }])('每天 $weekdays 沿用原起点，跨周不重置且周末照常检查', ({ weekdays }) => {
    const ctx = fixture({ weekdays, everyMs: hour, byLocalTime: null, lastSatisfiedAt: local('2026-11-06 22:00') });
    expect(expectationPeriodStart(weekdays, local('2026-11-09 00:30'), zone)).toBeNull();
    expect(checkAt(ctx, '2026-11-07 00:30')).toHaveLength(1);
    expect(checkAt(ctx, '2026-11-09 00:30')).toHaveLength(1);
  });

  it('weekdays=null 的钟点期望保留周末检查行为', () => {
    const ctx = fixture({ weekdays: null });
    expect(checkAt(ctx, '2026-11-07 08:20')).toEqual([]);
    expect(checkAt(ctx, '2026-11-07 08:21')).toHaveLength(1);
  });

  it.each(['2026-03-09', '2026-11-02'])('夏令时前后 %s 的周一连续段仍正确起于本地周六', day => {
    const tz = 'America/New_York';
    const saturday = day === '2026-03-09' ? '2026-03-07' : '2026-10-31';
    const now = parseLocalDateTime(`${day} 00:30`, tz);
    expect(expectationPeriodStart([6, 7, 1], now, tz)).toBe(parseLocalDateTime(`${saturday} 00:00`, tz));
  });
});

describe('M08 真实 Hub tick 第四步接线', () => {
  it('同一关注项周末不产生落空，周一到点产生一次且后续 tick 不重复', async () => {
    const ctx = fixture();
    ctx.clock.set(local('2026-11-07 09:00'));
    const hub = createHub(ctx);
    await hub.start();
    try {
      for (const time of ['2026-11-07 09:00', '2026-11-08 09:00']) {
        ctx.clock.set(local(time)); await hub.tick();
        expect(ctx.store.table('percepts').list(p => p.kind === 'expectation_missed')).toEqual([]);
      }
      ctx.clock.set(local('2026-11-09 08:21')); await hub.tick();
      ctx.clock.advance(60_000); await hub.tick();
      expect(ctx.store.table('percepts').list(p => p.kind === 'expectation_missed')).toHaveLength(1);
    } finally { await hub.stop(); }
  });
});

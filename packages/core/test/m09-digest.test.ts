/** M09 日报验收：真实日志经过 Hub tick 后逐日核对，并覆盖生效时刻和实际切换时区的边界。 */
import { describe, expect, it } from 'vitest';
import { resolveSettings } from '../src/config/defaults.js';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { WatchSchema } from '../src/model/perception.js';
import { buildDigest } from '../src/outreach/digest.js';
import { writeOutreachAudit } from '../src/outreach/audit.js';
import { createSimWorld } from '../src/sim/runner.js';
import { localDateKey, parseLocalDateTime } from '../src/util/time.js';
import { okData } from './c04-api-fixtures.js';
import { botFixture, watchFixture } from './model-fixtures.js';

const zone = 'Asia/Shanghai';
const hour = 3_600_000;
const local = (time: string) => parseLocalDateTime(time, zone);

/** 只取该关注的期望行，不让日报其他摘要中的文字造成假阳性。 */
function expectationLine(digest: string): string {
  const rows = digest.split('\n').filter(row => row.startsWith('期望「'));
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

describe('M09 真实 Hub 整周日报', () => {
  it.each([
    { name: '工作日', weekdays: [1, 2, 3, 4, 5], days: [5, 6, 7, 8, 9, 10, 11], satisfied: [5, 9],
      expected: ['已出现', '【未出现】', '昨日不检查', '昨日不检查', '已出现', '【未出现】'] },
    { name: '周一三五', weekdays: [1, 3, 5], days: [2, 3, 4, 5, 6, 7, 8, 9, 10], satisfied: [2, 6],
      expected: ['已出现', '昨日不检查', '【未出现】', '昨日不检查', '已出现', '昨日不检查', '昨日不检查', '【未出现】'] },
    { name: '周末', weekdays: [6, 7], days: [7, 8, 9, 10, 11, 12, 13, 14, 15, 16], satisfied: [7, 15],
      expected: ['已出现', '【未出现】', '昨日不检查', '昨日不检查', '昨日不检查', '昨日不检查', '昨日不检查', '【未出现】', '已出现'] },
  ])('$name 的每个检查日结果都出现在次日日报', async ({ weekdays, days, satisfied, expected }) => {
    const date = (day: number) => `2026-11-${String(day).padStart(2, '0')}`;
    const world = await createSimWorld({ startAt: local(`${date(days[0]!)} 07:00`),
      settings: { timezone: zone }, bots: [{ id: botFixture.id, name: '巡检员' }] });
    const target = '/sim-hub/shared/morning.log';
    try {
      await world.fs.writeTextAtomic(target, '初始日志\n');
      const watch = WatchSchema.parse(okData(await world.hub.api.upsertWatch({ botId: botFixture.id, kind: 'log', target,
        why: '核对检查日的早盘日志', expectation: { text: '早盘日志出现', byLocalTime: '08:20', weekdays } })));
      const actual: string[] = [];
      for (const [index, day] of days.entries()) {
        // 日志只在指定日出现；满足事实由真正的文件监听与两分钟去抖产生，不直接写统计字段。
        world.clock.set(local(`${date(day)} 08:15`));
        if (satisfied.includes(day)) await world.fs.appendText(target, `${date(day)} 的早盘日志\n`);
        world.clock.advance(world.settings.fileDebounceMs);
        await world.hub.tick(); await world.host.settle();
        world.clock.set(local(`${date(day)} 08:21`));
        await world.hub.tick(); await world.host.settle();
        world.clock.set(local(`${date(day)} 08:30`));
        await world.hub.tick(); await world.host.settle();
        const digests = world.store.log('thread').all().filter(row => row.kind === 'digest' && row.refId === `digest:${date(day)}`);
        expect(digests).toHaveLength(1);
        if (index > 0) {
          const line = expectationLine(digests[0]!.text);
          expect(digests[0]!.text).toContain(`统计昨日：${date(days[index - 1]!)}`);
          expect(line).toContain(`：${expected[index - 1]}（${target}）`);
          expect(line).not.toContain('今天不检查');
          actual.push(line.slice(line.indexOf('：') + 1, line.indexOf('（')));
        }
      }
      expect(actual).toEqual(expected);
      // 对照落空感知与日报，证明检查日的漏跑确实经过引擎，而非只有渲染文本正确。
      const missedDays = world.store.table('percepts').list(row => row.watchId === watch.id && row.kind === 'expectation_missed')
        .map(row => localDateKey(row.createdAt, zone));
      for (let index = 0; index < expected.length; index += 1) {
        if (expected[index] === '【未出现】') expect(missedDays).toContain(date(days[index]!));
        else expect(missedDays).not.toContain(date(days[index]!));
      }
      expect(world.logger.lines.filter(row => row.level === 'error')).toEqual([]);
    } finally { await world.hub.stop(); }
  });
});

/** 为直接统计边界准备一条旧关注，期望的真实生效时刻由每个用例显式给出。 */
function digestContext(now: string, effective: string, patch: Record<string, unknown> = {}) {
  const ctx = createTestContext({ settings: resolveSettings({ rootDir: '/hub', timezone: zone }) });
  ctx.clock.set(local(now));
  ctx.store.table('bots').put(botFixture);
  const watch = WatchSchema.parse({ ...watchFixture, createdAt: local('2026-11-01 00:00'),
    expectation: { text: '早盘日志出现', weekdays: null, everyMs: null, byLocalTime: '08:20',
      effectiveAt: local(effective), lastSatisfiedAt: null, lastMissedAt: null, ...patch } });
  ctx.store.table('watches').put(watch);
  return { ctx, watch };
}

describe('M09 日报期望生效边界', () => {
  it.each(['2026-11-05 16:00', '2026-11-06 08:30'])('%s 不追判当天 15:00 才建立的 08:20 期望', now => {
    const { ctx } = digestContext(now, '2026-11-05 15:00');
    expect(expectationLine(buildDigest(ctx, ctx.clock.now()))).toContain('：昨日尚未开始检查');
  });

  it.each([true, false])('生效次日的结果在后一天正常展示满足=%s', satisfied => {
    const { ctx } = digestContext('2026-11-07 08:30', '2026-11-05 15:00',
      { lastSatisfiedAt: satisfied ? local('2026-11-06 08:15') : null });
    expect(expectationLine(buildDigest(ctx, ctx.clock.now()))).toContain(satisfied ? '：已出现' : '：【未出现】');
  });

  it('期限与生效恰好相等仍属于已开始检查', () => {
    const { ctx } = digestContext('2026-11-06 08:30', '2026-11-05 08:20');
    expect(expectationLine(buildDigest(ctx, ctx.clock.now()))).toContain('：【未出现】');
  });

  it.each([true, false])('纯间隔在统计日日内生效=%s，整天在生效前才写尚未开始', started => {
    const { ctx } = digestContext('2026-11-06 08:30', started ? '2026-11-05 15:00' : '2026-11-06 00:00',
      { byLocalTime: null, everyMs: hour, lastSatisfiedAt: local('2026-11-05 16:00') });
    expect(expectationLine(buildDigest(ctx, ctx.clock.now()))).toContain(started ? '：已出现' : '：昨日尚未开始检查');
  });

  it('期望修改前的满足不能冒充新期望结果，但旧落空必须保留', () => {
    const { ctx, watch } = digestContext('2026-11-06 08:30', '2026-11-05 07:00',
      { lastSatisfiedAt: local('2026-11-05 06:00'), lastMissedAt: local('2026-11-05 06:30') });
    writeOutreachAudit(ctx, 'expectation_satisfied', { watchId: watch.id }, 'hub', local('2026-11-05 06:00'));
    expect(expectationLine(buildDigest(ctx, ctx.clock.now()))).toContain('：【未出现】');
    writeOutreachAudit(ctx, 'expectation_satisfied', { watchId: watch.id }, 'hub', local('2026-11-05 08:15'));
    expect(expectationLine(buildDigest(ctx, ctx.clock.now()))).toBe(`期望「早盘日志出现」：【未出现】（${watch.target}）`);
    // 仅移除本例的落空事实作对照：生效之后的满足才足以显示已出现。
    ctx.store.table('watches').patch(watch.id, { expectation: { ...watch.expectation!, lastMissedAt: null } });
    expect(expectationLine(buildDigest(ctx, ctx.clock.now()))).toContain('：已出现');
  });
});

describe('M09 日报实际切换设置时区', () => {
  it.each([true, false])('同一时刻从上海切成 UTC，昨日星期与满足=%s 都跟随设置', satisfied => {
    const { ctx } = digestContext('2026-11-09 02:00', '2026-11-01 00:00',
      { weekdays: [6], lastSatisfiedAt: satisfied ? Date.parse('2026-11-07T08:15:00Z') : null });
    expect(expectationLine(buildDigest(ctx, ctx.clock.now()))).toContain('：昨日不检查');
    ctx.settings = resolveSettings({ rootDir: '/hub', timezone: 'UTC' });
    const digest = buildDigest(ctx, ctx.clock.now());
    expect(digest).toContain('统计昨日：2026-11-07');
    expect(expectationLine(digest)).toContain(satisfied ? '：已出现' : '：【未出现】');
  });

  it('每天检查的期望与统计日期也遵循纽约春进后的昨日自然日', () => {
    const { ctx, watch } = digestContext('2026-11-06 08:30', '2026-11-01 00:00');
    ctx.settings = resolveSettings({ rootDir: '/hub', timezone: 'America/New_York' });
    ctx.clock.set(Date.parse('2026-03-09T09:00:00-04:00'));
    ctx.store.table('watches').patch(watch.id, { expectation: { ...watch.expectation!,
      effectiveAt: Date.parse('2026-03-01T00:00:00-05:00'), lastSatisfiedAt: Date.parse('2026-03-07T08:15:00-05:00') } });
    const digest = buildDigest(ctx, ctx.clock.now());
    expect(digest).toContain('统计昨日：2026-03-08');
    expect(expectationLine(digest)).toContain('：【未出现】');
  });
});

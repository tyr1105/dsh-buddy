/** M10 把日报与期望检查对齐：验证首到期点、既有落空、原样重存及上海以东的时区边界。 */
import { describe, expect, it } from 'vitest';
import { createUiApi } from '../src/api/index.js';
import { resolveSettings } from '../src/config/defaults.js';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { initRoot } from '../src/memory/files.js';
import { WatchSchema, type Expectation } from '../src/model/perception.js';
import { buildDigest } from '../src/outreach/digest.js';
import { checkExpectations } from '../src/perception/expectations.js';
import { markWatchSatisfied } from '../src/perception/satisfaction.js';
import { updateWatch } from '../src/tools/hub-watch-update.js';
import { parseLocalDateTime } from '../src/util/time.js';
import { okData } from './c04-api-fixtures.js';
import { botFixture, watchFixture } from './model-fixtures.js';

const hour = 3_600_000;
const zone = 'Asia/Shanghai';
const local = (value: string, timezone = zone) => parseLocalDateTime(value, timezone);
const watchInput = { kind: 'session', target: '早盘日志', why: '检查每个应当出现的结果' };

/** 精确取唯一的期望行，使其他日报段落不能掩盖错误结果。 */
function expectationLine(digest: string): string {
  const rows = digest.split('\n').filter(row => row.startsWith('期望「'));
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

/** 直接统计用例显式保存生效、满足和检查日；所有日期都经指定时区解析。 */
function digestContext(effectiveAt: number, expectation: Partial<Expectation> = {}, timezone = zone) {
  const ctx = createTestContext({ settings: resolveSettings({ rootDir: '/hub', timezone }) });
  ctx.store.table('bots').put(botFixture);
  const watch = WatchSchema.parse({ ...watchFixture, target: '早盘日志', createdAt: effectiveAt,
    expectation: { text: '日志出现', everyMs: hour, byLocalTime: null, weekdays: null,
      effectiveAt, lastSatisfiedAt: null, lastMissedAt: null, ...expectation } });
  ctx.store.table('watches').put(watch);
  return { ctx, watch };
}

/** 界面入口用真实参数校验和保存，避免测试直接写 effectiveAt 而漏掉原样重存缺陷。 */
async function ownerFixture() {
  const ctx = createTestContext();
  ctx.clock.set(local('2026-11-06 07:00'));
  await initRoot(ctx);
  const api = createUiApi(ctx, async () => { await ctx.store.flush(); });
  const bot = okData(await api.createBot({ name: '检查队友', role: 'sentinel', persona: '逐条核实', aspirations: ['核实每日期望'] }));
  const expectation = { text: '日志出现', byLocalTime: '08:20', weekdays: [1, 2, 3, 4, 5] };
  const watch = WatchSchema.parse(okData(await api.upsertWatch({ ...watchInput, botId: bot.id, expectation })));
  return { ctx, api, bot, watch, expectation };
}

describe('M10 间隔期望首到期点', () => {
  it.each([
    { name: '当日生效但二十四小时尚未到期', effective: '15:00', everyMs: 24 * hour, byLocalTime: null, result: '昨日尚未开始检查', missed: false },
    { name: '深夜生效且首到期点在次日', effective: '23:30', everyMs: hour, byLocalTime: null, result: '昨日尚未开始检查', missed: false },
    { name: '首到期点恰好为统计日结束', effective: '23:00', everyMs: hour, byLocalTime: null, result: '昨日尚未开始检查', missed: false },
    { name: '首到期点在统计日结束之前', effective: '22:59', everyMs: hour, byLocalTime: null, result: '【未出现】', missed: true },
    { name: '双期限的钟点已过且间隔未到期', effective: '15:00', everyMs: 24 * hour, byLocalTime: '08:20', result: '昨日尚未开始检查', missed: false },
    { name: '双期限中钟点有效而间隔未到期', effective: '15:00', everyMs: 24 * hour, byLocalTime: '16:00', result: '【未出现】', missed: true },
    { name: '双期限中钟点已过但间隔当天到期', effective: '15:00', everyMs: hour, byLocalTime: '08:20', result: '【未出现】', missed: true },
  ])('$name：日报与检查器保持一致', ({ effective, everyMs, byLocalTime, result, missed }) => {
    const { ctx } = digestContext(local(`2026-11-05 ${effective}`), { everyMs, byLocalTime });
    // 先核对停机也能兜底的日报，再运行检查器，防止落空事实遮住首到期点计算。
    const digestAt = local('2026-11-06 08:30');
    expect(expectationLine(buildDigest(ctx, digestAt))).toBe(`期望「日志出现」：${result}（早盘日志）`);
    expect(checkExpectations(ctx, local('2026-11-06 00:00') - 1)).toHaveLength(missed ? 1 : 0);
    expect(expectationLine(buildDigest(ctx, digestAt))).toBe(`期望「日志出现」：${result}（早盘日志）`);
  });

  it('休息日后的连续检查段重新起算，M11 的十二小时间隔周一当天到期', () => {
    const { ctx } = digestContext(local('2026-11-06 00:00'), { weekdays: [1, 2, 3, 4, 5], everyMs: 12 * hour });
    expect(expectationLine(buildDigest(ctx, local('2026-11-10 08:30')))).toBe('期望「日志出现，工作日，每 12 小时」：【未出现】（早盘日志）');
    expect(expectationLine(buildDigest(ctx, local('2026-11-11 08:30')))).toBe('期望「日志出现，工作日，每 12 小时」：【未出现】（早盘日志）');
  });
});

describe('M10 落空事实与原样重存', () => {
  it.each(['工具暂停恢复', '主人暂停恢复', '修改期限', '修改检查日'])('周五已落空后%s，周六日报仍保留未出现', async mode => {
    const { ctx, api, bot, watch, expectation } = await ownerFixture();
    ctx.clock.set(local('2026-11-06 08:21'));
    expect(checkExpectations(ctx, ctx.clock.now()).map(row => row.watchId)).toEqual([watch.id]);
    if (mode.endsWith('暂停恢复')) {
      ctx.clock.set(local('2026-11-06 10:00'));
      if (mode.startsWith('工具')) await updateWatch(ctx, bot.id, { id: watch.id, status: 'paused' });
      else okData(await api.upsertWatch({ ...watchInput, botId: bot.id, id: watch.id, status: 'paused' }));
      ctx.clock.set(local('2026-11-06 10:05'));
      if (mode.startsWith('工具')) await updateWatch(ctx, bot.id, { id: watch.id, status: 'active' });
      else okData(await api.upsertWatch({ ...watchInput, botId: bot.id, id: watch.id, status: 'active' }));
    } else {
      ctx.clock.set(local('2026-11-06 15:00'));
      okData(await api.upsertWatch({ ...watchInput, botId: bot.id, id: watch.id,
        expectation: { ...expectation, ...(mode === '修改期限' ? { byLocalTime: '08:40' } : { weekdays: [1] }) } }));
    }
    expect(ctx.store.table('watches').get(watch.id)?.expectation?.lastMissedAt).toBeNull();
    // 下午真正出现也不能撤销早上已经错过期限的事实。
    ctx.clock.set(local('2026-11-06 16:00'));
    markWatchSatisfied(ctx, watch.id, ctx.clock.now());
    const line = expectationLine(buildDigest(ctx, local('2026-11-07 08:30')));
    const label = mode === '修改期限' ? '日志出现，工作日每天 08:40 前'
      : mode === '修改检查日' ? '日志出现，每周一 08:20 前' : '日志出现，工作日每天 08:20 前';
    expect(line).toBe(`期望「${label}」：【未出现】（早盘日志）`);
  });

  it('当天已满足后原样重存期望，08:21 不误报且满足事实完整保留', async () => {
    const { ctx, api, bot, watch, expectation } = await ownerFixture();
    ctx.clock.set(local('2026-11-06 08:10'));
    markWatchSatisfied(ctx, watch.id, ctx.clock.now());
    const before = ctx.store.table('watches').get(watch.id)!.expectation;
    ctx.clock.set(local('2026-11-06 08:15'));
    const saved = WatchSchema.parse(okData(await api.upsertWatch({ ...watchInput, botId: bot.id, id: watch.id,
      why: '只改说明，保留原期望', expectation: { ...expectation, weekdays: [5, 4, 3, 2, 1, 1] } })));
    expect(saved.expectation).toEqual(before);
    ctx.clock.set(local('2026-11-06 08:21'));
    expect(checkExpectations(ctx, ctx.clock.now())).toEqual([]);
    expect(expectationLine(buildDigest(ctx, local('2026-11-07 08:30')))).toBe('期望「日志出现，工作日每天 08:20 前」：已出现（早盘日志）');
  });

  it('原样重存保留 lastMissedAt 与 effectiveAt，真正修改才重新生效', async () => {
    const { ctx, api, bot, watch, expectation } = await ownerFixture();
    ctx.clock.set(local('2026-11-06 08:21'));
    expect(checkExpectations(ctx, ctx.clock.now())).toHaveLength(1);
    const before = ctx.store.table('watches').get(watch.id)!.expectation;
    ctx.clock.set(local('2026-11-06 08:25'));
    const saved = WatchSchema.parse(okData(await api.upsertWatch({ ...watchInput, botId: bot.id, id: watch.id, expectation })));
    expect(saved.expectation).toEqual(before);
    const changed = WatchSchema.parse(okData(await api.upsertWatch({ ...watchInput, botId: bot.id, id: watch.id,
      expectation: { ...expectation, text: '另一份日志出现' } })));
    expect(changed.expectation?.effectiveAt).toBe(ctx.clock.now());
    expect(changed.expectation?.lastMissedAt).toBeNull();
  });
});

describe('M10 日报的东京时区', () => {
  const tokyo = 'Asia/Tokyo';
  it.each([true, false])('东京周日的满足=%s 在周一日报按周日检查，不能写死上海', satisfied => {
    const { ctx } = digestContext(local('2026-11-01 00:00', tokyo), { everyMs: null, byLocalTime: '08:20', weekdays: [7],
      lastSatisfiedAt: satisfied ? local('2026-11-08 08:00', tokyo) : null }, tokyo);
    expect(expectationLine(buildDigest(ctx, local('2026-11-09 08:30', tokyo))))
      .toBe(`期望「日志出现，每周日 08:20 前」：${satisfied ? '已出现' : '【未出现】'}（早盘日志）`);
  });

  it.each([
    { effective: '00:10', result: '【未出现】' },
    { effective: '00:30', result: '昨日尚未开始检查' },
  ])('东京午夜附近 $effective 生效，期限按东京 00:20 判断', ({ effective, result }) => {
    const { ctx } = digestContext(local(`2026-11-08 ${effective}`, tokyo), { everyMs: null, byLocalTime: '00:20' }, tokyo);
    expect(expectationLine(buildDigest(ctx, local('2026-11-09 08:30', tokyo))))
      .toBe(`期望「日志出现」：${result}（早盘日志）`);
  });
});

/** M09 验证期望的入口校验和生效边界，所有日期由假时钟推进，旧文件通过真实 FileStore 往返。 */
import { describe, expect, it } from 'vitest';
import { ExpectationSchema, WatchSchema, type Watch } from '../src/model/perception.js';
import { checkExpectations } from '../src/perception/expectations.js';
import { answerInbox } from '../src/outreach/inbox.js';
import { runTool } from '../src/tools/index.js';
import { FileStore } from '../src/store/file-store.js';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { expectationEffectiveAt, isExpectationStartedOnDay } from '../src/util/expectation-effective.js';
import { longestExpectationCheckSpan } from '../src/util/expectation-calendar.js';
import { parseLocalDateTime } from '../src/util/time.js';
import { createUiApi } from '../src/api/index.js';
import { initRoot } from '../src/memory/files.js';
import { updateWatch } from '../src/tools/hub-watch-update.js';
import { createRuntime } from '../src/engine/context.js';
import { markWatchSatisfied } from '../src/perception/satisfaction.js';
import { okData } from './c04-api-fixtures.js';
import { toolFixture } from './c03-tool-fixtures.js';
import { watchFixture } from './model-fixtures.js';

const hour = 3_600_000;
const zone = 'Asia/Shanghai';
const local = (text: string) => parseLocalDateTime(text, zone);
const watchInput = { kind: 'session', target: '早盘日志', why: '只检查生效之后的日志' };
const profile = { name: '期望队友', role: 'sentinel', persona: '核实日志', aspirations: ['核实应出现的信息'] };
const expected = { text: '日志出现', byLocalTime: '08:20' };

/** 先设测试起点再创建身份文件，避免倒拨时钟令保护快照的审计顺序反转。 */
async function ownerFixture() {
  const ctx = createTestContext();
  ctx.clock.set(local('2026-11-05 00:00'));
  await initRoot(ctx);
  const api = createUiApi(ctx, async () => { await ctx.store.flush(); });
  const bot = okData(await api.createBot({ ...profile, name: '检查发起者' }));
  return { ctx, api, bot };
}

/** 逐个入口使用独立环境，失败时核对原记录，确保校验不会留下半份业务数据。 */
async function runEntry(entry: string, everyMs: number, weekdays: number[] | null) {
  const expectation = { text: '定期出现日志', everyMs, weekdays };
  if (entry === 'propose' || entry === 'reflect') {
    const { ctx, tc, wake } = toolFixture();
    const before = ctx.store.table('watches').list();
    if (entry === 'reflect') ctx.store.table('wakes').patch(wake.id, { variant: 'reflection' });
    const result = entry === 'propose'
      ? await runTool(ctx, tc, 'hub_watch_propose', { ...watchInput, expectation })
      : await runTool(ctx, tc, 'hub_reflect_commit', { summary: '调整检查日', lessons: [], routineUpdates: [],
        watchChanges: [{ ...watchInput, expectation }] });
    if (!result.ok) expect(ctx.store.table('watches').list()).toEqual(before);
    return result;
  }
  const { ctx, api, bot } = await ownerFixture();
  const before = ctx.store.table('bots').list();
  const result = entry === 'createBot'
    ? await api.createBot({ ...profile, watches: [{ ...watchInput, expectation }] })
    : await api.upsertWatch({ ...watchInput, botId: bot.id, expectation });
  if (!result.ok) {
    expect(ctx.store.table('bots').list()).toEqual(before);
    expect(ctx.store.table('watches').count()).toBe(0);
  }
  return result;
}

describe('M09 检查段计算与 M11 单日间隔上限', () => {
  it.each([
    [[1, 3, 5], 1], [[1, 2, 3, 4, 5], 5], [[6, 7, 1], 3], [[7, 1, 2, 4, 5], 3],
  ] as const)('星期 %j 的最长连续段为 %s 天，跨周连接', (days, length) => {
    expect(longestExpectationCheckSpan(days)).toBe(length);
    const value = { text: '周期日志', byLocalTime: null, weekdays: [...days], lastSatisfiedAt: null, lastMissedAt: null };
    expect(ExpectationSchema.safeParse({ ...value, everyMs: 24 * hour - 1 }).success).toBe(true);
    expect(() => ExpectationSchema.parse({ ...value, everyMs: length * 24 * hour })).toThrow('everyMs 必须小于 24 小时');
    expect(() => ExpectationSchema.parse({ ...value, everyMs: length * 24 * hour + 1 })).toThrow('everyMs 必须小于 24 小时');
  });

  it.each(['propose', 'createBot', 'upsertWatch', 'reflect'])('%s 共享中文拒绝与边界允许规则且失败不落表', async entry => {
    const rejected = await runEntry(entry, 24 * hour, [1, 3, 5]);
    expect(rejected).toMatchObject({ ok: false, error: expect.stringContaining('weekdays 不为空时 everyMs 必须小于 24 小时；每个检查日一份请用 byLocalTime（例如每天 08:20 前）') });
    expect(await runEntry(entry, 24 * hour - 1, [1, 3, 5])).toMatchObject({ ok: true });
    expect(await runEntry(entry, 24 * hour + 1, [1, 3, 5])).toMatchObject({ ok: false });
    expect(await runEntry(entry, 7 * 24 * hour, [1, 2, 3, 4, 5])).toMatchObject({ ok: false });
    expect(await runEntry(entry, 3 * 24 * hour, [6, 7, 1])).toMatchObject({ ok: false });
    expect(await runEntry(entry, 3 * 24 * hour - 1, [6, 7, 1])).toMatchObject({ ok: false });
    expect(await runEntry(entry, 24 * hour - 1, [6, 7, 1])).toMatchObject({ ok: true });
  });

  it.each([{ days: null, accepted: true }, { days: [1, 2, 3, 4, 5, 6, 7], accepted: false }])('每天 $days 仅在不指定星期时允许跨天间隔', async ({ days, accepted }) => {
    expect(await runEntry('propose', 8 * 24 * hour, days)).toMatchObject({ ok: accepted });
  });
});

describe('M09 生效前不追溯期望', () => {
  it('15:00 创建 08:20 期望，当日不报，次日严格超过 08:20 才报', async () => {
    const { ctx, api, bot } = await ownerFixture();
    ctx.clock.set(local('2026-11-05 15:00'));
    const watch = WatchSchema.parse(okData(await api.upsertWatch({ ...watchInput, botId: bot.id, expectation: expected })));
    expect(watch.expectation?.effectiveAt).toBe(ctx.clock.now());
    expect(checkExpectations(ctx, ctx.clock.now())).toEqual([]);
    expect(isExpectationStartedOnDay(watch, ctx.clock.now(), zone)).toBe(false);
    ctx.clock.set(local('2026-11-06 08:20'));
    expect(checkExpectations(ctx, ctx.clock.now())).toEqual([]);
    ctx.clock.advance(60_000);
    expect(checkExpectations(ctx, ctx.clock.now())).toHaveLength(1);
    expect(isExpectationStartedOnDay(watch, ctx.clock.now(), zone)).toBe(true);
  });

  it('期限与生效同一时刻仍有效，生效前同日的满足不能代替新期望', async () => {
    const { ctx, api, bot } = await ownerFixture();
    ctx.clock.set(local('2026-11-05 08:20'));
    const watch = WatchSchema.parse(okData(await api.upsertWatch({ ...watchInput, botId: bot.id, expectation: expected })));
    ctx.store.table('watches').patch(watch.id, { expectation: { ...watch.expectation!, lastSatisfiedAt: ctx.clock.now() - 60_000 } });
    expect(isExpectationStartedOnDay(watch, ctx.clock.now(), zone)).toBe(true);
    expect(checkExpectations(ctx, ctx.clock.now())).toEqual([]);
    ctx.clock.advance(60_000);
    expect(checkExpectations(ctx, ctx.clock.now())).toHaveLength(1);
  });

  it('主人次日下午才接受提议，钟点期望从接受时刻起算', async () => {
    const { ctx, tc } = toolFixture();
    ctx.clock.set(local('2026-11-05 07:00'));
    expect(await runTool(ctx, tc, 'hub_watch_propose', { ...watchInput, expectation: expected })).toMatchObject({ ok: true });
    const watch = ctx.store.table('watches').list(row => row.target === watchInput.target)[0]!;
    expect(watch.status).toBe('proposed');
    ctx.clock.set(local('2026-11-06 15:00'));
    expect(checkExpectations(ctx, ctx.clock.now())).toEqual([]);
    const item = ctx.store.table('inbox').list(row => row.refId === watch.id)[0]!;
    await answerInbox(ctx, item.id, '接受');
    expect(ctx.store.table('watches').get(watch.id)?.expectation?.effectiveAt).toBe(ctx.clock.now());
    expect(checkExpectations(ctx, ctx.clock.now())).toEqual([]);
    ctx.clock.set(local('2026-11-07 08:21'));
    expect(checkExpectations(ctx, ctx.clock.now()).map(row => row.watchId)).toEqual([watch.id]);
  });

  it('everyMs 接受提议后给满间隔，过去创建时间不参与追溯', async () => {
    const { ctx, tc } = toolFixture();
    ctx.clock.set(local('2026-11-05 07:00'));
    expect(await runTool(ctx, tc, 'hub_watch_propose', { ...watchInput,
      expectation: { text: '每小时出现', everyMs: hour } })).toMatchObject({ ok: true });
    const watch = ctx.store.table('watches').list(row => row.target === watchInput.target)[0]!;
    ctx.clock.set(local('2026-11-06 15:00'));
    await answerInbox(ctx, ctx.store.table('inbox').list(row => row.refId === watch.id)[0]!.id, '接受');
    ctx.clock.advance(hour);
    expect(checkExpectations(ctx, ctx.clock.now())).toEqual([]);
    ctx.clock.advance(1);
    expect(checkExpectations(ctx, ctx.clock.now())).toHaveLength(1);
  });

  it('修改期望重新起算，普通编辑保留有效时刻，真实重载后旧满足和落空不阻止新检查', async () => {
    const { ctx, api, bot } = await ownerFixture();
    ctx.clock.set(local('2026-11-05 07:00'));
    const watch = WatchSchema.parse(okData(await api.upsertWatch({ ...watchInput, botId: bot.id, expectation: expected })));
    ctx.clock.set(local('2026-11-05 08:21'));
    expect(checkExpectations(ctx, ctx.clock.now())).toHaveLength(1);
    ctx.clock.set(local('2026-11-05 08:30'));
    markWatchSatisfied(ctx, watch.id, ctx.clock.now());
    ctx.clock.set(local('2026-11-05 15:00'));
    const changed = WatchSchema.parse(okData(await api.upsertWatch({ ...watchInput, botId: bot.id, id: watch.id,
      expectation: { text: '每小时日志', everyMs: hour } })));
    expect(changed.expectation?.effectiveAt).toBe(ctx.clock.now());
    expect(changed.expectation?.lastMissedAt).toBeNull();
    ctx.clock.advance(hour);
    const retained = WatchSchema.parse(okData(await api.upsertWatch({ ...watchInput, botId: bot.id, id: watch.id, why: '更新理由' })));
    expect(retained.expectation?.effectiveAt).toBe(changed.expectation?.effectiveAt);
    expect(checkExpectations(ctx, ctx.clock.now())).toEqual([]);
    // 重建存储和运行态，让原指纹真的来自已落盘的旧阶段；重启也不能吞掉新阶段的首个落空。
    for (const table of ['bots', 'watches', 'percepts'] as const) {
      await ctx.fs.writeTextAtomic(`/hub/.hub/state/${table}.json`, JSON.stringify(ctx.store.table(table).list()));
    }
    const store = new FileStore(ctx.fs, ctx.clock, '/hub', zone, ctx.logger);
    await store.load();
    const restarted = { ...ctx, store, runtime: createRuntime(ctx.clock.now()) };
    ctx.clock.advance(1);
    expect(checkExpectations(restarted, ctx.clock.now())).toHaveLength(1);
    expect(checkExpectations(restarted, ctx.clock.now())).toEqual([]);
    const misses = store.table('percepts').list(row => row.kind === 'expectation_missed');
    expect(misses).toHaveLength(2);
    expect(new Set(misses.map(row => row.fingerprint)).size).toBe(2);
  });

  it.each(['owner', 'tool'])('%s 恢复暂停关注从恢复时刻起算，重复设 active 不延后期限', async source => {
    const { ctx, api, bot } = await ownerFixture();
    ctx.clock.set(local('2026-11-05 07:00'));
    const watch = WatchSchema.parse(okData(await api.upsertWatch({ ...watchInput, botId: bot.id, status: 'paused',
      expectation: { text: '每小时日志', everyMs: hour } })));
    const resume = async () => source === 'owner'
      ? okData(await api.upsertWatch({ ...watchInput, botId: bot.id, id: watch.id, status: 'active' }))
      : updateWatch(ctx, bot.id, { id: watch.id, status: 'active' });
    ctx.clock.set(local('2026-11-06 15:00'));
    await resume();
    expect(ctx.store.table('watches').get(watch.id)?.expectation?.effectiveAt).toBe(ctx.clock.now());
    ctx.clock.advance(hour);
    await resume();
    expect(checkExpectations(ctx, ctx.clock.now())).toEqual([]);
    ctx.clock.advance(1);
    expect(checkExpectations(ctx, ctx.clock.now())).toHaveLength(1);
  });

  it('双期限各自受生效时刻约束；间隔首到期点在生效当日才算开始检查', async () => {
    const { ctx, api, bot } = await ownerFixture();
    ctx.clock.set(local('2026-11-05 15:00'));
    const watch = WatchSchema.parse(okData(await api.upsertWatch({ ...watchInput, botId: bot.id,
      expectation: { ...expected, everyMs: hour } })));
    expect(isExpectationStartedOnDay(watch, local('2026-11-04 23:00'), zone)).toBe(false);
    expect(isExpectationStartedOnDay(watch, ctx.clock.now(), zone)).toBe(true);
    expect(checkExpectations(ctx, ctx.clock.now())).toEqual([]);
    ctx.clock.advance(hour + 1);
    expect(checkExpectations(ctx, ctx.clock.now())).toHaveLength(1);
  });

  it('旧落空早于生效时刻时不触发同日去重，未来生效时刻也不提前检查', async () => {
    const { ctx, api, bot } = await ownerFixture();
    ctx.clock.set(local('2026-11-05 15:00'));
    const watch = WatchSchema.parse(okData(await api.upsertWatch({ ...watchInput, botId: bot.id,
      expectation: { text: '下午日志', byLocalTime: '16:00' } })));
    ctx.store.table('watches').patch(watch.id, { expectation: { ...watch.expectation!, lastMissedAt: local('2026-11-05 08:21') } });
    ctx.clock.set(local('2026-11-05 14:00'));
    expect(checkExpectations(ctx, ctx.clock.now())).toEqual([]);
    ctx.clock.set(local('2026-11-05 16:01'));
    expect(checkExpectations(ctx, ctx.clock.now())).toHaveLength(1);
  });
});

describe('M09 旧存档生效时刻兼容', () => {
  it('只补缺字段 effectiveAt=createdAt，完整保留历史数据并经 flush/reload 不再迁移', async () => {
    const ctx = createTestContext();
    const path = '/hub/.hub/state/watches.json';
    const legacy = { ...watchFixture, createdAt: local('2026-11-05 15:00'), updatedAt: local('2026-11-06 18:00'),
      expectation: { ...expected, everyMs: null, weekdays: null, lastSatisfiedAt: null, lastMissedAt: null, historicalNote: '保留' }, historicalVersion: 2 };
    const explicit = { ...legacy, id: 'wt_0000000002', expectation: { ...legacy.expectation, effectiveAt: local('2026-11-06 15:00') } };
    await ctx.fs.writeTextAtomic(path, JSON.stringify([legacy, explicit]));
    const store = new FileStore(ctx.fs, ctx.clock, '/hub', zone, ctx.logger);
    await store.load();
    expect(store.table('watches').list()).toEqual([{ ...legacy, expectation: { ...legacy.expectation, effectiveAt: legacy.createdAt } }, explicit]);
    expect(expectationEffectiveAt(legacy as Watch)).toBe(legacy.createdAt);
    expect(store.isDirty()).toBe(true);
    await store.flush();
    const reloaded = new FileStore(ctx.fs, ctx.clock, '/hub', zone, ctx.logger);
    await reloaded.load();
    expect(reloaded.table('watches').list()).toEqual(store.table('watches').list());
    expect(reloaded.isDirty()).toBe(false);
    expect((await ctx.fs.list('/hub/.hub/state')).filter(name => name.includes('.bad'))).toEqual([]);
    expect(ctx.logger.lines).toEqual([]);
  });
});

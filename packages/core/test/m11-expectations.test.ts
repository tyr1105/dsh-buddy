/** M11 按真实 Hub、文件存档与假时钟重放期望回归，防止发现日期冒充事情发生日期。 */
import { describe, expect, it } from 'vitest';
import { createHub } from '../src/engine/hub.js';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { WatchSchema } from '../src/model/perception.js';
import { FileStore } from '../src/store/file-store.js';
import { SimHost } from '../src/sim/sim-host.js';
import { quietBrain } from '../src/sim/brains.js';
import { createSimWorld } from '../src/sim/runner.js';
import { parseLocalDateTime } from '../src/util/time.js';
import { runTool } from '../src/tools/index.js';
import { hubWatchPropose } from '../src/tools/hub-watch-propose.js';
import { createUiApi } from '../src/api/index.js';
import { initRoot } from '../src/memory/files.js';
import { flushFileEvents, syncFileWatches } from '../src/perception/files.js';
import { checkExpectations } from '../src/perception/expectations.js';
import { markWatchSatisfied } from '../src/perception/satisfaction.js';
import { readWatchState } from '../src/perception/watch-state.js';
import { readFileBaseline } from '../src/perception/file-baseline.js';
import { buildDigest } from '../src/outreach/digest.js';
import { toolFixture } from './c03-tool-fixtures.js';
import { okData } from './c04-api-fixtures.js';
import { botFixture, watchFixture } from './model-fixtures.js';

const zone = 'Asia/Shanghai';
const hour = 3_600_000;
const local = (value: string) => parseLocalDateTime(value, zone);
const weekdays = [1, 2, 3, 4, 5];
const profile = { name: '日志队友', role: 'sentinel', persona: '逐项核实', aspirations: ['核对每天应出现的日志'] };
const watchInput = { kind: 'session', target: '日志', why: '保证工作日检查' };
const intervalError = 'weekdays 不为空时 everyMs 必须小于 24 小时；每个检查日一份请用 byLocalTime（例如每天 08:20 前）';

/** 走四个真实入口，并核对拒绝后不会留下半份关注或新机器人。 */
async function configure(entry: string, everyMs: number) {
  const expectation = { text: '日志出现', everyMs, weekdays };
  if (entry === 'hub_watch_propose' || entry === '反思交账') {
    const { ctx, tc, wake } = toolFixture();
    if (entry === '反思交账') ctx.store.table('wakes').patch(wake.id, { variant: 'reflection' });
    const before = ctx.store.table('watches').list();
    const result = entry === 'hub_watch_propose'
      ? await runTool(ctx, tc, entry, { ...watchInput, expectation })
      : await runTool(ctx, tc, 'hub_reflect_commit', { summary: '修正日志检查', lessons: [], routineUpdates: [], watchChanges: [{ ...watchInput, expectation }] });
    if (!result.ok) expect(ctx.store.table('watches').list()).toEqual(before);
    return result;
  }
  const ctx = createTestContext();
  await initRoot(ctx);
  const api = createUiApi(ctx, async () => { await ctx.store.flush(); });
  const bot = okData(await api.createBot({ ...profile, name: '配置发起者' }));
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

/** 日报定位到特定期望行，避免只匹配其他段落的“已出现”。 */
function expectationLine(text: string): string | undefined {
  return text.split('\n').find(row => row.startsWith('期望「'));
}

describe('M11 星期间隔与到期归属', () => {
  it.each(['hub_watch_propose', 'createBot', 'upsertWatch', '反思交账'])('%s 拒绝工作日 24h，边界内允许且错误含推荐写法', async entry => {
    expect(await configure(entry, 24 * hour)).toMatchObject({ ok: false, error: expect.stringContaining(intervalError) });
    expect(await configure(entry, 24 * hour - 1)).toMatchObject({ ok: true });
  });

  it('hub_watch_propose 工具说明直接告诉队友每个检查日一份的正确写法', () => {
    expect(hubWatchPropose.description).toContain('每个检查日一份请用 byLocalTime（例如每天 08:20 前）');
  });

  it('工作日 12h 周一当天报落空；凌晨旧欠期归周一，周三日报仍认周二已出现', async () => {
    const world = await createSimWorld({ startAt: local('2026-11-06 07:00'), bots: [{ id: botFixture.id, name: '日志队友' }] });
    const target = '/sim-hub/shared/daily.log';
    await world.fs.writeTextAtomic(target, '初始\n');
    const watch = WatchSchema.parse(okData(await world.hub.api.upsertWatch({ botId: botFixture.id, kind: 'log', target, why: '核对半日更新',
      expectation: { text: '日志出现', everyMs: 12 * hour, weekdays } })));
    const tickAt = async (at: string) => { world.clock.set(local(at)); await world.hub.tick(); await world.host.settle(); };
    await tickAt('2026-11-09 12:01');
    const monday = world.store.table('percepts').list(row => row.watchId === watch.id && row.kind === 'expectation_missed');
    expect(monday).toHaveLength(1);
    expect(monday[0]).toMatchObject({ createdAt: local('2026-11-09 12:01'), dueAt: local('2026-11-09 12:00') });
    await tickAt('2026-11-10 00:01');
    const late = world.store.table('percepts').list(row => row.watchId === watch.id && row.kind === 'expectation_missed');
    expect(late).toHaveLength(2);
    expect(late[1]).toMatchObject({ createdAt: local('2026-11-10 00:01'), dueAt: local('2026-11-09 12:00') });
    for (const at of ['2026-11-10 08:10', '2026-11-10 20:00']) {
      world.clock.set(local(at)); await world.fs.appendText(target, `${at} 更新\n`);
      await world.hub.tick(); world.clock.advance(120_000); await world.hub.tick(); await world.host.settle();
      if (at.endsWith('08:10')) await tickAt('2026-11-10 08:30');
    }
    await tickAt('2026-11-11 08:30');
    const digest = (day: string) => world.store.log('thread').all().find(row => row.refId === `digest:${day}`)!.text;
    expect(expectationLine(digest('2026-11-10'))).toBe(`期望「日志出现，工作日，每 12 小时」：【未出现】（${target}）`);
    expect(expectationLine(digest('2026-11-11'))).toBe(`期望「日志出现，工作日，每 12 小时」：已出现（${target}）`);
    await world.hub.stop();
  });

  it('只在凌晨首次发现旧欠期时，真实到期点经 FileStore 往返仍属前一天', async () => {
    const ctx = createTestContext();
    const createdAt = local('2026-11-06 07:00');
    ctx.store.table('bots').put(botFixture);
    ctx.store.table('watches').put({ ...watchFixture, createdAt, expectation: { text: '日志出现', everyMs: 12 * hour,
      byLocalTime: null, weekdays, effectiveAt: createdAt, lastSatisfiedAt: null, lastMissedAt: null } });
    ctx.clock.set(local('2026-11-10 00:01'));
    expect(checkExpectations(ctx, ctx.clock.now())[0]).toMatchObject({ dueAt: local('2026-11-09 12:00') });
    for (const table of ['bots', 'watches', 'percepts'] as const) await ctx.fs.writeTextAtomic(`/hub/.hub/state/${table}.json`, JSON.stringify(ctx.store.table(table).list()));
    const store = new FileStore(ctx.fs, ctx.clock, '/hub', zone, ctx.logger); await store.load();
    expect(store.table('watches').get(watchFixture.id)?.expectation?.lastMissedDueAt).toBe(local('2026-11-09 12:00'));
    expect(store.table('percepts').list()[0]?.dueAt).toBe(local('2026-11-09 12:00'));
    // 周二实际满足，昨日的落空不能污染周二；最新时间与历史感知两个通道都要守住日期。
    const watch = store.table('watches').get(watchFixture.id)!;
    store.table('watches').patch(watch.id, { expectation: { ...watch.expectation!, lastSatisfiedAt: local('2026-11-10 08:10') } });
    expect(expectationLine(buildDigest({ ...ctx, store }, local('2026-11-11 08:30')))).toContain('：已出现');
  });

  it('旧记录没有 dueAt 时仍以原发现日期归属，既有落空不会被升级抹掉', () => {
    const ctx = createTestContext();
    ctx.store.table('bots').put(botFixture);
    ctx.store.table('watches').put({ ...watchFixture, createdAt: local('2026-11-05 07:00'), expectation: {
      text: '旧期望', everyMs: null, byLocalTime: '08:20', weekdays,
      lastSatisfiedAt: local('2026-11-06 10:00'), lastMissedAt: local('2026-11-06 08:21') } });
    expect(expectationLine(buildDigest(ctx, local('2026-11-07 08:30')))).toContain('：【未出现】');
  });

  it.each([
    { byLocalTime: '08:20', result: '【未出现】' }, { byLocalTime: null, result: '已出现' },
  ])('钟点=$byLocalTime：旧间隔与当前钟点分别归属，周二晚到满足后日报为$result', async ({ byLocalTime, result }) => {
    const ctx = createTestContext();
    const createdAt = local('2026-11-06 07:00');
    ctx.store.table('bots').put(botFixture);
    ctx.store.table('watches').put({ ...watchFixture, createdAt, expectation: {
      text: '双期限日志', everyMs: 12 * hour, byLocalTime, weekdays, effectiveAt: createdAt,
      lastSatisfiedAt: null, lastMissedAt: null } });
    ctx.clock.set(local('2026-11-10 08:21'));
    const dueAts = [local('2026-11-09 12:00'), ...(byLocalTime ? [local('2026-11-10 08:20')] : [])];
    expect(checkExpectations(ctx, ctx.clock.now())).toEqual([expect.objectContaining({ dueAt: dueAts[0], dueAts })]);
    expect(checkExpectations(ctx, ctx.clock.now())).toEqual([]);
    ctx.clock.set(local('2026-11-10 09:00'));
    markWatchSatisfied(ctx, watchFixture.id, ctx.clock.now());
    for (const table of ['bots', 'watches', 'percepts'] as const) await ctx.fs.writeTextAtomic(`/hub/.hub/state/${table}.json`, JSON.stringify(ctx.store.table(table).list()));
    const store = new FileStore(ctx.fs, ctx.clock, '/hub', zone, ctx.logger); await store.load();
    expect(store.table('watches').get(watchFixture.id)?.expectation?.lastMissedDueAts).toEqual(dueAts);
    expect(store.table('percepts').list()[0]?.dueAts).toEqual(dueAts);
    expect(expectationLine(buildDigest({ ...ctx, store }, local('2026-11-11 08:30')))).toContain(`：${result}`);
    // 分别只留历史感知或最近期望事实，两个读回通道都不能丢掉双期限。
    const expectation = store.table('watches').get(watchFixture.id)!.expectation!;
    store.table('watches').patch(watchFixture.id, { expectation: { ...expectation, lastMissedAt: null } });
    expect(expectationLine(buildDigest({ ...ctx, store }, local('2026-11-11 08:30')))).toContain(`：${result}`);
    store.table('watches').patch(watchFixture.id, { expectation });
    for (const row of store.table('percepts').list()) store.table('percepts').remove(row.id);
    expect(expectationLine(buildDigest({ ...ctx, store }, local('2026-11-11 08:30')))).toContain(`：${result}`);
  });

  it('双期限恰好落在同一时刻只保存一个到期点，仍只有一条感知和一次每日限报', () => {
    const ctx = createTestContext(); const createdAt = local('2026-11-09 07:00');
    ctx.clock.set(local('2026-11-09 08:21'));
    ctx.store.table('bots').put(botFixture);
    ctx.store.table('watches').put({ ...watchFixture, createdAt, expectation: {
      text: '双期限日志', everyMs: 80 * 60_000, byLocalTime: '08:20', weekdays, effectiveAt: createdAt,
      lastSatisfiedAt: null, lastMissedAt: null } });
    const dueAt = local('2026-11-09 08:20');
    expect(checkExpectations(ctx, ctx.clock.now())).toEqual([expect.objectContaining({ dueAt, dueAts: [dueAt] })]);
    expect(ctx.store.table('watches').get(watchFixture.id)?.expectation?.lastMissedDueAts).toEqual([dueAt]);
    expect(checkExpectations(ctx, ctx.clock.now())).toEqual([]);
  });

  it('小数 everyMs 保留精确到期比较，仅到期存档向下取整，且不阻断后续关注检查', () => {
    const ctx = createTestContext(); const createdAt = local('2026-11-09 07:00');
    ctx.store.table('bots').put(botFixture);
    const first = WatchSchema.parse({ ...watchFixture, createdAt, expectation: {
      text: '亚毫秒间隔日志', everyMs: hour + 0.5, byLocalTime: null, weekdays, effectiveAt: createdAt,
      lastSatisfiedAt: null, lastMissedAt: null } });
    ctx.store.table('watches').put(first);
    ctx.store.table('watches').put({ ...first, id: 'wt_0000000002', target: '/hub/shared/another.log' });
    ctx.clock.set(createdAt + hour);
    expect(checkExpectations(ctx, ctx.clock.now())).toEqual([]);
    // 整数毫秒时钟在 .5ms 期限之后第一次观察是 +1ms；不把期限先取整后提前判落空。
    ctx.clock.advance(1);
    expect(checkExpectations(ctx, ctx.clock.now())).toEqual([
      expect.objectContaining({ watchId: first.id, dueAt: createdAt + hour, dueAts: [createdAt + hour] }),
      expect.objectContaining({ watchId: 'wt_0000000002', dueAt: createdAt + hour, dueAts: [createdAt + hour] }),
    ]);
    expect(ctx.store.table('watches').get(first.id)?.expectation?.everyMs).toBe(hour + 0.5);
  });
});

/** 新建 FileStore、宿主与 Hub 模拟真正重启，共用磁盘和时钟是唯一跨进程资源。 */
async function restartFixture(checkDays: number[] | null = weekdays) {
  const ctx = createTestContext(); ctx.clock.set(local('2026-11-05 07:00'));
  const target = '/hub/shared/morning.log'; await ctx.fs.writeTextAtomic(target, '初始\n');
  const open = async () => {
    const store = new FileStore(ctx.fs, ctx.clock, '/hub', zone, ctx.logger);
    const host = new SimHost(ctx.clock); host.setDefaultBrain(quietBrain);
    const hub = createHub({ ...ctx, host, store, settings: { rootDir: '/hub', timezone: zone } });
    host.attach(hub); await hub.start(); await host.settle();
    return { store, host, hub };
  };
  let process = await open();
  const bot = okData(await process.hub.api.createBot({ ...profile, name: '配置发起者' }));
  const watch = WatchSchema.parse(okData(await process.hub.api.upsertWatch({ botId: bot.id, kind: 'log', target, why: '核实每日早盘日志',
    expectation: { text: '早盘日志出现', byLocalTime: '08:20', weekdays: checkDays } })));
  ctx.clock.set(local('2026-11-05 08:10')); await ctx.fs.appendText(target, '周四日志\n');
  ctx.clock.advance(120_000); await process.hub.tick(); await process.host.settle();
  ctx.clock.set(local('2026-11-05 20:00')); await process.hub.tick(); await process.host.settle();
  return { ctx, target, watch, process, open };
}

describe('M11 文件满足属于真实发生时刻', () => {
  it.each([
    { mode: '重启', written: true }, { mode: '重启', written: false },
    { mode: 'tick 中断', written: true }, { mode: 'tick 中断', written: false },
  ])('$mode 周四 20:00 至周六 09:00，周五写出=$written 的日报与审计都正确', async ({ mode, written }) => {
    const fixture = await restartFixture(); const { ctx, target, watch, open } = fixture;
    let process = fixture.process;
    if (mode === '重启') await process.hub.stop();
    ctx.clock.set(local('2026-11-06 08:10'));
    if (written) await ctx.fs.appendText(target, '周五日志\n');
    ctx.clock.set(local('2026-11-07 09:00'));
    if (mode === '重启') process = await open();
    await process.hub.tick(); await process.host.settle();
    const digest = process.store.log('thread').all().find(row => row.refId === 'digest:2026-11-07')!;
    expect(expectationLine(digest.text)).toBe(`期望「早盘日志出现，工作日每天 08:20 前」：${written ? '已出现' : '【未出现】'}（${target}）`);
    expect(process.store.table('watches').get(watch.id)?.expectation?.lastSatisfiedAt)
      .toBe(local(written ? '2026-11-06 08:10' : '2026-11-05 08:10'));
    expect(process.store.log('audit').all().filter(row => row.action === 'expectation_satisfied').map(row => row.at))
      .toEqual([local('2026-11-05 08:10'), ...(written ? [local('2026-11-06 08:10')] : [])]);
    expect(process.host.notifications.filter(row => row.title === '团队日报 2026-11-07')).toHaveLength(1);
    await process.hub.stop();
  });

  it('同一在线批次跨日发生多次变化，满足与审计取 firstAt 而非最后一次或处理时刻', async () => {
    const ctx = createTestContext(); ctx.clock.set(local('2026-11-05 07:00'));
    const target = '/hub/shared/batched.log'; await ctx.fs.writeTextAtomic(target, '初始\n');
    ctx.store.table('bots').put(botFixture);
    ctx.store.table('watches').put({ ...watchFixture, kind: 'log', target, createdAt: ctx.clock.now(), expectation: {
      text: '日志出现', everyMs: null, byLocalTime: '08:20', weekdays, lastSatisfiedAt: null, lastMissedAt: null } });
    await syncFileWatches(ctx);
    ctx.clock.set(local('2026-11-06 08:10')); await ctx.fs.appendText(target, '第一条\n');
    ctx.clock.set(local('2026-11-07 08:50')); await ctx.fs.appendText(target, '第二条\n');
    expect(ctx.runtime.pendingFileEvents.get(watchFixture.id)?.firstAt).toBe(local('2026-11-06 08:10'));
    ctx.clock.set(local('2026-11-07 09:00')); await flushFileEvents(ctx, ctx.clock.now());
    expect(ctx.store.table('watches').get(watchFixture.id)?.expectation?.lastSatisfiedAt).toBe(local('2026-11-06 08:10'));
    expect(ctx.store.log('audit').all().filter(row => row.action === 'expectation_satisfied').map(row => row.at)).toEqual([local('2026-11-06 08:10')]);
  });

  it('离线文件的未来 mtime 截到发现时刻，启动跳过去抖不篡改真实时间', async () => {
    const { ctx, target, watch, process, open } = await restartFixture();
    await process.hub.stop();
    ctx.clock.set(local('2026-11-07 10:00')); await ctx.fs.appendText(target, '时间偏快的文件\n');
    ctx.clock.set(local('2026-11-07 09:00'));
    const reopened = await open();
    expect(reopened.store.table('watches').get(watch.id)?.expectation?.lastSatisfiedAt).toBe(local('2026-11-07 09:00'));
    expect(reopened.store.log('audit').all().filter(row => row.action === 'expectation_satisfied').map(row => row.at))
      .toEqual([local('2026-11-05 08:10'), local('2026-11-07 09:00')]);
    await reopened.hub.stop();
  });

  it('周五离线写出的满足只属于周五，不能掩盖周六真正没写的日志', async () => {
    const { ctx, target, watch, process, open } = await restartFixture(null);
    await process.hub.stop();
    ctx.clock.set(local('2026-11-06 08:10')); await ctx.fs.appendText(target, '周五日志\n');
    ctx.clock.set(local('2026-11-07 09:00'));
    const reopened = await open(); await reopened.hub.tick(); await reopened.host.settle();
    expect(reopened.store.table('percepts').list(row => row.watchId === watch.id && row.kind === 'expectation_missed'))
      .toEqual([expect.objectContaining({ createdAt: local('2026-11-07 09:00'), dueAt: local('2026-11-07 08:20') })]);
    ctx.clock.set(local('2026-11-08 08:30')); await reopened.hub.tick(); await reopened.host.settle();
    const digest = (day: string) => reopened.store.log('thread').all().find(row => row.refId === `digest:${day}`)!.text;
    expect(expectationLine(digest('2026-11-07'))).toBe(`期望「早盘日志出现」：已出现（${target}）`);
    expect(expectationLine(digest('2026-11-08'))).toBe(`期望「早盘日志出现」：【未出现】（${target}）`);
    await reopened.hub.stop();
  });

  it('FileStore 重启补扫小数 mtime 时以整数真实时刻满足，感知成功入表且不反复失败', async () => {
    const { ctx, target, watch, process, open } = await restartFixture();
    await process.hub.stop();
    const writtenAt = local('2026-11-06 08:10');
    ctx.clock.set(writtenAt); await ctx.fs.appendText(target, '周五小数时间日志\n');
    // 模拟 Node stat 的亚毫秒精度；不能把 MemoryFs 的整数时钟当成真实文件接口的全部输入域。
    const stat = ctx.fs.stat.bind(ctx.fs);
    ctx.fs.stat = async path => { const info = await stat(path); return info && path === target ? { ...info, mtimeMs: info.mtimeMs + 0.75 } : info; };
    ctx.clock.set(local('2026-11-07 09:00'));
    const reopened = await open();
    const fresh = reopened.store.table('watches').get(watch.id)!;
    expect(fresh.expectation?.lastSatisfiedAt).toBe(writtenAt);
    expect(readWatchState(fresh)).toMatchObject({ lastError: null, consecutiveFailures: 0 });
    expect(reopened.store.log('audit').all().filter(row => row.action === 'expectation_satisfied').map(row => row.at))
      .toEqual([local('2026-11-05 08:10'), writtenAt]);
    const changes = () => reopened.store.table('percepts').list(row => row.watchId === watch.id && row.kind === 'changed');
    expect(changes()).toHaveLength(2);
    expect(changes()[1]?.createdAt).toBe(ctx.clock.now());
    await reopened.hub.tick(); ctx.clock.advance(120_000); await reopened.hub.tick(); await reopened.host.settle();
    expect(changes()).toHaveLength(2);
    expect(readWatchState(reopened.store.table('watches').get(watch.id)!)).toMatchObject({ lastError: null, consecutiveFailures: 0 });
    expect((await readFileBaseline({ ...ctx, store: reopened.store }, fresh))?.entries[target]?.mtimeMs).toBe(writtenAt + 0.75);
    await reopened.hub.stop();
  });

  it('单文件漏回调的 stat 补扫把小数 mtime 转成整数，清掉批次并保留基线原精度', async () => {
    const ctx = createTestContext(); ctx.clock.set(local('2026-11-05 07:00'));
    const target = '/hub/shared/missed-callback.log'; await ctx.fs.writeTextAtomic(target, '初始\n');
    ctx.store.table('bots').put(botFixture);
    ctx.store.table('watches').put({ ...watchFixture, kind: 'log', target, createdAt: ctx.clock.now(), expectation: {
      text: '日志出现', everyMs: null, byLocalTime: '08:20', weekdays, lastSatisfiedAt: null, lastMissedAt: null } });
    // 监听成功注册但系统没有送达回调，必须走 existing.single 的 stat 补扫分支。
    ctx.fs.watch = () => () => undefined;
    const stat = ctx.fs.stat.bind(ctx.fs);
    ctx.fs.stat = async path => { const info = await stat(path); return info && path === target ? { ...info, mtimeMs: info.mtimeMs + 0.25 } : info; };
    await syncFileWatches(ctx);
    const writtenAt = local('2026-11-06 08:10');
    ctx.clock.set(writtenAt); await ctx.fs.appendText(target, '漏送回调的日志\n');
    expect(ctx.runtime.pendingFileEvents.size).toBe(0);
    ctx.clock.set(local('2026-11-07 09:00')); await syncFileWatches(ctx);
    expect(ctx.runtime.pendingFileEvents.get(watchFixture.id)).toMatchObject({ firstAt: writtenAt, lastAt: writtenAt });
    expect(await flushFileEvents(ctx, ctx.clock.now())).toHaveLength(1);
    expect(ctx.runtime.pendingFileEvents.size).toBe(0);
    const watch = ctx.store.table('watches').get(watchFixture.id)!;
    expect(watch.expectation?.lastSatisfiedAt).toBe(writtenAt);
    expect(readWatchState(watch)).toMatchObject({ lastError: null, consecutiveFailures: 0 });
    expect((await readFileBaseline(ctx, watch))?.entries[target]?.mtimeMs).toBe(writtenAt + 0.25);
    await syncFileWatches(ctx); expect(ctx.runtime.pendingFileEvents.size).toBe(0);
    expect(ctx.store.log('audit').all().filter(row => row.action === 'expectation_satisfied').map(row => row.at)).toEqual([writtenAt]);
  });
});

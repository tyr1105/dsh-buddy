/** 文件测试由内存文件系统真实发出监听事件；检查首事件去抖、目录过滤、日志尾部和失败隔离。 */
import { describe, expect, it } from 'vitest';
import { syncFileWatches, flushFileEvents, parseFileTarget } from '../src/perception/files.js';
import { readWatchState } from '../src/perception/watch-state.js';
import { watchFixture } from './model-fixtures.js';
import { perceptionContext, minute } from './perception-fixtures.js';

const target = '/hub/files';
async function flush(ctx: ReturnType<typeof perceptionContext>) { ctx.clock.advance(2 * minute); return flushFileEvents(ctx, ctx.clock.now()); }

describe('文件感知', () => {
  it('初始只建基线不产生感知，变化达到 2 分钟才发出', async () => {
    const ctx = perceptionContext({ target }); await ctx.fs.mkdirp(target); await ctx.fs.writeTextAtomic(`${target}/a.txt`, 'old');
    await syncFileWatches(ctx); expect(ctx.store.table('percepts').count()).toBe(0);
    await ctx.fs.writeTextAtomic(`${target}/a.txt`, 'new'); ctx.clock.advance(2 * minute - 1);
    expect(await flushFileEvents(ctx, ctx.clock.now())).toEqual([]); ctx.clock.advance(1);
    expect((await flushFileEvents(ctx, ctx.clock.now()))[0]).toMatchObject({ kind: 'changed', source: 'file' });
  });
  it('按首事件计 2 分钟，持续新事件合并为一条', async () => {
    const ctx = perceptionContext({ target }); await ctx.fs.mkdirp(target); await syncFileWatches(ctx);
    await ctx.fs.writeTextAtomic(`${target}/a.txt`, 'a'); ctx.clock.advance(minute);
    await ctx.fs.writeTextAtomic(`${target}/b.txt`, 'b'); ctx.clock.advance(minute);
    const result = await flushFileEvents(ctx, ctx.clock.now()); expect(result).toHaveLength(1); expect(result[0]?.magnitude).toBe(0.4);
    expect(result[0]?.summary).toContain('a.txt'); expect(result[0]?.summary).toContain('b.txt');
  });
  it('删除文件归为 deleted，新文件归为 created', async () => {
    const ctx = perceptionContext({ target }); await ctx.fs.mkdirp(target); await ctx.fs.writeTextAtomic(`${target}/a.txt`, 'a'); await syncFileWatches(ctx);
    await ctx.fs.remove(`${target}/a.txt`); expect((await flush(ctx))[0]?.kind).toBe('deleted');
    await ctx.fs.writeTextAtomic(`${target}/b.txt`, 'b'); expect((await flush(ctx))[0]?.kind).toBe('created');
  });
  it('能获取大小时取文件数与大小变化比例的较大值', async () => {
    const path = `${target}/a.txt`; const ctx = perceptionContext({ target: path }); await ctx.fs.writeTextAtomic(path, 'a'); await syncFileWatches(ctx);
    await ctx.fs.writeTextAtomic(path, 'a'.repeat(10)); expect((await flush(ctx))[0]?.magnitude).toBe(0.9);
  });
  it('目录支持递归事件', async () => {
    const ctx = perceptionContext({ target }); await ctx.fs.mkdirp(`${target}/nested`); await syncFileWatches(ctx);
    await ctx.fs.writeTextAtomic(`${target}/nested/a.txt`, 'a'); expect((await flush(ctx))[0]?.summary).toContain('nested/a.txt');
  });
  it('只监听单文件，不接收同目录其他文件', async () => {
    const ctx = perceptionContext({ target: `${target}/a.txt` }); await ctx.fs.mkdirp(target); await syncFileWatches(ctx);
    await ctx.fs.writeTextAtomic(`${target}/b.txt`, 'b'); expect(await flush(ctx)).toEqual([]);
    await ctx.fs.writeTextAtomic(`${target}/a.txt`, 'a'); expect(await flush(ctx)).toHaveLength(1);
  });
  it('通配符只匹配目录直属扩展名', async () => {
    const ctx = perceptionContext({ target: `${target}/*.txt` }); await ctx.fs.mkdirp(`${target}/nested`); await syncFileWatches(ctx);
    await ctx.fs.writeTextAtomic(`${target}/a.md`, 'md'); await ctx.fs.writeTextAtomic(`${target}/nested/a.txt`, 'nested');
    expect(await flush(ctx)).toEqual([]); await ctx.fs.writeTextAtomic(`${target}/a.txt`, 'txt'); expect(await flush(ctx)).toHaveLength(1);
  });
  it.each(['/hub/**/*.txt', '/hub/a?.txt', '/hub/*/a.txt', 'relative.txt'])('拒绝不支持路径 %s', value => {
    expect(() => parseFileTarget(value)).toThrow();
  });
  it('暂停后取消监听并清掉未处理事件', async () => {
    const ctx = perceptionContext({ target }); await ctx.fs.mkdirp(target); await syncFileWatches(ctx); await ctx.fs.writeTextAtomic(`${target}/a.txt`, 'a');
    ctx.store.table('watches').patch(watchFixture.id, { status: 'paused' }); await syncFileWatches(ctx);
    expect(ctx.runtime.watchDisposers.size).toBe(0); expect(ctx.runtime.pendingFileEvents.size).toBe(0);
    await ctx.fs.writeTextAtomic(`${target}/b.txt`, 'b'); expect(await flush(ctx)).toEqual([]);
  });
  it('反复同步不重复注册，修改 target 会更换监听', async () => {
    const ctx = perceptionContext({ target }); await ctx.fs.mkdirp(target); await syncFileWatches(ctx); await syncFileWatches(ctx);
    expect(ctx.runtime.watchDisposers.size).toBe(1);
    await ctx.fs.mkdirp('/hub/other'); ctx.store.table('watches').patch(watchFixture.id, { target: '/hub/other' }); await syncFileWatches(ctx);
    await ctx.fs.writeTextAtomic(`${target}/a.txt`, 'old'); expect(await flush(ctx)).toEqual([]);
    await ctx.fs.writeTextAtomic('/hub/other/a.txt', 'new'); expect(await flush(ctx)).toHaveLength(1);
  });
  it('一个无效关注项不会影响其他监听建立', async () => {
    const ctx = perceptionContext({ target: '/hub/**/*.txt' }); ctx.store.table('watches').put({ ...watchFixture, id: 'wt_0000000002', target });
    await ctx.fs.mkdirp(target); await syncFileWatches(ctx); expect(ctx.runtime.watchDisposers.size).toBe(1);
    expect(readWatchState(ctx.store.table('watches').get(watchFixture.id)!).lastError).toContain('通配符');
  });
});

describe('日志新增尾部与期望满足', () => {
  const path = '/hub/output.log';
  const expectation = { text: '有新增行', everyMs: minute, byLocalTime: null, weekdays: null, lastSatisfiedAt: null, lastMissedAt: null };
  it('首次记录大小，追加只报告新内容并满足期望', async () => {
    const ctx = perceptionContext({ target: path, kind: 'log', expectation }); await ctx.fs.writeTextAtomic(path, '旧行\n'); await syncFileWatches(ctx);
    const occurredAt = ctx.clock.now();
    await ctx.fs.appendText(path, '新增行\n'); const p = (await flush(ctx))[0]; expect(p?.summary).toBe('新增行\n');
    const watch = ctx.store.table('watches').get(watchFixture.id)!;
    expect(watch.expectation?.lastSatisfiedAt).toBe(occurredAt); expect(readWatchState(watch).size).toBe(Buffer.byteLength('旧行\n新增行\n'));
  });
  it('没有新增行时不满足期望', async () => {
    const ctx = perceptionContext({ target: path, kind: 'log', expectation }); await ctx.fs.writeTextAtomic(path, '旧行\n'); await syncFileWatches(ctx);
    await ctx.fs.appendText(path, '半行'); await flush(ctx); expect(ctx.store.table('watches').get(watchFixture.id)?.expectation?.lastSatisfiedAt).toBeNull();
  });
  it('日志截断轮换后从新文件起读', async () => {
    const ctx = perceptionContext({ target: path, kind: 'log' }); await ctx.fs.writeTextAtomic(path, '很长的原日志'.repeat(50)); await syncFileWatches(ctx);
    await ctx.fs.writeTextAtomic(path, '新日志\n'); expect((await flush(ctx))[0]?.summary).toBe('新日志\n');
  });
  it('大段日志只取最后 4 KB，中文不乱码，感知仍限制 500 字', async () => {
    const ctx = perceptionContext({ target: path, kind: 'log' }); await ctx.fs.writeTextAtomic(path, ''); await syncFileWatches(ctx);
    await ctx.fs.appendText(path, '前文'.repeat(3000) + '尾'.repeat(1400) + '\n'); const p = (await flush(ctx))[0];
    expect(p?.summary).not.toContain('前文'); expect(p?.summary).not.toContain('\ufffd'); expect(p?.summary.length).toBeLessThanOrEqual(500);
  });
  it('相同大小内容重写不误当追加行', async () => {
    const ctx = perceptionContext({ target: path, kind: 'log', expectation }); await ctx.fs.writeTextAtomic(path, 'aaa\n'); await syncFileWatches(ctx);
    await ctx.fs.writeTextAtomic(path, 'bbb\n'); expect(await flush(ctx)).toEqual([]); expect(ctx.store.table('watches').get(watchFixture.id)?.expectation?.lastSatisfiedAt).toBeNull();
  });
});

// 重启及临时故障的回归保证：既有关注项必须能补回离线事实，而不能靠后续新事件碰巧唤醒。
describe('文件关注恢复', () => {
  it('重新注册已有基线按 mtime 扫出离线同尺寸修改', async () => {
    const path = '/hub/file.txt'; const ctx = perceptionContext({ target: path });
    await ctx.fs.writeTextAtomic(path, 'old'); await syncFileWatches(ctx);
    ctx.runtime.watchDisposers.get(watchFixture.id)!(); ctx.runtime.watchDisposers.clear();
    ctx.clock.advance(10 * minute); await ctx.fs.writeTextAtomic(path, 'new');
    await syncFileWatches(ctx); expect(ctx.runtime.pendingFileEvents.size).toBe(1);
    expect((await flush(ctx))[0]?.kind).toBe('changed');
  });
  it('重新注册已有目录基线补回离线删除', async () => {
    const ctx = perceptionContext({ target }); await ctx.fs.mkdirp(target); await ctx.fs.writeTextAtomic(`${target}/a.txt`, 'a'); await syncFileWatches(ctx);
    ctx.runtime.watchDisposers.get(watchFixture.id)!(); ctx.runtime.watchDisposers.clear(); await ctx.fs.remove(`${target}/a.txt`);
    await syncFileWatches(ctx); expect((await flush(ctx))[0]?.kind).toBe('deleted');
  });
  it('临时读取失败保留待处理批次，恢复后重新处理', async () => {
    const path = '/hub/read.log'; const ctx = perceptionContext({ kind: 'log', target: path }); await ctx.fs.writeTextAtomic(path, ''); await syncFileWatches(ctx);
    await ctx.fs.appendText(path, '新行\n'); const originalRead = ctx.fs.readText.bind(ctx.fs);
    ctx.fs.readText = async () => { throw new Error('暂时无法读取'); };
    expect(await flush(ctx)).toEqual([]); expect(ctx.runtime.pendingFileEvents.size).toBe(1);
    ctx.fs.readText = originalRead; expect(await flushFileEvents(ctx, ctx.clock.now())).toHaveLength(1); expect(ctx.runtime.pendingFileEvents.size).toBe(0);
  });
});

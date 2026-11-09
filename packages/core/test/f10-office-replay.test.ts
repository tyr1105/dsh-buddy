/** F10 假时钟验收：历史保持观察时的灯与引用，去重、断点、日界线与落盘都不改当前事实。 */
import { describe, expect, it, vi } from 'vitest';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { resolveSettings, F10_DEFAULTS } from '../src/config/defaults.js';
import { createUiApi } from '../src/api/index.js';
import { officeReplay, recordOfficeFrame, markOfficeRecordFailure } from '../src/office/replay.js';
import { startOfLocalDay } from '../src/util/time.js';
import { FileStore, MemoryStore } from '../src/store/index.js';
import { botFixture } from './model-fixtures.js';

const DAY = 86400000;
/** 给历史房间一位在岗队友；所有时刻来自同一个可控时钟。 */
function setup() {
  const ctx = createTestContext();
  ctx.store.table('bots').put({ ...botFixture, lifecycle: 'active', activity: 'watching', updatedAt: ctx.clock.now() });
  return ctx;
}

describe('F10 实际观察与不可变历史', () => {
  it('同日相同房间去重，状态变化保留；选择之前最近一次记录而非插值', () => {
    const ctx = setup();
    const first = ctx.clock.now();
    recordOfficeFrame(ctx);
    ctx.clock.advance(1000);
    recordOfficeFrame(ctx);
    expect(ctx.store.table('officeFrames').count()).toBe(1);
    ctx.store.table('bots').patch(botFixture.id, { activity: 'thinking', updatedAt: ctx.clock.now() });
    recordOfficeFrame(ctx);
    const old = officeReplay(ctx, { at: first + 500 });
    expect(old.recordedAt).toBe(first);
    expect(old.room?.seats[0]?.light).toBe('watching');
    expect(officeReplay(ctx, {}).room?.seats[0]?.light).toBe('working');
    // 主人修改读取副本，不能影响存储或当前队友。
    old.room!.seats[0]!.occupant!.name = '改副本';
    expect(officeReplay(ctx, { at: first }).room?.seats[0]?.occupant?.name).toBe(botFixture.name);
    expect(ctx.store.table('bots').get(botFixture.id)?.activity).toBe('thinking');
  });

  it('房间内桌面 wakeId 与门口卡片引用固定，不受后来更换引用影响', () => {
    const ctx = setup();
    recordOfficeFrame(ctx);
    const row = ctx.store.table('officeFrames').list()[0]!;
    const seat = row.room!.seats[0]!;
    // 用存储中一份合法投影固定引用，下一帧由真实当前状态重新投影。
    seat.desk = { kind: 'wake_output', kindLabel: '本次产出（自述）', title: '旧产出',
      ref: 'wake:w_old', refKind: 'wake', refId: 'w_old' };
    seat.door = { count: 1, inboxIds: ['i_old'], refs: ['inbox:i_old'],
      items: [{ inboxId: 'i_old', type: 'question', title: '旧问题', ref: 'inbox:i_old' }] };
    ctx.store.table('officeFrames').put(row);
    ctx.clock.advance(100);
    ctx.store.table('bots').patch(botFixture.id, { activity: 'blocked' });
    recordOfficeFrame(ctx);
    const replay = officeReplay(ctx, { at: row.at });
    expect(replay.room?.seats[0]?.desk.refId).toBe('w_old');
    expect(replay.room?.seats[0]?.door.inboxIds).toEqual(['i_old']);
    expect(officeReplay(ctx, {}).room?.seats[0]?.desk.refKind).toBe('bot');
  });

  it('同一毫秒不同状态都有帧，选择得到确定的最后状态', () => {
    const ctx = setup();
    recordOfficeFrame(ctx);
    ctx.store.table('bots').patch(botFixture.id, { activity: 'thinking' });
    recordOfficeFrame(ctx);
    ctx.store.table('bots').patch(botFixture.id, { activity: 'blocked' });
    recordOfficeFrame(ctx);
    const rows = ctx.store.table('officeFrames').list();
    expect(new Set(rows.map(row => row.id)).size).toBe(3);
    expect(rows.map(row => row.sequence)).toEqual([0, 1, 2]);
    expect(officeReplay(ctx, {}).room?.seats[0]?.light).toBe('blocked');
  });

  it('跨日首帧不去重，午夜以前的帧不带入今天', () => {
    const ctx = setup();
    recordOfficeFrame(ctx);
    ctx.clock.advance(DAY);
    const today = startOfLocalDay(ctx.clock.now(), ctx.settings.timezone);
    expect(officeReplay(ctx, { at: today }).room).toBeNull();
    recordOfficeFrame(ctx);
    expect(ctx.store.table('officeFrames').count()).toBe(2);
    expect(officeReplay(ctx, {}).frames).toHaveLength(1);
  });

  it.each(['Asia/Shanghai', 'America/New_York', 'Pacific/Apia'])('日界线使用设置时区 %s', timezone => {
    const ctx = setup();
    ctx.settings = resolveSettings({ ...ctx.settings, timezone });
    const start = startOfLocalDay(ctx.clock.now(), timezone);
    expect(officeReplay(ctx, { at: start }).dayStart).toBe(start);
    expect(() => officeReplay(ctx, { at: start - 1 })).toThrow('今天');
    expect(officeReplay(ctx, { at: ctx.clock.now() }).selectedAt).toBe(ctx.clock.now());
    expect(() => officeReplay(ctx, { at: ctx.clock.now() + 1 })).toThrow('当前');
  });

  it.each([{ at: '昨天' }, { at: NaN }, { at: Infinity }, { at: 1.5 }, { other: 1 }, null])('非法选择中文拒绝 %j', raw => {
    expect(() => officeReplay(setup(), raw)).toThrow(/[\u3400-\u9fff]/);
  });

  it('首次记录之前与旧档没有历史都返回缺失，不用当前房间代替', () => {
    const ctx = setup();
    expect(officeReplay(ctx, {}).room).toBeNull();
    expect(officeReplay(ctx, {}).missing).toContain('没有房间记录');
    const first = ctx.clock.now();
    recordOfficeFrame(ctx);
    expect(officeReplay(ctx, { at: first - 1 }).room).toBeNull();
    expect(officeReplay(ctx, { at: first }).room).not.toBeNull();
  });
});

describe('F10 资源限制与停机断点', () => {
  it('单帧字节上限包含元数据，不以房间正文大小冒充整帧大小', () => {
    const ctx = setup();
    recordOfficeFrame(ctx);
    const row = ctx.store.table('officeFrames').list()[0]!;
    ctx.settings = resolveSettings({ ...ctx.settings,
      officeReplay: { maxFrameBytes: Buffer.byteLength(JSON.stringify(row.room), 'utf8') } });
    ctx.clock.advance(1);
    recordOfficeFrame(ctx);
    expect(officeReplay(ctx, {}).room).toBeNull();
    expect(officeReplay(ctx, {}).missing).toContain('大小上限');
  });
  it('帧额度到顶留断点，不能沿用最后房间；同原因断点去重，次日恢复', () => {
    const ctx = setup();
    ctx.settings = resolveSettings({ ...ctx.settings, officeReplay: { maxFramesPerDay: 1 } });
    recordOfficeFrame(ctx);
    ctx.clock.advance(100);
    ctx.store.table('bots').patch(botFixture.id, { activity: 'blocked' });
    recordOfficeFrame(ctx);
    expect(officeReplay(ctx, {}).missing).toContain('当天房间记录已达上限');
    expect(officeReplay(ctx, {}).room).toBeNull();
    ctx.clock.advance(100); recordOfficeFrame(ctx);
    expect(ctx.store.table('officeFrames').count()).toBe(2);
    ctx.clock.advance(DAY); recordOfficeFrame(ctx);
    expect(officeReplay(ctx, {}).room?.seats[0]?.light).toBe('blocked');
  });

  it('单帧超限不截断保存，恢复后新帧可读取、断点时段仍缺失', () => {
    const ctx = setup();
    recordOfficeFrame(ctx);
    ctx.clock.advance(100);
    const gapAt = ctx.clock.now();
    ctx.settings = resolveSettings({ ...ctx.settings, officeReplay: { maxFrameBytes: 1 } });
    recordOfficeFrame(ctx);
    expect(officeReplay(ctx, {}).room).toBeNull();
    expect(officeReplay(ctx, {}).missing).toContain('大小上限');
    ctx.settings = resolveSettings({ ...ctx.settings, officeReplay: { maxFrameBytes: F10_DEFAULTS.maxFrameBytes } });
    ctx.clock.advance(100); recordOfficeFrame(ctx);
    expect(officeReplay(ctx, {}).room).not.toBeNull();
    expect(officeReplay(ctx, { at: gapAt }).room).toBeNull();
  });

  it('停止到启动有空白；异常退出后重启也不把停机间隔当成旧房间', () => {
    const ctx = setup();
    recordOfficeFrame(ctx, 'start');
    ctx.clock.advance(100);
    const stopAt = ctx.clock.now();
    recordOfficeFrame(ctx, 'stop');
    ctx.clock.advance(100);
    expect(officeReplay(ctx, {}).room).toBeNull();
    recordOfficeFrame(ctx, 'start');
    expect(officeReplay(ctx, { at: stopAt + 1 }).missing).toContain('停止');
    expect(officeReplay(ctx, {}).room).not.toBeNull();
    const lastAt = ctx.clock.now();
    ctx.clock.advance(100); recordOfficeFrame(ctx, 'start');
    expect(officeReplay(ctx, { at: lastAt + 1 }).missing).toContain('未持续运行');
  });

  it('记录异常在内存留缺失，恢复先补断点再记新帧', () => {
    const ctx = setup();
    recordOfficeFrame(ctx);
    ctx.clock.advance(100);
    const failed = ctx.clock.now();
    markOfficeRecordFailure(ctx);
    expect(officeReplay(ctx, {}).missing).toContain('记录失败');
    expect(officeReplay(ctx, {}).room).toBeNull();
    ctx.clock.advance(100); recordOfficeFrame(ctx);
    expect(officeReplay(ctx, { at: failed }).room).toBeNull();
    expect(officeReplay(ctx, {}).room).not.toBeNull();
  });

  it('7 天保留精确边界，读取可用更短设置但不写盘', async () => {
    const ctx = setup();
    recordOfficeFrame(ctx);
    const row = ctx.store.table('officeFrames').list()[0]!;
    ctx.store.table('officeFrames').put({ ...row, id: 'edge', at: ctx.clock.now() - F10_DEFAULTS.retentionMs });
    ctx.store.table('officeFrames').put({ ...row, id: 'old', at: ctx.clock.now() - F10_DEFAULTS.retentionMs - 1 });
    await ctx.store.prune(ctx.clock.now());
    expect(ctx.store.table('officeFrames').get('old')).toBeNull();
    expect(ctx.store.table('officeFrames').get('edge')).not.toBeNull();
    ctx.clock.advance(100);
    ctx.settings = resolveSettings({ ...ctx.settings, retentionMsByCollection: { officeFrames: 10 } });
    await ctx.store.flush();
    expect(officeReplay(ctx, { at: row.at }).room).toBeNull();
    expect(ctx.store.isDirty()).toBe(false);
  });

  it('FileStore 独立文件恢复，缺表兼容；恢复后同毫秒顺序仍固定', async () => {
    const ctx = setup();
    const file = new FileStore(ctx.fs, ctx.clock, '/hub', ctx.settings.timezone);
    await file.load();
    expect(file.table('officeFrames').count()).toBe(0);
    const recorded = setup();
    recordOfficeFrame(recorded);
    recorded.store.table('bots').patch(botFixture.id, { activity: 'blocked' });
    recordOfficeFrame(recorded);
    for (const row of recorded.store.table('officeFrames').list()) file.table('officeFrames').put(row);
    await file.flush();
    expect(await ctx.fs.readText('/hub/.hub/state/officeFrames.json')).toContain('blocked');
    const restored = new FileStore(ctx.fs, ctx.clock, '/hub', ctx.settings.timezone);
    const revision = restored.table('officeFrames').revision();
    await restored.load();
    expect(restored.table('officeFrames').revision()).toBeGreaterThan(revision);
    expect(restored.isDirty()).toBe(false);
    expect(officeReplay({ ...ctx, store: restored }, {}).room?.seats[0]?.light).toBe('blocked');
    // 自定义保留期在存储层也生效。
    const short = new MemoryStore({ retentionMsByCollection: { ...ctx.settings.retentionMsByCollection, officeFrames: 10 } });
    short.table('officeFrames').put(recorded.store.table('officeFrames').list()[0]!);
    await short.prune(ctx.clock.now() + 11);
    expect(short.table('officeFrames').count()).toBe(0);
  });

  it('只读 API 不写审计、不调后处理或宿主；非法输入同样不写', async () => {
    const ctx = setup();
    recordOfficeFrame(ctx);
    await ctx.store.flush();
    const after = vi.fn(async () => {});
    const api = createUiApi(ctx, after);
    expect((await api.officeReplay({})).ok).toBe(true);
    expect((await api.officeReplay({ at: '错误' })).ok).toBe(false);
    expect(after).not.toHaveBeenCalled();
    expect(ctx.store.log('audit').all()).toEqual([]);
    expect(ctx.host.calls).toEqual([]);
    expect(ctx.store.isDirty()).toBe(false);
  });
});

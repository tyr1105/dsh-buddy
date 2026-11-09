/** F10 公共入口验收：观察在业务收口且落盘之前，读历史不能调度，记录异常不能击穿中心。 */
import { describe, expect, it, vi } from 'vitest';
import { createHub } from '../src/engine/hub.js';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { createBotHome } from '../src/memory/files.js';
import { botFixture } from './model-fixtures.js';

/** 用完整合法家目录验证实际中心收口，不直接调用回放记录器。 */
async function setup() {
  const ctx = createTestContext();
  const bot = { ...botFixture, lifecycle: 'active' as const, activity: 'watching' as const,
    sessionId: null, sessionStartedAt: null, lastThinkAt: null, lightCheckAt: null, updatedAt: ctx.clock.now() };
  ctx.store.table('bots').put(bot);
  await createBotHome(ctx, bot);
  const hub = createHub(ctx);
  await hub.start();
  return { ctx, hub, bot };
}

describe('F10 Hub 收口记录', () => {
  it('启动、tick、事件、主人命令、停止与重启都保存各自观察', async () => {
    const { ctx, hub, bot } = await setup();
    const first = ctx.clock.now();
    expect(ctx.store.table('officeFrames').count()).toBe(1);
    ctx.clock.advance(1000);
    ctx.store.table('bots').patch(bot.id, { activity: 'blocked', activityText: '资料不可用' });
    await hub.tick();
    expect((await hub.api.officeReplay({}))).toMatchObject({ ok: true, data: { room: { seats: [{ light: 'blocked' }] } } });
    ctx.clock.advance(1000);
    ctx.store.table('bots').patch(bot.id, { activity: 'resting', activityText: '暂时休息' });
    await hub.onOwnerActivity(ctx.clock.now());
    expect((await hub.api.officeReplay({}))).toMatchObject({ ok: true, data: { room: { seats: [{ light: 'resting' }] } } });
    const renamed = await hub.api.updateBot(bot.id, { name: '改名后' });
    expect(renamed.ok).toBe(true);
    expect((await hub.api.officeReplay({}))).toMatchObject({ ok: true, data: { room: { seats: [{ occupant: { name: '改名后' } }] } } });
    ctx.clock.advance(1000); await hub.stop();
    expect((await hub.api.officeReplay({}))).toMatchObject({ ok: true, data: { room: null, missing: expect.stringContaining('停止') } });
    const count = ctx.store.table('officeFrames').count();
    ctx.clock.advance(1000); await hub.tick();
    expect(ctx.store.table('officeFrames').count()).toBe(count);
    await hub.start();
    expect((await hub.api.officeReplay({ at: first }))).toMatchObject({ ok: true, data: { room: { seats: [{ light: 'watching' }] } } });
    expect((await hub.api.officeReplay({}))).toMatchObject({ ok: true, data: { room: { seats: [{ occupant: { name: '改名后' } }] } } });
  });

  it('帧在 flush 前存在；读回放成功或失败均不刷盘、不写审计、不发通知、不调用宿主', async () => {
    const { ctx, hub, bot } = await setup();
    const saved: string[] = [];
    const flush = ctx.store.flush.bind(ctx.store);
    vi.spyOn(ctx.store, 'flush').mockImplementation(async () => {
      saved.push(ctx.store.table('officeFrames').list().at(-1)?.room?.seats[0]?.occupant?.name ?? '');
      await flush();
    });
    expect((await hub.api.updateBot(bot.id, { name: '收口新名' })).ok).toBe(true);
    expect(saved.at(-1)).toBe('收口新名');
    const calls = ctx.host.calls.length;
    const audit = ctx.store.log('audit').all();
    const changed = vi.fn(); hub.subscribe(changed);
    const writes = saved.length;
    expect((await hub.api.officeReplay({})).ok).toBe(true);
    expect((await hub.api.officeReplay({ at: '坏时间' })).ok).toBe(false);
    expect(saved).toHaveLength(writes);
    expect(ctx.host.calls).toHaveLength(calls);
    expect(ctx.store.log('audit').all()).toEqual(audit);
    expect(changed).not.toHaveBeenCalled();
    expect(ctx.store.isDirty()).toBe(false);
  });

  it('房间表写入异常仍保存业务；失败时段缺失，恢复后补断点', async () => {
    const { ctx, hub, bot } = await setup();
    const table = ctx.store.table.bind(ctx.store);
    let fail = true;
    vi.spyOn(ctx.store, 'table').mockImplementation(((name: Parameters<typeof table>[0]) => {
      const original = table(name);
      if (name !== 'officeFrames' || !fail) return original;
      return { ...original, put: () => { throw new Error('历史表暂时不可写'); } };
    }) as typeof ctx.store.table);
    ctx.clock.advance(1000);
    const failureAt = ctx.clock.now();
    expect((await hub.api.updateBot(bot.id, { name: '业务已保存' })).ok).toBe(true);
    expect(ctx.store.table('bots').get(bot.id)?.name).toBe('业务已保存');
    expect(ctx.store.isDirty()).toBe(false);
    expect((await hub.api.officeReplay({}))).toMatchObject({ ok: true, data: { room: null, missing: expect.stringContaining('记录失败') } });
    fail = false; ctx.clock.advance(1000);
    await hub.onOwnerActivity(ctx.clock.now());
    expect((await hub.api.officeReplay({ at: failureAt }))).toMatchObject({ ok: true, data: { room: null } });
    expect((await hub.api.officeReplay({}))).toMatchObject({ ok: true, data: { room: { seats: [{ occupant: { name: '业务已保存' } }] } } });
    expect(ctx.logger.lines.some(line => line.level === 'error' && line.message.includes('房间历史'))).toBe(true);
  });
});

/** 模型目录读取可能等待宿主；档案修改必须合入最新状态，不能用读取前的快照复活已打断回合。 */
import { describe, expect, it, vi } from 'vitest';
import { createHub } from '../src/index.js';
import { updateBot, setLifecycle } from '../src/api/bots.js';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { okData } from './c04-api-fixtures.js';
import { toolFixture } from './c03-tool-fixtures.js';

const option = { provider: 'catalog-provider', model: 'catalog-model', label: '目录模型' };
const choice = { provider: option.provider, model: option.model };

/** 直接控制等待点而不使用真实定时器，确保变化恰好发生在目录校验中途。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('M07 模型目录等待中的档案合并', () => {
  it('真实 Hub 修改档案等待目录时仍可打断；目录返回后不恢复旧会话或 thinking 状态', async () => {
    const ctx = createTestContext();
    const listModels = vi.fn(async () => [option]);
    const hub = createHub({ ...ctx, listModels });
    await hub.start();
    const bot = okData(await hub.api.createBot({ name: '等待目录', role: 'researcher', persona: '原档案', aspirations: ['核实公开证据'], model: choice }));
    const wake = ctx.store.table('wakes').list(row => row.botId === bot.id && row.status === 'running')[0]!;
    expect(wake.sessionId).not.toBeNull();
    const entered = deferred<void>(), catalog = deferred<typeof option[]>(), canceled = deferred<void>();
    listModels.mockImplementationOnce(() => { entered.resolve(); return catalog.promise; });
    const originalCancel = ctx.host.cancel.bind(ctx.host);
    vi.spyOn(ctx.host, 'cancel').mockImplementation(async sessionId => { await originalCancel(sessionId); canceled.resolve(); });
    const editing = hub.api.updateBot(bot.id, { persona: '新档案保留' });
    await entered.promise;
    const interrupting = hub.api.interruptBot({ botId: bot.id });
    await canceled.promise;
    expect(ctx.store.table('bots').get(bot.id)).toMatchObject({ sessionId: null, activity: 'watching' });
    ctx.clock.advance(1);
    catalog.resolve([option]);
    expect(await editing).toMatchObject({ ok: true });
    expect(await interrupting).toMatchObject({ ok: true });
    expect(ctx.store.table('bots').get(bot.id)).toMatchObject({ persona: '新档案保留', sessionId: null, sessionStartedAt: null,
      lifecycle: 'probation', activity: 'watching', consecutiveErrors: 0, consecutiveNoCommit: 0, updatedAt: ctx.clock.now() });
    expect(ctx.store.table('wakes').get(wake.id)).toMatchObject({ status: 'canceled', canceledBy: 'owner' });
    await hub.stop();
  });

  it('目录等待期间运行计数和资格变化被保留，只应用显式档案字段', async () => {
    const { ctx, bot } = toolFixture();
    ctx.store.table('bots').patch(bot.id, { model: choice });
    const entered = deferred<void>(), catalog = deferred<typeof option[]>();
    const updating = updateBot({ ...ctx, listModels: () => { entered.resolve(); return catalog.promise; } }, bot.id, { persona: '更新后的档案' });
    await entered.promise;
    ctx.clock.advance(10);
    ctx.store.table('bots').patch(bot.id, { lifecycle: 'paused', pausedFrom: 'active', activity: 'resting', activityText: '已暂停（你暂停的）',
      consecutiveErrors: 2, consecutiveNoCommit: 1, lastThinkAt: ctx.clock.now(), nextThinkAt: null, sessionId: null });
    catalog.resolve([option]);
    const saved = await updating;
    expect(saved).toMatchObject({ persona: '更新后的档案', lifecycle: 'paused', pausedFrom: 'active', activity: 'resting',
      activityText: '已暂停（你暂停的）', consecutiveErrors: 2, consecutiveNoCommit: 1, lastThinkAt: ctx.clock.now(), sessionId: null });
  });

  it('目录等待期间退役后拒绝写入，保留退役档案', async () => {
    const { ctx, bot } = toolFixture();
    ctx.store.table('bots').patch(bot.id, { model: choice });
    const entered = deferred<void>(), catalog = deferred<typeof option[]>();
    const updating = updateBot({ ...ctx, listModels: () => { entered.resolve(); return catalog.promise; } }, bot.id, { persona: '不该写入' });
    await entered.promise;
    await setLifecycle(ctx, bot.id, 'retired');
    const retired = ctx.store.table('bots').get(bot.id);
    catalog.resolve([option]);
    await expect(updating).rejects.toThrow('退役机器人不能再修改档案');
    expect(ctx.store.table('bots').get(bot.id)).toEqual(retired);
  });

  it.each(['name', 'role'] as const)('目录等待后重新检查 %s 约束，冲突不覆盖档案', async field => {
    const { ctx, bot, peer } = toolFixture();
    ctx.store.table('bots').patch(bot.id, { model: choice });
    const entered = deferred<void>(), catalog = deferred<typeof option[]>();
    const patch = field === 'name' ? { name: '待选名称' } : { role: 'chief' };
    const updating = updateBot({ ...ctx, listModels: () => { entered.resolve(); return catalog.promise; } }, bot.id, patch);
    await entered.promise;
    ctx.store.table('bots').patch(peer.id, field === 'name' ? { name: '待选名称' } : { role: 'chief' });
    const original = ctx.store.table('bots').get(bot.id);
    catalog.resolve([option]);
    await expect(updating).rejects.toThrow(field === 'name' ? '已有同名机器人' : '总管最多');
    expect(ctx.store.table('bots').get(bot.id)).toEqual(original);
  });
});

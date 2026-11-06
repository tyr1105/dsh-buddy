/** 在 Promise 已结算但 await 尚未恢复的精确间隙打断，防止只测长时间挂起而漏掉迟到成功竞态。 */
import { expect, it, vi } from 'vitest';
import { createDispatcher } from '../src/engine/dispatch.js';
import { interruptWake } from '../src/turn/interrupt.js';
import { createHub } from '../src/engine/hub.js';
import { apiFixture, okData } from './c04-api-fixtures.js';
import { createTestContext } from '../src/io/testing/create-test-context.js';

/** 手动结算点可安排微任务顺序，无需借助真实时钟。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

it.each(['sessionInfo', 'createSession', 'deliver'] as const)('M07 %s 已结算的迟到 continuation 不复活主人取消的回合', async method => {
  const { ctx, bot } = await apiFixture();
  if (method !== 'createSession') {
    ctx.store.table('bots').patch(bot.id, { sessionId: 'old-session', sessionStartedAt: ctx.clock.now() });
    ctx.host.sessions.set('old-session', { exists: true, running: false, contextRatio: null });
  }
  const called = deferred<void>(), blocked = deferred<never>();
  vi.spyOn(ctx.host, method).mockImplementationOnce(() => { called.resolve(); return blocked.promise; });
  const dispatcher = createDispatcher(ctx);
  const pumping = dispatcher.pump();
  await called.promise;
  const wake = ctx.store.table('wakes').list()[0]!;
  blocked.resolve((method === 'createSession' ? { sessionId: 'created-before-cancel' }
    : method === 'sessionInfo' ? { exists: true, running: false, contextRatio: null } : undefined) as never);
  // race 的成功分支已排入微任务，但它后面的 await continuation 尚未执行。
  await Promise.resolve();
  interruptWake(ctx, wake.id, ctx.clock.now());
  await pumping;
  expect(ctx.store.table('wakes').get(wake.id)).toMatchObject({ status: 'canceled', canceledBy: 'owner', error: null });
  expect(ctx.store.table('bots').get(bot.id)).toMatchObject({ sessionId: null, activity: 'watching', consecutiveErrors: 0 });
  if (method === 'createSession') {
    expect(ctx.store.table('wakes').get(wake.id)?.sessionId).toBe('created-before-cancel');
    expect(ctx.host.calls.filter(call => call.method === 'cancel')).toEqual([{ method: 'cancel', args: ['created-before-cancel'] }]);
  } else if (method === 'sessionInfo') expect(ctx.host.calls.filter(call => call.method === 'deliver')).toEqual([]);
});

it('M07 ended 在保护文件核对期间被打断，不得再写 syntheticCommit 或未交账', async () => {
  const ctx = createTestContext();
  const hub = createHub(ctx); await hub.start();
  const bot = okData(await hub.api.createBot({ name: '并发收尾', role: 'researcher', persona: '核实', aspirations: ['观察公开变化'] }));
  const wake = ctx.store.table('wakes').list()[0]!;
  const called = deferred<void>(), blocked = deferred<string | null>();
  const read = ctx.fs.readText.bind(ctx.fs);
  vi.spyOn(ctx.fs, 'readText').mockImplementationOnce(async path => { called.resolve(); await blocked.promise; return read(path); });
  const ending = hub.onTurnEvent({ type: 'ended', sessionId: wake.sessionId!, at: ctx.clock.now(), finalText: '结束', tokens: 2 });
  await called.promise;
  const interrupted = hub.api.interruptBot({ botId: bot.id });
  await Promise.resolve();
  await Promise.resolve();
  expect(ctx.store.table('wakes').get(wake.id)?.status).toBe('canceled');
  blocked.resolve(null);
  await ending; await interrupted;
  expect(ctx.store.table('wakes').get(wake.id)).toMatchObject({ status: 'canceled', canceledBy: 'owner', error: null });
  expect(ctx.store.table('wakes').get(wake.id)?.syntheticCommit).toBeUndefined();
  expect(ctx.store.table('commits').count()).toBe(0);
  expect(ctx.store.table('bots').get(bot.id)).toMatchObject({ consecutiveNoCommit: 0, consecutiveErrors: 0 });
});

it('M07 创建会话绑定前到来的 interrupted 排队等待身份，不被未知 session 静默丢弃', async () => {
  const ctx = createTestContext();
  const hub = createHub(ctx); await hub.start();
  const called = deferred<void>(), blocked = deferred<{ sessionId: string }>();
  vi.spyOn(ctx.host, 'createSession').mockImplementationOnce(() => { called.resolve(); return blocked.promise; });
  const creation = hub.api.createBot({ name: '提前事件', role: 'researcher', persona: '核实', aspirations: ['观察公开变化'] });
  await called.promise;
  const interrupted = hub.onTurnEvent({ type: 'interrupted', sessionId: 'just-created', at: ctx.clock.now(), by: 'owner' });
  blocked.resolve({ sessionId: 'just-created' });
  const bot = okData(await creation);
  await interrupted;
  expect(ctx.store.table('wakes').list()[0]).toMatchObject({ sessionId: 'just-created', status: 'canceled', canceledBy: 'owner' });
  expect(ctx.store.table('bots').get(bot.id)).toMatchObject({ consecutiveNoCommit: 0, consecutiveErrors: 0, activity: 'watching' });
});

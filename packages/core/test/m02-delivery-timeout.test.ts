/** 真实未决宿主 Promise 的故障注入：超时必须解除串行入口，迟到结果不能复活唤醒单或污染重试。 */
import { expect, it, vi } from 'vitest';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { createHub } from '../src/engine/hub.js';
import { createBotHome } from '../src/memory/files.js';
import { botFixture } from './model-fixtures.js';

/** 人工完成点只用 Promise，不依赖墙钟，让悬挂与迟到两个阶段可独立断言。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

it.each(['createSession', 'sessionInfo', 'deliver'] as const)(
  'M02 [17] %s 真正悬挂时两分钟后解除队列，迟到结果不复活且重试能运行', async method => {
    const ctx = createTestContext();
    const now = ctx.clock.now();
    const bot = { ...botFixture, sessionId: method === 'createSession' ? null : 'old-session', sessionStartedAt: now };
    ctx.store.table('bots').put(bot); await createBotHome(ctx, bot);
    if (bot.sessionId) ctx.host.sessions.set(bot.sessionId, { exists: true, running: false, contextRatio: 0 });
    const hub = createHub(ctx); await hub.start();
    const called = deferred<void>();
    const blocked = deferred<never>();
    // 只挂起一次，下一次调用恢复正常，验证失败机器人可以继续真实调度。
    const spy = vi.spyOn(ctx.host, method).mockImplementationOnce(() => { called.resolve(); return blocked.promise; });
    const sending = hub.api.sendMessage(bot.id, '核对一次公开资料');
    await called.promise;
    const wake = ctx.store.table('wakes').list()[0]!;
    expect(wake.status).toBe('delivering');
    ctx.clock.advance(ctx.settings.c02.deliveryTimeoutMs);
    const boundaryTick = hub.tick();
    await Promise.resolve();
    expect(ctx.store.table('wakes').get(wake.id)?.status).toBe('delivering');
    ctx.clock.advance(1);
    await hub.tick(); // 即使前一个 tick 正排队，也先释放超时等待。
    await sending; await boundaryTick;
    expect(ctx.store.table('wakes').get(wake.id)).toMatchObject({ status: 'error', dispatchedAt: null,
      endedAt: ctx.clock.now(), error: '投递超过两分钟仍未收到开始事件' });
    expect(ctx.store.log('ledger').all()).toHaveLength(0);
    const failedBot = ctx.store.table('bots').get(bot.id)!;
    expect(failedBot).toMatchObject({ sessionId: null, consecutiveErrors: 1, retryAt: expect.any(Number) });
    expect(ctx.store.table('queue').count()).toBe(1);
    // 迟到的创建结果只被取消，deliver/sessionInfo 的迟到完成不会继续写 running。
    blocked.resolve((method === 'createSession' ? { sessionId: 'late-session' }
      : method === 'sessionInfo' ? { exists: true, running: false, contextRatio: 0 } : undefined) as never);
    await Promise.resolve(); await Promise.resolve();
    expect(ctx.store.table('bots').get(bot.id)?.sessionId).toBeNull();
    expect(ctx.store.table('wakes').get(wake.id)?.status).toBe('error');
    if (method === 'createSession') expect(ctx.host.calls).toContainEqual({ method: 'cancel', args: ['late-session'] });
    else expect(ctx.host.calls).toContainEqual({ method: 'cancel', args: ['old-session'] });
    spy.mockRestore();
    ctx.clock.set(failedBot.retryAt!);
    await hub.tick();
    expect(ctx.store.table('wakes').list(w => w.status === 'running')).toHaveLength(1);
    expect(ctx.store.table('bots').get(bot.id)?.sessionId).not.toBe('late-session');
  });

it('M02 [17] tick 自己发起的投递悬挂，也能由重叠 tick 释放并发', async () => {
  const ctx = createTestContext();
  const bot = { ...botFixture, lightCheckAt: ctx.clock.now() };
  ctx.store.table('bots').put(bot); await createBotHome(ctx, bot);
  const hub = createHub(ctx); await hub.start();
  ctx.clock.advance(ctx.settings.startupQuietMs);
  const called = deferred<void>();
  vi.spyOn(ctx.host, 'createSession').mockImplementationOnce(() => { called.resolve(); return new Promise(() => undefined); });
  const first = hub.tick(); await called.promise;
  ctx.clock.advance(ctx.settings.c02.deliveryTimeoutMs + 1);
  await hub.tick(); await first;
  expect(ctx.store.table('wakes').list()).toEqual([expect.objectContaining({ status: 'error', dispatchedAt: null })]);
  expect(ctx.store.table('bots').get(bot.id)?.retryAt).toBeGreaterThan(ctx.clock.now());
  expect(ctx.store.log('ledger').all()).toHaveLength(0);
});

/** 主人打断覆盖真实 Hub、同步取消回调与未决投递，证明不是靠假宿主不发结束事件才通过。 */
import { describe, expect, it, vi } from 'vitest';
import { createHub, TurnEventSchema, type HostPort } from '../src/index.js';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { okData } from './c04-api-fixtures.js';
import { commitArgs } from './c03-turn-fixtures.js';
import { getQuotaState } from '../src/quota/window.js';
import { createDispatcher } from '../src/engine/dispatch.js';

/** 用可控 Promise 精确停在投递阶段，不依赖真实定时器。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
/** 建立一轮正在执行的真实中心；保留内存宿主以注入其真实结束回调。 */
async function fixture() {
  const ctx = createTestContext();
  const hub = createHub(ctx);
  await hub.start();
  const bot = okData(await hub.api.createBot({ name: '中断测试', role: 'researcher', persona: '认真核实', aspirations: ['观察公开变化'] }));
  const current = () => ctx.store.table('wakes').list(w => w.endedAt === null)[0]!;
  return { ctx, hub, bot, current };
}

describe('M07 主人打断', () => {
  it.each(['owner', 'system'] as const)('取消额度探针时只为主人打断归还许可，不把其他取消伪装成无故障：%s', async source => {
    const { ctx, hub, bot, current } = await fixture();
    const wake = current(), now = ctx.clock.now();
    ctx.store.table('quota').put({ ...getQuotaState(ctx, now), light: 'red', redUntil: now,
      tokenLimit: 1, botTokens: 2, probeAllowed: false, probeInFlight: true, probeWakeId: wake.id });
    if (source === 'owner') {
      expect(await hub.api.interruptBot({ botId: bot.id })).toMatchObject({ ok: true });
      expect(ctx.store.table('bots').get(bot.id)).toMatchObject({ activity: 'watching', consecutiveErrors: 0 });
    } else {
      ctx.store.table('wakes').patch(wake.id, { status: 'canceled', endedAt: now });
      createDispatcher(ctx).finishProbe();
    }
    expect(ctx.store.table('quota').get('quota')).toMatchObject({ light: 'red', probeInFlight: false, probeWakeId: null,
      probeAllowed: source === 'owner', redUntil: source === 'owner' ? now : now + ctx.settings.quotaWindowMs + ctx.settings.quotaResetGraceMs });
    expect(ctx.store.table('wakes').count()).toBe(1);
  });

  it('连续打断五轮，取消前先落 canceled；随后 ended/error 无效，下一消息仍是普通回合', async () => {
    const { ctx, hub, bot, current } = await fixture();
    const originalCancel = ctx.host.cancel.bind(ctx.host);
    vi.spyOn(ctx.host, 'cancel').mockImplementation(async sessionId => {
      expect(ctx.store.table('wakes').list(w => w.sessionId === sessionId).at(-1))
        .toMatchObject({ status: 'canceled', canceledBy: 'owner', error: null });
      await originalCancel(sessionId);
      await hub.onTurnEvent({ type: 'ended', sessionId, at: ctx.clock.now(), finalText: '取消结束', tokens: 12 });
      await hub.onTurnEvent({ type: 'error', sessionId, at: ctx.clock.now(), errorText: '取消后回调' });
    });
    const oldSessions: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const wake = current(); oldSessions.push(wake.sessionId!);
      expect(await hub.api.interruptBot({ botId: bot.id })).toMatchObject({ ok: true, data: { status: 'canceled', canceledBy: 'owner' } });
      expect(ctx.store.table('bots').get(bot.id)).toMatchObject({ consecutiveNoCommit: 0, consecutiveErrors: 0,
        lifecycle: 'probation', activity: 'watching', retryAt: null });
      expect(ctx.store.table('commits').count()).toBe(0);
      ctx.clock.advance(1);
      expect(await hub.api.sendMessage(bot.id, `继续第 ${i + 1} 件事`)).toMatchObject({ ok: true });
      expect(current()).toMatchObject({ status: 'running', variant: 'regular', reason: { kind: 'owner_message' } });
      expect(current().sessionId).not.toBe(wake.sessionId);
      // 下一轮已运行后，旧会话再发带更新时刻的错误也不能误伤新回合。
      for (const sessionId of oldSessions) await hub.onTurnEvent({ type: 'error', sessionId, at: ctx.clock.now(), errorText: '迟到旧错误' });
      expect(current().status).toBe('running');
    }
    expect(ctx.store.log('thread').all().filter(m => m.kind === 'system' && m.text === '你打断了它；它会在下次醒来时接着处理')).toHaveLength(5);
    expect(ctx.store.table('alerts').list(a => a.status === 'open')).toEqual([]);
    expect(ctx.store.log('ledger').all().filter(row => row.kind === 'turn')).toHaveLength(5);
    expect(ctx.store.table('wakes').list(w => w.status === 'canceled')).toHaveLength(5);
  });

  it('只恢复本轮消费的感知，打断后不自发重启或报掉线，下次唤醒包带回并再次消费', async () => {
    const { ctx, hub, bot } = await fixture();
    await hub.api.interruptBot({ botId: bot.id });
    await hub.api.sendMessage(bot.id, '尚未完成的原始任务');
    const wake = ctx.store.table('wakes').list(w => w.status === 'running')[0]!;
    const percept = ctx.store.table('percepts').list(p => p.consumedByWake === wake.id)[0]!;
    expect(percept).toBeDefined();
    await hub.api.interruptBot({ botId: bot.id });
    expect(ctx.store.table('percepts').get(percept.id)).toMatchObject({ consumedByWake: null, deferredByOwner: true });
    const count = ctx.store.table('wakes').count();
    for (let i = 0; i < 40; i += 1) { ctx.clock.advance(ctx.settings.tickMs); await hub.tick(); }
    expect(ctx.store.table('wakes').count()).toBe(count);
    expect(ctx.store.table('alerts').list(a => a.code === 'deadman')).toEqual([]);
    await hub.api.sendMessage(bot.id, '现在继续处理');
    const next = ctx.store.table('wakes').list(w => w.status === 'running')[0]!;
    expect(next.reason.evidence).toContain(percept.id);
    expect(ctx.store.table('percepts').get(percept.id)?.consumedByWake).toBe(next.id);
    expect((ctx.host.calls.filter(call => call.method === 'createSession').at(-1)!.args[0] as Parameters<HostPort['createSession']>[0]).firstMessage)
      .toContain('尚未完成的原始任务');
  });

  it('宿主 interrupted 事件无需额外 cancel，重复及晚到终态不重复写消息或账本', async () => {
    const { ctx, hub, bot, current } = await fixture();
    const wake = current();
    const event = { type: 'interrupted' as const, sessionId: wake.sessionId!, at: ctx.clock.now(), by: 'owner' as const };
    await hub.onTurnEvent(event); await hub.onTurnEvent(event);
    await hub.onTurnEvent({ type: 'ended', sessionId: wake.sessionId!, at: ctx.clock.now(), finalText: '', tokens: null });
    expect(ctx.store.table('wakes').get(wake.id)).toMatchObject({ status: 'canceled', canceledBy: 'owner' });
    expect(ctx.store.log('ledger').all().filter(row => row.wakeId === wake.id)).toHaveLength(1);
    expect(ctx.host.calls.filter(call => call.method === 'cancel')).toHaveLength(0);
    expect(ctx.store.table('bots').get(bot.id)).toMatchObject({ activity: 'watching', consecutiveNoCommit: 0, consecutiveErrors: 0 });
  });

  it.each(['createSession', 'sessionInfo', 'deliver'] as const)('可以打断真正挂起的 %s，迟到成功不能复活回合', async method => {
    const { ctx, hub, bot, current } = await fixture();
    const original = current();
    // 正常完成试跑并将宿主状态置闲，下一条消息就会走复用投递。
    expect(await hub.tools().find(t => t.name === 'hub_commit')!.handler(original.sessionId!, commitArgs({ reply: '试跑完成' }))).toMatchObject({ ok: true });
    await hub.onTurnEvent({ type: 'ended', sessionId: original.sessionId!, at: ctx.clock.now(), finalText: '', tokens: 1 });
    ctx.host.sessions.get(original.sessionId!)!.running = false;
    if (method === 'createSession') ctx.store.table('bots').patch(bot.id, { sessionId: null, sessionStartedAt: null });
    const called = deferred<void>(), blocked = deferred<never>();
    const spy = vi.spyOn(ctx.host, method).mockImplementationOnce(() => { called.resolve(); return blocked.promise; });
    const sending = hub.api.sendMessage(bot.id, '投递时取消这条');
    await called.promise;
    const wake = current();
    expect(wake.status).toBe('delivering');
    expect(await hub.api.interruptBot({ botId: bot.id })).toMatchObject({ ok: true });
    await sending;
    expect(ctx.store.table('wakes').get(wake.id)).toMatchObject({ status: 'canceled', canceledBy: 'owner', error: null });
    expect(ctx.store.table('bots').get(bot.id)).toMatchObject({ consecutiveNoCommit: 0, consecutiveErrors: 0, retryAt: null, activity: 'watching' });
    expect(ctx.store.log('ledger').all().filter(row => row.wakeId === wake.id)).toHaveLength(0);
    blocked.resolve((method === 'createSession' ? { sessionId: 'late-created' }
      : method === 'sessionInfo' ? { exists: true, running: false, contextRatio: null } : undefined) as never);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(ctx.store.table('wakes').get(wake.id)?.status).toBe('canceled');
    expect(ctx.store.table('bots').get(bot.id)?.sessionId).toBeNull();
    if (method === 'createSession') expect(ctx.host.calls).toContainEqual({ method: 'cancel', args: ['late-created'] });
    spy.mockRestore();
    await hub.api.sendMessage(bot.id, '继续正常处理');
    expect(current()).toMatchObject({ status: 'running', variant: 'regular' });
  });

  it('无在途回合、已交账和非法参数明确失败，不取消其他工作', async () => {
    const { ctx, hub, bot, current } = await fixture();
    const wake = current();
    expect(await hub.api.interruptBot({ botId: bot.id, extra: true })).toMatchObject({ ok: false });
    expect(TurnEventSchema.safeParse({ type: 'interrupted', sessionId: wake.sessionId, at: ctx.clock.now(), by: 'bot' }).success).toBe(false);
    expect(await hub.tools().find(t => t.name === 'hub_commit')!.handler(wake.sessionId!, commitArgs({ reply: '完成了' }))).toMatchObject({ ok: true });
    expect(await hub.api.interruptBot({ botId: bot.id })).toEqual({ ok: false, error: '它现在没在处理事情' });
    await hub.onTurnEvent({ type: 'ended', sessionId: wake.sessionId!, at: ctx.clock.now(), finalText: '', tokens: 1 });
    expect(await hub.api.interruptBot({ botId: bot.id })).toEqual({ ok: false, error: '它现在没在处理事情' });
    expect(ctx.host.calls.filter(call => call.method === 'cancel')).toEqual([]);
  });

  it('宿主取消失败也保留主人取消事实，晚到错误不惩罚机器人', async () => {
    const { ctx, hub, bot, current } = await fixture();
    const wake = current();
    vi.spyOn(ctx.host, 'cancel').mockRejectedValueOnce(new Error('宿主连接中断'));
    expect(await hub.api.interruptBot({ botId: bot.id })).toMatchObject({ ok: false, error: expect.stringContaining('已记录主人打断，但宿主取消失败') });
    await hub.onTurnEvent({ type: 'error', sessionId: wake.sessionId!, at: ctx.clock.now(), errorText: '迟到故障' });
    expect(ctx.store.table('wakes').get(wake.id)).toMatchObject({ status: 'canceled', canceledBy: 'owner' });
    expect(ctx.store.table('bots').get(bot.id)).toMatchObject({ consecutiveErrors: 0, consecutiveNoCommit: 0 });
  });
});

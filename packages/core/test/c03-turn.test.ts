/** 回合守卫用假时钟核对收口、取消、未交账与计量，明确区分宿主结束和模型交账两个事件。 */
import { describe, expect, test } from 'vitest';
import { onTurnEvent, finishTurn } from '../src/turn/events.js';
import { checkTurnLimits, CLOSING_MESSAGE } from '../src/turn/limits.js';
import { createTicket } from '../src/wake/ticket.js';
import { processCommit } from '../src/commit/process.js';
import { turnContext, commitArgs } from './c03-turn-fixtures.js';
import { botUsageToday } from '../src/quota/usage.js';

describe('回合事件与限额', () => {
  test('started 和 step 更新累计步数和已知 token', async () => {
    const { ctx, ticket, bot } = await turnContext();
    ctx.store.table('wakes').patch(ticket.id, { status: 'delivering', dispatchedAt: null });
    await onTurnEvent(ctx, { type: 'started', sessionId: bot.sessionId!, at: ctx.clock.now() });
    await onTurnEvent(ctx, { type: 'step', sessionId: bot.sessionId!, at: ctx.clock.now(), steps: 3, tokens: 200 });
    expect(ctx.store.table('wakes').get(ticket.id)).toMatchObject({ status: 'running', steps: 3, tokens: 200, tokensKnown: true });
    expect(ctx.store.table('bots').get(bot.id)?.activity).toBe('thinking');
  });
  test('累计数据不因乱序或较小值倒退', async () => {
    const { ctx, ticket, bot } = await turnContext();
    await onTurnEvent(ctx, { type: 'step', sessionId: bot.sessionId!, at: ctx.clock.now(), steps: 3, tokens: 200 });
    await onTurnEvent(ctx, { type: 'step', sessionId: bot.sessionId!, at: ctx.clock.now(), steps: 1, tokens: 100 });
    expect(ctx.store.table('wakes').get(ticket.id)).toMatchObject({ steps: 3, tokens: 200 });
  });
  test.each(['steps', 'tokens', 'time'] as const)('%s 到上限只 steer 一次，三分钟后 cancel', async kind => {
    const { ctx, ticket } = await turnContext();
    if (kind === 'time') ctx.clock.advance(ctx.settings.turnLimitsByVariant.regular.durationMs);
    else ctx.store.table('wakes').patch(ticket.id, { [kind]: ctx.settings.turnLimitsByVariant.regular[kind] });
    await checkTurnLimits(ctx, ctx.clock.now()); await checkTurnLimits(ctx, ctx.clock.now());
    expect(ctx.host.calls.filter(c => c.method === 'steer')).toEqual([{ method: 'steer', args: ['session-one', CLOSING_MESSAGE] }]);
    ctx.clock.advance(ctx.settings.closingGraceMs - 1); await checkTurnLimits(ctx, ctx.clock.now());
    expect(ctx.host.calls.some(c => c.method === 'cancel')).toBe(false);
    ctx.clock.advance(1); await checkTurnLimits(ctx, ctx.clock.now());
    expect(ctx.store.table('wakes').get(ticket.id)?.status).toBe('timeout');
    expect(ctx.host.calls.filter(c => c.method === 'cancel')).toHaveLength(1);
  });
  test('未到任何上限不会收口', async () => {
    const { ctx } = await turnContext(); await checkTurnLimits(ctx, ctx.clock.now());
    expect(ctx.host.calls).toHaveLength(0);
  });
  test('轻复查第五步即收口', async () => {
    const { ctx, ticket } = await turnContext('light_check');
    ctx.store.table('wakes').patch(ticket.id, { steps: 5 }); await checkTurnLimits(ctx, ctx.clock.now());
    expect(ctx.host.calls[0]?.method).toBe('steer');
  });
  test('主人发起回合使用40步上限', async () => {
    const { ctx, ticket } = await turnContext();
    ctx.store.table('wakes').patch(ticket.id, { steps: 30, ownerInitiated: true }); await checkTurnLimits(ctx, ctx.clock.now());
    expect(ctx.host.calls).toHaveLength(0);
    ctx.store.table('wakes').patch(ticket.id, { steps: 40 }); await checkTurnLimits(ctx, ctx.clock.now());
    expect(ctx.host.calls[0]?.method).toBe('steer');
  });
  test('ended 无交账会合成no_change并递增未交账次数', async () => {
    const { ctx, ticket, bot } = await turnContext();
    await onTurnEvent(ctx, { type: 'ended', sessionId: bot.sessionId!, at: ctx.clock.now(), finalText: '', tokens: 100 });
    expect(ctx.store.table('wakes').get(ticket.id)?.status).toBe('no_commit');
    expect(ctx.store.table('commits').list()[0]).toMatchObject({ outcome: 'no_change', summary: '未交账' });
    expect(ctx.store.table('bots').get(bot.id)).toMatchObject({ consecutiveNoCommit: 1, noChangeStreak: 1 });
    expect(ctx.store.log('ledger').all()[0]?.tokens).toBe(120);
  });
  test('连续两次未交账下次强制复盘，复盘仍未交账隔离', async () => {
    const { ctx, bot, entry } = await turnContext();
    const end = () => onTurnEvent(ctx, { type: 'ended', sessionId: bot.sessionId!, at: ctx.clock.now(), finalText: '', tokens: 10 });
    await end(); ctx.clock.advance(1);
    const second = createTicket(ctx, entry, bot.sessionId); ctx.store.table('wakes').patch(second.id, { status: 'running', dispatchedAt: ctx.clock.now() }); await end();
    expect(ctx.store.table('bots').get(bot.id)?.consecutiveNoCommit).toBe(2);
    ctx.clock.advance(1);
    const third = createTicket(ctx, entry, bot.sessionId); expect(third.variant).toBe('reflection');
    ctx.store.table('wakes').patch(third.id, { status: 'running', dispatchedAt: ctx.clock.now() }); await end();
    expect(ctx.store.table('bots').get(bot.id)?.lifecycle).toBe('quarantined');
  });
  test('成功交账后ended保持committed且重复结束只记一次用量', async () => {
    const { ctx, ticket, bot, toolCtx } = await turnContext();
    await processCommit(ctx, toolCtx, commitArgs());
    const e = { type: 'ended' as const, sessionId: bot.sessionId!, at: ctx.clock.now(), finalText: '', tokens: 100 };
    await onTurnEvent(ctx, e); await onTurnEvent(ctx, e);
    expect(ctx.store.table('wakes').get(ticket.id)?.status).toBe('committed');
    expect(ctx.store.log('ledger').all()).toHaveLength(1);
    expect(ctx.store.table('bots').get(bot.id)?.consecutiveNoCommit).toBe(0);
  });
  test('拿不到token用字节与步数估算，宿主明确0则按0', async () => {
    const { ctx, ticket, bot } = await turnContext();
    ctx.store.table('wakes').patch(ticket.id, { steps: 2, packetBytes: 300 });
    await onTurnEvent(ctx, { type: 'ended', sessionId: bot.sessionId!, at: ctx.clock.now(), finalText: '', tokens: null });
    expect(ctx.store.log('ledger').all()[0]?.tokens).toBe(4920);
  });
  test('owner_direct 交账可选，最终回复进入线程并豁免机器人预算', async () => {
    const { ctx, ticket, bot } = await turnContext(); ctx.store.table('wakes').remove(ticket.id);
    await onTurnEvent(ctx, { type: 'owner_direct', sessionId: bot.sessionId!, at: ctx.clock.now(), text: '帮我看看' });
    expect(ctx.store.table('wakes').list()[0]).toMatchObject({ ownerInitiated: true, status: 'running', variant: 'regular', reason: { kind: 'owner_message' } });
    await onTurnEvent(ctx, { type: 'ended', sessionId: bot.sessionId!, at: ctx.clock.now(), finalText: '看好了', tokens: 0 });
    expect(ctx.store.table('commits').count()).toBe(0);
    expect(ctx.store.table('bots').get(bot.id)).toMatchObject({ activity: 'watching', consecutiveNoCommit: 0 });
    expect(ctx.store.log('thread').all().some(m => m.text === '看好了')).toBe(true);
    expect(botUsageToday(ctx, bot.id, ctx.clock.now()).turns).toBe(0);
  });
  test('awaiting_approval 五分钟后取消并告警', async () => {
    const { ctx, bot, ticket } = await turnContext();
    await onTurnEvent(ctx, { type: 'awaiting_approval', sessionId: bot.sessionId!, at: ctx.clock.now(), tool: 'write', summary: '等待' });
    expect(ctx.store.table('alerts').list()[0]).toMatchObject({ level: 'P1', status: 'open' });
    ctx.clock.advance(5 * 60_000 - 1); await checkTurnLimits(ctx, ctx.clock.now());
    expect(ctx.host.calls.some(c => c.method === 'cancel')).toBe(false);
    ctx.clock.advance(1); await checkTurnLimits(ctx, ctx.clock.now());
    expect(ctx.store.table('wakes').get(ticket.id)?.status).toBe('timeout');
  });
  test.each(['网络失败', '429 quota', '401 unauthorized'])('error 分类：%s', async errorText => {
    const { ctx, bot, ticket } = await turnContext();
    await onTurnEvent(ctx, { type: 'error', sessionId: bot.sessionId!, at: ctx.clock.now(), errorText });
    expect(ctx.store.table('wakes').get(ticket.id)?.status).toBe('error');
    if (errorText.startsWith('429')) expect(ctx.store.table('quota').get('quota')?.light).toBe('red');
    else if (errorText.startsWith('401')) expect(ctx.store.table('alerts').list().some(a => a.code === 'auth')).toBe(true);
    else expect(ctx.store.table('bots').get(bot.id)?.retryAt).toBeGreaterThan(ctx.clock.now());
  });
  test('任何终态恢复篡改文件并记录越界', async () => {
    const { ctx, bot, ticket } = await turnContext();
    const original = await ctx.fs.readText(`${bot.homeDir}/AGENTS.md`);
    await ctx.fs.writeTextAtomic(`${bot.homeDir}/AGENTS.md`, '被改写的身份');
    await finishTurn(ctx, ticket.id, ctx.clock.now(), 'canceled');
    expect(await ctx.fs.readText(`${bot.homeDir}/AGENTS.md`)).toBe(original);
    expect(ctx.store.table('bots').get(bot.id)?.violations).toBe(1);
  });
  test('非机器人事件不产生唤醒单', async () => {
    const { ctx } = await turnContext(); const before = ctx.store.table('wakes').count();
    await onTurnEvent(ctx, { type: 'owner_direct', sessionId: 'other', at: ctx.clock.now(), text: '问好' });
    expect(ctx.store.table('wakes').count()).toBe(before);
  });
  test('宿主steer失败仍可在宽限后取消，异常不抛出', async () => {
    const { ctx, ticket } = await turnContext();
    ctx.host.steer = async () => { throw new Error('宿主暂不可用'); };
    ctx.store.table('wakes').patch(ticket.id, { steps: 30 }); await checkTurnLimits(ctx, ctx.clock.now());
    ctx.clock.advance(ctx.settings.closingGraceMs); await checkTurnLimits(ctx, ctx.clock.now());
    expect(ctx.store.table('wakes').get(ticket.id)?.status).toBe('timeout');
  });
});

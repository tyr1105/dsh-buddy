/** M03 生命周期回归：恢复资格、教学拒绝、名额释放和在途暂停都通过真实 API 与回合入口验证。 */
import { describe, expect, it, vi } from 'vitest';
import { apiFixture, okData } from './c04-api-fixtures.js';
import { commitArgs, turnContext } from './c03-turn-fixtures.js';
import { createUiApi } from '../src/api/index.js';
import { processCommit } from '../src/commit/process.js';
import { onTurnEvent } from '../src/turn/events.js';
import { quarantine } from '../src/health/quarantine.js';
import { syncAlertItems } from '../src/outreach/alerts.js';
import { botBudgetFor } from '../src/config/defaults.js';
import { guardToolCall } from '../src/gate/guard.js';

const DAY = 86_400_000;
const newcomer = { name: '新同事', role: 'researcher', persona: '核实事实', aspirations: ['保留证据'] };

describe('M03 [10][17] 隔离与试岗恢复', () => {
  it.each(['active', 'probation'] as const)('试岗隔离后请求 %s 只恢复 probation，保持 L1 闸与原截止，关闭隔离告警', async requested => {
    const { ctx, api, bot } = await apiFixture();
    await api.updateBot(bot.id, { autonomy: 'L3' });
    ctx.settings.l3Grants = ['write_file'];
    ctx.store.table('bots').patch(bot.id, { sessionId: 'bot-session', violations: 3 });
    quarantine(ctx, bot.id, '越界尝试达到三次');
    await syncAlertItems(ctx);
    expect(ctx.store.table('alerts').list(row => row.code === 'quarantine' && row.status === 'open')).toHaveLength(1);
    expect(ctx.store.table('inbox').list(row => row.type === 'alert' && row.status === 'open')).toHaveLength(1);
    ctx.clock.advance(60_000);
    const restored = okData(await api.setLifecycle(bot.id, requested));
    expect(restored).toMatchObject({ lifecycle: 'probation', probationEndsAt: bot.probationEndsAt, violations: 0, quarantineReason: null });
    expect(botBudgetFor(restored.lifecycle, ctx.settings).dailyTurns).toBe(3);
    expect(await ctx.fs.readText(`${bot.homeDir}/AGENTS.md`)).toContain('L1');
    const verdict = await guardToolCall(ctx, 'bot-session', 'write_file', { path: '/public-note.txt', content: '公开说明' });
    expect(verdict.allow).toBe(false);
    expect(ctx.store.table('approvals').count()).toBe(1);
    expect(ctx.store.table('alerts').list(row => row.code === 'quarantine')).toEqual([expect.objectContaining({ status: 'closed', count: 0 })]);
    expect(ctx.store.table('inbox').list(row => row.type === 'alert')).toEqual([expect.objectContaining({ status: 'closed' })]);
  });
  it.each(['paused', 'quarantined'] as const)('%s 跨过试岗期后恢复上限 L2，主人显式设 L3 仍允许', async lifecycle => {
    const { ctx, api, bot } = await apiFixture();
    await api.updateBot(bot.id, { autonomy: 'L3' });
    if (lifecycle === 'quarantined') quarantine(ctx, bot.id, '测试隔离');
    else okData(await api.setLifecycle(bot.id, 'paused'));
    ctx.clock.advance(8 * DAY);
    expect((await api.setLifecycle(bot.id, 'probation')).ok).toBe(false);
    expect(okData(await api.setLifecycle(bot.id, 'active'))).toMatchObject({ lifecycle: 'active', autonomy: 'L2', probationEndsAt: null });
    expect(okData(await api.updateBot(bot.id, { autonomy: 'L3' })).autonomy).toBe('L3');
  });
  it('提前转正也封顶 L2；已有 active 的 L3 暂停恢复不撤销明确授权', async () => {
    const { ctx, api, bot } = await apiFixture();
    await api.updateBot(bot.id, { autonomy: 'L3' });
    ctx.clock.advance(3 * DAY);
    expect(okData(await api.setLifecycle(bot.id, 'active')).autonomy).toBe('L2');
    okData(await api.updateBot(bot.id, { autonomy: 'L3' }));
    okData(await api.setLifecycle(bot.id, 'paused'));
    expect(okData(await api.setLifecycle(bot.id, 'active')).autonomy).toBe('L3');
  });
});

describe('M03 [7][19] 命令资格和队伍名额', () => {
  it.each(['paused', 'retired', 'quarantined', 'draft'] as const)('%s 教学立即中文拒绝，不读取摘要也不留教学候选', async lifecycle => {
    const { ctx, api, bot } = await apiFixture();
    ctx.store.table('bots').patch(bot.id, { lifecycle });
    for (const row of ctx.store.table('queue').list()) ctx.store.table('queue').remove(row.id);
    const read = vi.spyOn(ctx.host, 'readSessionDigest');
    const result = await api.teach(bot.id, 'lesson', '核实资料');
    expect(result).toEqual({ ok: false, error: '教学：机器人必须在岗或试岗，请先恢复其状态' });
    expect(read).not.toHaveBeenCalled();
    expect(ctx.store.table('queue').count()).toBe(0);
    expect(ctx.store.log('audit').all().filter(row => row.action === 'teach_context')).toHaveLength(0);
  });
  it.each(['active', 'probation'] as const)('%s 教学读取材料并生成 teach 候选', async lifecycle => {
    const { ctx, api, bot } = await apiFixture();
    ctx.store.table('bots').patch(bot.id, { lifecycle });
    for (const row of ctx.store.table('queue').list()) ctx.store.table('queue').remove(row.id);
    ctx.host.digests.set('lesson', '打开原文再比较');
    expect((await api.teach(bot.id, 'lesson', '核实资料')).ok).toBe(true);
    expect(ctx.host.calls.some(row => row.method === 'readSessionDigest')).toBe(true);
    expect(ctx.store.table('queue').list()).toEqual([expect.objectContaining({ variant: 'teach' })]);
  });
  it('退役总管释放总管名额，历史名字仍唯一，未退役总管仍受一个上限', async () => {
    const { ctx, api } = await apiFixture();
    const chief = okData(await api.createBot({ ...newcomer, name: '旧总管', role: 'chief' }));
    expect((await api.createBot({ ...newcomer, role: 'chief' })).ok).toBe(false);
    okData(await api.setLifecycle(chief.id, 'retired'));
    expect((await api.createBot({ ...newcomer, name: '旧总管', role: 'chief' })).ok).toBe(false);
    expect((await api.createBot({ ...newcomer, role: 'chief' })).ok).toBe(true);
    expect((await api.createBot({ ...newcomer, name: '第三总管', role: 'chief' })).ok).toBe(false);
    expect(ctx.store.table('bots').get(chief.id)?.lifecycle).toBe('retired');
    expect((await api.updateSettings({ maxBots: 2, maxChiefs: 1 })).ok).toBe(true);
    expect((await api.updateSettings({ maxBots: 1 })).ok).toBe(false);
  });
});

describe('M03 [18] 回合中的暂停与退役', () => {
  it.each(['paused', 'retired'] as const)('%s 允许真实交账收尾，但文案不恢复关注', async lifecycle => {
    const { ctx, bot, toolCtx, ticket } = await turnContext();
    const api = createUiApi(ctx, async () => ctx.store.flush());
    okData(await api.setLifecycle(bot.id, lifecycle));
    expect(ctx.store.table('bots').get(bot.id)?.activity).toBe('thinking');
    expect((await processCommit(ctx, toolCtx, commitArgs())).ok).toBe(true);
    const activityText = lifecycle === 'paused' ? '已暂停（你暂停的）' : '已退役';
    expect(ctx.store.table('bots').get(bot.id)).toMatchObject({ lifecycle, activity: 'resting', activityText });
    await onTurnEvent(ctx, { type: 'ended', sessionId: bot.sessionId!, at: ctx.clock.now(), tokens: 100, finalText: '' });
    expect(ctx.store.table('wakes').get(ticket.id)?.status).toBe('committed');
    expect(api.overview().bots[0]).toMatchObject({ lifecycle, activity: 'resting', activityText });
  });
  it.each(['ended', 'error'] as const)('暂停后 %s 无交账也恢复暂停文案，不排 retry', async ending => {
    const { ctx, bot, ticket } = await turnContext();
    const api = createUiApi(ctx, async () => ctx.store.flush());
    okData(await api.setLifecycle(bot.id, 'paused'));
    if (ending === 'ended') await onTurnEvent(ctx, { type: 'ended', sessionId: bot.sessionId!, at: ctx.clock.now(), tokens: 100, finalText: '' });
    else await onTurnEvent(ctx, { type: 'error', sessionId: bot.sessionId!, at: ctx.clock.now(), errorText: '执行失败' });
    expect(ctx.store.table('wakes').get(ticket.id)?.status).toBe(ending === 'ended' ? 'no_commit' : 'error');
    expect(api.overview().bots[0]).toMatchObject({ lifecycle: 'paused', activity: 'resting', activityText: '已暂停（你暂停的）' });
    expect(ctx.store.table('queue').list(row => row.reason.kind === 'retry')).toHaveLength(0);
  });
});

/** M03 生命周期回归：恢复资格、教学拒绝、名额释放和在途暂停都通过真实 API 与回合入口验证。 */
import { describe, expect, it, vi } from 'vitest';
import { apiFixture, okData } from './c04-api-fixtures.js';
import { commitArgs, turnContext } from './c03-turn-fixtures.js';
import { createUiApi } from '../src/api/index.js';
import { processCommit } from '../src/commit/process.js';
import { onTurnEvent } from '../src/turn/events.js';
import { quarantine } from '../src/health/quarantine.js';
import { syncAlertItems } from '../src/outreach/alerts.js';
import { botCard } from '../src/api/summary-views.js';
import { guardToolCall } from '../src/gate/guard.js';

const DAY = 86_400_000;
const newcomer = { name: '新同事', role: 'researcher', persona: '核实事实', aspirations: ['保留证据'] };

describe('M03 [10][17] 隔离与试岗恢复', () => {
  it.each(['active', 'probation'] as const)('隔离后请求 %s 恢复到在岗，保持 L1 闸，关闭隔离告警', async requested => {
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
    // P73a（5.1 第 2 类）：原预期恢复到 probation、保留原试岗截止、预算减半（3）；新预期恢复到 active、截止为空、预算 6（不再减半）。
    expect(restored).toMatchObject({ lifecycle: 'active', probationEndsAt: null, violations: 0, quarantineReason: null });
    // P76c：botBudgetFor 已删除（试岗减半取消），每天上限只剩设置里的一个数；原断言「恢复后预算 6、不减半」改为：
    // 恢复后员工卡上的每天上限就是设置里的完整值（默认 2，没有被减半成 1）。
    expect(ctx.settings.botDailyTurnBudget).toBe(2);
    expect(botCard(ctx, ctx.store.table('bots').get(bot.id)!).todayBudget).toBe(ctx.settings.botDailyTurnBudget);
    expect(await ctx.fs.readText(`${bot.homeDir}/AGENTS.md`)).toContain('L1');
    const verdict = await guardToolCall(ctx, 'bot-session', 'write_file', { path: '/public-note.txt', content: '公开说明' });
    expect(verdict.allow).toBe(false);
    expect(ctx.store.table('approvals').count()).toBe(1);
    expect(ctx.store.table('alerts').list(row => row.code === 'quarantine')).toEqual([expect.objectContaining({ status: 'closed', count: 0 })]);
    expect(ctx.store.table('inbox').list(row => row.type === 'alert')).toEqual([expect.objectContaining({ status: 'closed' })]);
  });
  it.each(['paused', 'quarantined'] as const)('%s 跨过多日后恢复一律回到在岗；执行类的 L3 授权被忽略', async lifecycle => {
    // P73a（5.1 第 2 类）：原预期恢复到 probation 被拒、恢复 active 封顶 L2、主人再设 L3 生效；
    // 新预期没有试岗：请求 probation 也恢复到在岗；执行类固定听吩咐，传入 L3 被忽略，授权保持 L1。
    const { ctx, api, bot } = await apiFixture();
    await api.updateBot(bot.id, { autonomy: 'L3' });
    if (lifecycle === 'quarantined') quarantine(ctx, bot.id, '测试隔离');
    else okData(await api.setLifecycle(bot.id, 'paused'));
    ctx.clock.advance(8 * DAY);
    expect(okData(await api.setLifecycle(bot.id, 'probation'))).toMatchObject({ lifecycle: 'active', autonomy: 'L1', probationEndsAt: null });
    expect(okData(await api.updateBot(bot.id, { autonomy: 'L3' })).autonomy).toBe('L1');
  });
  it('旧试岗档案转在岗仍封顶 L2；已有 active 的 L3 暂停恢复不撤销明确授权', async () => {
    // P73a：执行类的 L3 只能来自旧数据，这里直接改档案模拟旧档案；规则本身（转正封顶 L2、恢复不撤销 L3）不变。
    const { ctx, api, bot } = await apiFixture();
    ctx.store.table('bots').patch(bot.id, { lifecycle: 'probation', autonomy: 'L3', probationEndsAt: ctx.clock.now() + 7 * DAY });
    expect(okData(await api.setLifecycle(bot.id, 'active')).autonomy).toBe('L2');
    ctx.store.table('bots').patch(bot.id, { autonomy: 'L3' });
    okData(await api.setLifecycle(bot.id, 'paused'));
    expect(okData(await api.setLifecycle(bot.id, 'active')).autonomy).toBe('L3');
  });
});

describe('M03 [7][19] 命令资格和队伍名额', () => {
  // P75f：UiApi teach 已删除，「%s 教学立即中文拒绝」「%s 教学读取材料并生成 teach 候选」两组测试随之删除（宿主停用说明由插件 real-hub 测试覆盖）。
  it('退役总管释放总管名额，历史名字仍唯一，未退役总管仍受一个上限', async () => {
    const { ctx, api } = await apiFixture();
    const chief = okData(await api.createBot({ ...newcomer, name: '旧总管', role: 'chief' }));
    expect((await api.createBot({ ...newcomer, role: 'chief' })).ok).toBe(false);
    // P73r1（R2）：总管不能经命令退役（等同归档，总管不能归档）；本用例测名额与重名规则，改为直接写成旧数据。
    expect((await api.setLifecycle(chief.id, 'retired')).ok).toBe(false);
    ctx.store.table('bots').patch(chief.id, { lifecycle: 'retired' });
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
    // P73a（5.1 第 3 类）：原预期「已暂停（你暂停的）」「已退役」；新预期「已停用（你停用的）」「已归档」。
    const activityText = lifecycle === 'paused' ? '已停用（你停用的）' : '已归档';
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
    // P73a（5.1 第 3 类）：原预期文字「已暂停（你暂停的）」；新预期「已停用（你停用的）」。
    expect(api.overview().bots[0]).toMatchObject({ lifecycle: 'paused', activity: 'resting', activityText: '已停用（你停用的）' });
    expect(ctx.store.table('queue').list(row => row.reason.kind === 'retry')).toHaveLength(0);
  });
});

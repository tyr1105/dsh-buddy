/** 交账集成测试验证真实存储、线程、收件箱和文件变化，不把单纯返回成功当作完成。 */
import { describe, expect, test } from 'vitest';
import { processCommit } from '../src/commit/process.js';
import { buildSnapshot } from '../src/scheduler/snapshot.js';
import { turnContext, commitArgs } from './c03-turn-fixtures.js';
import { goalFixture } from './model-fixtures.js';

describe('交账处理', () => {
  test.each(['no_change', 'progress', 'done', 'blocked', 'needs_owner'] as const)('%s 更新自己的状态', async outcome => {
    const { ctx, bot, toolCtx, ticket } = await turnContext('regular', { noChangeStreak: 2 });
    ctx.store.table('goals').put(goalFixture);
    const result = await processCommit(ctx, toolCtx, commitArgs({ outcome, blocker: outcome === 'blocked' ? '资料缺失' : null,
      ownerQuestion: outcome === 'needs_owner' ? { text: '哪条路线', options: ['甲', '乙'], defaultOption: '甲', whyNeeded: '需要选择' } : null }));
    expect(result.ok).toBe(true);
    const current = ctx.store.table('bots').get(bot.id)!;
    expect(current.noChangeStreak).toBe(outcome === 'no_change' ? 3 : outcome === 'progress' || outcome === 'done' ? 0 : 2);
    expect(current.activity).toBe(outcome === 'needs_owner' ? 'waiting_owner' : outcome === 'blocked' ? 'blocked' : 'watching');
    expect(current.lastThinkAt).toBe(ctx.clock.now());
    expect(ctx.store.table('wakes').get(ticket.id)?.status).toBe('committed');
    expect(ctx.store.table('goals').get(goalFixture.id)?.status).toBe(outcome === 'done' ? 'done_pending_check' : 'active');
    expect(await ctx.fs.readText(`${bot.homeDir}/memory/journal/2026-11-05.md`)).toContain(outcome);
  });
  test('已交账仍占宿主并发直到 ended', async () => {
    const { ctx, toolCtx, bot } = await turnContext();
    await processCommit(ctx, toolCtx, commitArgs());
    expect(buildSnapshot(ctx, bot.id, ctx.clock.now()).running).toBe(true);
  });
  test('重复与并发交账不重复生成记录', async () => {
    const { ctx, toolCtx } = await turnContext();
    const results = await Promise.all([processCommit(ctx, toolCtx, commitArgs()), processCommit(ctx, toolCtx, commitArgs())]);
    expect(results.filter(r => r.ok)).toHaveLength(1);
    expect(results.find(r => !r.ok)).toEqual({ ok: false, error: '本轮已交账' });
    expect(ctx.store.table('commits').count()).toBe(1);
  });
  test('主人消息缺回复拒绝，有回复入线程', async () => {
    const { ctx, ticket, toolCtx } = await turnContext();
    ctx.store.table('wakes').patch(ticket.id, { reason: { ...ticket.reason, kind: 'owner_message' }, ownerInitiated: true });
    const denied = await processCommit(ctx, toolCtx, commitArgs());
    expect(denied.ok).toBe(false); if (!denied.ok) expect(denied.error).toContain('reply');
    expect((await processCommit(ctx, toolCtx, commitArgs({ reply: '已经核实' }))).ok).toBe(true);
    expect(ctx.store.log('thread').all().some(m => m.kind === 'reply' && m.text === '已经核实')).toBe(true);
  });
  test('没有唤醒单的直聊允许交账并计为主人发起', async () => {
    const { ctx, ticket, toolCtx } = await turnContext();
    ctx.store.table('wakes').remove(ticket.id);
    expect((await processCommit(ctx, { ...toolCtx, wakeId: null }, commitArgs())).ok).toBe(true);
    expect(ctx.store.table('wakes').list()[0]).toMatchObject({ ownerInitiated: true, ownerDirect: true, reason: { kind: 'owner_message' } });
  });
  test.each(['wake', 'session', 'ended'] as const)('无效 %s 上下文不能交账', async field => {
    const { ctx, ticket, toolCtx } = await turnContext();
    if (field === 'ended') ctx.store.table('wakes').patch(ticket.id, { status: 'timeout', endedAt: ctx.clock.now() });
    const result = await processCommit(ctx, { ...toolCtx, ...(field === 'wake' ? { wakeId: 'w_unknown' } : field === 'session' ? { sessionId: 'other' } : {}) }, commitArgs());
    expect(result.ok).toBe(false); expect(ctx.store.table('commits').count()).toBe(0);
  });
  test('汇报提问提议各自路由，低分提议进点子池', async () => {
    const { ctx, toolCtx } = await turnContext();
    const args = commitArgs({ reply: '回答', report: '重要汇报', importance: 9,
      ownerQuestion: { text: '批准路线', options: ['甲', '乙'], defaultOption: '甲', whyNeeded: '才能继续' },
      proposals: [{ title: '高价值', detail: '细节', value: 0.8, confidence: 0.8 }, { title: '初步点子', detail: '细节', value: 0.1, confidence: 0.2 }] });
    expect((await processCommit(ctx, toolCtx, args)).ok).toBe(true);
    expect(ctx.store.log('thread').all().map(m => m.kind)).toEqual(expect.arrayContaining(['reply', 'report', 'question', 'proposal']));
    expect(ctx.store.table('inbox').list().find(i => i.title === '高价值')?.status).toBe('open');
    expect(ctx.store.table('inbox').list().find(i => i.title === '初步点子')).toMatchObject({ status: 'closed', answer: 'idea_pool' });
    expect(ctx.host.calls.filter(c => c.method === 'notify')).toHaveLength(2);
  });
  test('多目标没有明确关联时不冒认全完成', async () => {
    const { ctx, toolCtx } = await turnContext();
    ctx.store.table('goals').put(goalFixture); ctx.store.table('goals').put({ ...goalFixture, id: 'g_0000000002' });
    await processCommit(ctx, toolCtx, commitArgs({ outcome: 'done' }));
    expect(ctx.store.table('goals').list().every(g => g.status === 'active')).toBe(true);
  });
  test('明确关联只更新对应目标且验收题默认为未通过', async () => {
    const { ctx, toolCtx } = await turnContext();
    ctx.store.table('goals').put(goalFixture); ctx.store.table('goals').put({ ...goalFixture, id: 'g_0000000002' });
    await processCommit(ctx, toolCtx, commitArgs({ outcome: 'done', evidence: [goalFixture.id] }));
    expect(ctx.store.table('goals').get(goalFixture.id)?.status).toBe('done_pending_check');
    expect(ctx.store.table('goals').get('g_0000000002')?.status).toBe('active');
    expect(ctx.store.table('inbox').list()[0]).toMatchObject({ type: 'question', defaultOption: '未通过' });
  });
  test('nextThink 下限使用本次无变化退避后的节奏', async () => {
    const { ctx, toolCtx, bot } = await turnContext();
    await processCommit(ctx, toolCtx, commitArgs({ nextThink: { mode: 'after', afterMinutes: 1, reason: '继续' } }));
    const current = ctx.store.table('bots').get(bot.id)!;
    expect(current.nextThinkAt).toBe(ctx.clock.now() + 2 * 60 * 60_000);
    expect(current.expectedBy).toBe(current.nextThinkAt! + ctx.settings.deadmanGraceMs);
  });
  test('I/O失败保留交账并返回明确的失败提示', async () => {
    const { ctx, toolCtx } = await turnContext();
    ctx.fs.appendText = async () => { throw new Error('磁盘已满'); };
    const result = await processCommit(ctx, toolCtx, commitArgs());
    expect(result.ok).toBe(true); if (result.ok) expect(result.text).toContain('日志追加失败');
    expect(ctx.store.log('audit').all().some(a => a.action === 'commit_effect_error')).toBe(true);
  });
});

/** 故障与并发验收：通知、文件和宿主事件相互交错时，已保存的事实和回合终态不能丢失。 */
import { expect, test } from 'vitest';
import { turnContext, commitArgs } from './c03-turn-fixtures.js';
import { processCommit } from '../src/commit/process.js';
import { onTurnEvent } from '../src/turn/events.js';
import { sendOwnerMessage } from '../src/outreach/thread.js';
import { goalFixture } from './model-fixtures.js';
import { resolveSettings } from '../src/config/defaults.js';

test('通知失败仍保存提问和全部提议，返回明确提示', async () => {
  const { ctx, toolCtx } = await turnContext();
  ctx.host.notify = async () => { throw new Error('通知渠道离线'); };
  const result = await processCommit(ctx, toolCtx, commitArgs({ report: '需要关注的报告', importance: 9,
    ownerQuestion: { text: '确认路线', options: ['甲', '乙'], defaultOption: '甲', whyNeeded: '继续需要确认' },
    proposals: [{ title: '独立提议', detail: '值得尝试', value: 0.8, confidence: 0.8 }] }));
  expect(result.ok).toBe(true); if (result.ok) expect(result.text).toContain('结果路由失败');
  expect(ctx.store.table('inbox').list().map(i => i.type)).toEqual(expect.arrayContaining(['question', 'proposal']));
  expect(ctx.store.log('thread').all().map(m => m.kind)).toEqual(expect.arrayContaining(['report', 'question', 'proposal']));
});
test('完成验收题会申请P1单推', async () => {
  const { ctx, toolCtx } = await turnContext(); ctx.store.table('goals').put(goalFixture);
  await processCommit(ctx, toolCtx, commitArgs({ outcome: 'done' }));
  expect(ctx.host.calls.filter(c => c.method === 'notify')[0]?.args[0]).toMatchObject({ level: 'P1' });
  expect(ctx.store.table('inbox').list()[0]?.pushed).toBe(true);
});
test('保护文件读取失败不妨碍结束与计量', async () => {
  const { ctx, bot, ticket } = await turnContext();
  ctx.fs.readText = async () => { throw new Error('文件系统暂不可用'); };
  await onTurnEvent(ctx, { type: 'ended', sessionId: bot.sessionId!, at: ctx.clock.now(), finalText: '', tokens: 10 });
  expect(ctx.store.table('wakes').get(ticket.id)?.endedAt).toBe(ctx.clock.now());
  expect(ctx.store.log('ledger').all()).toHaveLength(1);
  expect(ctx.store.table('alerts').list().some(a => a.code === 'protected_verify')).toBe(true);
});
test('ended等待文件核验期间交账，最终必须保留真实committed', async () => {
  const { ctx, bot, ticket, toolCtx } = await turnContext();
  const read = ctx.fs.readText.bind(ctx.fs);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let first = true;
  ctx.fs.readText = async path => { if (first) { first = false; await gate; } return read(path); };
  const ending = onTurnEvent(ctx, { type: 'ended', sessionId: bot.sessionId!, at: ctx.clock.now(), finalText: '', tokens: 10 });
  const committing = processCommit(ctx, toolCtx, commitArgs({ outcome: 'progress' }));
  release(); await Promise.all([ending, committing]);
  expect(ctx.store.table('wakes').get(ticket.id)?.status).toBe('committed');
  expect(ctx.store.table('commits').list()[0]?.outcome).toBe('progress');
  expect(ctx.store.table('bots').get(bot.id)?.consecutiveNoCommit).toBe(0);
});
test('并发ended只合成一次且不能冒充真实交账', async () => {
  const { ctx, bot, ticket } = await turnContext();
  const event = { type: 'ended' as const, sessionId: bot.sessionId!, at: ctx.clock.now(), finalText: '', tokens: 10 };
  await Promise.all([onTurnEvent(ctx, event), onTurnEvent(ctx, event)]);
  expect(ctx.store.table('commits').count()).toBe(1);
  expect(ctx.store.table('wakes').get(ticket.id)?.status).toBe('no_commit');
  expect(ctx.store.table('bots').get(bot.id)?.consecutiveNoCommit).toBe(1);
  expect(ctx.store.log('ledger').all()).toHaveLength(1);
});
test('回合期间主人追加的消息不能被旧回合结束清掉', async () => {
  const { ctx, bot, ticket } = await turnContext();
  ctx.clock.advance(1); sendOwnerMessage(ctx, bot.id, '新的要求');
  await onTurnEvent(ctx, { type: 'ended', sessionId: bot.sessionId!, at: ctx.clock.now(), finalText: '', tokens: 10 });
  expect(ctx.store.table('wakes').get(ticket.id)?.endedAt).not.toBeNull();
  expect(ctx.store.table('queue').list()[0]?.reason.kind).toBe('owner_message');
});
test('C03补充设置深合并且拒绝非法值', () => {
  expect(resolveSettings({ c03: { awaitingApprovalCancelMs: 100 } }).c03).toMatchObject({ awaitingApprovalCancelMs: 100, stateMaxBytes: 3072 });
  expect(() => resolveSettings({ c03: { reflectionHour: 24 } })).toThrow('reflectionHour');
  expect(() => resolveSettings({ c03: { handoffAgendaPriority: 6 } })).toThrow('handoffAgendaPriority');
});
test('复盘保存教训不能冒充目标进展', async () => {
  const { ctx, toolCtx } = await turnContext('reflection'); ctx.store.table('goals').put(goalFixture);
  const lastProgressAt = ctx.store.table('goals').get(goalFixture.id)!.lastProgressAt;
  await processCommit(ctx, toolCtx, commitArgs({ outcome: 'progress', summary: '保存了一条教训' }));
  expect(ctx.store.table('goals').get(goalFixture.id)?.lastProgressAt).toBe(lastProgressAt);
});
test('主人消息未交账只显示中心提示，不冒充机器人的实际回复', async () => {
  const { ctx, bot, ticket } = await turnContext();
  ctx.store.table('wakes').patch(ticket.id, { reason: { ...ticket.reason, kind: 'owner_message' } });
  await onTurnEvent(ctx, { type: 'ended', sessionId: bot.sessionId!, at: ctx.clock.now(), finalText: '', tokens: 10 });
  expect(ctx.store.log('thread').all().some(m => m.from === 'hub' && m.text === '机器人没有回复')).toBe(true);
  expect(ctx.store.log('thread').all().filter(m => m.kind === 'reply' && m.from === bot.id)).toHaveLength(0);
});

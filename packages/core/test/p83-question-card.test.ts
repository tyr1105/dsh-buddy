/**
 * P83：真实模型验证（2026-11-14 第二轮）抓到的两个提问卡缺陷。
 *
 * 1. 提问卡上的回答与主人直接回话等价：主人点了卡上的选项，约定提交要认这句回答，
 *    不能因为「这一回合不是主人发消息叫醒的」把总管挡回去、让它把同一个问题再问一遍。
 * 2. 过期提问不留在「待你处理」：主人改在私聊里直接回话之后，同一私聊里更早开着的普通提问标为已失效。
 *
 * 全部用真实 Hub（内存存储、假时钟、假宿主）走真实路径：交账建提问 → 收件箱回答 → 提交约定 / 直接发消息。
 */
import { describe, expect, it } from 'vitest';
import { processCommit } from '../src/commit/process.js';
import { answerInbox, createInboxItem } from '../src/outreach/inbox.js';
import { inboxView } from '../src/api/feed-views.js';
import { postThread, sendOwnerMessage } from '../src/outreach/thread.js';
import { ownerMessageOfWake, submitAgreement } from '../src/project/agreements.js';
import { NOT_OWNER_TURN_TEXT } from '../src/project/agreement-chain.js';
import { STALE_QUESTION_ANSWER, withdrawStaleQuestions } from '../src/outreach/stale-questions.js';
import type { InboxItem } from '../src/model/outreach.js';
import { turnContext, commitArgs } from './c03-turn-fixtures.js';
import { submitFixture, wakeTicket } from './p72a-agreement-fixtures.js';

/** 与真实使用同形的提问：两个选项，其中一个默认。 */
const QUESTION = { text: '约定卡只能在你直接发消息时提交，现在随便回我一句（比如「发卡」）', options: ['好的，我发一句', '不用约定卡'], defaultOption: '好的，我发一句', whyNeeded: '才能提交约定' };

/** 开一个有总管（本回合正在跑）的测试 Hub。 */
async function chiefHub() {
  return turnContext('regular', { role: 'chief' });
}

/** 总管交一次账并提一个问题，返回建出来的「待你处理」条目。 */
async function ask(ctx: Awaited<ReturnType<typeof chiefHub>>['ctx'], toolCtx: { botId: string; sessionId: string; wakeId: string }): Promise<InboxItem> {
  const before = new Set(ctx.store.table('inbox').list().map(row => row.id));
  const result = await processCommit(ctx, toolCtx, commitArgs({ ownerQuestion: QUESTION }));
  expect(result.ok).toBe(true);
  const item = ctx.store.table('inbox').list(row => row.type === 'question' && row.status === 'open' && !before.has(row.id))[0];
  expect(item).toBeDefined();
  return item!;
}

/** 一条落在私聊里的普通提问（带提问卡消息）。 */
function privateQuestion(ctx: Awaited<ReturnType<typeof chiefHub>>['ctx'], botId: string, key: string): InboxItem {
  const item = createInboxItem(ctx, { botId, type: 'question', title: '问一句', body: '理由', options: ['甲', '乙'], defaultOption: '甲',
    refId: null, expiresAt: null, subjectKey: key });
  postThread(ctx, { thread: botId, from: botId, kind: 'question', text: '问一句', refId: item.id });
  return item;
}

describe('P83-1 提问卡上的回答等于主人的话', () => {
  it('主人回答提问卡后，这一回合的主人原话就是那条回答，据此能提交约定', async () => {
    const { ctx, bot, toolCtx } = await chiefHub();
    const item = await ask(ctx, toolCtx);
    // 主人点卡片上的选项作答。
    await answerInbox(ctx, item.id, '好的，我发一句');
    const queued = ctx.store.table('queue').list(row => row.botId === bot.id && row.reason.kind === 'inbox_reply')[0]!;
    expect(queued).toBeDefined();
    const answeredWake = wakeTicket(ctx, bot.id, { kind: 'inbox_reply', evidence: queued.reason.evidence });
    const words = ownerMessageOfWake(ctx, answeredWake);
    expect(words).not.toBeNull();
    expect(words!.text).toContain('好的，我发一句');
    // 真实入口：这一回合提交约定成功（修改前会被「不是主人发消息叫醒的」挡回去，总管只好再问一遍）。
    const out = await submitAgreement(ctx, bot.id, answeredWake, submitFixture());
    expect(out.kind).toBe('created');
  });

  it('审批的回答、中心按默认处理落的回复都不算主人的话；不是主人叫醒的回合照样拒绝提交约定', async () => {
    const { ctx, bot } = await chiefHub();
    // 审批条目不是提问：主人答过也不认。
    const approval = createInboxItem(ctx, { botId: bot.id, type: 'approval', title: '批准：运行命令', body: '申请运行 ls',
      options: ['批准', '拒绝'], defaultOption: '批准', refId: 'ap_0000000001', subjectKey: 'approval:ap_0000000001', expiresAt: null });
    postThread(ctx, { thread: bot.id, from: 'owner', kind: 'reply', text: '「批准：运行命令」：批准', refId: approval.id });
    expect(ownerMessageOfWake(ctx, wakeTicket(ctx, bot.id, { kind: 'inbox_reply', evidence: [approval.id] }))).toBeNull();
    // 提问被中心按到期默认处理时落的是中心消息，不是主人写的，同样不认。
    const question = createInboxItem(ctx, { botId: bot.id, type: 'question', title: '选一条路线', body: '才能继续',
      options: ['甲', '乙'], defaultOption: '甲', refId: null, expiresAt: null, subjectKey: 'question:i_0000000009' });
    postThread(ctx, { thread: bot.id, from: 'hub', kind: 'reply', text: '「选一条路线」已按默认回答处理：甲', refId: question.id });
    expect(ownerMessageOfWake(ctx, wakeTicket(ctx, bot.id, { kind: 'inbox_reply', evidence: [question.id] }))).toBeNull();
    // 不是主人叫醒的回合：提交约定被拒，文字不变。
    await expect(submitAgreement(ctx, bot.id, wakeTicket(ctx, bot.id, { kind: 'next_think', evidence: [] }), submitFixture()))
      .rejects.toThrow(NOT_OWNER_TURN_TEXT);
  });
});

describe('P83-2 主人直接回话之后，更早的提问标为已失效', () => {
  it('同一私聊里更早开着的提问被撤回，从「待你处理」里消失', async () => {
    const { ctx, bot, toolCtx } = await chiefHub();
    const item = await ask(ctx, toolCtx);
    expect(inboxView(ctx).items.some(row => row.id === item.id)).toBe(true);
    // 主人没点卡片，而是在私聊里直接说了一句（真实验证里就是「发卡」）。
    sendOwnerMessage(ctx, bot.id, '发卡');
    const after = ctx.store.table('inbox').get(item.id)!;
    expect(after.status).toBe('withdrawn');
    expect(after.answer).toBe(STALE_QUESTION_ANSWER);
    expect(inboxView(ctx).items.some(row => row.id === item.id)).toBe(false);
  });

  it('主题里的提问、一件事的条目、发话之后才提的问题都不动', async () => {
    const { ctx, bot } = await chiefHub();
    const now = ctx.clock.now();
    // 一条落在主题里的提问：提问卡不在这位员工的私聊里，不在这次处理范围内。
    ctx.store.table('projectTopics').put({ id: 'ptp_0000000001', projectId: 'prj_0000000001', title: '主题',
      createdAt: now, updatedAt: now, lastMessageAt: now, agentTurnsSinceOwner: 0, pendingBotIds: [] });
    const inTopic = createInboxItem(ctx, { botId: bot.id, type: 'question', title: '问一句', body: '理由', options: ['甲', '乙'], defaultOption: '甲',
      refId: null, expiresAt: null, subjectKey: 'question:i_0000000011', topicId: 'ptp_0000000001' });
    postThread(ctx, { thread: 'ptp_0000000001', from: bot.id, kind: 'question', text: '问一句', refId: inTopic.id });
    // 一件事的条目有它自己的收回路径（不受这里影响）。
    const jobItem = createInboxItem(ctx, { botId: bot.id, type: 'question', title: '这件事到回合上限了', body: '理由',
      options: ['追加 4 个回合', '缩小范围', '暂停'], defaultOption: null, refId: null, subjectKey: 'job:job_0000000001:cap:1', expiresAt: null });
    // 更早开在私聊里的普通提问：应当被撤回（证明筛选按线程与时间做了）。
    const old = privateQuestion(ctx, bot.id, 'question:i_0000000012');
    sendOwnerMessage(ctx, bot.id, '发卡');
    // 主人发话之后才提的问题：保持开着。
    const later = privateQuestion(ctx, bot.id, 'question:i_0000000013');
    expect(ctx.store.table('inbox').get(old.id)!.status).toBe('withdrawn');
    expect(ctx.store.table('inbox').get(later.id)!.status).toBe('open');
    expect(ctx.store.table('inbox').get(inTopic.id)!.status).toBe('open');
    expect(ctx.store.table('inbox').get(jobItem.id)!.status).toBe('open');
  });

  it('团队线程不处理；撤回只碰说话的那位员工的提问', async () => {
    const { ctx, bot } = await chiefHub();
    const other = { ...bot, id: 'b_0000000002', name: '另一位', sessionId: null, homeDir: '/hub/bots/b_0000000002' };
    ctx.store.table('bots').put(other);
    const mine = privateQuestion(ctx, bot.id, 'question:i_0000000021');
    const theirs = privateQuestion(ctx, other.id, 'question:i_0000000022');
    // 团队线程不区分是哪位员工的私聊：一条也不撤。
    expect(withdrawStaleQuestions(ctx, { botId: bot.id, thread: 'team', before: ctx.clock.now() + 1 })).toEqual([]);
    expect(ctx.store.table('inbox').get(mine.id)!.status).toBe('open');
    sendOwnerMessage(ctx, bot.id, '发卡');
    expect(ctx.store.table('inbox').get(mine.id)!.status).toBe('withdrawn');
    expect(ctx.store.table('inbox').get(theirs.id)!.status).toBe('open');
  });
});

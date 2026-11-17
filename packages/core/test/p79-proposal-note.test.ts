/**
 * P79：答复提议时可以附一句话（附言）。
 *
 * 规则（任务卡第 4 节）：
 * - 附言去掉首尾空白后不超过 200 个字，超过就拒绝并说明；内容不做限制（它是主人自己的话）；
 * - 记在这条条目的记录上（ownerNote）；
 * - 提出提议的员工得知结果的地方（回复感知的概要、私聊里主人那条回复），在原句后面加「主人说：{附言}」；
 *   主题里的旁白同理；没有附言时文字与原来逐字相同；
 * - 只有提议带附言有意义：其他类型带了也不起作用（审批另有 decideApproval 的备注通道）。
 */
import { describe, expect, it } from 'vitest';
import { createInboxItem } from '../src/outreach/inbox.js';
import { submitProposal } from '../src/outreach/proposals.js';
import { followUpNoteText } from '../src/project/topic-followup.js';
import { apiFixture } from './c04-api-fixtures.js';
import { goalFixture } from './model-fixtures.js';

/** 建一条真实的提议（目标草稿 + 收件箱条目），返回条目。 */
async function makeProposal(title = '核实新资料') {
  const fixture = await apiFixture();
  const { ctx, bot } = fixture;
  const goal = { ...goalFixture, botId: bot.id, status: 'proposed' as const };
  ctx.store.table('goals').put(goal);
  const item = (await submitProposal(ctx, bot.id, { title, detail: '先核对来源', value: 1, confidence: 1, refId: goal.id }))!;
  return { ...fixture, item, goal };
}

/** 该员工最近一条「回复收件箱」感知的概要。 */
function lastReplySummary(ctx: Awaited<ReturnType<typeof apiFixture>>['ctx']): string | undefined {
  return ctx.store.table('percepts').list(row => row.kind === 'inbox_reply').at(-1)?.summary;
}

/** 私聊里主人那条回复（员工在唤醒包里看到的就是这条）。 */
function ownerReplyText(ctx: Awaited<ReturnType<typeof apiFixture>>['ctx'], botId: string, itemId: string): string | undefined {
  return ctx.store.log('thread').all().find(row => row.thread === botId && row.from === 'owner' && row.refId === itemId)?.text;
}

describe('P79 提议的附言', () => {
  it('不做并附言：条目记录上有附言，感知概要（给员工看）有「主人说：……」，私聊里主人的气泡写成「答复：附言」', async () => {
    const { ctx, api, bot, item } = await makeProposal();
    expect(await api.answerInbox(item.id, '不做', '这个方向先放一放，下周再说')).toMatchObject({ ok: true });
    expect(ctx.store.table('inbox').get(item.id)).toMatchObject({ status: 'answered', answer: '不做', ownerNote: '这个方向先放一放，下周再说' });
    expect(lastReplySummary(ctx)).toBe('主人回复「核实新资料」：不做。主人说：这个方向先放一放，下周再说');
    // P74i-m4（第 4 节）：私聊里主人自己的气泡不写「主人说：」，写成「{答复}：{附言}」；给员工看的感知概要保持「主人说：」。
    expect(ownerReplyText(ctx, bot.id, item.id)).toBe('「核实新资料」：不做：这个方向先放一放，下周再说');
  });

  it('接受并附言：同样记下并带到员工得知结果的地方', async () => {
    const { ctx, api, bot, goal, item } = await makeProposal();
    expect(await api.answerInbox(item.id, '接受', '可以，注意先核对来源')).toMatchObject({ ok: true });
    expect(ctx.store.table('goals').get(goal.id)?.status).toBe('active');
    expect(ctx.store.table('inbox').get(item.id)?.ownerNote).toBe('可以，注意先核对来源');
    expect(lastReplySummary(ctx)).toBe('主人回复「核实新资料」：接受。主人说：可以，注意先核对来源');
    expect(ownerReplyText(ctx, bot.id, item.id)).toBe('「核实新资料」：接受：可以，注意先核对来源');
  });

  it.each([['不传附言', undefined], ['空附言', ''], ['只有空白的附言', '   ']])('%s：文字与原来逐字相同，记录上没有附言字段', async (_name, note) => {
    const { ctx, api, bot, item } = await makeProposal();
    expect(await api.answerInbox(item.id, '不做', note)).toMatchObject({ ok: true });
    expect(lastReplySummary(ctx)).toBe('主人回复「核实新资料」：不做');
    expect(ownerReplyText(ctx, bot.id, item.id)).toBe('「核实新资料」：不做');
    expect('ownerNote' in ctx.store.table('inbox').get(item.id)!).toBe(false);
  });

  it('附言去掉首尾空白后再记；恰好 200 个字可以，空白不算字数', async () => {
    const { ctx, api, item } = await makeProposal();
    const note = '字'.repeat(200);
    expect(await api.answerInbox(item.id, '不做', `  ${note}\n `)).toMatchObject({ ok: true });
    expect(ctx.store.table('inbox').get(item.id)?.ownerNote).toBe(note);
  });

  it('超过 200 个字被拒绝并说明，条目仍在等主人处理，业务状态没有变', async () => {
    const { ctx, api, goal, item } = await makeProposal();
    const result = await api.answerInbox(item.id, '接受', '字'.repeat(201));
    // P74i-m4（第 4 节）：错误是中文，不带英文字段名（原为「note：附言不能超过 200 个字」）。
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('附言：不能超过 200 个字') });
    expect((result as { error: string }).error).not.toContain('note');
    expect(ctx.store.table('inbox').get(item.id)?.status).toBe('open');
    expect(ctx.store.table('goals').get(goal.id)?.status).toBe('proposed');
    // 同一条随后不带附言仍可正常答复。
    expect(await api.answerInbox(item.id, '接受')).toMatchObject({ ok: true });
  });

  it('附言内容不做限制：标点、换行、尖括号原样保留', async () => {
    const { ctx, api, item } = await makeProposal();
    expect(await api.answerInbox(item.id, '不做', '先看 <日志>；\n再说')).toMatchObject({ ok: true });
    expect(ctx.store.table('inbox').get(item.id)?.ownerNote).toBe('先看 <日志>；\n再说');
  });

  it('其他类型带了附言也不起作用（提问照原样处理，不记附言）', async () => {
    const { ctx, api, bot } = await apiFixture();
    const item = createInboxItem(ctx, { botId: bot.id, type: 'question', title: '选一个方向', body: '供你决定',
      subjectKey: 'question:direction', options: ['方案甲', '方案乙'], defaultOption: '方案乙' });
    expect(await api.answerInbox(item.id, '方案甲', '顺便说一句')).toMatchObject({ ok: true });
    expect('ownerNote' in ctx.store.table('inbox').get(item.id)!).toBe(false);
    expect(lastReplySummary(ctx)).toBe('主人回复「选一个方向」：方案甲');
  });

  it('主题里的旁白：有附言接在原句后面，没有附言与原来逐字相同', () => {
    const proposal = { type: 'proposal' as const, title: '核实新资料' };
    expect(followUpNoteText(proposal, '接受')).toBe('你接受了建议「核实新资料」。');
    expect(followUpNoteText(proposal, '不做')).toBe('你没有采纳建议「核实新资料」。');
    expect(followUpNoteText(proposal, '不做', '')).toBe('你没有采纳建议「核实新资料」。');
    // P74i-m4（第 4 节）：旁白里已用「你」称呼主人，附言写成「（你说：……）」。
    expect(followUpNoteText(proposal, '不做', '下周再说')).toBe('你没有采纳建议「核实新资料」。（你说：下周再说）');
    // 提问的旁白不受影响。
    expect(followUpNoteText({ type: 'question', title: '选方向' }, '方案甲', '多余')).toBe('你回答了「选方向」：方案甲');
  });
});

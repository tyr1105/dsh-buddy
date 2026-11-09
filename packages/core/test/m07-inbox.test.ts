/** M07 收件箱契约：界面按 options 原样作答即可完成决定，非法回答不能悄悄改变业务状态。 */
import { describe, expect, it } from 'vitest';
import { createInboxItem, expireInbox } from '../src/outreach/inbox.js';
import { submitProposal } from '../src/outreach/proposals.js';
import { postThread } from '../src/outreach/thread.js';
import { buildDigest } from '../src/outreach/digest.js';
import { prepareApproval } from '../src/gate/approvals.js';
import type { InboxItem } from '../src/model/outreach.js';
import { HUB_EVENT_SCOPES } from '../src/api/event-scopes.js';
import { apiFixture } from './c04-api-fixtures.js';
import { goalFixture, id } from './model-fixtures.js';

/** 手工发布一张真实卡片，随后均通过 UiApi 读取与决定，不模拟卡片答案。 */
function publish(ctx: Awaited<ReturnType<typeof apiFixture>>['ctx'], item: InboxItem): void {
  postThread(ctx, { thread: item.botId ?? 'team', from: 'hub', kind: item.type, text: item.title, refId: item.id });
}

describe('M07 每类卡片的选项与往返', () => {
  it.each(['接受', '不做'] as const)('提议按钮 %s 原样回传并真正处理草稿', async answer => {
    const { ctx, api, bot } = await apiFixture();
    const goal = { ...goalFixture, botId: bot.id, status: 'proposed' as const };
    ctx.store.table('goals').put(goal);
    const item = (await submitProposal(ctx, bot.id, { title: '核实新资料', detail: '先核对来源', value: 1, confidence: 1, refId: goal.id }))!;
    const card = api.thread(bot.id).messages.find(row => row.card?.inboxId === item.id)!.card!;
    expect(card.options).toEqual(['接受', '不做']);
    expect(card.approvalId).toBeNull();
    expect(api.inbox().items.find(row => row.id === item.id)?.options).toEqual(card.options);
    expect(await api.answerInbox(item.id, card.options.find(option => option === answer)!)).toMatchObject({ ok: true });
    expect(ctx.store.table('goals').get(goal.id)?.status).toBe(answer === '接受' ? 'active' : 'abandoned');
    expect(api.inbox().items.some(row => row.id === item.id)).toBe(false);
    expect(api.thread(bot.id).messages.find(row => row.card?.inboxId === item.id)?.card).toMatchObject({ status: 'answered', answer });
  });

  it.each(['批准', '拒绝'] as const)('审批按钮 %s 通过 decideApproval 处理', async answer => {
    const { ctx, api, bot } = await apiFixture();
    const { approval } = prepareApproval(ctx, bot.id, 'write_file', { path: '/outside/result' }, 'C', '交付结果');
    const item = ctx.store.table('inbox').list(row => row.refId === approval.id)[0]!;
    const card = api.thread(bot.id).messages.find(row => row.card?.inboxId === item.id)!.card!;
    expect(card.options).toEqual(['批准', '拒绝']);
    expect(card.approvalId).toBe(approval.id);
    expect(api.inbox().items.find(row => row.id === item.id)?.approvalId).toBe(card.approvalId);
    expect(api.inbox().items.find(row => row.id === item.id)?.options).toEqual(card.options);
    const option = card.options.find(value => value === answer)!;
    expect(await api.decideApproval(card.approvalId!, option === '批准')).toMatchObject({ ok: true });
    expect(ctx.store.table('approvals').get(approval.id)?.status).toBe(answer === '批准' ? 'approved' : 'rejected');
    expect(api.thread(bot.id).messages.find(row => row.card?.inboxId === item.id)?.card).toMatchObject({ status: 'answered', answer });
    expect(await api.decideApproval(approval.id, option !== '批准')).toMatchObject({ ok: false, error: expect.stringContaining('已经处理') });
  });

  it.each(['方案甲', '方案乙', '我另有一个计划'])('提问选项和自由文本 %s 都原样保留', async answer => {
    const { ctx, api, bot } = await apiFixture();
    const item = createInboxItem(ctx, { botId: bot.id, type: 'question', title: '选一个方向', body: '供你决定',
      subjectKey: 'question:direction', options: ['方案甲', '方案乙'], defaultOption: '方案乙' });
    publish(ctx, item);
    expect(api.thread(bot.id).messages[0]?.card?.options).toEqual(['方案甲', '方案乙']);
    expect(api.inbox().items[0]?.options).toEqual(['方案甲', '方案乙']);
    expect(await api.answerInbox(item.id, answer)).toMatchObject({ ok: true });
    expect(api.thread(bot.id).messages[0]?.card).toMatchObject({ status: 'answered', answer });
    expect(ctx.store.table('percepts').list(row => row.kind === 'inbox_reply').at(-1)?.summary).toContain(answer);
  });

  it('提问拒绝空白自由文本，保留待答状态', async () => {
    const { ctx, api, bot } = await apiFixture();
    const item = createInboxItem(ctx, { botId: bot.id, type: 'question', title: '请选择', body: '内容', subjectKey: 'q', options: ['甲', '乙'], defaultOption: '乙' });
    expect(await api.answerInbox(item.id, ' \n ')).toMatchObject({ ok: false, error: expect.stringMatching(/[\u3400-\u9fff]/) });
    expect(ctx.store.table('inbox').get(item.id)?.status).toBe('open');
  });

  it('告警只接受「知道了」，确认后同步关闭底层告警及卡片', async () => {
    const { ctx, api, bot } = await apiFixture();
    ctx.store.table('alerts').put({ id: id('al'), botId: bot.id, code: 'fault', text: '故障内容', level: 'P1', count: 1,
      firstAt: ctx.clock.now(), lastAt: ctx.clock.now(), status: 'open' });
    const item = createInboxItem(ctx, { botId: bot.id, type: 'alert', title: '需要注意', body: '故障内容', subjectKey: 'alert:fault', refId: id('al') });
    publish(ctx, item);
    expect(api.thread(bot.id).messages[0]?.card?.options).toEqual(['知道了']);
    expect(api.inbox().items[0]?.options).toEqual(['知道了']);
    expect(await api.answerInbox(item.id, '忽略')).toMatchObject({ ok: false, error: expect.stringContaining('知道了') });
    expect(ctx.store.table('alerts').get(id('al'))?.status).toBe('open');
    expect(await api.answerInbox(item.id, api.inbox().items[0]!.options[0]!)).toMatchObject({ ok: true });
    expect(ctx.store.table('alerts').get(id('al'))?.status).toBe('closed');
    expect(api.thread(bot.id).messages[0]?.card).toMatchObject({ status: 'closed', answer: '知道了' });
  });
});

describe('M07 提议合法值及历史数据兼容', () => {
  it.each([
    ['接受', '接受'], [' 同意 ', '接受'], ['好', '接受'], [' ACCEPT ', '接受'], ['aCcEpT', '接受'], ['\n 接 受 \t', '接受'],
    ['不做', '不做'], [' 拒绝 ', '不做'], ['不要', '不做'], [' REJECT ', '不做'], ['rEjEcT', '不做'], [' 不 做 ', '不做'],
  ])('回答 %j 规范为 %s', async (answer, canonical) => {
    const { ctx, api, bot } = await apiFixture();
    const item = createInboxItem(ctx, { botId: bot.id, type: 'proposal', title: '尝试新方法', body: '说明', subjectKey: 'proposal:method' });
    expect(await api.answerInbox(item.id, answer)).toMatchObject({ ok: true });
    expect(ctx.store.table('inbox').get(item.id)).toMatchObject({ status: 'answered', answer: canonical });
  });

  it.each(['暂缓', 'yes', '', ' \n '])('非法提议回答 %j 列出合法值，且没有接受或拒绝副作用', async answer => {
    const { ctx, api, bot } = await apiFixture();
    const item = createInboxItem(ctx, { botId: bot.id, type: 'proposal', title: '提议', body: '说明', subjectKey: 'proposal' });
    const before = ctx.store.table('percepts').count();
    const result = await api.answerInbox(item.id, answer);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('接受 / 同意 / 好 / accept') });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('不做 / 拒绝 / 不要 / reject') });
    expect(ctx.store.table('inbox').get(item.id)).toMatchObject({ status: 'open', answer: null });
    expect(ctx.store.table('percepts').count()).toBe(before);
    expect(ctx.store.log('audit').all().some(row => row.action === 'proposal_rejected')).toBe(false);
  });

  it('旧提议与缺选项的旧告警在两个视图中使用合法按钮，读取不改写原记录', async () => {
    const { ctx, api, bot } = await apiFixture();
    for (const type of ['proposal', 'alert'] as const) {
      const item = createInboxItem(ctx, { botId: bot.id, type, title: type, body: '旧记录', subjectKey: type });
      ctx.store.table('inbox').patch(item.id, { options: type === 'proposal' ? ['接受', '拒绝'] : [], defaultOption: '拒绝' });
      publish(ctx, item);
      const expected = type === 'proposal' ? ['接受', '不做'] : ['知道了'];
      expect(api.thread(bot.id).messages.find(row => row.card?.inboxId === item.id)?.card).toMatchObject({ options: expected, defaultOption: expected.at(-1) });
      expect(api.inbox().items.find(row => row.id === item.id)?.options).toEqual(expected);
      expect(ctx.store.table('inbox').get(item.id)?.defaultOption).toBe('拒绝');
    }
  });

  it('旧 answerInbox 审批入口仍委托决定路径，非法答案不改变批准票', async () => {
    const { ctx, api, bot } = await apiFixture();
    const { approval } = prepareApproval(ctx, bot.id, 'write_file', { path: '/outside/result' }, 'C', '交付结果');
    const item = ctx.store.table('inbox').list(row => row.refId === approval.id)[0]!;
    expect(await api.answerInbox(item.id, '随便')).toMatchObject({ ok: false, error: expect.stringContaining('批准') });
    expect(ctx.store.table('approvals').get(approval.id)?.status).toBe('pending');
    expect(await api.answerInbox(item.id, '批准')).toMatchObject({ ok: true });
    expect(ctx.store.table('approvals').get(approval.id)?.status).toBe('approved');
    expect(ctx.store.table('percepts').count(row => row.kind === 'approval_decided')).toBe(1);
  });

  it('「不做」纳入拒绝冷却和周报接受率，旧答案也继续参与统计', async () => {
    const { ctx, api, bot } = await apiFixture();
    for (const [title, answer] of [['新接受', '好'], ['新拒绝', '不做']]) {
      const item = (await submitProposal(ctx, bot.id, { title: title!, detail: '说明', value: 1, confidence: 1 }))!;
      expect(await api.answerInbox(item.id, answer!)).toMatchObject({ ok: true });
    }
    const old = createInboxItem(ctx, { botId: bot.id, type: 'proposal', title: '旧拒绝', body: '说明', subjectKey: 'old' });
    ctx.store.table('inbox').patch(old.id, { status: 'answered', answer: 'reject', answeredAt: ctx.clock.now() });
    expect(await submitProposal(ctx, bot.id, { title: '新拒绝', detail: '再次建议', value: 1, confidence: 1 })).toBeNull();
    expect(await submitProposal(ctx, bot.id, { title: '旧拒绝', detail: '再次建议', value: 1, confidence: 1 })).toBeNull();
    ctx.clock.set(Date.parse('2026-11-08T10:00:00+08:00'));
    expect(buildDigest(ctx, ctx.clock.now())).toContain('提议接受率：33%（1/3）');
    expect((await api.bot(bot.id)).stats.proposalAcceptRate).toBeCloseTo(1 / 3);
  });

  it('到期撤回按机器人发出 inbox/thread/bot 事件，没有全局无归属的批量事件', async () => {
    const { ctx, bot } = await apiFixture();
    const item = createInboxItem(ctx, { botId: bot.id, type: 'proposal', title: '到期提议', body: '说明', subjectKey: 'expire' });
    const events: Array<{ scope: string; botId?: string | null }> = [];
    ctx.emit = (scope, botId) => { events.push({ scope, botId }); };
    ctx.clock.set(item.expiresAt!);
    await expireInbox(ctx, ctx.clock.now());
    for (const scope of [HUB_EVENT_SCOPES.inbox, HUB_EVENT_SCOPES.thread, HUB_EVENT_SCOPES.bot])
      expect(events).toContainEqual({ scope, botId: bot.id });
    expect(events.every(event => event.botId === bot.id)).toBe(true);
  });
});

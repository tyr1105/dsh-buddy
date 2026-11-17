/**
 * P75g 的测试四：复盘回合的交账落点（不落私聊、不推送、没落卡时以 work 落主题并归入「复盘」折叠组、不许向主人提问）、
 * 往来折叠的标题与箭头、复盘全程对主人安静、给主人看的文字不含内部名称。
 * 走真实链路：验收之后执行者、评审员各跑一个真实回合，只用唤醒包里的文字调用工具，最后 hub_commit 收尾。
 */
import { describe, expect, it } from 'vitest';
import { topicFloorsForTopic } from '../src/api/job-topic-views.js';
import { topicFloorsView, isRetroMessage } from '../src/api/job-views.js';
import type { ThreadMessage } from '../src/model/outreach.js';
import { goalFixture } from './model-fixtures.js';
import {
  INTERNAL_NAMES, bot, callTool, commitAndEnd, flow, ownerNoise, retroRun, retroTurn, skillKeysQueued, srcsIn, theJob, threadOf, tick, MINUTE, type JobFix,
} from './p75g-fixtures.js';

const THIRD_BACK = { no: 3, text: '第 3 条还是不对：失败时页面没有任何提示', problem: '失败时页面没有任何提示' };

/** 所有私聊线程（总管、每位员工、团队线程）里的消息。 */
function privateRows(fix: JobFix) {
  return fix.ctx.store.log('thread').all().filter(row => row.thread === 'team' || fix.ctx.store.table('bots').get(row.thread) !== null);
}

/** 这件事主题里的折叠组（视图）。 */
function folds(fix: JobFix, topicId: string) {
  return topicFloorsForTopic(fix.ctx, topicId, threadOf(fix.ctx, topicId)).items.filter(item => item.kind === 'fold');
}

describe('17 复盘回合的交账：不落私聊、不推送', () => {
  it('没有落复盘卡时，reply 以 work 落到这件事的主题（refId retro-summary:…，发出者是这位员工），并归入「复盘」折叠组；私聊、推送、「没有回复」提示都没有', async () => {
    const { fix, job } = await flow({ rejectFirst: true });
    const run = retroRun(fix, job.id)!;
    await retroTurn(fix, fix.engineer.id);
    const before = ownerNoise(fix);
    const privateBefore = privateRows(fix).length;
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '先看看', reply: '这次我没有想到可以记下的做法。', report: '重要汇报', importance: 10 });
    const topic = threadOf(fix.ctx, job.topicId);
    const posted = topic.filter(row => row.refId?.startsWith(`retro-summary:${run.id}:`));
    expect(posted).toMatchObject([{ from: fix.engineer.id, kind: 'work', text: '这次我没有想到可以记下的做法。' }]);
    // report 不落任何地方。
    expect(topic.some(row => row.text === '重要汇报')).toBe(false);
    expect(privateRows(fix)).toHaveLength(privateBefore);
    expect(privateRows(fix).some(row => row.text === '机器人没有回复' || row.text === '这次我没有想到可以记下的做法。' || row.text === '重要汇报')).toBe(false);
    expect(ownerNoise(fix)).toEqual(before);
    expect(fix.ctx.store.log('thread').all().some(row => row.text === '机器人没有回复')).toBe(false);
    // 折叠组：组标题写「复盘」，这条在组里，没有箭头。
    const group = folds(fix, job.topicId).at(-1)!;
    expect(group).toMatchObject({ kind: 'fold', label: '复盘' });
    const row = (group as { messages: Array<{ message: ThreadMessage; fromName: string; toNames: string[] }> }).messages.find(item => item.message.refId === posted[0]!.refId)!;
    expect(row).toMatchObject({ fromName: '林舟', toNames: [] });
  });

  it('这一回合没有说话（reply 为 null）：什么都不落，也没有「没有回复」的提示', async () => {
    const { fix, job } = await flow({ rejectFirst: true });
    await retroTurn(fix, fix.engineer.id);
    const topicBefore = threadOf(fix.ctx, job.topicId).length;
    const privateBefore = privateRows(fix).length;
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '先看看', reply: null });
    expect(threadOf(fix.ctx, job.topicId)).toHaveLength(topicBefore);
    expect(privateRows(fix)).toHaveLength(privateBefore);
    expect(fix.ctx.store.log('thread').all().some(row => row.text === '机器人没有回复')).toBe(false);
  });

  it('已经落了复盘卡的回合，reply 不再重复落；卡片本身在主题折叠组里，接收者是核对人（评审甲）', async () => {
    const { fix, job } = await flow({ rejectFirst: true, ownerReturn: THIRD_BACK });
    const run = retroRun(fix, job.id)!;
    const { packet } = await retroTurn(fix, fix.engineer.id);
    const review = srcsIn(packet).find(row => row.kind === '评审意见')!;
    expect(await callTool(fix, bot(fix, fix.engineer.id), 'hub_skill', { mode: 'propose', updates: [{ title: '失败路径自查', whenToUse: '交回之前', sentences: [{ text: '交回前断开接口试一次', sources: [review.src] }] }] })).toMatchObject({ ok: true });
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '复盘完成', reply: '已提交一条技能更新。' });
    const topic = threadOf(fix.ctx, job.topicId);
    expect(topic.filter(row => row.refId?.startsWith(`retro-summary:${run.id}:`))).toEqual([]);
    expect(topic.filter(row => row.refId === `retro:${run.id}:${fix.engineer.id}`)).toHaveLength(1);
    const group = folds(fix, job.topicId).at(-1) as { label?: string; messages: Array<{ message: ThreadMessage; fromName: string; toNames: string[] }> };
    expect(group.label).toBe('复盘');
    expect(group.messages.map(item => [item.message.refId, item.fromName, item.toNames])).toEqual([[`retro:${run.id}:${fix.engineer.id}`, '林舟', ['评审甲']]]);
    expect(privateRows(fix).some(row => row.text.includes('已提交一条技能更新'))).toBe(false);
  });

  it('向主人提问被拒（逐字），交账没有保存，改正之后可以再交账', async () => {
    const { fix, job } = await flow({ rejectFirst: true });
    await retroTurn(fix, fix.engineer.id);
    const question = { text: '这条做法要不要记下来', options: ['记', '不记'], defaultOption: '记', whyNeeded: '拿不准' };
    const commitsBefore = fix.ctx.store.table('commits').count();
    const tool = fix.hub.tools().find(item => item.name === 'hub_commit')!;
    const { commitArgs } = await import('./c03-turn-fixtures.js');
    const refused = await tool.handler(bot(fix, fix.engineer.id).sessionId!, commitArgs({ outcome: 'needs_owner', summary: '想问一句', ownerQuestion: question })) as { ok: boolean; error?: string };
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain('复盘回合不能向主人提问，有问题写进 note');
    expect(fix.ctx.store.table('commits').count()).toBe(commitsBefore);
    expect(fix.ctx.store.table('inbox').list(row => row.status === 'open')).toEqual([]);
    expect(retroRun(fix, job.id)!.participants[0]).toMatchObject({ state: 'running' });
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '先看看', reply: null });
  });

  it('复盘回合不推进目标、不生成目标验收提问（交账说完成也一样）', async () => {
    const { fix, job } = await flow({ rejectFirst: true });
    const goal = { ...goalFixture, id: 'g_0000000001', botId: fix.engineer.id, status: 'active' as const };
    fix.ctx.store.table('goals').put(goal);
    await retroTurn(fix, fix.engineer.id);
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'done', summary: '复盘完成', reply: null });
    expect(fix.ctx.store.table('goals').get('g_0000000001')).toEqual(goal);
    expect(fix.ctx.store.table('inbox').list(row => row.status === 'open')).toEqual([]);
    expect(retroRun(fix, job.id)).not.toBeNull();
  });
});

describe('往来折叠：复盘类消息进折叠组，只有全是复盘类的组才有 label', () => {
  const message = (id: string, patch: Partial<ThreadMessage>): ThreadMessage => ({
    id, thread: 'ptp_0000000001', from: 'b_0000000002', kind: 'work', text: '一句话', refId: null, createdAt: 1_000, readAt: null, ...patch } as ThreadMessage);
  const view = (messages: ThreadMessage[]) => topicFloorsView({
    messages, names: { b_0000000002: '林舟', b_0000000003: '评审甲' }, events: { jev_0000000001: { actor: 'b_0000000002', to: ['b_0000000003'] } },
    commitSenders: {}, chiefId: 'b_0000000001', timezone: 'Asia/Shanghai' }).items.filter(item => item.kind === 'fold');

  it('复盘卡、技能核对卡、复盘小结算复盘类消息；其他工作往来不算', () => {
    expect(isRetroMessage(message('m_1', { kind: 'job_card', refId: 'retro:sr_0000000001:b_0000000002' }))).toBe(true);
    expect(isRetroMessage(message('m_2', { kind: 'job_card', refId: 'skillcheck:su_0000000001#1' }))).toBe(true);
    expect(isRetroMessage(message('m_3', { kind: 'work', refId: 'retro-summary:sr_0000000001' }))).toBe(true);
    expect(isRetroMessage(message('m_4', { kind: 'work', refId: 'retro-summary:sr_0000000001:w_0000000001' }))).toBe(true);
    expect(isRetroMessage(message('m_5', { kind: 'work', refId: 'jev_0000000001' }))).toBe(false);
    expect(isRetroMessage(message('m_6', { kind: 'job_card', refId: 'submission:jsb_0000000001' }))).toBe(false);
    expect(isRetroMessage(message('m_7', { kind: 'work', refId: 'retro:abc' }))).toBe(false); // 种类不对：retro: 只给 job_card
  });

  it('全是复盘类：组带 label「复盘」；掺了别的工作往来：没有 label 字段；复盘卡的箭头由卡片接收者决定，小结没有箭头', () => {
    const card = message('m_1', { kind: 'job_card', refId: 'retro:sr_0000000001:b_0000000002', text: '复盘　林舟　活动报名页' });
    const summary = message('m_2', { from: 'hub', kind: 'work', refId: 'retro-summary:sr_0000000001', text: '复盘没有新的技能更新。', createdAt: 2_000 });
    const [pure] = view([card, summary]);
    expect(pure).toMatchObject({ kind: 'fold', count: 2, label: '复盘' });
    const other = message('m_3', { refId: 'jev_0000000001', text: '交回了', createdAt: 500 });
    const [mixed] = view([other, card, summary]);
    expect(mixed).toMatchObject({ kind: 'fold', count: 3 });
    expect('label' in mixed!).toBe(false);
    const [arrow] = topicFloorsView({
      messages: [card, summary], names: { b_0000000002: '林舟', b_0000000003: '评审甲' }, events: {}, commitSenders: {}, chiefId: 'b_0000000001', timezone: 'Asia/Shanghai',
      cardTitleOf: () => '林舟　活动报名页', cardRecipientsOf: () => ['评审甲'],
    }).items.filter(item => item.kind === 'fold');
    expect((arrow as { messages: Array<{ fromName: string; toNames: string[] }> }).messages.map(row => [row.fromName, row.toNames])).toEqual([['林舟', ['评审甲']], ['Agent 中心', []]]);
  });
});

describe('18 全程对主人安静', () => {
  it('从验收刚完成到复盘提交、评审员复盘、总管核对唤醒入队：「待你处理」条目数、单推次数、所有私聊消息数都不变', async () => {
    const { fix, job } = await flow({ rejectFirst: true, ownerReturn: THIRD_BACK, topicMessages: ['以后不要在提示文字里用感叹号'] });
    const start = ownerNoise(fix);
    const run = retroRun(fix, job.id)!;
    // 林舟的复盘回合：提交一条更新，最后 hub_commit（带 reply 与一条高重要度汇报）。
    const executor = await retroTurn(fix, fix.engineer.id);
    const srcs = srcsIn(executor.packet);
    expect(await callTool(fix, bot(fix, fix.engineer.id), 'hub_skill', { mode: 'propose', updates: [{ title: '失败路径自查', whenToUse: '交回之前', sentences: [
      { text: '交回前断开接口试一次失败提示', sources: [srcs[0]!.src] }] }] })).toMatchObject({ ok: true });
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '复盘完成', reply: '已提交一条技能更新。', report: '重要汇报', importance: 10 });
    expect(ownerNoise(fix)).toEqual(start);
    // 评审员的复盘回合：提交自己的更新（等总管核对），也收尾。
    const reviewer = await retroTurn(fix, fix.reviewer.id);
    const mine = srcsIn(reviewer.packet);
    expect(await callTool(fix, bot(fix, fix.reviewer.id), 'hub_skill', { mode: 'propose', updates: [{ title: '核对要试失败路径', whenToUse: '核对表单页时', sentences: [
      { text: '核对表单页时断开接口试一次', sources: [mine[0]!.src] }] }] })).toMatchObject({ ok: true });
    await commitAndEnd(fix, fix.reviewer.id, { outcome: 'progress', summary: '复盘完成', reply: '已提交。' });
    expect(ownerNoise(fix)).toEqual(start);
    // 总管的核对唤醒已入队（核对本身是下一张卡）；再走几个 tick 也不打扰主人。
    expect(skillKeysQueued(fix, fix.chief.id)).toEqual([`skillcheck:${run.id}:${fix.chief.id}`]);
    await tick(fix, 5 * MINUTE);
    expect(ownerNoise(fix)).toEqual(start);
    expect(theJob(fix).state).toBe('done');
  });
});

describe('19 主人看得见的提示、卡片、小结不含内部名称', () => {
  it('主题里新增的每一条消息（提示、复盘卡文字、小结、回复）和卡片视图都不含 hub_、src、sk_、su_、sr_、b_', async () => {
    const { fix, job } = await flow({ rejectFirst: true, ownerReturn: THIRD_BACK, topicMessages: ['以后不要在提示文字里用感叹号'] });
    const before = new Set(threadOf(fix.ctx, job.topicId).map(row => row.id));
    const executor = await retroTurn(fix, fix.engineer.id);
    const srcs = srcsIn(executor.packet);
    await callTool(fix, bot(fix, fix.engineer.id), 'hub_skill', { mode: 'propose', updates: [{ title: '失败路径自查', whenToUse: '交回之前', sentences: [{ text: '交回前断开接口试一次失败提示', sources: [srcs[0]!.src] }] }] });
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '复盘完成', reply: '已提交一条技能更新。' });
    const reviewer = await retroTurn(fix, fix.reviewer.id);
    await callTool(fix, bot(fix, fix.reviewer.id), 'hub_skill', { mode: 'propose', updates: [], note: '没有可复用的做法' });
    await commitAndEnd(fix, fix.reviewer.id, { outcome: 'progress', summary: '没有', reply: '这次没有可写的。' });
    expect(reviewer.section).toContain('src1');
    const added = threadOf(fix.ctx, job.topicId).filter(row => !before.has(row.id));
    expect(added.length).toBeGreaterThan(0);
    for (const row of added) expect(INTERNAL_NAMES.test(row.text), row.text).toBe(false);
    // 提示（验收之后、复盘之前落的）同样检查。
    for (const row of threadOf(fix.ctx, job.topicId)) if (row.text.includes('可学的出处')) expect(INTERNAL_NAMES.test(row.text), row.text).toBe(false);
    // 卡片视图和折叠组标题。
    for (const group of folds(fix, job.topicId)) {
      expect(INTERNAL_NAMES.test(JSON.stringify({ latest: (group as { latest: string }).latest, label: (group as { label?: string }).label })), JSON.stringify(group)).toBe(false);
    }
  });
});

/**
 * P65 主题里的提问、审批、建议：主人在「待你处理」里处理后，队友接着做的那一回合回到原主题。
 * 用真实 Hub + 假宿主 + 假时钟跑完整链路：提出 → 主人处理 → 后续唤醒带主题 → 回复落在主题里。
 * 每条规则都配一个反例：不在主题里提出的事项照旧落私聊。
 */
import { describe, expect, it } from 'vitest';
import { prepareApproval } from '../src/gate/approvals.js';
import { submitProposal } from '../src/outreach/proposals.js';
import { floors, lastPacket, openTopic, queued, runningWake, speak, topicHub } from './p63-topic-fixtures.js';
import { PROPOSAL, ask, expectOk, followUpOf, privateThread } from './p65-topic-followup-fixtures.js';

describe('P65 主题里的提问：回答后回到主题', () => {
  it('回答后接着做的那一回合带主题、算主人发起，回复落在主题里，私聊不多一条', async () => {
    const fix = await topicHub();
    const [owner] = fix.bots;
    const topicId = await openTopic(fix, '开工');
    const item = await ask(fix, owner!);
    expect(item.topicId).toBe(topicId);
    expectOk(await fix.hub.api.answerInbox(item.id, 'B'));
    const wake = runningWake(fix.ctx, owner!.id)!;
    expect(wake).toMatchObject({ topicId, ownerInitiated: true });
    expect(wake.reason.kind).toBe('inbox_reply');
    // 主题里落一句旁白，读主题的人知道主人答了什么。
    expect(floors(fix.ctx, topicId).at(-1)).toMatchObject({ from: 'hub', kind: 'system', text: '你回答了「选 A 还是 B」：B', refId: item.id });
    // 唤醒包是主题回合的样子，主人的回答也在里面。
    const packet = lastPacket(fix, owner!);
    expect(packet).toContain('## 项目主题讨论');
    expect(packet).toContain('主人回复「选 A 还是 B」：B');
    await speak(fix, owner!, '好，按 B 做');
    expect(floors(fix.ctx, topicId).at(-1)).toMatchObject({ from: owner!.id, kind: 'reply', text: '好，按 B 做' });
    expect(privateThread(fix.ctx, owner!.id)).toEqual([]);
  });

  it('提问卡在主题里也能直接答（同一张收件箱卡），效果一样', async () => {
    const fix = await topicHub();
    const [owner] = fix.bots;
    const topicId = await openTopic(fix, '开工');
    await ask(fix, owner!);
    const card = (await fix.hub.api.thread(topicId)).messages.find(row => row.kind === 'question')!.card!;
    expectOk(await fix.hub.api.answerInbox(card.inboxId, 'A'));
    expect(runningWake(fix.ctx, owner!.id)).toMatchObject({ topicId });
  });

  it('反例：私聊里的提问，回答后照旧落私聊，主题不受影响', async () => {
    const fix = await topicHub();
    const [owner] = fix.bots;
    const topicId = await openTopic(fix, '开工');
    await speak(fix, owner!, '收到');
    expectOk(await fix.hub.api.sendMessage(owner!.id, '私聊问一句'));
    const item = await ask(fix, owner!);
    expect(item.topicId).toBeUndefined();
    const before = floors(fix.ctx, topicId).length;
    expectOk(await fix.hub.api.answerInbox(item.id, 'B'));
    expect(runningWake(fix.ctx, owner!.id)!.topicId).toBeUndefined();
    expect(privateThread(fix.ctx, owner!.id).at(-1)).toMatchObject({ from: 'owner', kind: 'reply', text: '「选 A 还是 B」：B' });
    await speak(fix, owner!, '好');
    expect(privateThread(fix.ctx, owner!.id).at(-1)).toMatchObject({ from: owner!.id, kind: 'reply', text: '好' });
    expect(floors(fix.ctx, topicId)).toHaveLength(before);
  });
});

describe('P65 主人的回答算主人在主题里说了一句，但只叫提问的那位', () => {
  it('计数清零、等待名单加上它；负责人不被叫；别人还在排的回合不取消', async () => {
    const fix = await topicHub();
    const [boss, wang, li] = fix.bots;
    const topicId = await openTopic(fix, '@小王 @小李 @老大 各看一眼');
    // 主人在场时同一时间只跑一个：小王先说并提问，说完后另外两位一个在跑、一个在排。
    const item = await ask(fix, wang!);
    fix.ctx.store.table('projectTopics').patch(topicId, { agentTurnsSinceOwner: 5 });
    const wakesBefore = fix.ctx.store.table('wakes').count();
    expectOk(await fix.hub.api.answerInbox(item.id, 'A'));
    const topic = fix.ctx.store.table('projectTopics').get(topicId)!;
    expect(topic.agentTurnsSinceOwner).toBe(0);
    expect([...topic.pendingBotIds].sort()).toEqual([boss!.id, wang!.id, li!.id].sort());
    // 小王排进这个主题；另外两位原来的回合都还在（一个在跑，一个在排），没有被取消。
    expect(queued(fix.ctx, wang!.id, topicId)).toMatchObject({ topicId, ownerInitiated: true });
    for (const bot of [boss!, li!]) expect(Boolean(runningWake(fix.ctx, bot.id)) || Boolean(queued(fix.ctx, bot.id, topicId))).toBe(true);
    // 这次处理本身没有多叫醒任何人：唤醒单数量不变，小王等前面的人说完再跑。
    expect(fix.ctx.store.table('wakes').count()).toBe(wakesBefore);
  });

  it('提问的是成员：只叫它，负责人这时不被叫；它说完没 @ 人，按原有接力规则交回负责人', async () => {
    const fix = await topicHub();
    const [boss, wang] = fix.bots;
    const topicId = await openTopic(fix, '@小王 先看');
    const item = await ask(fix, wang!);
    await speak(fix, boss!, '等主人定'); // 小王说完交回负责人，负责人说完这一轮结束
    expect(fix.ctx.store.table('projectTopics').get(topicId)!.pendingBotIds).toEqual([]);
    expectOk(await fix.hub.api.answerInbox(item.id, 'A'));
    expect(runningWake(fix.ctx, wang!.id)).toMatchObject({ topicId });
    expect(runningWake(fix.ctx, boss!.id)).toBeUndefined();
    expect(queued(fix.ctx, boss!.id, topicId)).toBeUndefined();
    await speak(fix, wang!, '按 A 做完了');
    expect(runningWake(fix.ctx, boss!.id)).toMatchObject({ topicId });
  });

  it('提问的是负责人：它接着说完，这一轮就结束，不再叫别人', async () => {
    const fix = await topicHub();
    const [boss] = fix.bots;
    const topicId = await openTopic(fix, '开工');
    const item = await ask(fix, boss!);
    expectOk(await fix.hub.api.answerInbox(item.id, 'A'));
    await speak(fix, boss!, '按 A 做完了');
    expect(fix.ctx.store.table('projectTopics').get(topicId)).toMatchObject({ pendingBotIds: [], agentTurnsSinceOwner: 1 });
    expect(fix.ctx.store.table('wakes').count(wake => wake.status === 'running')).toBe(0);
    expect(fix.ctx.store.table('queue').count()).toBe(0);
  });

  it('同一个回答只叫醒一次：感知收集器不会再排一条不带主题的私聊唤醒', async () => {
    const fix = await topicHub();
    const [owner] = fix.bots;
    await openTopic(fix, '开工');
    const item = await ask(fix, owner!);
    expectOk(await fix.hub.api.answerInbox(item.id, 'B'));
    const wake = runningWake(fix.ctx, owner!.id)!;
    const percept = fix.ctx.store.table('percepts').list(row => row.kind === 'inbox_reply' && row.location === item.id)[0]!;
    expect(percept.evaluatedAt).toBeDefined();
    expect(percept.consumedByWake).toBe(wake.id);
    expect(fix.ctx.store.table('queue').count(row => row.botId === owner!.id && !row.topicId)).toBe(0);
    fix.ctx.clock.advance(60_000);
    await fix.hub.tick();
    expect(fix.ctx.store.table('queue').count(row => row.botId === owner!.id && !row.topicId)).toBe(0);
    expect(fix.ctx.store.table('wakes').count(row => row.botId === owner!.id && row.reason.kind === 'inbox_reply')).toBe(1);
  });
});

describe('P65 主题里的审批：批准或拒绝后回到主题', () => {
  it('批准：记下来源主题，接着做的那一回合回到主题，主题里落「你批准了」，私聊的审批记录照旧', async () => {
    const fix = await topicHub();
    const [owner] = fix.bots;
    const topicId = await openTopic(fix, '开工');
    const { approval } = prepareApproval(fix.ctx, owner!.id, 'write_file', { path: '/x' }, 'C', '要写文件');
    expect(approval.topicId).toBe(topicId);
    expect(fix.ctx.store.table('inbox').list(row => row.refId === approval.id)[0]?.topicId).toBe(topicId);
    await speak(fix, owner!, '等你批准');
    expectOk(await fix.hub.api.decideApproval(approval.id, true));
    const wake = runningWake(fix.ctx, owner!.id)!;
    expect(wake).toMatchObject({ topicId, ownerInitiated: true });
    expect(wake.reason.kind).toBe('approval_decided');
    // 审批结果感知不会被收集器再排成一条私聊唤醒。
    expect(fix.ctx.store.table('queue').count(row => row.botId === owner!.id && !row.topicId)).toBe(0);
    const note = floors(fix.ctx, topicId).at(-1)!;
    expect(note).toMatchObject({ from: 'hub', kind: 'system', refId: approval.id });
    expect(note.text).toMatch(/^你批准了：/);
    expect(lastPacket(fix, owner!)).toContain('## 审批结果');
    // 审批卡在私聊里：卡片和结果那句照旧在私聊。
    expect(privateThread(fix.ctx, owner!.id).map(row => row.kind)).toEqual(['approval', 'system']);
    await speak(fix, owner!, '已经写好了');
    expect(floors(fix.ctx, topicId).at(-1)).toMatchObject({ from: owner!.id, kind: 'reply', text: '已经写好了' });
    expect(privateThread(fix.ctx, owner!.id).some(row => row.kind === 'reply')).toBe(false);
  });

  it('拒绝：同样回到主题，旁白写「你拒绝了」并带上附言', async () => {
    const fix = await topicHub();
    const [owner] = fix.bots;
    const topicId = await openTopic(fix, '开工');
    const { approval } = prepareApproval(fix.ctx, owner!.id, 'write_file', { path: '/x' }, 'C', '要写文件');
    await speak(fix, owner!, '等你批准');
    expectOk(await fix.hub.api.decideApproval(approval.id, false, '先别动'));
    expect(runningWake(fix.ctx, owner!.id)).toMatchObject({ topicId });
    const note = floors(fix.ctx, topicId).at(-1)!.text;
    expect(note).toMatch(/^你拒绝了：/);
    expect(note).toContain('你的附言：先别动');
  });

  it('反例：不在主题回合里申请的审批，不记主题，决定后照旧落私聊', async () => {
    const fix = await topicHub();
    const [owner] = fix.bots;
    const topicId = await openTopic(fix, '开工');
    await speak(fix, owner!, '收到');
    const { approval } = prepareApproval(fix.ctx, owner!.id, 'write_file', { path: '/y' }, 'C', '要写文件');
    expect(approval.topicId).toBeUndefined();
    const before = floors(fix.ctx, topicId).length;
    expectOk(await fix.hub.api.decideApproval(approval.id, true));
    const followUp = followUpOf(fix.ctx, approval.id, 'approval_decided')!;
    expect(followUp.topicId).toBeUndefined();
    expect(followUp.ownerInitiated).toBe(false);
    expect(floors(fix.ctx, topicId)).toHaveLength(before);
  });
});

describe('P65 主题里的建议：接受或不做后回到主题', () => {
  it('交账里的建议记下来源主题；接受后回到主题，主题里落「你接受了建议」，私聊照旧记一笔', async () => {
    const fix = await topicHub();
    const [owner] = fix.bots;
    const topicId = await openTopic(fix, '开工');
    await speak(fix, owner!, '我有个建议', { outcome: 'progress', proposals: [PROPOSAL] });
    const item = fix.ctx.store.table('inbox').list(row => row.type === 'proposal' && row.status === 'open')[0]!;
    expect(item.topicId).toBe(topicId);
    expectOk(await fix.hub.api.answerInbox(item.id, '接受'));
    const wake = runningWake(fix.ctx, owner!.id)!;
    expect(wake).toMatchObject({ topicId, ownerInitiated: true });
    expect(fix.ctx.store.table('queue').count(row => row.botId === owner!.id && !row.topicId)).toBe(0);
    expect(floors(fix.ctx, topicId).at(-1)).toMatchObject({ kind: 'system', text: '你接受了建议「每天早上看一眼日志」。' });
    // 建议卡在私聊里，私聊照旧记下主人的选择。
    expect(privateThread(fix.ctx, owner!.id).map(row => [row.kind, row.from])).toEqual([['proposal', owner!.id], ['reply', 'owner']]);
    await speak(fix, owner!, '好的，明早开始');
    expect(floors(fix.ctx, topicId).at(-1)).toMatchObject({ from: owner!.id, kind: 'reply', text: '好的，明早开始' });
  });

  it('不做：同样回到主题，旁白写没有采纳', async () => {
    const fix = await topicHub();
    const [owner] = fix.bots;
    const topicId = await openTopic(fix, '开工');
    await speak(fix, owner!, '我有个建议', { outcome: 'progress', proposals: [PROPOSAL] });
    const item = fix.ctx.store.table('inbox').list(row => row.type === 'proposal' && row.status === 'open')[0]!;
    expectOk(await fix.hub.api.answerInbox(item.id, '不做'));
    expect(runningWake(fix.ctx, owner!.id)).toMatchObject({ topicId });
    expect(floors(fix.ctx, topicId).at(-1)!.text).toBe('你没有采纳建议「每天早上看一眼日志」。');
  });

  it('工具里提的建议按正在进行的主题回合记来源；反例：不在主题回合里提的不记', async () => {
    const fix = await topicHub();
    const [owner] = fix.bots;
    const topicId = await openTopic(fix, '开工');
    const during = await submitProposal(fix.ctx, owner!.id, { ...PROPOSAL, title: '主题里提的' });
    expect(during?.topicId).toBe(topicId);
    await speak(fix, owner!, '收到');
    const after = await submitProposal(fix.ctx, owner!.id, { ...PROPOSAL, title: '主题外提的' });
    expect(after?.topicId).toBeUndefined();
  });

  it('反例：私聊回合交账里的建议明确记成不属于主题', async () => {
    const fix = await topicHub();
    const [owner] = fix.bots;
    await openTopic(fix, '开工');
    await speak(fix, owner!, '收到');
    expectOk(await fix.hub.api.sendMessage(owner!.id, '私聊说一句'));
    await speak(fix, owner!, '我有个建议', { outcome: 'progress', proposals: [PROPOSAL] });
    const item = fix.ctx.store.table('inbox').list(row => row.type === 'proposal')[0]!;
    expect(item.topicId).toBeUndefined();
  });
});

describe('P65 待你处理视图带上来源主题', () => {
  it('来自主题的事项带主题 id 和主题名；反例：私聊里的不带，主题删掉后也不带', async () => {
    const fix = await topicHub();
    const [owner] = fix.bots;
    const topicId = await openTopic(fix, '竞品周报怎么做\n先看三家');
    const fromTopic = await ask(fix, owner!);
    expectOk(await fix.hub.api.sendMessage(owner!.id, '私聊问一句'));
    const fromChat = await ask(fix, owner!);
    const view = (id: string) => fix.hub.api.inbox().items.find(row => row.id === id)!;
    expect(view(fromTopic.id)).toMatchObject({ topicId, topicTitle: '竞品周报怎么做' });
    expect(view(fromChat.id)).toMatchObject({ topicId: null, topicTitle: null });
    fix.ctx.store.table('projectTopics').remove(topicId);
    expect(view(fromTopic.id)).toMatchObject({ topicId: null, topicTitle: null });
  });
});

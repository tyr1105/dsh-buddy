/**
 * P75c 的测试（一）：总管「记住」（hub_memory 的 note）。
 *
 * 全部走真实的 Hub：主人在总管私聊或主题里说话，总管拿到唤醒包，工具调用的参数只来自唤醒包里的文字；
 * 交账后「已记住」挂在总管的回复下面；没有回复时回合结束由中心补落。
 * 每条拒绝规则各一例，断言错误文字，并断言没有写入。
 */
import { describe, expect, it } from 'vitest';
import { newId } from '../src/util/ids.js';
import { postThread } from '../src/outreach/thread.js';
import { wakeForOwnerMessage } from '../src/outreach/thread.js';
import { NOTE_DONE_TEXT, NOTE_NO_TRIGGER_TEXT, NOTE_NOT_OWN_WORDS_TEXT, NOTE_NOT_OWNER_TURN_TEXT } from '../src/memory/note.js';
import { floors, openTopic } from './p63-topic-fixtures.js';
import {
  agentsMdOf, bot, callTool, chiefHears, jobFix, lastPacket, memoriesOf, messagesIn, noteArgs, noted, ownerSays, speak, staffNamesIn,
} from './p75c-fixtures.js';

describe('只用唤醒包里的文字调用成功', () => {
  it('主人在总管私聊说「以后……」：从唤醒包读出员工名字，note 成功；交账后回复的视图带 memoryNotes', async () => {
    const fix = await jobFix();
    const packet = await chiefHears(fix, '以后页面上的提示文字都用「请」字开头');
    // 唤醒包里有总管守则第 13 条和员工名字；参数只用这里读出的文字。
    expect(packet).toContain('13. 主人的话里有「以后」');
    const names = staffNamesIn(packet);
    expect(names).toEqual(expect.arrayContaining(['林舟', '评审甲']));
    const result = await callTool(fix, fix.chief, 'hub_memory', noteArgs());
    expect(result, JSON.stringify(result)).toEqual({ ok: true, text: NOTE_DONE_TEXT });
    const [memory] = memoriesOf(fix.ctx);
    expect(memory).toMatchObject({ kind: 'rule', status: 'active', redLine: false, replyMessageId: null,
      scope: { staff: 'all', projects: 'all' }, source: { kind: 'owner_words', threadId: fix.chief.id, quote: '以后页面上的提示文字都用「请」字开头' } });
    expect(memory!.noteWakeId).not.toBeNull();
    // 身份文件立刻带上这一条（总管和执行员工都有）。
    for (const who of [fix.chief, fix.engineer]) {
      const text = await agentsMdOf(fix.ctx, bot(fix, who.id));
      expect(text).toContain('## 主人的规矩与偏好（全队共用，中心维护）');
      expect(text).toContain('- 规矩：页面上的提示文字都用「请」字开头（例如：写「请输入手机号」，不写「输入手机号」）');
    }
    await speak(fix, fix.chief, '已记住：页面上的提示文字都用「请」字开头，例如写「请输入手机号」。适用于全部员工。', { outcome: 'progress' });
    const view = fix.hub.api.thread(fix.chief.id);
    const reply = view.messages.find(row => row.from === fix.chief.id && row.kind === 'reply')!;
    // P75r1：「已记住」一行多了两个字段：主人原话一行、适用范围一行（原来只有前六项）。
    expect(reply.memoryNotes).toEqual([{ memoryId: memory!.id, kindLabel: '规矩', action: 'noted', text: memory!.text, state: 'active', canUndo: true,
      quoteLine: '你说：「以后页面上的提示文字都用「请」字开头」', scopeLine: '用于全部员工、全部项目' }]);
    expect(fix.ctx.store.table('memories').get(memory!.id)!.replyMessageId).toBe(reply.id);
    // 没有挂靠的消息不带这个字段。
    expect(view.messages.filter(row => row.id !== reply.id).every(row => row.memoryNotes === undefined)).toBe(true);
  });

  it('员工名字取自唤醒包：staff 写「林舟」时只进林舟的身份文件，不进评审甲的', async () => {
    const fix = await jobFix();
    const packet = await chiefHears(fix, '以后林舟交东西都先发我一份截图');
    const name = staffNamesIn(packet).find(item => item === '林舟')!;
    const result = await callTool(fix, fix.chief, 'hub_memory', noteArgs({ staff: name, kind: 'preference', text: '交东西先发一份截图', example: undefined }));
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(memoriesOf(fix.ctx)[0]!.scope.staff).toEqual([fix.engineer.id]);
    expect(await agentsMdOf(fix.ctx, bot(fix, fix.engineer.id))).toContain('- 偏好：交东西先发一份截图');
    expect(await agentsMdOf(fix.ctx, bot(fix, fix.reviewer.id))).not.toContain('交东西先发一份截图');
  });

  it('在主题里说话：出处线程是这个主题，回复落在主题里，楼层带 memoryNotes', async () => {
    const fix = await jobFix();
    const topicId = await openTopic(fix, '帮我整理一下登录页的文案');
    await speak(fix, fix.chief, '收到，我来看。', { outcome: 'progress' });
    await ownerSays(fix, topicId, '以后登录页的提示都用「请」字开头');
    expect(await callTool(fix, fix.chief, 'hub_memory', noteArgs())).toMatchObject({ ok: true });
    await speak(fix, fix.chief, '已记住：页面上的提示文字都用「请」字开头，例如写「请输入手机号」。适用于全部员工。', { outcome: 'progress' });
    const memory = memoriesOf(fix.ctx)[0]!;
    expect(memory.source.threadId).toBe(topicId);
    const floorsView = fix.hub.api.thread(topicId).floors!;
    const withNote = floorsView.items.filter(item => item.kind === 'floor' && item.memoryNotes !== undefined);
    expect(withNote).toHaveLength(1);
    expect(withNote[0]).toMatchObject({ kind: 'floor', message: { from: fix.chief.id, kind: 'reply' }, memoryNotes: [{ memoryId: memory.id, state: 'active' }] });
    expect(floors(fix.ctx, topicId).find(row => row.id === memory.replyMessageId)?.from).toBe(fix.chief.id);
  });
});

describe('拒绝：错误文字与「没有写入」', () => {
  it('不是总管', async () => {
    const fix = await jobFix();
    await chiefHears(fix, '以后都先发截图');
    const result = await callTool(fix, fix.engineer, 'hub_memory', noteArgs());
    expect(result).toEqual({ ok: false, error: '只有总管能记主人的规矩' });
    expect(memoriesOf(fix.ctx)).toHaveLength(0);
  });

  it('不是主人发起的回合', async () => {
    const fix = await jobFix();
    await chiefHears(fix, '以后页面提示都用请字开头');
    const wake = fix.ctx.store.table('wakes').list(row => row.botId === fix.chief.id && row.status === 'running')[0]!;
    fix.ctx.store.table('wakes').patch(wake.id, { ownerInitiated: false });
    expect(await callTool(fix, fix.chief, 'hub_memory', noteArgs())).toEqual({ ok: false, error: NOTE_NOT_OWNER_TURN_TEXT });
    expect(memoriesOf(fix.ctx)).toHaveLength(0);
  });

  it('主人的话里没有触发词：「把这一页的按钮颜色改深一点」', async () => {
    const fix = await jobFix();
    await chiefHears(fix, '把这一页的按钮颜色改深一点');
    const result = await callTool(fix, fix.chief, 'hub_memory', noteArgs({ text: '按钮颜色改深一点', example: '主按钮用深蓝' }));
    expect(result).toEqual({ ok: false, error: NOTE_NO_TRIGGER_TEXT });
    expect(memoriesOf(fix.ctx)).toHaveLength(0);
  });

  it('三问的回答（消息带着三问记录的编号）不能作为出处', async () => {
    const fix = await jobFix();
    // 与真实的三问点选一致：中心以主人名义落的那条话，refId 是三问记录的编号；这里再让总管被它叫醒。
    const message = postThread(fix.ctx, { thread: fix.chief.id, from: 'owner', kind: 'chat', text: '以后选项统一选有', refId: newId('tsu', fix.ctx.rng) });
    wakeForOwnerMessage(fix.ctx, bot(fix, fix.chief.id), message);
    await fix.hub.tick();
    expect(lastPacket(fix, bot(fix, fix.chief.id))).toContain('13. ');
    const result = await callTool(fix, fix.chief, 'hub_memory', noteArgs());
    expect(result).toEqual({ ok: false, error: NOTE_NOT_OWN_WORDS_TEXT });
    expect(memoriesOf(fix.ctx)).toHaveLength(0);
  });

  it('员工名字找不到、规矩没写例子、文字里有内部名称：一次列全', async () => {
    const fix = await jobFix();
    await chiefHears(fix, '以后页面提示都用请字开头');
    const result = await callTool(fix, fix.chief, 'hub_memory', noteArgs({ staff: '林舟、不存在的人', example: undefined, text: '先用 hub_send 告诉他们' }));
    expect(result.ok).toBe(false);
    const error = result.error!;
    expect(error).toContain('找不到这些员工：不存在的人');
    expect(error).toContain('example：规矩必须写一个例子');
    expect(error).toContain('text：「hub_send」是内部名称');
    expect(memoriesOf(fix.ctx)).toHaveLength(0);
  });

  it('项目名找不到', async () => {
    const fix = await jobFix();
    await chiefHears(fix, '以后页面提示都用请字开头');
    const result = await callTool(fix, fix.chief, 'hub_memory', noteArgs({ projects: '不存在的项目' }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('找不到这些项目：不存在的项目');
    expect(memoriesOf(fix.ctx)).toHaveLength(0);
  });

  it('同一回合第 3 条被拒绝，前两条保留', async () => {
    const fix = await jobFix();
    await chiefHears(fix, '以后提示都用请字开头，还有按钮都用圆角，还有标题都加粗');
    expect(await callTool(fix, fix.chief, 'hub_memory', noteArgs({ text: '提示都用请字开头' }))).toMatchObject({ ok: true });
    expect(await callTool(fix, fix.chief, 'hub_memory', noteArgs({ text: '按钮都用圆角' }))).toMatchObject({ ok: true });
    const third = await callTool(fix, fix.chief, 'hub_memory', noteArgs({ text: '标题都加粗' }));
    expect(third.ok).toBe(false);
    expect(third.error).toContain('同一回合最多记 2 条');
    expect(memoriesOf(fix.ctx)).toHaveLength(2);
  });

  it('回合证据里没有主人的消息', async () => {
    const fix = await jobFix();
    await chiefHears(fix, '以后页面提示都用请字开头');
    const wake = fix.ctx.store.table('wakes').list(row => row.botId === fix.chief.id && row.status === 'running')[0]!;
    fix.ctx.store.table('wakes').patch(wake.id, { reason: { ...wake.reason, evidence: [] } });
    expect(await callTool(fix, fix.chief, 'hub_memory', noteArgs())).toEqual({ ok: false, error: NOTE_NOT_OWNER_TURN_TEXT });
    expect(memoriesOf(fix.ctx)).toHaveLength(0);
  });

  it('参数校验：mode、kind、text 长度的中文错误', async () => {
    const fix = await jobFix();
    await chiefHears(fix, '以后页面提示都用请字开头');
    expect((await callTool(fix, fix.chief, 'hub_memory', noteArgs({ mode: 'remove' }))).error).toContain('mode：必须是 note、forget、correct 之一');
    expect((await callTool(fix, fix.chief, 'hub_memory', noteArgs({ kind: 'precedent' }))).error).toContain('kind：必须是 rule 或 preference');
    expect((await callTool(fix, fix.chief, 'hub_memory', noteArgs({ text: '长'.repeat(121) }))).error).toContain('text：不能超过 120 字');
    expect(memoriesOf(fix.ctx)).toHaveLength(0);
  });
});

describe('「要我以后都这样吗」与中心补落', () => {
  it('上一回合总管回复以追问句结尾，主人回「是」：note 成功，出处含两条消息，quote 含原先那句话', async () => {
    const fix = await jobFix();
    await chiefHears(fix, '这个页面的按钮都用圆角');
    await speak(fix, fix.chief, '已改好：把按钮由直角改为圆角，其他不变。要我以后都这样吗？', { outcome: 'progress' });
    await chiefHears(fix, '是');
    const result = await callTool(fix, fix.chief, 'hub_memory', noteArgs({ text: '按钮都用圆角', example: '确定按钮用 8 像素圆角' }));
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    const memory = memoriesOf(fix.ctx)[0]!;
    expect(memory.source.messageIds).toHaveLength(2);
    expect(memory.source.quote).toContain('这个页面的按钮都用圆角');
    expect(memory.source.quote).toContain('是');
    const texts = messagesIn(fix.ctx, fix.chief.id).filter(row => memory.source.messageIds.includes(row.id)).map(row => row.text);
    expect(texts).toEqual(['这个页面的按钮都用圆角', '是']);
  });

  it('上一条回复没有追问句：主人只回「是」，被拒绝', async () => {
    const fix = await jobFix();
    await chiefHears(fix, '这个页面的按钮都用圆角');
    await speak(fix, fix.chief, '已改好：把按钮由直角改为圆角，其他不变。', { outcome: 'progress' });
    await chiefHears(fix, '是');
    expect(await callTool(fix, fix.chief, 'hub_memory', noteArgs())).toEqual({ ok: false, error: NOTE_NO_TRIGGER_TEXT });
    expect(memoriesOf(fix.ctx)).toHaveLength(0);
  });

  it('交账没有成功、回合没有 reply 就结束：回合结束时中心补落「已记住：……。」，视图挂在这条上', async () => {
    const fix = await jobFix();
    await chiefHears(fix, '以后页面上的提示文字都用「请」字开头');
    expect(await callTool(fix, fix.chief, 'hub_memory', noteArgs())).toMatchObject({ ok: true });
    // 主人发话的回合 reply 必填，不带 reply 的交账被拒绝（交账失败），回合随后结束。
    const rejected = await callTool(fix, fix.chief, 'hub_commit', { outcome: 'progress', summary: '记下了', worldChanges: [], evidence: [],
      verification: { level: 'none', notCovered: '无' }, blocker: null, nextThink: { mode: 'auto', reason: '等待' }, ownerQuestion: null, reply: null, report: null, importance: 5, proposals: [] });
    expect(rejected.ok).toBe(false);
    await fix.hub.onTurnEvent({ type: 'ended', sessionId: bot(fix, fix.chief.id).sessionId!, at: fix.ctx.clock.now(), finalText: '', tokens: 100 });
    const memory = memoriesOf(fix.ctx)[0]!;
    const added = messagesIn(fix.ctx, fix.chief.id).find(row => row.id === memory.replyMessageId)!;
    expect(added).toMatchObject({ from: fix.chief.id, kind: 'reply', text: `已记住：${memory.text}。` });
    const view = fix.hub.api.thread(fix.chief.id).messages.find(row => row.id === added.id)!;
    expect(view.memoryNotes).toHaveLength(1);
    expect(view.memoryNotes![0]).toMatchObject({ memoryId: memory.id, state: 'active' });
  });

  it('回合根本没有交账（合成交账，落「机器人没有回复」）：同样补落，不会无处显示', async () => {
    const fix = await jobFix();
    await chiefHears(fix, '以后页面上的提示文字都用「请」字开头');
    expect(await callTool(fix, fix.chief, 'hub_memory', noteArgs())).toMatchObject({ ok: true });
    await fix.hub.onTurnEvent({ type: 'ended', sessionId: bot(fix, fix.chief.id).sessionId!, at: fix.ctx.clock.now(), finalText: '', tokens: 100 });
    const memory = memoriesOf(fix.ctx)[0]!;
    expect(memory.replyMessageId).not.toBeNull();
    expect(messagesIn(fix.ctx, fix.chief.id).find(row => row.id === memory.replyMessageId)!.text).toBe(`已记住：${memory.text}。`);
  });

  it('其他回合不出现「已记住」', async () => {
    const fix = await jobFix();
    const { memory } = await noted(fix);
    const before = messagesIn(fix.ctx, fix.chief.id).filter(row => row.text.startsWith('已记住')).length;
    expect(before).toBe(1);
    // 之后的普通回合：没有记忆挂靠，也没有新的「已记住」。
    await chiefHears(fix, '把这一页的标题改大一点');
    await speak(fix, fix.chief, '已改好：把标题由 16 号改为 20 号，其他不变。', { outcome: 'progress' });
    expect(messagesIn(fix.ctx, fix.chief.id).filter(row => row.text.startsWith('已记住')).length).toBe(1);
    expect(fix.ctx.store.table('memories').get(memory.id)!.replyMessageId).not.toBeNull();
  });
});

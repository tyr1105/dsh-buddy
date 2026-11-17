/**
 * P75d 的测试（三）：对话里删掉、改掉记住的某条（hub_memory 的 forget、correct）。
 * （P75r1：原先「约定卡上改了引用记忆的条目时更正记忆」的两条测试随这条自动更正路径一起删除，见 docs/progress/P75r1.md。）
 * 全部走真实的 Hub：主人说话，总管拿到唤醒包，memoryId 只用正则从唤醒包「可引用的出处」里取。
 */
import { describe, expect, it } from 'vitest';
import { agentsMdOf, bot, callTool, chiefHears, jobFix, memoriesOf, messagesIn, noted, speak, type JobFix } from './p75c-fixtures.js';

const OLD = '页面上的提示文字都用「请」字开头';

/** 只从唤醒包里取规矩的编号。 */
function ruleIdIn(packet: string): string {
  const match = /^(mem_[0-9a-z]{10})：页面上的提示文字/m.exec(packet);
  expect(match, '唤醒包「可引用的出处」里应该有这条规矩').not.toBeNull();
  return match![1]!;
}

/** 总管私聊里最后一条总管的回复。 */
function lastChiefReply(fix: JobFix) {
  return fix.hub.api.thread(fix.chief.id).messages.filter(row => row.from === fix.chief.id && row.kind === 'reply').at(-1)!;
}

describe('只用唤醒包里的文字调用成功', () => {
  it('主人说「把『请』字那条删了」：forget 成功；回复下挂「已删除」行；撤销后恢复', async () => {
    const fix = await jobFix();
    const { memory } = await noted(fix);
    const packet = await chiefHears(fix, '把「请」字那条删了');
    const id = ruleIdIn(packet);
    expect(id).toBe(memory.id);
    const result = await callTool(fix, fix.chief, 'hub_memory', { mode: 'forget', memoryId: id });
    expect(result, JSON.stringify(result)).toEqual({ ok: true, text: '已删除，回复里写明删掉了什么。' });
    expect(fix.ctx.store.table('memories').get(id)).toMatchObject({ status: 'deleted', history: [{ action: 'deleted', text: OLD, by: 'chief' }] });
    expect(await agentsMdOf(fix.ctx, bot(fix, fix.engineer.id))).not.toContain(OLD);
    await speak(fix, fix.chief, `已删除「${OLD}」。`, { outcome: 'progress' });
    const reply = lastChiefReply(fix);
    // P75r1：删除行多了主人原话一行（对话里删的，记下了主人那句话）；范围一行只给「已记住」，这里是 null。
    const DELETE_QUOTE = '你说：「把「请」字那条删了」';
    expect(reply.memoryNotes).toEqual([{ memoryId: id, kindLabel: '规矩', action: 'deleted', text: OLD, state: 'deleted', canUndo: true, quoteLine: DELETE_QUOTE, scopeLine: null }]);
    // 撤销（撤销删除）：记忆恢复生效，身份文件带回，这一行变为已撤销。
    expect(await fix.hub.api.undoDeleteMemory({ memoryId: id })).toMatchObject({ ok: true });
    expect(fix.ctx.store.table('memories').get(id)!.status).toBe('active');
    expect(await agentsMdOf(fix.ctx, bot(fix, fix.engineer.id))).toContain(OLD);
    expect(lastChiefReply(fix).memoryNotes).toEqual([{ memoryId: id, kindLabel: '规矩', action: 'deleted', text: OLD, state: 'undone', canUndo: false, quoteLine: DELETE_QUOTE, scopeLine: null }]);
  });

  it('主人说「那条改成『提示文字以请或您开头』」：correct 成功；身份文件变为新文字；撤销后恢复旧文字', async () => {
    const fix = await jobFix();
    const { memory } = await noted(fix);
    const id = ruleIdIn(await chiefHears(fix, '那条改成「提示文字以请或您开头」'));
    const NEW = '提示文字以请或您开头';
    const result = await callTool(fix, fix.chief, 'hub_memory', { mode: 'correct', memoryId: id, text: NEW });
    expect(result, JSON.stringify(result)).toEqual({ ok: true, text: '已更正，回复里写明改成了什么。' });
    expect(await agentsMdOf(fix.ctx, bot(fix, fix.engineer.id))).toContain(NEW);
    expect(await agentsMdOf(fix.ctx, bot(fix, fix.engineer.id))).not.toContain(OLD);
    await speak(fix, fix.chief, `已更正为「${NEW}」。`, { outcome: 'progress' });
    const CORRECT_QUOTE = '你说：「那条改成「提示文字以请或您开头」」'; // P75r1：更正行带主人原话一行
    expect(lastChiefReply(fix).memoryNotes).toEqual([{ memoryId: id, kindLabel: '规矩', action: 'corrected', text: NEW, state: 'active', canUndo: true, quoteLine: CORRECT_QUOTE, scopeLine: null }]);
    expect(fix.ctx.store.table('memories').get(id)!.history[0]).toMatchObject({ text: memory.text, action: 'corrected', by: 'chief', undone: false });
    expect(await fix.hub.api.undoCorrectMemory({ memoryId: id })).toMatchObject({ ok: true });
    expect(fix.ctx.store.table('memories').get(id)!.text).toBe(OLD);
    expect(await agentsMdOf(fix.ctx, bot(fix, fix.engineer.id))).toContain(OLD);
    expect(lastChiefReply(fix).memoryNotes).toEqual([{ memoryId: id, kindLabel: '规矩', action: 'corrected', text: OLD, state: 'undone', canUndo: false, quoteLine: CORRECT_QUOTE, scopeLine: null }]);
    // 已撤销的更正不能再撤销。
    expect(await fix.hub.api.undoCorrectMemory({ memoryId: id })).toMatchObject({ ok: false, error: '这一条没有可以撤销的更正' });
  });

  it('本回合没有回复时：回合结束由中心以总管名义补落「已删除」并挂靠', async () => {
    const fix = await jobFix();
    await noted(fix);
    const id = ruleIdIn(await chiefHears(fix, '把「请」字那条删了'));
    expect(await callTool(fix, fix.chief, 'hub_memory', { mode: 'forget', memoryId: id })).toMatchObject({ ok: true });
    // 主人发话的回合 reply 必填，不带 reply 的交账被拒绝，回合随后结束（同 P75c 的补落测试）。
    const rejected = await callTool(fix, fix.chief, 'hub_commit', { outcome: 'progress', summary: '删掉了', worldChanges: [], evidence: [],
      verification: { level: 'none', notCovered: '无' }, blocker: null, nextThink: { mode: 'auto', reason: '等待' }, ownerQuestion: null, reply: null, report: null, importance: 5, proposals: [] });
    expect(rejected.ok).toBe(false);
    await fix.hub.onTurnEvent({ type: 'ended', sessionId: fix.chief.sessionId!, at: fix.ctx.clock.now(), finalText: '', tokens: 100 });
    const posted = messagesIn(fix.ctx, fix.chief.id).filter(row => row.from === fix.chief.id && row.text === `已删除「${OLD}」。`);
    expect(posted).toHaveLength(1);
    expect(fix.ctx.store.table('memories').get(id)!.history[0]!.replyMessageId).toBe(posted[0]!.id);
  });
});

describe('拒绝与参数', () => {
  it('不是总管、不是主人发话的回合、记忆不在用、memoryId 不存在、新文字相同或含内部名称：都被拒且没有改动', async () => {
    const fix = await jobFix();
    const { memory } = await noted(fix);
    // 不是主人发话的回合（总管的回合已结束）。
    const idle = await callTool(fix, fix.chief, 'hub_memory', { mode: 'forget', memoryId: memory.id });
    expect(idle.ok).toBe(false);
    await chiefHears(fix, '把那条删了');
    expect((await callTool(fix, fix.engineer, 'hub_memory', { mode: 'forget', memoryId: memory.id })).ok).toBe(false);
    const missing = await callTool(fix, fix.chief, 'hub_memory', { mode: 'forget', memoryId: 'mem_zzzzzzzzzz' });
    expect(missing.error).toContain('找不到这一条记忆');
    expect((await callTool(fix, fix.chief, 'hub_memory', { mode: 'correct', memoryId: memory.id, text: OLD })).error).toContain('和现在记的一样');
    expect((await callTool(fix, fix.chief, 'hub_memory', { mode: 'correct', memoryId: memory.id, text: '用 hub_send 通知' })).error).toContain('内部名称');
    expect(fix.ctx.store.table('memories').get(memory.id)).toMatchObject({ status: 'active', text: OLD, history: [] });
    await fix.hub.api.undoMemory({ memoryId: memory.id });
    expect((await callTool(fix, fix.chief, 'hub_memory', { mode: 'forget', memoryId: memory.id })).error).toContain('已经不在用了');
  });

  it('每个 mode 只认自己的字段：放错的字段、漏填的字段都报中文错误', async () => {
    const fix = await jobFix();
    const { memory } = await noted(fix);
    await chiefHears(fix, '把那条删了');
    const err = async (args: Record<string, unknown>) => (await callTool(fix, fix.chief, 'hub_memory', args)).error ?? '';
    expect(await err({ mode: 'forget', memoryId: memory.id, text: '多余' })).toContain('text：mode 为 forget 时不用写这一项');
    expect(await err({ mode: 'correct', memoryId: memory.id })).toContain('text：mode 为 correct 时必须写');
    expect(await err({ mode: 'correct', memoryId: memory.id, text: '新', kind: 'rule' })).toContain('kind：mode 为 correct 时不用写这一项');
    expect(await err({ mode: 'note', kind: 'rule', text: '以后都这样', example: '例', memoryId: memory.id })).toContain('memoryId：mode 为 note 时不用写这一项');
    expect(await err({ mode: 'forget' })).toContain('memoryId：mode 为 forget 时必须写');
    expect(memoriesOf(fix.ctx)).toHaveLength(1);
  });
});


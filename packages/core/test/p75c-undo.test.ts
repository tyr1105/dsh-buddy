/**
 * P75c 的测试（二）：撤销（按钮与文字）、更正、删除、撤销删除，以及文字撤销不影响「定了」「验收通过」。
 *
 * 全部走真实的 Hub 和假时钟（每次推进不超过 10 分钟；「24 小时外」「24 小时内」用带时间的记录构造，不一次跳一天）。
 */
import { describe, expect, it } from 'vitest';
import { newId } from '../src/util/ids.js';
import { writeMemory } from '../src/memory/service.js';
import { openTopic } from './p63-topic-fixtures.js';
import { chiefDrafts } from './p74b-fixtures.js';
import { entriesOf, wakesOf } from './p74c-fixtures.js';
import { delivered, theJob } from './p74f-fixtures.js';
import {
  agentsMdOf, bot, chiefHears, jobFix, memoriesOf, messagesIn, noted, ownerSays, speak, MINUTE, type JobFix,
} from './p75c-fixtures.js';

const HOUR = 60 * MINUTE;

/** 总管的唤醒和候选总数：用来断言「没有叫醒总管」。 */
function chiefActivity(fix: JobFix): number {
  return wakesOf(fix, fix.chief.id).length + entriesOf(fix, fix.chief.id).length;
}

/** 在总管私聊里直接造一条「已记住」：回复消息的时间可指定（构造 24 小时内外），不经模型回合。 */
async function seedNote(fix: JobFix, text: string, ageMs: number) {
  const memory = await writeMemory(fix.ctx, { kind: 'rule', text, example: '写「请输入」', redLine: false, scope: { staff: 'all', projects: 'all' },
    source: { kind: 'owner_words', messageIds: [], quote: `以后${text}`, threadId: fix.chief.id } });
  const reply = { id: newId('m', fix.ctx.rng), thread: fix.chief.id, from: fix.chief.id, kind: 'reply' as const, text: `已记住：${text}。`,
    refId: null, createdAt: fix.ctx.clock.now() - ageMs, readAt: null };
  fix.ctx.store.log('thread').append(reply);
  fix.ctx.store.table('memories').patch(memory.id, { replyMessageId: reply.id });
  return fix.ctx.store.table('memories').get(memory.id)!;
}

describe('按钮撤销与文字撤销：结果完全相同', () => {
  it('两种撤销后：记忆状态、身份文件、视图一致；文字撤销多落「已撤销：……。」且没有总管的新唤醒', async () => {
    const results: Array<{ status: string; ended: boolean; history: number; agents: string; note: unknown }> = [];
    for (const via of ['button', 'text'] as const) {
      const fix = await jobFix();
      const { memory, reply } = await noted(fix);
      expect(await agentsMdOf(fix.ctx, bot(fix, fix.engineer.id))).toContain(memory.text);
      const before = chiefActivity(fix);
      if (via === 'button') {
        expect(await fix.hub.api.undoMemory({ memoryId: memory.id })).toMatchObject({ ok: true });
      } else {
        expect(await fix.hub.api.sendMessage(fix.chief.id, '撤销')).toMatchObject({ ok: true });
        // 主人这句话照常落楼，但没有叫醒总管；中心以总管名义落「已撤销：……。」。
        expect(chiefActivity(fix)).toBe(before);
        const last = messagesIn(fix.ctx, fix.chief.id).at(-1)!;
        expect(last).toMatchObject({ from: fix.chief.id, kind: 'reply', text: `已撤销：${memory.text}。` });
        expect(messagesIn(fix.ctx, fix.chief.id).at(-2)).toMatchObject({ from: 'owner', text: '撤销' });
      }
      const after = fix.ctx.store.table('memories').get(memory.id)!;
      const agents = await agentsMdOf(fix.ctx, bot(fix, fix.engineer.id));
      expect(agents).not.toContain(memory.text);
      expect(await agentsMdOf(fix.ctx, bot(fix, fix.chief.id))).not.toContain(memory.text);
      const note = fix.hub.api.thread(fix.chief.id).messages.find(row => row.id === reply.id)!.memoryNotes;
      // P75r1：「已记住」一行多了主人原话一行和适用范围一行。
      expect(note).toEqual([{ memoryId: memory.id, kindLabel: '规矩', action: 'noted', text: memory.text, state: 'undone', canUndo: false,
        quoteLine: '你说：「以后页面上的提示文字都用「请」字开头」', scopeLine: '用于全部员工、全部项目' }]);
      results.push({ status: after.status, ended: after.endedAt !== null, history: after.history.length, agents, note });
    }
    expect(results[1]).toEqual(results[0]);
    expect(results[0]).toMatchObject({ status: 'undone', ended: true, history: 0 });
  });

  it('按钮撤销不叫醒任何人；撤销后再点一次被拒绝，说明已经撤销或删除', async () => {
    const fix = await jobFix();
    const { memory } = await noted(fix);
    const before = chiefActivity(fix);
    expect(await fix.hub.api.undoMemory({ memoryId: memory.id })).toMatchObject({ ok: true });
    expect(chiefActivity(fix)).toBe(before);
    expect(await fix.hub.api.undoMemory({ memoryId: memory.id })).toEqual({ ok: false, error: '这一条已经撤销或删除了' });
    expect(await fix.hub.api.undoMemory({ memoryId: 'mem_0000000000' })).toMatchObject({ ok: false, error: expect.stringContaining('不存在') });
    expect(await fix.hub.api.undoMemory({})).toMatchObject({ ok: false });
  });

  it('主人在记忆页自己写的（来源是主人的编辑）不能用 undoMemory 撤销', async () => {
    const fix = await jobFix();
    const memory = await writeMemory(fix.ctx, { kind: 'rule', text: '回复先说结论', example: null, redLine: false, scope: { staff: 'all', projects: 'all' },
      source: { kind: 'owner_edit', messageIds: [], quote: '回复先说结论', threadId: null } });
    expect(await fix.hub.api.undoMemory({ memoryId: memory.id })).toEqual({ ok: false, error: '这一条已经撤销或删除了' });
    expect(fix.ctx.store.table('memories').get(memory.id)!.status).toBe('active');
  });

  // P75r1：原来的断言是「说了『撤销吗』『先别撤销』并等总管回复之后，再说『撤回』仍然认领」（24 小时内随时可以文字撤销）；
  // 现在只认紧接着的一句，所以变体各在新一次「已记住」之后紧接着说。
  it('整句变体也认：「撤销。」「 撤回 」；「撤销吗」「先别撤销」不认领，按普通消息叫醒总管', async () => {
    const fix = await jobFix();
    const { memory } = await noted(fix);
    // 「撤销吗」「先别撤销」不是整句口令：不认领，叫醒总管，记忆不动。
    const before = chiefActivity(fix);
    expect(await fix.hub.api.sendMessage(fix.chief.id, '撤销吗')).toMatchObject({ ok: true });
    expect(chiefActivity(fix), '撤销吗').toBeGreaterThan(before);
    expect(fix.ctx.store.table('memories').get(memory.id)!.status).toBe('active');
    await speak(fix, fix.chief, '好的，没有动。', { outcome: 'progress' });
    const beforeSecond = chiefActivity(fix);
    expect(await fix.hub.api.sendMessage(fix.chief.id, '先别撤销')).toMatchObject({ ok: true });
    expect(chiefActivity(fix), '先别撤销').toBeGreaterThan(beforeSecond);
    expect(fix.ctx.store.table('memories').get(memory.id)!.status).toBe('active');
    // 整句变体：每个变体各自在一次「已记住」之后紧接着说。
    for (const text of ['撤销。', ' 撤回。 ', ' 撤回 ']) {
      const each = await jobFix();
      const { memory: row } = await noted(each);
      expect(await each.hub.api.sendMessage(each.chief.id, text)).toMatchObject({ ok: true });
      expect(each.ctx.store.table('memories').get(row.id)!.status, text).toBe('undone');
    }
  });

  // P75r1：原来的断言是「同一个对话里有两条：说一次撤最近的一条，再说一次撤另一条」；现在撤销之后最近一条回复下面已经没有
  // 生效的「已记住」，再说「撤销」不认领，这句话照常叫醒总管，另一条不动。
  it('同一个对话里有两条（各在自己的回复下）：整句「撤销」只撤紧接着的那条；再说一次不认领，叫醒总管，另一条不动', async () => {
    const fix = await jobFix();
    const first = await seedNote(fix, '提示都用请字开头', 2 * HOUR);
    const second = await seedNote(fix, '按钮都用圆角', 1 * HOUR);
    await fix.hub.api.sendMessage(fix.chief.id, '撤销');
    expect(fix.ctx.store.table('memories').get(second.id)!.status).toBe('undone');
    expect(fix.ctx.store.table('memories').get(first.id)!.status).toBe('active');
    const before = chiefActivity(fix);
    await fix.hub.api.sendMessage(fix.chief.id, '撤销');
    expect(chiefActivity(fix)).toBeGreaterThan(before);
    expect(fix.ctx.store.table('memories').get(first.id)!.status).toBe('active');
  });

  it('24 小时内（23 小时）认领；24 小时外（25 小时）按普通消息处理并叫醒总管，记忆不变', async () => {
    const inside = await jobFix();
    const fresh = await seedNote(inside, '提示都用请字开头', 23 * HOUR);
    const insideBefore = chiefActivity(inside);
    await inside.hub.api.sendMessage(inside.chief.id, '撤销');
    expect(inside.ctx.store.table('memories').get(fresh.id)!.status).toBe('undone');
    expect(chiefActivity(inside)).toBe(insideBefore);

    const outside = await jobFix();
    const old = await seedNote(outside, '提示都用请字开头', 25 * HOUR);
    const outsideBefore = chiefActivity(outside);
    await outside.hub.api.sendMessage(outside.chief.id, '撤销');
    expect(outside.ctx.store.table('memories').get(old.id)!.status).toBe('active');
    expect(chiefActivity(outside)).toBeGreaterThan(outsideBefore);
    expect(messagesIn(outside.ctx, outside.chief.id).some(row => row.text.startsWith('已撤销'))).toBe(false);
  });

  it('这个对话里没有「已记住」：整句「撤销」按普通消息处理并叫醒总管', async () => {
    const fix = await jobFix();
    // 别的对话（主题）里的「已记住」不算这个对话里的。
    const topicId = await openTopic(fix, '随便聊聊');
    await speak(fix, fix.chief, '收到。', { outcome: 'progress' });
    const memory = await writeMemory(fix.ctx, { kind: 'rule', text: '提示都用请字开头', example: '写「请输入」', redLine: false, scope: { staff: 'all', projects: 'all' },
      source: { kind: 'owner_words', messageIds: [], quote: '以后提示都用请字开头', threadId: topicId } });
    const reply = { id: newId('m', fix.ctx.rng), thread: topicId, from: fix.chief.id, kind: 'reply' as const, text: '已记住：提示都用请字开头。', refId: null, createdAt: fix.ctx.clock.now(), readAt: null };
    fix.ctx.store.log('thread').append(reply);
    fix.ctx.store.table('memories').patch(memory.id, { replyMessageId: reply.id });
    const before = chiefActivity(fix);
    await fix.hub.api.sendMessage(fix.chief.id, '撤销');
    expect(fix.ctx.store.table('memories').get(memory.id)!.status).toBe('active');
    expect(chiefActivity(fix)).toBeGreaterThan(before);
  });

  it('主题里：整句「撤销」撤销这个主题里最近的「已记住」，落「已撤销」，没有总管的新唤醒', async () => {
    const fix = await jobFix();
    const topicId = await openTopic(fix, '帮我整理一下登录页的文案');
    await speak(fix, fix.chief, '收到，我来看。', { outcome: 'progress' });
    await ownerSays(fix, topicId, '以后登录页的提示都用「请」字开头');
    expect((await fix.hub.tools().find(tool => tool.name === 'hub_memory')!.handler(bot(fix, fix.chief.id).sessionId!, {
      mode: 'note', kind: 'rule', text: '提示都用请字开头', example: '写「请输入」', staff: '全部', projects: '全部' })).ok).toBe(true);
    await speak(fix, fix.chief, '已记住：提示都用请字开头，例如写「请输入」。适用于全部员工。', { outcome: 'progress' });
    const memory = memoriesOf(fix.ctx)[0]!;
    const before = chiefActivity(fix);
    await ownerSays(fix, topicId, '撤销');
    expect(fix.ctx.store.table('memories').get(memory.id)!.status).toBe('undone');
    expect(chiefActivity(fix)).toBe(before);
    expect(messagesIn(fix.ctx, topicId).at(-1)).toMatchObject({ from: fix.chief.id, text: '已撤销：提示都用请字开头。' });
  });

  // P75r1：原来的断言是「会话直聊里整句『撤销』同样认领（撤销、落『已撤销』、身份文件里这条消失）」；
  // 现在直聊入口不认领（这个回合里总管的会话已经在处理这句话），记忆和身份文件都不动。
  it('会话直聊（owner_direct）里整句「撤销」不认领：记忆仍生效，不落「已撤销」', async () => {
    const fix = await jobFix();
    const { memory } = await noted(fix);
    await fix.hub.onTurnEvent({ type: 'owner_direct', sessionId: bot(fix, fix.chief.id).sessionId!, at: fix.ctx.clock.now(), text: '撤销' });
    expect(fix.ctx.store.table('memories').get(memory.id)!.status).toBe('active');
    expect(messagesIn(fix.ctx, fix.chief.id).some(row => row.text.startsWith('已撤销'))).toBe(false);
    expect(await agentsMdOf(fix.ctx, bot(fix, fix.engineer.id))).toContain(memory.text);
  });

  it('回合还没结束时被撤销：回合结束不补落「已记住」', async () => {
    const fix = await jobFix();
    await chiefHears(fix, '以后页面上的提示文字都用「请」字开头');
    expect((await fix.hub.tools().find(tool => tool.name === 'hub_memory')!.handler(bot(fix, fix.chief.id).sessionId!, {
      mode: 'note', kind: 'rule', text: '提示都用请字开头', example: '写「请输入」', staff: '全部', projects: '全部' })).ok).toBe(true);
    const memory = memoriesOf(fix.ctx)[0]!;
    expect(await fix.hub.api.undoMemory({ memoryId: memory.id })).toMatchObject({ ok: true });
    await fix.hub.onTurnEvent({ type: 'ended', sessionId: bot(fix, fix.chief.id).sessionId!, at: fix.ctx.clock.now(), finalText: '', tokens: 10 });
    expect(messagesIn(fix.ctx, fix.chief.id).some(row => row.text.startsWith('已记住'))).toBe(false);
    expect(fix.ctx.store.table('memories').get(memory.id)!.replyMessageId).toBeNull();
  });
});

describe('文字撤销不影响「定了」和「验收通过」', () => {
  it('有一条生效的「已记住」时，整句「定了」仍然固定约定，「已记住」不动，没有「已撤销」', async () => {
    const fix = await jobFix();
    const { memory } = await noted(fix);
    await chiefDrafts(fix as never, { title: '会员定价页' });
    await speak(fix, fix.chief, '这件事有 2 项需要你定。确认前不会开工。', { outcome: 'needs_owner' });
    expect(fix.ctx.store.table('agreements').list()[0]!.state).toBe('pending');
    // 整句「撤销」不会固定约定。P75r1：之后总管又落了约定卡的回复，「已记住」不是紧接着的那一条，所以「撤销」不认领（原来断言「已记住」被撤销）。
    await fix.hub.api.sendMessage(fix.chief.id, '撤销');
    expect(fix.ctx.store.table('agreements').list()[0]!.state).toBe('pending');
    expect(fix.ctx.store.table('memories').get(memory.id)!.status).toBe('active');
    // 之后，「定了」照常固定。
    await fix.hub.api.sendMessage(fix.chief.id, '定了');
    expect(fix.ctx.store.table('agreements').list()[0]!.state).toBe('locked');
  });

  it('「已记住」生效时说「定了」：约定固定，「已记住」仍生效，不落「已撤销」', async () => {
    const fix = await jobFix();
    const { memory } = await noted(fix);
    await chiefDrafts(fix as never, { title: '会员定价页' });
    await speak(fix, fix.chief, '这件事有 2 项需要你定。确认前不会开工。', { outcome: 'needs_owner' });
    await fix.hub.api.sendMessage(fix.chief.id, '定了');
    expect(fix.ctx.store.table('agreements').list()[0]!.state).toBe('locked');
    expect(fix.ctx.store.table('memories').get(memory.id)!.status).toBe('active');
    expect(messagesIn(fix.ctx, fix.chief.id).some(row => row.text.startsWith('已撤销'))).toBe(false);
  });

  it('「已记住」生效时，在总管私聊里说「验收通过」：这件事照常验收完成，「已记住」仍生效', async () => {
    const { fix, job } = await delivered();
    const { memory } = await noted(fix);
    expect(theJob(fix).state).toBe('awaiting_owner');
    await fix.hub.api.sendMessage(job.chiefId, '验收通过');
    expect(theJob(fix).state).toBe('done');
    expect(fix.ctx.store.table('memories').get(memory.id)!.status).toBe('active');
    expect(messagesIn(fix.ctx, fix.chief.id).some(row => row.text.startsWith('已撤销'))).toBe(false);
  });
});

describe('更正、删除、撤销删除', () => {
  it('更正：旧文字进 history，身份文件变为新文字；非生效的记忆拒绝；超长拒绝', async () => {
    const fix = await jobFix();
    const { memory } = await noted(fix);
    const result = await fix.hub.api.correctMemory({ memoryId: memory.id, text: '提示文字一律以「请」字开头' });
    expect(result).toMatchObject({ ok: true });
    const after = fix.ctx.store.table('memories').get(memory.id)!;
    expect(after.text).toBe('提示文字一律以「请」字开头');
    expect(after.history).toEqual([{ text: memory.text, at: fix.ctx.clock.now(), by: 'owner', note: '你在记忆页更正',
      action: 'corrected', wakeId: null, replyMessageId: null, threadId: null, undone: false, messageIds: [], quote: '' }]); // P75r1：记忆页上主人自己改的，原话两项留空
    const agents = await agentsMdOf(fix.ctx, bot(fix, fix.engineer.id));
    expect(agents).toContain('提示文字一律以「请」字开头');
    expect(agents).not.toContain(memory.text);
    expect(await fix.hub.api.correctMemory({ memoryId: memory.id, text: '长'.repeat(121) })).toMatchObject({ ok: false, error: expect.stringContaining('不能超过 120 字') });
    expect(await fix.hub.api.correctMemory({ memoryId: memory.id, text: '  ' })).toMatchObject({ ok: false });
    await fix.hub.api.deleteMemory({ memoryId: memory.id });
    expect(await fix.hub.api.correctMemory({ memoryId: memory.id, text: '新说法' })).toEqual({ ok: false, error: '只能更正生效中的记忆' });
  });

  it('更正超过上限：只保留最近 20 条旧说法', async () => {
    const fix = await jobFix();
    const { memory } = await noted(fix);
    for (let i = 0; i < 22; i += 1) await fix.hub.api.correctMemory({ memoryId: memory.id, text: `第 ${i} 种说法` });
    const after = fix.ctx.store.table('memories').get(memory.id)!;
    expect(after.history).toHaveLength(20);
    expect(after.history[0]!.text).toBe('第 1 种说法');
    expect(after.history.at(-1)!.text).toBe('第 20 种说法');
    expect(after.text).toBe('第 21 种说法');
  });

  it('删除后身份文件不再带这条；24 小时内可撤销删除，超过 24 小时被拒绝', async () => {
    const fix = await jobFix();
    const { memory } = await noted(fix);
    expect(await fix.hub.api.deleteMemory({ memoryId: memory.id })).toMatchObject({ ok: true });
    expect(fix.ctx.store.table('memories').get(memory.id)).toMatchObject({ status: 'deleted' });
    expect(await agentsMdOf(fix.ctx, bot(fix, fix.engineer.id))).not.toContain(memory.text);
    expect(await fix.hub.api.deleteMemory({ memoryId: memory.id })).toEqual({ ok: false, error: '只能删除生效中的记忆' });
    // 23 小时（带时间的记录）：可撤销。
    fix.ctx.store.table('memories').patch(memory.id, { endedAt: fix.ctx.clock.now() - 23 * HOUR });
    expect(await fix.hub.api.undoDeleteMemory({ memoryId: memory.id })).toMatchObject({ ok: true });
    expect(fix.ctx.store.table('memories').get(memory.id)).toMatchObject({ status: 'active', endedAt: null });
    expect(await agentsMdOf(fix.ctx, bot(fix, fix.engineer.id))).toContain(memory.text);
    // 再删一次，25 小时：被拒绝。
    await fix.hub.api.deleteMemory({ memoryId: memory.id });
    fix.ctx.store.table('memories').patch(memory.id, { endedAt: fix.ctx.clock.now() - 25 * HOUR });
    expect(await fix.hub.api.undoDeleteMemory({ memoryId: memory.id })).toEqual({ ok: false, error: '删除已超过 24 小时，不能撤销' });
    expect(fix.ctx.store.table('memories').get(memory.id)!.status).toBe('deleted');
  });

  it('撤销删除只对已删除的记忆有效；已撤销（不是删除）的不行', async () => {
    const fix = await jobFix();
    const { memory } = await noted(fix);
    expect(await fix.hub.api.undoDeleteMemory({ memoryId: memory.id })).toMatchObject({ ok: false });
    await fix.hub.api.undoMemory({ memoryId: memory.id });
    expect(await fix.hub.api.undoDeleteMemory({ memoryId: memory.id })).toMatchObject({ ok: false });
  });
});

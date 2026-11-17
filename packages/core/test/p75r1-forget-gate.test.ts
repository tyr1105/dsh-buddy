/**
 * P75r1 第 7 节的测试：对话里删、改记忆，与记住用同一道门（主人亲口打的字），并记下主人那句话。
 *
 * 对应审查记录 M4、L7：原来 forget、correct 只要求本回合是主人发起的，主人只是点了约定卡上的「定了」按钮，
 * 这一回合总管也能删改记忆；改动之后记忆页的出处仍是最早那句原话，看不到是哪句话让它被改的。
 * 全部走真实的 Hub：memoryId 只用正则从唤醒包「可引用的出处」里取。
 */
import { describe, expect, it } from 'vitest';
import { MemorySchema } from '../src/model/memory.js';
import { buildMemoryPage, memoryPageView, type MemoryPageInput } from '../src/api/index.js';
import { flushJobHooks } from '../src/job/agreement-hooks.js';
import { NOT_OWN_WORDS_TEXT } from '../src/memory/forget.js';
import { postThread } from '../src/outreach/thread.js';
import { newId } from '../src/util/ids.js';
import { chiefDraftsAnother } from './p74b-fixtures.js';
import { callTool, chiefHears, jobFix, memoriesOf, noted, speak } from './p75c-fixtures.js';

const OLD = '页面上的提示文字都用「请」字开头';

/** 只从唤醒包里取规矩的编号。 */
function ruleIdIn(packet: string): string {
  const match = /^(mem_[0-9a-z]{10})：页面上的提示文字/m.exec(packet);
  expect(match, '唤醒包「可引用的出处」里应该有这条规矩').not.toBeNull();
  return match![1]!;
}

/** 记忆页上这一条的 historyNote。 */
function historyNoteOf(fix: Awaited<ReturnType<typeof jobFix>>, memoryId: string): string | null {
  return memoryPageView(fix.ctx).groups.flatMap(group => group.entries).find(row => row.memoryId === memoryId)!.historyNote;
}

describe('点按钮的回合不能删改记忆', () => {
  it('主人点了约定卡上的「定了」按钮的回合：forget、correct 都被拒，文字逐字相同，记忆不变', async () => {
    const fix = await jobFix();
    const { memory } = await noted(fix);
    await chiefHears(fix, '帮我做个报价页');
    const agreementId = await chiefDraftsAnother(fix, '报价页', { category: '表单页' });
    await speak(fix, fix.chief, '这件事有 2 项需要你定。确认前不会开工。', { outcome: 'needs_owner' });
    // 中心代主人落「定了」（带约定编号），总管被这句话叫醒。
    expect(await fix.hub.api.confirmAgreement({ agreementId, version: 1 })).toMatchObject({ ok: true });
    await flushJobHooks(fix.ctx);
    await fix.hub.tick();
    const forgot = await callTool(fix, fix.chief, 'hub_memory', { mode: 'forget', memoryId: memory.id });
    const corrected = await callTool(fix, fix.chief, 'hub_memory', { mode: 'correct', memoryId: memory.id, text: '提示文字一律以「请」字开头' });
    expect(forgot).toEqual({ ok: false, error: NOT_OWN_WORDS_TEXT });
    expect(corrected).toEqual({ ok: false, error: NOT_OWN_WORDS_TEXT });
    expect(NOT_OWN_WORDS_TEXT).toBe('只能在主人亲口说要删或要改的回合里做；点按钮、选办法这类由中心代落的话不算');
    expect(fix.ctx.store.table('memories').get(memory.id)).toMatchObject({ status: 'active', text: OLD, history: [] });
  });
});

describe('主人亲口说：成功并记下原话', () => {
  it('主人说「把『请』字那条删了」：forget 成功，历史项里有这句原话', async () => {
    const fix = await jobFix();
    await noted(fix);
    const id = ruleIdIn(await chiefHears(fix, '把「请」字那条删了'));
    expect(await callTool(fix, fix.chief, 'hub_memory', { mode: 'forget', memoryId: id })).toMatchObject({ ok: true });
    const item = fix.ctx.store.table('memories').get(id)!.history[0]!;
    expect(item).toMatchObject({ action: 'deleted', quote: '把「请」字那条删了' });
    expect(item.messageIds).toHaveLength(1);
  });

  it('主人说「改成……」：correct 成功，记忆页 historyNote 带「你说：……」；没有原话时只写「原为……」', async () => {
    const fix = await jobFix();
    const { memory } = await noted(fix);
    const id = ruleIdIn(await chiefHears(fix, '那条改成「提示文字以请或您开头」'));
    expect(await callTool(fix, fix.chief, 'hub_memory', { mode: 'correct', memoryId: id, text: '提示文字以请或您开头' })).toMatchObject({ ok: true });
    expect(historyNoteOf(fix, id)).toBe(`原为「${memory.text}」。你说：「那条改成「提示文字以请或您开头」」`);
    // 记忆页上主人自己改的：两个字段留空，只写「原为……」。
    await speak(fix, fix.chief, '已更正。', { outcome: 'progress' });
    expect(await fix.hub.api.correctMemory({ memoryId: id, text: '提示文字以请开头' })).toMatchObject({ ok: true });
    const history = fix.ctx.store.table('memories').get(id)!.history;
    expect(history[1]).toMatchObject({ by: 'owner', messageIds: [], quote: '' });
    expect(historyNoteOf(fix, id)).toBe('原为「提示文字以请或您开头」。');
  });

  it('追问之后主人回「是」的回合里 correct 成功，原话里有更早那句', async () => {
    const fix = await jobFix();
    await noted(fix);
    await chiefHears(fix, '那条改成「提示文字以请或您开头」');
    await speak(fix, fix.chief, '已改好。要我以后都这样吗？', { outcome: 'progress' });
    const id = ruleIdIn(await chiefHears(fix, '是'));
    expect(await callTool(fix, fix.chief, 'hub_memory', { mode: 'correct', memoryId: id, text: '提示文字以请或您开头' })).toMatchObject({ ok: true });
    const item = fix.ctx.store.table('memories').get(id)!.history[0]!;
    expect(item.quote).toBe('那条改成「提示文字以请或您开头」\n是');
    expect(item.messageIds).toHaveLength(2);
  });

  it('更早那句是中心代主人落的话：追问之后回「是」，不并入原话（只记「是」）', async () => {
    const fix = await jobFix();
    await noted(fix);
    await chiefHears(fix, '那条改成「提示文字以请或您开头」');
    await speak(fix, fix.chief, '已改好。要我以后都这样吗？', { outcome: 'progress' });
    // 日志不能原位改：新落一对（带记录编号的代落的话，加总管的追问回复），让它们成为「是」之前最近的往来。
    postThread(fix.ctx, { thread: fix.chief.id, from: 'owner', kind: 'chat', text: '选 B：以后都改成这样', refId: newId('tsu', fix.ctx.rng) });
    postThread(fix.ctx, { thread: fix.chief.id, from: fix.chief.id, kind: 'reply', text: '已按选项办。要我以后都这样吗？' });
    const id = ruleIdIn(await chiefHears(fix, '是'));
    expect(await callTool(fix, fix.chief, 'hub_memory', { mode: 'correct', memoryId: id, text: '提示文字以请或您开头' })).toMatchObject({ ok: true });
    const item = fix.ctx.store.table('memories').get(id)!.history[0]!;
    expect(item.quote).toBe('是');
    expect(item.messageIds).toHaveLength(1);
  });
});

describe('旧形状的历史项（没有 messageIds、quote）照常能读', () => {
  it('按旧形状解析：两个字段取默认值；记忆页只写「原为……」', async () => {
    const fix = await jobFix();
    const { memory } = await noted(fix);
    const legacyItem = { text: '旧说法', at: 1, by: 'owner', note: '你在记忆页更正', action: 'corrected', wakeId: null, replyMessageId: null, threadId: null, undone: false };
    const parsed = MemorySchema.parse({ ...memory, history: [legacyItem] });
    expect(parsed.history[0]).toMatchObject({ messageIds: [], quote: '' });
    const input: MemoryPageInput = {
      memories: [parsed], projects: [], agreementTitles: new Map(), botNames: new Map(), topicTitles: new Map(), projectNames: new Map(),
      citations: new Map(), now: memory.updatedAt, timezone: fix.ctx.settings.timezone,
    };
    const entry = buildMemoryPage(input).groups.flatMap(group => group.entries).find(row => row.memoryId === memory.id)!;
    expect(entry.historyNote).toBe('原为「旧说法」。');
    expect(memoriesOf(fix.ctx)).toHaveLength(1);
  });
});

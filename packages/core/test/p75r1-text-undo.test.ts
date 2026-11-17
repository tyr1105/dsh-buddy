/**
 * P75r1 第 3 节的测试：文字撤销只认紧接着「已记住」的那一句。
 *
 * 对应审查记录 H3：原来 24 小时内这个对话里主人的任何一句整句「撤销」都被记忆认领，记住一条之后又办了别的事再说「撤销」，
 * 被撤的是规矩，真正想撤的事没人处理。现在要同时满足：这句话是撤销口令；这个对话里最后一条（不算中心落的提示）是一条
 * 员工的回复 R，R 下面挂着生效的「已记住」；R 落下不超过 24 小时。认领时撤销 R 下面挂着的全部，不认领时叫醒总管。
 * 全部走真实的 Hub 和假时钟（每次推进不超过 10 分钟；24 小时外用带时间的记录构造）。
 */
import { describe, expect, it } from 'vitest';
import { wouldClaimTextUndo } from '../src/memory/undo.js';
import { writeMemory } from '../src/memory/service.js';
import { postThread } from '../src/outreach/thread.js';
import { newId } from '../src/util/ids.js';
import { openTopic } from './p63-topic-fixtures.js';
import { entriesOf, wakesOf } from './p74c-fixtures.js';
import {
  agentsMdOf, bot, callTool, chiefHears, jobFix, memoriesOf, messagesIn, noteArgs, noted, ownerSays, speak, MINUTE, type JobFix,
} from './p75c-fixtures.js';

const HOUR = 60 * MINUTE;

/** 总管的唤醒和候选总数：用来断言「有没有叫醒总管」。 */
function chiefActivity(fix: JobFix): number {
  return wakesOf(fix, fix.chief.id).length + entriesOf(fix, fix.chief.id).length;
}

/** 记忆当前的状态。 */
function statusOf(fix: JobFix, id: string): string {
  return fix.ctx.store.table('memories').get(id)!.status;
}

describe('不认领：记住之后又有别的往来', () => {
  it('记住之后，主人让总管办了另一件事、总管回复了，主人再说「撤销」：不认领，记忆仍生效，总管被叫醒', async () => {
    const fix = await jobFix();
    const { memory } = await noted(fix);
    fix.ctx.clock.advance(10 * MINUTE);
    await chiefHears(fix, '把周报改成每周五发');
    await speak(fix, fix.chief, '已改好：周报改为每周五发，其他不变。', { outcome: 'progress' });
    const before = chiefActivity(fix);
    expect(await fix.hub.api.sendMessage(fix.chief.id, '撤销')).toMatchObject({ ok: true });
    expect(statusOf(fix, memory.id)).toBe('active');
    expect(chiefActivity(fix)).toBeGreaterThan(before);
    expect(messagesIn(fix.ctx, fix.chief.id).some(row => row.text.startsWith('已撤销'))).toBe(false);
    expect(await agentsMdOf(fix.ctx, bot(fix, fix.engineer.id))).toContain(memory.text);
  });

  it('记住之后，主人先说了一句别的话（总管还没回复），再说「撤销」：不认领', async () => {
    const fix = await jobFix();
    const { memory } = await noted(fix);
    await ownerSays(fix, fix.chief.id, '另外，把周报改成每周五发');
    // 总管这一回合还开着、没有回复；主人紧接着说「撤销」。
    expect(wouldClaimTextUndo(fix.ctx, fix.chief.id, '撤销')).toBe(false);
    await ownerSays(fix, fix.chief.id, '撤销');
    expect(statusOf(fix, memory.id)).toBe('active');
    expect(messagesIn(fix.ctx, fix.chief.id).some(row => row.text.startsWith('已撤销'))).toBe(false);
  });

  it('DSH 会话直聊入口不认领：紧接着说「撤销」也不撤，不落「已撤销」', async () => {
    const fix = await jobFix();
    const { memory } = await noted(fix);
    await fix.hub.onTurnEvent({ type: 'owner_direct', sessionId: bot(fix, fix.chief.id).sessionId!, at: fix.ctx.clock.now(), text: '撤销' });
    expect(statusOf(fix, memory.id)).toBe('active');
    expect(messagesIn(fix.ctx, fix.chief.id).some(row => row.text.startsWith('已撤销'))).toBe(false);
  });

  it('超过 24 小时不认领（回复落下 25 小时）；23 小时内认领', async () => {
    const make = async (ageMs: number) => {
      const fix = await jobFix();
      const memory = await writeMemory(fix.ctx, { kind: 'rule', text: '提示都用请字开头', example: '写「请输入」', redLine: false, scope: { staff: 'all', projects: 'all' },
        source: { kind: 'owner_words', messageIds: [], quote: '以后提示都用请字开头', threadId: fix.chief.id } });
      const reply = { id: newId('m', fix.ctx.rng), thread: fix.chief.id, from: fix.chief.id, kind: 'reply' as const, text: '已记住：提示都用请字开头。',
        refId: null, createdAt: fix.ctx.clock.now() - ageMs, readAt: null };
      fix.ctx.store.log('thread').append(reply);
      fix.ctx.store.table('memories').patch(memory.id, { replyMessageId: reply.id });
      return { fix, memory };
    };
    const inside = await make(23 * HOUR);
    await inside.fix.hub.api.sendMessage(inside.fix.chief.id, '撤销');
    expect(statusOf(inside.fix, inside.memory.id)).toBe('undone');
    const outside = await make(25 * HOUR);
    const before = chiefActivity(outside.fix);
    await outside.fix.hub.api.sendMessage(outside.fix.chief.id, '撤销');
    expect(statusOf(outside.fix, outside.memory.id)).toBe('active');
    expect(chiefActivity(outside.fix)).toBeGreaterThan(before);
  });
});

describe('认领：紧接着的一句「撤销」', () => {
  it('正例：认领，总管没有被叫醒，身份文件里这一条消失', async () => {
    const fix = await jobFix();
    const { memory } = await noted(fix);
    expect(await agentsMdOf(fix.ctx, bot(fix, fix.engineer.id))).toContain(memory.text);
    const before = chiefActivity(fix);
    expect(await fix.hub.api.sendMessage(fix.chief.id, '撤销')).toMatchObject({ ok: true });
    expect(statusOf(fix, memory.id)).toBe('undone');
    expect(chiefActivity(fix)).toBe(before);
    expect(messagesIn(fix.ctx, fix.chief.id).at(-1)).toMatchObject({ from: fix.chief.id, kind: 'reply', text: `已撤销：${memory.text}。` });
    expect(await agentsMdOf(fix.ctx, bot(fix, fix.engineer.id))).not.toContain(memory.text);
  });

  it('主题里记下的同样成立：主题里紧接着说「撤销」认领，没有总管的新唤醒', async () => {
    const fix = await jobFix();
    const topicId = await openTopic(fix, '帮我整理一下登录页的文案');
    await speak(fix, fix.chief, '收到，我来看。', { outcome: 'progress' });
    await ownerSays(fix, topicId, '以后登录页的提示都用「请」字开头');
    expect((await callTool(fix, fix.chief, 'hub_memory', noteArgs({ text: '提示都用请字开头', example: '写「请输入」' }))).ok).toBe(true);
    await speak(fix, fix.chief, '已记住：提示都用请字开头，例如写「请输入」。适用于全部员工。', { outcome: 'progress' });
    const memory = memoriesOf(fix.ctx)[0]!;
    const before = chiefActivity(fix);
    await ownerSays(fix, topicId, '撤销');
    expect(statusOf(fix, memory.id)).toBe('undone');
    expect(chiefActivity(fix)).toBe(before);
    expect(messagesIn(fix.ctx, topicId).at(-1)).toMatchObject({ from: fix.chief.id, text: '已撤销：提示都用请字开头。' });
  });

  it('回复 R 之后只有中心落的提示、没有别的往来：仍然认领', async () => {
    const fix = await jobFix();
    const { memory } = await noted(fix);
    postThread(fix.ctx, { thread: fix.chief.id, from: 'hub', kind: 'system', text: '中心提示：这是一句由中心落下的提示。' });
    const before = chiefActivity(fix);
    await fix.hub.api.sendMessage(fix.chief.id, '撤销');
    expect(statusOf(fix, memory.id)).toBe('undone');
    expect(chiefActivity(fix)).toBe(before);
  });

  it('一个回合记了两条，主人紧接着说「撤销」：两条都撤销，落的话有两行，总管没被叫醒；再说一次不认领，总管被叫醒', async () => {
    const fix = await jobFix();
    await chiefHears(fix, '以后提示文字都用「请」字开头，以后按钮都用圆角');
    expect((await callTool(fix, fix.chief, 'hub_memory', noteArgs())).ok).toBe(true);
    expect((await callTool(fix, fix.chief, 'hub_memory', noteArgs({ text: '按钮都用圆角', example: '写圆角按钮' }))).ok).toBe(true);
    await speak(fix, fix.chief, '已记住两条：提示文字都用「请」字开头；按钮都用圆角。适用于全部员工。', { outcome: 'progress' });
    const [first, second] = memoriesOf(fix.ctx);
    expect(first!.status).toBe('active');
    expect(second!.status).toBe('active');
    expect(first!.replyMessageId).not.toBeNull();
    expect(first!.replyMessageId).toBe(second!.replyMessageId);
    const before = chiefActivity(fix);
    await fix.hub.api.sendMessage(fix.chief.id, '撤销');
    expect(statusOf(fix, first!.id)).toBe('undone');
    expect(statusOf(fix, second!.id)).toBe('undone');
    expect(chiefActivity(fix)).toBe(before);
    const last = messagesIn(fix.ctx, fix.chief.id).at(-1)!;
    expect(last.text).toBe(`已撤销：${first!.text}。\n已撤销：${second!.text}。`);
    // 再说一次：最近一条回复下面已经没有生效的「已记住」，不认领，照常叫醒总管。
    await fix.hub.api.sendMessage(fix.chief.id, '撤销');
    expect(chiefActivity(fix)).toBeGreaterThan(before);
    expect(messagesIn(fix.ctx, fix.chief.id).filter(row => row.text.startsWith('已撤销')).length).toBe(1);
  });
});

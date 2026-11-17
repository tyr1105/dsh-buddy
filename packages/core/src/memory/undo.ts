/**
 * 记忆的撤销、更正、删除（P75c）：界面的四个命令，以及对话里整句「撤销」的文字撤销。
 *
 * 两种撤销（按钮、文字）走同一个函数 setMemoryStatus，所以状态、身份文件、视图的结果完全相同；
 * 唯一的区别是文字撤销还会在对话里落一句「已撤销：……。」，因为主人那句「撤销」是一条消息，需要有回应。
 *
 * 文字撤销的认领条件（方案 7.5，P75r1 收紧）：主人整句（规范化之后）等于「撤销」「撤回」，并且「已记住」所挂的那条回复 R
 * 就是这个对话里紧挨着这句话的上一条（R 之后没有主人的其他消息、没有员工的回复，中心落的提示不算），R 落下不超过 24 小时，
 * R 下面挂着仍然生效的、主人原话记下的「已记住」。认领后撤销 R 下面挂着的全部「已记住」，这句话照常落楼、但不叫醒任何人，
 * 也不再交给别的口令机制；不认领时这句话按普通消息处理（叫醒总管，由总管判断主人要撤销什么）。
 * 为什么要限定「紧接着」：记住之后主人又办了别的事，再说「撤销」多半指别的事，不能被悄悄吞掉。
 * DSH 会话直聊的入口不认领（那个回合里总管的会话已经在处理这句话，中心再处理一次会变成两边各做一件事）。
 *
 * 文字撤销在同步的入口里调用（发消息、回合事件），所以状态改动在同步部分完成，
 * 刷新身份文件这段异步收尾登记到 scheduleHook，由命令出口统一等它做完。
 */
import { z } from 'zod';
import { MEMORY_DEFAULTS as D } from '../config/defaults.js';
import type { HubContext } from '../engine/context.js';
import { parseInput } from '../engine/validation.js';
import { scheduleHook } from '../job/agreement-hooks.js';
import type { Memory } from '../model/memory.js';
import type { ThreadMessage } from '../model/outreach.js';
import { recordId } from '../model/primitives.js';
import { postThread } from '../outreach/thread.js';
import { normalizeConfirmText } from '../project/agreement-confirm.js';
import { correctMemoryText, setMemoryStatus, undoLastCorrection } from './service.js';

const MemoryIdSchema = z.strictObject({ memoryId: recordId('mem') });
const CorrectSchema = z.strictObject({
  memoryId: recordId('mem'),
  text: z.string({ error: 'text：必须是文字' }).trim().min(1, 'text：不能为空')
    .refine(value => [...value].length <= D.TEXT_MAX_CHARS, `text：不能超过 ${D.TEXT_MAX_CHARS} 字`),
});

/** 取一条记忆；找不到时报中文错误。 */
function requireRow(ctx: HubContext, memoryId: string): Memory {
  const row = ctx.store.table('memories').get(memoryId);
  if (!row) throw new Error('memoryId：这一条记忆不存在');
  return row;
}

/** UiApi undoMemory：生效中、主人原话记下的记忆改为已撤销；不叫醒任何人。 */
export async function undoMemoryCommand(ctx: HubContext, raw: unknown): Promise<{ memoryId: string }> {
  const { memoryId } = parseInput(MemoryIdSchema, raw, '撤销记忆');
  const row = requireRow(ctx, memoryId);
  if (row.status !== 'active' || row.source.kind !== 'owner_words') throw new Error('这一条已经撤销或删除了');
  await setMemoryStatus(ctx, memoryId, 'undone', 'owner');
  return { memoryId };
}

/** UiApi correctMemory：记忆页更正文字，旧说法进历史。 */
export async function correctMemoryCommand(ctx: HubContext, raw: unknown): Promise<{ memoryId: string }> {
  const { memoryId, text } = parseInput(CorrectSchema, raw, '更正记忆');
  const row = requireRow(ctx, memoryId);
  if (row.status !== 'active') throw new Error('只能更正生效中的记忆');
  await correctMemoryText(ctx, memoryId, text, 'owner', '你在记忆页更正');
  return { memoryId };
}

/** UiApi deleteMemory：生效中的记忆改为已删除（24 小时内可撤销删除）。 */
export async function deleteMemoryCommand(ctx: HubContext, raw: unknown): Promise<{ memoryId: string }> {
  const { memoryId } = parseInput(MemoryIdSchema, raw, '删除记忆');
  if (requireRow(ctx, memoryId).status !== 'active') throw new Error('只能删除生效中的记忆');
  await setMemoryStatus(ctx, memoryId, 'deleted', 'owner');
  return { memoryId };
}

/** UiApi undoDeleteMemory：删除后 24 小时内改回生效；超时拒绝。 */
export async function undoDeleteMemoryCommand(ctx: HubContext, raw: unknown): Promise<{ memoryId: string }> {
  const { memoryId } = parseInput(MemoryIdSchema, raw, '撤销删除');
  const row = requireRow(ctx, memoryId);
  if (row.status !== 'deleted') throw new Error('这一条没有被删除，不用撤销');
  if (row.endedAt === null || ctx.clock.now() - row.endedAt > D.DELETE_UNDO_MS) throw new Error('删除已超过 24 小时，不能撤销');
  await setMemoryStatus(ctx, memoryId, 'active', 'owner');
  return { memoryId };
}

/** UiApi undoCorrectMemory（P75d）：撤销最近一次更正，文字恢复为更正之前的说法；24 小时内可用。 */
export async function undoCorrectMemoryCommand(ctx: HubContext, raw: unknown): Promise<{ memoryId: string }> {
  const { memoryId } = parseInput(MemoryIdSchema, raw, '撤销更正');
  requireRow(ctx, memoryId);
  await undoLastCorrection(ctx, memoryId, 'owner');
  return { memoryId };
}

/**
 * 文字撤销的目标（P75r1，只认「紧接着」的那一句）。认领要同时满足：
 * - 这个对话里最后一条消息（不算这句「撤销」本身，也不算中心落的提示）是一条员工的回复 R；
 * - R 下面挂着至少一条生效中的、由主人原话记下的「已记住」（规矩或偏好）；
 * - R 落下不超过 UNDO_WINDOW_MS（24 小时，作为上限保留）。
 * 满足时返回 R 和 R 下面挂着的全部生效中的「已记住」（一个回合记了两条时两条都在）。
 * 为什么这样严：记住之后主人又办了别的事再说「撤销」，多半指别的事，不能被记忆悄悄认领；不认领时这句话照常叫醒总管，
 * 由总管判断主人要撤销什么。excludeId 是这句「撤销」自己的消息编号（已经落楼时要排除；还没落楼时不传）。
 */
function undoTargetIn(ctx: HubContext, threadId: string, excludeId?: string): { memories: Memory[]; reply: ThreadMessage } | null {
  const now = ctx.clock.now();
  // 这个对话里最后一条不是中心落的提示、也不是这句「撤销」自己的消息。
  const last = ctx.store.log('thread').recent(1, row => row.thread === threadId && row.id !== excludeId && row.from !== 'hub')[0];
  // 必须是员工的回复（主人的话、别的类型的员工消息都不行：那说明 R 之后有别的往来）。
  if (last === undefined || last.from === 'owner' || last.kind !== 'reply' || now - last.createdAt > D.UNDO_WINDOW_MS) return null;
  const memories = ctx.store.table('memories').list(row => row.status === 'active' && row.source.kind === 'owner_words'
    && row.replyMessageId === last.id && row.source.threadId === threadId && (row.kind === 'rule' || row.kind === 'preference'))
    .sort((a, b) => a.createdAt - b.createdAt);
  return memories.length === 0 ? null : { memories, reply: last };
}

/** 这句话在这个对话里会不会被文字撤销认领（只判断，不改任何东西）：主题入口要在落楼之前先知道，决定落楼后叫不叫人。 */
export function wouldClaimTextUndo(ctx: HubContext, threadId: string, text: string): boolean {
  return isUndoPhrase(text) && undoTargetIn(ctx, threadId) !== null;
}

/** 这句话是不是撤销口令（规范化后整句等于名单中的一项）。 */
export function isUndoPhrase(text: string): boolean {
  return D.UNDO_PHRASES.includes(normalizeConfirmText(text));
}

/**
 * 文字撤销：认领成功返回 true（撤销紧接着那条回复下面挂的全部「已记住」，并在同一条消息里每条一行落「已撤销：……。」，
 * 调用方不再叫醒任何人、不再交给别的口令机制）；不认领返回 false（调用方照原流程处理，这句话是普通消息，叫醒总管）。
 * 自己兜底所有异常：出错时不认领，让这句话照常叫醒总管，不丢主人的话。
 */
export function claimTextUndo(ctx: HubContext, threadId: string, message: ThreadMessage): boolean {
  try {
    if (!isUndoPhrase(message.text)) return false;
    const target = undoTargetIn(ctx, threadId, message.id);
    if (target === null) return false;
    // 状态改动在这里同步完成；刷新身份文件的异步收尾登记起来，由命令和回合事件的出口等它做完。
    // 一个回合记了两条时两条都撤销：主人看到的是一条回复下两行「已记住」，只撤一条会让他以为都撤了。
    for (const memory of target.memories) {
      scheduleHook(ctx, '撤销记忆后刷新', async () => { await setMemoryStatus(ctx, memory.id, 'undone', 'owner'); });
    }
    // 以回复那一位（总管）的名义落一条话，每条记忆一行；那位员工查不到时退回中心名义。
    const speaker = ctx.store.table('bots').get(target.reply.from) !== null ? target.reply.from : 'hub';
    const lines = target.memories.map(memory => `已撤销：${stripEndMark(memory.text)}。`);
    postThread(ctx, { thread: threadId, from: speaker, kind: speaker === 'hub' ? 'system' : 'reply', text: lines.join('\n') });
    return true;
  } catch (error) {
    try { ctx.logger.error('文字撤销处理失败，按普通消息处理', error); } catch { /* 日志出错也不能抛出去。 */ }
    return false;
  }
}

/** 去掉文字末尾的句号，免得「已撤销：……。。」。 */
export function stripEndMark(text: string): string {
  return text.trim().replace(/[。.]+$/u, '');
}

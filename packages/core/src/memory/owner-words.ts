/**
 * 「主人亲口说的话」的出处取法（P75r1，从 note.ts 挪出，记住、删除、更正三处共用同一道门）。
 *
 * 为什么由中心取出处：记住（note）、删掉（forget）、改掉（correct）一条记忆，都只能凭主人亲口打的字，
 * 点按钮、选办法这类由中心代主人落下的话（消息上带着所属记录的编号）不算。三处共用同一套判断，
 * 不会出现「记住拒绝、删改却放行」的不一致（审查记录 M4）。
 *
 * 出处消息的取法：本回合证据里主人亲口打的、同一个对话里的消息；总管在同一个对话里的上一条回复以固定追问句
 * 「要我以后都这样吗」结尾、并且主人本回合的话是肯定回答时，主人在那条回复之前的最后一句也算
 * （判断本身在 owner-turn.ts 的 pendingConfirmation，P76p 起唤醒包也用它）。
 * 原文由中心从消息里抄，不经模型。
 *
 * 本文件只读存储，不写任何东西。
 */
import { MEMORY_DEFAULTS as D } from '../config/defaults.js';
import type { HubContext } from '../engine/context.js';
import type { ThreadMessage } from '../model/outreach.js';
import type { WakeTicket } from '../model/wake.js';
import { evidenceMessageIds } from '../wake/chief-packet.js';
import { isOwnTypedWords, pendingConfirmation } from './owner-turn.js';

// 这两项原来定义在本文件，P76p 挪到 owner-turn.ts（唤醒包也要用）；仍从这里导出，调用方不用改。
export { isOwnTypedWords, isYesAnswer } from './owner-turn.js';

/**
 * 出处消息：本回合证据里主人亲口打的消息；总管在同一个对话里的上一条回复以待确认问句结尾、
 * 并且主人本回合的话是肯定回答时，主人在那条回复之前的最后一句也算。返回按时间从早到晚排列的消息。
 * 为什么要看肯定回答：主人回「不用，就这一次」时，更早那句话里的「都」不能当作这次的出处。
 * 并入出处的每一条主人消息都要是主人亲口打的字：中心代主人落的话（选办法、点按钮，带记录编号）不并入；
 * 另一个对话里的主人消息也不并入。
 */
export function sourceMessages(ctx: HubContext, wake: WakeTicket, main: ThreadMessage, chiefId: string): ThreadMessage[] {
  const ids = evidenceMessageIds(ctx, wake);
  const all = ctx.store.log('thread').all();
  // 证据里主人的消息（同一个对话里的、主人亲口打的；主消息一定在内，且已在调用处检查过）。
  const found = all.filter(row => row.from === 'owner' && row.thread === main.thread && (ids.has(row.id) || row.id === main.id)
    && isOwnTypedWords(row, wake));
  const confirmation = pendingConfirmation(ctx, wake, main, chiefId);
  const earlier = confirmation?.earlier ?? null;
  const merged = earlier === null || found.some(row => row.id === earlier.id) ? found : [earlier, ...found];
  return merged.sort((a, b) => a.createdAt - b.createdAt);
}

/** 把出处消息的原文拼成一段（多句用换行连接），取前 max 个字。 */
export function quoteOf(messages: readonly ThreadMessage[], max: number): string {
  return [...messages.map(row => row.text.trim()).join('\n')].slice(0, max).join('');
}

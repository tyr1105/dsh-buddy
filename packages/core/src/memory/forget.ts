/**
 * 总管按主人的话删掉或改掉一条记住的事（hub_memory 的 forget、correct，P75d，方案 7.5「更正、删除」）。
 *
 * 为什么只限总管、只在主人发起的回合：记忆会写进每位员工的身份文件，删改和新增一样要有主人的话作依据。
 * P75r1：与记住（note）用同一道门，本回合主人的话必须是亲口打的字（点「定了」按钮、选办法这类中心代落的话不算），
 * 并且由中心把主人那句话抄进历史项（messageIds、quote），记忆页能看到是哪句话让它被改的。
 * memoryId 只能取自总管约定段的「可引用的出处」（规矩、偏好、先例都可以），必须是生效中的记忆。
 *
 * 做法：
 * - forget：记忆改为已删除，history 记一项 action 为 deleted；
 * - correct：新文字取代旧文字（旧文字进 history，action 为 corrected）；新文字要过内部名称检查（它会显示给主人），
 *   与现有文字相同时拒绝（没有更正的必要，也无处挂「已更正」）。
 * 两者 history 项带上本回合的编号和对话，交账后挂到回复下面（commit/effects.ts、turn/events.ts 里的 attachMemoryReply）；
 * 本回合没有回复时回合结束由 ensureNotesShown 以总管名义补落一句，作为挂靠的消息。
 * 先例的更正和删除只改记忆这一行，不改约定本身。
 *
 * 写入全部经 service.ts。
 */
import { MEMORY_DEFAULTS } from '../config/defaults.js';
import type { HubContext } from '../engine/context.js';
import { currentWake, requireChief } from '../job/manage-common.js';
import { ownerTextProblem } from '../job/owner-text.js';
import { ownerMessageOfWake } from '../project/agreements.js';
import type { ToolContext } from '../tools/types.js';
import { isOwnTypedWords, quoteOf, sourceMessages } from './owner-words.js';
import { correctMemoryText, setMemoryStatus } from './service.js';

/** 不是主人发话叫醒的回合时的固定说明。 */
export const NOT_OWNER_TURN_TEXT = '只能在主人发话叫醒的回合里删或改';

/** 成功时返回给模型的话。 */
export const FORGET_DONE_TEXT = '已删除，回复里写明删掉了什么。';
export const CORRECT_DONE_TEXT = '已更正，回复里写明改成了什么。';

/** 本回合主人的话不是亲口打的字（点按钮、选办法这类由中心代落的话）时的固定说明（P75r1，与记住用同一道门）。 */
export const NOT_OWN_WORDS_TEXT = '只能在主人亲口说要删或要改的回合里做；点按钮、选办法这类由中心代落的话不算';

/**
 * 取这一回合的主人发话回合信息和要改的记忆；不满足条件抛出中文错误。
 * P75r1：除了「主人发话的回合」，本回合的主消息还必须是主人亲口打的字（与 note 同一道门）；
 * 同时由中心从消息里抄下主人那句话（本回合的话；追问之后主人回肯定的话时加上更早那句），记进历史项，不经模型。
 */
function resolveTarget(ctx: HubContext, tc: ToolContext, memoryId: string, what: string) {
  const chief = requireChief(ctx, tc, what);
  const wake = currentWake(ctx, tc);
  const main = wake !== null && wake.ownerInitiated === true ? ownerMessageOfWake(ctx, wake) : null;
  if (wake === null || main === null) throw new Error(NOT_OWNER_TURN_TEXT);
  if (!isOwnTypedWords(main, wake)) throw new Error(NOT_OWN_WORDS_TEXT);
  const sources = sourceMessages(ctx, wake, main, chief.id);
  const chat = { wakeId: wake.id, threadId: main.thread, messageIds: sources.map(row => row.id), quote: quoteOf(sources, MEMORY_DEFAULTS.QUOTE_MAX_CHARS) };
  const memory = ctx.store.table('memories').get(memoryId);
  if (memory === null || memory === undefined) throw new Error('memoryId：找不到这一条记忆，只能写约定段「可引用的出处」里的编号');
  if (memory.status !== 'active') throw new Error('memoryId：这一条记忆已经不在用了（已删除、已撤销、已被取代或已被否掉）');
  return { memory, chat };
}

/** forget：删掉一条记忆。 */
export async function runMemoryForget(ctx: HubContext, tc: ToolContext, args: { memoryId: string }): Promise<string> {
  const { chat } = resolveTarget(ctx, tc, args.memoryId, '删主人的规矩');
  await setMemoryStatus(ctx, args.memoryId, 'deleted', 'chief', { chat, note: '你对总管说删掉' });
  return FORGET_DONE_TEXT;
}

/** correct：把一条记忆改成新文字。 */
export async function runMemoryCorrect(ctx: HubContext, tc: ToolContext, args: { memoryId: string; text: string }): Promise<string> {
  const { memory, chat } = resolveTarget(ctx, tc, args.memoryId, '改主人的规矩');
  const problems: string[] = [];
  const textProblem = ownerTextProblem('text', args.text);
  if (textProblem !== null) problems.push(textProblem);
  if (args.text.trim() === memory.text) problems.push('text：和现在记的一样，不用更正');
  if (problems.length > 0) throw new Error(problems.join('；'));
  await correctMemoryText(ctx, args.memoryId, args.text, 'chief', '你对总管说改成这样', { chat });
  return CORRECT_DONE_TEXT;
}

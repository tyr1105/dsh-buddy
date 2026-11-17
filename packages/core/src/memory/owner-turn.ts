/**
 * 「主人这句话是不是亲口说的」「是不是在回答上一轮待确认的问句」的判断（P76p）。
 *
 * 为什么单独一个文件：这两件事原来混在 owner-words.ts（取出处）里，唤醒包也要用同一套判断，
 * 而唤醒包（wake/packet.ts）不能被 owner-words.ts 反过来依赖（owner-words 要读唤醒证据，引用 chief-packet，会成环）。
 * 把判断放在这里：不读唤醒证据、不写存储，只按消息和唤醒单判断，owner-words 与唤醒包都用它。
 *
 * 为什么要判断「在回答上一问」：P76l 实测里主人对「要我以后都这样吗？」答「是。」，
 * 中心把更早那句并进出处是对的，但 note 的触发词门槛把它拒了，规矩没记下来。
 * 确认算不算数，取决于上一轮是不是待确认问句：
 * - 固定追问句「要我以后都这样吗」；
 * - 或最后一问明确在问要不要记住（记下、记住、记到、写进记忆）。
 * 别的问句（「你要红色还是蓝色？」）不是记忆确认，主人答「是」不算；上一轮不是问句时，这句「是」也不是确认。
 */
import { MEMORY_DEFAULTS as D } from '../config/defaults.js';
import type { HubContext } from '../engine/context.js';
import type { ThreadMessage } from '../model/outreach.js';
import type { WakeTicket } from '../model/wake.js';
import { normalizeConfirmText } from '../project/agreement-confirm.js';
import { UNVERIFIED_CLAIM_NOTE } from '../commit/claim-evidence.js';

/** 这句话是不是主人自己说的：消息上没有关联记录，或关联的是这一回合的唤醒单。 */
export function isOwnTypedWords(message: ThreadMessage, wake: WakeTicket): boolean {
  return message.refId === null || message.refId === wake.id;
}

/** 更早的那句话（总管追问之前的）：关联的是某个主人直聊的唤醒单也算主人自己说的。 */
function isEarlierOwnWords(ctx: HubContext, message: ThreadMessage, wake: WakeTicket): boolean {
  if (isOwnTypedWords(message, wake)) return true;
  return ctx.store.table('wakes').get(message.refId!)?.ownerDirect === true;
}

/** 去掉回复末尾由中心补的「没有可以核对的结果」那一行（没有就原样返回）。 */
function withoutClaimNote(text: string): string {
  return text.split(UNVERIFIED_CLAIM_NOTE).join('').trimEnd();
}

/** 去掉末尾的标点和空白后，是否以固定追问句结尾。 */
function endsWithAsk(text: string): boolean {
  return text.replace(/[\s\p{P}\p{S}]+$/u, '').endsWith(D.ASK_SUFFIX);
}

/** 主人本回合这句话是不是对固定追问句的肯定回答：去掉空白和标点后整句等于名单中的一项。 */
export function isYesAnswer(text: string): boolean {
  return D.ASK_YES_PHRASES.includes(normalizeConfirmText(text));
}

/** 最后一问句话：按句末标点切开，取最后一段非空文字（没有标点时就是整句）。 */
function lastSentence(text: string): string {
  return text.split(/[。；;！!？?\n]+/u).map(item => item.trim()).filter(item => item !== '').at(-1) ?? '';
}

/**
 * 这句话是不是一个「待确认问句」：固定追问句，或最后一问明确在问要不要记住。
 * 为什么只看最后一问：总管上一条回复可能很长，只有最后一句才是给主人的问句。
 */
function isConfirmationQuestion(text: string): boolean {
  if (endsWithAsk(text)) return true;
  if (!/[？?]\s*$/u.test(text)) return false;
  return /记住|记下|记到|写进记忆/u.test(lastSentence(text));
}

/** 一次确认：总管的那一问，以及问之前主人说的那句（要确认的内容）。 */
export interface PendingConfirmation {
  ask: ThreadMessage;
  earlier: ThreadMessage;
}

/**
 * 主人这一回合的话是不是在回答总管上一轮的待确认问句；是则返回那一问与问之前主人说的那句，否则 null。
 * 条件：这一句是名单里的简短肯定回答；同一个对话里总管的上一条回复是待确认问句；
 * 那一问之前主人的最后一句必须是主人自己说的（点按钮、选办法这类中心代落的话不算）。
 */
export function pendingConfirmation(ctx: HubContext, wake: WakeTicket, main: ThreadMessage, chiefId: string): PendingConfirmation | null {
  if (!isYesAnswer(main.text)) return null;
  const all = ctx.store.log('thread').all();
  const mainIndex = all.findIndex(row => row.id === main.id);
  if (mainIndex < 0) return null;
  for (let i = mainIndex - 1; i >= 0; i -= 1) {
    const row = all[i]!;
    // 同一个对话里、总管的消息；别人的消息跳过。
    // P85（审查 W12）：遇到总管的任何一条消息就停，以最近一条为准：最近一条不是回复（例如提问卡、汇报）时，
    // 这句「是」回答的是那一条，不能越过它去确认更早的那一问。第一条回复不是待确认问句时，这句「是」也不当作确认。
    if (row.thread !== main.thread || row.from !== chiefId) continue;
    if (row.kind !== 'reply') return null;
    // P85：完成声明没有证据时，中心会在回复末尾另起一行补一句固定的话（commit/claim-evidence.ts）；
    // 判断「最后一问」时把这一句去掉，否则「已改好……要我以后都这样吗？」会因为末尾多了一行而不再算待确认问句。
    const askText = withoutClaimNote(row.text);
    if (!isConfirmationQuestion(askText)) return null;
    for (let j = i - 1; j >= 0; j -= 1) {
      const prior = all[j]!;
      if (prior.thread === main.thread && prior.from === 'owner') {
        return isEarlierOwnWords(ctx, prior, wake) ? { ask: { ...row, text: askText }, earlier: prior } : null;
      }
    }
    return null;
  }
  return null;
}

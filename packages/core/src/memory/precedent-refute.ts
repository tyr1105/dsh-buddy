/**
 * 主人否掉一条先例（P76p）。
 *
 * 为什么要有这件事：先例只在约定换版时才会改写（memory/precedents.ts）。主人在验收入口直接改主意，
 * 说「背景我要浅色白底，不要深色渐变」时约定没有换版，旧先例就一直以 active 留在「可引用的出处」里，
 * 下次同类的事对齐还会引用一个被推翻的选择（P76l 第 9 节问题 4）。
 *
 * 做法：总管按主人指出的条目返工（job/reopen.ts）时，用主人那句话对照这份约定里的生效中先例；
 * 明确否掉了哪一条的选定项，就把那一条改为「已被否掉」（refuted），history 里留一条旧文字与主人原话。
 * 被否掉的先例不再出现在出处、记忆页和依据解析里，但行还在，能追溯是谁哪句话让它失效的。
 *
 * 只按字面判断，不做语义推断：
 * - 否定词之后 12 个字以内出现原选定项的完整文字：判否掉（P85：原来是「片段、3 个字以上取前 2 个字」，
 *   「页面上不要公开我的名字」会因为「公开」二字被当成否掉「公开接口」；被误判否掉的先例，记忆页看不到、也恢复不了）。
 *   例：「报价来源不要公开接口，改成手工表格」对上「报价从哪里取：公开接口」。
 *   字面判断的限度：选定项本身是一个常见词时（例如「每天」），「不要每天都给我发通知」仍会被判否掉；
 *   中心为此在主题里落一句旁白，让主人看得见哪条先例作废了（见 refutePrecedentsByOwnerWords）。
 * - 只改措辞不算：否定词没有碰到原选定项（「不要写错别字」）不作废。
 * - 只说「改成……」、没有否定原词的（「改成浅色白底」）也不作废：这句话可能是在改别的事，
 *   中心无法只凭字面确认它针对这一条先例。这类改主意由约定换版（写先例时旧的变已取代）或总管用
 *   hub_memory 的 correct、forget 处理；边界写在 docs/questions.md。
 *
 * 本文件只经 service.ts 写记忆。
 */
import type { HubContext } from '../engine/context.js';
import { postThread } from '../outreach/thread.js';
import { setMemoryStatus } from './service.js';

/** P85：否掉一条先例时，在这件事的主题里落的中心旁白（给主人看，逐字；text 是先例正文「{待定项}：{选定项}」）。 */
export function refutedPrecedentNote(text: string): string {
  return `「${text}」这条先例已按你的话作废，以后对齐时不再引用。`;
}

/** 明确否掉的说法：后面紧跟原选定项的片段才算否掉。 */
const NEGATIONS = ['不要', '不用', '别用', '别再', '不想要', '不采用', '去掉', '换掉', '取消', '否掉', '不选'] as const;
/** 否定词之后看几个字（够放下一个短语，又不会把整句都算进来）。 */
const NEGATION_WINDOW = 12;

/** 先例正文「{问题}：{选定项}」里的选定项；没有冒号时整句都算。 */
export function chosenPartOf(text: string): string {
  const index = text.search(/[：:]/u);
  return index < 0 ? text : text.slice(index + 1);
}

/**
 * 主人这句话是不是否掉了这条先例的选定项。只按字面判断，见文件开头的规则。
 * P85：只认完整的选定项文字，且它要在否定词之后 12 个字以内开始出现；选定项不足 2 个字时不判否掉：证据太弱。
 */
export function ownerWordsRefute(ownerText: string, precedentText: string): boolean {
  const chosen = chosenPartOf(precedentText).trim();
  if ([...chosen].length < 2) return false;
  for (const marker of NEGATIONS) {
    let from = 0;
    for (;;) {
      const index = ownerText.indexOf(marker, from);
      if (index < 0) break;
      const after = index + marker.length;
      const found = ownerText.indexOf(chosen, after);
      // 完整的选定项文字在否定词之后 12 个字以内开始出现。
      if (found >= 0 && found - after < NEGATION_WINDOW) return true;
      from = after;
    }
  }
  return false;
}

/** 否掉一条先例时要留下的追溯信息：在哪个对话、主人哪句话（原文由中心抄出）。 */
export interface RefuteTrace {
  threadId: string;
  messageIds: string[];
  quote: string;
}

/**
 * 把这份约定里被主人这句话否掉的生效中先例改为「已被否掉」，返回被改的编号。
 * 只动先例；约定本身不变（新说法由这次返工和之后的约定版本生效）。
 */
export async function refutePrecedentsByOwnerWords(ctx: HubContext, agreementId: string, ownerText: string,
  trace: RefuteTrace): Promise<string[]> {
  const rows = ctx.store.table('memories').list(row => row.kind === 'precedent' && row.status === 'active'
    && row.source.agreementId === agreementId);
  const refuted: string[] = [];
  for (const row of rows) {
    if (!ownerWordsRefute(ownerText, row.text)) continue;
    await setMemoryStatus(ctx, row.id, 'refuted', 'hub', {
      chat: { wakeId: null, threadId: trace.threadId, messageIds: trace.messageIds, quote: trace.quote },
      note: '你在验收时否掉了这一条',
    });
    refuted.push(row.id);
    // P85：否掉的先例在记忆页看不到、也恢复不了，所以在这件事的主题里落一句中心旁白，让主人看得见作废了哪一条
    // （字面判断有误判的可能，主人看到不对可以再告诉总管）。落楼失败只记日志，不影响否掉本身。
    try {
      postThread(ctx, { thread: trace.threadId, from: 'hub', kind: 'system', text: refutedPrecedentNote(row.text) });
    } catch (error) {
      ctx.logger.warn('先例作废的旁白没有落楼', { memoryId: row.id, error: String(error) });
    }
  }
  return refuted;
}

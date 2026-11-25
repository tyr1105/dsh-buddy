/**
 * 「定了」的三条途径（P72c）：卡片按钮、「待你处理」里的按钮、在对话里打字。
 *
 * 三条途径最后都落到同一个内部函数 finishLock：先用 P72a 的纯函数 applyLock 算出固定后的约定
 * （失败直接抛出，此时什么都没写），再写表、处理收件箱条目、落中心旁白、记审计、发事件。
 * 这样无论主人怎么说「定了」，结果的形状完全一样。
 *
 * 为什么打字只认整句：只要句子里还有别的内容（「定了，但把邮箱加上」「定了吗」「先别定」），
 * 就不是确认，而是修改或提问，要交给总管理解；宁可多问一句，也不能把没说清的话当成确认。
 *
 * 总管没有任何途径调用这里的函数：工具表里没有「确认约定」，确认只能由主人发起。
 */
import { z } from 'zod';
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import type { HubContext } from '../engine/context.js';
import { parseInput } from '../engine/validation.js';
import { AgreementSchema, type Agreement, type LockVia } from '../model/agreement.js';
import type { InboxItem, ThreadMessage } from '../model/outreach.js';
import { recordId } from '../model/primitives.js';
import { writeOutreachAudit } from '../outreach/audit.js';
import { emitInboxChange } from '../outreach/inbox.js';
import { postThread, wakeForOwnerMessage } from '../outreach/thread.js';
import { confirmNeedsNoChief, onAgreementLocked } from '../job/agreement-hooks.js';
import { isConversationTopic } from './conversation.js';
import { wakeTopicResponder } from './topics.js';
import { agreementForTopic, applyLock, pendingAgreementsOf } from './agreements.js';
import { followTopicTitle, versionTitleOf } from './agreement-title.js';

// ---------------------------------------------------------------------------
// 口令识别
// ---------------------------------------------------------------------------

/** 口令整句的最长字数（规范化之后）。 */
export const CONFIRM_PHRASE_MAX_CHARS = 12;

/**
 * 认作「确认」的整句口令（规范化之后完全相等才算）。
 * 只认整句：「定了，但把邮箱加上」「定了吗」「先别定」「不定了」「我们定了个规矩」都不在名单里，
 * 会照常交给总管当作修改或提问处理。
 */
export const CONFIRM_PHRASES = ['定了', '定', '就这么定', '就这么定了', '就这样定了', '按建议定了', '按你的建议定了',
  '都按建议', '按建议来', '按建议', '可以定了', '好定了', '好的定了', '行定了', 'ok定了', '确认', '确认了', '没问题定了'] as const;

/** 规范化：全角转半角（NFKC）、转小写、去掉全部空白与标点符号，让「 OK，定了。」和「ok定了」等价。 */
export function normalizeConfirmText(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
}

/** 这句话是不是确认口令：规范化后不超过字数上限，且完全等于名单中的一项。 */
export function isConfirmPhrase(text: string): boolean {
  const normalized = normalizeConfirmText(text);
  return [...normalized].length <= CONFIRM_PHRASE_MAX_CHARS && (CONFIRM_PHRASES as readonly string[]).includes(normalized);
}

// ---------------------------------------------------------------------------
// 统一收尾
// ---------------------------------------------------------------------------

/** finishLock 的入参：固定参数和写进收件箱条目的回答文字。 */
interface FinishInput {
  version: number;
  via: Exclude<LockVia, 'amend'>;
  choices: Record<string, string> | null;
  confirmMessageId: string | null;
  /** 收件箱条目的回答文字：打字和按钮是「定了」，待你处理是「按建议，定了」。 */
  answerText: string;
}

/**
 * 三条途径共用的收尾。applyLock 失败直接抛出（此时什么都没写）；成功后依次：
 * 写表 → 收件箱条目标已回答 → 私聊与主题各落一条旁白 → 审计 → 发事件。
 * 返回固定后的约定。
 */
function finishLock(ctx: HubContext, agreement: Agreement, input: FinishInput): Agreement {
  const now = ctx.clock.now();
  const locked = applyLock(agreement, {
    version: input.version, via: input.via, choices: input.choices, at: now, confirmMessageId: input.confirmMessageId,
  });
  // 写表：待你处理条目随之了结，约定里不再指向它。
  // P74r16b：这一版的标题与固定之前的标题不同时，约定记录上的标题随之改成新标题（主题的标题在下面跟上）。
  const inboxId = agreement.inboxId;
  const newTitle = versionTitleOf(ctx, agreement, input.version);
  ctx.store.table('agreements').put(AgreementSchema.parse({ ...locked, inboxId: null, title: newTitle }));

  // 条目仍开着时标为已回答并发事件（已被撤回、已处理的不动）。
  const item = inboxId === null ? null : ctx.store.table('inbox').get(inboxId);
  if (item && item.status === 'open') {
    ctx.store.table('inbox').patch(item.id, { status: 'answered', answer: input.answerText, answeredAt: now });
    emitInboxChange(ctx, item);
  }

  // 中心旁白：私聊一条（带主题名），主题里一条。主题被删除时不往主题落（线程不存在会报错）。
  postThread(ctx, { thread: agreement.originThread, from: 'hub', kind: 'system',
    text: `约定第 ${input.version} 版已固定，挂在主题「${agreement.title}」上。`, refId: agreement.id });
  if (ctx.store.table('projectTopics').get(agreement.topicId)) {
    postThread(ctx, { thread: agreement.topicId, from: 'hub', kind: 'system', text: `约定第 ${input.version} 版已固定。`, refId: agreement.id });
  }

  // P74r16b：主题的标题（主人没有自己改过的话）跟着改，并在主题里落一句工作往来；出错只记日志。
  try { followTopicTitle(ctx, agreement, agreement.title, newTitle, input.version); }
  catch (error) { ctx.logger.warn('主题标题没有跟上约定的新标题', { agreementId: agreement.id, error: String(error) }); }
  const adoption = locked.versions.find(row => row.no === input.version)?.adoption ?? null;
  writeOutreachAudit(ctx, 'agreement_lock', { agreementId: agreement.id, no: input.version, via: input.via, adoption }, 'owner', now);
  ctx.emit(HUB_EVENT_SCOPES.thread, agreement.originThread);
  ctx.emit(HUB_EVENT_SCOPES.project, null);
  ctx.emit(HUB_EVENT_SCOPES.bot, agreement.botId);
  // P74e：这份约定挂着一件事（执行中、返工中、已完成……）时，约定变了它的后续：重写主题文件、清掉暂停、叫醒执行者……
  // 这是第二段，出错只记日志，不影响约定已经固定成功。
  try { onAgreementLocked(ctx, agreement.id, input.version, 'confirm'); }
  catch (error) { ctx.logger.warn('约定固定后这件事的后续没有做成', { agreementId: agreement.id, error: String(error) }); }
  return locked;
}

/** 按钮和待你处理共用：中心代主人在总管私聊落一条「定了」，固定约定，再叫醒总管。 */
function lockWithOwnerMessage(ctx: HubContext, agreement: Agreement, input: Omit<FinishInput, 'confirmMessageId'>): void {
  // 先在副本上试算：失败（旧版本、已固定、选项不对）直接抛出，线程里不会多出一条「定了」。
  applyLock(agreement, { version: input.version, via: input.via, choices: input.choices, at: ctx.clock.now(), confirmMessageId: null });
  const message = postThread(ctx, { thread: agreement.originThread, from: 'owner', kind: 'chat', text: '定了', refId: agreement.id });
  ctx.runtime.ownerActiveAt = ctx.clock.now();
  finishLock(ctx, agreement, { ...input, confirmMessageId: message.id });
  // 这条「定了」是中心代发的，没有走 sendOwnerMessage，所以要自己叫醒总管，让它接着开工。
  // P74e：这份约定有正在做的事时不叫醒总管（执行者接着做，不需要总管再出一个回合；省约 5 万 token）。
  // P74f-2：确认的是写明「不再做」的版本、中心刚把这件事停下时，同样不叫醒总管（固定之后这件事已不是进行中，所以不能只看进行中）。
  if (confirmNeedsNoChief(ctx, agreement.id)) return;
  const chief = ctx.store.table('bots').get(agreement.botId);
  if (!chief) return;
  // W1：卡片发在项目对话里时，按主题的方式叫醒总管（回复落在项目对话，不落到私聊）。
  if (ctx.store.table('projectTopics').get(agreement.originThread)) wakeTopicResponder(ctx, agreement.originThread, chief.id, message.id);
  else wakeForOwnerMessage(ctx, chief, message);
}

// ---------------------------------------------------------------------------
// 途径一：卡片按钮（界面命令 confirmAgreement）
// ---------------------------------------------------------------------------

const ConfirmInputSchema = z.strictObject({
  agreementId: recordId('agr'),
  version: z.number({ error: '必须是整数' }).int('必须是整数').min(1, '版本号从 1 起'),
  choices: z.record(z.string(), z.string()).optional(),
});

/** 卡片上点「定了」：入参校验、试算、落主人「定了」、固定、叫醒总管。返回约定 id 与固定的版本号。 */
export function confirmAgreementCommand(ctx: HubContext, raw: unknown): { agreementId: string; version: number } {
  const input = parseInput(ConfirmInputSchema, raw, '确认约定');
  const agreement = ctx.store.table('agreements').get(input.agreementId);
  if (!agreement) throw new Error('agreementId：约定不存在');
  lockWithOwnerMessage(ctx, agreement, { version: input.version, via: 'button', choices: input.choices ?? null, answerText: '定了' });
  return { agreementId: agreement.id, version: input.version };
}

// ---------------------------------------------------------------------------
// 途径二：待你处理
// ---------------------------------------------------------------------------

/** 条目的 subjectKey 形如 agreement:约定id:版本号；解析失败返回 null。 */
export function parseAgreementSubjectKey(subjectKey: string): { agreementId: string; version: number } | null {
  const match = /^agreement:(agr_[a-z0-9]{10}):(\d+)$/.exec(subjectKey);
  return match ? { agreementId: match[1]!, version: Number(match[2]) } : null;
}

/** 条目是不是约定确认条目（提问类型、subjectKey 以 agreement: 开头）。 */
export function isAgreementInboxItem(item: Pick<InboxItem, 'type' | 'subjectKey'>): boolean {
  return item.type === 'question' && item.subjectKey.startsWith('agreement:');
}

/**
 * 在「待你处理」里回答约定条目：只允许「按建议，定了」。
 * 要修改的话请去对话里写，所以其他文字一律报错、什么都不改。返回更新后的条目。
 */
export function confirmFromInbox(ctx: HubContext, item: InboxItem, answer: string): InboxItem {
  if (answer.trim() !== '按建议，定了') throw new Error('在「待你处理」里只能按建议确认；要修改，请点「查看对话」在对话里写');
  const parsed = parseAgreementSubjectKey(item.subjectKey);
  const agreement = parsed ? ctx.store.table('agreements').get(parsed.agreementId) : null;
  if (!parsed || !agreement) throw new Error('约定不存在，这条事项已失效');
  lockWithOwnerMessage(ctx, agreement, { version: parsed.version, via: 'inbox', choices: null, answerText: '按建议，定了' });
  // 条目正常情况下已在 finishLock 里了结；若约定的 inboxId 与它不一致，这里补上，保证这条一定变成已回答。
  const current = ctx.store.table('inbox').get(item.id)!;
  if (current.status === 'open') {
    const patched = ctx.store.table('inbox').patch(item.id, { status: 'answered', answer: '按建议，定了', answeredAt: ctx.clock.now() });
    emitInboxChange(ctx, item);
    return patched;
  }
  return current;
}

// ---------------------------------------------------------------------------
// 途径三：打字
// ---------------------------------------------------------------------------

/** 总管私聊里有两张以上约定在等主人确认时，打字「定了」不识别，中心落的那句话（原文，P74e）。 */
export function ambiguousConfirmText(count: number): string {
  return `现在有 ${count} 张约定在等你确认，请在要确认的那张卡上点「定了」。`;
}

/**
 * 总管私聊（或 W1 的项目对话）里主人已经看到卡片的待确认约定（最新版待确认且已落楼），按 updatedAt 从新到旧。
 * 约定卡发在约定的 originThread：总管私聊（线程 id 就是总管 id）或项目对话（线程 id 是那个主题 id）。
 */
export function seenPendingIn(ctx: HubContext, threadId: string): Agreement[] {
  const rows = ctx.store.table('projectTopics').get(threadId) !== null
    ? ctx.store.table('agreements').list(row => row.state === 'pending').sort((a, b) => b.updatedAt - a.updatedAt)
    : pendingAgreementsOf(ctx, threadId);
  return rows.filter(row => {
    const latest = row.versions[row.versions.length - 1]!;
    return row.originThread === threadId && latest.state === 'pending' && latest.cardMessageId !== null;
  });
}

/** 打字确认的结果：固定了哪一份（没有为 null）；私聊里同时有几张待确认约定而没有识别（没有为 0）。 */
export interface ConfirmByTextResult { locked: Agreement | null; ambiguous: number }

/**
 * 主人在某个线程里发了一句话：若它是确认口令，且当前有一份主人看过的待确认约定，就固定它。
 * 返回固定了哪一份（P74e：调用方据此决定要不要叫醒总管——这份约定有正在做的事时不叫，见方案 5.3、5.4）。
 * 规则：
 * - 主题线程：只认这个主题自己的那一张；
 * - 项目对话（W1）：和总管私聊一样，认卡片发在这里的待确认约定；
 * - 总管私聊（含 DSH 会话直聊）：待确认约定恰好一张时照旧识别；两张以上时不识别、不固定任何一张，
 *   中心落一句「现在有 n 张约定在等你确认，请在要确认的那张卡上点「定了」。」，返回 ambiguous 为 n。
 * 同步函数，任何异常都捕获后记日志并返回「没有固定」，绝不能让主人发消息失败。
 */
export function confirmByTextDetail(ctx: HubContext, threadId: string, message: ThreadMessage): ConfirmByTextResult {
  const none: ConfirmByTextResult = { locked: null, ambiguous: 0 };
  try {
    if (!isConfirmPhrase(message.text)) return none;
    let agreement: Agreement | null;
    const topic = ctx.store.table('projectTopics').get(threadId);
    if (topic && !isConversationTopic(topic)) {
      const found = agreementForTopic(ctx, threadId);
      agreement = found?.state === 'pending' ? found : null;
    } else {
      const seen = seenPendingIn(ctx, threadId);
      if (seen.length >= 2) {
        // 两张以上：不替主人猜是哪一张。这条消息不固定任何一张，也不叫醒总管（调用方按 ambiguous 判断）。
        postThread(ctx, { thread: threadId, from: 'hub', kind: 'system', text: ambiguousConfirmText(seen.length), refId: message.id });
        return { locked: null, ambiguous: seen.length };
      }
      agreement = seen[0] ?? null;
    }
    if (!agreement) return none;
    const latest = agreement.versions[agreement.versions.length - 1]!;
    // 最新版必须待确认且已落楼；还没落楼说明主人没看过它。
    if (latest.state !== 'pending' || latest.cardMessageId === null) return none;
    // 主人这句话必须不早于卡片落楼：防止对着旧版说的「定了」固定了没看过的新版。
    const card = ctx.store.log('thread').recent(1, row => row.id === latest.cardMessageId)[0];
    if (!card || card.createdAt > message.createdAt) return none;
    const locked = finishLock(ctx, agreement, { version: latest.no, via: 'text', choices: null, confirmMessageId: message.id, answerText: '定了' });
    return { locked, ambiguous: 0 };
  }
  catch (error) {
    ctx.logger.error('按口令固定约定失败', error);
    return none;
  }
}

/**
 * 同上，只返回有没有固定（旧调用方沿用）。
 * 不叫醒总管：这条消息本来就会按原路径叫醒它；需要「固定的是正在做的事的约定时不叫醒」的调用方改用 confirmByTextDetail。
 */
export function confirmByText(ctx: HubContext, threadId: string, message: ThreadMessage): boolean {
  return confirmByTextDetail(ctx, threadId, message).locked !== null;
}

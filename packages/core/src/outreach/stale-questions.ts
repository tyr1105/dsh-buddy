/**
 * P83：主人已经在私聊里直接回了话，这位员工更早开着的提问标为已失效。
 *
 * 为什么要有这个文件：
 * - 员工提问（hub_commit 的 ownerQuestion）建出来的「待你处理」条目不设到期时间（P76c 起就是这样），
 *   只有主人在卡片上作答才会关掉。主人改在对话里直接说话时，这张卡永远开着；
 * - 更糟的是，开着的提问会让这位员工一直被「等你回答」闸门挡住（scheduler/gates.ts），不再自己起来干活；
 * - 真实模型验证（2026-11-14 第二轮）里，总管 13:27 问「请直接给我发句话，我才好提交约定」，
 *   主人 13:28 就直接发了一句话，而那张卡在约定提交、验收、发布全部做完之后还挂在「待你处理」里。
 *
 * 做法只做一件事：主人在这位员工的私聊里发的话真的叫醒了这位员工之后，把同一私聊里更早开着、还是普通提问（事项键 question:）的条目撤回，
 * 答复栏写明原因。撤回等于「从待办里消失」，卡片在线程里显示为已处理。
 * P85：只在话真的交给这位员工时撤回（见 outreach/thread.ts）。被中心认领、不叫醒员工的话（额度口令、「定了」、
 * 「验收通过」、「撤销」、组队三问的回答等）与提问无关，不撤回，「等你回答」闸门也不因此解开。
 * 只处理私聊里的普通提问：job:、agreement:、team:、learn:、goal_check: 各有自己的收回路径，
 * 别的员工通过唤醒来处理的提问也不在这里动。主人真的还需要答案时，员工会再问一次。
 */
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import type { HubContext } from '../engine/context.js';
import type { InboxItem } from '../model/outreach.js';

/**
 * 撤回时写进答复栏的原因（只有这一处产生）。
 * P85：状态词与线程里卡片上的「已撤回」一致（原来写「已失效：……不再等你答」，两个状态词、偏口语）。
 */
export const STALE_QUESTION_ANSWER = '已撤回：你已在对话里直接回复';

/**
 * P85：被主人这句话撤回的提问，给被叫醒的那位员工看的说明（写进唤醒包的「主人对你说」一节）。
 * 为什么要有：撤回只发生在主人这句话真的叫醒了这位员工的时候，员工在那一回合要能知道自己更早的提问已经撤回，
 * 不要再等那个答案，也不要把提问当成还开着。title 是那条提问的标题，截到 40 个字。
 */
export function withdrawnQuestionNote(title: string): string {
  const shown = [...title.replace(/\s*\r?\n\s*/g, ' ').trim()].slice(0, 40).join('');
  return `中心说明：你更早提的问题「${shown}」已撤回，主人在对话里直接回了话，以主人这句话为准，不用再等那个问题的答案。`;
}

/**
 * P85：这条主人消息撤回了哪几条提问：这位员工名下、答复栏是撤回固定句、撤回时间落在这条消息之后，
 * 且在同一私聊里下一条主人消息之前（撤回与消息在同一次调用里发生，时间相同或极接近；按「最近的一条主人消息」归属，不靠时间差）。
 */
export function questionsWithdrawnBy(ctx: HubContext, botId: string, message: { thread: string; createdAt: number }): InboxItem[] {
  const next = ctx.store.log('thread').all()
    .filter(row => row.thread === message.thread && row.from === 'owner' && row.createdAt > message.createdAt)
    .reduce<number | null>((min, row) => (min === null || row.createdAt < min ? row.createdAt : min), null);
  return ctx.store.table('inbox').list(row => row.botId === botId && row.status === 'withdrawn' && row.answer === STALE_QUESTION_ANSWER
    && row.answeredAt !== null && row.answeredAt >= message.createdAt && (next === null || row.answeredAt < next));
}

/** 这条提问的卡片当时落在哪个线程：按它自己那条提问消息所在的线程算（收件箱条目只记主题，私聊线程记不出来）。 */
function questionThreadOf(ctx: HubContext, item: InboxItem): string | null {
  const card = ctx.store.log('thread').recent(1, row => row.refId === item.id && row.kind === 'question'
    && row.from !== 'owner' && row.from !== 'hub')[0];
  return card?.thread ?? null;
}

/**
 * 撤回这位员工在 thread 里、早于 before 开着的普通提问，返回撤回的条目。
 * 调用方负责 try/catch（撤回失败只记日志，不能挡住主人这句话本来要做的事）。
 */
export function withdrawStaleQuestions(
  ctx: HubContext, input: { botId: string; thread: string; before: number },
): InboxItem[] {
  // 团队线程不区分是哪位员工的私聊，提问卡也不落在这里，不处理。
  if (input.thread === 'team') return [];
  const now = ctx.clock.now();
  const stale = ctx.store.table('inbox').list(row => row.status === 'open' && row.type === 'question' && row.botId === input.botId
    && row.subjectKey.startsWith('question:') && row.createdAt <= input.before && questionThreadOf(ctx, row) === input.thread);
  for (const item of stale) {
    ctx.store.table('inbox').patch(item.id, { status: 'withdrawn', answer: STALE_QUESTION_ANSWER, answeredAt: now });
    // 与 outreach/inbox.ts 的 emitInboxChange 同一套通知范围（这里不 import 它，避免 thread.ts 与 inbox.ts 互相引入）。
    ctx.emit(HUB_EVENT_SCOPES.inbox, item.botId);
    ctx.emit(HUB_EVENT_SCOPES.thread, item.botId);
    if (item.botId) ctx.emit(HUB_EVENT_SCOPES.bot, item.botId);
  }
  return stale;
}

/**
 * 学习选会话的提问卡（P75i 第 4.1 节）：总管这一回合的回复落下之后，在总管私聊落一张提问卡
 * （与总管 ownerQuestion 的提问卡同一种消息：kind 为 question，refId 指向「待你处理」那条条目）。
 *
 * 时机（照 P75c「已记住」挂靠）：交账路由在回复落下之后立刻落（commit/effects.ts）；回合结束时再检查一次，
 * 没有回复、回复没落成或交账出错的回合也会补落（turn/events.ts）。落过的不重复落（按条目编号判断）。
 *
 * 为什么用「本回合开始之后建的、还开着的 learn: 条目」找：teach 在总管的回合里建条目，条目的所属员工就是总管、
 * 建立时间在这个回合的开始之后；不需要另存「这条条目是哪个回合建的」。
 */
import type { HubContext } from '../engine/context.js';
import type { WakeTicket } from '../model/wake.js';
import { postThread } from '../outreach/thread.js';

/** 把这个回合里总管建的、还没有落提问卡的学习选会话条目落成卡片；返回落了几张。出错抛出，调用方只记日志。 */
export function postLearnCards(ctx: HubContext, wake: Pick<WakeTicket, 'botId' | 'startedAt'>): number {
  const items = ctx.store.table('inbox').list(row => row.botId === wake.botId && row.type === 'question' && row.status === 'open'
    && row.subjectKey.startsWith('learn:') && row.createdAt >= wake.startedAt);
  let posted = 0;
  for (const item of items) {
    const already = ctx.store.log('thread').all().some(row => row.thread === wake.botId && row.kind === 'question' && row.refId === item.id);
    if (already) continue;
    postThread(ctx, { thread: wake.botId, from: wake.botId, kind: 'question', text: `${item.title}\n${item.body}`, refId: item.id });
    posted += 1;
  }
  return posted;
}

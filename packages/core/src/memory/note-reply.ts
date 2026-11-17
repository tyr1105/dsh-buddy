/**
 * 回合结束时的检查：这一回合记下的规矩或偏好，必须有一条回复可以挂「已记住」（P75c，方案 7.5）。
 *
 * 为什么要有这一步：「已记住」一行挂在总管的回复下面。但回合可能交账失败、没写 reply，
 * 或回复落在别的对话里（出处在私聊、回复却落在主题里）。这时记忆已经写进去并会影响之后每一次工作，
 * 主人却看不到任何说明，这是不允许的。所以回合结束时再检查一次：还没挂靠的，由中心以总管名义
 * 在出处那个对话里落一句「已记住：{文字}。」，把它作为挂靠的消息。
 *
 * 已经被撤销的不补落（主人已经撤销了，再说「已记住」自相矛盾）。出错只记日志，不影响回合收尾。
 */
import type { HubContext } from '../engine/context.js';
import type { WakeTicket } from '../model/wake.js';
import { postThread } from '../outreach/thread.js';
import { attachHistoryRow, attachMemoryRow } from './service.js';
import { stripEndMark } from './undo.js';

/** 这一回合记下却还没挂靠的记忆，逐条补落「已记住」并挂靠。 */
export function ensureNotesShown(ctx: HubContext, wake: Pick<WakeTicket, 'id' | 'botId'>): void {
  const pending = ctx.store.table('memories').list(row => row.noteWakeId === wake.id && row.replyMessageId === null
    && row.status === 'active' && row.source.threadId !== null);
  for (const row of pending) {
    try {
      const posted = postThread(ctx, { thread: row.source.threadId!, from: wake.botId, kind: 'reply', text: `已记住：${stripEndMark(row.text)}。` });
      attachMemoryRow(ctx, row.id, posted.id);
    } catch (error) {
      try { ctx.logger.error('回合结束时补落「已记住」失败', error); } catch { /* 日志出错也不能抛出去。 */ }
    }
  }
  // P75d：本回合在对话里更正、删除（hub_memory 的 correct、forget）却没有回复可挂的：以总管名义补落一句并挂靠。
  const changed = ctx.store.table('memories').list(row => row.history.some(item => item.wakeId === wake.id && item.replyMessageId === null && item.threadId !== null));
  for (const row of changed) {
    for (const item of row.history.filter(entry => entry.wakeId === wake.id && entry.replyMessageId === null && entry.threadId !== null)) {
      // 同一条记忆同一回合有两项时，挂靠一次会把两项都挂上；重新读一遍，已挂上的不再补落。
      const fresh = ctx.store.table('memories').get(row.id)?.history.find(entry => entry.at === item.at && entry.action === item.action);
      if (fresh === undefined || fresh.replyMessageId !== null) continue;
      try {
        const text = item.action === 'deleted' ? `已删除「${stripEndMark(item.text)}」。` : `已更正为「${stripEndMark(row.text)}」。`;
        const posted = postThread(ctx, { thread: item.threadId!, from: wake.botId, kind: 'reply', text });
        attachHistoryRow(ctx, row.id, wake.id, posted.id);
      } catch (error) {
        try { ctx.logger.error('回合结束时补落「已更正」「已删除」失败', error); } catch { /* 日志出错也不能抛出去。 */ }
      }
    }
  }
}

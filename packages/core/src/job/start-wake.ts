/**
 * 丢弃某位员工队列里属于某件事的候选（P74b 建，P74c 瘦身）。
 *
 * 为什么留这个文件：改派时要丢弃旧执行者队列里这件事的候选，并且能撤销。
 * 原来这里的「排一次接这件事的唤醒」临时入队写法，P74c 起统一换成 job/chain.ts 的 enqueueJobWake（带撤销的版本叫
 * enqueueJobWakeUndoable）；员工是否在岗的判断 isOnDutyNow 也一并搬到了那里，这里保留一个同名转出，旧的引用不用改。
 */
import type { HubContext } from '../engine/context.js';
import type { QueueEntry } from '../model/wake.js';
import { removeEntry } from '../scheduler/queue.js';

export { isOnDutyNow } from './chain.js';

/**
 * 丢弃这位员工队列里属于某件事的候选（改派时对旧执行者用）。
 * 返回撤销闭包：把被丢的候选和员工状态放回去。
 */
export function dropJobEntries(ctx: HubContext, botId: string, jobId: string): () => void {
  const dropped: QueueEntry[] = ctx.store.table('queue').list(row => row.botId === botId && row.jobId === jobId);
  const botBefore = ctx.store.table('bots').get(botId);
  for (const entry of dropped) removeEntry(ctx, entry.id);
  return () => {
    for (const entry of dropped) ctx.store.table('queue').put(entry);
    if (botBefore) ctx.store.table('bots').put(botBefore);
  };
}

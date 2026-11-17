/**
 * 一件事的「记录」（P76g，方案 7.6）：判断一件事「有没有动静」的唯一依据。
 *
 * 什么算记录（取下面几个时间里最晚的一个）：
 * 一、这件事的任一事件（jobEvents），但不含中心自己的兜底叫醒（isIdleResumeEvent 为真的 resumed 事件）：
 *     兜底叫醒是中心的动作，不是进展，否则叫一次就会让「没有动静」的计时重新开始；
 * 二、这件事主题里的任一条消息（含主人的话、员工交账时落的工作往来、放文件时落的说明）；
 *     中心为兜底叫醒不在主题里落任何提示，所以主题里的消息都算；
 * 三、这件事的派活时间（还没有任何事件和消息时的起点）。
 *
 * 为什么「回合开始或结束」不单独算记录：有回合在排队或在跑时，停滞判断本来就不判停摆（见 stall-check.ts 的「running」）；
 * 回合交账时，员工做过的事会在主题落工作往来或产生事件，已经算进上面两类。重新唤醒的那个回合如果没有交账就结束，
 * 不留下任何记录，正是「重新唤醒之后仍没有记录」的情形。
 *
 * 纯函数：只读传入的数据，不读存储、不读时钟。
 */
import type { Job, JobEvent } from '../model/job.js';
import type { ThreadMessage } from '../model/outreach.js';
import { isIdleResumeEvent } from './sweep-events.js';

/** 最近一次记录的时间。topicMessages 是这件事主题里的消息（只用到 createdAt）。 */
export function lastProgressAtOf(job: Pick<Job, 'assignedAt'>, events: readonly JobEvent[], topicMessages: ReadonlyArray<Pick<ThreadMessage, 'createdAt'>>): number {
  let latest = job.assignedAt;
  for (const event of events) {
    if (!isIdleResumeEvent(event) && event.at > latest) latest = event.at;
  }
  for (const message of topicMessages) {
    if (message.createdAt > latest) latest = message.createdAt;
  }
  return latest;
}

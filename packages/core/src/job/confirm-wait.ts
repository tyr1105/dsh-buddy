/**
 * 「这件事此刻在等主人确认约定的新版本」的判断（P74r2b，纯函数）。
 *
 * 为什么单独一个文件：兜底巡检（chain.ts 的 expectedActorOf）、进度行（api/job-views.ts）、延迟说明（delay.ts）、
 * 回合上限条目正文（cap.ts）都要用同一份口径，而其中有的文件不能互相引用（会形成循环），所以放在没有任何依赖的这里。
 *
 * 两种情形：
 * 1. 执行者（或核对人）的提问在约定里推不出答案，总管已经出了新版本请主人确认（openAsk.agreementNo 有值）；
 * 2. 执行者已经把照常在做的部分做完，在等主人确认（pause.executorWaiting 为真），且没有别的未回答的提问。
 */
import type { Job } from '../model/job.js';

/** 执行者干活的三个状态。 */
const WORKING_STATES: readonly Job['state'][] = ['ready', 'doing', 'rework'];

/** 在等主人确认时返回那一版的版本号；不是返回 null。 */
export function confirmWaitNo(job: Pick<Job, 'state' | 'pause' | 'openAsk'>): number | null {
  if (job.pause === null) return null;
  if (job.openAsk !== null && job.openAsk.agreementNo != null) return job.pause.versionNo;
  if (job.openAsk === null && job.pause.executorWaiting === true && WORKING_STATES.includes(job.state)) return job.pause.versionNo;
  return null;
}

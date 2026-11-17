/**
 * 重新唤醒留下的事件的判断（从 sweep.ts 拆出）：「记录」（progress-mark.ts）要排除它们：
 * 重新唤醒是中心自己的动作，不是进展。拆出来才不会和 sweep.ts 形成循环引用。纯函数，不读存储。
 */
import type { JobEvent } from '../model/job.js';

/** 重新唤醒留下的事件：kind 为 resumed，data.idle 为真。 */
export function isIdleResumeEvent(event: JobEvent): boolean {
  return event.kind === 'resumed' && event.data.idle === true;
}

/**
 * 「待你处理」里一件事的条目的回答分流（P74f、P74f-2）。
 *
 * 四类条目（事项键 job:<jobId>:<种类>:...）各有专用的回答函数，都不走通用回答、不排 inbox_reply 唤醒：
 * - accept 验收：只认「验收通过」，落到 acceptJob（验收的五条途径之一）；
 * - escalate 三轮不过的办法：点「A　标题」这样的按钮，落到 chooseJobOption（choose-option.ts）；
 * - cap 回合用到上限：「再给 N 个回合」「先停下」，落到 answerJobCap（blocked-answer.ts）；
 * - stall 停住了：「再叫一次」「先停下」，落到 answerJobStall。
 * 回答不在固定的选项里一律报错、什么都不改：这几类条目都没有默认选项，不能替主人拿主意。
 */
import type { HubContext } from '../engine/context.js';
import type { InboxItem } from '../model/outreach.js';
import { JOB_ACCEPT_OPTION } from '../outreach/inbox.js';
import { acceptJob } from './accept.js';
import { answerJobCap, answerJobStall } from './blocked-answer.js';
import { chooseFromInbox } from './choose-option.js';

/** 事项键 job:<jobId>:accept:<阶段> 拆开；格式不对返回 null。 */
export function parseAcceptSubjectKey(subjectKey: string): { jobId: string; stage: number } | null {
  const match = /^job:(job_[a-z0-9]{10}):accept:(\d+)$/.exec(subjectKey);
  return match === null ? null : { jobId: match[1]!, stage: Number(match[2]) };
}

/** 事项键拆成事编号和种类；不是一件事的条目返回 null。 */
function parseJobSubjectKey(subjectKey: string): { jobId: string; kind: string } | null {
  const match = /^job:(job_[a-z0-9]{10}):(accept|escalate|cap|stall):/.exec(subjectKey);
  return match === null ? null : { jobId: match[1]!, kind: match[2]! };
}

/** 这个条目要不要走专用回答（验收、三轮不过、回合上限、停住了）。 */
export function isJobInboxItem(item: Pick<InboxItem, 'type' | 'subjectKey'>): boolean {
  return item.type === 'question' && parseJobSubjectKey(item.subjectKey) !== null;
}

/** 「待你处理」条目视图里的 jobEntry：这是一件事的哪一类条目。 */
export type JobEntryKind = 'accept' | 'escalate' | 'cap' | 'stall';

/**
 * P74r4b 第 6 节：条目是一件事的哪一类条目、属于哪件事；不是这四类返回 null。
 * 与 isJobInboxItem、answerJobInbox 分流用的是同一套判断（同一个 parseJobSubjectKey、同样要求是提问类条目），不另写一套。
 * 界面据此显示对应的操作，不再按按钮文字的形状猜；core 以后改按钮文字也不影响。
 */
export function jobEntryOf(item: Pick<InboxItem, 'type' | 'subjectKey'>): { kind: JobEntryKind; jobId: string } | null {
  if (!isJobInboxItem(item)) return null;
  const parsed = parseJobSubjectKey(item.subjectKey);
  return parsed === null ? null : { kind: parsed.kind as JobEntryKind, jobId: parsed.jobId };
}

/** 回答一件事的条目。返回更新后的条目。 */
export function answerJobInbox(ctx: HubContext, item: InboxItem, answer: string): InboxItem {
  const parsed = parseJobSubjectKey(item.subjectKey);
  if (parsed === null) throw new Error('这条事项已失效');
  switch (parsed.kind) {
    case 'accept': {
      const accept = parseAcceptSubjectKey(item.subjectKey);
      if (accept === null) throw new Error('这条事项已失效');
      if (answer.trim() !== JOB_ACCEPT_OPTION) throw new Error(`在「待你处理」里只能回答「${JOB_ACCEPT_OPTION}」；哪条不符合，请去对话里写序号和问题`);
      acceptJob(ctx, { jobId: accept.jobId, stage: accept.stage, via: 'inbox', messageId: null });
      break;
    }
    case 'escalate': chooseFromInbox(ctx, item, answer); break;
    case 'cap': answerJobCap(ctx, { jobId: parsed.jobId, answer, via: 'inbox' }); break;
    default: answerJobStall(ctx, { jobId: parsed.jobId, answer, via: 'inbox' });
  }
  return ctx.store.table('inbox').get(item.id)!;
}

/**
 * 主人答复「预计消耗」「停住了」两类条目时，共用的「写状态、叫人、记事件」一步（P74f-2，P76f 从 blocked-answer.ts 拆出）。
 *
 * 为什么拆出来：预计消耗条目的答复（budget-answer.ts）和「停住了」条目的答复（blocked-answer.ts）走同一套三段式，
 * 两个文件都要用它；放在任何一边都会让另一边反过来引用，形成循环引用。
 *
 * 三段式（方案 6.4）里的第二段：全部写进存储，每一步登记撤销动作，任何一步失败整体恢复，抛出中文错误；
 * 成功之后做第三段前的收尾（审计、通知界面、撤回其余受阻条目）。第三段「主人看得见的话」由调用方做。
 */
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import type { HubContext } from '../engine/context.js';
import { JobSchema, type Job } from '../model/job.js';
import type { InboxItem } from '../model/outreach.js';
import { writeOutreachAudit } from '../outreach/audit.js';
import { emitInboxChange } from '../outreach/inbox.js';
import { openBlockItems, withdrawBlockItems } from './block-items.js';
import { clearOverdueMark, restoreNotice } from './notices.js';
import { appendJobEvent, putJob } from './store.js';
import { wakeExpected } from './unblock.js';
import { runUndoSync, softly, type UndoSteps } from './work-common.js';

/** 答复的入口：「待你处理」按钮，或界面命令。 */
export type BlockedAnswerVia = 'inbox' | 'command';

/** 写状态之外的几步（只有预计消耗条目的答复用）：额外的写入（预计、提醒记号），以及不走「叫此刻该动的人」的自定义叫醒。 */
export interface CommitExtras {
  /** 状态写好、条目答复之后做的额外写入；要撤销的登记进撤销清单。 */
  writes?: (undo: UndoSteps) => void;
  /** 自定义叫醒：返回被叫醒的员工 id（没叫人返回 null）；叫不醒时抛出中文错误。给了它就不再走 wake 参数的默认叫法。 */
  wakeWith?: (undo: UndoSteps) => string | null;
}

/** 写状态、叫人、记事件的共同流程；失败整体恢复。返回写好的事。 */
export function commitAnswer(ctx: HubContext, job: Job, item: InboxItem, next: Job, answer: string, kind: 'cap' | 'stall',
  via: BlockedAnswerVia, wake: { summary: string } | null, extra: Record<string, unknown>, extras: CommitExtras = {}): { job: Job; wokenId: string | null } {
  const now = ctx.clock.now();
  const others = openBlockItems(ctx, job.id).filter(row => row.id !== item.id);
  const undo: UndoSteps = [];
  let wokenId: string | null = null;
  try {
    putJob(ctx, JobSchema.parse(next));
    undo.push(() => { putJob(ctx, job); });
    ctx.store.table('inbox').patch(item.id, { status: 'answered', answer, answeredAt: now });
    undo.push(() => { ctx.store.table('inbox').put(item); });
    // P84（K4）：答复的是「没有进展」条目：条目了结，逾期记号一并清掉（失败时原样写回）。
    if (kind === 'stall') {
      const noticeBefore = ctx.store.table('jobNotices').get(job.id);
      if (clearOverdueMark(ctx, job.id) !== undefined) undo.push(() => { restoreNotice(ctx, job.id, noticeBefore); });
    }
    extras.writes?.(undo);
    if (extras.wakeWith !== undefined) wokenId = extras.wakeWith(undo);
    else if (wake !== null) wokenId = wakeExpected(ctx, next, wake.summary, undo);
    appendJobEvent(ctx, { jobId: job.id, actor: 'owner', kind: kind === 'cap' ? 'cap_answered' : 'resumed', to: wokenId === null ? [job.chiefId] : [wokenId],
      refId: item.id, data: { answer, via, ...extra } });
  } catch (error) {
    runUndoSync(ctx, undo, '答复', job.id);
    ctx.emit(HUB_EVENT_SCOPES.project, null);
    throw new Error(`答复没有记下，已恢复到之前的状态：${error instanceof Error ? error.message : String(error)}`);
  }
  writeOutreachAudit(ctx, kind === 'cap' ? 'job_cap_answer' : 'job_stall_answer', { jobId: job.id, answer, via }, 'owner', now);
  ctx.runtime.ownerActiveAt = now;
  ctx.emit(HUB_EVENT_SCOPES.project, null);
  ctx.emit(HUB_EVENT_SCOPES.bot, job.chiefId);
  emitInboxChange(ctx, item);
  softly(ctx, '撤回其余受阻条目', () => { withdrawBlockItems(ctx, others, now, '主人已答复，这件事有了新的进展'); });
  return { job: next, wokenId };
}

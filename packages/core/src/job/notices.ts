/**
 * 一件事的提醒记号（表 jobNotices，P76b 建表）的读写入口（P76f 起）。
 *
 * 为什么单独一个文件：「同一个预算线只问一次」「你选了暂停」「你选了缩小范围」都记在这张表里，
 * 读取时没有记录要给出一份默认的，写入时要保持其余字段不变。集中在这里，各处不用各写一遍默认值。
 * 这张表是新表，不改一件事（Job）的结构，旧版本直接忽略它。
 */
import type { HubContext } from '../engine/context.js';
import { JobNoticeSchema, type JobNotice } from '../model/budget.js';

/** 这件事的提醒记号；没有记录时给一份默认的（不写入）。 */
export function noticeOf(ctx: HubContext, jobId: string): JobNotice {
  const existing = ctx.store.table('jobNotices').get(jobId);
  if (existing !== null) return existing;
  const job = ctx.store.table('jobs').get(jobId);
  const now = ctx.clock.now();
  return {
    id: jobId, lastProgressAt: job?.assignedAt ?? now, rewakeAt: null, stallNotifiedAt: null, stallKind: null, overdueNotifiedFor: null,
    remindedItemIds: [], budgetAskedCaps: [], holdAtCap: false, narrowRequestedAt: null, dueRiskNotifiedAt: null, updatedAt: now,
  };
}

/** 改这件事的提醒记号里的几项，其余不变；返回改之前的记录（供撤销时原样写回；改之前没有记录时为 null）。 */
export function patchNotice(ctx: HubContext, jobId: string, changes: Partial<Omit<JobNotice, 'id'>>): JobNotice | null {
  const before = ctx.store.table('jobNotices').get(jobId);
  const base = noticeOf(ctx, jobId);
  ctx.store.table('jobNotices').put(JobNoticeSchema.parse({ ...base, ...changes, id: jobId, updatedAt: ctx.clock.now() }));
  return before;
}

/**
 * 清掉「逾期」记号（P84，K4）：逾期条目被答复、被撤回或被取代时调用。
 * 为什么要清：记号一直留着，之后新建的「回合被结束」条目会被「交付时间已改」那条规则当成逾期条目撤回；
 * 逾期记号也用来判断开着的「没有进展」条目是不是逾期条目（owner-ask.ts）。
 * 只清「逾期」这一种，停摆、空转的记号照旧；没有记录或不是逾期时什么都不做。返回改之前的记录（没有改动时为 undefined），供撤销用。
 */
export function clearOverdueMark(ctx: HubContext, jobId: string): JobNotice | null | undefined {
  const existing = ctx.store.table('jobNotices').get(jobId);
  if (existing === null || existing.stallKind !== 'overdue') return undefined;
  return patchNotice(ctx, jobId, { stallKind: null });
}

/** 把提醒记号恢复成 before（null 表示原来没有记录）：撤销清单用。 */
export function restoreNotice(ctx: HubContext, jobId: string, before: JobNotice | null): void {
  if (before === null) ctx.store.table('jobNotices').remove(jobId);
  else ctx.store.table('jobNotices').put(before);
}

/**
 * 在等你：开着满 24 小时提醒一次（P76g，方案 7.7）。
 *
 * 为什么需要：「待你处理」里有一条与某件事（或某份约定）有关的条目，你一直没有处理，这件事就一直停在那里；
 * 中心不替你定，但满 24 小时要提醒你一次，免得它被忘掉。只提醒这一次：之后「待你处理」那一条会显示「已等 {时长}」
 * （条目视图的 waitedText），不再来找你。
 *
 * 对象：开着的条目，满 WAIT_OWNER_REMIND_MS（24 小时），并且
 * - 与一件事有关（relatedJobOfItem 不为空：这件事自己的条目、这份约定已有事的确认条目、组队卡、这件事发布步骤的审批），或
 * - 事项键以 agreement: 开头（约定确认条目；这份约定还没有事时也要提醒）。
 * 员工新提的、与一件事无关的提问不提醒。
 *
 * 提醒记号记在 jobNotices.remindedItemIds：这件事还没有时，约定确认条目的记号写在以约定编号为 id 的行里
 * （同一张表，行的 id 前缀区分：job_ 开头是事，agr_ 开头是还没有事的约定；JobNoticeSchema 的 id 两种都认）。
 * 提醒做两件事：总管私聊以总管名义落一句；推送一条通知（类别取条目的类别，验收等不属于四类的条目按第一类「约定」发，
 * 带条目编号：发出之前条目已被处理就不再推送）。出错只记日志，不影响别的条目。
 */
import { BUDGET_DEFAULTS as D } from '../config/defaults.js';
import { dueTextOf } from '../api/job-views.js';
import type { HubContext } from '../engine/context.js';
import type { Job } from '../model/job.js';
import type { InboxItem } from '../model/outreach.js';
import { notifyCategoryOf, notifyOwner } from '../outreach/notify.js';
import { postThread } from '../outreach/thread.js';
import { jobTitleOf } from './chain.js';
import { relatedJobOfItem } from './disturb.js';
import { noticeOf, patchNotice } from './notices.js';
import { waitedText } from './stall-text.js';

/** 约定确认条目的事项键：agreement:<约定编号>:<版本号>。 */
const AGREEMENT_KEY = /^agreement:(agr_[a-z0-9]{10}):(\d+)/;

/** 条目是哪一种事：提醒里「还在等你……」后面写什么（派活说明第一节，逐字）。 */
export function waitMatterOf(item: Pick<InboxItem, 'type' | 'subjectKey' | 'title'>): string {
  const key = item.subjectKey;
  const agreement = AGREEMENT_KEY.exec(key);
  if (agreement !== null) return `确认约定第 ${agreement[2]} 版`;
  if (/^job:[^:]+:accept:/.test(key)) return '验收';
  if (/^job:[^:]+:cap:/.test(key)) return '决定预计消耗怎样处理';
  if (/^job:[^:]+:escalate:/.test(key)) return '选一个办法';
  if (/^job:[^:]+:stall:/.test(key)) return '决定怎样继续';
  if (item.type === 'approval') return `批准${item.title}`;
  return `处理${item.title}`;
}

/** 总管私聊里的提醒：「{标题}还在等你{事项}，已等 {时长}。交付时间是 {dueText}。」没有交付时间去掉第二句。 */
export function remindText(title: string, matter: string, waitedMs: number, job: Pick<Job, 'dueAt'> | null, timezone: string): string {
  const due = job === null || job.dueAt === null ? '' : `交付时间是 ${dueTextOf(job.dueAt, timezone)}。`;
  return `${title}还在等你${matter}，已等 ${waitedText(waitedMs)}。${due}`;
}

/** 提醒一条。已经提醒过、不属于这件事或约定、约定找不到的，什么都不做。 */
function remindOne(ctx: HubContext, item: InboxItem, now: number): void {
  const job = relatedJobOfItem(ctx, item);
  const agreementId = AGREEMENT_KEY.exec(item.subjectKey)?.[1] ?? null;
  if (job === null && agreementId === null) return;
  const noticeId = job?.id ?? agreementId!;
  if (noticeOf(ctx, noticeId).remindedItemIds.includes(item.id)) return;
  const agreement = job === null ? ctx.store.table('agreements').get(agreementId!) : null;
  if (job === null && agreement === null) return;
  const title = job === null ? agreement!.title : jobTitleOf(ctx, job);
  const chiefId = job === null ? agreement!.botId : job.chiefId;
  const text = remindText(title, waitMatterOf(item), now - item.createdAt, job, ctx.settings.timezone);
  // 先记下「提醒过了」：之后任何一步出错都不会在下个 tick 重复提醒（只提醒这一次）。
  patchNotice(ctx, noticeId, { remindedItemIds: [...noticeOf(ctx, noticeId).remindedItemIds, item.id] });
  try {
    postThread(ctx, { thread: chiefId, from: chiefId, kind: 'reply', refId: job?.id ?? agreementId, text });
  } catch (error) {
    ctx.logger.warn('在等你的提醒的私聊没有落下', { itemId: item.id, error: String(error) });
  }
  // 推送：不等待（notifyOwner 同步写队列，出错只记日志，不会向外抛）。
  void notifyOwner(ctx, { category: notifyCategoryOf(item) ?? 'agreement', title: `${title}还在等你`, body: text,
    subjectKey: `remind:${item.id}`, botId: chiefId, inboxId: item.id }).catch(() => undefined);
}

/** 每个 tick 的巡检调用：对开着满 24 小时的相关条目各提醒一次。 */
export function remindWaitingOwner(ctx: HubContext, now: number): void {
  for (const item of ctx.store.table('inbox').list(row => row.status === 'open' && now - row.createdAt >= D.WAIT_OWNER_REMIND_MS)) {
    try {
      remindOne(ctx, item, now);
    } catch (error) {
      try { ctx.logger.warn('在等你的提醒失败', { itemId: item.id, error: String(error) }); } catch { /* 日志出错也不能挡住别的条目。 */ }
    }
  }
}

/**
 * 「没有进展」告知（P74r1 建，P76g 改写）：三种停滞（停摆、空转、逾期）的统一出口，唯一建这类条目的地方。
 *
 * 为什么需要：一件事停下来而主人不知道，是最糟的情形。判断由 job/stall-check.ts 做，这里只负责「通知你」：
 *   1. 在「待你处理」建一条：标题「{这件事的标题}：没有进展」，选项有可接手的人时是「换{名字}接手」「再提醒一次」「暂停」，
 *      否则只有后两项；没有默认选项、不会到期（只有主人能定，到期按默认处理等于替主人做决定）；
 *      建条目时通知队列自动收到一条通知（类别：没有进展，job/outreach 的 createInboxItem 负责，本文件不另调用）；
 *   2. 把条目编号记在这件事上（inboxId）：之后巡检不再叫人，也不会再建第二条；
 *   3. 写停滞记号（jobNotices：通知时间、种类、逾期通知过的交付时间）：保证「一次停滞只通知一次」；
 *   4. 在总管私聊以总管名义落同样的话，末行说明之后 24 小时内不会再来找你。
 * 两段式：先建条目（会出错的一步，失败时什么都不改，下个 tick 再试），成功之后才写记号，最后落私聊（出错只记日志）。
 *
 * 条目的答复处理在 blocked-answer.ts（再提醒一次、暂停、换人接手）。
 * 「同一次停滞只建一条」：事项键带这件事记录上的序号（stallNo），每建一条加一。
 *
 * P76g 之前这里是另一个函数（旧的告知函数），被「第三块兜底」（30 分钟、两次、转受阻叫总管）和 P74r15 的「总管核对回合被结束两次」共用，现已删除。
 * 兜底整段删除；总管核对回合被结束两次这一条路径（chain-turn-end.ts）仍要告诉主人，改调 reportStall，
 * 用 kind 为 ended 并自带正文和私聊文字（那是事实句，不套停摆、空转、逾期的句式）。
 */
import type { HubContext } from '../engine/context.js';
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import { BUDGET_DEFAULTS as B } from '../config/defaults.js';
import type { Job } from '../model/job.js';
import type { StallKind } from '../model/budget.js';
import { createInboxItem, emitInboxChange } from '../outreach/inbox.js';
import { postThread } from '../outreach/thread.js';
import { stallOptionsOf } from './block-options.js';
import { expectedActorOf, jobTitleOf } from './chain.js';
import { clearOverdueMark, patchNotice, noticeOf } from './notices.js';
import { hasAnyOpenJobItem } from './owner-ask.js';
import { stallBodyLines, stallChatClosing, waitedText } from './stall-text.js';
import { spinRunOf } from './stall-spin.js';
import { takeoverCandidateOf } from './stall-takeover.js';
import { eventsOf } from './store.js';

// waitedText 原来写在本文件，别处仍从这里引用。
export { waitedText };

/** 停滞条目的事项键：job:<jobId>:stall:<这件事记录上的序号>。 */
export function stallSubjectKey(jobId: string, stallNo: number): string {
  return `job:${jobId}:stall:${stallNo}`;
}

/** 这件事的「没有进展」条目的事项键前缀（job:<jobId>:stall:）。 */
export function stallSubjectPrefix(jobId: string): string {
  return `job:${jobId}:stall:`;
}

/**
 * 这件事当前给主人的那一条，是不是「没有进展」条目（P74r2a）。
 * 总管之后处理了（换核对人、提交核对结论）时，要把它撤回；预计消耗等其他条目不在这里处理。
 */
export function hasOpenStallItem(ctx: HubContext, job: Pick<Job, 'id' | 'inboxId'>): boolean {
  if (job.inboxId === null) return false;
  const item = ctx.store.table('inbox').get(job.inboxId);
  return item !== null && item.status === 'open' && item.subjectKey.startsWith(stallSubjectPrefix(job.id));
}

/**
 * 撤回这件事开着的「没有进展」条目（总管已经处理）。出错由调用方按「主人看得见的动作」处理，只记日志。
 * 返回被撤回的条目编号（P76r3，R11：调用方先重读这件事，只在编号仍等于被撤回的那一条时才清空）。
 * 做法与 stop.ts 撤回条目一致：状态改为撤回，答复栏写明原因。
 */
export function withdrawStallItems(ctx: HubContext, jobId: string, now: number, why: string): string[] {
  const prefix = stallSubjectPrefix(jobId);
  const withdrawn: string[] = [];
  for (const item of ctx.store.table('inbox').list(row => row.status === 'open' && row.subjectKey.startsWith(prefix))) {
    ctx.store.table('inbox').patch(item.id, { status: 'withdrawn', answer: why, answeredAt: now });
    emitInboxChange(ctx, item);
    withdrawn.push(item.id);
  }
  // P84（K4）：条目了结，逾期记号一并清掉（之后新建的条目不会被当成逾期条目撤回）。
  if (withdrawn.length > 0) clearOverdueMark(ctx, jobId);
  return withdrawn;
}

/** reportStall 的种类：三种停滞，或 ended（总管核对的回合被中心结束两次，正文由调用方给）。 */
export type StallReportKind = StallKind | 'ended';

/** reportStall 的可选参数。 */
export interface StallReportDetail {
  /** 空转时连续几个回合没有新文件或新证据；省略时现算。 */
  spinRun?: number;
  /** ended 必填：条目正文与总管私聊的话（事实句，由调用方写）。 */
  facts?: { body: string; thread: string };
  /** 预期的人；省略时取这件事此刻在等的人，没有就取总管。 */
  actorId?: string;
}

/**
 * 通知你这件事没有进展。返回是否真的建了条目（已经有条目开着、主人已经知道时返回 false，什么都不改）。
 * 不判断「该不该通知」（那是 stall-check.ts 的事）；建条目失败时抛出，什么都没有改。
 */
export function reportStall(ctx: HubContext, job: Job, kind: StallReportKind, now: number, detail: StallReportDetail = {}): boolean {
  // P76r3（R1）：这件事有任一开着的条目（含不记进 job.inboxId 的「将超出预计」、说明条目）时，主人已经知道，不再重复，
  // 也不因建条目撤回主人正在决定的条目。口径与停滞判断的「乙」共用一份。
  if (hasAnyOpenJobItem(ctx, job.id)) return false;
  const title = jobTitleOf(ctx, job);
  const notice = noticeOf(ctx, job.id);
  const actorId = detail.actorId ?? expectedActorOf(job) ?? job.chiefId;
  // 事项键里的序号取这件事记录上的计数（stallNo），不数事件日志（日志只保留近 14 天，重启后只加载近 14 天）。
  const stallNo = (job.stallNo ?? 0) + 1;
  let body: string;
  let chat: string;
  let chatFrom: 'hub' | string;
  if (kind === 'ended') {
    if (detail.facts === undefined) throw new Error('facts：ended 必须给出条目正文和私聊文字');
    body = detail.facts.body;
    chat = detail.facts.thread;
    chatFrom = 'hub';
  } else {
    const spinRun = kind === 'spin'
      ? detail.spinRun ?? (spinRunOf(ctx, job.id, actorId, eventsOf(ctx, job.id), notice.stallNotifiedAt) || B.SPIN_TURNS) : 0;
    const lines = stallBodyLines(ctx, job, { kind, actorId, lastProgressAt: notice.lastProgressAt, rewakeAt: notice.rewakeAt, spinRun }, now);
    body = lines.join('\n');
    // P76r3（R2、R10 第 3 点）：逾期时这件事可能正在做、进展正常，末行说明「同一个交付时间只通知这一次」；
    // 停摆、空转的末行不变（有新进展之后重新计时）。
    chat = [...lines, kind === 'overdue' ? '同一个交付时间只通知这一次。' : stallChatClosing(title)].join('\n');
    chatFrom = job.chiefId;
  }
  // 可接手的人：卡住的是总管、或没有合适的人时没有这一项。
  const candidate = kind === 'ended' ? null : takeoverCandidateOf(ctx, job, actorId, now);
  // P76r3（R2、R10 第 3 点）：逾期写「已过交付时间」，停摆、空转仍写「没有进展」。
  const itemTitle = kind === 'overdue' ? `${title}：已过交付时间` : `${title}：没有进展`;
  // 第一段：建条目（会出错的一步）。失败时抛出，下面什么都没有写。
  const item = createInboxItem(ctx, {
    botId: job.chiefId, type: 'question', title: itemTitle, body,
    options: stallOptionsOf(candidate === null ? null : candidate.name), defaultOption: null, expiresAt: null, priority: 'P1',
    refId: job.id, subjectKey: stallSubjectKey(job.id, stallNo),
  });
  // 第二段：写这件事的条目编号与序号、停滞记号。建条目时「打扰你」已在记录上加一（createInboxItem）：取最新的计数，不能被建条目之前读到的旧记录盖掉。
  ctx.store.table('jobs').put({ ...job, disturbCount: ctx.store.table('jobs').get(job.id)?.disturbCount ?? job.disturbCount ?? 0, inboxId: item.id, stallNo, updatedAt: now });
  patchNotice(ctx, job.id, {
    stallNotifiedAt: now,
    // P84（K4）：「回合被结束」不写种类；但之前遗留的逾期记号要清掉，免得它被当成逾期条目。
    ...(kind === 'ended' ? (notice.stallKind === 'overdue' ? { stallKind: null } : {}) : { stallKind: kind }),
    ...(kind === 'overdue' && job.dueAt !== null ? { overdueNotifiedFor: job.dueAt } : {}),
  });
  // 第三段：总管私聊（出错只记日志）。
  try {
    postThread(ctx, { thread: job.chiefId, from: chatFrom, kind: chatFrom === 'hub' ? 'system' : 'reply', refId: job.id, text: chat });
  } catch (error) {
    ctx.logger.warn('停滞提示的私聊没有落下', { jobId: job.id, error: String(error) });
  }
  ctx.emit(HUB_EVENT_SCOPES.project, null);
  ctx.emit(HUB_EVENT_SCOPES.inbox, job.chiefId);
  return true;
}

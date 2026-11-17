/**
 * 右侧栏「在办的事」（P76i，方案 7.11）：每件事三行（标题与状态、在等谁与交付时间、消耗），加头部合计。
 *
 * 为什么是一个读取函数：这些文字完全由记录决定，不调用模型；进度行的状态词、在等谁、第几轮、交付时间全部取
 * jobProgressView 的输出（job-progress-base.ts），消耗取 P76e 分步记账的用量行和预计，数字与进度行第三行同一个来源，
 * 几处说的才不会各说各话。总管左栏的一句（chiefJobLine）读这里的行，口径只有一份。
 *
 * 口径（只按一件事和约定的记录数，**不读目标表**）：
 * - 总管：他是总管（chiefId）的、没收尾的事（状态不是已完成、已停止；已完成但还在发布环节的也算没收尾，
 *   用 inLaunchPhase 判断），加上他提交的、待确认、还没有进行中的事的约定（这一行的状态词是「对齐中」）；
 * - 其他员工：他是执行者或核对人的、没收尾的事。
 * 不读目标表的原因：总管的目标在一件事做完之后一直是「进行中」（第三块遗留），拿它计数会永远多出一件。
 *
 * 排序：在等你的在前，其间按「已等」从长到短；其余按交付时间先后，没有交付时间的最后；同序按更新时间新到旧。
 * 本文件只读存储，不写任何东西。
 */
import { z } from 'zod';
import type { HubContext } from '../engine/context.js';
import { ALIGNING_LABEL, type Job } from '../model/job.js';
import type { Agreement } from '../model/agreement.js';
import type { InboxItem } from '../model/outreach.js';
import { activeJobOfAgreement } from '../job/agreement-hooks.js';
import { expectedActorOf } from '../job/chain.js';
import { confirmWaitNo } from '../job/confirm-wait.js';
import { displayEstimate, latestEstimate } from '../job/estimate.js';
import { inLaunchPhase } from '../job/launch-turns.js';
import { hasAnyOpenJobItem, ownerAskOpenOf } from '../job/owner-ask.js';
import { waitedText } from '../job/stall.js';
import { isJobClosed } from '../job/store.js';
import { alignmentOf, usageTotals } from '../job/usage.js';
import { ownerCostPhrase } from '../job/usage-text.js';
import { pendingAgreementsOf } from '../project/agreements.js';
import { listQueue } from '../scheduler/queue.js';
import { buildSnapshot, evaluateGates } from '../scheduler/gates.js';
import { isOpenWake } from '../turn/session.js';
import { formatTokenCount } from '../util/token-format.js';
import { currentVersionNo, progressBaseOf } from './job-progress-base.js';
import { dueTextOf } from './job-views.js';
import { quotaWindowView } from './quota-views.js';

// ---------------------------------------------------------------------------
// 视图结构（插件在 P76j 使用，zod 结构与类型共用一份定义）
// ---------------------------------------------------------------------------

export const ActiveJobRowSchema = z.strictObject({
  key: z.string(), // 一件事的编号或约定编号（界面用来定位，不显示）
  topicId: z.string(),
  title: z.string(),
  stateLabel: z.string(),
  stateTone: z.enum(['run', 'you', 'ok']),
  waitText: z.string(), // 「在等：{谁}　{补充}　交付：{交付时间}」
  costText: z.string(), // 「{已用} / {预计} 回合　{x} token」或「已用 {已用} 回合　{x} token」
  costRatio: z.number().nullable(), // 已用 / 预计，画消耗条用；没有预计时为 null
  waitingOwner: z.boolean(), // 这一行现在是不是在等你
});
export type ActiveJobRow = z.infer<typeof ActiveJobRowSchema>;

export const ActiveJobsViewSchema = z.strictObject({
  headText: z.string(),
  rows: z.array(ActiveJobRowSchema),
  footerText: z.literal('查看全部记录'),
});
export type ActiveJobsView = z.infer<typeof ActiveJobsViewSchema>;

/** 只用于排序的内部信息，不进视图。 */
interface Draft { row: ActiveJobRow; waitedMs: number; dueAt: number | null; updatedAt: number; used: number; tokens: number; hasOpenItem: boolean }

/** 条目的简短事项（接在「在等：你」后面）：按事项键 job:<id>:<类别>: 的类别写。 */
const ITEM_SHORT: Record<string, string> = {
  accept: '验收', cap: '决定预计消耗怎样处理', escalate: '选一个办法', stall: '决定怎样继续',
};
/** 没有开着的条目、却在等你时的简短事项兜底。 */
const FALLBACK_ITEM = '决定怎样继续';

/** 「在等：{谁}　{补充}　交付：{交付时间}」；补充为空时不留空段。没有交付时间写「待定」。 */
function waitLine(who: string, extra: string | null, dueAt: number | null, timezone: string): string {
  const due = dueAt === null ? '待定' : dueTextOf(dueAt, timezone);
  return `在等：${who}${extra === null ? '' : `　${extra}`}　交付：${due}`;
}

/** 补充语的各段用全角空格连接，空段丢掉。 */
function joinExtra(parts: Array<string | null>): string | null {
  const kept = parts.filter((part): part is string => part !== null && part !== '');
  return kept.length === 0 ? null : kept.join('　');
}

/**
 * 消耗一行的文字与比例：有预计「{used} / {total} 回合　{x} token」，没有「已用 {used} 回合　{x} token」。
 * hasToken 为假（没有用量记录的旧事）：只写回合数，不写「0 token」。
 */
function costOf(used: number, tokens: number, total: number | null, hasToken = true, ownerPhrase: string | null = null): { costText: string; costRatio: number | null } {
  // P87：这件事上有「你发起的总管回合」时，一行末尾加「，另有你发起的 {n} 回合 {y} token」（与进度行同一口径）；比例与头部合计不含它。
  const token = `${hasToken ? `　${formatTokenCount(tokens)} token` : ''}${ownerPhrase === null ? '' : `，${ownerPhrase}`}`;
  if (total === null) return { costText: `已用 ${used} 回合${token}`, costRatio: null };
  return { costText: `${used} / ${total} 回合${token}`, costRatio: total > 0 ? used / total : null };
}

/**
 * 预期的人被额度挡住时的那一句（「额度恢复，约 HH:mm 继续」）；没有被挡住返回 null。
 * 判断与进度行的延迟说明（job/delay.ts）同一套：只看进行中的事；这件事此刻没有回合在跑；
 * 排在队列里的、预期那个人的第一条候选，重放闸门，拦截原因是额度。额度视图没有恢复时间（waitText 为空）时不改写。
 */
function quotaWaitOf(ctx: HubContext, job: Job, now: number): string | null {
  if (!['ready', 'doing', 'checking', 'rework'].includes(job.state)) return null;
  if (confirmWaitNo(job) !== null) return null;
  if (ctx.store.table('wakes').count(wake => wake.jobId === job.id && isOpenWake(wake)) > 0) return null;
  const actor = expectedActorOf(job);
  const entry = listQueue(ctx).find(row => row.jobId === job.id && (actor === null || row.botId === actor));
  if (entry === undefined) return null;
  const snapshot = buildSnapshot(ctx, entry.botId, now, job.id);
  const verdict = evaluateGates(entry, snapshot, now, ctx.settings);
  if (verdict.pass || verdict.by !== 'quota' || snapshot.authBlocked) return null;
  return quotaWindowView(ctx, now).waitText;
}

/** 这件事开着的、要主人处理的条目（事项键 job:<id>: 开头，状态开着）；有多条时取最早建的。预计消耗条目也算（不论是否已到预算线）。 */
function openItemOf(ctx: HubContext, job: Job): InboxItem | null {
  const prefix = `job:${job.id}:`;
  return ctx.store.table('inbox').list(row => row.status === 'open' && row.subjectKey.startsWith(prefix))
    .sort((a, b) => a.createdAt - b.createdAt)[0] ?? null;
}

/** 在等你时，没有开着的条目也要说清「已等多久」「等什么」：按这件事自己的时间点和状态兜底。 */
function ownerWaitFallback(job: Job): { since: number; item: string } {
  if (job.state === 'awaiting_owner') return { since: job.deliveredAt ?? job.updatedAt, item: '验收' };
  if (job.state === 'blocked') return { since: job.blocked?.since ?? job.updatedAt, item: FALLBACK_ITEM };
  if (inLaunchPhase(job) && job.launch.state === 'approval') return { since: job.updatedAt, item: '批准发布' };
  return { since: job.updatedAt, item: FALLBACK_ITEM };
}

/** 一件事此刻「在等谁」的事实（进度行的输出加条目）：「在办的事」和离开期间摘要共用，口径只有一份。 */
export interface JobWaitState {
  stateLabel: string; stateTone: 'run' | 'you' | 'ok'; roundText: string | null;
  /** 进度行写的在等谁（名字、「你」「总管」等）；没有人在等为 null。 */
  waitingOn: string | null;
  /**
   * 这件事真的停下在等你（P76r3 的「甲」，口径与闸门相同）。只有它为真时才写「在等：你」。
   * 只是有一条通知类条目开着（「乙」）时它为假：这件事还在做，「在等」仍写正在等的员工。
   */
  waitingOwner: boolean;
  /** 这件事有没有任何一条开着的 job: 条目（P76r3 的「乙」，含「将超出预计」条目）；排序与「另有一条在等你」用它。 */
  hasOpenItem: boolean;
  /** 在等你时的简短事项（验收、选一个办法……）；不在等你为 null。 */
  itemText: string | null;
  /** 乙成立而甲不成立时，那一条开着的事项（决定预计消耗怎样处理、决定怎样继续……）；其余为 null。 */
  noticeText: string | null;
  /** 在等你已经等了多久（毫秒）；不在等你的排序用开着的条目已开的时长；都没有时为 0。 */
  waitedMs: number;
}

/** 读一件事此刻在等谁。约定已撤下而这件事还在（异常数据）时按「没有约定记录」取进度行，保证状态词和在等谁仍能算出来。 */
export function jobWaitState(ctx: HubContext, job: Job, now: number): JobWaitState {
  const agreement = ctx.store.table('agreements').get(job.agreementId);
  const progress = progressBaseOf(ctx, agreement?.state === 'withdrawn' ? null : agreement, job, null)!;
  const item = openItemOf(ctx, job);
  // P76r3（R1、R6）：甲 = 闸门口径的条目 + 约定新版本在等确认 + 已暂停 + 待你验收；乙 = 任意开着的 job: 条目。
  const ownerAsk = ownerAskOpenOf(ctx, job) || progress.waitingOn === '你' || confirmWaitNo(job) !== null || job.pause !== null;
  const hasOpenItem = hasAnyOpenJobItem(ctx, job.id);
  const fallback = ownerWaitFallback(job);
  const itemMatter = item === null ? null : ITEM_SHORT[item.subjectKey.split(':')[2] ?? ''] ?? FALLBACK_ITEM;
  return {
    stateLabel: progress.stateLabel, stateTone: progress.stateTone, roundText: progress.roundText, waitingOn: progress.waitingOn,
    waitingOwner: ownerAsk,
    hasOpenItem,
    itemText: !ownerAsk ? null : item === null ? fallback.item : itemMatter,
    noticeText: ownerAsk || item === null ? null : itemMatter ?? FALLBACK_ITEM,
    waitedMs: ownerAsk ? Math.max(0, now - (item?.createdAt ?? fallback.since)) : item === null ? 0 : Math.max(0, now - item.createdAt),
  };
}

/** 一件事的一行。textual 为假时不做额度闸门重放（只给数件数的调用方用，字段 waitingOwner 不受影响）。 */
function jobDraft(ctx: HubContext, job: Job, now: number, textual: boolean): Draft {
  const timezone = ctx.settings.timezone;
  const agreement = ctx.store.table('agreements').get(job.agreementId);
  const progress = jobWaitState(ctx, job, now);
  const title = agreement?.title ?? '未命名';
  const waitingOn = progress.waitingOn;
  const { waitingOwner, waitedMs } = progress;

  const confirmNo = confirmWaitNo(job);
  const quota = textual ? quotaWaitOf(ctx, job, now) : null;
  const notice = ctx.store.table('jobNotices').get(job.id);
  // 通知过停滞、之后没有新的记录：从最近一次有进展的时间算起。
  // P76r3（R14 前半）：停摆已经重新唤醒、还没到通知的那一小时（rewakeAt 不为空）也显示「{时长}没有进展」。
  const notifiedStall = notice !== null && notice.stallNotifiedAt !== null && notice.lastProgressAt <= notice.stallNotifiedAt;
  const rewaking = notice !== null && notice.rewakeAt !== null && notice.lastProgressAt <= notice.rewakeAt;
  const stalledSince = notice !== null && (notifiedStall || rewaking) ? notice.lastProgressAt : null;
  // P76r3（R6 第 4 点）：乙成立而甲不成立时，「在等」仍写正在等的员工，后面补一句「另有一条在等你{事项}」。
  const noticeExtra = progress.noticeText === null ? null : `另有一条在等你${progress.noticeText}`;
  let waitText: string;
  if (quota !== null) waitText = waitLine(quota, null, job.dueAt, timezone);
  else if (confirmNo !== null) waitText = waitLine('你', `确认约定第 ${confirmNo} 版`, job.dueAt, timezone);
  else if (waitingOwner) waitText = waitLine('你', `${progress.itemText}　已等 ${waitedText(waitedMs)}`, job.dueAt, timezone);
  else if (job.state === 'checking' && progress.roundText !== null) {
    waitText = waitLine(waitingOn ?? '总管', joinExtra([progress.roundText, noticeExtra]), job.dueAt, timezone);
  } else if (stalledSince !== null) {
    waitText = waitLine(waitingOn ?? '总管', joinExtra([`${waitedText(now - stalledSince)}没有进展`, noticeExtra]), job.dueAt, timezone);
  } else waitText = waitLine(waitingOn ?? '总管', noticeExtra, job.dueAt, timezone);

  // 消耗：与进度行第三行同一个来源（用量行合计；预计取当前生效的那一项）。
  // P76r3（R6）：预计一律取 latestEstimate（与条目、私聊、用量表、总管唤醒包一致）；已用与消耗条不含发布这一步的回合
  // （预计本来就不含发布），回合明细与回执仍是全部回合。没有用量行（旧数据）只写「已用 n 回合」，不写「0 token」。
  const usage = ctx.store.table('jobUsage').get(job.id);
  const totals = usage === null ? { turns: job.turnsUsed, tokens: 0 } : usageTotals(usage);
  const usedForCost = usage === null ? totals.turns : totals.turns - usage.steps.launch.turns;
  const estimate = agreement === null ? null : latestEstimate(ctx, agreement.id);
  const cost = costOf(usedForCost, totals.tokens, estimate === null ? null : estimate.total, usage !== null, usage === null ? null : ownerCostPhrase(ctx.store.table('jobOwnerTurns').get(job.id)));
  return {
    row: { key: job.id, topicId: job.topicId, title, stateLabel: progress.stateLabel, stateTone: progress.stateTone,
      waitText, ...cost, waitingOwner },
    waitedMs, dueAt: job.dueAt, updatedAt: job.updatedAt, used: usedForCost, tokens: totals.tokens, hasOpenItem: progress.hasOpenItem,
  };
}

/** 一份待确认、还没有进行中的事的约定的一行（状态词「对齐中」，在等你确认这一版）。 */
function aligningDraft(ctx: HubContext, agreement: Agreement, now: number): Draft {
  const versionNo = agreement.versions[agreement.versions.length - 1]!.no;
  const item = ctx.store.table('inbox').list(row => row.status === 'open' && row.subjectKey.startsWith(`agreement:${agreement.id}:`))
    .sort((a, b) => a.createdAt - b.createdAt)[0];
  const align = alignmentOf(ctx, agreement);
  const version = agreement.versions.find(row => row.no === currentVersionNo(agreement));
  const estimate = version === undefined ? null : displayEstimate(ctx, agreement, version);
  return {
    row: { key: agreement.id, topicId: agreement.topicId, title: agreement.title, stateLabel: ALIGNING_LABEL, stateTone: 'you',
      waitText: waitLine('你', `确认约定第 ${versionNo} 版`, null, ctx.settings.timezone),
      ...costOf(align.turns, align.tokens, estimate === null ? null : estimate.total), waitingOwner: true },
    waitedMs: Math.max(0, now - (item?.createdAt ?? agreement.updatedAt)), dueAt: null, updatedAt: agreement.updatedAt,
    used: align.turns, tokens: align.tokens, hasOpenItem: true,
  };
}

/** 排序：有任何开着的条目的事在前（其间按已等从长到短）；其余按交付时间升序（没有交付时间的最后）；同序按更新时间新到旧。 */
function compareDrafts(a: Draft, b: Draft): number {
  // P76r3（R6 第 4 点）：排序不变——有任何开着的条目的事仍排在前面，即使它不是「真的停下在等你」（甲不成立）。
  if (a.hasOpenItem !== b.hasOpenItem) return a.hasOpenItem ? -1 : 1;
  if (a.hasOpenItem) return b.waitedMs - a.waitedMs || b.updatedAt - a.updatedAt;
  const due = (a.dueAt ?? Number.POSITIVE_INFINITY) === (b.dueAt ?? Number.POSITIVE_INFINITY) ? 0
    : (a.dueAt ?? Number.POSITIVE_INFINITY) < (b.dueAt ?? Number.POSITIVE_INFINITY) ? -1 : 1;
  return due || b.updatedAt - a.updatedAt;
}

/**
 * 某位员工的「在办的事」。textual 为假时只保证行数、waitingOwner 与排序正确，不做额度闸门重放（总览左栏一句用）。
 * 员工不存在时按「其他员工」处理（没有事）。
 */
export function activeJobsView(ctx: HubContext, botId: string, options: { textual?: boolean } = {}): ActiveJobsView {
  const textual = options.textual !== false;
  const now = ctx.clock.now();
  const isChief = ctx.store.table('bots').get(botId)?.role === 'chief';
  // 没收尾：已完成、已停止的不算；已完成但还在发布环节的算。
  const open = (job: Job): boolean => !isJobClosed(job) || inLaunchPhase(job);
  const jobs = ctx.store.table('jobs').list(row => open(row)
    && (isChief ? row.chiefId === botId : row.executorId === botId || row.reviewerId === botId));
  const drafts = jobs.map(job => jobDraft(ctx, job, now, textual));
  if (isChief) {
    // 待确认、还没有进行中的事的约定；已经有对应行（发布环节的事）的不重复。
    const shown = new Set(jobs.map(job => job.agreementId));
    for (const agreement of pendingAgreementsOf(ctx, botId)) {
      if (!shown.has(agreement.id) && activeJobOfAgreement(ctx, agreement.id) === null) drafts.push(aligningDraft(ctx, agreement, now));
    }
  }
  drafts.sort(compareDrafts);
  if (drafts.length === 0) return { headText: '现在没有在办的事', rows: [], footerText: '查看全部记录' };
  const used = drafts.reduce((sum, draft) => sum + draft.used, 0);
  const tokens = drafts.reduce((sum, draft) => sum + draft.tokens, 0);
  return { headText: `在办的事　${drafts.length} 件　共用 ${used} 回合，${formatTokenCount(tokens)} token`,
    rows: drafts.map(draft => draft.row), footerText: '查看全部记录' };
}

/**
 * 一件事的存储查询帮手（P74a）。
 *
 * 为什么单独放一个文件：几块代码（派活、交回、核对、视图、唤醒包）都要「按约定找这件事」「找某位员工手上的事」
 * 「某件事的最新一次交回」，集中写一份，口径才不会走偏。
 * 本文件只读或只追加，不做任何业务判断，不改表里已有的记录。
 */
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import type { HubContext } from '../engine/context.js';
import { parseWithPaths } from '../model/agreement.js';
import { JobEventSchema, type Job, type JobEvent, type JobReview, type JobSubmission } from '../model/job.js';
import { newId } from '../util/ids.js';
import { voidJobApprovals } from './void-job-approvals.js';

/**
 * P74r16b：通知界面「这件事所在的主题」要重新读取。
 * 为什么：进度行随主题线程一起返回，界面只在收到这个主题编号的 thread 范围事件时才重新读取已经打开的主题；
 * 只发项目范围的事件时，打开着的主题上的进度行会停在旧状态（员工被停用后仍写「待开工、排队中」）。
 */
export function emitJobTopic(ctx: HubContext, job: Pick<Job, 'topicId'>): void {
  ctx.emit(HUB_EVENT_SCOPES.thread, job.topicId);
}

/**
 * 进度行上会显示的内容：状态、受阻的种类、有没有未回答的提问、发布这一步的状态、第几轮、执行者与核对人、暂停的约定版本、
 * 等主人确认的标记、交付时间（P74r17 起，进度行上显示它，约定新版本只改交付时间时也要刷新）。
 * 任何一项变化，主题上的进度行（状态、在等谁、环节）就要重新读取。
 *
 * 仍直接写这件事记录、不经 putJob 的地方（P74r17 核对，共 10 处）：
 * - job/deliver.ts（写交付卡的 inboxId）、job/stall.ts（写「停住了」条目的 inboxId、stallNo）、
 *   job/agreement-hooks.ts 两处（清 inboxId、记 handledVersionNo）、job/disturb.ts（disturbCount 加一）、
 *   job/block-items.ts 两处（清 inboxId）、job/escalation-expiry.ts（escalation.invalid，必要时清 inboxId）、
 *   job/trial.ts（trialReported）；
 * - job/assign.ts 的撤销（派活失败时整件移除这件事的记录，记录本来就不再存在）。
 * 它们改的都是 inboxId、disturbCount、stallNo、handledVersionNo、escalation.invalid、trialReported 这类不进进度行的字段，
 * 所以不走统一出口，也不会漏掉刷新。以后新增的写入一律走 putJob。
 */
function progressKeyOf(job: Job): string {
  return JSON.stringify([job.state, job.blocked?.kind ?? null, job.blocked?.text ?? null, job.openAsk?.agreementNo ?? (job.openAsk === null ? null : 0),
    job.launch.state, job.round, job.executorId, job.reviewerId, job.pause?.versionNo ?? null, job.pause?.executorWaiting ?? null, job.startedAt,
    job.dueAt ?? null]);
}

/**
 * 写这件事的记录，并在进度行相关的内容变化时通知界面刷新这件事所在的主题（P74r16b 第 2.1 节的统一出口）。
 * 只改计数、条目编号等不影响进度行的字段时不发事件；恢复备份（撤销）同样走这里，状态变回去也要刷新。
 */
export function putJob(ctx: HubContext, job: Job): void {
  const before = ctx.store.table('jobs').get(job.id);
  ctx.store.table('jobs').put(job);
  if (before === null || progressKeyOf(before) !== progressKeyOf(job)) emitJobTopic(ctx, job);
  // P74r19 第 2 节：发布这一步结束（变成暂不发布、已发布）的那一刻，这件事执行者提交的其余还在等批准的审批一并作废，
  // 不留下没人处理的审批。放在统一出口里，各种结束方式（主人拒绝、中心结束、审批过期、命令成功后记为已发布）都不会漏。
  // 发布没有成功（failed）不算结束：执行者还可以改正重提。出错只记日志，不影响这件事的记录。
  if (before !== null && before.launch.state !== job.launch.state && job.state === 'done'
    && (job.launch.state === 'declined' || job.launch.state === 'done')) {
    try { voidJobApprovals(ctx, job, 'launch_ended', ctx.clock.now(), job.executorId); }
    catch (error) { ctx.logger.warn('发布结束后没有作废这件事其余的审批', { jobId: job.id, error: String(error) }); }
  }
}

/** 一件事是否已经收尾（完成或停止）。 */
export function isJobClosed(job: Pick<Job, 'state'>): boolean {
  return job.state === 'done' || job.state === 'stopped';
}

/**
 * 按约定找这件事：同一时刻至多一件没停止的事，没有时为 null。
 * P74b：已停止的事允许对同一份约定重新派活，所以有多条时优先取没停止的，都已停止则取最新的。
 */
export function jobOfAgreement(ctx: HubContext, agreementId: string): Job | null {
  const rows = ctx.store.table('jobs').list(row => row.agreementId === agreementId);
  return rows.find(row => row.state !== 'stopped') ?? rows.sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
}

/**
 * 某位员工手上还没收尾的事：他是执行者，或者是核对人（reviewerId 为空表示总管自己核对，所以总管也算核对人）。
 * 状态是已完成、已停止的不算。
 */
export function activeJobsOf(ctx: HubContext, botId: string): Job[] {
  return ctx.store.table('jobs').list(row => !isJobClosed(row)
    && (row.executorId === botId || row.reviewerId === botId || (row.reviewerId === null && row.chiefId === botId)));
}

/** 这位总管名下的全部事（含已收尾的），按创建时间从旧到新。 */
export function jobsOfChief(ctx: HubContext, chiefId: string): Job[] {
  return ctx.store.table('jobs').list(row => row.chiefId === chiefId).sort((a, b) => a.createdAt - b.createdAt);
}

/** 最近一次交回：按创建时间取最新，时间相同时后写入的胜出（list 是写入顺序）。 */
export function latestSubmission(ctx: HubContext, jobId: string): JobSubmission | null {
  let latest: JobSubmission | null = null;
  for (const row of ctx.store.table('jobSubmissions').list(item => item.jobId === jobId)) {
    if (latest === null || row.createdAt >= latest.createdAt) latest = row;
  }
  return latest;
}

/** 这件事的全部核对结论，按创建时间从旧到新（时间相同保持写入顺序）。 */
export function reviewsOf(ctx: HubContext, jobId: string): JobReview[] {
  return ctx.store.table('jobReviews').list(row => row.jobId === jobId).sort((a, b) => a.createdAt - b.createdAt);
}

/** 这件事的全部事件，按时间和追加顺序从旧到新。 */
export function eventsOf(ctx: HubContext, jobId: string): JobEvent[] {
  return ctx.store.log('jobEvents').all().filter(row => row.jobId === jobId);
}

/**
 * 没回答的那一问的原文（P74r2b）：先读这件事记录上存的原文（P74r2a 起），没有（升级前的数据）才回头找 asked 事件；都没有返回 null。
 */
export function openAskText(ctx: HubContext, job: Pick<Job, 'id' | 'openAsk'>): string | null {
  if (job.openAsk === null) return null;
  if (typeof job.openAsk.text === 'string' && job.openAsk.text !== '') return job.openAsk.text;
  const text = eventsOf(ctx, job.id).find(row => row.id === job.openAsk!.eventId)?.data.text;
  return typeof text === 'string' && text !== '' ? text : null;
}

/** 追加一条事件：校验后写入只追加日志；id 与时间默认由这里生成（时间可显式给，便于按发生时刻补记）。 */
export function appendJobEvent(ctx: HubContext, input: Omit<JobEvent, 'id' | 'at'> & { at?: number; id?: string }): JobEvent {
  // P74b：id 可由调用方预先生成（派活要先拿到事件 id 去引用，日志本身排在最后才追加）。
  const row = parseWithPaths(JobEventSchema, { ...input, at: input.at ?? ctx.clock.now(), id: input.id ?? newId('jev', ctx.rng) }, '事件');
  ctx.store.log('jobEvents').append(row);
  return row;
}

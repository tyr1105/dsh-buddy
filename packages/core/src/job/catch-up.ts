/**
 * 约定固定之后的收尾，没做完时补做（P74r2b，对应第二次审查的疑点 2）。
 *
 * 为什么需要：约定固定后的收尾（重写主题文件、清掉暂停、主题里落一句话、叫醒执行者）是异步的，只登记在内存里。
 * 约定已经写成固定、收尾还没跑完时进程退出（例如重启 DSH），重启之后暂停永远不清、主题文件还是旧版本、执行者不被叫醒。
 *
 * 做法：每件事记下「已处理到约定第几版」（Job.handledVersionNo，收尾的状态步骤做完才更新）。
 * 启动整理和每次巡检（job/sweep.ts）发现约定最新的固定版本号大于它，就补做，走和正常收尾同一个函数（onAgreementLocked），
 * 所以话、往来、事件、对执行者的叫醒都只出现一次：补做之后「已处理到」更新，再也不会命中；
 * 正常收尾还在跑时由 onAgreementLocked 里的「同一件事同一版只跑一份」挡住，不会重复开一份。
 * 不用事件日志判断（日志在内存里只保留 14 天）。
 *
 * 另一种遗漏：暂停指向的版本已经被撤下（或已不存在）而暂停还在（撤销时进程退出）：按撤销处理，
 * 清掉暂停、叫醒执行者、工作往来一句（onReopenWithdrawn）。
 *
 * 没有「已处理到」记录的旧数据（升级前建的事）不补做：不知道当时处理到哪一版，补做会重复说话；
 * 只有暂停指向一个已经固定的版本（正是重启留下的那种状态）时才补做。
 */
import type { HubContext } from '../engine/context.js';
import type { Agreement } from '../model/agreement.js';
import type { Job } from '../model/job.js';
import { activeJobOfAgreement, onAgreementLocked, onReopenWithdrawn } from './agreement-hooks.js';

/** 约定最新的固定版本（曾经固定过的最大版本号）；从没固定过返回 null。 */
function latestLockedVersion(agreement: Agreement) {
  return agreement.versions.filter(row => row.lockedAt !== null).sort((a, b) => b.no - a.no)[0] ?? null;
}

/** 检查一件事，需要补做就补做。 */
function catchUpOne(ctx: HubContext, jobId: string): void {
  const job = ctx.store.table('jobs').get(jobId);
  if (!job || job.state === 'stopped') return;
  const agreement = ctx.store.table('agreements').get(job.agreementId);
  if (!agreement) return;
  // 一、暂停指向的版本已经被撤下（或已不存在）：按撤销处理。已完成的事没有暂停。
  if (job.pause !== null && job.state !== 'done') {
    const target = agreement.versions.find(row => row.no === job.pause!.versionNo);
    const waiting = target !== undefined && target.state === 'pending' && agreement.state === 'pending';
    const fixed = target !== undefined && (target.state === 'locked' || target.state === 'replaced');
    if (!waiting && !fixed && activeJobOfAgreement(ctx, agreement.id) !== null) onReopenWithdrawn(ctx, agreement.id);
  }
  // 二、约定最新的固定版本比已处理到的更大：补做固定后的收尾。
  const fresh: Job | null = ctx.store.table('jobs').get(jobId);
  const latest = latestLockedVersion(agreement);
  if (!fresh || latest === null) return;
  const handled = fresh.handledVersionNo ?? null;
  const pauseOnFixed = fresh.pause !== null && fresh.pause.versionNo <= latest.no
    && agreement.versions.some(row => row.no === fresh.pause!.versionNo && row.lockedAt !== null);
  if ((handled !== null && latest.no > handled) || (handled === null && pauseOnFixed)) {
    onAgreementLocked(ctx, agreement.id, latest.no, latest.lockedVia === 'amend' ? 'amend' : 'confirm');
  }
}

/**
 * 巡检所有没停止的事（含已完成的：约定文件里的版本号要对得上）。每件事各自兜底：一件事出错只记日志，不影响别的事。
 * 同步函数：补做的异步部分登记在 scheduleHook 里，启动时用 flushJobHooks 等它做完。
 */
export function catchUpJobFollowUps(ctx: HubContext): void {
  for (const job of ctx.store.table('jobs').list(row => row.state !== 'stopped')) {
    try { catchUpOne(ctx, job.id); }
    catch (error) {
      try { ctx.logger.warn('约定固定后的收尾补做失败', { jobId: job.id, error: String(error) }); } catch { /* 日志出错也不能挡住别的事。 */ }
    }
  }
}

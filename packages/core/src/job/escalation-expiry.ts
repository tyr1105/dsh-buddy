/**
 * 一次说明随约定版本、随受阻失效（P74r4a 第 2 条，对应第三次审查 K2、K5；P74r4a-m1 把状态按事实写）。
 *
 * 总则：一次说明（总管向主人写的「卡在哪、有哪几个办法」）只对「它写的时候的那个约定版本、那一次受阻」有效。
 * 这两者之一变了，这次说明就失效：「待你处理」里的条目撤回、卡片显示失效、不能再选。
 *
 * 失效原因在事情发生时记在这次说明上（JobEscalation.invalid），视图和拒绝文字按记下的原因说话，不去猜：
 * - reconfirming：约定出了新版本，在等主人确认；
 * - updated：约定固定了新版本（含主人亲口的小改动直接生效）；
 * - withdrawn：待确认的版本被撤销（约定没有变）；
 * - released：这件事离开了这次说明所针对的那一次受阻，主人没有选办法（回答、转交、恢复在岗等）；
 * - held（P74r6）：主人暂停了这件事；reassigned（P74r6）：总管改派了（不论改派之后是否仍有人停用）。
 * 另有一个不记下的状态 stopped：这件事已停止，视图按这件事的状态判断。
 * 新版本固定、或待确认版本被撤销之后，这件事如果仍受阻、在等总管，立即给总管排一次唤醒。
 */
import type { HubContext } from '../engine/context.js';
import type { Agreement } from '../model/agreement.js';
import type { Job, JobEscalation } from '../model/job.js';
import { newId } from '../util/ids.js';
import { openBlockItems, withdrawBlockItems } from './block-items.js';
import { enqueueJobWake, expectedActorOf } from './chain.js';
import { lockedVersionOf } from './files.js';
import { clearChiefBlockedAfterEscalation } from './chief-blocked.js';

/** 记在说明上的四种失效原因。 */
export type EscalationMark = NonNullable<JobEscalation['invalid']>;
/** 视图和拒绝文字用的状态：四种原因加「这件事已停止」。 */
export type EscalationExpiry = EscalationMark | 'stopped';

/** 约定已更新时选办法的拒绝文字（原文）。 */
export const ESCALATION_EXPIRED_TEXT = '约定已经更新，这张卡上的办法是按旧版本写的，已失效。总管会按新版本重新处理。';

/** 选办法被拒的文字：按失效原因区分，每一句说的都是事实。 */
export const EXPIRY_REFUSAL_TEXT: Record<EscalationExpiry, string> = {
  reconfirming: '这张卡上的办法在约定重新确认期间已失效。总管会重新处理。',
  updated: ESCALATION_EXPIRED_TEXT,
  withdrawn: '这张卡上的办法在约定重新确认期间已失效。总管会重新处理。',
  released: '这件事已经继续进行了，这张卡上的办法不用再选。',
  held: '这件事已暂停，这张卡上的办法不用再选。',
  reassigned: '总管已经改派，这张卡上的办法不用再选。',
  stopped: '这件事已停止，这张卡上的办法不用再选。',
};

/** 总管被叫醒时唤醒包里写明的话：因为约定固定了新版本（原文）。 */
export const ESCALATION_EXPIRED_WAKE_TEXT = '上一次给主人的办法因为约定更新已失效；请按现在的约定重新判断：能解决就解决，仍要主人决定就重新说明。';
/** 因为待确认的版本被撤销（原文）。 */
export const ESCALATION_WITHDRAWN_WAKE_TEXT = '上一次给主人的办法已失效：期间约定出过新版本、后来撤销了，现在仍是原来的版本。请按现在的约定重新判断：能解决就解决，仍要主人决定就重新说明。';

/** 唤醒包里要写的那句话；这种原因不需要叫总管时返回 null。 */
export function expiredWakeText(mark: EscalationMark | undefined): string | null {
  return mark === 'updated' ? ESCALATION_EXPIRED_WAKE_TEXT : mark === 'withdrawn' ? ESCALATION_WITHDRAWN_WAKE_TEXT : null;
}

/** 卡片状态文字（主人没有选的说明）。 */
export const EXPIRY_STATE_TEXT: Record<EscalationExpiry, string> = {
  reconfirming: '已失效：约定在重新确认',
  updated: '已失效：约定已更新',
  withdrawn: '已失效：约定修改已撤销',
  released: '已失效：这件事已继续进行',
  held: '已失效：你已暂停这件事',
  reassigned: '已失效：总管已改派',
  stopped: '已失效：这件事已停止',
};

/** 约定有新版本在等主人确认时返回那一版的版本号；没有返回 null。 */
export function pendingVersionNo(agreement: Agreement | null): number | null {
  return agreement !== null && agreement.state === 'pending' ? agreement.versions[agreement.versions.length - 1]!.no : null;
}

/** 这次说明是不是这件事现在这一次受阻的说明（不是的话，它针对的那一次受阻已经过去）。 */
function isCurrentBlock(job: Pick<Job, 'state' | 'blocked'>, escalation: JobEscalation): boolean {
  if (job.state !== 'blocked' || job.blocked === null) return false;
  // P74r16c：因参与者被停用而受阻时，总管写的说明记成「执行者做不下去」一类（escalate.ts），受阻原因是 participant_off：
  // 这两者对得上（必须有记下的受阻开始时间，旧数据没有时不放宽）。原来对不上，说明一写好就被当成「已继续进行」失效，选不了办法。
  const offParticipant = job.blocked.kind === 'participant_off' && escalation.kind === 'executor' && escalation.blockedSince !== undefined;
  if (job.blocked.kind !== escalation.kind && !offParticipant) return false;
  return escalation.blockedSince === undefined || escalation.blockedSince === job.blocked.since;
}

/**
 * 主人没有选的说明，现在的状态（视图的判断顺序）；仍有效返回 null。主人已选过的说明没有「失效」的说法。
 * 一、这件事已停止；二、记录上有标记；三、没有标记但它不是现在这一次受阻的说明，或是历史里被后一次说明取代的：released；
 * 四、没有标记，约定在等确认或版本与说明时不同（兜底，正常不会出现）。
 */
export function jobEscalationExpiry(ctx: HubContext, job: Job, escalation: JobEscalation, isLatest = true): EscalationExpiry | null {
  if (escalation.chosen !== null) return null;
  if (job.state === 'stopped') return 'stopped';
  if (escalation.invalid !== undefined) return escalation.invalid;
  if (!isLatest || !isCurrentBlock(job, escalation)) return 'released';
  const agreement = ctx.store.table('agreements').get(job.agreementId);
  if (pendingVersionNo(agreement) !== null) return 'reconfirming';
  if (agreement !== null && agreement.versions.some(row => row.lockedAt !== null) && lockedVersionOf(agreement).no !== escalation.versionNo) return 'updated';
  return null;
}

/**
 * 纯函数：这件事离开了这次说明针对的那一次受阻，而主人没有选：给没有标记的说明标上这件事离开的原因（已有标记保持）。
 * 离开的原因有三种（P74r6）：released 接着做了；held 主人暂停了；reassigned 总管改派了。
 * 例外：已标 reconfirming（约定在等确认）的，这件事在等确认期间离开了那一次受阻，改标为离开的原因，不再显示「约定在重新确认」。
 * 所有让这件事离开受阻的路径在写状态时调用它（releaseBlockItems、改派、答复回合上限、先停下）。
 */
export function markReleased(job: Job, reason: 'released' | 'held' | 'reassigned' = 'released'): Job {
  const e = job.escalation;
  if (e == null || e.chosen !== null || (e.invalid !== undefined && e.invalid !== 'reconfirming')) return job;
  return { ...job, escalation: { ...e, invalid: reason } };
}

/**
 * 按事情发生的时机记下失效原因，返回是否改了：
 * - reconfirming：没有标记时标上，并撤回条目、清编号（这次说明作废）；
 * - updated：没有标记的标 updated（同时撤回条目）；已标 reconfirming 的改为 updated；
 * - withdrawn：已标 reconfirming 的改为 withdrawn。
 * 只对这件事仍受阻、主人没选、针对这一次受阻的说明做（幂等）。状态先写，条目撤回在后（出错只记日志）。
 */
export function invalidateOpenEscalation(ctx: HubContext, jobId: string, reason: 'reconfirming' | 'updated' | 'withdrawn'): boolean {
  const job = ctx.store.table('jobs').get(jobId);
  const escalation = job?.escalation;
  if (job === null || escalation == null || job.state !== 'blocked' || job.blocked === null) return false;
  if (escalation.chosen !== null || !isCurrentBlock(job, escalation)) return false;
  const current = escalation.invalid;
  const next: EscalationMark | null = reason === 'reconfirming' ? (current === undefined ? 'reconfirming' : null)
    : reason === 'updated' ? (current === undefined || current === 'reconfirming' ? 'updated' : null)
      : (current === 'reconfirming' ? 'withdrawn' : null);
  if (next === null) return false;
  const now = ctx.clock.now();
  // 第一次标记：说明还在「待你处理」里，撤回并清编号；之后的改标不再有条目。
  const items = current === undefined ? openBlockItems(ctx, job.id).filter(row => row.subjectKey.startsWith(`job:${job.id}:escalate:`)) : [];
  const clearInbox = job.inboxId !== null && items.some(row => row.id === job.inboxId);
  ctx.store.table('jobs').put({ ...job, escalation: { ...escalation, invalid: next }, inboxId: clearInbox ? null : job.inboxId, updatedAt: now });
  try {
    withdrawBlockItems(ctx, items, now, next === 'reconfirming' ? '约定在重新确认，这次的办法已失效' : '约定已更新，这次的办法已失效');
  } catch (error) {
    ctx.logger.warn('说明失效后撤回条目失败', { jobId: job.id, error: String(error) });
  }
  // P74r14：这次说明失效：清掉总管因为这次说明写下的受阻状态（总管随后若被重新叫醒，会写新的状态）。
  clearChiefBlockedAfterEscalation(ctx, job.id);
  return true;
}

/**
 * 新版本固定之后、或待确认的版本被撤销之后：说明已标 updated 或 withdrawn、这件事仍受阻且在等总管时，立即给总管排一次唤醒。
 * 约定仍有新版本在等确认时不叫；总管已经排着唤醒的不重复排。没排上（总管不在岗）只记日志，兜底巡检会在他恢复后叫他。
 */
export function wakeChiefAfterExpiry(ctx: HubContext, jobId: string): boolean {
  const job = ctx.store.table('jobs').get(jobId);
  const escalation = job?.escalation;
  if (job === null || escalation == null || escalation.chosen !== null) return false;
  const text = expiredWakeText(escalation.invalid);
  if (text === null || !isCurrentBlock(job, escalation)) return false;
  if (pendingVersionNo(ctx.store.table('agreements').get(job.agreementId)) !== null) return false;
  if (expectedActorOf(job) !== job.chiefId) return false;
  if (ctx.store.table('queue').count(row => row.botId === job.chiefId && row.jobId === job.id) > 0) return false;
  const entry = enqueueJobWake(ctx, { job, botId: job.chiefId, why: 'escalate', eventId: newId('jev', ctx.rng), summary: text });
  if (entry === null) ctx.logger.warn('约定更新后没有排上总管的唤醒（总管此刻可能不在岗）', { jobId: job.id });
  return entry !== null;
}

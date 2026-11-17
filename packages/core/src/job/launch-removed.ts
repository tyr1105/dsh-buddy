/**
 * 已经验收的事，约定新版本改了「对外发布」一项之后的收尾（P74r13 第 2 节）。
 *
 * 为什么需要：对外发布写在约定里，要不要发布由主人确认的约定决定。这件事已经验收、发布这一步正在进行
 * （执行者在准备、发布审批在等主人、已批准还没有执行）时，主人确认了一版去掉对外发布的约定，
 * 如果中心什么都不做，发布照常进行，主人确认了不发布、发布却还在走。
 *
 * 三种情形：
 * 1. 发布这一步还没有做完：中心结束它，做法与主人点「暂不发布」之后的收尾相同
 *    （还开着的发布审批作废、执行者不再被叫醒准备发布、这件事回到已完成），结束的原因记为主人，主题里落一句固定句；
 * 2. 发布已经做完：不动；总管得到的返回文字里写明事实，让总管对主人如实说明；
 * 3. 反方向（这件事原来没有发布这一步，新版本加上了对外发布）：不追加发布这一步，返回文字里写明事实。
 *
 * 本文件只放判断和固定句；情形 1 的收尾由 job/agreement-hooks.ts 在新版本固定时调用，
 * 情形 2、3 的返回文字由 tools/hub-agreement-submit.ts 在总管提交修订时拼进回话。
 */
import type { HubContext } from '../engine/context.js';
import { VOID_REASON_NO_LAUNCH, voidApproval } from '../gate/void-approval.js';
import type { AgreementVersion } from '../model/agreement.js';
import type { Job } from '../model/job.js';
import { postThread } from '../outreach/thread.js';
import { markDeclined } from './launch-approval.js';
import { cancelLaunchTurn } from './launch-cancel.js';
import { dropJobEntries } from './start-wake.js';
import { jobOfAgreement } from './store.js';

/** 主题里落的那一句（固定句，逐字）。 */
export function launchRemovedTopicText(versionNo: number): string {
  return `约定第 ${versionNo} 版去掉了对外发布，这次不发布。`;
}

/** 情形 2：发布已经完成时，返回给总管的那一句（逐字）。 */
export const LAUNCH_REMOVED_AFTER_DONE_TEXT = '对外发布已经完成，去掉这一项不影响已经发布的结果；对主人如实说明。';

/** 情形 3：这件事已经验收、新版本加上了对外发布时，返回给总管的那一句（逐字）。 */
export const LAUNCH_ADDED_AFTER_ACCEPT_TEXT = '这件事已经验收，这一版加上的对外发布不会自动进行；要发布请另起一件事，对主人如实说明。';

/**
 * 发布这一步是不是还没有做完、可以由中心结束：已验收，并且发布状态是「准备中」，
 * 或是「等批准」而且那张审批还在等主人（待审批）、或主人已批准还没有执行（已批准）。
 * 审批已经被使用（命令已经开始运行）算「已经发布」，不在此列。
 */
function launchCanBeEnded(ctx: HubContext, job: Job): boolean {
  if (job.state !== 'done' || job.acceptedAt === null || !job.launchStep) return false;
  // P74r18b：发布没有成功（failed）、执行者还没改正重提时，这一步也还没有做完，可以由中心结束。
  if (job.launch.state === 'preparing' || job.launch.state === 'failed') return true;
  if (job.launch.state !== 'approval') return false;
  const approval = job.launch.approvalId === null ? null : ctx.store.table('approvals').get(job.launch.approvalId);
  return approval === null || approval.status === 'pending' || approval.status === 'approved';
}

/** 发布这一步是不是已经做完（已发布，或发布命令已经开始运行）。 */
function launchIsDone(ctx: HubContext, job: Job): boolean {
  if (job.launch.state === 'done') return true;
  if (job.launch.state !== 'approval' || job.launch.approvalId === null) return false;
  return ctx.store.table('approvals').get(job.launch.approvalId)?.status === 'used';
}

/**
 * 新版本（没有对外发布）固定时，结束这件事还没做完的发布这一步。结束了返回 true；不满足条件什么都不改、返回 false。
 * 顺序：先改发布状态（写失败会抛出，什么都没作废、什么都没说），再作废审批、丢弃执行者排着的叫醒，最后才在主题里说话。
 */
export function endLaunchForRemovedClause(ctx: HubContext, job: Job, versionNo: number): boolean {
  if (!launchCanBeEnded(ctx, job)) return false;
  const now = ctx.clock.now();
  const approvalId = job.launch.approvalId;
  // 结束的原因记为主人：这是主人确认的决定（进度行写「你暂不发布」）。
  markDeclined(ctx, job, now, { reason: 'agreement_no_launch', versionNo }, 'owner');
  // 还开着的发布审批作废（等主人的、已批准还没执行的都一样）：作废之后主人批准不了，命令也不会运行。
  if (approvalId !== null) {
    const approval = ctx.store.table('approvals').get(approvalId);
    if (approval !== null && (approval.status === 'pending' || approval.status === 'approved')) voidApproval(ctx, approvalId, VOID_REASON_NO_LAUNCH, now);
  }
  // 执行者排着的「准备发布」叫醒不再需要。
  dropJobEntries(ctx, job.executorId, job.id);
  // P74r15：执行者此刻正在跑的发布准备回合也要停下（原因：中心结束），否则它仍能提交发布命令。
  cancelLaunchTurn(ctx, job);
  postThread(ctx, { thread: job.topicId, from: 'hub', kind: 'work', refId: job.id, text: launchRemovedTopicText(versionNo) });
  return true;
}

/** P74r15：发布已经开始执行（审批已批准、命令已开始运行）时主人确认去掉对外发布，主题里落的那一句（逐字固定）。 */
export function launchRunningTopicText(versionNo: number): string {
  return `约定第 ${versionNo} 版去掉了对外发布，但这次发布已经在执行，没有中止。`;
}

/** P74r15：发布已经完成时主人确认去掉对外发布，主题里落的那一句（逐字固定）。 */
export function launchDoneTopicText(versionNo: number): string {
  return `约定第 ${versionNo} 版去掉了对外发布；这次发布在此之前已经完成。`;
}

/**
 * P74r15：新版本（没有对外发布）固定时，发布这一步结束不了（已经开始执行，或已经完成）：在主题里说明事实，
 * 免得主人以为发布已经被去掉。发布还在准备或等批准的由 endLaunchForRemovedClause 处理；其余（没有发布、已暂不发布）不说。
 * 返回有没有落话；出错只记日志。
 */
export function noteLaunchNotStopped(ctx: HubContext, job: Job, versionNo: number): boolean {
  try {
    if (!job.launchStep || job.acceptedAt === null) return false;
    const done = job.launch.state === 'done';
    const running = !done && launchIsDone(ctx, job);
    if (!done && !running) return false;
    postThread(ctx, { thread: job.topicId, from: 'hub', kind: 'work', refId: job.id, text: done ? launchDoneTopicText(versionNo) : launchRunningTopicText(versionNo) });
    return true;
  } catch (error) {
    ctx.logger.warn('去掉对外发布时发布已在执行或已完成，主题里的说明没有落下', { jobId: job.id, error: String(error) });
    return false;
  }
}

/**
 * 总管提交修订成功时，要不要在返回文字后面加一句事实（情形 2、3）；不加返回空字符串。
 * 只看这一版自己改了对外发布（改动标记里有 launch）：这一版没动对外发布时不加，免得每次修订都重复说。
 */
export function launchChangeNoteFor(ctx: HubContext, agreementId: string, version: AgreementVersion | null | undefined): string {
  if (version === undefined || version === null) return '';
  const job = jobOfAgreement(ctx, agreementId);
  if (job === null || job.state !== 'done' || job.acceptedAt === null) return '';
  const mark = version.changes.find(row => row.section === 'launch');
  if (mark === undefined) return '';
  if (mark.kind === 'removed' && job.launchStep && launchIsDone(ctx, job)) return LAUNCH_REMOVED_AFTER_DONE_TEXT;
  if (mark.kind === 'added' && !job.launchStep) return LAUNCH_ADDED_AFTER_ACCEPT_TEXT;
  return '';
}

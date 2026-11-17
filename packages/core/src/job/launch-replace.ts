/**
 * 发布这一步同一时间只有一条命令在等批准（P74r19 第 1 节）。
 *
 * 为什么需要：第三次真实模型验证里，执行者在同一个回合先提交了只建目录的命令（被记为这件事的发布审批），
 * 又提交了完整的命令（成了一张普通审批）。主人面前出现两张卡，标着「批准发布」的那张只建目录，
 * 批准了它，中心运行完建目录就宣布「已发布」，文件却没有复制过去。
 *
 * 做法：这件事已有一条发布审批在等主人批准时，执行者再提交需要批准的动作：
 * - 没有带 replace: true：直接拒绝（不建审批、不落消息、不计越界），告诉模型同一时间只能有一条；
 * - 带了 replace: true（只对 run_command 有效）：新的一条成为这件事的发布审批，原来那条作废。
 * 原来那条已经被批准（命令在运行或已运行完）时不适用：那时发布状态虽然仍写「等批准」，但主人已经决定过了，
 * 这里只认「审批单还是待批准」的那一条。
 *
 * 本文件只放判断、固定文字和作废；建审批仍由 gate/approvals.ts、job/launch-approval.ts 负责。
 */
import type { HubContext } from '../engine/context.js';
import type { Approval } from '../model/outreach.js';
import type { Job } from '../model/job.js';
import { VOID_LAUNCH_REPLACED_TEXT, voidApprovalAndOutbox } from './void-job-approvals.js';

/** 没有带 replace 就再提交时的拒绝文字（给模型看，逐字）。 */
export const LAUNCH_ONE_AT_A_TIME_REFUSAL = '这件事已有一条发布命令在等主人批准，同一时间只能有一条。要用新的命令取代它，重新提交并把 replace 设为 true；发布之外的动作等发布结束之后再提交。';

/** 取代成功时工具返回给模型的话末尾加的一句（逐字）。 */
export const LAUNCH_REPLACED_TOOL_TEXT = '前一条发布命令已作废，主人只会看到这一条。';

/** replace 参数的说明（给模型看，逐字）。 */
export const REPLACE_PARAM_DESCRIPTION = '只在发布这一步用：这件事已有一条发布命令在等主人批准、你要用这一条取代它时设为 true。';

/**
 * 这件事此刻在等主人批准的那条发布审批：这件事已完成、发布状态是「等批准」、记下的审批单还是待批准（没有过期）。
 * 不是这种情形（准备中、没成功、已结束、已批准）返回 null。
 */
export function pendingLaunchApprovalOf(ctx: HubContext, job: Job): Approval | null {
  if (job.state !== 'done' || job.launch.state !== 'approval' || job.launch.approvalId === null) return null;
  const approval = ctx.store.table('approvals').get(job.launch.approvalId);
  return approval !== null && approval.status === 'pending' && approval.expiresAt > ctx.clock.now() ? approval : null;
}

/**
 * 提交入口的把关（job 是这位员工此刻在做的那件事，没有为 null）：这件事已经有一条发布命令在等批准时，返回要取代的那条审批的编号或拒绝文字。
 * - 不在这种情形：返回 null（照旧）；
 * - 在这种情形、没有 replace：返回拒绝文字；
 * - 在这种情形、有 replace 且是命令：返回 { replacing: 旧审批编号 }。
 */
export function launchSingleGuard(ctx: HubContext, job: Job | null, input: { kind: string; replace?: boolean | undefined }): { refusal: string } | { replacing: string } | null {
  if (job === null) return null;
  const pending = pendingLaunchApprovalOf(ctx, job);
  if (pending === null) return null;
  if (input.replace === true && input.kind === 'run_command') return { replacing: pending.id };
  return { refusal: LAUNCH_ONE_AT_A_TIME_REFUSAL };
}

/**
 * 新的发布命令已经成为这件事的发布审批、新审批的卡片也已建好之后，作废原来那条：
 * 审批单、出站记录、「待你处理」条目（总管私聊里那张卡随它）状态一致地变成已作废，原因写进卡片答复栏和出站记录。
 * 复用统一的作废写法（gate/void-approval.ts），不另写一套；现有审批单没有原因字段，原因不单独存。
 * 不叫醒任何人，不落任何话（主人已经看过一次「下一步是对外发布，需要你批准」）。
 */
export function voidReplacedLaunchApproval(ctx: HubContext, oldApprovalId: string, now: number): void {
  voidApprovalAndOutbox(ctx, oldApprovalId, VOID_LAUNCH_REPLACED_TEXT, now);
}

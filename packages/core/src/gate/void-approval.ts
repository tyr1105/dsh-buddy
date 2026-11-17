/**
 * 中心作废一张审批的统一写法（P74r4b-m1 第 1 节）。
 *
 * 为什么统一：中心作废审批有两种来源——发布这一步用满回合上限（job/launch-approval.ts），
 * 批准之后要运行的内容被改动（gate/outbox.ts）。两处原来各写各的：一处记「已过期」，一处记「已拒绝」，
 * 后一种会让主人批准过的审批看起来像被主人拒绝。现在都经过这里：
 * - 状态记为「已过期」（现有状态里唯一不表示主人做过决定的终点），并在审批记录上加 voided: true，
 *   界面据此把状态写成「已作废」（视图字段 ApprovalCardParts.voided）；
 * - 这张审批还开着的卡片撤回，答复栏里写作废的原因（事实，不出现「拒绝」）。
 * 主人拒绝、到期没人处理、已使用的审批不经过这里，voided 保持为空。
 */
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import type { HubContext } from '../engine/context.js';

/** 发布这一步用满回合上限而作废时，撤回的卡片上写的原因。 */
export const VOID_REASON_LAUNCH_CAP = '发布这一步没有在规定的回合内完成，已作废';
/** P74r13：主人确认了去掉对外发布的约定新版本，发布审批随之作废时，撤回的卡片上写的原因。 */
export const VOID_REASON_NO_LAUNCH = '约定去掉了对外发布，这次不发布，已作废';
/** 批准之后要运行的内容被改动而作废时，撤回的卡片上写的原因。 */
export const VOID_REASON_CHANGED = '批准之后要运行的内容被改动，已作废，没有运行';

/** 批准之后内容被改动、审批属于一件事（不是发布审批）时，总管私聊里的那句话。 */
export const VOID_OWNER_TEXT = '批准之后要运行的内容被改动，这张审批已作废，没有运行。需要时让员工重新提交。';

/** 作废一张审批：改状态、加标记、撤回还开着的卡片。 */
export function voidApproval(ctx: HubContext, approvalId: string, reason: string, now: number): void {
  ctx.store.table('approvals').patch(approvalId, { status: 'expired', decidedAt: now, voided: true });
  for (const card of ctx.store.table('inbox').list(item => item.type === 'approval' && item.refId === approvalId && item.status === 'open')) {
    ctx.store.table('inbox').patch(card.id, { status: 'withdrawn', answer: reason, answeredAt: now });
  }
  ctx.emit(HUB_EVENT_SCOPES.inbox);
}

/**
 * 停止一件事时，它的约定正在重新确认（P74r2d 第 4 条，审查报告疑点 3）。
 *
 * 为什么要处理：停止原来只撤回这件事自己的「待你处理」条目（job: 开头的），约定的新版本（等主人确认的那一版）和它的确认卡、
 * 「待你处理」里 agreement: 开头的条目仍开着。主人之后对那张卡点确认，因为已没有进行中的事，按钮途径会叫醒总管，
 * 总管可能对同一份约定重新派活——主人已经说了不做。
 *
 * 做法（与总管撤销重新确认同一个口径，但不叫醒执行者：事已停止）：
 * - 待确认的那一版作废，约定回到最近一次固定的版本；约定的「待你处理」条目撤回；
 * - 这件事上与待确认版本有关的几处回到一致：暂停信息清空，提问上「已转成约定第 n 版」的记号清掉（clearReopenLinks，
 *   与 onReopenWithdrawn 共用）；「已处理到第几版」不动（待确认的版本从没固定过，没有收尾可补）；
 * - 之后主人对那张旧卡点确认，走「这张卡已不是最新的」的老路径，不叫醒总管，不会重新派活。
 * 全部是同步写存储，返回撤销步骤，由 stop 在失败时一起恢复。
 */
import type { HubContext } from '../engine/context.js';
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import { AgreementSchema, type Agreement } from '../model/agreement.js';
import type { Job } from '../model/job.js';
import { postThread } from '../outreach/thread.js';
import { agreementInboxPrefix, withdrawAgreementInboxItems } from '../project/agreement-inbox.js';
import type { InboxItem } from '../model/outreach.js';

/** 约定是不是「已有固定版本、另有待确认的新版本」（重新确认中）。 */
export function isReopenPending(agreement: Agreement): boolean {
  return agreement.state === 'pending' && agreement.versions.some(row => row.lockedAt !== null);
}

/** 撤下重新确认的结果：撤销步骤和一句给主人的说明（主人没有见过那张卡时为 null）。 */
export interface StopReopenResult { undo: Array<() => void>; notice: { thread: string; text: string; refId: string; botId: string } | null }

/**
 * 撤下这件事约定的待确认版本；约定不在重新确认中时返回 null（什么都不做）。
 * 先改状态；任何一步抛错由调用方（stop 的第二段）用返回的撤销步骤恢复。
 */
export function withdrawReopenForStop(ctx: HubContext, job: Job, now: number): StopReopenResult | null {
  const agreement = ctx.store.table('agreements').get(job.agreementId);
  if (!agreement || !isReopenPending(agreement)) return null;
  const undo: Array<() => void> = [];
  const latest = agreement.versions[agreement.versions.length - 1]!;
  const keptNo = agreement.versions.filter(row => row.lockedAt !== null).sort((a, b) => b.no - a.no)[0]!.no;
  // 1. 待确认的那一版作废，约定回到已固定。
  const versions = agreement.versions.map(row => row.state === 'pending' ? { ...row, state: 'superseded' as const } : row);
  const next = AgreementSchema.parse({ ...agreement, versions, state: 'locked', inboxId: null, updatedAt: now });
  ctx.store.table('agreements').put(next);
  undo.push(() => { ctx.store.table('agreements').put(agreement); });
  // 2. 约定的「待你处理」条目撤回（撤回前的样子记下来，失败时放回去）。
  const open: InboxItem[] = ctx.store.table('inbox').list(row => row.status === 'open' && row.subjectKey.startsWith(agreementInboxPrefix(agreement.id)));
  withdrawAgreementInboxItems(ctx, agreement.id, '这件事已停止');
  undo.push(() => { for (const item of open) ctx.store.table('inbox').put(item); });
  ctx.emit(HUB_EVENT_SCOPES.project, null);
  ctx.emit(HUB_EVENT_SCOPES.thread, agreement.botId);
  // 3. 主人已经看到过新版的卡时，私聊里留一句说明（没发过卡就不用打扰主人）。
  const notice = latest.cardMessageId === null ? null : {
    thread: agreement.originThread, refId: agreement.id, botId: agreement.botId,
    text: `约定「${agreement.title}」第 ${latest.no} 版的重新确认已撤下，因为这件事已停止。约定仍是已固定的第 ${keptNo} 版。`,
  };
  return { undo, notice };
}

/** 发出 withdrawReopenForStop 返回的说明（第三段，出错由调用方只记日志）。 */
export function postStopReopenNotice(ctx: HubContext, result: StopReopenResult): void {
  if (result.notice === null) return;
  postThread(ctx, { thread: result.notice.thread, from: 'hub', kind: 'system', refId: result.notice.refId, text: result.notice.text });
  ctx.emit(HUB_EVENT_SCOPES.thread, result.notice.botId);
}

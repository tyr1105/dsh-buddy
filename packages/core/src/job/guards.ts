/**
 * 同伴消息的收口规则（P74b）：员工之间不直接发消息；总管与正在做事的员工之间，关于那件事的往来走这件事自己的工具。
 *
 * 为什么要收口：否则执行者可以绕过交回，直接把东西发给评审员；总管的回答可以绕过「写出处」，往来也不进主题里的折叠组。
 * 这是「旧入口和新入口不能并存两套检查」的一部分（方案 5.1.5、6.5）。
 *
 * 规则：
 * 1. 发件人和收件人都不是总管：拒绝，员工有话问总管，做完交回用交回的工具；
 * 2. 一方是总管、另一方是某件进行中（不是已完成、已停止）的事的执行者或核对人：拒绝，并给出这件事的 jobId；
 * 3. 其余照旧：总管与没有在办的事的员工之间的第二档小事，仍然用 hub_send。
 *
 * 本文件只读存储，不写任何东西。
 */
import type { HubContext } from '../engine/context.js';
import { activeJobsOf } from './store.js';

/** 员工之间发消息被拒的文字（hub_job_work 在 P74d 加入，这里先写好，P74d 不用改文字）。 */
export const PEER_TO_PEER_BLOCK_TEXT = '员工之间不直接发消息。做完交回用 hub_job_work 的 submit；有问题问总管。';

/** 这位员工作为执行者或核对人的、还没收尾的事（按创建时间取最早的一件）。 */
export function activeJobOfStaff(ctx: HubContext, staffId: string) {
  return activeJobsOf(ctx, staffId).filter(job => job.executorId === staffId || job.reviewerId === staffId)
    .sort((a, b) => a.createdAt - b.createdAt)[0] ?? null;
}

/** 约定标题（一件事没有自己的标题，沿用约定的）。 */
function titleOf(ctx: HubContext, agreementId: string): string {
  return ctx.store.table('agreements').get(agreementId)?.title ?? '这件事';
}

/** 发件人 fromId 给收件人 toId 发同伴消息前调用；不允许就抛出中文错误。 */
export function assertNotOnJob(ctx: HubContext, fromId: string, toId: string): void {
  const from = ctx.store.table('bots').get(fromId);
  const to = ctx.store.table('bots').get(toId);
  if (!from || !to) return; // 找不到人的情形由 peerRecipient 报错，这里不重复
  const fromChief = from.role === 'chief';
  const toChief = to.role === 'chief';
  if (!fromChief && !toChief) throw new Error(PEER_TO_PEER_BLOCK_TEXT);
  if (fromChief && toChief) return;
  const staff = fromChief ? to : from;
  const job = activeJobOfStaff(ctx, staff.id);
  if (job === null) return;
  const title = titleOf(ctx, job.agreementId);
  if (fromChief) throw new Error(`${staff.name}正在做「${title}」（jobId 为 ${job.id}），关于这件事的往来用 hub_job_manage。`);
  throw new Error(`你正在做「${title}」（jobId 为 ${job.id}），问总管用 hub_job_work 的 ask。`);
}

/**
 * 「打扰你」的累计（P74r4a 第 5 条，对应第三次审查 K8）：回执里「打扰你 N 次」是这件事一共让主人处理过几条「待你处理」条目。
 *
 * 为什么放在这件事的记录上：原来回执去数收件箱里的条目，但已关闭的条目 30 天后会被清掉，交付 31 天后回执的数字就变了。
 * 现在每建一条与这件事或它的约定有关的条目，就在这件事的记录上加一（createInboxItem 调用 bumpDisturbCount），
 * 验收时连同回执其余几行一起算好存下（receipt.ts），之后不再现算。
 *
 * 哪些条目算与这件事有关：
 * - 这件事自己的条目（事项键 job:<jobId>:...：验收、说明、「停住了」、回合上限）；
 * - 这份约定的确认条目（事项键 agreement:<约定编号>:...）；
 * - 这份约定的组队卡条目（事项键 team:<组队卡编号>，组队卡记着是为哪份约定组的队）；
 * - 这件事发布步骤的审批条目（按审批的旁表找到它属于哪件事）。
 * 约定确认、组队卡的条目有可能早于这件事的出现（派活之前），所以派活时用 initialDisturbCount 补上已经有的几条。
 */
import type { HubContext } from '../engine/context.js';
import type { Job } from '../model/job.js';
import type { InboxItem } from '../model/outreach.js';
import { jobOfAgreement } from './store.js';

/** 一条条目属于哪件事；与任何事都无关返回 null。 */
export function relatedJobOfItem(ctx: HubContext, item: Pick<InboxItem, 'type' | 'subjectKey' | 'refId'>): Job | null {
  const key = item.subjectKey;
  const own = /^job:(job_[a-z0-9]{10}):/.exec(key);
  if (own !== null) return ctx.store.table('jobs').get(own[1]!);
  const agreement = /^agreement:(agr_[a-z0-9]{10}):/.exec(key);
  if (agreement !== null) return jobOfAgreement(ctx, agreement[1]!);
  if (key.startsWith('team:')) {
    const proposal = ctx.store.table('teamProposals').get(item.refId ?? '');
    return proposal === null || proposal.agreementId === null || proposal.agreementId === undefined ? null : jobOfAgreement(ctx, proposal.agreementId);
  }
  if (item.type === 'approval' && item.refId !== null) {
    const note = ctx.store.table('approvalNotes').get(item.refId);
    return note === null || note.jobId === undefined || note.jobId === null ? null : ctx.store.table('jobs').get(note.jobId);
  }
  return null;
}

/** 新建了一条条目：与某件事有关的，这件事的「打扰你」加一。出错只记日志，不影响条目已经建成。 */
export function bumpDisturbCount(ctx: HubContext, item: Pick<InboxItem, 'type' | 'subjectKey' | 'refId'>): void {
  try {
    const job = relatedJobOfItem(ctx, item);
    if (job === null) return;
    ctx.store.table('jobs').patch(job.id, { disturbCount: (job.disturbCount ?? 0) + 1 });
  } catch (error) {
    ctx.logger.warn('累计「打扰你」失败', { error: String(error) });
  }
}

/** 派活时已经有的、与这份约定有关的条目数（约定的确认条目、这份约定的组队卡条目，含已关闭的）：作为这件事「打扰你」的起点。 */
export function initialDisturbCount(ctx: HubContext, agreementId: string): number {
  const proposalIds = new Set(ctx.store.table('teamProposals').list(row => row.agreementId === agreementId).map(row => row.id));
  return ctx.store.table('inbox').count(row => row.subjectKey.startsWith(`agreement:${agreementId}:`)
    || (row.subjectKey.startsWith('team:') && proposalIds.has(row.refId ?? '')));
}

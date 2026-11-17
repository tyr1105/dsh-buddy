/**
 * 交付卡与回执的视图（P74f，方案 5.5、5.8，设计稿场景 D）。
 *
 * 分两层，做法同 P74d 的交回卡和核对卡：
 * - 纯函数 buildDeliveryCard、buildReceiptCard：输入显式给出记录、名字、时区，不读存储、不读时钟，
 *   每一种写法都能逐种单测，插件的示例数据也只调用它们；
 * - deliveryCardView、receiptCardView：按线程消息的 refId（delivery:<jobId>#<阶段>、receipt:<jobId>）读存储，再调用纯函数。
 *   jobCardView（job-card-views.ts）遇到这两种前缀时转到这里。
 *
 * 交付卡的结论取本阶段最后一次核对；沿用的条目回头找最近一次不是沿用的结论；逐条的历史按条目原文对应，不按序号
 * （约定改过之后序号会变，补充要求 3.7）。给主人看的文字不出现工具名、员工编号和内部编号。
 */
import type { HubContext } from '../engine/context.js';
import type { Job, JobOwnerReturn, JobReview, JobSubmission } from '../model/job.js';
import { receiptRowsOf } from '../job/receipt.js';
import { latestEstimate } from '../job/estimate.js';
import { receiptCostValue } from '../job/usage-text.js';
import { reviewsOf } from '../job/store.js';
import { localParts } from '../util/time.js';
import { evidenceView } from './job-card-views.js';
import type { DeliveryCardView, EvidenceItemView, ReceiptCardView } from './types.js';

/** P74r8：交付卡的结构化状态，取值见 job-view-schemas.ts 的 DeliveryCardPhaseSchema。 */
type DeliveryCardPhase = DeliveryCardView['phase'];

const pad = (value: number): string => String(value).padStart(2, '0');

/** 「M月D日 HH:mm」。 */
function stampText(at: number, timezone: string): string {
  const p = localParts(at, timezone);
  return `${p.month}月${p.day}日 ${pad(p.hour)}:${pad(p.minute)}`;
}

/** 交付卡标题。 */
export function deliveryCardTitle(agreementTitle: string, versionNo: number): string {
  return `${agreementTitle}　按约定第 ${versionNo} 版`;
}

export interface DeliveryCardInput {
  jobId: string;
  /** 这张卡对应的阶段。 */
  stage: number;
  /** 这件事此刻的状态与阶段：卡片是不是「最新的一张」据此判断。 */
  jobState: Job['state'];
  currentStage: number;
  /** 这张卡的修订号，和这件事本阶段最新一张卡的修订号（P74f-2；不是最新一张的卡显示失效、没有验收按钮）。省略按 0 处理。 */
  revision?: number;
  latestRevision?: number;
  agreementTitle: string;
  versionNo: number;
  /** 本阶段的全部核对（从旧到新）和它们对应的交回（按 id 查）。 */
  reviews: JobReview[];
  submissions: JobSubmission[];
  /** 交付时核对的结果；没有交付记录时为空数组。 */
  checks: Array<{ no: number; ok: boolean }>;
  deliveredAt: number | null;
  acceptedAt: number | null;
  /** 这个阶段被主人指出不符的记录；没有为 null。 */
  ownerReturn: JobOwnerReturn | null;
  /** 约定新版本在等主人确认时的版本号，否则为 null。 */
  pendingVersionNo: number | null;
  hasPreview: boolean;
  /**
   * P74r13：这张卡是不是这件事最新的一次交付。预览打开的是这件事现在的产物，不是某一次交付时的样子，
   * 所以只有最新的一次交付的卡才给预览（返工后旧的那张「未通过」的卡不给）。省略按 true 处理（只有一次交付时照旧）。
   */
  isLatestDelivery?: boolean;
  timezone: string;
}

/** 同一条目在某次核对里的结论（按原文找）。 */
function verdictByText(review: JobReview, byId: Map<string, JobSubmission>, text: string): JobReview['items'][number] | undefined {
  const submission = byId.get(review.submissionId);
  const no = submission?.items.find(item => item.text === text)?.no;
  return no === undefined ? undefined : review.items.find(item => item.no === no);
}

/** 逐条历史：「第 {r1} 轮不符，第 {r2} 轮改好。」；没有不符过为 null。 */
function historyOf(reviews: JobReview[], byId: Map<string, JobSubmission>, text: string): string | null {
  let firstUnmet: number | null = null;
  let fixedAt: number | null = null;
  for (const review of reviews) {
    const row = verdictByText(review, byId, text);
    if (row === undefined) continue;
    if (row.verdict === 'unmet') { if (firstUnmet === null) firstUnmet = review.round; fixedAt = null; }
    else if (firstUnmet !== null && fixedAt === null && row.verdict !== 'carried') fixedAt = review.round;
  }
  return firstUnmet === null || fixedAt === null ? null : `第 ${firstUnmet} 轮不符，第 ${fixedAt} 轮改好。`;
}

/** 交付卡（纯函数）。 */
export function buildDeliveryCard(input: DeliveryCardInput): DeliveryCardView {
  const byId = new Map(input.submissions.map(row => [row.id, row]));
  const last = input.reviews[input.reviews.length - 1];
  const lastSubmission = last === undefined ? undefined : byId.get(last.submissionId);
  const texts = new Map<number, string>((lastSubmission?.items ?? []).map(item => [item.no, item.text]));
  const total = last?.items.length ?? 0;
  const returned = input.ownerReturn;

  // 每一条的结论：交付时核对的看按时交付，其余取本阶段最后一次非沿用的核对结论。
  const items: EvidenceItemView[] = [...(last?.items ?? [])].sort((a, b) => a.no - b.no).map(lastRow => {
    const text = texts.get(lastRow.no) ?? '';
    const own = lastSubmission?.items.find(item => item.no === lastRow.no);
    const evidence = (own?.evidence ?? []).map(evidenceView);
    const history = historyOf(input.reviews, byId, text);
    // 沿用的条目回头找最近一次不是沿用的结论（按条目原文找，不按序号）。
    let row = lastRow;
    if (row.verdict === 'carried') {
      for (let i = input.reviews.length - 2; i >= 0; i -= 1) {
        const earlier = verdictByText(input.reviews[i]!, byId, text);
        if (earlier !== undefined && earlier.verdict !== 'carried') { row = earlier; break; }
      }
    }
    if (row.verdict === 'at_delivery') {
      const ok = input.checks.find(check => check.no === lastRow.no)?.ok ?? true;
      return { no: lastRow.no, text, evidence, fixTo: null, history,
        verdict: ok ? { label: '符合', tone: 'ok' } : { label: '不符', tone: 'bad' },
        note: ok ? `${input.deliveredAt === null ? '' : `${stampText(input.deliveredAt, input.timezone)} 交付。`}总管核对。` : '已过交付时间' };
    }
    return { no: lastRow.no, text, evidence, fixTo: null, history, note: row.note, verdict: { label: '符合', tone: 'ok' } };
  });

  const sameStage = input.stage === input.currentStage;
  const revision = input.revision ?? 0;
  // 只有这件事最新的一张交付卡才算「当前」：同一阶段重新交付之后，更早的卡失效。
  const isCurrent = sameStage && revision === (input.latestRevision ?? 0);
  // P74r8（第 2 节）：phase 与 stateText 在同一处算出，两者永远对应；界面按 phase 判断只读、着色、收起，不再按文字开头猜。
  let stateText: string;
  let phase: DeliveryCardPhase;
  if (returned !== null) { phase = 'returned'; stateText = `未通过：第 ${returned.items.map(item => item.no).join('、')} 条`; }
  else if (input.jobState === 'done' && isCurrent && input.acceptedAt !== null) { phase = 'accepted'; stateText = `已完成　${stampText(input.acceptedAt, input.timezone)}`; }
  else if (input.jobState === 'awaiting_owner' && isCurrent) {
    // 待你验收；约定有新版本在等确认时暂不可验收（文字不变，phase 区分）。
    phase = input.pendingVersionNo === null ? 'awaiting' : 'waiting_agreement';
    stateText = '待你验收';
  }
  else if (sameStage && !isCurrent) { phase = 'void'; stateText = '已失效：已重新交付'; }
  else if (input.jobState === 'stopped') { phase = 'void'; stateText = '已失效：这件事已停止'; }
  else { phase = 'void'; stateText = '已失效：约定已更新'; }

  const shown: EvidenceItemView[] = returned === null ? items : returned.items.map(flag => {
    const base = items.find(item => item.no === flag.no);
    return { no: flag.no, text: base?.text ?? flag.text, evidence: base?.evidence ?? [], history: null,
      verdict: { label: '你判不符', tone: 'bad' }, note: flag.problem, fixTo: flag.fixTo };
  });
  const waitingForOwner = input.jobState === 'awaiting_owner' && isCurrent && returned === null;
  const accept = waitingForOwner && input.pendingVersionNo === null;
  return {
    kind: 'delivery', head: '交付', title: deliveryCardTitle(input.agreementTitle, input.versionNo), stateText, phase, items: shown,
    returnedHint: returned === null ? null : `其余 ${Math.max(0, total - returned.items.length)} 条：你未提出问题，保持通过。`,
    doneHint: input.jobState === 'done' && isCurrent && returned === null ? `${total} 条全部符合，你已验收。` : null,
    // 已失效的卡不给预览（P74r8）：失效的卡只读，界面不应露出「在你的电脑上打开预览」；已完成的卡预览保留。
    // P74r13：只有这件事最新的一次交付的卡给预览：旧卡（例如返工后「未通过」的那张）点开的是现在的产物，不是那一次交付时的样子。
    actions: { accept, preview: input.hasPreview && phase !== 'void' && (input.isLatestDelivery ?? true),
      hint: accept ? '哪条不符合，直接写序号和问题。'
        : waitingForOwner && input.pendingVersionNo !== null ? `约定第 ${input.pendingVersionNo} 版在等你确认，确认后再验收。` : null },
    jobId: input.jobId, stage: input.stage, revision,
    evidenceJobId: input.jobId, evidenceSubmissionId: lastSubmission?.id ?? null,
  };
}

/** 回执卡（纯函数）。 */
export function buildReceiptCard(agreementTitle: string, rows: ReceiptCardView['rows']): ReceiptCardView {
  return { kind: 'receipt', title: `交付回执　${agreementTitle}`, rows };
}

// ---------------------------------------------------------------------------
// 读存储的一层
// ---------------------------------------------------------------------------

/** delivery:<jobId>#<阶段> 拆开；格式不对返回 null。 */
export function parseDeliveryRef(refId: string): { jobId: string; stage: number; revision: number } | null {
  const match = /^delivery:(job_[a-z0-9]{10})#(\d+)(?:~(\d+))?$/.exec(refId);
  return match === null ? null : { jobId: match[1]!, stage: Number(match[2]), revision: match[3] === undefined ? 0 : Number(match[3]) };
}

/** 按 refId 取交付卡视图；找不到记录返回 null。 */
export function deliveryCardView(ctx: HubContext, refId: string): DeliveryCardView | null {
  const parsed = parseDeliveryRef(refId);
  if (parsed === null) return null;
  const job = ctx.store.table('jobs').get(parsed.jobId);
  if (job === null) return null;
  const agreement = ctx.store.table('agreements').get(job.agreementId);
  if (agreement === null) return null;
  const reviews = reviewsOf(ctx, job.id).filter(row => row.stage === parsed.stage);
  const submissions = ctx.store.table('jobSubmissions').list(row => row.jobId === job.id && row.stage === parsed.stage);
  const latest = submissions.sort((a, b) => a.createdAt - b.createdAt)[submissions.length - 1];
  const pending = agreement.state === 'pending' ? agreement.versions[agreement.versions.length - 1]!.no : null;
  const delivery = job.delivery !== null && job.delivery !== undefined && job.delivery.stage === parsed.stage ? job.delivery : null;
  return buildDeliveryCard({
    jobId: job.id, stage: parsed.stage, jobState: job.state, currentStage: job.stage, agreementTitle: agreement.title,
    revision: parsed.revision, latestRevision: job.delivery != null && job.delivery.stage === parsed.stage ? job.delivery.rev ?? 0 : parsed.revision,
    versionNo: latest?.versionNo ?? agreement.versions[agreement.versions.length - 1]!.no,
    reviews, submissions, checks: delivery?.checks ?? [], deliveredAt: job.deliveredAt, acceptedAt: job.acceptedAt,
    ownerReturn: (job.ownerReturns ?? []).find(row => row.stage === parsed.stage) ?? null,
    pendingVersionNo: pending, hasPreview: latest?.preview !== null && latest?.preview !== undefined, timezone: ctx.settings.timezone,
    // 这件事最近一次交付记录的阶段和修订号与这张卡一致，才是最新的一次交付；没有交付记录（旧数据）按最新处理。
    isLatestDelivery: job.delivery == null || (job.delivery.stage === parsed.stage && (job.delivery.rev ?? 0) === parsed.revision),
  });
}

/** 按 refId（receipt:<jobId>）取回执视图。 */
export function receiptCardView(ctx: HubContext, refId: string): ReceiptCardView | null {
  const job = ctx.store.table('jobs').get(refId.slice('receipt:'.length));
  if (job === null) return null;
  const title = ctx.store.table('agreements').get(job.agreementId)?.title ?? '这件事';
  // P76e：第六行「消耗」只在视图里追加，不写进 Job.receipt（那里的标签是五种固定的）。没有用量行的旧数据不加这一行。
  const rows: ReceiptCardView['rows'] = receiptRowsOf(ctx, job);
  const cost = receiptCostValue(ctx.store.table('jobUsage').get(job.id), latestEstimate(ctx, job.agreementId), ctx.store.table('jobOwnerTurns').get(job.id));
  return buildReceiptCard(title, cost === null ? rows : [...rows, { label: '消耗', value: cost }]);
}

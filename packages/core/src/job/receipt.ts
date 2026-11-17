/**
 * 交付回执的数字（P74f，方案 5.8）：验收通过后落在主题里的一张卡，让主人看到「这件事花了你多少精力」。
 *
 * 为什么单独一个文件：数字全部由中心按记录算出，不调用模型；算法写成纯函数（computeReceiptRows），
 * 输入显式给出，插件的示例数据和单测都直接调用它，不会和中心各说各话。
 * 读存储的一层（receiptRowsOf）只负责把记录取齐。
 *
 * 数字不依赖内存里只保留 14 天的事件日志，也不依赖只保留 30 天的已关闭条目（补充要求 3.6、3.7，P74r4a 第 5 条）：
 * - 打扰你：这件事记录上的 disturbCount（每建一条相关条目加一，见 job/disturb.ts）；
 * - 总管替你答掉的问题：这件事记录上的 answeredCount；
 * - 核对：核对结论表，只排除中心自己生成的那一份（记录上有 byCenter 标记）；选办法之后的复核、只删条目重排之后的核对都算；
 * - 五行在验收通过时一次算好存在这件事的记录上（Job.receipt），之后查看回执用存下的数字，不再现算。
 */
import type { HubContext } from '../engine/context.js';
import type { Job, JobReview, JobSubmission } from '../model/job.js';
import { lockedVersionOf } from './files.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** 回执卡消息的 refId：receipt:<jobId>。 */
export function receiptRefId(jobId: string): string {
  return `receipt:${jobId}`;
}

/** 回执的一行。 */
export interface ReceiptRow { label: '从「定了」到验收' | '需要你处理' | '总管代你答复的问题' | '核对' | '约定版本'; value: string }

/** P74r11：旧存档里的回执标签换成新写法；其余标签原样。 */
export function modernReceiptLabel(label: string): ReceiptRow['label'] {
  if (label === '打扰你') return '需要你处理';
  if (label === '总管替你答掉的问题') return '总管代你答复的问题';
  return label as ReceiptRow['label'];
}

/** 时长：满一天写「{d} 天 {h} 小时」，不足一天写「{h} 小时 {m} 分钟」。 */
export function durationText(ms: number): string {
  const safe = Math.max(0, ms);
  if (safe >= DAY) return `${Math.floor(safe / DAY)} 天 ${Math.floor((safe % DAY) / HOUR)} 小时`;
  return `${Math.floor(safe / HOUR)} 小时 ${Math.floor((safe % HOUR) / MINUTE)} 分钟`;
}

/** 纯函数的输入：全部由调用方显式给出。 */
export interface ReceiptInput {
  firstLockedAt: number;
  acceptedAt: number;
  /** 这份约定和这件事产生过的「待你处理」条目数。 */
  disturbed: number;
  answered: number;
  /** 核对人的每一轮核对（已排除中心重排的），按时间从旧到新；first 是第一次核对里被判不符的条数。 */
  reviewRounds: number;
  firstRoundUnmet: number;
  /**
   * P74r13：有退回的轮数（核对人在这一轮判了至少一条不符的轮）。省略时按「第 1 轮有退回算 1 轮、否则 0 轮」推出，
   * 旧的调用方只给 firstRoundUnmet 时行为不变。
   */
  returnedRounds?: number;
  /** P74r12：主人在验收时指出不符的次数（这件事记录上的 ownerReturns 条数）；省略按 0。 */
  ownerReturned?: number;
  versionNo: number;
}

/**
 * P74r12：「核对」一行的值；P74r13 改为任何一轮有退回就不能写「都通过」（{n} 是总轮数）：
 * - 没有核对：无；
 * - 只核对了 1 轮并通过：「1 轮，一次通过」；
 * - 整件事的第 1 轮有退回、其余轮都没有：「{n} 轮，第 1 轮退回 {k} 条」；
 * - 有退回的轮不止一轮，或者有退回的不是第 1 轮：「{n} 轮，其中 {r} 轮有退回」；
 * - 多轮、没有任何一轮有退回：「{n} 轮，都通过」；
 * 主人指出过不符时，在值后面加「；你指出不符 {m} 次」。
 */
export function reviewRowValue(input: Pick<ReceiptInput, 'reviewRounds' | 'firstRoundUnmet' | 'ownerReturned' | 'returnedRounds'>): string {
  if (input.reviewRounds === 0) return '无';
  const n = input.reviewRounds;
  const returnedRounds = input.returnedRounds ?? (input.firstRoundUnmet > 0 ? 1 : 0);
  let base: string;
  if (returnedRounds === 0) base = n === 1 ? '1 轮，一次通过' : `${n} 轮，都通过`;
  else if (returnedRounds === 1 && input.firstRoundUnmet > 0) base = `${n} 轮，第 1 轮退回 ${input.firstRoundUnmet} 条`;
  else base = `${n} 轮，其中 ${returnedRounds} 轮有退回`;
  const returned = input.ownerReturned ?? 0;
  return returned > 0 ? `${base}；你指出不符 ${returned} 次` : base;
}

/** 回执五行。 */
export function computeReceiptRows(input: ReceiptInput): ReceiptRow[] {
  const review = reviewRowValue(input);
  return [
    { label: '从「定了」到验收', value: durationText(input.acceptedAt - input.firstLockedAt) },
    { label: '需要你处理', value: `${input.disturbed} 次` },
    { label: '总管代你答复的问题', value: `${input.answered} 个` },
    { label: '核对', value: review },
    { label: '约定版本', value: `第 ${input.versionNo} 版` },
  ];
}

/**
 * 核对人真实做过的核对：只排除中心自己生成的那一份核对记录（记录上有 byCenter 标记）。
 * P74r4a 第 5 条：原来按「它对应的交回是不是中心重排的」判断，主人选办法之后的复核、只删条目重排之后的核对，
 * 针对的正是中心重排的交回，是核对人真实做的一轮，却被误排除，回执和试用反馈少算一轮。
 * 第二个参数保留只为兼容旧的调用方，不再使用。
 */
export function realReviews(reviews: readonly JobReview[], _submissions?: ReadonlyMap<string, JobSubmission>): JobReview[] {
  return reviews.filter(review => review.byCenter !== true);
}

/**
 * 这件事「打扰你」的次数：读这件事记录上的累计（job/disturb.ts，每建一条相关条目加一）。
 * 旧数据没有累计，才回头数收件箱里现有的条目（约定的确认条目、这份约定的组队卡条目、这件事自己的条目、发布审批）。
 */
export function disturbCount(ctx: HubContext, job: Job): number {
  if (job.disturbCount !== undefined) return job.disturbCount;
  const proposalIds = new Set(ctx.store.table('teamProposals').list(row => row.agreementId === job.agreementId).map(row => row.id));
  return ctx.store.table('inbox').count(row => row.subjectKey.startsWith(`agreement:${job.agreementId}:`)
    || row.subjectKey.startsWith(`job:${job.id}:`)
    || (row.subjectKey.startsWith('team:') && proposalIds.has(row.refId ?? ''))
    // 这件事的审批条目（发布步骤，P74g 起）：按 refId 关联得到的计入。
    || (row.type === 'approval' && row.refId !== null && row.refId === job.launch.approvalId));
}

/**
 * 读存储：取回执五行。验收通过时已经算好存在这件事的记录上（job.receipt），有就直接用存下的数字，不再现算；
 * 没有（还没验收，或旧数据）才现算（验收前调用没有意义，acceptedAt 为空时按此刻）。
 */
export function receiptRowsOf(ctx: HubContext, job: Job): ReceiptRow[] {
  // 旧存档里存的标签可能是旧写法，给视图之前一律换成新写法。
  if (job.receipt !== undefined) return job.receipt.map(row => ({ label: modernReceiptLabel(row.label), value: row.value }));
  return computeReceiptRowsFor(ctx, job);
}

/** 现算回执五行（验收时调用一次、旧数据查看时调用）。 */
export function computeReceiptRowsFor(ctx: HubContext, job: Job): ReceiptRow[] {
  const reviews = realReviews(ctx.store.table('jobReviews').list(row => row.jobId === job.id).sort((a, b) => a.createdAt - b.createdAt));
  const agreement = ctx.store.table('agreements').get(job.agreementId);
  const first = reviews[0];
  return computeReceiptRows({
    firstLockedAt: job.firstLockedAt, acceptedAt: job.acceptedAt ?? ctx.clock.now(),
    disturbed: disturbCount(ctx, job), answered: job.answeredCount ?? 0,
    reviewRounds: reviews.length,
    ownerReturned: job.ownerReturns?.length ?? 0,
    firstRoundUnmet: first === undefined ? 0 : first.items.filter(item => item.verdict === 'unmet').length,
    // P74r13：有退回的轮数（任何一轮判了不符都算），不只看第 1 轮。
    returnedRounds: reviews.filter(review => review.items.some(item => item.verdict === 'unmet')).length,
    versionNo: agreement === null ? 1 : lockedVersionOf(agreement).no,
  });
}

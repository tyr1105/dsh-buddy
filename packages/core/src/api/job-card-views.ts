/**
 * 交回卡与核对卡的视图（P74d，方案 5.3，设计稿场景 C）。
 *
 * 分两层：
 * - 纯函数 buildSubmissionCard、buildReviewCard：输入显式给出交回、核对、约定标题、名字表，不读存储、不读时钟，
 *   所以每一种写法都能逐种单测，插件的示例数据也只调用它们，不会和中心各说各话；
 * - jobCardView(ctx, refId)：按线程消息的 refId（submission:<id> 或 review:<id>）读存储，再调用纯函数。
 * 另有 cardTitleFor：往来折叠组里「最近一句」用的卡片标题。
 *
 * 给主人看的文字不出现工具名、机器人 id、内部编号：用「员工」「你」，称呼用名字表里的名字。
 * 交回、核对、交付共用同一种清单（EvidenceItemView），只有结论一栏不同。
 */
import { posix } from 'node:path';
import { JOB_DEFAULTS as D } from '../config/defaults.js';
import type { HubContext } from '../engine/context.js';
import { hostOf } from '../job/evidence.js';
import { reviewsOf } from '../job/store.js';
import type { Evidence, JobReview, JobSubmission } from '../model/job.js';
import type { ThreadMessage } from '../model/outreach.js';
import type { EvidenceItemView, JobCardView, ReviewCardView, SubmissionCardView } from './types.js';
import { deliveryCardView, receiptCardView } from './job-delivery-views.js';
import { escalationCardView } from './job-escalation-views.js';
import { retroCardView } from './skill-views.js';
import { skillCheckCardView } from './skill-check-card.js';
import { parseRetroCardRef, parseSkillCheckCardRef } from '../skill/card.js';

/** 核对卡底部的固定一行。 */
export const REVIEW_CARD_FOOTER = '只核对是否符合约定、是否正确；配色、字体、文案语气不在核对范围。';

/** 交回卡标题：「{约定标题}　第 {round} 轮」。工作往来消息的文字也用它。 */
export function submissionCardTitle(agreementTitle: string, round: number): string {
  return `${agreementTitle}　第 ${round} 轮`;
}

/** 核对卡标题。通过时 count 是全部条数，不通过时是不符条数。 */
export function reviewCardTitle(round: number, pass: boolean, count: number): string {
  return pass ? `第 ${round} 轮　通过：${count} 条均符合` : `第 ${round} 轮　不通过：${count} 条不符`;
}

/** 一项证据在卡片上的样子：文件显示文件名，截图显示说明，测试显示「自动测试」，链接显示主机名。 */
export function evidenceView(evidence: Evidence): EvidenceItemView['evidence'][number] {
  const label = evidence.kind === 'file' ? posix.basename(evidence.path ?? '') || evidence.summary
    : evidence.kind === 'image' ? evidence.summary
      : evidence.kind === 'test' ? '自动测试' : hostOf(evidence.url ?? '');
  return { id: evidence.id, kind: evidence.kind, label, path: evidence.path, url: evidence.url, summary: evidence.summary,
    checkText: evidence.check.detail === '' ? null : evidence.check.detail };
}

// ---------------------------------------------------------------------------
// 交回卡
// ---------------------------------------------------------------------------

export interface SubmissionCardInput {
  submission: JobSubmission;
  /** 约定标题（一件事沿用约定的标题）。 */
  agreementTitle: string;
}

/** 自查结论 -> 卡片上的结论栏。 */
function selfCheckVerdict(selfCheck: JobSubmission['items'][number]['selfCheck']): EvidenceItemView['verdict'] {
  switch (selfCheck) {
    case 'met': return { label: '自查符合', tone: 'ok' };
    case 'not_met': return { label: '自查不符', tone: 'bad' };
    case 'at_delivery': return { label: '交付时核对', tone: 'na' };
    case 'carried': return { label: '沿用', tone: 'na' };
  }
}

/** 交回卡：每条对应约定里「怎样算做完」的一条，写自查结论和证据。 */
export function buildSubmissionCard(input: SubmissionCardInput): SubmissionCardView {
  const { submission } = input;
  const own = submission.items.filter(item => item.selfCheck !== 'carried').length;
  const files = submission.deliverables.map(path => posix.basename(path)).join('、');
  return {
    kind: 'submission', head: '交回',
    title: submissionCardTitle(input.agreementTitle, submission.round),
    stateText: `按约定第 ${submission.versionNo} 版　自查 ${own} 条`,
    intro: `产出物：${files}，在主题文件夹「交付」里。`,
    evidenceJobId: submission.jobId, evidenceSubmissionId: submission.id,
    items: [...submission.items].sort((a, b) => a.no - b.no).map(item => ({
      no: item.no, text: item.text, verdict: selfCheckVerdict(item.selfCheck),
      // 沿用的条目带着上一次的证据（数据里保留），卡片上不重复展示。
      evidence: item.selfCheck === 'carried' ? [] : item.evidence.map(evidenceView), note: item.selfCheck === 'carried' ? null : item.note, fixTo: null, history: null,
    })),
  };
}

// ---------------------------------------------------------------------------
// 核对卡
// ---------------------------------------------------------------------------

export interface ReviewCardInput {
  review: JobReview;
  submission: JobSubmission;
  /** 沿用的结论来自第几轮核对（上一次核对的轮次）；没有上一次核对为 null。 */
  previousRound: number | null;
  /** 员工 id -> 名字。 */
  names: Record<string, string>;
  /** 这件事的总管 id：总管自己核对时核对人写「总管」。 */
  chiefId: string;
}

/** 核对结论 -> 卡片上的结论栏。 */
function reviewVerdict(verdict: JobReview['items'][number]['verdict']): EvidenceItemView['verdict'] {
  switch (verdict) {
    case 'met': return { label: '符合', tone: 'ok' };
    case 'unmet': return { label: '不符', tone: 'bad' };
    case 'at_delivery': return { label: '交付时核对', tone: 'na' };
    case 'carried': return { label: '沿用', tone: 'na' };
  }
}

/** 核对卡：通过时只列本轮非沿用的条目；不通过时列全部条目，不符的写明问题和「改到什么程度算过」。 */
export function buildReviewCard(input: ReviewCardInput): ReviewCardView {
  const { review, submission } = input;
  const unmet = review.items.filter(item => item.verdict === 'unmet');
  const pass = unmet.length === 0;
  const all: EvidenceItemView[] = [...review.items].sort((a, b) => a.no - b.no).map(row => {
    const own = submission.items.find(item => item.no === row.no);
    const shownEvidence = own === undefined || own.selfCheck === 'carried' ? [] : own.evidence;
    return { no: row.no, text: own?.text ?? '', verdict: reviewVerdict(row.verdict), evidence: shownEvidence.map(evidenceView),
      note: row.note, fixTo: row.fixTo, history: null };
  });
  // 沿用的条目：一句话交代，卡片里不重复。
  const carried = review.items.filter(item => item.verdict === 'carried');
  let carriedText: string | null = null;
  if (carried.length > 0) {
    const from = input.previousRound === null ? '上一轮' : `第 ${input.previousRound} 轮`;
    // 抽查只写仍然沿用的条目（重新写了结论的条目不算抽查）。
    const spot = review.spotChecked.filter(no => carried.some(item => item.no === no));
    carriedText = `其余 ${carried.length} 条沿用${from}结论${review.carriedNote === null ? '' : `：${review.carriedNote}`}${spot.length === 0 ? '' : `；抽查了第 ${spot.join('、')} 条，仍然符合`}。`;
  }
  return {
    kind: 'review', head: '核对',
    title: reviewCardTitle(review.round, pass, pass ? review.items.length : unmet.length),
    stateText: pass ? '已通过' : null,
    roundText: pass ? null : `剩余 ${D.REVIEW_ROUNDS_MAX - review.round} 轮`,
    items: pass ? all.filter(item => item.verdict.label !== '沿用') : all,
    carriedText, footer: REVIEW_CARD_FOOTER,
    evidenceJobId: review.jobId, evidenceSubmissionId: submission.id,
    reviewerName: review.reviewerId === input.chiefId ? '总管' : input.names[review.reviewerId] ?? '评审员',
  };
}

// ---------------------------------------------------------------------------
// 读存储的一层
// ---------------------------------------------------------------------------

/** 员工 id -> 名字。 */
function nameTable(ctx: HubContext): Record<string, string> {
  const names: Record<string, string> = {};
  for (const bot of ctx.store.table('bots').list()) names[bot.id] = bot.name;
  return names;
}

/** 约定标题。 */
function titleOfJob(ctx: HubContext, jobId: string): string {
  const job = ctx.store.table('jobs').get(jobId);
  return (job === null ? null : ctx.store.table('agreements').get(job.agreementId)?.title) ?? '这件事';
}

/** 按线程消息的 refId 取卡片视图：submission:<id> 或 review:<id>；找不到对应记录返回 null（界面退回显示文字）。 */
export function jobCardView(ctx: HubContext, refId: string | null): JobCardView | null {
  if (refId === null) return null;
  // P74f：交付卡、回执（楼层卡片，不进往来折叠组）。
  if (refId.startsWith('delivery:')) return deliveryCardView(ctx, refId);
  if (refId.startsWith('receipt:')) return receiptCardView(ctx, refId);
  // P74f-2：三轮不过卡（总管私聊里的楼层卡片）。
  if (refId.startsWith('escalation:')) return escalationCardView(ctx, refId);
  // P75g：复盘卡（主题折叠组里，retro:<runId>:<botId>；读存储版在 skill-views.ts）。
  if (refId.startsWith('retro:')) return retroCardView(ctx, refId);
  // P75h：技能核对卡（skillcheck:<updateId>#<第几次核对>；读存储版在 skill-check-card.ts）。
  if (refId.startsWith('skillcheck:')) return skillCheckCardView(ctx, refId);
  if (refId.startsWith('submission:')) {
    const submission = ctx.store.table('jobSubmissions').get(refId.slice('submission:'.length));
    return submission === null ? null : buildSubmissionCard({ submission, agreementTitle: titleOfJob(ctx, submission.jobId) });
  }
  if (refId.startsWith('review:')) {
    const review = ctx.store.table('jobReviews').get(refId.slice('review:'.length));
    if (review === null) return null;
    const submission = ctx.store.table('jobSubmissions').get(review.submissionId);
    const job = ctx.store.table('jobs').get(review.jobId);
    if (submission === null || job === null) return null;
    const all = reviewsOf(ctx, review.jobId);
    const index = all.findIndex(row => row.id === review.id);
    const previous = index > 0 ? all[index - 1]! : null;
    return buildReviewCard({ review, submission, previousRound: previous?.round ?? null, names: nameTable(ctx), chiefId: job.chiefId });
  }
  return null;
}

/**
 * 往来折叠组里卡片消息的接收者名字（只读，名字取法同往来消息：查不到的写「已删除的员工」）：
 * - 交回卡：这次交回的核对人；核对人是总管自己时只写「总管」，是评审员时写「评审员名字、总管」；
 * - 核对卡：执行者和总管（顺序：执行者、总管）；核对人是总管自己时只写执行者。
 * 其他卡片（交付卡、三轮不过卡、回执）不在折叠组里，返回空。
 */
export function cardRecipientsFor(ctx: HubContext): (message: ThreadMessage) => string[] {
  const nameOf = (id: string): string => ctx.store.table('bots').get(id)?.name ?? '已删除的员工';
  return message => {
    const ref = message.refId;
    if (ref === null) return [];
    if (ref.startsWith('submission:')) {
      const submission = ctx.store.table('jobSubmissions').get(ref.slice('submission:'.length));
      const job = submission === null ? null : ctx.store.table('jobs').get(submission.jobId);
      if (job === null) return [];
      return job.reviewerId === null || job.reviewerId === job.chiefId ? ['总管'] : [nameOf(job.reviewerId), '总管'];
    }
    if (ref.startsWith('review:')) {
      const review = ctx.store.table('jobReviews').get(ref.slice('review:'.length));
      const job = review === null ? null : ctx.store.table('jobs').get(review.jobId);
      if (review === null || job === null) return [];
      const executor = nameOf(job.executorId);
      return review.reviewerId === job.chiefId ? [executor] : [executor, '总管'];
    }
    // P75g：复盘卡的接收者是这次更新的核对人（没有更新时没有箭头）；改写卡（P75h）同样，只看被改写的那一条。
    if (ref.startsWith('retro:')) {
      const parsed = parseRetroCardRef(ref);
      if (parsed === null) return [];
      const { runId, botId } = parsed;
      const run = ctx.store.table('skillRuns').get(runId);
      const job = run === null || run.jobId === null ? null : ctx.store.table('jobs').get(run.jobId);
      const updates = ctx.store.table('skillUpdates').list(row => row.runId === runId && row.botId === botId && (parsed.updateId === null || row.id === parsed.updateId));
      return [...new Set(updates.map(row => row.checkerId))]
        .map(id => job !== null && id === job.chiefId ? '总管' : nameOf(id))
        .filter(name => name !== '');
    }
    // P75h：核对卡的接收者是这条更新的提交人。
    if (ref.startsWith('skillcheck:')) {
      const parsed = parseSkillCheckCardRef(ref);
      const update = parsed === null ? null : ctx.store.table('skillUpdates').get(parsed.updateId);
      return update === null ? [] : [nameOf(update.botId)];
    }
    return [];
  };
}

/** 往来折叠组里卡片消息的标题：交回卡写「{执行者}交回第 {round} 轮」，核对卡取卡片标题。 */
export function cardTitleFor(ctx: HubContext): (message: ThreadMessage) => string {
  return message => {
    const ref = message.refId;
    if (ref === null) return '';
    if (ref.startsWith('submission:')) {
      const submission = ctx.store.table('jobSubmissions').get(ref.slice('submission:'.length));
      if (submission === null) return '交回卡';
      return `${ctx.store.table('bots').get(submission.executorId)?.name ?? '执行者'}交回第 ${submission.round} 轮`;
    }
    if (ref.startsWith('review:')) {
      const view = jobCardView(ctx, ref);
      return view !== null && view.kind === 'review' ? view.title : '核对卡';
    }
    // P75g：复盘卡用卡片标题「{名字}　{标题}」。
    if (ref.startsWith('retro:')) {
      const view = jobCardView(ctx, ref);
      return view !== null && view.kind === 'retro' ? view.title : '复盘';
    }
    // P75h：核对卡用卡片标题「技能更新　「{技能}」第 {n} 版」。
    if (ref.startsWith('skillcheck:')) {
      const view = jobCardView(ctx, ref);
      return view !== null && view.kind === 'skill_check' ? view.title : '技能更新核对';
    }
    return '';
  };
}

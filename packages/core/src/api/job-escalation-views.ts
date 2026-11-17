/**
 * 三轮不过卡的视图（P74f-2，任务卡第 9 节 EscalationCardView）：总管用 escalate 说明卡在哪、给出办法之后，
 * 在总管私聊里落的一张卡（楼层卡片，不进往来折叠组），主人在卡上点一个办法。
 *
 * 两层：纯函数 buildEscalationCard（输入显式给记录、各轮核对、名字，不读存储）和读存储的 escalationCardView。
 * 文字里不出现内部编号、工具名、mode 名：办法的标题、做法与代价、建议理由在 escalate 时已经检查过（job/owner-text.ts），
 * 卡上的「各轮怎么试的」取自交回说明和核对说明，含内部名称的换成固定句。只读，不写任何东西。
 *
 * P74r4a：说明随约定版本失效（job/escalation-expiry.ts）：失效的卡状态文字写明原因（已失效：约定在重新确认、已失效：约定已更新），
 * 办法不可选（selectable 为假）；「待你处理」里这次说明的条目带这张卡的完整视图（inboxView 的 escalationCard 字段，
 * 与总管私聊里那张卡同一份数据）。
 */
import type { HubContext } from '../engine/context.js';
import type { Agreement } from '../model/agreement.js';
import type { InboxItem } from '../model/outreach.js';
import type { JobEscalation, JobReview, JobSubmission } from '../model/job.js';
import { changeLineOf } from '../job/change-line.js';
import { lockedVersionOf } from '../job/files.js';
import { OPTION_LETTERS, escalationTitle } from '../job/escalate.js';
import { EXPIRY_STATE_TEXT, jobEscalationExpiry, type EscalationExpiry } from '../job/escalation-expiry.js';
import { nextOptionVersionNo } from '../job/option-version.js';
import { ownerSafe } from '../job/owner-text.js';
import { reviewsOf } from '../job/store.js';
import type { EscalationCardView } from './types.js';

export { changeLineOf };

/** 内部名称换成的固定句。 */
const HIDDEN_TEXT = '详情见这件事的主题';

export interface EscalationCardInput {
  jobId: string;
  escalation: JobEscalation;
  executorName: string;
  /** 这一阶段的全部核对（从旧到新）和它们对应的交回（按 id 查）。 */
  reviews: JobReview[];
  submissions: JobSubmission[];
  /**
   * 这张卡对应的约定版本里「怎样算做完」的清单（用来写「删去」办法的一行文字）；取不到为 null。
   * 由 escalationCardView 按「主人选之前取说明时的版本，选过之后取当时被替换的那一版」算出。
   */
  doneWhen?: string[] | null;
  /** 这次说明失效的原因；仍有效为 null（可省略）。 */
  expiry?: EscalationExpiry | null;
  /** P74r6：选了带改动的办法之后实际会生成的约定版本号（与 option-version.ts 的 nextOptionVersionNo 同一个算法）；省略时按说明时的版本号加 1。 */
  nextVersionNo?: number;
}

/**
 * 这张卡对应的约定版本里的「怎样算做完」清单。
 * - 主人还没选：说明时记下的版本（失效的卡也按它显示，不随约定后来的变化改写）；找不到时取当前固定的版本；
 * - 主人选了不带改动的办法（约定没有变）：当前固定的版本；
 * - 主人选了带改动的办法：中心当时生成的新版本（创建时间等于选办法的时间、来源是主人的指示）的上一版，
 *   这样约定后来又变了，旧卡也按选办法当时的内容显示；找不到时退回说明时记下的版本号，再找不到返回 null。
 */
export function doneWhenForCard(agreement: Agreement | null, escalation: JobEscalation): string[] | null {
  if (agreement === null || agreement.versions.length === 0) return null;
  const chosen = escalation.chosen === null ? null : escalation.options[escalation.chosen] ?? null;
  if (chosen === null) {
    return agreement.versions.find(row => row.no === escalation.versionNo)?.content.doneWhen
      ?? (agreement.versions.some(row => row.lockedAt !== null) ? lockedVersionOf(agreement).content.doneWhen : null);
  }
  if (chosen.change === null) return lockedVersionOf(agreement).content.doneWhen;
  const made = agreement.versions.find(row => row.source === 'owner_instruction' && row.createdAt === escalation.chosenAt);
  const prev = made === undefined ? agreement.versions.find(row => row.no === escalation.versionNo) : agreement.versions.find(row => row.no === made.no - 1);
  return prev?.content.doneWhen ?? null;
}

/** review_limit：逐轮「第 {r} 轮：{changeNote}。{核对人对该条的 note}」，按卡住条目的原文找同一条。 */
function triedByRound(input: EscalationCardInput): string[] {
  const byId = new Map(input.submissions.map(row => [row.id, row]));
  return input.reviews.map(review => {
    const submission = byId.get(review.submissionId);
    const no = submission?.items.find(item => item.text === input.escalation.noText)?.no ?? input.escalation.no;
    // P74r5 第 2 节：交回说明本身常以句号结尾，直接拼「。」会出现「。。」：拼之前去掉交回说明末尾的空白和句末标点，再加一个「。」；
    // 核对说明开头的空白去掉。去掉之后为空的按没有写处理（固定字样不变）。
    const sent = (submission?.changeNote ?? '').replace(TRAILING_PUNCT, '');
    const note = (review.items.find(row => row.no === no)?.note ?? '').replace(/^\s+/, '');
    return ownerSafe(`第 ${review.round} 轮：${sent === '' ? '（没有交回说明）' : sent}。${note === '' ? '（没有写说明）' : note}`, `第 ${review.round} 轮：${HIDDEN_TEXT}`);
  });
}

/** 交回说明末尾要去掉的空白和句末标点（。．.！!？?；;，,）。 */
const TRAILING_PUNCT = /[\s。．.！!？?；;，,]+$/;

/**
 * 「可选的办法」小标题（P74r5 第 3 节）：带改动的办法一个：选 A；两个：选 A 或 B；三个及以上：选 A、B 或 C；
 * 后面接「即记为约定第 n 版，不再另外请你确认」。没有带改动的办法、或这张卡已不可选（主人已选、已失效）时只写「可选的办法」，
 * 免得对已经选过的卡还写「即记为……」与事实不符。
 */
function optionsTitleOf(letters: readonly string[], selectable: boolean, nextVersionNo: number): string {
  if (letters.length === 0 || !selectable) return '可选的办法';
  const list = letters.length === 1 ? letters[0]! : `${letters.slice(0, -1).join('、')} 或 ${letters[letters.length - 1]}`;
  return `可选的办法　选 ${list} 即记为约定第 ${nextVersionNo} 版，不再另外请你确认`;
}

/** 三轮不过卡（纯函数）。 */
export function buildEscalationCard(input: EscalationCardInput): EscalationCardView {
  const { escalation } = input;
  const expiry = input.expiry ?? null;
  const letters = escalation.options.flatMap((option, index) => (option.change === null ? [] : [OPTION_LETTERS[index]!]));
  const chosenLetter = escalation.chosen === null ? null : OPTION_LETTERS[escalation.chosen]!;
  return {
    kind: 'escalation', head: '提问', title: escalationTitle(escalation, input.executorName),
    stateText: chosenLetter !== null ? `你选了 ${chosenLetter}` : expiry !== null ? EXPIRY_STATE_TEXT[expiry] : '等你决定',
    stuckAt: escalation.stuckAt,
    tried: escalation.kind === 'review_limit' ? triedByRound(input) : escalation.tried.map(text => ownerSafe(text, HIDDEN_TEXT)),
    optionsTitle: optionsTitleOf(letters, chosenLetter === null && expiry === null, input.nextVersionNo ?? escalation.versionNo + 1),
    options: escalation.options.map((option, index) => ({
      letter: OPTION_LETTERS[index]!, title: option.title, detail: option.detail, suggested: index === escalation.suggested,
      changeLine: changeLineOf(option.change, input.doneWhen ?? null) })),
    reasonHint: `建议 ${OPTION_LETTERS[escalation.suggested]} 的理由：${escalation.reason}`,
    jobId: input.jobId, stage: escalation.stage, chosen: chosenLetter, revision: escalation.rev ?? 0,
    // 办法可不可选：主人已经选过、或这次说明已失效，都不可选（界面据此把办法画成不可点）。
    selectable: chosenLetter === null && expiry === null,
  };
}

/** escalation:<jobId>#<阶段> 拆开；格式不对返回 null。 */
export function parseEscalationRef(refId: string): { jobId: string; stage: number; rev: number } | null {
  const match = /^escalation:(job_[a-z0-9]{10})#(\d+)(?:~(\d+))?$/.exec(refId);
  return match === null ? null : { jobId: match[1]!, stage: Number(match[2]), rev: match[3] === undefined ? 0 : Number(match[3]) };
}

/** 按 refId 取三轮不过卡视图；找不到记录（或这件事记录的说明不是这一阶段的）返回 null。 */
export function escalationCardView(ctx: HubContext, refId: string): EscalationCardView | null {
  const parsed = parseEscalationRef(refId);
  if (parsed === null) return null;
  const job = ctx.store.table('jobs').get(parsed.jobId);
  // 同一阶段再次说明时，上一次的记录放进了 escalationHistory：按阶段和修订号找，旧卡仍显示主人当时选的办法。
  const escalation = job === null ? null : [...(job.escalationHistory ?? []), ...(job.escalation == null ? [] : [job.escalation])]
    .find(row => row.stage === parsed.stage && (row.rev ?? 0) === parsed.rev) ?? null;
  if (job === null || escalation === null) return null;
  const reviews = reviewsOf(ctx, job.id).filter(row => row.stage === parsed.stage);
  const submissions = ctx.store.table('jobSubmissions').list(row => row.jobId === job.id && row.stage === parsed.stage);
  const agreement = ctx.store.table('agreements').get(job.agreementId);
  const doneWhen = doneWhenForCard(agreement, escalation);
  // 失效：主人没选、而约定在重新确认或版本变了，或这次说明已被标为失效。更早的几次说明（历史里的）没选过的一律是已被取代的，
  // 也按失效显示（同一阶段再次说明之后，旧的一张只会是失效的）。
  const isLatest = job.escalation != null && job.escalation.stage === escalation.stage && (job.escalation.rev ?? 0) === (escalation.rev ?? 0);
  // 状态按事实写（job/escalation-expiry.ts）：已停止、记下的原因、不是这一次受阻的说明（含历史里被取代的）、兜底的约定变化。
  const expiry = jobEscalationExpiry(ctx, job, escalation, isLatest);
  return buildEscalationCard({ jobId: job.id, escalation, executorName: ctx.store.table('bots').get(job.executorId)?.name ?? '执行者', reviews, submissions, doneWhen, expiry,
    ...(agreement === null ? {} : { nextVersionNo: nextOptionVersionNo(agreement) }) });
}

/** 「待你处理」里这次说明的条目（事项键 job:<jobId>:escalate:<阶段>[~修订号]）对应的卡片 refId；不是这类条目返回 null。 */
export function escalationRefOfItem(item: Pick<InboxItem, 'subjectKey'>): string | null {
  const match = /^job:(job_[a-z0-9]{10}):escalate:(\d+)(?:~(\d+))?$/.exec(item.subjectKey);
  return match === null ? null : `escalation:${match[1]}#${match[2]}${match[3] === undefined ? '' : `~${match[3]}`}`;
}

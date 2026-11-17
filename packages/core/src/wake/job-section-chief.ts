/**
 * 唤醒包「你手上的事」段里总管的两种写法（P74c，任务卡 9.3 与 9 节开头）：
 * 一、执行链唤醒（唤醒单带 jobId）：这件事的状态、约定各部分的序号、需要总管处理的情况行；
 * 二、没有 jobId 的唤醒（含主人发起的）：「你手上的事」一览，最多 5 件，每件一行。
 *
 * 为什么约定各部分要带序号：总管回答执行者的提问时，依据（basis）要写约定的哪一部分的第几条，
 * 序号必须和主题文件夹里「约定.md」、和这里列的完全一致，模型才能不看别处就填对。
 * 给模型看的段落可以出现工具名和编号；给主人看的文字不在这里。
 * 只读存储，不写任何东西。
 */
import { waitingOnOf } from '../api/job-views.js';
import type { HubContext } from '../engine/context.js';
import { botIsArchived } from '../model/bot.js';
import { ON_TEAM_LIFECYCLES } from '../model/enums.js';
import { expectedActorOf, isOnDutyNow, offDutyOfJob } from '../job/chain.js';
import { reviewStalled } from '../job/version-stage.js';
import { latestEstimate } from '../job/estimate.js';
import { chiefCostLine } from '../job/usage-text.js';
import { narrowParagraph } from '../job/narrow.js';
import { escalatedThisBlock } from '../job/escalate.js';
import { stuckStepName } from '../job/participants.js';
import { suspendedFactLine } from '../job/suspended.js';
import { expiredWakeText } from '../job/escalation-expiry.js';
import { lockedVersionOf } from '../job/files.js';
import { staffDutyLabel } from '../team/workload.js';
import { reviewsOf, activeJobsOf, eventsOf } from '../job/store.js';
import { JOB_STATE_LABELS, type Job, type JobEvent } from '../model/job.js';
import { JOB_DEFAULTS as D } from '../config/defaults.js';
import { localParts } from '../util/time.js';
import { recentClosedJobs } from '../job/recent-closed.js';
import { byteLength, truncateBytes } from '../util/text.js';
import { withLabel } from '../util/name-label.js';
import { joinQuestion } from '../util/question-join.js';
import { closeSentence } from '../util/sentence.js';
import { clipWithEllipsis, type CompressLevel, type FlexRow, type JobBodyParts } from './job-section-fit.js';

/**
 * P74r15：这件事的受阻是不是「某个回合被中心结束」造成的：受阻中，最近一条执行者受阻事件的原因标记是超时或用量超线。
 * 是的话，受阻说明本身就是写明是谁的回合的事实句，唤醒包直接照写。
 */
function centerEndedBlock(ctx: HubContext, job: Job, wakeEvents: readonly JobEvent[]): boolean {
  if (job.state !== 'blocked' || job.blocked === null) return false;
  const latest = [...wakeEvents, ...eventsOf(ctx, job.id)].reverse().find(row => row.kind === 'executor_blocked');
  const reason = latest?.data.reason;
  return reason === 'turn_overtime' || reason === 'turn_overuse';
}

/**
 * 核对人没有动静时的那一句（总管唤醒包和「你手上的事」一览共用）：
 * 回合被中心结束造成的，写事实句加「第 n 轮的核对结论没有提交」；兜底连续叫了两次都没有提交的，写「两次被叫醒都没有提交」。
 */
function reviewerStallLine(ctx: HubContext, job: Job, wakeEvents: readonly JobEvent[]): string {
  if (centerEndedBlock(ctx, job, wakeEvents)) return `${closeSentence(job.blocked!.text)}第 ${job.round} 轮的核对结论没有提交。`;
  return `${nameOf(ctx, job.reviewerId, '总管')}两次被叫醒都没有提交第 ${job.round} 轮的核对结论。`;
}

/** P76e：这件事的消耗一行（已用回合、预计总数）；读这件事的用量行和约定最新的预计。 */
function costLineFor(ctx: HubContext, job: Job): string {
  return chiefCostLine(ctx.store.table('jobUsage').get(job.id), latestEstimate(ctx, job.agreementId));
}

/** 总管的「一览」最多列几件。 */
const OVERVIEW_MAX = 5;

/** id → 名字。 */
function nameOf(ctx: HubContext, id: string | null, fallback: string): string {
  return id === null ? fallback : ctx.store.table('bots').get(id)?.name ?? fallback;
}

/** 在岗的员工（不含总管）：名字和角色标签，换人时从里面选（P74r2a：只用唤醒包里的文字就能写对名字）。 */
function staffLine(ctx: HubContext): string {
  const staff = ctx.store.table('bots').list(row => row.role !== 'chief' && (ON_TEAM_LIFECYCLES as readonly string[]).includes(row.lifecycle) && !botIsArchived(row));
  return staff.length === 0 ? '当前没有在岗的员工，要换人先告诉主人添加。'
    : `当前在岗的员工：${staff.map(bot => withLabel(bot.name, staffDutyLabel(ctx, bot))).join('、')}。`;
}

/** 换核对人的做法（写给总管看，只写现在真能做成的）。 */
function swapReviewerHint(job: Job): string {
  return `换核对人：调用 hub_job_manage，mode 写 reassign，jobId 写 ${job.id}，reviewer 写新核对人的名字；写「总管」表示由你自己核对。`;
}

/** 换执行者的做法。 */
function swapExecutorHint(job: Job): string {
  return `换执行者：调用 hub_job_manage，mode 写 reassign，jobId 写 ${job.id}，executor 写新执行者的名字。`;
}

/**
 * 「还没有回答的那一问」的原文：先读这件事记录上存的原文（P74r2a），没有（升级前的数据）才取 asked 事件里的 text；
 * 都没有就说明原文不在记录里。
 */
function askTextOf(ctx: HubContext, job: Job): string {
  if (job.openAsk === null) return '';
  if (typeof job.openAsk.text === 'string' && job.openAsk.text !== '') return job.openAsk.text;
  const event = eventsOf(ctx, job.id).find(row => row.id === job.openAsk!.eventId);
  const text = event?.data.text;
  return typeof text === 'string' && text !== '' ? text : '（问题原文没有留在记录里，请让他再说一遍）';
}

/** 核对三轮不过时，逐轮列出：第几轮、交回时怎么说的、核对人对那一条怎么说。 */
function reviewLimitLines(ctx: HubContext, job: Job): string {
  const no = job.blocked?.no ?? null;
  // P74r2c：各轮核对记录按它们当时的序号存；约定改过之后 blocked.no 是现在的序号，按条目原文找「同一条」，不按序号。
  const agreement = ctx.store.table('agreements').get(job.agreementId);
  const wanted = no === null || !agreement ? undefined : lockedVersionOf(agreement).content.doneWhen[no - 1];
  const rows = reviewsOf(ctx, job.id).filter(review => review.stage === job.stage).map(review => {
    const submission = ctx.store.table('jobSubmissions').get(review.submissionId);
    const item = no === null ? undefined : review.items.find(row => wanted === undefined || submission === null
      ? row.no === no : submission.items.find(own => own.no === row.no)?.text === wanted);
    return `第 ${review.round} 轮：${submission?.changeNote ?? '（没有交回说明）'}。核对人：${item?.note ?? '（没有写说明）'}`;
  });
  return `第 ${no ?? '?'} 条核对三轮仍未通过。各轮：${rows.join('；')}`;
}

/** 执行链唤醒里总管看到的这件事（任务卡 9.3 逐字）。wakeEvents 是这次唤醒证据里对应的事件，目前用来取执行者的 tried。 */
export function chiefChainBody(ctx: HubContext, job: Job, absPath: (name: string) => string, wakeEvents: readonly JobEvent[], level: CompressLevel = 0, materials: readonly string[] = []): JobBodyParts {
  const title = ctx.store.table('agreements').get(job.agreementId)?.title ?? '这件事';
  const agreement = ctx.store.table('agreements').get(job.agreementId);
  const executor = nameOf(ctx, job.executorId, '执行者');
  const reviewer = job.reviewerId === null ? '你' : nameOf(ctx, job.reviewerId, '评审员');
  const rows = [`「${title}」（jobId 为 ${job.id}）：${JOB_STATE_LABELS[job.state]}，执行者${executor}，核对人${reviewer}。约定全文：${absPath(D.FOLDER_FILES.agreement)}。`,
    // P76e：这件事的消耗（已用回合与预计），让总管心里有数。
    costLineFor(ctx, job)];
  // P74e：约定各部分的序号是可缩减的清单（条目太多放不下时从最后往前省略）；末尾的做法说明（怎样回答）一行不丢。
  const flex: FlexRow[] = [];
  let note: string | null = null;
  if (agreement) {
    const c = lockedVersionOf(agreement).content;
    rows.push('约定各部分的序号（回答时 basis 用 section 加 no）：');
    // P74r2d：放不下时第三级把每条原文截到 60 字（序号一直在，回答引用出处只要序号）；截短了才写「条目全文见约定文件」。
    let shortened = false;
    const line = (prefix: string, text: string): string => {
      const shown = level >= 3 ? clipWithEllipsis(text, D.PACKET_CLIP_ITEM_CHARS) : { text, clipped: false };
      if (shown.clipped) shortened = true;
      return `${prefix} ${shown.text}`;
    };
    const numbered: string[] = [line('summary 1.', c.summary)];
    c.pending.forEach((item, index) => numbered.push(line(`pending ${index + 1}.`, joinQuestion(item.question, item.chosen ?? item.suggested))));
    c.decided.forEach((item, index) => numbered.push(line(`decided ${index + 1}.`, item.text)));
    c.scopeIn.forEach((item, index) => numbered.push(line(`scopeIn ${index + 1}.`, item)));
    c.scopeOut.forEach((item, index) => numbered.push(line(`scopeOut ${index + 1}.`, item)));
    c.doneWhen.forEach((item, index) => numbered.push(line(`doneWhen ${index + 1}.`, item)));
    flex.push({ items: numbered, render: kept => (kept.length === 0 ? null : kept.join('\n')) });
    note = shortened ? `条目全文见约定文件 ${absPath(D.FOLDER_FILES.agreement)}` : null;
  }
  const tail: string[] = [];
  // 受阻原因是「执行者」时分两种：执行者自己做不下去（resumeTo 不是核对中），或核对人两次被叫醒都没有提交结论（resumeTo 是核对中）。
  // 写的是谁停住、为什么停住，与受阻说明一致（P74r2a）。
  const blockedByExecutorKind = job.state === 'blocked' && job.blocked?.kind === 'executor';
  const reviewerStalled = blockedByExecutorKind && reviewStalled(job);
  const executorStuck = blockedByExecutorKind && !reviewerStalled;
  if (reviewerStalled) {
    tail.push(reviewerStallLine(ctx, job, wakeEvents));
    tail.push(swapReviewerHint(job));
    tail.push(staffLine(ctx));
  }
  if (executorStuck) {
    const blockedEvent = [...wakeEvents, ...eventsOf(ctx, job.id)].reverse().find(row => row.kind === 'executor_blocked');
    const tried = Array.isArray(blockedEvent?.data.tried) ? (blockedEvent!.data.tried as unknown[]).filter((item): item is string => typeof item === 'string') : [];
    if (centerEndedBlock(ctx, job, wakeEvents)) {
      // P74r15：回合被中心结束：说明本身就是事实句（写明是谁的回合），不写「做不下去」（那是员工自己说做不下去时的说法）。
      tail.push(closeSentence(job.blocked!.text));
    } else {
      // 说明自己以句号结尾时不再接句号；后面还有「试过」时先去掉说明末尾的标点。
      const reasonText = tried.length > 0 ? job.blocked!.text.replace(/[。.！!？?\s]+$/u, '') : job.blocked!.text;
      tail.push(closeSentence(`${executor}做不下去：${reasonText}${tried.length > 0 ? `；试过：${tried.join('；')}` : ''}`));
    }
  }
  // P74r16c：参与者被停用而受阻：写明事实和能怎么做（原来这几行只在没有编号的一览里）。
  if (job.state === 'blocked' && job.blocked?.kind === 'participant_off') tail.push(...participantOffLines(ctx, job));
  if (job.state === 'blocked' && job.blocked?.kind === 'review_limit') tail.push(`${reviewLimitLines(ctx, job)}。`);
  // P74f-2：主人已经选过办法、这件事仍受阻（选的是不带改动的办法）：写明主人选了什么，总管照它处理。
  const choice = chosenOptionNote(ctx, job);
  if (choice !== null) tail.push(choice);
  // P74r4a：上一次给主人的办法因为约定更新已失效：写明，让总管按现在的约定重新判断（写说明的做法在下面，escalatedThisBlock 此时为假）。
  const expired = job.escalation;
  const expiredText = expired == null ? null : expiredWakeText(expired.invalid);
  if (job.state === 'blocked' && expired != null && expiredText !== null && expired.chosen === null
    && (expired.blockedSince === undefined || job.blocked === null || expired.blockedSince === job.blocked.since)) tail.push(expiredText);
  if (job.openAsk !== null) tail.push(`${nameOf(ctx, job.openAsk.fromId, '执行者')}问你：${askTextOf(ctx, job)}`);
  // P74r2b：这一问已经转成约定的新版本在等主人确认：不用也不能再回答（answer 会被拒）；主人确认后中心回答，主人不同意由总管撤销后再回答。
  const askLinked = job.openAsk !== null && job.openAsk.agreementNo != null;
  if (askLinked) tail.push(`这个问题已经转成约定第 ${job.openAsk!.agreementNo} 版，在等主人确认；主人确认后中心会回答，现在不用回答。`);
  // P74e（任务卡 3 节）：有人在等回答（有未回答的提问，或执行者做不下去）时，写明怎样回答；序号用上面列出的各部分编号。
  if ((job.openAsk !== null && !askLinked) || executorStuck) {
    const who = job.openAsk !== null ? nameOf(ctx, job.openAsk.fromId, '执行者') : executor;
    // P74r2d：主人转来的材料也能当出处，列出现有的标题；「一句话」不能作为唯一出处。
    const materialHint = materials.length === 0 ? '' : `主人转来的材料也能当出处：section 写 material，title 写材料标题，现有：${materials.map(title => `「${title}」`).join('、')}。`;
    tail.push(`回答：调用 hub_job_manage，mode 写 answer，jobId 写 ${job.id}，to 写${who}，text 写答案，basis 写出处（section 和 no，见上方序号）。${materialHint}约定推不出答案时不要用 answer，按守则第 11 条处理。`);
  }
  // 执行者做不下去时，除了回答，还可以换一位执行者（执行链回合里也能用）。
  if (executorStuck) {
    tail.push(swapExecutorHint(job));
    tail.push(staffLine(ctx));
  }
  // P74f-2：核对三轮仍不过、或执行者做不下去而总管解决不了：写说明交给主人。这是做法说明，压缩时任何一级都不删（在 tail 里）。
  if (canEscalate(job, reviewerStalled)) tail.push(escalateHint(job));
  // P76f：主人在预计消耗条目里选了「缩小范围」、新版本还没出：写明哪些条目还没通过、怎样提交新版本（做法说明，压缩时不删）。
  const narrow = narrowParagraph(ctx, job);
  if (narrow !== null) tail.push(narrow.join('\n'));
  // P88：这一段只写了这一件事，别的事的状态不要凭记忆说（固定的话，压缩时不删）。
  tail.push(CHAIN_ONLY_THIS_LINE);
  return { head: rows, flex, note, tail };
}

/** 这件事现在能不能用 escalate：受阻、原因是三轮不过或执行者做不下去（不是核对人没动静），这一阶段还没有说明过。 */
function canEscalate(job: Job, reviewerStalled: boolean): boolean {
  return job.state === 'blocked' && !reviewerStalled && (job.blocked?.kind === 'review_limit' || job.blocked?.kind === 'executor')
    && !escalatedThisBlock(job);
}

/** 写说明的做法（任务卡第 12 节逐字）：只写现在真能做成的。 */
function escalateHint(job: Job): string {
  return `写说明：调用 hub_job_manage，mode 写 escalate，jobId 写 ${job.id}，stuckAt 用白话写卡在哪（不写技术名词），options 写 2 到 3 个办法（title、detail 写做法和代价；选了就改某条「怎样算做完」的，写 change：no 和改后的 text，删去写 null；改约定之外还要你做后续安排的，followUp 写 true），suggested 写建议第几个（从 0 起），reason 写建议的理由。能帮执行者解决的，用 mode answer 回答，不用交给主人。`;
}

/** 主人选了不带改动的办法之后，这件事仍然受阻：告诉总管主人选了什么，照它处理；没有这回事返回 null。 */
function chosenOptionNote(ctx: HubContext, job: Job): string | null {
  const escalation = job.escalation;
  if (escalation == null || escalation.chosen === null || !escalatedThisBlock(job) || job.state !== 'blocked') return null;
  const option = escalation.options[escalation.chosen];
  if (option === undefined) return null;
  // P74r6：三条路——换执行者、只换核对人（仅三轮不过）、不换人接着做（resume）；三轮不过时换人或接着做之后核对从新的三轮算起；
  // 主人选的办法是整件事不再做时，出一版写明不再做的约定请主人确认。
  const reviewLimit = job.blocked?.kind === 'review_limit';
  const resumeHint = `不换人、照办法接着做：调用 hub_job_manage，mode 写 resume，jobId 写 ${job.id}。`;
  const hints = [swapExecutorHint(job), ...(reviewLimit ? [swapReviewerHint(job)] : []), resumeHint, staffLine(ctx)];
  const fresh = reviewLimit ? '换人或接着做之后，核对从新的三轮算起。' : '';
  const stops = '主人选的办法是整件事不再做时，用 hub_agreement_submit 出一版写明不再做（stopsJob 写 true）请主人确认。';
  return `主人为这件事选了办法「${option.title}」：${option.detail}。请照这个办法处理（${hints.join('')}）${fresh}${stops}`;
}

/**
 * P76g：主人在「没有进展」条目上选了「换{名字}接手」、总管还没有改派时，写明要换的人和做法（只用这一段文字就能做成）。
 * 要换的是谁：这件事此刻在等的人（执行者或核对人）；已经改派过（之后有 reassigned 事件）就不再写。没有返回 null。
 */
function takeOverNote(ctx: HubContext, job: Job): string | null {
  const events = eventsOf(ctx, job.id);
  const choice = [...events].reverse().find(row => row.kind === 'resumed' && typeof row.data.takeOver === 'string');
  if (choice === undefined || events.some(row => row.kind === 'reassigned' && row.at >= choice.at)) return null;
  const reviewer = job.reviewerId !== null && expectedActorOf(job) === job.reviewerId;
  return `主人在「没有进展」那一条上选了「换${String(choice.data.takeOver)}接手」，要换的是${reviewer ? '核对人' : '执行者'}：${reviewer ? swapReviewerHint(job) : swapExecutorHint(job)}`;
}

/** P88：一览里固定的两句话。没有在办的事时写第一句；第二句任何时候都写（提到别的事的状态以这一段为准）。 */
export const OVERVIEW_NONE_LINE = '现在没有已经派出、还没有收尾的事。';
// 说「已经派出的事」而不是「在办的事」：同一个唤醒包的「你手上的约定」一段里，待确认、正要派活的约定界面上也算在办，这里不能与它冲突。
export const OVERVIEW_RULE_LINE = '提到一件已经派出的事的状态时，只按这一段列出的写；这一段没有列出的事，不要说它正在进行或正在返工。约定的状态见「你手上的约定」。';
/** P88：带 jobId 的总管唤醒包只写这一件事，段末写明别的事不要凭记忆说（做法说明，压缩时不删，在 tail 里）。 */
export const CHAIN_ONLY_THIS_LINE = '这里只写了这一件事；提到别的事的状态时，不要凭记忆说它正在进行或正在返工。';

/**
 * P88：这位总管名下最近收尾的事（已验收完成或已停止，收尾时间在最近 RECENT_CLOSED_DAYS 天内），
 * 按收尾时间从近到远，最多 RECENT_CLOSED_MAX 件；每件一行，日期按设置里的时区。没有就返回空数组。
 * 收尾时间：已完成取验收时间（缺失时取记录更新时间），已停止取停止时间（同理）。
 */
function recentClosedLines(ctx: HubContext, chiefId: string): string[] {
  // P88r1：取数口径放在 job/recent-closed.ts，与完成声明核对共用。
  const rows = recentClosedJobs(ctx, chiefId, ['done', 'stopped'], D.RECENT_CLOSED_MAX);
  return rows.map(({ job, at }) => {
    const title = ctx.store.table('agreements').get(job.agreementId)?.title ?? '这件事';
    const parts = localParts(at, ctx.settings.timezone);
    return `「${title}」${job.state === 'done' ? '已验收完成' : '已停止'}（${parts.month}月${parts.day}日）`;
  });
}

/**
 * 没有 jobId 的总管唤醒：「你手上的事」一览——在办的事（最多 5 件，每件一行）、最近收尾的事（P88）、一句固定的话。
 * P88：没有在办的事时这一段也出现（写「现在没有在办的事。」），模型才有「现在什么都没在做」的事实；
 * 放不下 maxBytes 时先整块删掉「最近收尾的事」，再截短在办的事的部分；「现在没有在办的事。」和固定那一句任何时候都在。
 * 返回正文和是否删过最近收尾的事或截短过（给压缩级别用）。
 */
export function chiefOverviewDetailed(ctx: HubContext, chiefId: string, maxBytes: number = D.PACKET_MAX_BYTES): { text: string; compressed: boolean } {
  const active = activeOverviewText(ctx, chiefId);
  const recent = recentClosedLines(ctx, chiefId);
  const compose = (withRecent: boolean, activeText: string): string =>
    [activeText, ...(withRecent && recent.length > 0 ? ['最近收尾的事：', ...recent] : []), OVERVIEW_RULE_LINE].join('\n');
  const full = compose(true, active);
  if (byteLength(full) <= maxBytes) return { text: full, compressed: false };
  // 第一步：整块删掉最近收尾的事。
  const withoutRecent = compose(false, active);
  if (byteLength(withoutRecent) <= maxBytes) return { text: withoutRecent, compressed: true };
  // 第二步：仍放不下（在办的事太多太长），只截短在办的事的部分，固定那一句留在末尾。
  const room = maxBytes - byteLength(`\n${OVERVIEW_RULE_LINE}`);
  return { text: `${truncateBytes(active, Math.max(room, 0))}\n${OVERVIEW_RULE_LINE}`, compressed: true };
}

/** 没有 jobId 的总管唤醒：「你手上的事」一览的正文（见 chiefOverviewDetailed）。 */
export function chiefOverviewBody(ctx: HubContext, chiefId: string, maxBytes: number = D.PACKET_MAX_BYTES): string {
  return chiefOverviewDetailed(ctx, chiefId, maxBytes).text;
}

/** 一览里在办的事的部分，最多 5 件，每件一行（写法与 P88 之前逐字相同）；没有在办的事写「现在没有在办的事。」。 */
function activeOverviewText(ctx: HubContext, chiefId: string): string {
  const names: Record<string, string> = {};
  for (const bot of ctx.store.table('bots').list()) names[bot.id] = bot.name;
  const jobs = ctx.store.table('jobs').list(job => job.chiefId === chiefId && job.state !== 'done' && job.state !== 'stopped')
    .sort((a, b) => a.createdAt - b.createdAt);
  if (jobs.length === 0) return OVERVIEW_NONE_LINE;
  const lines = jobs.slice(0, OVERVIEW_MAX).map(job => {
    const title = ctx.store.table('agreements').get(job.agreementId)?.title ?? '这件事';
    // P74r17（低-4）：传入与主题进度行同样的不在岗名单，参与者停用而受阻的事写「{名字}（已停用）」，不写「在等总管」。
    const { offDuty, retired } = offDutyOfJob(ctx, job);
    const waiting = waitingOnOf(job, names, offDuty, retired);
    const choice = chosenOptionNote(ctx, job);
    const takeOver = takeOverNote(ctx, job);
    return `「${title}」（jobId 为 ${job.id}）${JOB_STATE_LABELS[job.state]}${waiting === null ? '' : `，在等${waiting}`}\n  ${costLineFor(ctx, job)}${stuckNote(ctx, job)}${acceptNote(ctx, job, title)}${choice === null ? '' : `\n  ${choice}`}${takeOver === null ? '' : `\n  ${takeOver}`}`;
  });
  const more = jobs.length > OVERVIEW_MAX ? `\n另有 ${jobs.length - OVERVIEW_MAX} 件没有列出。` : '';
  // 有事因为换人才能继续时（含主人选了「换{名字}接手」），列出在岗的员工，总管只用这一段文字就能写对名字。
  const needSwap = jobs.slice(0, OVERVIEW_MAX).some(job => swapNeeded(ctx, job) !== null || takeOverNote(ctx, job) !== null);
  return `${lines.join('\n')}${more}${needSwap ? `\n${staffLine(ctx)}` : ''}`;
}

/** 这件事是不是因为某位员工停用或没有动静而需要换人；需要时返回要换的是执行者、核对人还是两位。 */
function swapNeeded(ctx: HubContext, job: Job): { executor: boolean; reviewer: boolean; offNames: string[] } | null {
  if (job.state !== 'blocked' || job.blocked === null) return null;
  const off = (id: string | null): boolean => id !== null && !isOnDutyNow(ctx, id);
  if (job.blocked.kind === 'participant_off') {
    const executor = off(job.executorId);
    const reviewer = off(job.reviewerId);
    if (!executor && !reviewer) return null;
    const offNames = [...(executor ? [nameOf(ctx, job.executorId, '执行者')] : []), ...(reviewer ? [nameOf(ctx, job.reviewerId, '核对人')] : [])];
    return { executor, reviewer, offNames };
  }
  if (reviewStalled(job)) {
    return { executor: false, reviewer: true, offNames: [] };
  }
  return null;
}

/** 一览里这件事的补充说明：停住的原因和怎样换人（只写现在真能做成的做法）。 */
function stuckNote(ctx: HubContext, job: Job): string {
  const swap = swapNeeded(ctx, job);
  if (swap === null) return '';
  if (swap.offNames.length === 0) {
    // 核对人两次被叫醒都没有提交结论。
    return `\n  ${reviewerStallLine(ctx, job, [])}${swapReviewerHint(job)}`;
  }
  return `\n  ${swap.offNames.join('、')}已停用，这件事暂时没法往下做。${swapParticipantHint(job, swap)}`;
}

/** 参与者停用时的换人做法（一览和带编号的唤醒包共用同一段，P74r16c 第 1 节）。 */
function swapParticipantHint(job: Job, swap: { executor: boolean; reviewer: boolean }): string {
  const fields = swap.executor && swap.reviewer
    ? 'executor 写新执行者的名字、reviewer 写新核对人的名字（写「总管」表示由你自己核对），每次可以只换一位，两位都要换'
    : swap.executor ? 'executor 写新执行者的名字' : 'reviewer 写新核对人的名字（写「总管」表示由你自己核对）';
  return `换人：调用 hub_job_manage，mode 写 reassign，jobId 写 ${job.id}，${fields}。`;
}

/**
 * 带这件事编号的唤醒包里，参与者被停用而受阻时写的几行（P74r16c 第 1 节）：
 * 事实一行（谁被停用、原因、停在哪一步）、换人的做法加在岗员工名单（与一览同一段）、
 * 向主人说明的提示加「主人恢复之后这件事自己接着做」。这件事这一次受阻已经说明过时不再提示说明。
 * 手动停用的员工（不是中心停用）没有「原因」，事实一行改写成不带原因的说法。
 */
function participantOffLines(ctx: HubContext, job: Job): string[] {
  const swap = swapNeeded(ctx, job);
  if (swap === null || swap.offNames.length === 0) return [];
  const step = stuckStepName(ctx, job);
  const offBots = [job.executorId, job.reviewerId].flatMap(id => (id !== null && !isOnDutyNow(ctx, id) ? [ctx.store.table('bots').get(id)] : []))
    .filter((bot): bot is NonNullable<typeof bot> => bot !== null);
  const facts = offBots.map(bot => (bot.lifecycle === 'quarantined' && bot.quarantineReason !== null
    ? suspendedFactLine(bot.name, bot.quarantineReason, step) : `${bot.name}已停用，这件事停在${step}。`));
  const lines = [...facts, swapParticipantHint(job, swap), staffLine(ctx)];
  if (!escalatedThisBlock(job)) {
    lines.push(`也可以向主人说明现状、给出几个办法（mode 写 escalate）。主人恢复${swap.offNames.join('、')}在岗之后，这件事会自己接着做，不需要你再安排。`);
  }
  return lines;
}

/**
 * 在等主人验收的事，多写两行（P74f）：交付卡上的条目（序号加原文前 30 字，总管填 reopen 的序号只用这里的文字），
 * 以及主人指出不符时怎么做（reopen 的写法；不在约定里的新要求不算验收不符，按守则第 7 条处理）。
 * 这两行属于做法说明，压缩时任何一级都不删（它们在一览里，不在 job-section-fit 的可压缩部分）。
 */
function acceptNote(ctx: HubContext, job: Job, _title: string): string {
  if (job.state !== 'awaiting_owner') return '';
  const agreement = ctx.store.table('agreements').get(job.agreementId);
  const items = agreement === null ? [] : lockedVersionOf(agreement).content.doneWhen.map((text, index) => `${index + 1}. ${clipWithEllipsis(text, 30).text}`);
  return `\n  这件事在等主人验收，交付卡条目：${items.join('；')}。`
    + `\n  主人指出某条不符时，用 hub_job_manage 的 mode reopen（jobId 写 ${job.id}，items 写 no、problem、fixTo，missed 写核对为什么漏了、这次怎么补）；主人说的问题不在约定里，是新要求，按守则第 7 条处理，不算验收不符。`;
}

/** 其他员工（没有 jobId 的唤醒）：有在办的事就写一行。activeJobsOf 把核对人也算在内，这里只取这位员工是执行者或核对人的事。 */
export function staffOverviewLine(ctx: HubContext, botId: string): string {
  const job = activeJobsOf(ctx, botId).find(row => row.chiefId !== botId);
  if (job === undefined) return '';
  const title = ctx.store.table('agreements').get(job.agreementId)?.title ?? '这件事';
  return `你正在做「${title}」（jobId 为 ${job.id}），关于这件事的往来用 hub_job_work。`;
}

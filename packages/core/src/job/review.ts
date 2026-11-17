/**
 * 核对（P74d，方案 5.3.2）：核对人对照最新一次交回逐条给结论，结果由中心按规则决定，不由模型决定。
 *
 * 规则：
 * - 调用者是这件事的核对人（没有核对人时只能是总管），不能是执行者；这件事处于「核对中」；对象是最新一次交回；
 * - 交回里不是「沿用」的条目必须逐条给结论；沿用的条目可以不写（记为沿用，沿用上一次核对对它的结论），也可以写（推翻沿用）；
 * - 不符（unmet）必须同时写 note（问题是什么）和 fixTo（改到什么程度算过，写成可以验证的一句话）；
 * - at_delivery 只能用在 deliveryItems 的条目上，deliveryItems 的条目也只能写 at_delivery；
 * - spotChecked 抽查的必须是仍然沿用的条目；carriedNote 只在有沿用条目时允许。
 * 全部校验在写入之前，问题一次列全。
 *
 * 三种结果（轮次由中心计数，不靠模型自报）：
 * | 没有不符 | 转「待你验收」；不叫醒任何人；工作往来落核对卡和一句「核对通过」，交付由 onReviewPassed 接（P74f） |
 * | 有不符且不到第 3 轮 | 转「返工中」，不符的条目写进这件事，叫醒执行者 |
 * | 有不符且已是第 3 轮 | 转「受阻」（三轮不过），叫醒总管写说明 |
 * 和交回一样分三段，返回成功时后续的唤醒已经就位（通过时没有唤醒，后续是 onReviewPassed）。
 */
import { JOB_DEFAULTS as D } from '../config/defaults.js';
import { paramNameProblem } from './owner-text.js';
import type { HubContext } from '../engine/context.js';
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import { reviewCardTitle } from '../api/job-card-views.js';
import { parseWithPaths } from '../model/agreement.js';
import { JobReviewSchema, type Job, type JobReview, type JobSubmission, type JobUnmet } from '../model/job.js';
import { writeOutreachAudit } from '../outreach/audit.js';
import { postThread } from '../outreach/thread.js';
import type { ToolContext } from '../tools/types.js';
import { newId } from '../util/ids.js';
import { jobTitleOf } from './chain.js';
import { latestEstimate } from './estimate.js';
import { isCenterRemapped } from './item-remap.js';
import { applyJobAction } from './state.js';
import { appendJobEvent, latestSubmission, putJob } from './store.js';
import { blockForTurnCap } from './cap.js';
import { deliverJob } from './deliver.js';
import { noticeOf } from './notices.js';
import { hasOpenStallItem, withdrawStallItems } from './stall.js';
import { assertJobOpen, locateJob, queueWakeUnlessCapped, runUndo, softly, stateRefusal, type UndoSteps } from './work-common.js';

/** 核对人传入的一条结论。 */
export interface ReviewItemArg {
  no: number;
  verdict?: 'met' | 'unmet' | 'at_delivery' | undefined;
  note?: string | undefined;
  fixTo?: string | undefined;
  rechecked?: boolean | undefined;
}

/** hub_job_work review 解析后的参数。 */
export interface ReviewArgs {
  jobId: string;
  items?: ReviewItemArg[] | undefined;
  carriedNote?: string | undefined;
  spotChecked?: number[] | undefined;
}

/** 校验通过后可以写入的核对结论。 */
interface ReviewPlan {
  items: JobReview['items'];
  carriedNote: string | null;
  spotChecked: number[];
  unmet: JobUnmet[];
}

/** 校验一次核对并整理出结论；问题一次列全，一条都不写。 */
function planReview(job: Job, submission: JobSubmission, args: ReviewArgs): ReviewPlan {
  if (args.items === undefined) throw new Error('缺少必填项：items（mode 为 review 时要填写，逐条写 no、verdict、note、fixTo）');
  const errors: string[] = [];
  const byNo = new Map(submission.items.map(item => [item.no, item]));
  const given = new Map<number, ReviewItemArg>();
  for (const item of [...args.items].sort((a, b) => a.no - b.no)) {
    const prefix = `第 ${item.no} 条：`;
    const own = byNo.get(item.no);
    if (own === undefined) {
      // P74r2c：这次交回是中心按新编号重排的（约定删去了条目）：核对人按旧序号、旧条数给结论时，说明条目已重新编号，只写一次。
      const text = isCenterRemapped(submission)
        ? `约定已更新为第 ${submission.versionNo} 版，条目已重新编号，现在共 ${submission.items.length} 条，请按唤醒包里的新清单给结论。`
        : `${prefix}这次交回里没有这一条（交回里有第 ${[...byNo.keys()].join('、')} 条）`;
      if (!errors.includes(text)) errors.push(text);
      continue;
    }
    if (given.has(item.no)) { errors.push(`${prefix}写了多次，每一条只能写一次`); continue; }
    given.set(item.no, item);
    const isDelivery = job.deliveryItems.includes(item.no);
    const note = item.note?.trim() === '' ? undefined : item.note?.trim();
    const fixTo = item.fixTo?.trim() === '' ? undefined : item.fixTo?.trim();
    // P74r14：每一条的说明、改到什么程度会显示给主人，不带参数名。
    for (const [name, text] of [['note', note], ['fixTo', fixTo]] as const) {
      const problem = text === undefined ? null : paramNameProblem(`${prefix}${name}`, text);
      if (problem !== null) errors.push(problem);
    }
    if (item.verdict === undefined) { errors.push(`${prefix}缺少 verdict（met、unmet 或 at_delivery）`); continue; }
    if (isDelivery && item.verdict !== 'at_delivery') errors.push(`${prefix}这一条在交付时核对，verdict 只能写 at_delivery`);
    if (!isDelivery && item.verdict === 'at_delivery') errors.push(`${prefix}这一条不是交付时核对的条目，verdict 不能写 at_delivery，请写 met 或 unmet`);
    if (item.verdict === 'unmet') {
      if (note === undefined) errors.push(`${prefix}不符必须用 note 写明问题是什么`);
      if (fixTo === undefined) errors.push(`${prefix}不符必须用 fixTo 写明改到什么程度算过（写成一句可以验证的话）`);
    } else if (fixTo !== undefined) {
      errors.push(`${prefix}只有不符的条目才写 fixTo`);
    }
  }
  // 不是沿用的条目必须逐条给结论。
  // P74f-2：主人选了办法、这件事回到核对中之后（recheckNos），只需要给记下的那几条结论，其余条目按沿用处理（本阶段前面已通过）。
  const only = job.recheckNos;
  for (const item of submission.items) {
    const exempt = only !== undefined && !only.includes(item.no);
    if (item.selfCheck !== 'carried' && !given.has(item.no) && !exempt) errors.push(`第 ${item.no} 条：这一条本轮交回了，必须给出结论（met、unmet 或 at_delivery）`);
  }
  // 抽查和沿用说明。
  const stillCarried = (no: number): boolean => byNo.get(no)?.selfCheck === 'carried' && !given.has(no);
  const hasCarried = submission.items.some(item => item.selfCheck === 'carried');
  const spot = args.spotChecked ?? [];
  for (const no of spot) {
    if (!stillCarried(no)) errors.push(`第 ${no} 条：spotChecked 只能写仍然沿用上一轮结论的条目（本轮交回里没有沿用它，或你已经给它写了结论）`);
  }
  if (new Set(spot).size !== spot.length) errors.push('spotChecked：序号不能重复');
  const carriedNote = args.carriedNote?.trim() === '' ? undefined : args.carriedNote?.trim();
  if (carriedNote !== undefined && !hasCarried) errors.push('carriedNote：这次交回没有沿用的条目，不需要写沿用说明');
  const carriedProblem = carriedNote === undefined ? null : paramNameProblem('carriedNote', carriedNote);
  if (carriedProblem !== null) errors.push(carriedProblem);
  if (errors.length > 0) throw new Error(`核对结论被拒，没有写入任何东西。需要改的地方：\n${errors.join('\n')}`);

  // 整理：交回里的每一条都有一行；没写的沿用条目记为 carried。
  const items: JobReview['items'] = [...submission.items].sort((a, b) => a.no - b.no).map(own => {
    const row = given.get(own.no);
    if (row === undefined) return { no: own.no, verdict: 'carried' as const, note: null, fixTo: null, rechecked: false };
    return { no: own.no, verdict: row.verdict!, note: row.note?.trim() || null, fixTo: row.verdict === 'unmet' ? row.fixTo!.trim() : null, rechecked: row.rechecked === true };
  });
  const unmet: JobUnmet[] = items.filter(row => row.verdict === 'unmet').map(row => ({ no: row.no, problem: row.note!, fixTo: row.fixTo! }));
  return { items, carriedNote: carriedNote ?? null, spotChecked: [...spot].sort((a, b) => a - b), unmet };
}

/**
 * 核对通过之后的后续：交付（P74f）。放在单独的函数里，让交付不用改核对本身。出错只记日志。
 */
export function onReviewPassed(ctx: HubContext, job: Job): void {
  // P74f：交给 deliverJob（job/deliver.ts）：主题里一句话加交付卡、总管私聊一句、「待你处理」一条验收条目。
  // 出错只记日志，每个 tick 的巡检会补齐缺的部分。
  softly(ctx, '交付', () => { deliverJob(ctx, job); });
}

/** 核对：返回给模型看的一句话。 */
export async function runJobReview(ctx: HubContext, tc: ToolContext, args: ReviewArgs): Promise<string> {
  const { bot, job } = locateJob(ctx, tc, args.jobId);
  assertJobOpen(job, '提交核对结论');
  if (bot.id === job.executorId) throw new Error('核对人不能是执行者本人，只有这件事的核对人能提交核对结论');
  const isReviewer = job.reviewerId === null ? bot.id === job.chiefId : bot.id === job.reviewerId;
  if (!isReviewer) {
    const who = job.reviewerId === null ? '总管' : ctx.store.table('bots').get(job.reviewerId)?.name ?? '核对人';
    throw new Error(`只有这件事的核对人（${who}）能提交核对结论`);
  }
  const allowed: Job['state'][] = ['checking'];
  if (!allowed.includes(job.state)) throw stateRefusal(job, '提交核对结论', allowed);
  // 只挡提问人自己的核对结论（P74r2a）：核对人自己问了问题，要等回答；别人的提问不影响他。
  if (job.openAsk !== null && job.openAsk.fromId === bot.id) throw new Error('还有一个问题在等总管回答，回答之后再提交核对结论');
  // P74e（B2）：约定正在等主人确认（执行中的事重新确认）时，核对要等确认之后：通过会让主人面前同时有两个入口。
  const agreement = ctx.store.table('agreements').get(job.agreementId);
  if (agreement?.state === 'pending') {
    throw new Error(`约定第 ${job.pause?.versionNo ?? agreement.versions[agreement.versions.length - 1]!.no} 版还在等主人确认，核对要等确认之后（确认后按新版本核对）。`);
  }
  const submission = latestSubmission(ctx, job.id);
  if (submission === null) throw new Error('这件事还没有交回记录，没有可核对的内容');
  const plan = planReview(job, submission, args);

  const now = ctx.clock.now();
  const review = parseWithPaths(JobReviewSchema, {
    id: newId('jrv', ctx.rng), jobId: job.id, stage: submission.stage, round: submission.round, submissionId: submission.id, reviewerId: bot.id,
    items: plan.items, carriedNote: plan.carriedNote, spotChecked: plan.spotChecked, createdAt: now,
  }, '核对结论');
  // 结果由中心按规则决定：没有不符 -> 通过；不符且不到第 3 轮 -> 退回；第 3 轮仍有不符 -> 三轮不过。
  const result: 'pass' | 'fail' | 'limit' = plan.unmet.length === 0 ? 'pass' : job.round < D.REVIEW_ROUNDS_MAX ? 'fail' : 'limit';
  const applied = result === 'pass' ? applyJobAction(job, { type: 'review_pass' }, now)
    : result === 'fail' ? applyJobAction(job, { type: 'review_fail', unmet: plan.unmet }, now)
      : applyJobAction(job, { type: 'review_limit', no: plan.unmet[0]!.no, text: plan.unmet[0]!.problem }, now);
  // P74r2a（G9）：总管自己核对却一直没动、中心给主人放过「停住了」条目；现在总管提交了核对结论，条目随之撤回，
  // 这件事的条目编号清空（之后验收、三轮不过等条目由 P74f 接手）。撤回条目是主人看得见的动作，放在状态写成功之后。
  // P84（K1）：只撤回停摆、空转、「回合被结束」三种；逾期条目留着，条目编号也不清（逾期时这件事本来就在照常往下做，
  // 核对不通过不等于交付时间的问题解决了；核对通过时由验收条目取代，那是现有逻辑）。
  const stallOpen = hasOpenStallItem(ctx, job) && noticeOf(ctx, job.id).stallKind !== 'overdue';
  // P74f-2：这次核对做完，「只需给记下那几条结论」的记号随之清掉。
  const { recheckNos: _done, ...appliedRest } = applied;
  const next: Job = stallOpen ? { ...appliedRest, inboxId: null } : appliedRest;
  const eventId = newId('jev', ctx.rng);
  const title = jobTitleOf(ctx, job);
  const executorName = ctx.store.table('bots').get(job.executorId)?.name ?? '执行者';
  const nos = plan.unmet.map(item => item.no).join('、');
  const target = result === 'fail' ? job.executorId : job.chiefId;

  // 第二段：写状态，有备份。
  const undo: UndoSteps = [];
  // P74e 修正：退回、三轮不过需要叫醒下一个人；叫不醒的原因恰好是「回合用到上限」时，照常记录核对结论，
  // 不排唤醒，由回合上限的处理接手（见下面第三段）。其他原因叫不醒仍然整体恢复并拒绝。
  let capped = false;
  try {
    ctx.store.table('jobReviews').put(review);
    undo.push(() => { ctx.store.table('jobReviews').remove(review.id); });
    putJob(ctx, next);
    undo.push(() => { putJob(ctx, job); });
    if (result === 'fail') {
      capped = queueWakeUnlessCapped(ctx, { job: next, botId: job.executorId, why: 'returned', eventId,
        summary: `「${title}」第 ${review.round} 轮核对没有通过，请只改第 ${nos} 条` }, undo, executorName) === null;
    } else if (result === 'limit') {
      capped = queueWakeUnlessCapped(ctx, { job: next, botId: job.chiefId, why: 'escalate', eventId,
        summary: `「${title}」第 ${plan.unmet[0]!.no} 条核对三轮仍未通过，请向主人说明` }, undo, '总管') === null;
    }
    appendJobEvent(ctx, { id: eventId, jobId: job.id, actor: bot.id, kind: 'reviewed', to: [target], refId: review.id,
      data: { stage: review.stage, round: review.round, result, unmet: plan.unmet.map(item => item.no) } });
  } catch (error) {
    await runUndo(ctx, undo, '核对', job.id);
    throw new Error(`核对结论没有记下，已恢复到核对前的状态：${error instanceof Error ? error.message : String(error)}`);
  }
  writeOutreachAudit(ctx, 'job_review', { jobId: job.id, round: review.round, result, reviewId: review.id }, bot.id, now);
  ctx.emit(HUB_EVENT_SCOPES.project, null);
  ctx.emit(HUB_EVENT_SCOPES.bot, target);

  // 第三段：核对卡和中心提示。
  // P76r3（R10 第 1 点）：答复栏不写死「总管」——P76g 起核对人是员工的事也会有「没有进展」条目，写不带主语的那一句。
  if (stallOpen) softly(ctx, '撤回「停住了」条目', () => { withdrawStallItems(ctx, job.id, now, '核对结论已提交'); });
  softly(ctx, '工作往来里的核对卡', () => {
    postThread(ctx, { thread: job.topicId, from: bot.id, kind: 'job_card', refId: `review:${review.id}`,
      text: reviewCardTitle(review.round, result === 'pass', result === 'pass' ? review.items.length : plan.unmet.length) });
  });
  if (result === 'pass') {
    onReviewPassed(ctx, next);
    return '核对通过，中心会交给主人验收。';
  }
  // 回合用到上限时没有叫醒下一个人：提示和返回文字都按事实写，不说「已退回，请返工」「总管会告诉你」。
  // P76r3（R10 第 2 点）：有预计的事统一写「已用到预计消耗」；没有预计的旧事保留「回合用到上限」。
  const capText = latestEstimate(ctx, job.agreementId) === null ? '回合用到上限' : '已用到预计消耗';
  const hint = capped
    ? (result === 'fail'
      ? `第 ${review.round} 轮核对未通过，只改第 ${nos} 条。${capText}，返工要等你决定是否继续。`
      : `第 ${D.REVIEW_ROUNDS_MAX} 轮核对仍未通过。${capText}，总管的说明要等你决定是否继续。`)
    : result === 'fail'
      ? `第 ${review.round} 轮核对未通过，已退回${executorName}，只改第 ${nos} 条。剩余 ${D.REVIEW_ROUNDS_MAX - review.round} 轮。`
      : `第 ${D.REVIEW_ROUNDS_MAX} 轮核对仍未通过，这件事在等总管向你说明停在哪一步。`;
  softly(ctx, '工作往来里的核对提示', () => {
    postThread(ctx, { thread: job.topicId, from: 'hub', kind: 'work', refId: eventId, text: hint });
  });
  if (capped) {
    // 回合上限的处理接手：退回的事转为因回合上限受阻（受阻前是返工中，主人追加回合后叫醒执行者）；
    // 三轮不过的事保持原来的受阻原因，只补上回合上限条目（「现在卡在」写明总管要向主人说明）。
    const stuckText = result === 'fail' ? `等${executorName}返工第 ${nos} 条`
      : `第 ${plan.unmet[0]!.no} 条核对三轮仍未通过，等总管向你说明`;
    softly(ctx, '回合上限的处理', () => { blockForTurnCap(ctx, job.id, now, { stuckText }); });
    return result === 'fail'
      ? `核对结论已记下，第 ${nos} 条不符。这件事${capText === '回合用到上限' ? '的回合用到上限' : '已用到预计消耗'}，返工要等主人决定是否继续。`
      : `核对结论已记下，第 3 轮仍未通过。这件事${capText === '回合用到上限' ? '的回合用到上限' : '已用到预计消耗'}，总管的说明要等主人决定是否继续。`;
  }
  return result === 'fail' ? `已退回${executorName}，只改第 ${nos} 条。` : '第 3 轮仍未通过，已告诉总管。';
}

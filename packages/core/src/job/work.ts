/**
 * 执行者（和核对人）的三个动作（P74d）：提问 ask、交回 submit、说明做不下去 block。
 * 核对 review 在 review.ts。工具外壳是 tools/hub-job-work.ts。
 *
 * 和派活一样分三段（方案 6.4）：
 * 1. 校验，一条都不写；交回的问题一次列全；
 * 2. 写状态（交回记录、状态、给下一个人排的唤醒、事件），有备份，任何一步失败全部恢复，工具返回失败。
 *    所以工具返回「已交回」「已问总管」「已告诉总管」时，下一个人确实入了队、而且闸门不会直接丢弃他的唤醒；
 * 3. 最后才写主人看得见的话（往来里的卡片和提示），出错只记日志，不影响已成功的状态。
 *
 * 谁能调用什么：提问是执行者和核对人（总管自己核对时不用问自己）；交回、说明做不下去只有执行者。
 */
import { JOB_DEFAULTS as D } from '../config/defaults.js';
import type { HubContext } from '../engine/context.js';
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import { submissionCardTitle } from '../api/job-card-views.js';
import { parseWithPaths } from '../model/agreement.js';
import { JobSchema, JobSubmissionSchema, type Job, type JobSubmission } from '../model/job.js';
import { writeOutreachAudit } from '../outreach/audit.js';
import { postThread } from '../outreach/thread.js';
import type { ToolContext } from '../tools/types.js';
import { newId } from '../util/ids.js';
import { closeSentence } from '../util/sentence.js';
import { jobTitleOf } from './chain.js';
import { latestEstimate } from './estimate.js';
import { ownerSafe, paramNameProblem } from './owner-text.js';
import { applyJobAction } from './state.js';
import { voidJobApprovals } from './void-job-approvals.js';
import { appendJobEvent, putJob } from './store.js';
import { planSubmission, type SubmitArgs } from './submit-check.js';
import { blockForTurnCap } from './cap.js';
import { LAUNCH_ASK_REFUSAL_TEXT } from './launch-blocked.js';
import { assertJobOpen, locateJob, queueWake, queueWakeUnlessCapped, runUndo, softly, stateRefusal, type UndoSteps } from './work-common.js';

/** hub_job_work 解析后的参数（review 的部分见 review.ts）。 */
export interface JobWorkArgs extends SubmitArgs {
  mode: 'ask' | 'submit' | 'review' | 'block' | 'launched';
  jobId: string;
  link?: string | undefined;
  text?: string | undefined;
  stuckAt?: string | undefined;
  tried?: string[] | undefined;
}

// ---------------------------------------------------------------------------
// ask
// ---------------------------------------------------------------------------

/** 提问：执行者或核对人问总管一个问题；总管用约定回答（P74e）。 */
export async function runJobAsk(ctx: HubContext, tc: ToolContext, args: JobWorkArgs): Promise<string> {
  const { bot, job } = locateJob(ctx, tc, args.jobId);
  // P74r7：发布准备中的事已完成、不能提问：这一句告诉执行者缺发布条件时该怎么做（交账写 blocked）；别的已完成或已停止的照旧。
  if (job.state === 'done' && job.launch.state === 'preparing') throw new Error(LAUNCH_ASK_REFUSAL_TEXT);
  assertJobOpen(job, '提问');
  // 执行者，或有名有姓的核对人（核对人为空表示总管自己核对，总管不用问自己）。
  if (bot.id !== job.executorId && !(job.reviewerId !== null && bot.id === job.reviewerId)) {
    throw new Error('只有这件事的执行者和核对人能向总管提问');
  }
  if (args.text === undefined) throw new Error('缺少必填项：text（mode 为 ask 时要填写，写你的问题）');
  const allowed: Job['state'][] = ['ready', 'doing', 'rework', 'checking'];
  if (!allowed.includes(job.state)) throw stateRefusal(job, '提问', allowed);
  // P74r2a：执行者在核对中已经交回，在等核对结论，没有什么可问的；允许他问会让核对人的提交被「有提问」挡住。
  if (bot.id === job.executorId && job.state === 'checking') throw new Error('这件事在核对中，等核对结论出来再问。');
  if (job.openAsk !== null) {
    if (job.openAsk.fromId === bot.id) throw new Error('你上一个问题总管还没有回答，先等回答');
    const other = ctx.store.table('bots').get(job.openAsk.fromId)?.name ?? '另一位员工';
    throw new Error(`${other}问总管的问题还没有回答，先等回答，再提问`);
  }
  const text = args.text.trim();
  const now = ctx.clock.now();
  const eventId = newId('jev', ctx.rng);
  // P74r2a：提问原文同时存在这件事的记录上（读取时不再依赖会被裁剪的事件日志）。
  const asked: Job = JobSchema.parse({ ...job, openAsk: { eventId, fromId: bot.id, at: now, text }, updatedAt: now });
  const undo: UndoSteps = [];
  try {
    putJob(ctx, asked);
    undo.push(() => { putJob(ctx, job); });
    queueWake(ctx, { job: asked, botId: job.chiefId, why: 'asked', eventId,
      summary: `${bot.name}在「${jobTitleOf(ctx, job)}」里问了一个问题，请按约定回答` }, undo, '总管');
    appendJobEvent(ctx, { id: eventId, jobId: job.id, actor: bot.id, kind: 'asked', to: [job.chiefId], refId: null, data: { text } });
  } catch (error) {
    await runUndo(ctx, undo, '提问', job.id);
    throw new Error(`提问失败，已恢复到提问前的状态：${error instanceof Error ? error.message : String(error)}`);
  }
  ctx.emit(HUB_EVENT_SCOPES.project, null);
  ctx.emit(HUB_EVENT_SCOPES.bot, job.chiefId);
  softly(ctx, '工作往来里的提问', () => {
    postThread(ctx, { thread: job.topicId, from: bot.id, kind: 'work', refId: eventId, text });
  });
  return '已问总管，等回答。';
}

// ---------------------------------------------------------------------------
// submit
// ---------------------------------------------------------------------------

/**
 * 交回后往来里的中心提示：{执行者}交回第 n 轮，a 条附证据，b 条交付时核对，c 条沿用上一轮；{核对人}正在核对。
 * P76r3（R10 第 2 点）：有预计的事写「已用到预计消耗」，没有预计的旧事保留「回合用到上限」。
 */
export function submittedHint(executor: string, reviewer: string, submission: JobSubmission, capped = false, hasEstimate = true): string {
  // 沿用的条目虽然带着上一次的证据，但这一轮没有新附证据，不算在「附证据」里。
  const attached = submission.items.filter(item => item.selfCheck !== 'carried' && item.evidence.length > 0).length;
  const atDelivery = submission.items.filter(item => item.selfCheck === 'at_delivery').length;
  const carried = submission.items.filter(item => item.selfCheck === 'carried').length;
  const parts = [attached > 0 ? `${attached} 条附证据` : null, atDelivery > 0 ? `${atDelivery} 条交付时核对` : null,
    carried > 0 ? `${carried} 条沿用上一轮` : null].filter((part): part is string => part !== null);
  // 回合用到上限时没有叫醒核对人（P74e 修正）：不能写「正在核对」，如实写核对在等主人决定。
  const tail = capped ? `${hasEstimate ? '已用到预计消耗' : '回合用到上限'}，核对要等你决定是否继续。` : `${reviewer}正在核对。`;
  return `${executor}交回第 ${submission.round} 轮${parts.length === 0 ? '' : `，${parts.join('，')}`}；${tail}`;
}

/** 交回：逐条对应「怎样算做完」，附证据，中心机械检查；成功后叫核对人（没有核对人时叫总管）。 */
export async function runJobSubmit(ctx: HubContext, tc: ToolContext, args: JobWorkArgs): Promise<string> {
  const { bot, job } = locateJob(ctx, tc, args.jobId);
  assertJobOpen(job, '交回');
  if (bot.id !== job.executorId) throw new Error('只有这件事的执行者能交回');
  const allowed: Job['state'][] = ['doing', 'rework'];
  if (!allowed.includes(job.state)) throw stateRefusal(job, '交回', allowed);
  const agreement = ctx.store.table('agreements').get(job.agreementId);
  if (!agreement) throw new Error('这件事的约定找不到了，不能交回');
  if (agreement.state === 'withdrawn') throw new Error('约定已经撤下，不能交回');
  if (agreement.state === 'pending') {
    const pendingNo = agreement.versions[agreement.versions.length - 1]!.no;
    // P74r2b：他的交回因等确认被拒，说明照常在做的部分已经做到头了：记下「执行者在等确认」（这件事此刻在等谁为空，不再续排）。
    // 只在这件事有暂停记录时记；记录失败不能挡住拒绝，只记日志。
    if (job.pause !== null && job.pause.executorWaiting !== true) {
      try { putJob(ctx, JobSchema.parse({ ...job, pause: { ...job.pause, executorWaiting: true }, updatedAt: ctx.clock.now() })); }
      catch (error) { ctx.logger.warn('没有记下执行者在等确认', { jobId: job.id, error: String(error) }); }
    }
    throw new Error(`约定第 ${job.pause?.versionNo ?? pendingNo} 版还在等主人确认，暂停的部分确认后再交回。照常在做的部分做完了就结束这一回合，主人确认后中心会叫你。`);
  }
  // 只挡提问人自己的交回（P74r2a）：别人的提问不影响他；改派时旧执行者的提问已随改派作废，不会留到这里。
  if (job.openAsk !== null && job.openAsk.fromId === bot.id) throw new Error('你的问题总管还没有回答，先等回答，再交回');
  if (job.round >= D.REVIEW_ROUNDS_MAX) throw new Error(`本阶段已经交回 ${job.round} 轮，达到上限 ${D.REVIEW_ROUNDS_MAX} 轮，不能再交回`);

  // 第一段之前的全部校验：问题一次列全，一条都不写。
  const plan = await planSubmission(ctx, job, agreement, args);
  const reviewerId = job.reviewerId ?? job.chiefId;
  const reviewerName = job.reviewerId === null ? '总管' : ctx.store.table('bots').get(job.reviewerId)?.name ?? '核对人';
  const now = ctx.clock.now();
  const submission = parseWithPaths(JobSubmissionSchema, {
    id: newId('jsb', ctx.rng), jobId: job.id, stage: job.stage, round: job.round + 1, executorId: bot.id, versionNo: plan.versionNo,
    changeNote: plan.changeNote, items: plan.items, deliverables: plan.deliverables, preview: plan.preview, createdAt: now,
  }, '交回');
  const next = applyJobAction(job, { type: 'submit' }, now);
  const eventId = newId('jev', ctx.rng);

  // 第二段：写状态，有备份。
  const undo: UndoSteps = [];
  // P74e 修正：叫不醒核对人的原因恰好是「回合用到上限」时，照常记录交回，不排唤醒，由回合上限的处理接手（见下面第三段）。
  let capped = false;
  try {
    ctx.store.table('jobSubmissions').put(submission);
    undo.push(() => { ctx.store.table('jobSubmissions').remove(submission.id); });
    putJob(ctx, next);
    undo.push(() => { putJob(ctx, job); });
    capped =queueWakeUnlessCapped(ctx, { job: next, botId: reviewerId, why: 'to_review', eventId,
      summary: `${bot.name}交回了「${jobTitleOf(ctx, job)}」第 ${submission.round} 轮，请对照约定逐条核对` }, undo, reviewerName) === null;
    appendJobEvent(ctx, { id: eventId, jobId: job.id, actor: bot.id, kind: 'submitted', to: [reviewerId], refId: submission.id,
      data: { stage: job.stage, round: submission.round, versionNo: submission.versionNo } });
  } catch (error) {
    await runUndo(ctx, undo, '交回', job.id);
    throw new Error(`交回失败，已恢复到交回前的状态（不占轮次）：${error instanceof Error ? error.message : String(error)}`);
  }
  writeOutreachAudit(ctx, 'job_submit', { jobId: job.id, round: submission.round, submissionId: submission.id }, bot.id, now);
  // P76r3（R10 第 2 点）：有预计的事在提示与返回文字里写「已用到预计消耗」。
  const hasEstimate = latestEstimate(ctx, job.agreementId) !== null;
  ctx.emit(HUB_EVENT_SCOPES.project, null);
  ctx.emit(HUB_EVENT_SCOPES.bot, reviewerId);
  // P74r18a：执行者交回了，他为这件事提交、还没有用掉的审批（自测时引出的）不再需要，由中心作废：
  // 待审批的、已批准没用掉的都作废；发布那一张不动；只作废执行者自己提交的。出错只记日志，不影响交回。
  softly(ctx, '作废执行者为这件事提交的审批', () => { voidJobApprovals(ctx, next, 'delivered', now, bot.id); });

  // 第三段：往来里的交回卡和中心提示。
  softly(ctx, '工作往来里的交回卡', () => {
    postThread(ctx, { thread: job.topicId, from: bot.id, kind: 'job_card', refId: `submission:${submission.id}`,
      text: submissionCardTitle(jobTitleOf(ctx, job), submission.round) });
  });
  softly(ctx, '工作往来里的交回提示', () => {
    postThread(ctx, { thread: job.topicId, from: 'hub', kind: 'work', refId: eventId, text: submittedHint(bot.name, reviewerName, submission, capped, hasEstimate) });
  });
  if (capped) {
    // 回合上限的处理接手：这件事转受阻（原因：回合用到上限，受阻前是核对中），「待你处理」放一条，写明在等谁做什么。
    // 出错只记日志：交回已经成功入库，巡检（job/sweep.ts）下一个 tick 会按同样的规则补上。
    softly(ctx, '回合上限的处理', () => {
      blockForTurnCap(ctx, job.id, now, { stuckText: `等${reviewerName}核对第 ${submission.round} 轮交回` });
    });
    return hasEstimate
      ? `已交回第 ${submission.round} 轮。这件事已用到预计消耗，核对要等主人决定是否继续。`
      : `已交回第 ${submission.round} 轮。这件事的回合用到上限，核对要等主人决定是否继续。`;
  }
  return `已交回第 ${submission.round} 轮，${reviewerName}会逐条核对。`;
}

// ---------------------------------------------------------------------------
// block
// ---------------------------------------------------------------------------

/** 说明做不下去：这件事转受阻（原因：执行者），叫总管，总管用约定回答或向主人说明。 */
export async function runJobBlock(ctx: HubContext, tc: ToolContext, args: JobWorkArgs): Promise<string> {
  const { bot, job } = locateJob(ctx, tc, args.jobId);
  assertJobOpen(job, '说明做不下去');
  if (bot.id !== job.executorId) throw new Error('只有这件事的执行者能说明做不下去');
  const allowed: Job['state'][] = ['ready', 'doing', 'rework'];
  if (!allowed.includes(job.state)) throw stateRefusal(job, '说明做不下去', allowed);
  const missing = [args.stuckAt === undefined ? 'stuckAt' : null, args.tried === undefined ? 'tried' : null].filter((name): name is string => name !== null);
  if (missing.length > 0) throw new Error(`缺少必填项：${missing.join('、')}（mode 为 block 时都要填写）`);
  const stuckAt = args.stuckAt!.trim();
  const tried = args.tried!.map(item => item.trim());
  // P74r14：做不下去的原因和试过的办法会显示给主人，不带参数名。
  const paramProblems = [paramNameProblem('stuckAt', stuckAt), ...tried.map((item, index) => paramNameProblem(`tried[${index}]`, item))]
    .filter((problem): problem is string => problem !== null);
  if (paramProblems.length > 0) throw new Error(paramProblems.join('；'));
  const now = ctx.clock.now();
  const blocked = applyJobAction(job, { type: 'block', kind: 'executor', no: null, text: stuckAt }, now);
  const eventId = newId('jev', ctx.rng);
  const undo: UndoSteps = [];
  try {
    putJob(ctx, blocked);
    undo.push(() => { putJob(ctx, job); });
    queueWake(ctx, { job: blocked, botId: job.chiefId, why: 'escalate', eventId,
      summary: `${bot.name}在做「${jobTitleOf(ctx, job)}」时做不下去：${stuckAt}` }, undo, '总管');
    appendJobEvent(ctx, { id: eventId, jobId: job.id, actor: bot.id, kind: 'executor_blocked', to: [job.chiefId], refId: null, data: { text: stuckAt, tried } });
  } catch (error) {
    await runUndo(ctx, undo, '说明做不下去', job.id);
    throw new Error(`没有记下，已恢复到之前的状态：${error instanceof Error ? error.message : String(error)}`);
  }
  writeOutreachAudit(ctx, 'job_block', { jobId: job.id }, bot.id, now);
  ctx.emit(HUB_EVENT_SCOPES.project, null);
  ctx.emit(HUB_EVENT_SCOPES.bot, job.chiefId);
  softly(ctx, '工作往来里的说明', () => {
    postThread(ctx, { thread: job.topicId, from: 'hub', kind: 'work', refId: eventId, text: `${bot.name}无法继续：${closeSentence(ownerSafe(stuckAt, '具体原因见这件事的主题'))}已告诉总管。` });
  });
  return '已告诉总管。';
}

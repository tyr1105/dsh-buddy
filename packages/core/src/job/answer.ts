/**
 * 总管按约定回答执行者（或核对人）的问题（P74e，方案 5.2.1，B1）：hub_job_manage 的 answer。
 *
 * 核心规则：约定出处由中心附上，不由模型自报（answer-basis.ts）。模型只说「约定的哪一部分、第几条」，
 * 中心核对这一条真实存在、取出原文、拼成「依据：约定「我已定的」第 3 条（……）。这一点不改约定，不需要问主人。」；
 * 引用不存在的条目一律拒绝并列出每部分有几条；模型写在答案里的「依据：……」会被去掉，依据只出现一次。
 * 约定推不出答案的问题没有出处可引用，总管不能用 answer 编一个，要走改约定的路径（守则第 11 条）。
 *
 * 和别的服务一样分三段（方案 6.4）：
 * 1. 校验，一条都不写；
 * 2. 写状态（清掉这次提问；执行者做不下去时恢复到受阻前的状态；给收件人排唤醒；answered 事件），有备份，任何一步失败全部恢复，
 *    所以工具返回「已回答」时收件人确实入了队、闸门不会直接丢弃他的唤醒；
 * 3. 最后才写主人看得见的话（往来里的回答全文和一句中心提示），出错只记日志。
 */
import { JOB_DEFAULTS as D } from '../config/defaults.js';
import type { HubContext } from '../engine/context.js';
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import { JobSchema, type Job } from '../model/job.js';
import { writeOutreachAudit } from '../outreach/audit.js';
import { postThread } from '../outreach/thread.js';
import { resolveBotRef } from '../peer/common.js';
import type { ToolContext } from '../tools/types.js';
import { newId } from '../util/ids.js';
import { posix } from 'node:path';
import { SUMMARY_ONLY_BASIS_TEXT, availableBasisText, basisProblems, composeAnswer, isSummaryOnlyBasis } from './answer-basis.js';
import type { JobManageArgs } from './assign.js';
import { jobTitleOf } from './chain.js';
import type { InboxItem } from '../model/outreach.js';
import { releaseBlockItems, withdrawBlockItems } from './block-items.js';
import { jobFolderPaths, lockedVersionOf } from './files.js';
import { assertOpen, chiefJobOf, requireChief, requireFields } from './manage-common.js';
import { applyJobAction } from './state.js';
import { appendJobEvent, putJob } from './store.js';
import { reviewStalled } from './version-stage.js';
import { queueWake, runUndo, softly, type UndoSteps } from './work-common.js';

/** 没有人在等回答时的报错（原文）。 */
export const NOBODY_ASKING_TEXT = '现在没有人在等你回答。要把主人的新材料交给执行者，用 mode forward';

/** 核对环节没有动静时，answer 的拒绝文字（只写现在真能做的事：换核对人）。 */
export const REVIEW_STALLED_ANSWER_TEXT = '这件事卡在核对环节，不是在等回答。换核对人：mode reassign，reviewer 写新核对人的名字；写「总管」表示由你自己核对。';

/** 这件事材料文件夹里已有的材料标题（文件名去掉 .md，按名字排序）；文件夹不存在时为空。 */
export async function materialTitles(ctx: HubContext, job: Job): Promise<string[]> {
  const { jobDir } = jobFolderPaths(ctx, job);
  const names = await ctx.fs.list(posix.join(jobDir, D.FOLDER_FILES.materials));
  return names.filter(name => name.endsWith('.md')).map(name => name.slice(0, -3)).sort();
}

/** answer 的入口：返回给模型看的一句话。 */
export async function runJobAnswer(ctx: HubContext, tc: ToolContext, args: JobManageArgs): Promise<string> {
  // ---- 第一段：校验 ----
  const chief = requireChief(ctx, tc, '回答问题');
  requireFields('answer', args,['jobId', 'text', 'basis']);
  const job = chiefJobOf(ctx, chief, args.jobId!);
  assertOpen(job, '回答');
  // 谁在等回答：有未回答的提问（执行者或核对人问的）；或者执行者做不下去、转了受阻。
  const executorStuck = job.state === 'blocked' && job.blocked?.kind === 'executor';
  if (job.openAsk === null && !executorStuck) throw new Error(NOBODY_ASKING_TEXT);
  // P74r2b：这一问已经转成约定的新版本在等主人确认，主人确认后由中心回答；主人不确认、撤销之后才能回答。
  if (job.openAsk !== null && job.openAsk.agreementNo != null) {
    throw new Error(`这个问题已经转成约定第 ${job.openAsk.agreementNo} 版，在等主人确认；主人确认后中心会回答。主人不同意的话，撤销这一版之后再回答。`);
  }
  if (job.openAsk === null && reviewStalled(job)) {
    // 兜底发现核对人没有动：等的是核对人，不是执行者在等回答，回答解决不了；现在能做的是换核对人（P74r2a）。
    throw new Error(REVIEW_STALLED_ANSWER_TEXT);
  }
  const recipientId = job.openAsk !== null ? job.openAsk.fromId : job.executorId;
  const recipient = ctx.store.table('bots').get(recipientId);
  if (!recipient) throw new Error('提问的员工找不到了，不能回答');
  if (args.to !== undefined) {
    const named = resolveBotRef(ctx, args.to, 'to', chief.id);
    if (named.id !== recipient.id) throw new Error(`to：现在在等你回答的是${recipient.name}`);
  }
  const rawText = args.text!.trim();
  if (rawText === '') throw new Error('text：不能为空');
  if ([...rawText].length > D.ANSWER_MAX_CHARS) throw new Error(`text：不能超过 ${D.ANSWER_MAX_CHARS} 字`);
  const basis = args.basis!;
  if (basis.length < 1 || basis.length > D.BASIS_MAX) throw new Error(`basis：要写 1 到 ${D.BASIS_MAX} 处出处`);
  const agreement = ctx.store.table('agreements').get(job.agreementId);
  if (!agreement) throw new Error('这件事的约定找不到了，不能回答');
  const content = lockedVersionOf(agreement).content;
  // P74r2d：主人转来的材料也是出处，标题必须是这件事材料文件夹里已有的一份（文件名去掉 .md）。
  const materials = await materialTitles(ctx, job);
  const problems = basisProblems(content, basis, materials);
  if (problems !== null) {
    throw new Error(`${problems}\n${availableBasisText(content, materials)}。约定里推不出答案的问题，不能编出处：要改约定请用 hub_agreement_submit 的 revise，按守则第 11 条处理`);
  }
  // 「一句话」只是复述，推不出具体的答案，不能当唯一出处（P74r2d，审查报告第 7 节第 6 条）。
  if (isSummaryOnlyBasis(basis)) throw new Error(SUMMARY_ONLY_BASIS_TEXT);
  const full = composeAnswer(content, rawText, basis);
  if (full === null) throw new Error('text：去掉你自己写的「依据：……」之后没有内容了，请先写答案本身；依据由中心从约定里附上');
  const data = { text: full, basis: basis.map(item => item.section === 'material' ? { section: item.section, title: item.title } : { section: item.section, no: item.no }) };
  if (Buffer.byteLength(JSON.stringify(data), 'utf8') > D.EVENT_DATA_MAX_BYTES) throw new Error('text：回答太长，请缩短答案本身');

  // ---- 第二段：写状态，有备份 ----
  const now = ctx.clock.now();
  const eventId = newId('jev', ctx.rng);
  // P74f：回执的「总管替你答掉的问题」读这件事记录上的计数，不读只保留 14 天的事件日志。
  let next: Job = { ...job, openAsk: null, updatedAt: now, answeredCount: (job.answeredCount ?? 0) + 1 };
  // 执行者做不下去时，回答同时让这件事回到受阻前的状态。
  // P74f-2：解除受阻的同时，这件事开着的「停住了」「三轮不过说明」等条目也要撤回（状态里先清空编号，条目在第三段撤回）。
  // P74r4a 第 3 条：解除受阻统一走 releaseBlockItems（清编号、取开着的受阻条目）。
  let staleItems: InboxItem[] = [];
  if (executorStuck) {
    const released = releaseBlockItems(ctx, applyJobAction(next, { type: 'unblock' }, now));
    next = released.job;
    staleItems = released.items;
  }
  next = JobSchema.parse(next);
  const undo: UndoSteps = [];
  try {
    putJob(ctx, next);
    undo.push(() => { putJob(ctx, job); });
    queueWake(ctx, { job: next, botId: recipient.id, why: 'answered', eventId,
      summary: `总管回答了你在「${jobTitleOf(ctx, job)}」里的问题` }, undo, recipient.name);
    appendJobEvent(ctx, { id: eventId, jobId: job.id, actor: chief.id, kind: 'answered', to: [recipient.id],
      refId: job.openAsk?.eventId ?? null, data });
  } catch (error) {
    await runUndo(ctx, undo, '回答', job.id);
    ctx.emit(HUB_EVENT_SCOPES.project, null);
    throw new Error(`回答失败，已恢复到回答前的状态：${error instanceof Error ? error.message : String(error)}`);
  }
  writeOutreachAudit(ctx, 'job_answer', { jobId: job.id, to: recipient.id, eventId }, chief.id, now);
  ctx.emit(HUB_EVENT_SCOPES.project, null);
  ctx.emit(HUB_EVENT_SCOPES.bot, recipient.id);

  // ---- 第三段：主人看得见的话 ----
  softly(ctx, '撤回受阻条目', () => { withdrawBlockItems(ctx, staleItems, now, '总管已回答，这件事继续进行'); });
  softly(ctx, '工作往来里的回答', () => {
    postThread(ctx, { thread: job.topicId, from: chief.id, kind: 'work', refId: eventId, text: full });
  });
  softly(ctx, '工作往来里的提示', () => {
    postThread(ctx, { thread: job.topicId, from: 'hub', kind: 'work', refId: eventId, text: `总管按约定答复了${recipient.name} 1 个问题，不需要你处理。` });
  });
  return `已回答${recipient.name}。`;
}

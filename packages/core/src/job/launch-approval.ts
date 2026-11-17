/**
 * 执行者在一件事里申请审批时，审批与这件事的衔接（P74g，方案 5.6）。
 *
 * 这个文件管三件事：
 * 1. 识别：这位员工此刻是不是在做某件事的执行链回合（打开的唤醒带 jobId，而且他是这件事的执行者）。
 *    是，这张审批就属于这件事：审批卡落在总管私聊，审批单旁边记一行 approvalNotes（带 jobId，以及费用、能否撤回、批准之后三行）；
 *    不是，审批的一切保持原样。核对人、总管自己在回合里申请的审批不算（他们不是做这件事的人，说「由某某执行」不符合事实）。
 * 2. 发布准备：这件事已验收、发布状态是「准备中」时，执行者提交的第一张审批就是发布审批，发布状态改成「等批准」；
 *    主人拒绝或审批过期时改成「暂不发布」，这件事本身仍是已完成。
 * 3. 总管的话：这些话是中心按固定句落的，以总管的名义，不叫醒总管（方案 13 节第 3 条）。
 *
 * 写法照 P74 一贯的三段：先改状态（有撤销函数），全部成功之后才由调用方说主人看得见的话。
 * 本文件不碰审批单本身，也不建收件箱条目，那些仍由 gate/approvals.ts 负责。
 */
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import { VOID_REASON_LAUNCH_CAP, voidApproval } from '../gate/void-approval.js';
import type { HubContext } from '../engine/context.js';
import { JobSchema, ApprovalNoteSchema, type Job } from '../model/job.js';
import { postThread } from '../outreach/thread.js';
import { isOpenWake } from '../turn/session.js';
import { launchOf } from '../model/agreement.js';
import { lockedVersionOf } from './files.js';
import { botIsArchived } from '../model/bot.js';
import { enqueueJobWake, isOnDutyNow, jobTitleOf } from './chain.js';
import { inLaunchPhase, launchTurnsLeft, launchTurnsUsed } from './launch-turns.js';
import { cancelLaunchTurn } from './launch-cancel.js';
import { appendJobEvent, putJob } from './store.js';
import { pendingLaunchApprovalOf } from './launch-replace.js';
import { followUpTopic } from '../project/topic-followup.js';

/** 审批卡上没有填写的那一项显示的字样。 */
export const LAUNCH_UNSPECIFIED = '未说明';

/** 员工提交审批时写的三行（都可省略）。 */
export interface ApprovalNoteInput {
  cost?: string | undefined; undo?: string | undefined; after?: string | undefined;
  /** P74r19：用这一条取代这件事已有的、还在等批准的发布命令（只在发布这一步有效，见 job/launch-replace.ts）。不写进审批旁表。 */
  replace?: boolean | undefined;
}

/** 发布审批被拒绝时总管私聊里的那句话。 */
export const LAUNCH_DECLINED_TEXT = '好的，暂不发布。需要时告诉我。';
/** 发布审批过期时总管私聊里的那句话。 */
export const LAUNCH_EXPIRED_TEXT = '发布审批已过期，没有发布。需要时告诉我。';

/**
 * 这位员工此刻在做的那件事：他最近一个打开的唤醒带 jobId，而且他是这件事的执行者。没有返回 null。
 * 只认执行者：审批卡上要写「由{执行者}执行」，核对人和总管申请的审批不属于「执行」。
 */
export function executingJobOf(ctx: HubContext, botId: string): Job | null {
  const wake = ctx.store.table('wakes').list(row => row.botId === botId && isOpenWake(row) && typeof row.jobId === 'string' && row.jobId !== '')
    .sort((a, b) => b.startedAt - a.startedAt)[0];
  if (wake?.jobId === undefined || wake.jobId === null) return null;
  const job = ctx.store.table('jobs').get(wake.jobId);
  return job !== null && job.executorId === botId ? job : null;
}

/** 这张审批单属于哪件事（读旁表）；不属于任何事、或这件事已不存在时返回 null。 */
export function noteJobOf(ctx: HubContext, approvalId: string): Job | null {
  const note = ctx.store.table('approvalNotes').get(approvalId);
  if (note === null || note.jobId === undefined || note.jobId === null) return null;
  return ctx.store.table('jobs').get(note.jobId);
}

/**
 * P81r1（S6）：这一条提交下来的审批，会不会成为这件事的发布审批；是时带上约定里现在的发布位置。
 * 显示（审批卡提示句里带不带发布位置）与绑定（beginJobApproval 改发布状态、旁表记下位置）共用这一个函数，
 * 带 replace 时两处判断不再不一致。
 */
export interface LaunchSubmission {
  job: Job;
  /** 约定里现在的发布位置（绝对路径）；约定没有写为 null。 */
  localDir: string | null;
}

/** 用已知的这件事判断（beginJobApproval 已经在手上有 job，避免重复取一次唤醒）。 */
export function launchSubmissionFor(ctx: HubContext, job: Job, replace: boolean): LaunchSubmission | null {
  if (job.state !== 'done') return null;
  // 只有带 replace 时才把「已有发布审批在等批准」算作发布审批；没有 replace 的已在入口被拒绝（gate/outbox.ts）。
  const replaced = replace ? pendingLaunchApprovalOf(ctx, job) : null;
  if (job.launch.state !== 'preparing' && job.launch.state !== 'failed' && replaced === null) return null;
  const agreement = ctx.store.table('agreements').get(job.agreementId);
  const localDir = agreement === null ? null : launchOf(lockedVersionOf(agreement).content)?.localDir ?? null;
  return { job, localDir };
}

/** 这位员工此刻提交的审批会不会成为发布审批（按他正在做的事判断）；不是为 null。 */
export function launchSubmissionOf(ctx: HubContext, botId: string, replace: boolean): LaunchSubmission | null {
  const job = executingJobOf(ctx, botId);
  return job === null ? null : launchSubmissionFor(ctx, job, replace);
}

/** 这张审批卡应该落在哪个线程：属于一件事的落在总管私聊，其余落在申请的员工私聊（原样）。 */
export function approvalThreadOf(ctx: HubContext, approvalId: string, botId: string): string {
  return noteJobOf(ctx, approvalId)?.chiefId ?? botId;
}

/** 发布审批给主人看的一句话的前缀（P74r13）：「按约定对外发布：{约定里的发布方式}」。 */
export const LAUNCH_SENTENCE_PREFIX = '按约定对外发布：';

/**
 * P74r13：这件事的发布审批给主人看的一句话：取这件事约定里写的发布方式（launch.how）。
 * 通用句「请中心代为运行一条命令」让主人看不出这是约定里说好的对外发布；这一句替换它，
 * 审批卡第一行、「待你处理」条目的标题、对话里的系统行都用它。约定里没有发布方式（不应出现）返回 null，沿用通用句。
 */
export function launchApprovalSentence(ctx: HubContext, job: Pick<Job, 'agreementId'>): string | null {
  const agreement = ctx.store.table('agreements').get(job.agreementId);
  if (agreement === null) return null;
  const launch = launchOf(lockedVersionOf(agreement).content);
  return launch === null ? null : `${LAUNCH_SENTENCE_PREFIX}${launch.how}`;
}

/** 审批提交时的开始结果：这是不是这件事的发布审批；撤销函数把改动全部放回去。 */
export interface BegunJobApproval {
  job: Job; launching: boolean; undo: () => void;
  /** P74r19：这张审批取代了这件事原来在等批准的发布审批时，原来那张的编号（调用方在新卡建好之后作废它）；没有取代为 null。 */
  replaced: string | null;
}

/**
 * 第一段：为属于这件事的审批写旁表；是发布审批时再把发布状态改成「等批准」、记一条 launch_requested 事件。
 * 任何一步失败，已做的改动全部撤销后抛出中文错误，调用方据此连审批单一起撤回。
 * 事件日志是只追加的，所以事件放在最后一步写。
 */
export function beginJobApproval(ctx: HubContext, job: Job, approvalId: string, notes: ApprovalNoteInput, now: number): BegunJobApproval {
  // P81r1（S6）：是不是发布审批、约定里现在的发布位置，由同一个函数判断（显示与绑定共用）。
  const submission = launchSubmissionFor(ctx, job, notes.replace === true);
  const row = ApprovalNoteSchema.parse({ id: approvalId, cost: notes.cost ?? null, undo: notes.undo ?? null, after: notes.after ?? null, jobId: job.id,
    ...(submission?.localDir === null || submission?.localDir === undefined ? {} : { launchLocalDir: submission.localDir }), createdAt: now });
  // P74r18b：发布没有成功（failed）之后，执行者改正命令重新提交的发布审批同样是发布审批：发布状态回到等批准，这件事继续。
  // P74r19：这件事已有一条发布命令在等批准、执行者带 replace 提交了新的一条：新的成为发布审批（走同样的路径），
  // 原来那条由调用方在新卡建好之后作废；没有带 replace 的已在入口被拒绝（gate/outbox.ts），到不了这里。
  const replacedApproval = notes.replace === true ? pendingLaunchApprovalOf(ctx, job) : null;
  const launching = submission !== null;
  const next = launching ? JobSchema.parse({ ...job, launch: { ...job.launch, state: 'approval', approvalId }, updatedAt: now }) : job;
  const undo = (): void => {
    ctx.store.table('approvalNotes').remove(approvalId);
    if (launching) putJob(ctx, job);
  };
  try {
    ctx.store.table('approvalNotes').put(row);
    if (launching) {
      putJob(ctx, next);
      appendJobEvent(ctx, { jobId: job.id, actor: job.executorId, kind: 'launch_requested', to: ['owner'], refId: approvalId, data: { approvalId } });
    }
  } catch (error) {
    undo();
    throw new Error(`审批没有记下，已恢复到申请前的状态：${error instanceof Error ? error.message : String(error)}`);
  }
  return { job: next, launching, undo, replaced: replacedApproval?.id ?? null };
}

/** 只有三行没有关联事时写的旁表（员工填了费用、能否撤回、批准之后，但这张审批不属于任何一件事）。 */
export function putPlainNote(ctx: HubContext, approvalId: string, notes: ApprovalNoteInput, now: number): () => void {
  ctx.store.table('approvalNotes').put(ApprovalNoteSchema.parse({ id: approvalId, cost: notes.cost ?? null, undo: notes.undo ?? null, after: notes.after ?? null, jobId: null, createdAt: now }));
  return () => { ctx.store.table('approvalNotes').remove(approvalId); };
}

/**
 * 第三段：审批卡之前，以总管的名义在总管私聊落一句。
 * 发布准备时说明这件事已验收、需要批准；执行中途的审批说明是谁在做哪件事。出错只记日志，不影响审批。
 */
export function announceJobApproval(ctx: HubContext, job: Job, launching: boolean, approvalId: string, replaced = false): void {
  // P74r19：取代原来那条发布命令时不重复说「已验收，下一步是对外发布，需要你批准」（主人已经看过一次，新卡直接落在后面）。
  if (replaced) return;
  try {
    const title = jobTitleOf(ctx, job);
    const executor = ctx.store.table('bots').get(job.executorId)?.name ?? '执行者';
    // P74r4a 第 9 条：这件事已完成（在发布环节）、执行者又提交了发布审批之外的第二张审批：不能写「在做」（这件事已经做完了），
    // 写「在准备发布」。
    const text = launching ? `${title}已验收，下一步是对外发布，需要你批准；批准前不会发布。`
      : job.state === 'done' ? `${executor}在准备发布「${title}」，这一步需要你批准。` : `${executor}在做「${title}」，这一步需要你批准。`;
    postThread(ctx, { thread: job.chiefId, from: job.chiefId, kind: 'reply', refId: approvalId, text });
  } catch (error) {
    ctx.logger.warn('总管私聊里的审批说明没有落下', { jobId: job.id, error: String(error) });
  }
}

/** 批准之后、执行之前审批被作废（例如批准后命令有改动）时总管私聊里的那句话。 */
export const LAUNCH_VOIDED_TEXT = '发布审批已作废（批准之后要运行的命令有改动），没有发布。需要时告诉我。';

/**
 * 发布这一步用满自己的回合上限时，按当时的事实分四种（P74r4b 第 1 节，审查 K7、L4）：
 * - no_approval：执行者还没有提交发布审批；
 * - pending：审批在等主人批准（已作废）；
 * - approved：主人已批准、命令还没有运行（已作废）；
 * - ran_ok / ran_failed：命令已经运行，结果成功（没有回报地址）或失败。
 */
export type LaunchCapKind = 'no_approval' | 'pending' | 'approved' | 'ran_ok' | 'ran_failed' | 'ran_unknown';

/** 命令已经开始运行、出站记录仍不是终点状态时，最多等多久（30 分钟）再按「结果没有记录下来」结束。 */
export const LAUNCH_RESULT_WAIT_MS = 30 * 60 * 1000;

/** 发布这一步用满自己的回合上限时总管私聊里的那句话（五个变体，逐字固定）。 */
export function launchCapText(kind: LaunchCapKind, input: { title: string; turns: number; executor: string }): string {
  const { title, turns, executor } = input;
  switch (kind) {
    case 'no_approval': return `${title}的发布这一步用了 ${turns} 个回合，${executor}仍没有提交发布审批，发布这一步到此结束，没有发布。需要时告诉我。`;
    case 'pending': return `${title}的发布这一步用了 ${turns} 个回合仍没有完成，等你批准的那张发布审批已作废，没有发布。需要时告诉我。`;
    case 'approved': return `${title}的发布这一步用了 ${turns} 个回合仍没有完成，你批准的发布命令还没有运行，已作废，没有发布。需要时告诉我。`;
    case 'ran_ok': return `${title}的发布命令已经运行，${executor}没有回报发布后的地址。请你确认是否已上线。`;
    case 'ran_failed': return `${title}的发布命令运行失败，没有发布。需要时告诉我。`;
    case 'ran_unknown': return `${title}的发布命令已经运行，结果没有记录下来。请你确认是否已上线。`;
  }
}

/** 总管私聊里以中心名义落一句（出错只记日志）。 */
function hubSays(ctx: HubContext, job: Job, text: string): void {
  try { postThread(ctx, { thread: job.chiefId, from: 'hub', kind: 'system', refId: job.id, text }); }
  catch (error) { ctx.logger.warn('总管私聊里的发布说明没有落下', { jobId: job.id, error: String(error) }); }
}

/** P74r19 第 4 节：主人点「暂不发布」之后，这件事的主题里落的旁白（逐字）。 */
export const LAUNCH_TOPIC_OWNER_DECLINED_TEXT = '你选择了暂不发布。';
/** P74r19 第 4 节：中心结束发布这一步（做不了、兜底、审批过期、回合用满）时，这件事的主题里落的旁白（逐字）。 */
export const LAUNCH_TOPIC_HUB_ENDED_TEXT = '这件事没有发布。';

/**
 * P74r19 第 4 节：在这件事的主题里落一句旁白（以中心的名义，系统行）。写法照批准时主题里落旁白的现有写法
 * （gate/approvals.ts 的 finishDecision → project/topic-followup.ts 的 startTopicFollowUp：postThread、from hub、kind system），
 * 主题已经不能再落话（项目不在进行中、总管不在队里、主题已删除等，followUpTopic 判断）时不落；出错只记日志，不影响发布状态。
 * 用总管判断主题还能不能落话：总管一定是项目成员，不受执行者被归档的影响。
 */
function noteInJobTopic(ctx: HubContext, job: Job, text: string): void {
  try {
    const topic = followUpTopic(ctx, job.chiefId, job.topicId);
    if (topic === null) return;
    postThread(ctx, { thread: topic.id, from: 'hub', kind: 'system', text, refId: job.id });
  } catch (error) {
    ctx.logger.warn('主题里的发布旁白没有落下', { jobId: job.id, error: String(error) });
  }
}

/**
 * 把发布状态记为「暂不发布」并记事件；写失败恢复并抛出。
 * endedBy（P74r7）：谁结束的：owner 是主人自己点的，hub 是中心结束的；进度行据此写「你暂不发布」或「没有发布」。
 * P74r19：中心结束（hub）时，这件事的主题里落「这件事没有发布。」。owner 在这里只来自「约定去掉了对外发布」，那种情形有自己的主题文字，不在这里落。
 */
export function markDeclined(ctx: HubContext, job: Job, now: number, data: Record<string, unknown>, endedBy: 'owner' | 'hub'): Job {
  const next = JobSchema.parse({ ...job, launch: { ...job.launch, state: 'declined', endedBy }, updatedAt: now });
  try {
    putJob(ctx, next);
    appendJobEvent(ctx, { jobId: job.id, actor: 'hub', kind: 'launch_declined', to: [job.executorId], refId: job.launch.approvalId, data });
  } catch (error) {
    putJob(ctx, job);
    throw error;
  }
  ctx.emit(HUB_EVENT_SCOPES.project, null);
  ctx.emit(HUB_EVENT_SCOPES.bot, job.chiefId);
  if (endedBy === 'hub') noteInJobTopic(ctx, job, LAUNCH_TOPIC_HUB_ENDED_TEXT);
  return next;
}

/** 叫执行者去准备发布（验收之后、恢复在岗之后用）。返回有没有排上。 */
export function wakeForLaunch(ctx: HubContext, job: Job): boolean {
  const entry = enqueueJobWake(ctx, { job, botId: job.executorId, why: 'launch', eventId: null,
    summary: `「${jobTitleOf(ctx, job)}」主人已验收，请准备对外发布并提交审批` });
  if (entry === null) ctx.logger.warn('发布准备的唤醒没有排上', { jobId: job.id });
  return entry !== null;
}

/**
 * 验收之后发布这一步的起头（验收一定成功，这里不影响验收）：
 * - 执行者在岗：叫他准备发布，这件事的回合上限不约束这个叫醒（见 launch-turns.ts）；
 * - 执行者停用等不在岗：发布保持准备中，总管私聊落一句；他恢复在岗时由 resumeLaunchOfReinstated 叫醒他；
 * - 执行者已归档（或已不存在）：这一步记为「暂不发布」，落一句。
 * 整个函数出错只记日志。
 */
export function startLaunch(ctx: HubContext, job: Job): void {
  try {
    const title = jobTitleOf(ctx, job);
    const bot = ctx.store.table('bots').get(job.executorId);
    if (bot === null || botIsArchived(bot)) {
      markDeclined(ctx, job, ctx.clock.now(), { reason: 'executor_archived' }, 'hub');
      hubSays(ctx, job, `${title}已验收。${bot?.name ?? '执行者'}已归档，发布这一步没有进行。需要时告诉我。`);
    } else if (!isOnDutyNow(ctx, job.executorId)) {
      hubSays(ctx, job, `${title}已验收。发布这一步要等${bot.name}恢复在岗后才开始。`);
    } else {
      wakeForLaunch(ctx, job);
    }
  } catch (error) {
    ctx.logger.warn('发布这一步没有起头', { jobId: job.id, error: String(error) });
  }
}

/**
 * 执行者恢复在岗：他名下已验收、发布还在准备中（或批准后还没回报）的事，由中心叫醒他接着做。
 * 接在 job/participants.ts 的恢复在岗路径上；已经排着的不重复排。
 */
export function resumeLaunchOfReinstated(ctx: HubContext, botId: string): void {
  for (const job of ctx.store.table('jobs').list(row => row.executorId === botId && inLaunchPhase(row))) {
    try {
      const approval = job.launch.approvalId === null ? null : ctx.store.table('approvals').get(job.launch.approvalId);
      const approved = approval !== null && (approval.status === 'approved' || approval.status === 'used');
      const waiting = job.launch.state === 'preparing' || approved;
      if (!waiting || ctx.store.table('queue').count(row => row.botId === botId && row.jobId === job.id) > 0) continue;
      wakeForLaunch(ctx, job);
    } catch (error) {
      ctx.logger.warn('恢复在岗后没有叫醒发布', { jobId: job.id, error: String(error) });
    }
  }
}

/**
 * 读「当时的事实」（P74r4b 第 1 节）。读法：
 * - 这件事的发布审批 = job.launch.approvalId 指的那张审批单；没有、或找不到：执行者还没有提交（no_approval）；
 * - 审批状态是 pending：在等主人批准；approved：主人批准了、命令还没有运行（批准票还没有被使用）；
 * - 审批状态是 used：批准票已被使用，也就是中心已经运行了命令；结果看这张审批对应的出站记录（outbox 表里 approvalId 相同的行）：
 *   状态 done 为成功；failed 为失败；rejected（中心在命令运行途中退出，重启后被出站循环收尾成的）为结果没有记录下来；
 *   P74r4b-m1：记录还不是终点状态（运行中、找不到记录）时这一次不下结论（返回 running），等它到终点状态；
 *   从批准票被使用（approval.usedAt，即命令开始运行）起满 30 分钟仍不是终点状态，按 ran_unknown 结束（已发布、没有地址，请主人确认）；
 * - 审批已是 rejected、expired（正常情况下发布状态早已是暂不发布，到不了这里）：按没有可用的审批处理（no_approval）。
 */
function launchCapKind(ctx: HubContext, job: Job, now: number): LaunchCapKind | 'running' {
  const approval = job.launch.approvalId === null ? null : ctx.store.table('approvals').get(job.launch.approvalId);
  if (approval === null) return 'no_approval';
  if (approval.status === 'pending') return 'pending';
  if (approval.status === 'approved') return 'approved';
  if (approval.status === 'used') {
    const sent = ctx.store.table('outbox').list(row => row.approvalId === approval.id);
    if (sent.some(row => row.status === 'done')) return 'ran_ok';
    if (sent.length > 0 && sent.every(row => row.status === 'failed')) return 'ran_failed';
    // 批准票已使用而出站记录是「已拒绝」：只可能是中心在运行命令途中退出，重启后出站循环见到「批准票已使用」把这一行收尾成已拒绝
    // （gate/outbox.ts executeReadyOutbox）。命令可能已经运行，不能说成「运行失败」：直接按「结果没有记录下来」结束。
    if (sent.some(row => row.status === 'rejected')) return 'ran_unknown';
    return now - (approval.usedAt ?? approval.decidedAt ?? approval.createdAt) >= LAUNCH_RESULT_WAIT_MS ? 'ran_unknown' : 'running';
  }
  return 'no_approval';
}

/** 命令已运行（成功）而执行者没有回报地址：发布状态记为已发布、地址为空，记 launched 事件。写失败恢复并抛出。 */
function markLaunchedWithoutLink(ctx: HubContext, job: Job, now: number): void {
  const next = JobSchema.parse({ ...job, launch: { ...job.launch, state: 'done' }, updatedAt: now });
  try {
    putJob(ctx, next);
    appendJobEvent(ctx, { jobId: job.id, actor: 'hub', kind: 'launched', to: ['owner'], refId: job.launch.approvalId, data: { link: null, reason: 'turn_cap' } });
  } catch (error) {
    putJob(ctx, job);
    throw error;
  }
  ctx.emit(HUB_EVENT_SCOPES.project, null);
  ctx.emit(HUB_EVENT_SCOPES.bot, job.chiefId);
}

/**
 * 发布这一步用满自己的回合上限（闸门丢弃了一个发布的叫醒，scheduler 之后调用）：
 * 按当时的事实分四种处理（见 launchCapKind、docs/progress/P74r4b.md），总管私聊以总管名义落对应的一句；不建「待你处理」条目。
 * - 没有提交审批：暂不发布，审批无；
 * - 审批在等批准、或已批准还没运行：暂不发布，审批作废（否则中心之后仍会替他运行那条命令，而话已经说了「没有发布」）；
 * - 命令已运行：成功记为已发布（没有地址），失败记为暂不发布；审批不动。
 */
export function stopLaunchForCap(ctx: HubContext, jobId: string): void {
  try {
    const job = ctx.store.table('jobs').get(jobId);
    if (job === null || !inLaunchPhase(job)) return;
    const turns = launchTurnsUsed(ctx, job);
    const now = ctx.clock.now();
    const kind = launchCapKind(ctx, job, now);
    // P74r4b-m1：命令已经运行、结果还没有记下：这一次不结束、不说话，等它到终点状态（巡检 recheckLaunchCaps 之后再来）。
    if (kind === 'running') return;
    // 先改发布状态（写失败会抛出，什么都不会说），再处理审批，最后才说话。
    if (kind === 'ran_ok' || kind === 'ran_unknown') markLaunchedWithoutLink(ctx, job, now);
    else markDeclined(ctx, job, now, { reason: kind === 'ran_failed' ? 'turn_cap_command_failed' : 'turn_cap', turns }, 'hub');
    if ((kind === 'pending' || kind === 'approved') && job.launch.approvalId !== null) voidApproval(ctx, job.launch.approvalId, VOID_REASON_LAUNCH_CAP, now); // 与脚本被改动的作废共用一个函数（gate/void-approval.ts）
    // P74r15：发布这一步结束了，执行者正在跑的发布准备回合（若有）一并取消。
    cancelLaunchTurn(ctx, job);
    const executor = ctx.store.table('bots').get(job.executorId)?.name ?? '执行者';
    postThread(ctx, { thread: job.chiefId, from: job.chiefId, kind: 'reply', refId: job.id, text: launchCapText(kind, { title: jobTitleOf(ctx, job), turns, executor }) });
  } catch (error) {
    ctx.logger.warn('发布这一步用满回合上限的收尾没有完成', { jobId, error: String(error) });
  }
}

/**
 * 巡检补做（P74r4b-m1）：发布这一步已用满回合上限、但上次因为命令结果还没记下而没有结束的事，每次巡检再看一次。
 * 只处理「回合用满、发布审批已使用（命令已开始运行）」的事，其余不碰（回合没用满的事执行者还会被叫醒）。
 */
export function recheckLaunchCaps(ctx: HubContext): void {
  for (const job of ctx.store.table('jobs').list(row => inLaunchPhase(row) && row.launch.state === 'approval')) {
    try {
      const approval = job.launch.approvalId === null ? null : ctx.store.table('approvals').get(job.launch.approvalId);
      if (approval?.status === 'used' && launchTurnsLeft(ctx, job) <= 0) stopLaunchForCap(ctx, job.id);
    } catch (error) {
      ctx.logger.warn('发布结果的巡检补做失败', { jobId: job.id, error: String(error) });
    }
  }
}

/** 拒绝、过期或作废之后的这一步：撤销函数（把发布状态放回「等批准」）和说话函数。 */
export interface DeclinedLaunch { undo: () => void; announce: () => void }

/**
 * 主人拒绝、或审批过期，而且这件事正在等这张审批：发布状态改成「暂不发布」，记 launch_declined 事件。
 * 这件事本身保持已完成。这张审批不是这件事在等的那一张（或这件事不在等发布审批）时返回 null，什么都不改。
 * 先改状态：写失败时已改的放回并抛出，调用方不再继续落审批结果，主人可以重新点一次。
 */
export function declineLaunchStep(ctx: HubContext, approvalId: string, status: 'rejected' | 'expired' | 'voided', now: number): DeclinedLaunch | null {
  const job = noteJobOf(ctx, approvalId);
  if (job === null || job.state !== 'done' || job.launch.state !== 'approval' || job.launch.approvalId !== approvalId) return null;
  // P74r7：只有主人自己拒绝（rejected）算主人结束的；过期、作废都是中心结束的，进度行写「没有发布」。
  const next = JobSchema.parse({ ...job, launch: { ...job.launch, state: 'declined', endedBy: status === 'rejected' ? 'owner' : 'hub' }, updatedAt: now });
  try {
    putJob(ctx, next);
    appendJobEvent(ctx, { jobId: job.id, actor: status === 'rejected' ? 'owner' : 'hub', kind: 'launch_declined', to: [job.executorId], refId: approvalId, data: { approvalId, status } });
  } catch (error) {
    putJob(ctx, job);
    throw new Error(`发布结果没有记下，已恢复到之前的状态：${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    undo: () => { putJob(ctx, job); },
    announce: () => {
      // P74r15：发布这一步结束了，执行者正在跑的发布准备回合一并取消（取消失败、出错都只记日志）。
      cancelLaunchTurn(ctx, job);
      // P74r19 第 4 节：这件事的主题里落一句：主人点的「暂不发布」写「你选择了暂不发布。」，过期、作废（中心结束的）写「这件事没有发布。」。
      noteInJobTopic(ctx, job, status === 'rejected' ? LAUNCH_TOPIC_OWNER_DECLINED_TEXT : LAUNCH_TOPIC_HUB_ENDED_TEXT);
      try {
        postThread(ctx, { thread: job.chiefId, from: job.chiefId, kind: 'reply', refId: approvalId, text: status === 'expired' ? LAUNCH_EXPIRED_TEXT : status === 'voided' ? LAUNCH_VOIDED_TEXT : LAUNCH_DECLINED_TEXT });
        ctx.emit(HUB_EVENT_SCOPES.project, null);
        ctx.emit(HUB_EVENT_SCOPES.bot, job.chiefId);
      } catch (error) {
        ctx.logger.warn('总管私聊里的「暂不发布」没有落下', { jobId: job.id, error: String(error) });
      }
    },
  };
}

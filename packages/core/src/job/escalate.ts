/**
 * 向主人说明卡在哪、有哪几个办法：hub_job_manage 的 escalate（P74f-2，任务卡第 7 节，补充要求 3.1）。
 *
 * 两种情形：核对三轮仍不过（review_limit）；执行者做不下去、总管自己又解决不了（executor）。
 * 总管用 escalate 把「卡在哪」和两三个办法交给主人，由主人选一个（选的办法怎样生效见 choose-option.ts）。
 * escalate 在主人发起的回合和执行链回合里都能用（三轮不过时叫醒总管的是执行链回合）。
 * 执行者或核对人的提问在约定里推不出答案，走的是另一条路（执行链回合里用 revise 出新版本），不用 escalate。
 *
 * 规则：调用者是这件事的总管；这件事受阻、原因是 review_limit 或 executor；这一阶段还没有说明过（读这件事记录上的 escalation，
 * 不读事件日志）；办法的改动序号在「怎样算做完」里、改后的约定仍合格式；建议的序号在办法范围内；
 * 总管写的文字不含工具名、内部编号、mode 名（主人会看到它们）。全部校验在写入之前。
 * 先改状态（记录、条目、事件，失败恢复），全部成功之后才做主人看得见的话（总管私聊一句、三轮不过卡）。
 */
import { AGREEMENT_DEFAULTS, JOB_DEFAULTS as D } from '../config/defaults.js';
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import type { HubContext } from '../engine/context.js';
import { JobSchema, type Job, type JobEscalation } from '../model/job.js';
import type { InboxItem } from '../model/outreach.js';
import { writeOutreachAudit } from '../outreach/audit.js';
import { createInboxItem, emitInboxChange } from '../outreach/inbox.js';
import { postThread } from '../outreach/thread.js';
import type { ToolContext } from '../tools/types.js';
import type { JobManageArgs } from './assign.js';
import { isOnDutyNow, jobTitleOf } from './chain.js';
import { lockedVersionOf } from './files.js';
import { assertOpen, chiefJobOf, requireChief, requireFields } from './manage-common.js';
import { pendingVersionNo } from './escalation-expiry.js';
import { contentWithChange } from './option-version.js';
import { changeLineProblems, escalationItemBody } from './change-line.js';
import { ownerTextProblem } from './owner-text.js';
import { appendJobEvent, eventsOf, putJob, reviewsOf } from './store.js';
import { reviewStalled } from './version-stage.js';
import { runUndo, softly, type UndoSteps } from './work-common.js';

/** 状态不对时的拒绝文字（原文）。 */
export const ESCALATE_REFUSED_TEXT = '只能在这件事核对三轮仍不过、或执行者做不下去之后，向主人说明并给出办法';
/** 办法的字母前缀：A、B、C。 */
export const OPTION_LETTERS = ['A', 'B', 'C'] as const;

/** 条目上显示的办法按钮文字：「A　{标题}」（字母加全角空格）。 */
export function optionLabel(index: number, title: string): string {
  return `${OPTION_LETTERS[index]}　${title}`;
}

/** 三轮不过卡的消息编号：escalation:<jobId>#<阶段>。 */
export function escalationRefId(jobId: string, stage: number, rev = 0): string {
  return rev > 0 ? `escalation:${jobId}#${stage}~${rev}` : `escalation:${jobId}#${stage}`;
}

/** 三轮不过条目的事项键：job:<jobId>:escalate:<阶段>，同一阶段再次说明的带修订号 ~<rev>（不与第一次撞键）。 */
export function escalateSubjectKey(jobId: string, stage: number, rev = 0): string {
  return rev > 0 ? `job:${jobId}:escalate:${stage}~${rev}` : `job:${jobId}:escalate:${stage}`;
}

/**
 * 这一次受阻已经说明过吗：同一阶段、记录的受阻开始时间等于现在的受阻开始时间。
 * 每次解除受阻再受阻，blocked.since 都是新的时间，所以所有解除受阻的路径（回答、转交、改派、选办法、员工恢复在岗……）
 * 不用各自清记录，自然算新的一次。旧数据没有 blockedSince 时按阶段判断。
 */
export function escalatedThisBlock(job: Pick<Job, 'stage' | 'blocked' | 'escalation'>): boolean {
  const e = job.escalation;
  if (e == null || e.stage !== job.stage) return false;
  // P74r4a：失效的说明（约定变了）不算「这一次受阻已经说明过」，总管可以按新约定重新说明。
  if (e.invalid !== undefined) return false;
  return e.blockedSince === undefined || job.blocked === null || e.blockedSince === job.blocked.since;
}

/** 卡的标题：「第 {no} 条三轮未通过」或「{执行者}无法继续」（P74r11：书面表达）。 */
export function escalationTitle(escalation: Pick<JobEscalation, 'kind' | 'no'>, executorName: string): string {
  if (escalation.kind === 'executor') return `${executorName}无法继续`;
  return escalation.no === null ? '核对三轮未通过' : `第 ${escalation.no} 条三轮未通过`;
}

/**
 * 校验办法里每一处给主人看的模型原文：不含看不见的字符、不含内部名称（规范化之后再匹配，见 owner-text.ts）；一次列全。
 * P74r4a：办法里的改后原文（会写进约定的「怎样算做完」，主人在约定卡、交付卡里都会看到）同样检查。
 */
function internalProblems(args: JobManageArgs): string[] {
  const rows: Array<[string, string]> = [['stuckAt', args.stuckAt ?? ''], ['reason', args.reason ?? '']];
  (args.options ?? []).forEach((option, index) => {
    rows.push([`options[${index}].title`, option.title], [`options[${index}].detail`, option.detail]);
    if (option.change?.text != null) rows.push([`options[${index}].change.text`, option.change.text]);
  });
  return rows.flatMap(([name, text]) => {
    const problem = ownerTextProblem(name, text, { noOwnerWord: true });
    return problem === null ? [] : [problem];
  });
}

/** P74r14：escalate 成功的返回文字里，说明之后这一回合怎样交账（逐字）。 */
export const ESCALATE_COMMIT_HINT = '这一回合交账时 outcome 写 blocked（这件事在等主人选办法），不要写 needs_owner，不要带 ownerQuestion。';

/** escalate 的入口：返回给模型看的一句话。 */
export async function runJobEscalate(ctx: HubContext, tc: ToolContext, args: JobManageArgs): Promise<string> {
  // ---- 第一段：校验 ----
  const chief = requireChief(ctx, tc, '向主人说明办法');
  requireFields('escalate', args, ['jobId', 'stuckAt', 'options', 'suggested', 'reason']);
  const job = chiefJobOf(ctx, chief, args.jobId!);
  assertOpen(job, '向主人说明');
  const blockedKind = job.blocked?.kind;
  // P74r16b：参与者被停用而受阻、停用的那位此刻仍不在岗时，总管也能向主人说明（记成「执行者做不下去」一类，卡上写停用的那位无法继续）。
  const offParticipant = blockedKind === 'participant_off' ? [job.executorId, job.reviewerId].find((id): id is string => id !== null && !isOnDutyNow(ctx, id)) ?? null : null;
  if (job.state !== 'blocked' || (blockedKind !== 'review_limit' && blockedKind !== 'executor' && offParticipant === null)) throw new Error(ESCALATE_REFUSED_TEXT);
  const kind: 'review_limit' | 'executor' = blockedKind === 'review_limit' ? 'review_limit' : 'executor';
  if (reviewStalled(job)) throw new Error('这件事停在核对人没有动静：换一位核对人才能继续，用 mode reassign 的 reviewer，不用向主人说明办法');
  if (escalatedThisBlock(job)) throw new Error('这一次受阻已经向主人说明过了，在等主人选办法，不能再说明');
  const agreement = ctx.store.table('agreements').get(job.agreementId);
  if (!agreement) throw new Error('这件事的约定找不到了，不能说明办法');
  // P74r4a 第 2 条：约定有新版本在等主人确认时不能说明（办法是按固定版本写的，确认之后才知道按哪一版）。
  const pendingNo = pendingVersionNo(agreement);
  if (pendingNo !== null) throw new Error(`约定第 ${pendingNo} 版在等主人确认，确认之后再向主人说明。`);
  const content = lockedVersionOf(agreement).content;
  const stuckAt = args.stuckAt!.trim();
  const reason = args.reason!.trim();
  const options = args.options!;
  const errors: string[] = [];
  if (stuckAt === '' || [...stuckAt].length > D.NOTE_MAX_CHARS) errors.push(`stuckAt：1 到 ${D.NOTE_MAX_CHARS} 个字`);
  if (reason === '' || [...reason].length > D.ESCALATE_REASON_MAX_CHARS) errors.push(`reason：1 到 ${D.ESCALATE_REASON_MAX_CHARS} 个字`);
  if (options.length < D.OPTIONS_MIN || options.length > D.OPTIONS_MAX) errors.push(`options：要写 ${D.OPTIONS_MIN} 到 ${D.OPTIONS_MAX} 个办法`);
  const titles = new Set<string>();
  options.forEach((option, index) => {
    const prefix = `第 ${index + 1} 个办法：`;
    const title = option.title.trim();
    if (title === '' || [...title].length > D.OPTION_TITLE_MAX_CHARS) errors.push(`${prefix}title 要 1 到 ${D.OPTION_TITLE_MAX_CHARS} 个字`);
    if (titles.has(title)) errors.push(`${prefix}title 与前面的办法重复`);
    titles.add(title);
    const detail = option.detail.trim();
    if (detail === '' || [...detail].length > D.OPTION_DETAIL_MAX_CHARS) errors.push(`${prefix}detail 要 1 到 ${D.OPTION_DETAIL_MAX_CHARS} 个字`);
    if (option.change !== undefined) {
      const text = option.change.text;
      if (text !== null && (text.trim() === '' || [...text.trim()].length > AGREEMENT_DEFAULTS.DONE_WHEN_MAX_CHARS)) errors.push(`${prefix}change.text 要 1 到 ${AGREEMENT_DEFAULTS.DONE_WHEN_MAX_CHARS} 个字，删去这一条写 null`);
      else {
        try { contentWithChange(content, { no: option.change.no, text }); } catch (error) { errors.push(`${prefix}${error instanceof Error ? error.message : String(error)}`); }
      }
    }
  });
  if (!Number.isInteger(args.suggested) || args.suggested! < 0 || args.suggested! >= options.length) errors.push(`suggested：要写 0 到 ${options.length - 1} 的整数（从 0 起数）`);
  errors.push(...internalProblems(args));
  // P74r4a 第 1 条：带改动的办法，中心必须生成得出「选了会改什么」一行（序号在「怎样算做完」里），生成不出就一条都不写。
  errors.push(...changeLineProblems(options, content.doneWhen));
  if (errors.length > 0) throw new Error(`说明被拒，没有写入任何东西：${errors.join('；')}`);

  // ---- 第二段：写状态，有备份 ----
  const now = ctx.clock.now();
  const doneWhen = content.doneWhen;
  const no = kind === 'review_limit' ? job.blocked!.no : null;
  const tried = blockedKind === 'executor'
    ? ([...eventsOf(ctx, job.id)].reverse().find(row => row.kind === 'executor_blocked')?.data.tried as unknown[] | undefined ?? []).filter((x): x is string => typeof x === 'string' && x.trim() !== '')
    : [];
  const escalation: JobEscalation = {
    stage: job.stage, rev: job.escalation != null && job.escalation.stage === job.stage ? (job.escalation.rev ?? 0) + 1 : 0,
    blockedSince: job.blocked!.since, versionNo: lockedVersionOf(agreement).no, kind, stuckAt, no, noText: no === null ? null : doneWhen[no - 1] ?? null,
    options: options.map(option => ({ title: option.title.trim(), detail: option.detail.trim(),
      change: option.change === undefined ? null : { no: option.change.no, text: option.change.text === null ? null : option.change.text.trim() },
      followUp: option.followUp === true })),
    suggested: args.suggested!, reason, tried, at: now, chosen: null, chosenAt: null,
  };
  // 卡上写的是「谁无法继续」：停用的参与者受阻时写停用的那位，其余写执行者。
  const executorName = ctx.store.table('bots').get(offParticipant ?? job.executorId)?.name ?? '执行者';
  const title = jobTitleOf(ctx, job);
  const undo: UndoSteps = [];
  let item: InboxItem;
  try {
    // 先建主人要处理的条目（会出错的一步；同一件事其余开着的条目由 createInboxItem 撤回）。
    const before = ctx.store.table('inbox').list(row => row.status === 'open' && row.subjectKey.startsWith(`job:${job.id}:`));
    item = createInboxItem(ctx, {
      // P74r4a 第 1 条：正文在「卡在哪」之后逐个办法列出「{字母}　{标题}」，带改动的办法下一行是中心生成的「选了会改什么」。
      botId: job.chiefId, type: 'question', title: `${title}：${escalationTitle(escalation, executorName)}`,
      body: escalationItemBody(stuckAt, escalation.options, doneWhen, OPTION_LETTERS),
      options: escalation.options.map((option, index) => optionLabel(index, option.title)), defaultOption: null, expiresAt: null, priority: 'P1',
      refId: job.id, subjectKey: escalateSubjectKey(job.id, job.stage, escalation.rev ?? 0), topicId: job.topicId,
    });
    undo.push(() => {
      ctx.store.table('inbox').remove(item.id);
      for (const row of before) ctx.store.table('inbox').put(row);
    });
    // 建条目时「打扰你」已在这件事的记录上加一（createInboxItem）：基于最新的记录写，不能用建条目之前读到的旧记录覆盖掉它。
    putJob(ctx, JobSchema.parse({ ...(ctx.store.table('jobs').get(job.id) ?? job), escalation, inboxId: item.id, updatedAt: now,
      ...(job.escalation == null ? {} : { escalationHistory: [...(job.escalationHistory ?? []), job.escalation] }) }));
    undo.push(() => { putJob(ctx, job); });
    appendJobEvent(ctx, { jobId: job.id, actor: chief.id, kind: 'escalated', to: ['owner'], refId: item.id,
      data: { stage: job.stage, kind, stuckAt, options: escalation.options, suggested: escalation.suggested, reason } });
  } catch (error) {
    await runUndo(ctx, undo, '说明办法', job.id);
    ctx.emit(HUB_EVENT_SCOPES.project, null);
    throw new Error(`说明没有记下，已恢复到之前的状态：${error instanceof Error ? error.message : String(error)}`);
  }
  writeOutreachAudit(ctx, 'job_escalate', { jobId: job.id, stage: job.stage, kind }, chief.id, now);
  ctx.emit(HUB_EVENT_SCOPES.project, null);
  ctx.emit(HUB_EVENT_SCOPES.inbox, job.chiefId);
  emitInboxChange(ctx, item);

  // ---- 第三段：主人看得见的话 ----
  softly(ctx, '总管私聊里的说明', () => {
    let text: string;
    if (kind === 'review_limit') {
      const last = reviewsOf(ctx, job.id).filter(row => row.stage === job.stage).at(-1);
      const others = last === undefined ? Math.max(0, doneWhen.length - 1) : last.items.filter(row => row.verdict !== 'unmet').length;
      text = `${title}停在${no === null ? '一条' : `第 ${no} 条`}${escalation.noText === null ? '' : `（${escalation.noText}）`}，核对三轮仍未通过，在等你选一个处理办法。其余 ${others} 条已通过核对。`;
    } else {
      text = `${title}停在${job.blocked!.resumeTo === 'ready' ? '待开工' : job.blocked!.resumeTo === 'rework' ? '返工' : '执行'}：${executorName}无法继续，需要你选一个处理办法。`;
    }
    postThread(ctx, { thread: job.chiefId, from: chief.id, kind: 'reply', refId: job.id, text });
    postThread(ctx, { thread: job.chiefId, from: chief.id, kind: 'job_card', refId: escalationRefId(job.id, job.stage, escalation.rev ?? 0), text: escalationTitle(escalation, executorName) });
  });
  ctx.emit(HUB_EVENT_SCOPES.thread, job.chiefId);
  // P74r14：说明之后这一回合怎样交账（真实模型曾先写 needs_owner 被拒三次，浪费约 25 万 token）。
  return `已把卡在哪和办法交给主人。${ESCALATE_COMMIT_HINT}`;
}

/**
 * 派活的服务（P74b）：工具 hub_job_manage 的 assign mode 的全部规则。
 * 改派（reassign，含换核对人）在 reassign.ts（P74r2a 拆出，本文件导出它复用的员工解析函数）。
 *
 * 三段式（方案 6.4）：
 * 1. 先做全部校验，一条都不写；缺几项一次列全；
 * 2. 再写状态（一件事的记录、项目成员、主题文件夹与三份文件、给执行者排的唤醒、assigned 事件），
 *    有备份，任何一步失败全部恢复，工具返回失败。事件日志只追加不撤回，所以排在最后；
 * 3. 最后才做主人看得见的三句话（主题里一句、总管私聊一句、工作往来一条），出错只记日志，不影响已成功的状态。
 * 所以工具返回「已派给……」时，这件事的记录、项目成员、主题文件、执行者的唤醒都已经就位。
 *
 * 本文件不注册工具（见 tools/hub-job-manage.ts），不处理执行中的后续动作（提问、交回、核对在后面的卡）。
 */
import { JOB_DEFAULTS as D } from '../config/defaults.js';
import type { HubContext } from '../engine/context.js';
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import { launchOf, type Agreement } from '../model/agreement.js';
import { botIsArchived, type Bot } from '../model/bot.js';
import { ON_TEAM_LIFECYCLES } from '../model/enums.js';
import { JobSchema, type Job } from '../model/job.js';
import { parseFlexibleTime } from '../util/time.js';
import type { WakeTicket } from '../model/wake.js';
import { writeOutreachAudit } from '../outreach/audit.js';
import { postThread } from '../outreach/thread.js';
import { resolveBotRef, wakeOfToolContext } from '../peer/common.js';
import type { ToolContext } from '../tools/types.js';
import { dispatchBlockFor } from '../project/agreement-gate.js';
import { ownerMessageOfWake } from '../project/agreements.js';
import { normalizeProjectSharedDir } from '../project/shared-dir.js';
import { staffPostName } from '../team/workload.js';
import { V2_DEFAULTS } from '../config/defaults.js';
import { newId } from '../util/ids.js';
import { lockedVersionOf, jobFolderPaths, writeJobFiles } from './files.js';
import { addProjectMembers, removeProjectMembers } from './members.js';
import { appendJobEvent, jobOfAgreement, putJob } from './store.js';
import { enqueueJobWakeUndoable } from './chain.js';
import { initialDisturbCount } from './disturb.js';
import { latestEstimate } from './estimate.js';
import { recordAlignment } from './usage.js';
import { checkDeliveryItems } from './item-remap.js';
import { withLabel } from '../util/name-label.js';
import type { BasisArg } from './answer-basis.js';
import { jobCategory } from '../project/agreement-category.js';
import { restoreCollapsedForCategory } from '../skill/store.js';

/**
 * hub_job_manage 解析后的参数（字段含义见工具的参数说明）。
 * P74b：assign、reassign；P74e：answer、forward、stop、resume（to、text、basis、title、reason 是它们的字段）。
 */
export interface JobManageArgs {
  mode: 'assign' | 'reassign' | 'answer' | 'forward' | 'stop' | 'resume' | 'reopen' | 'escalate';
  /** P74f-2：escalate 用。stuckAt 白话写卡在哪；options 两三个办法；suggested 建议第几个（从 0 起）；理由写在 reason。 */
  stuckAt?: string;
  options?: Array<{ title: string; detail: string; change?: { no: number; text: string | null }; followUp?: boolean }>;
  suggested?: number;
  /** P74f：reopen 用，主人指出不符的条目；missed 写核对为什么漏了、这次怎么补。 */
  items?: Array<{ no: number; problem: string; fixTo: string }>;
  missed?: string;
  agreementId?: string;
  jobId?: string;
  executor?: string;
  reviewer?: string;
  dueAt?: string;
  deliveryItems?: number[];
  launchStep?: boolean;
  note?: string;
  to?: string;
  text?: string;
  basis?: BasisArg[];
  title?: string;
  reason?: string;
}

/** 校验通过后的派活计划：后面的写入只用这里的对象，不再回头查。 */
interface AssignPlan {
  chief: Bot;
  wake: WakeTicket;
  agreement: Agreement;
  executor: Bot;
  reviewer: Bot | null;
  dueAt: number;
  deliveryItems: number[];
  launchStep: boolean;
  note: string | null;
  messageId: string | null;
}

/** 员工此刻在岗（生命周期在岗且未归档）。 */
export function onDuty(bot: Bot): boolean {
  return (ON_TEAM_LIFECYCLES as readonly string[]).includes(bot.lifecycle) && !botIsArchived(bot);
}

/** 通用校验：调用者是总管，回合由主人发起。返回总管和本回合的唤醒单。 */
function assertChiefOwnerTurn(ctx: HubContext, tc: ToolContext, action: string): { chief: Bot; wake: WakeTicket } {
  const chief = ctx.store.table('bots').get(tc.botId);
  if (!chief || chief.role !== 'chief') throw new Error(`只有总管能${action}`);
  const wake = wakeOfToolContext(ctx, tc);
  if (!wake || wake.ownerInitiated !== true) throw new Error(`${action}只能在主人发话、确认或回答叫醒的回合里进行`);
  return { chief, wake };
}

/** 缺几项一次列全。 */
export function assertFilled(args: JobManageArgs, keys: readonly (keyof JobManageArgs)[]): void {
  const missing = keys.filter(key => args[key] === undefined);
  if (missing.length > 0) throw new Error(`缺少必填项：${missing.join('、')}（mode 为 ${args.mode} 时都要填写）`);
}

/** 找执行者：写名字或机器人 id；必须在岗、不是总管。 */
export function resolveExecutor(ctx: HubContext, chief: Bot, ref: string): Bot {
  const bot = resolveBotRef(ctx, ref, 'executor', chief.id);
  if (bot.role === 'chief') throw new Error('executor：总管不能当执行者，请写在岗员工的名字');
  if (!onDuty(bot)) throw new Error(`executor：「${bot.name}」当前不在岗`);
  return bot;
}

/** 找核对人：省略或整句是「总管」为 null；否则必须在岗、不是总管、不是执行者。 */
export function resolveReviewer(ctx: HubContext, chief: Bot, ref: string | undefined, executor: Bot): Bot | null {
  if (ref === undefined || ref.trim() === '总管') return null;
  const bot = resolveBotRef(ctx, ref, 'reviewer', chief.id);
  if (bot.id === executor.id) throw new Error('reviewer：核对人不能是执行者本人');
  if (bot.role === 'chief') throw new Error('reviewer：由你自己核对时写「总管」');
  if (!onDuty(bot)) throw new Error(`reviewer：「${bot.name}」当前不在岗`);
  return bot;
}

/** 约定所在项目的文件夹是否可用：项目存在、未归档。返回项目。 */
function requireProject(ctx: HubContext, agreement: Agreement) {
  const project = ctx.store.table('projects').get(agreement.projectId);
  if (!project || project.archivedAt !== null) throw new Error(`约定「${agreement.title}」所在的项目已归档，不能派活`);
  normalizeProjectSharedDir(ctx, project.sharedDir);
  return project;
}

// ---------------------------------------------------------------------------
// assign：第一段校验
// ---------------------------------------------------------------------------

/** 全部校验，不写任何东西。 */
function planAssign(ctx: HubContext, tc: ToolContext, args: JobManageArgs): AssignPlan {
  const { chief, wake } = assertChiefOwnerTurn(ctx, tc, '派活');
  // P74r9：launchStep 不再必填（由约定里的对外发布一项决定），填了只做一致性检查。
  assertFilled(args, ['agreementId', 'executor', 'dueAt']);
  // 3. 约定：存在、是你的、没有被撤下。
  const agreement = ctx.store.table('agreements').get(args.agreementId!);
  if (!agreement || agreement.botId !== chief.id || agreement.state === 'withdrawn') {
    throw new Error('agreementId：只能为你名下已固定的约定派活');
  }
  // 4. 一份约定同一时刻只有一件进行中的事。
  const existing = jobOfAgreement(ctx, agreement.id);
  if (existing !== null && existing.state !== 'stopped') {
    const who = ctx.store.table('bots').get(existing.executorId)?.name ?? '另一位员工';
    throw new Error(`这份约定已经交给${who}了（jobId 为 ${existing.id}），要换人用 mode reassign`);
  }
  // 5. 闸门：约定待确认，或有为它加人的组队卡在等主人。
  const blocked = dispatchBlockFor(ctx, chief.id, agreement.id);
  if (blocked !== null) throw new Error(blocked);
  if (agreement.state !== 'locked') throw new Error('agreementId：只能为你名下已固定的约定派活');
  const project = requireProject(ctx, agreement);
  // 6、7. 执行者和核对人。
  const executor = resolveExecutor(ctx, chief, args.executor!);
  const reviewer = resolveReviewer(ctx, chief, args.reviewer, executor);
  // 8. 交付时间晚于现在；交付时核对的条目序号在范围内、不重复。
  const dueAt = parseFlexibleTime(args.dueAt!, 'Asia/Shanghai');
  if (dueAt === null) throw new Error('dueAt：时间必须是有效的 ISO 时间或 YYYY-MM-DD HH:mm（北京时间）');
  if (dueAt <= ctx.clock.now()) throw new Error('dueAt：交付时间必须晚于现在');
  const doneCount = lockedVersionOf(agreement).content.doneWhen.length;
  const items = args.deliveryItems ?? [];
  // P74r2c：序号校验与执行中改约定共用同一份（job/item-remap.ts），文字不变。
  // P74r7：再按条目原文检查，只有写了时间的条目才能算「交付时核对」。
  checkDeliveryItems(items, doneCount, lockedVersionOf(agreement).content.doneWhen);
  // 项目成员席位：加上这两位之后不能超过上限（写入时的检查只是兜底）。
  const wanted = [executor.id, ...(reviewer ? [reviewer.id] : [])].filter(id => !project.memberBotIds.includes(id));
  if (project.memberBotIds.length + new Set(wanted).size > V2_DEFAULTS.PROJECT_MEMBER_MAX) {
    throw new Error(`项目成员已满（上限 ${V2_DEFAULTS.PROJECT_MEMBER_MAX} 位），不能再加入执行者和核对人`);
  }
  // 9. 同一条主人消息只能派一次（主人直聊没有消息 id 时按唤醒单去重）。
  const message = ownerMessageOfWake(ctx, wake);
  const duplicated = ctx.store.log('jobEvents').all().some(event => event.kind === 'assigned' && event.actor === chief.id
    && (message !== null ? event.data.sourceMessageId === message.id : event.data.wakeId === wake.id));
  if (duplicated) throw new Error('主人的这句话已经派过一件事了，同一句话只派一次；要换人用 mode reassign');
  // P74r9：这件事有没有发布这一步，只由已固定的那一版约定里的对外发布一项决定；总管填了 launchStep 且与约定不一致时拒绝，
  // 免得「约定里说一遍、派活参数再说一遍」两遍对不上（真实模型曾因此约定写了发布、参数却填了 false，验收后什么都没发生）。
  const launchStep = launchOf(lockedVersionOf(agreement).content) !== null;
  if (args.launchStep !== undefined && args.launchStep !== launchStep) {
    throw new Error(`launchStep：不用填。这件事有没有发布这一步，由约定里的对外发布一项决定；这份约定${launchStep ? '写了对外发布' : '没有写对外发布'}。要改，先改约定请主人确认。`);
  }
  return { chief, wake, agreement, executor, reviewer, dueAt, deliveryItems: items, launchStep,
    note: args.note ?? null, messageId: message?.id ?? null };
}

// ---------------------------------------------------------------------------
// assign：第二段（状态写入）与第三段（主人看得见的话）
// ---------------------------------------------------------------------------

/**
 * 开工：严格按顺序写入，任何一步失败全部恢复并抛出失败原因。
 * 1 写 Job；2 加成员；3 建文件夹和三份文件；4 预先生成事件 id；5 给执行者入队；6 追加 assigned 事件。
 */
async function startJob(ctx: HubContext, plan: AssignPlan): Promise<{ job: Job; eventId: string }> {
  const { chief, agreement, executor, reviewer } = plan;
  const now = ctx.clock.now();
  const version = lockedVersionOf(agreement);
  const jobId = newId('job', ctx.rng);
  const firstLockedAt = agreement.versions.find(row => row.lockedAt !== null)?.lockedAt ?? now;
  const job = JobSchema.parse({
    id: jobId, chiefId: chief.id, agreementId: agreement.id, projectId: agreement.projectId, topicId: agreement.topicId,
    folder: `${D.FOLDER_ROOT}/${jobId}`, state: 'ready', executorId: executor.id, reviewerId: reviewer?.id ?? null,
    dueAt: plan.dueAt, deliveryItems: plan.deliveryItems, launchStep: plan.launchStep, stage: 1, round: 0,
    blocked: null, pause: null, openAsk: null, unmet: [], turnsUsed: 0, turnCap: initialTurnCap(ctx, agreement.id),
    launch: { state: 'none', approvalId: null, link: null }, inboxId: null, handledVersionNo: version.no, firstLockedAt,
    // P74r4a：派活之前这份约定已经让主人处理过的条目（约定确认、组队卡）算作「打扰你」的起点，之后每建一条加一（job/disturb.ts）。
    disturbCount: initialDisturbCount(ctx, agreement.id),
    assignedAt: now, startedAt: null, deliveredAt: null, acceptedAt: null, stoppedAt: null, createdAt: now, updatedAt: now,
  });
  // 备份：成员与文件夹路径在做之前就准备好，恢复时用。
  const undo: Array<() => void | Promise<void>> = [];
  let eventId = '';
  try {
    // 1. 一件事的记录。
    putJob(ctx, job);
    undo.push(() => { ctx.store.table('jobs').remove(job.id); });
    // 2. 项目成员（只改成员名单，不走 saveProject）。
    const added = addProjectMembers(ctx, job.projectId, [executor.id, ...(reviewer ? [reviewer.id] : [])], chief.id, { byJob: job.id });
    undo.push(() => removeProjectMembers(ctx, job.projectId, added, chief.id, { byJob: job.id, recovered: true }));
    // 3. 主题文件夹、三个子文件夹、三份文件。
    const { projectDir, jobDir } = jobFolderPaths(ctx, job);
    undo.push(() => ctx.fs.remove(jobDir, { within: projectDir }));
    await writeJobFiles(ctx, job);
    // 4. 预先生成事件 id（日志本身排在最后才追加）。
    eventId = newId('jev', ctx.rng);
    // 5. 给执行者入队；入队不成功（执行者此刻已不在岗等）视为失败。
    // P74c：统一入队。执行链候选带 jobId，闸门按「执行链唤醒」处理（越过冷却、最短思考间隔与自主预算），不再靠 chiefDispatch。
    const wake = enqueueJobWakeUndoable(ctx, {
      job, botId: executor.id, why: 'assigned', eventId,
      summary: `总管交来一件事：${agreement.title}${plan.note === null ? '' : `。交代：${plan.note}`}`,
    });
    undo.push(wake.undo);
    if (wake.entry === null) throw new Error(`没有排上${executor.name}的队（他此刻可能已不在岗，或这次提醒被合并丢弃）`);
    // 6. 入队成功后才追加 assigned 事件。
    appendJobEvent(ctx, {
      id: eventId, jobId: job.id, actor: chief.id, kind: 'assigned',
      to: [executor.id, ...(reviewer ? [reviewer.id] : [])], refId: agreement.id,
      data: { versionNo: version.no, sourceMessageId: plan.messageId, wakeId: plan.wake.id, ...(plan.note === null ? {} : { note: plan.note }) },
    });
  } catch (error) {
    // 恢复：从后往前撤销已做的步骤；撤销本身出错只记日志，保证剩下的步骤仍会执行。
    for (const step of undo.reverse()) {
      try { await step(); } catch (undoError) { ctx.logger.warn('派活恢复时某一步没有撤销成功', { jobId: job.id, error: String(undoError) }); }
    }
    ctx.emit(HUB_EVENT_SCOPES.project, null);
    ctx.emit(HUB_EVENT_SCOPES.bot, executor.id);
    throw new Error(`派活失败，已恢复到派活前的状态：${error instanceof Error ? error.message : String(error)}`);
  }
  // P76e：对齐这一步的回合与 token 记进这件事的用量（出错只记日志，不影响派活）。
  recordAlignment(ctx, job);
  writeOutreachAudit(ctx, 'job_assign', { jobId: job.id, agreementId: agreement.id, executor: executor.id, reviewer: reviewer?.id ?? null }, chief.id, now);
  ctx.emit(HUB_EVENT_SCOPES.bot, executor.id);
  ctx.emit(HUB_EVENT_SCOPES.project, null);
  return { job, eventId };
}

/**
 * P76e：派活时这件事的预算线（回合上限）：这份约定有固定时算出的预计（lock，含你之后追加、缩小范围算的）时，
 * 等于「预计总数减去已用的对齐回合」，至少 1；没有预计（旧数据、计算失败）时仍用原来固定的回合数。
 * 在建记录时直接算好，不另调 setJobBudget（那是给之后的改动用的，见 budget-line.ts）。
 */
function initialTurnCap(ctx: HubContext, agreementId: string): number {
  try {
    const estimate = latestEstimate(ctx, agreementId);
    if (estimate !== null) return Math.max(1, estimate.total - estimate.steps.align);
    ctx.logger.warn('派活时这份约定没有预计消耗，预算线沿用默认回合数', { agreementId });
  } catch (error) {
    ctx.logger.warn('派活时读预计消耗失败，预算线沿用默认回合数', { agreementId, error: String(error) });
  }
  return D.TURN_CAP;
}

/** 第三段的一步：出错只记日志。 */
function softly(ctx: HubContext, what: string, work: () => void): void {
  try { work(); } catch (error) { ctx.logger.warn(`派活收尾失败：${what}`, { error: String(error) }); }
}

/** 主题里总管那句话（给主人看，不含工具名与内部编号）。 */
export function assignedTopicText(ctx: HubContext, executor: Bot, reviewer: Bot | null, versionNo: number): string {
  const checker = reviewer === null ? '我在交付前对照约定核对' : `${reviewer.name}在交付前对照约定核对`;
  // P74r9 第 5 节：括号里写岗位名称（「工程师」），不写岗位类别（「执行」会读成「（执行）执行」）；没有岗位名称时不写括号。
  const post = staffPostName(ctx, executor);
  return `这件事由${withLabel(executor.name, post)}执行，${checker}。我已把你的原话、草图和约定第 ${versionNo} 版作为文件交给${executor.name}。`;
}

/** 派活后主人看得见的三句话：主题里总管一句、总管私聊中心提示一句、主题里工作往来一条。 */
function announceAssigned(ctx: HubContext, plan: AssignPlan, job: Job, eventId: string): void {
  const { chief, agreement, executor, reviewer } = plan;
  const versionNo = lockedVersionOf(agreement).no;
  softly(ctx, '主题里的话', () => {
    postThread(ctx, { thread: agreement.topicId, from: chief.id, kind: 'reply', refId: job.id, text: assignedTopicText(ctx, executor, reviewer, versionNo) });
  });
  softly(ctx, '总管私聊里的提示', () => {
    postThread(ctx, { thread: chief.id, from: 'hub', kind: 'system', refId: job.id, text: `${executor.name}接手「${agreement.title}」，进展记在这件事的主题里。` });
  });
  softly(ctx, '工作往来', () => {
    postThread(ctx, { thread: agreement.topicId, from: 'hub', kind: 'work', refId: eventId,
      text: `总管把这件事交给${executor.name}：约定第 ${versionNo} 版、你的原话和草图在主题文件夹里。` });
  });
}

/** P74r10：派活成功后，有对外发布这一步的事在返回文字后追加的一句（逐字）。 */
export const ASSIGNED_LAUNCH_NOTE = '这件事验收之后还有对外发布这一步，到时中心会单独请主人批准；对主人说明安排时把这一步说上。';

/** assign 的入口：返回给模型看的一句话。 */
export async function runJobAssign(ctx: HubContext, tc: ToolContext, args: JobManageArgs): Promise<string> {
  const plan = planAssign(ctx, tc, args);
  const { job, eventId } = await startJob(ctx, plan);
  // P75e 第 7 节：接到同类的事时自动放回这位执行者收起原因为「久未用」的同类技能；出错只记日志，不影响派活结果。
  try { await restoreCollapsedForCategory(ctx, plan.executor.id, jobCategory(ctx, job.id)); }
  catch (error) { ctx.logger.warn('派活后放回同类技能失败', { jobId: job.id, error: String(error) }); }
  // P75r5c（审查 M4、第 5 节第 3 条）：核对人（有评审员时是评审员，没有时是总管自己）的同类技能也放回，
  // 让活动流「下次接到同类的事自动放回」这句对核对人的技能也成立；与执行者是同一人时上面已经放回，不重复。
  const checkerId = plan.reviewer?.id ?? plan.chief.id;
  if (checkerId !== plan.executor.id) {
    try { await restoreCollapsedForCategory(ctx, checkerId, jobCategory(ctx, job.id)); }
    catch (error) { ctx.logger.warn('派活后放回核对人的同类技能失败', { jobId: job.id, error: String(error) }); }
  }
  announceAssigned(ctx, plan, job, eventId);
  const base = `已派给${plan.executor.name}，${plan.reviewer === null ? '你自己' : plan.reviewer.name}核对。`;
  // P74r10：这件事验收之后还有对外发布这一步（照约定的 launch）时，提醒总管对主人说明安排时把这一步说上；
  // 没有对外发布的事返回文字不变。
  return plan.launchStep ? `${base}${ASSIGNED_LAUNCH_NOTE}` : base;
}


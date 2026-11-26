/**
 * 初始化三问（P73c，方案 4.2）：启动时开始三问，处理点选、打字、选择文件夹三种回答。
 *
 * 全程不调用模型、不排任何唤醒：问题和选项来自规则表（rules.ts 的 TEAM_QUESTIONS），
 * 回答用关键词表匹配，推荐名单也是按表取。主人在总管私聊打的字，三问期间当作当前问题的回答。
 *
 * 为什么有「异步收尾」：选「有项目」要建项目、建目录、写项目背景，答完第三问要读模型目录，
 * 这些都要异步；而 sendOwnerMessage 是同步函数。所以打字回答里不需要异步的（第一问、第二问选「没有」）当场处理，
 * 需要异步的（第二问给路径、第三问）交给异步任务，由界面命令 sendMessage 等它做完（settleTeamSetup）。
 */
import { posix } from 'node:path';
import { z } from 'zod';
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import type { HubContext } from '../engine/context.js';
import { parseInput } from '../engine/validation.js';
import type { Bot } from '../model/bot.js';
import type { ThreadMessage } from '../model/outreach.js';
import { recordId } from '../model/primitives.js';
import { TEAM_DEFAULTS as D } from '../config/defaults.js';
import { updateProjectBackgroundByOwner } from '../project/context-service.js';
import { saveProject } from '../project/service.js';
import { ensureProjectSharedDir } from '../project/shared-dir.js';
import { postThread } from '../outreach/thread.js';
import { newId } from '../util/ids.js';
import { TeamSetupSchema, type TeamAnswers, type TeamSetup } from '../model/team-proposal.js';
import { createInitialProposal } from './proposals.js';
import { isAwaitingPick } from './pick-key.js';
import { pickFallbackReason, requestChiefPick } from './pick-request.js';
import { ackText, matchTypedAnswer, TEAM_OPENING_TEXT, TEAM_QUESTIONS, type TeamStep } from './rules.js';
import { freeTemplateName } from './templates.js';
import { liveBots, liveChief } from './roster.js';
import { pendingOwnerConfirmOf } from './owner-confirm.js';
import { CHIEF_ASKING_TEXT, saveSetup, setChiefActivityText } from './setup-state.js';

/** 主人打字没有对上第二问的任何一种说法时，总管的重问句。 */
export const TEAM_REASK_TEXT = '请点选上面的选项，或写下项目文件夹的完整路径。';
/** 第二问选「有」之后接在「已记下」后面的句子：只说事实，不承诺立刻让员工熟悉项目。 */
export const TEAM_PROJECT_NOTE = '它的位置已写进项目背景。';

// ---------------------------------------------------------------------------
// 启动时开始三问
// ---------------------------------------------------------------------------

/**
 * 启动时调用：没有任何三问记录、且有总管时才动。
 * - 除总管外已有未归档的员工：记一条 skipped，不发任何消息（三问是为空团队设计的）；
 * - 否则记一条 asking、第 1 问，在总管私聊落开场白和第一问，总管状态行写明在提问。
 */
export async function ensureTeamSetup(ctx: HubContext): Promise<TeamSetup | null> {
  if (ctx.store.table('teamSetups').count() > 0) return null;
  const chief = liveChief(ctx);
  if (chief === null) return null;
  const now = ctx.clock.now();
  const others = liveBots(ctx).filter(bot => bot.id !== chief.id);
  const base = {
    id: newId('tsu', ctx.rng), chiefId: chief.id, step: 1 as const, proposalId: null, createdAt: now, updatedAt: now,
    answers: { work: null, workText: null, hasProject: null, projectId: null, projectFolder: null, notify: null },
  };
  if (others.length > 0) {
    const skipped = TeamSetupSchema.parse({ ...base, state: 'skipped', questionMessageIds: [] });
    ctx.store.table('teamSetups').put(skipped);
    return skipped;
  }
  const setup = TeamSetupSchema.parse({ ...base, state: 'asking', questionMessageIds: [] });
  ctx.store.table('teamSetups').put(setup);
  postThread(ctx, { thread: chief.id, from: chief.id, kind: 'chat', text: TEAM_OPENING_TEXT });
  const first = postQuestion(ctx, setup, 1);
  setChiefActivityText(ctx, chief.id, CHIEF_ASKING_TEXT);
  return saveSetup(ctx, setup, { questionMessageIds: [first.id] });
}

/** 落一问：消息类别 team_question，refId 指向三问记录，正文是问题原文（旧界面也能看懂）。 */
function postQuestion(ctx: HubContext, setup: TeamSetup, step: TeamStep): ThreadMessage {
  return postThread(ctx, { thread: setup.chiefId, from: setup.chiefId, kind: 'team_question', text: TEAM_QUESTIONS[step - 1]!.question, refId: setup.id });
}

// ---------------------------------------------------------------------------
// 作答
// ---------------------------------------------------------------------------

/** 一次作答整理后的样子：选项值，以及打字、文件夹、项目的附带信息。 */
interface Resolved {
  value: string;
  /** 主人是打字回答的（打字时主人自己的消息已经在线程里，不再替他落一条）。 */
  typed: boolean;
  fallback?: boolean;
  typedText?: string;
  folderPath?: string;
}

/** 第二问选「有」建好的项目。 */
interface SetupProject { projectId: string; name: string; folderName: string; folderPath: string }

/** 这一问有没有答过：看答案是否已写入，而不是只看 step（第三问答完后 step 不再前进）。 */
function isAnswered(setup: TeamSetup, step: TeamStep): boolean {
  if (step === 1) return setup.answers.work !== null;
  if (step === 2) return setup.answers.hasProject !== null;
  return setup.answers.notify !== null;
}

/** 正在异步处理的三问记录 id：同一个三问同时只处理一个回答。 */
const inflight = new WeakMap<HubContext, Set<string>>();
/** 异步收尾任务：界面命令等它们做完再返回。 */
const pending = new WeakMap<HubContext, Set<Promise<void>>>();

function track(ctx: HubContext, work: Promise<void>): void {
  const set = pending.get(ctx) ?? new Set<Promise<void>>();
  pending.set(ctx, set);
  const tracked = work.finally(() => { set.delete(tracked); });
  set.add(tracked);
}

/** 等所有异步收尾任务做完（界面命令 sendMessage 和测试用；任务出错已在任务内部处理）。 */
export async function settleTeamSetup(ctx: HubContext): Promise<void> {
  while ((pending.get(ctx)?.size ?? 0) > 0) await Promise.all([...pending.get(ctx)!]);
}

/** 路径取文件夹名：去掉末尾斜杠后的最后一段；空时用「我的项目」。 */
function folderNameOf(folderPath: string): string {
  const name = posix.basename(posix.normalize(folderPath).replace(/\/+$/, ''));
  return name === '' || name === '.' ? '我的项目' : name;
}

/**
 * 第二问选「有」：建项目（名称取文件夹名，与现有项目重名时加序号；负责人和成员都是总管），
 * 建共享目录，再把「项目文件夹：路径」写进项目背景。外部文件夹只记录路径，项目目录仍在中心根目录下。
 * 任何一步失败：已建的项目撤掉，抛错，三问不前进。
 */
async function createSetupProject(ctx: HubContext, chief: Bot, folderPath: string): Promise<SetupProject> {
  if (!posix.isAbsolute(folderPath)) throw new Error('folderPath：项目文件夹必须是完整路径（以 / 开头）');
  const folderName = folderNameOf(folderPath);
  const taken = ctx.store.table('projects').list(project => project.archivedAt === null).map(project => project.name);
  const name = [...freeTemplateName([...folderName].slice(0, 100).join(''), taken)].slice(0, 120).join('');
  const project = saveProject(ctx, { name, charter: '', memberBotIds: [chief.id], ownerBotId: chief.id }, chief.id);
  try {
    await ensureProjectSharedDir(ctx, project);
    await updateProjectBackgroundByOwner(ctx, chief.id, { projectId: project.id, background: `项目文件夹：${folderPath}` });
  } catch (error) {
    ctx.store.table('projects').remove(project.id);
    ctx.emit(HUB_EVENT_SCOPES.project, null);
    throw error;
  }
  return { projectId: project.id, name, folderName, folderPath };
}

/**
 * 记下一次回答（同步）：落主人消息（点选时）、总管的「已记下」、下一问，并保存答案。
 * 第三问答完不在这里生成组队卡（那是异步的），由调用方接着调用 createInitialProposal。
 */
function recordAnswer(ctx: HubContext, setup: TeamSetup, resolved: Resolved, project: SetupProject | null): TeamSetup {
  const step = setup.step;
  const question = TEAM_QUESTIONS[step - 1]!;
  const chiefId = setup.chiefId;
  // 点选时中心代主人落一条消息（选项原文）；打字时主人自己的话已经在线程里。
  if (!resolved.typed) {
    const label = question.options.find(option => option.value === resolved.value)?.label ?? resolved.value;
    const ownerText = step === 2 && resolved.value === 'yes' && project !== null ? `有，项目文件夹：${project.folderName}` : label;
    // P74r6（复验疑点 2）：这条是中心代主人落的，带上三问记录的编号：没有编号的主人消息会被「停止的依据」那条规则当作主人亲口说的话。
    // postThread 只落消息、不叫醒任何人（叫醒总管是 sendOwnerMessage 的事，三问进行中它也不叫），所以这条消息不会叫醒总管。
    postThread(ctx, { thread: chiefId, from: 'owner', kind: 'chat', text: ownerText, refId: setup.id });
  }
  const ack = ackText(step, { value: resolved.value, projectName: project?.name, typedText: resolved.typedText, fallback: resolved.fallback });
  postThread(ctx, { thread: chiefId, from: chiefId, kind: 'chat', text: step === 2 && resolved.value === 'yes' ? `${ack}${TEAM_PROJECT_NOTE}` : ack });
  // 保存答案。
  const answers: TeamAnswers = { ...setup.answers };
  if (step === 1) {
    answers.work = resolved.value as NonNullable<TeamAnswers['work']>;
    answers.workText = resolved.typedText === undefined ? null : [...resolved.typedText.trim()].slice(0, D.WORK_TEXT_MAX_CHARS).join('');
  } else if (step === 2) {
    answers.hasProject = resolved.value === 'yes';
    answers.projectId = project?.projectId ?? null;
    answers.projectFolder = project?.folderPath ?? null;
  } else {
    answers.notify = resolved.value as NonNullable<TeamAnswers['notify']>;
  }
  if (step === 3) return saveSetup(ctx, setup, { answers });
  // 前进到下一问。
  const nextStep = (step + 1) as TeamStep;
  const next = postQuestion(ctx, setup, nextStep);
  return saveSetup(ctx, setup, { answers, step: nextStep, questionMessageIds: [...setup.questionMessageIds, next.id] });
}

/** 总管名义落一句话（重问句、出错说明）。 */
function chiefSays(ctx: HubContext, setup: TeamSetup, text: string): void {
  postThread(ctx, { thread: setup.chiefId, from: setup.chiefId, kind: 'chat', text });
}

const AnswerInputSchema = z.strictObject({
  setupId: recordId('tsu'),
  step: z.union([z.literal(1), z.literal(2), z.literal(3)], { error: 'step：问题序号必须是 1、2、3 之一' }),
  choice: z.string({ error: 'choice：必须是文字' }).min(1, 'choice：不能为空').optional(),
  text: z.string({ error: 'text：必须是文字' }).min(1, 'text：不能为空').optional(),
  folderPath: z.string({ error: 'folderPath：必须是文字' }).min(1, 'folderPath：不能为空').optional(),
}).superRefine((value, ctx) => {
  if ((value.choice === undefined) === (value.text === undefined)) {
    ctx.addIssue({ code: 'custom', path: ['choice'], message: 'choice 和 text 必须恰好给一个' });
  }
  if (value.choice === 'yes' && value.step === 2 && value.folderPath === undefined) {
    ctx.addIssue({ code: 'custom', path: ['folderPath'], message: '第二问选「有」时必须给出项目文件夹' });
  }
});

/**
 * 界面命令：回答一问。校验在任何写入之前：记录存在、正在提问、就是当前这一问、没答过。
 * 打字没对上（第二问）时总管重问一句，不前进。第三问答完生成初始组队卡。
 */
export async function answerTeamQuestion(ctx: HubContext, raw: unknown): Promise<{ setupId: string; step: number }> {
  const input = parseInput(AnswerInputSchema, raw, '三问作答');
  const setup = ctx.store.table('teamSetups').get(input.setupId);
  if (!setup) throw new Error('setupId：三问记录不存在');
  if (setup.state !== 'asking' || setup.step !== input.step || isAnswered(setup, input.step)) throw new Error('这个问题已经回答过了');
  const busy = inflight.get(ctx) ?? new Set<string>();
  inflight.set(ctx, busy);
  if (busy.has(setup.id)) throw new Error('这个问题已经回答过了');
  const question = TEAM_QUESTIONS[input.step - 1]!;
  let resolved: Resolved;
  if (input.choice !== undefined) {
    if (!question.options.some(option => option.value === input.choice)) throw new Error('choice：不是这一问的选项');
    resolved = { value: input.choice, typed: false, folderPath: input.folderPath };
  } else {
    const typed = matchTypedAnswer(input.step, input.text!);
    if (typed === null) {
      chiefSays(ctx, setup, TEAM_REASK_TEXT);
      return { setupId: setup.id, step: setup.step };
    }
    resolved = { value: typed.value, typed: true, fallback: typed.fallback, typedText: input.step === 1 ? input.text! : undefined, folderPath: typed.folderPath };
  }
  busy.add(setup.id);
  try {
    await finishAnswer(ctx, setup, resolved);
  } finally {
    busy.delete(setup.id);
  }
  return { setupId: setup.id, step: ctx.store.table('teamSetups').get(setup.id)?.step ?? setup.step };
}

/** 作答的收尾：需要时先建项目，再记录答案，第三问答完再生成组队卡。项目建失败时抛错，三问不前进。 */
async function finishAnswer(ctx: HubContext, setup: TeamSetup, resolved: Resolved): Promise<void> {
  const chief = ctx.store.table('bots').get(setup.chiefId);
  if (!chief) throw new Error('总管不存在，无法继续提问');
  const project = setup.step === 2 && resolved.value === 'yes' ? await createSetupProject(ctx, chief, resolved.folderPath!) : null;
  const saved = recordAnswer(ctx, setup, resolved, project);
  ctx.emit(HUB_EVENT_SCOPES.thread, setup.chiefId);
  // W11：第三问答完不再直接查表，而是请总管按项目挑人；总管没能出卡时由 sweepTeamSetup 按规则表兜底。
  if (setup.step === 3) await startPick(ctx, saved);
}

/**
 * 第三问答完：在册没有空位（推荐 0 位）时不必请总管，直接走原来的固定句；
 * 其余情况请总管挑人。读模型目录在 createInitialProposal 里，这里不用等。
 */
async function startPick(ctx: HubContext, setup: TeamSetup): Promise<void> {
  if (liveBots(ctx).length >= ctx.settings.maxBots) {
    await createInitialProposal(ctx, setup);
    return;
  }
  requestChiefPick(ctx, setup);
}

// ---------------------------------------------------------------------------
// 打字作答（供 sendOwnerMessage 调用）
// ---------------------------------------------------------------------------

/**
 * 主人在某个线程里发了一句话：若它是总管私聊、且三问正在进行，就当作当前问题的回答，返回 true（调用方不排唤醒）。
 * 同步函数；任何异常都捕获后记日志并返回 false（此时照原流程排唤醒，不吞主人的话）。
 * 第二问给路径、第三问需要异步收尾：交给异步任务，出错时总管说明原因，三问不前进。
 */
export function typedSetupAnswer(ctx: HubContext, threadId: string, message: ThreadMessage): boolean {
  try {
    const setup = currentAskingSetup(ctx, threadId);
    if (setup === null) return false;
    const busy = inflight.get(ctx) ?? new Set<string>();
    inflight.set(ctx, busy);
    if (busy.has(setup.id)) return false;
    const typed = matchTypedAnswer(setup.step, message.text);
    if (typed === null) {
      chiefSays(ctx, setup, TEAM_REASK_TEXT);
      return true;
    }
    const resolved: Resolved = { value: typed.value, typed: true, fallback: typed.fallback,
      typedText: setup.step === 1 ? message.text : undefined, folderPath: typed.folderPath };
    if (setup.step === 1 || (setup.step === 2 && resolved.value === 'no')) {
      recordAnswer(ctx, setup, resolved, null);
      ctx.emit(HUB_EVENT_SCOPES.thread, setup.chiefId);
      return true;
    }
    // 需要异步收尾：第二问给路径（建项目）、第三问（读模型目录、生成组队卡）。
    busy.add(setup.id);
    track(ctx, finishAnswer(ctx, setup, resolved)
      .catch(error => {
        ctx.logger.error('三问打字作答失败', error);
        const reason = error instanceof Error ? error.message : String(error);
        chiefSays(ctx, setup, `这个回答没能记下：${reason}。请换一个说法，或点选上面的选项。`);
      })
      .finally(() => { busy.delete(setup.id); }));
    return true;
  }
  catch (error) {
    ctx.logger.error('三问打字作答失败', error);
    return false;
  }
}

/** 这个线程是总管私聊、且三问正在提问、当前问题还没答，返回三问记录；否则 null。 */
function currentAskingSetup(ctx: HubContext, threadId: string): TeamSetup | null {
  const setup = ctx.store.table('teamSetups').list(row => row.chiefId === threadId)[0];
  if (!setup || setup.state !== 'asking' || isAnswered(setup, setup.step)) return null;
  return setup;
}

/**
 * tick 兜底：三问全部答完却没有生成组队卡（例如读模型目录时出错）的，补生成。
 * 同步入口，生成本身是异步任务，交给 track；出错只记日志，下一个 tick 再试。
 */
export function sweepTeamSetup(ctx: HubContext): void {
  for (const setup of ctx.store.table('teamSetups').list(row => row.state === 'asking' && row.proposalId === null && row.answers.notify !== null)) {
    if (inflight.get(ctx)?.has(setup.id)) continue;
    // W11：正在等总管挑人的，只在该兜底时才按规则表出卡；兜底原因写进结论句。
    const fallback = isAwaitingPick(setup) ? pickFallbackReason(ctx, setup) : undefined;
    if (fallback === null) continue;
    // P73r3 S3：有一种卡待确认（约定卡或组队卡）时不补发组队卡；等它确认或撤下后再补。
    if (pendingOwnerConfirmOf(ctx, setup.chiefId) !== null) continue;
    const busy = inflight.get(ctx) ?? new Set<string>();
    inflight.set(ctx, busy);
    busy.add(setup.id);
    track(ctx, createInitialProposal(ctx, setup, fallback === undefined ? {} : { fallback }).then(() => undefined)
      .catch(error => { ctx.logger.error(`三问 ${setup.id} 补生成组队卡失败`, error); })
      .finally(() => { busy.delete(setup.id); }));
  }
}

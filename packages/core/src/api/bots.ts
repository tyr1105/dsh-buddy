/** 主人创建和管理机器人；显式生命周期转换阻止退役复活、绕过试岗和机器人自行解除隔离。 */
import { posix } from 'node:path';
import { z } from 'zod';
import type { HubContext } from '../engine/context.js';
import { BotSchema, AspirationSchema } from '../model/bot.js';
import { LifecycleSchema, type Bot, type Lifecycle } from '../model/index.js';
import { nonempty } from '../model/primitives.js';
import { newId } from '../util/ids.js';
import { createBotHome, refreshBotFiles } from '../memory/files.js';
import { buildCandidate } from '../appraisal/think.js';
import { enqueue, removeEntry } from '../scheduler/queue.js';
import { syncFileWatches } from '../perception/files.js';
import { validateCommand } from '../perception/script.js';
import { writeOutreachAudit } from '../outreach/audit.js';
import { postThread } from '../outreach/thread.js';
import { closeAlert } from '../health/alerts.js';
import { syncAlertItems } from '../outreach/alerts.js';
import { CreateBotSchema, ProfilePatchSchema } from './schemas.js';
import { normalizePresetSkillIds, unknownPresetSkillIds } from '../config/preset-skills.js';
import { syncPresetSkills } from '../memory/preset-skills.js';
import { saveBotMbti } from '../personality/profile.js';
import { composePersona, DEFAULT_ASPIRATION_BY_ROLE } from '../config/persona-choices.js';
import { input, requireBot } from './common.js';
import { makeGoal, makeWatch } from './entities.js';
import { validateModelChoice } from './models.js';
import { HUB_EVENT_SCOPES } from './event-scopes.js';

const ROLE_COLORS = { chief: '#75634E', researcher: '#427C9D', executor: '#54836B', sentinel: '#9B6B45', advisor: '#7A6A9B' };
/** 建议风格只提意见不动手：自主等级不能超过 L1，否则角色和权限互相矛盾。 */
function checkAdvisorAutonomy(role: Bot['role'], autonomy: Bot['autonomy']): void {
  if (role === 'advisor' && (autonomy === 'L2' || autonomy === 'L3')) throw new Error('自主节奏：建议风格只提意见不动手，请选听吩咐或提建议');
}
/** 所有路径都由中心根目录和新 id 生成，外部输入不能替换家目录或宿主会话。 */
export async function createBot(ctx: HubContext, raw: unknown): Promise<Bot> {
  const args = input(CreateBotSchema, raw, '创建机器人');
  if (ctx.store.table('bots').count(row => row.lifecycle !== 'retired') >= ctx.settings.maxBots) throw new Error(`机器人数量已达上限 ${ctx.settings.maxBots} 个`);
  checkNameAndRole(ctx, args.name, args.role);
  const model = args.model === undefined ? ctx.settings.defaultModel : args.model;
  // 目录校验在创建身份和任何写入之前完成；显式 null 仍表示跟随宿主默认模型。
  await validateModelChoice(ctx, model);
  const now = ctx.clock.now();
  const id = newId('b', ctx.rng);
  // P40：预置 skill 只能从内置清单里选；重复 id 去重，未知 id 直接拒绝。
  const presetSkillIds = checkPresetSkillIds(args.presetSkillIds ?? []);
  // P55：听吩咐默认用安静节奏；主人显式传了 pace 时以主人为准。
  const onDemand = args.onDemand ?? false;
  const autonomy = args.autonomy ?? 'L1';
  checkAdvisorAutonomy(args.role, autonomy);
  const temperament = args.temperament ?? null;
  const speechStyle = args.speechStyle ?? null;
  const persona = args.persona ?? composePersona({ name: args.name, role: args.role, temperament, speechStyle });
  const aspirationTexts = args.aspirations ?? [DEFAULT_ASPIRATION_BY_ROLE[args.role]];
  // MBTI 不写进 Bot 本体：旧版本用 strictObject 解析 bots.json，额外字段会让它整体读不出队友。
  const bot = input(BotSchema, { id, name: args.name, role: args.role, persona,
    color: ROLE_COLORS[args.role],
    lifecycle: 'probation', activity: 'watching', activityText: '试岗开始，准备试跑', autonomy, pace: args.pace ?? (onDemand ? 'quiet' : 'normal'),
    model, homeDir: posix.join(ctx.settings.rootDir, 'bots', id),
    sessionId: null, sessionStartedAt: null, createdAt: now, probationStartedAt: now, probationEndsAt: now + ctx.settings.probationMs,
    noChangeStreak: 0, lastThinkAt: null, nextThinkAt: null, nextThinkReason: null, nextThinkBy: null, nextThinkMode: null,
    lightCheckAt: now + ctx.settings.paceMaxIdleMs, expectedBy: null, consecutiveErrors: 0, consecutiveNoCommit: 0, violations: 0,
    retryAt: null, quarantineReason: null, workDataAllowed: false, presetSkillIds,
    dshSkillNames: [...new Set(args.dshSkillNames ?? [])], temperament, speechStyle, brief: args.brief?.trim() ?? '', onDemand, updatedAt: now }, '机器人');
  const aspirations = aspirationTexts.map(text => input(AspirationSchema, { id: newId('asp', ctx.rng), botId: id, text,
    status: 'active', createdBy: 'owner', approved: true, createdAt: now }, '志向'));
  if ((args.watches?.length ?? 0) > ctx.settings.maxWatchesPerBot) throw new Error('关注项数量已达上限');
  const watches = (args.watches ?? []).map(watch => makeWatch(ctx, bot, { ...watch, botId: id }, null));
  const goals = (args.goals ?? []).map(goal => {
    const aspiration = aspirations[goal.aspirationIndex ?? 0];
    if (!aspiration) throw new Error('aspirationIndex：初始目标指定的志向不存在');
    return makeGoal(ctx, { ...goal, botId: id, aspirationId: aspiration.id }, null);
  });
  for (const watch of watches) if (watch.kind === 'script') await validateCommand(ctx, bot, watch.target);
  if (goals.some(goal => goal.status === 'active')) bot.lightCheckAt = now + ctx.settings.paceMaxActiveGoalMs;
  // 全部输入预检成功后才落表；家目录失败则撤回本次新身份，不能留下半个在岗机器人。
  ctx.store.table('bots').put(bot);
  aspirations.forEach(row => ctx.store.table('aspirations').put(row));
  watches.forEach(row => ctx.store.table('watches').put(row));
  goals.forEach(row => ctx.store.table('goals').put(row));
  try {
    await createBotHome(ctx, bot);
    await syncFileWatches(ctx);
  } catch (error) {
    goals.forEach(row => ctx.store.table('goals').remove(row.id));
    watches.forEach(row => ctx.store.table('watches').remove(row.id));
    aspirations.forEach(row => ctx.store.table('aspirations').remove(row.id));
    ctx.store.table('bots').remove(id);
    try { await ctx.fs.remove(bot.homeDir); } catch { ctx.logger.warn('创建失败后的家目录清理未完成', { botId: id }); }
    throw error;
  }
  // 家目录创建成功后再落性格档案，避免试岗启动失败时留下没有机器人的孤儿档案。
  if (args.mbti != null) saveBotMbti(ctx, id, args.mbti);
  enqueue(ctx, buildCandidate(ctx, { botId: id, kind: 'trial', variant: 'trial', score: ctx.settings.c02.ownerSalience,
    summary: '主人创建了你，请试跑并交账', ownerSummary: '新队友开始试跑',
    evidence: aspirations.map(row => row.id), ownerInitiated: true, subjectKey: `trial:${id}` }));
  writeOutreachAudit(ctx, 'lifecycle', { botId: id, from: null, to: 'probation', text: `${bot.name}开始试岗` }, 'owner');
  ctx.emit(HUB_EVENT_SCOPES.bot, id);
  ctx.emit(HUB_EVENT_SCOPES.activity, id);
  return ctx.store.table('bots').get(id)!;
}
/** 预置 skill 只认内置清单：未知 id 拒绝，重复勾选按一次处理，顺序保留主人勾选次序。 */
function checkPresetSkillIds(ids: readonly string[]): string[] {
  const normalized = normalizePresetSkillIds(ids);
  const unknown = unknownPresetSkillIds(normalized);
  if (unknown.length) throw new Error(`预置 skill：没有「${unknown[0]}」这一项，请从清单里重新选择`);
  return normalized;
}
/** 名字跨全部名册唯一；退役档案只保留历史，不占当前队伍和总管名额。 */
function checkNameAndRole(ctx: HubContext, name: string, role: Bot['role'], id?: string): void {
  if (ctx.store.table('bots').count(row => row.id !== id && row.name === name)) throw new Error('name：已有同名机器人，请换一个名字');
  if (role === 'chief' && ctx.store.table('bots').count(row => row.id !== id && row.role === 'chief' && row.lifecycle !== 'retired') >= ctx.settings.maxChiefs)
    throw new Error(`总管最多 ${ctx.settings.maxChiefs} 个`);
}
/** 主人可以调整档案与授权，但无法通过档案修改运行计数、生命周期或会话绑定。 */
export async function updateBot(ctx: HubContext, botId: string, raw: unknown): Promise<Bot> {
  const old = requireBot(ctx, botId);
  // MBTI 不属于 Bot 本体：先拆出来，其余字段仍走原来的整档案校验与保存路径。
  const { mbti, ...patch } = input(ProfilePatchSchema, raw, '档案修改');
  // P40：勾选列表同样只认内置清单，未知 id 在落表前就拒绝。
  if (patch.presetSkillIds !== undefined) patch.presetSkillIds = checkPresetSkillIds(patch.presetSkillIds);
  if (patch.dshSkillNames !== undefined) patch.dshSkillNames = [...new Set(patch.dshSkillNames)];
  if (patch.brief !== undefined) patch.brief = patch.brief.trim();
  // P55：选择题改了就重新拼 persona；主人同时传了 persona 时以传入的为准。
  if ((patch.temperament !== undefined || patch.speechStyle !== undefined) && patch.persona === undefined) {
    patch.persona = composePersona({ name: patch.name ?? old.name, role: patch.role ?? old.role,
      temperament: patch.temperament !== undefined ? patch.temperament : old.temperament,
      speechStyle: patch.speechStyle !== undefined ? patch.speechStyle : old.speechStyle });
  }
  if (old.lifecycle === 'retired') throw new Error('退役机器人不能再修改档案');
  const preview = input(BotSchema, { ...old, ...patch, updatedAt: ctx.clock.now() }, '机器人');
  checkNameAndRole(ctx, preview.name, preview.role, preview.id);
  checkAdvisorAutonomy(preview.role, preview.autonomy);
  // 编辑也重验最终模型，目录移除的型号不能被无关档案修改默默保留。
  await validateModelChoice(ctx, preview.model);
  // 宿主目录读取期间主人仍可打断回合；只把档案字段合入最新状态，不能复活旧会话或覆盖运行计数。
  const current = requireBot(ctx, botId);
  if (current.lifecycle === 'retired') throw new Error('退役机器人不能再修改档案');
  const next = input(BotSchema, { ...current, ...patch, updatedAt: ctx.clock.now() }, '机器人');
  checkNameAndRole(ctx, next.name, next.role, next.id);
  ctx.store.table('bots').put(next);
  // 只有明确传了 mbti 才写档案；null 表示清空，未传表示保持原样。
  if (mbti !== undefined) saveBotMbti(ctx, botId, mbti);
  await syncFileWatches(ctx);
  await refreshBotFiles(ctx, botId);
  // P40：档案保存后同步预置 skill 文件：新勾选的写入，取消勾选的只清理中心写过的文件。
  await syncPresetSkills(ctx, next);
  ctx.emit(HUB_EVENT_SCOPES.bot, botId);
  return next;
}
/** 合法转换表：退役不可逆；隔离只能显式解除，恢复时仍须遵守原试岗期限。 */
export const LIFECYCLE_TRANSITIONS: Readonly<Record<Lifecycle, readonly Lifecycle[]>> = {
  draft: ['probation', 'retired'], probation: ['active', 'paused', 'retired'],
  active: ['paused', 'retired'], paused: ['probation', 'active', 'retired'], quarantined: ['probation', 'active', 'retired'], retired: [],
};
/** 恢复时重新排入暂停期间的主人消息，保留原始感知身份和去重依据。 */
function resumeOwnerMessages(ctx: HubContext, botId: string): void {
  const pending = ctx.store.table('percepts').list(row => row.botId === botId && row.source === 'owner' && row.consumedByWake === null);
  // 暂停期间留言可能已经入队；相同优先级合并会保留旧主理由，所以先给这类存量候选补主人摘要。
  for (const entry of ctx.store.table('queue').list(row => row.botId === botId && row.reason.kind === 'owner_message'
    && pending.some(percept => row.reason.evidence.includes(percept.id)))) {
    ctx.store.table('queue').patch(entry.id, { reason: { ...entry.reason, ownerSummary: '继续处理你暂停期间留的消息' } });
  }
  for (const percept of pending)
    enqueue(ctx, buildCandidate(ctx, { botId, kind: 'owner_message', score: ctx.settings.c02.ownerSalience,
      summary: '处理暂停期间主人留下的消息', ownerSummary: '继续处理你暂停期间留的消息',
      evidence: [percept.id], messageId: percept.location ?? percept.id, ownerInitiated: true }));
}
/** 提前转正要求满三天且没有越界；暂停不会重置试岗起点，解除隔离会清理故障计数。 */
export async function setLifecycle(ctx: HubContext, botId: string, lifecycle: Lifecycle): Promise<Bot> {
  const value = input(z.strictObject({ botId: nonempty, lifecycle: LifecycleSchema }), { botId, lifecycle }, '生命周期');
  const old = requireBot(ctx, value.botId);
  if (!LIFECYCLE_TRANSITIONS[old.lifecycle].includes(value.lifecycle)) throw new Error(`生命周期：不允许从 ${old.lifecycle} 转到 ${value.lifecycle}`);
  const now = ctx.clock.now();
  const stillProbation = old.probationEndsAt !== null && old.probationEndsAt > now;
  // 解除隔离表示恢复原有资格，不代表提前转正；旧界面传 active 时也按试岗恢复。
  if (old.lifecycle === 'quarantined' && value.lifecycle === 'active' && stillProbation) value.lifecycle = 'probation';
  if (value.lifecycle === 'active' && old.lifecycle !== 'quarantined' && stillProbation
    && (now - (old.probationStartedAt ?? old.createdAt) < ctx.settings.probationEarlyPromotionMs || old.violations > 0))
    throw new Error('提前转正：必须满三天且没有越界记录');
  if (value.lifecycle === 'probation' && ['paused', 'quarantined'].includes(old.lifecycle) && !stillProbation)
    throw new Error('已结束试岗的机器人请恢复到在岗');
  const resume = ['active', 'probation'].includes(value.lifecycle);
  const patch: Partial<Bot> = { lifecycle: value.lifecycle, activity: resume ? 'watching' : 'resting', activityText: resume ? '继续关注变化' : value.lifecycle === 'paused' ? '已暂停（你暂停的）' : '已退役', updatedAt: now };
  // 不让恢复动作猜测主人是否想提前转正；保存原资格并在离开暂停后清理。
  if (value.lifecycle === 'paused' && (old.lifecycle === 'probation' || old.lifecycle === 'active')) patch.pausedFrom = old.lifecycle;
  else patch.pausedFrom = null;
  // 草稿等待不计入试岗天数；真正上岗时才开始累计提前转正资格。
  if (old.lifecycle === 'draft' && value.lifecycle === 'probation') Object.assign(patch, {
    probationStartedAt: now, probationEndsAt: now + ctx.settings.probationMs,
  });
  if (value.lifecycle === 'active') {
    patch.probationEndsAt = null;
    // 试岗后的所有转正路径统一封顶 L2，L3 必须之后由主人显式修改档案。
    if (old.probationEndsAt !== null && old.autonomy === 'L3') patch.autonomy = 'L2';
  }
  if (old.lifecycle === 'quarantined' && resume) Object.assign(patch, {
    consecutiveErrors: 0, consecutiveNoCommit: 0, violations: 0, retryAt: null, quarantineReason: null, noChangeStreak: 0,
    releasedAt: now,
  });
  // 生命周期改变不取消宿主所有权下的在途回合，其终态仍由回合事件接收。
  const inFlight = ctx.store.table('wakes').list(wake => wake.botId === botId && wake.endedAt === null
    && ['delivering', 'running', 'committed'].includes(wake.status)).at(-1);
  if (inFlight) {
    patch.activity = inFlight.variant === 'reflection' ? 'reflecting' : inFlight.variant === 'catch_up' ? 'catching_up' : 'thinking';
    patch.activityText = resume ? old.activityText : '状态已更新，当前回合等待结束';
  }
  const row = ctx.store.table('bots').patch(botId, patch);
  // 主人已取消编制：退役不再需要腾空席位，任务记录保留队友 id，界面按「队友已退役」提示。
  if (old.lifecycle === 'quarantined' && resume) {
    closeAlert(ctx, 'quarantine', botId);
    await syncAlertItems(ctx);
  }
  if (!resume) for (const entry of ctx.store.table('queue').list(entry => entry.botId === botId)) removeEntry(ctx, entry.id);
  if (old.lifecycle === 'draft' && resume) {
    await createBotHome(ctx, row);
    enqueue(ctx, buildCandidate(ctx, { botId, kind: 'trial', variant: 'trial', score: ctx.settings.c02.ownerSalience,
      summary: '主人让你开始试岗', ownerSummary: '你已安排队友开始试岗',
      evidence: [botId], ownerInitiated: true, subjectKey: `trial:${botId}` }));
  } else await refreshBotFiles(ctx, botId);
  if (resume) resumeOwnerMessages(ctx, botId);
  await syncFileWatches(ctx);
  writeOutreachAudit(ctx, 'lifecycle', { botId, from: old.lifecycle, to: row.lifecycle, text: row.activityText }, 'owner');
  postThread(ctx, { thread: botId, from: 'hub', kind: 'system', text: `${old.name}：${row.activityText}` });
  ctx.emit(HUB_EVENT_SCOPES.bot, botId);
  ctx.emit(HUB_EVENT_SCOPES.activity, botId);
  return row;
}

/** 界面传动作而不是猜目标状态；兼容入口 setLifecycle 继续保留原有转换语义。 */
export const LifecycleActionSchema = z.enum(['pause', 'resume', 'promote', 'release_quarantine', 'retire']);
export type LifecycleAction = z.infer<typeof LifecycleActionSchema>;

/** 在改表之前校验动作资格，恢复、提前转正和解除隔离各走明确的业务含义。 */
export async function lifecycleAction(ctx: HubContext, raw: unknown): Promise<Bot> {
  const args = input(z.strictObject({ botId: nonempty, action: LifecycleActionSchema }), raw, '生命周期动作');
  const bot = requireBot(ctx, args.botId);
  const now = ctx.clock.now();
  switch (args.action) {
    case 'pause':
      if (bot.lifecycle !== 'active' && bot.lifecycle !== 'probation') throw new Error('暂停：只有在岗或试岗的机器人可以暂停');
      return setLifecycle(ctx, bot.id, 'paused');
    case 'resume': {
      if (bot.lifecycle !== 'paused') throw new Error('恢复：只有已暂停的机器人可以恢复');
      // M07 前的暂停档案没有 pausedFrom，非空试岗截止是仍有试岗资格的唯一持久证据。
      const previous = bot.pausedFrom ?? (bot.probationEndsAt !== null ? 'probation' : 'active');
      const expired = bot.probationEndsAt !== null && bot.probationEndsAt <= now;
      return setLifecycle(ctx, bot.id, previous === 'probation' && !expired ? 'probation' : 'active');
    }
    case 'promote': {
      if (bot.lifecycle !== 'probation') throw new Error('提前转正：只有正在试岗的机器人可以转正');
      if (bot.violations > 0) throw new Error('提前转正：有越界记录，不能转正');
      const remaining = (bot.probationStartedAt ?? bot.createdAt) + ctx.settings.probationEarlyPromotionMs - now;
      if (remaining > 0) throw new Error(`提前转正：试岗时间还差 ${Math.ceil(remaining / 86_400_000)} 天`);
      return setLifecycle(ctx, bot.id, 'active');
    }
    case 'release_quarantine':
      if (bot.lifecycle !== 'quarantined') throw new Error('解除隔离：只有已隔离的机器人可以解除隔离');
      return setLifecycle(ctx, bot.id, bot.probationEndsAt !== null && bot.probationEndsAt > now ? 'probation' : 'active');
    case 'retire':
      if (bot.lifecycle === 'retired') throw new Error('退役：它已经退役，不能重复退役');
      return setLifecycle(ctx, bot.id, 'retired');
  }
}

// ---------- P48：归档 / 恢复 / 删除 ----------

/** 阻止归档的单个项目：项目名 + 它在这个项目里的未结任务数。 */
export interface ArchiveBotBlockerProject {
  projectId: string;
  projectName: string;
  /** 它是否仍是这个项目的成员。 */
  member: boolean;
  /** 这个项目里指派给它、仍在进行中或待验收的任务数。 */
  openTaskCount: number;
}
/** 归档前置校验结果：界面据此显示受影响项目与任务数，服务端用同一份结果拒绝。 */
export interface ArchiveBotCheck {
  botId: string;
  botName: string;
  canArchive: boolean;
  /** 阻止原因（中文，说清缺哪一项）；可以归档时为 null。 */
  reason: string | null;
  projectCount: number;
  openTaskCount: number;
  projects: ArchiveBotBlockerProject[];
}

/** 未结任务口径：进行中与待验收；待办和受阻不算在身上。 */
const OPEN_TASK_STATUSES: readonly string[] = ['doing', 'done_pending_check'];

/**
 * 归档前置校验（纯读取）：只有已退役、且没有项目成员身份、没有未结任务的队友可以归档。
 * 未归档项目才算约束；项目已归档时它已经是历史，不应再拦住归档。
 */
export function archiveBotCheck(ctx: HubContext, botId: string): ArchiveBotCheck {
  const bot = requireBot(ctx, botId);
  const projects = ctx.store.table('projects').list();
  const tasks = ctx.store.table('projectTasks').list();
  const blockers: ArchiveBotBlockerProject[] = [];
  for (const project of projects) {
    if (project.archivedAt !== null) continue;
    const member = project.memberBotIds.includes(bot.id);
    const openTaskCount = tasks.filter(task => task.projectId === project.id && task.assigneeBotId === bot.id
      && OPEN_TASK_STATUSES.includes(task.status)).length;
    if (member || openTaskCount > 0) blockers.push({ projectId: project.id, projectName: project.name, member, openTaskCount });
  }
  blockers.sort((a, b) => a.projectName.localeCompare(b.projectName, 'zh-Hans-CN'));
  const projectCount = blockers.filter(row => row.member).length;
  const openTaskCount = blockers.reduce((sum, row) => sum + row.openTaskCount, 0);
  let reason: string | null = null;
  if (bot.archivedAt != null) reason = '归档：它已经在已归档区里了';
  else if (bot.lifecycle !== 'retired') reason = '归档：只有已退役的队友可以归档，请先退役';
  else if (blockers.length > 0) {
    const names = blockers.map(row => `${row.projectName}（${row.openTaskCount} 个未结任务${row.member ? '，仍是成员' : ''}）`).join('、');
    const parts: string[] = [];
    if (projectCount > 0) parts.push(`还是 ${projectCount} 个项目的成员`);
    if (openTaskCount > 0) parts.push(`有 ${openTaskCount} 个未结任务（进行中或待验收）`);
    reason = `归档：它${parts.join('，')}。先交接：${names}`;
  }
  return { botId: bot.id, botName: bot.name, canArchive: reason === null, reason,
    projectCount, openTaskCount, projects: blockers };
}

/** 归档：只写可恢复的 archivedAt 标记，唤醒账本、工作会话、任务、产物一律不动。 */
export function archiveBot(ctx: HubContext, botId: string): Bot {
  const check = archiveBotCheck(ctx, botId);
  if (!check.canArchive) throw new Error(check.reason ?? '归档：现在不能归档');
  const now = ctx.clock.now();
  const row = ctx.store.table('bots').patch(botId, { archivedAt: now, updatedAt: now });
  // 退役时已经清过队列；这里再清一次，避免旧数据里残留候选在归档后仍被调度。
  for (const entry of ctx.store.table('queue').list(entry => entry.botId === botId)) removeEntry(ctx, entry.id);
  writeOutreachAudit(ctx, 'bot_archive', { botId, name: row.name, at: now }, 'owner');
  ctx.emit(HUB_EVENT_SCOPES.bot, botId);
  ctx.emit(HUB_EVENT_SCOPES.overview);
  ctx.emit(HUB_EVENT_SCOPES.office);
  return row;
}

/** 恢复：只清 archivedAt，回到「已退役、仍在名单里」的状态，历史原样保留。 */
export function restoreArchivedBot(ctx: HubContext, botId: string): Bot {
  const bot = requireBot(ctx, botId);
  if (bot.archivedAt == null) throw new Error('恢复：它没有归档，不需要恢复');
  const now = ctx.clock.now();
  const row = ctx.store.table('bots').patch(botId, { archivedAt: null, updatedAt: now });
  writeOutreachAudit(ctx, 'bot_restore', { botId, name: row.name, at: now }, 'owner');
  ctx.emit(HUB_EVENT_SCOPES.bot, botId);
  ctx.emit(HUB_EVENT_SCOPES.overview);
  ctx.emit(HUB_EVENT_SCOPES.office);
  return row;
}

/**
 * 删除：只删队友的配置与档案（bots 与 botProfiles 两行）。
 * 唤醒账本、线程、任务、产物与审计一律保留；界面查不到名字时显示「已删除的队友」。
 * 只有已归档的队友可以删除，避免把还在名单里的队友误删。
 */
export function deleteArchivedBot(ctx: HubContext, botId: string): void {
  const bot = requireBot(ctx, botId);
  if (bot.archivedAt == null) throw new Error('删除：只有已归档的队友可以删除，请先归档');
  ctx.store.table('bots').remove(botId);
  ctx.store.table('botProfiles').remove(botId);
  for (const entry of ctx.store.table('queue').list(entry => entry.botId === botId)) removeEntry(ctx, entry.id);
  writeOutreachAudit(ctx, 'bot_delete', { botId, name: bot.name }, 'owner');
  ctx.emit(HUB_EVENT_SCOPES.bot, botId);
  ctx.emit(HUB_EVENT_SCOPES.overview);
  ctx.emit(HUB_EVENT_SCOPES.office);
}

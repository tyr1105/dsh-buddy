/** 主人创建和管理机器人；显式生命周期转换阻止退役复活、绕过试岗和机器人自行解除隔离。 */
import { posix } from 'node:path';
import { z } from 'zod';
import type { HubContext } from '../engine/context.js';
import { BotSchema, AspirationSchema, staffStatus } from '../model/bot.js';
import { BotOriginSchema, type BotOrigin } from '../model/bot-origin.js';
import { templateById } from '../team/templates.js';
import { liveChief, rosterHasTemplate, teamRoster } from '../team/roster.js';
import { LifecycleSchema, type Bot, type Lifecycle } from '../model/index.js';
import type { Project } from '../model/project.js';
import type { Alert } from '../model/operations.js';
import type { QueueEntry } from '../model/wake.js';
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
import { sameModelChoice } from '../memory/rotation.js';
import { HUB_EVENT_SCOPES } from './event-scopes.js';
import {
  announceParticipantOff, archiveBlockedByJob, blockJobsOfSuspended, restoreJobs, resumeJobsOfReinstated, settleArchivedLeftovers,
} from '../job/participants.js';
import { removeStaleSuspendWakes } from '../job/suspended.js';

/** 执行类 = 角色不是总管也不是值守（调研、执行、建议）；这类员工的自主节奏固定为听吩咐（方案 5.4）。 */
export function isExecutionRole(role: Bot['role']): boolean {
  return role !== 'chief' && role !== 'sentinel';
}
const ROLE_COLORS ={ chief: '#75634E', researcher: '#427C9D', executor: '#54836B', sentinel: '#9B6B45', advisor: '#7A6A9B' };
/** 建议风格只提意见不动手：自主等级不能超过 L1，否则角色和权限互相矛盾。 */
function checkAdvisorAutonomy(role: Bot['role'], autonomy: Bot['autonomy']): void {
  if (role === 'advisor' && (autonomy === 'L2' || autonomy === 'L3')) throw new Error('自主节奏：建议风格只提意见不动手，请选听吩咐或提建议');
}
/**
 * 创建员工的公开入口（主人界面用）。P73c 起：
 * - 带 templateId（从模板库添加）：模板必须存在，全队一位的模板已有一位时拒绝；写来历 library，
 *   并在总管私聊落一句中心旁白（不排唤醒）；
 * - 不带 templateId（自己从头配置）：写来历 custom，不落旁白。
 * 真正的创建在 createBotInternal，组队确认入职也调用它。
 */
export async function createBot(ctx: HubContext, raw: unknown): Promise<Bot> {
  const args = input(CreateBotSchema, raw, '创建机器人');
  const template = args.templateId === undefined ? null : templateById(args.templateId);
  if (args.templateId !== undefined) {
    if (template === undefined || template === null) throw new Error('templateId：没有这个模板');
    if (template.uniquePerTeam && rosterHasTemplate(teamRoster(ctx), template)) throw new Error(`templateId：${template.name}全队一位，已有`);
  }
  const bot = await createBotInternal(ctx, raw, {
    source: template ? 'library' : 'custom', templateId: template ? template.id : null, proposalId: null,
    renamedFrom: null, mbtiSuggested: null, modelTierSuggested: null,
  });
  // 从模板库添加：在总管私聊落一句中心旁白；失败只记日志，不影响已经成功的创建。不排唤醒。
  const chief = template ? liveChief(ctx) : null;
  if (template && chief) {
    try {
      postThread(ctx, { thread: chief.id, from: 'hub', kind: 'system',
        text: `你从模板库添加了${template.name}${bot.name !== template.name ? `（${bot.name}）` : ''}。之后安排工作时会算上这位员工。` });
    } catch (error) { ctx.logger.warn('模板库添加旁白落楼失败', { botId: bot.id, error: String(error) }); }
  }
  return bot;
}

/** 写来历用的入参（组队入职时还会带上改名、改性格、改模型的原值）。 */
export type BotOriginInput = Pick<BotOrigin, 'source' | 'templateId' | 'proposalId' | 'renamedFrom' | 'mbtiSuggested' | 'modelTierSuggested'>;

/**
 * 创建员工的内部入口：主人界面（createBot）、自动建总管、组队确认入职共用，来历在家目录创建成功之后才写。
 * extra.color 给组队入职用：颜色取模板色（CreateBotSchema 不收颜色，所以单独传）。
 * 所有路径都由中心根目录和新 id 生成，外部输入不能替换家目录或宿主会话。
 */
export async function createBotInternal(ctx: HubContext, raw: unknown, origin: BotOriginInput, extra: { color?: string } = {}): Promise<Bot> {
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
  // P73a（方案 5.4）：执行类员工（角色不是总管、值守）固定为听吩咐：忽略传入的节奏参数。
  // 总管与值守类照传入值：P55 起听吩咐默认用安静节奏，主人显式传了 pace 时以主人为准。
  const fixed = isExecutionRole(args.role);
  const onDemand = fixed ? true : (args.onDemand ?? false);
  const autonomy = fixed ? 'L1' : (args.autonomy ?? 'L1');
  const pace = fixed ? 'quiet' : (args.pace ?? (onDemand ? 'quiet' : 'normal'));
  checkAdvisorAutonomy(args.role, autonomy);
  const temperament = args.temperament ?? null;
  const speechStyle = args.speechStyle ?? null;
  const persona = args.persona ?? composePersona({ name: args.name, role: args.role, temperament, speechStyle });
  const aspirationTexts = args.aspirations ?? [DEFAULT_ASPIRATION_BY_ROLE[args.role]];
  // MBTI 不写进 Bot 本体：旧版本用 strictObject 解析 bots.json，额外字段会让它整体读不出队友。
  const bot = input(BotSchema, { id, name: args.name, role: args.role, persona,
    color: extra.color ?? ROLE_COLORS[args.role],
    // P73a：新员工直接在岗，不再有试岗（probationStartedAt 不写，probationEndsAt 为空）。
    lifecycle: 'active', activity: 'watching', activityText: '继续关注变化', autonomy, pace,
    model, homeDir: posix.join(ctx.settings.rootDir, 'bots', id),
    sessionId: null, sessionStartedAt: null, createdAt: now, probationEndsAt: null,
    noChangeStreak: 0, lastThinkAt: null, nextThinkAt: null, nextThinkReason: null, nextThinkBy: null, nextThinkMode: null,
    lightCheckAt: now + ctx.settings.paceMaxIdleMs, expectedBy: null, consecutiveErrors: 0, consecutiveNoCommit: 0, violations: 0,
    retryAt: null, quarantineReason: null, workDataAllowed: false, presetSkillIds,
    dshSkillNames: [...new Set(args.dshSkillNames ?? [])], temperament, speechStyle, brief: args.brief?.trim() ?? '', onDemand, updatedAt: now }, '机器人');
  const aspirations = aspirationTexts.map(text => input(AspirationSchema, { id: newId('asp', ctx.rng), botId: id, text,
    status: 'active', createdBy: 'owner', approved: true, createdAt: now }, '志向'));  if ((args.watches?.length ?? 0) > ctx.settings.maxWatchesPerBot) throw new Error('关注项数量已达上限');
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
  // P73c：来历。家目录已建成才写，所以创建失败不会留下孤儿来历。
  ctx.store.table('botOrigins').put(input(BotOriginSchema, { id, botId: id, ...origin, joinedAt: now }, '员工来历'));
  // P72h H3：新建员工后不再自动排「试跑」回合（主人在 DC55 定的）：
  // 试跑一次要消耗约 9 万 token，超时还会自动重试，留下的目标和关注提议也会一直挂在「待你处理」里。
  // 员工建好后安静待命，主人第一次对它说话或派活时才会被叫醒。
  writeOutreachAudit(ctx, 'lifecycle', { botId: id, from: null, to: 'active', text: `${bot.name}入职` }, 'owner');
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
  if (old.lifecycle === 'retired') throw new Error('已归档的员工不能再修改档案');
  // P73a（方案 5.4）：更新后是执行类时，传入的听吩咐三项被忽略（不报错），固定为听吩咐；
  // 只有更新后是值守类（或总管）时才采用传入值。
  if (isExecutionRole(patch.role ?? old.role)) Object.assign(patch, { onDemand: true, autonomy: 'L1', pace: 'quiet' });
  const preview = input(BotSchema, { ...old, ...patch, updatedAt: ctx.clock.now() }, '机器人');
  checkNameAndRole(ctx, preview.name, preview.role, preview.id);
  checkAdvisorAutonomy(preview.role, preview.autonomy);
  // 编辑也重验最终模型，目录移除的型号不能被无关档案修改默默保留。
  await validateModelChoice(ctx, preview.model);
  // 宿主目录读取期间主人仍可打断回合；只把档案字段合入最新状态，不能复活旧会话或覆盖运行计数。
  const current = requireBot(ctx, botId);
  if (current.lifecycle === 'retired') throw new Error('已归档的员工不能再修改档案');
  // P74r10：升级前建的会话没有 sessionModel。这次确实把模型改成了不同的值时，
  // 把改之前的模型记成会话用的模型，下一次叫醒才能看出不一致并重建会话。
  const upgradeSessionModel = current.sessionId !== null && current.sessionModel === undefined
    && patch.model !== undefined && !sameModelChoice(patch.model, current.model);
  const next = input(BotSchema, { ...current, ...patch, ...(upgradeSessionModel ? { sessionModel: current.model } : {}),
    updatedAt: ctx.clock.now() }, '机器人');
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
/**
 * 生命周期转换。P73a 起没有试岗这一步：目标为 probation 时改写为 active（兼容旧调用），
 * 从暂停、隔离恢复一律到 active；解除隔离会清理故障计数。
 * P73r1（R2）：目标为退役时不再直接落盘，一律走归档流程（同一套检查、同一套全有或全无的写入），
 * 因此「退役」和「归档」是同一件事，没有绕过检查的路径。
 */
export async function setLifecycle(ctx: HubContext, botId: string, lifecycle: Lifecycle): Promise<Bot> {
  if (lifecycle === 'retired') return archiveStaff(ctx, botId);
  return applyLifecycle(ctx, botId, lifecycle);
}
/** 生命周期转换的实际写入（内部函数）。目标为退役的转换不走这里，见 archiveStaff。 */
async function applyLifecycle(ctx: HubContext, botId: string, lifecycle: Lifecycle): Promise<Bot> {
  const value = input(z.strictObject({ botId: nonempty, lifecycle: LifecycleSchema }), { botId, lifecycle }, '生命周期');
  const old = requireBot(ctx, value.botId);
  if (!LIFECYCLE_TRANSITIONS[old.lifecycle].includes(value.lifecycle)) throw new Error(`生命周期：不允许从 ${old.lifecycle} 转到 ${value.lifecycle}`);
  const now = ctx.clock.now();
  // 转换合法性按调用方传入的目标检查，之后再把试岗改写为在岗。
  if (value.lifecycle === 'probation') value.lifecycle = 'active';
  const resume = ['active', 'probation'].includes(value.lifecycle);
  const patch: Partial<Bot> = { lifecycle: value.lifecycle, activity: resume ? 'watching' : 'resting', activityText: resume ? '继续关注变化' : value.lifecycle === 'paused' ? '已停用（你停用的）' : '已归档', updatedAt: now };
  // 暂停前的资格统一记为在岗；没有试岗之后恢复不再区分。
  if (value.lifecycle === 'paused' && (old.lifecycle === 'probation' || old.lifecycle === 'active')) patch.pausedFrom = 'active';
  else patch.pausedFrom = null;
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
  // P74b：停用时，他参与的事转为受阻（有备份；改员工档案失败就把这些事恢复原样）。
  const suspended = resume ? null : blockJobsOfSuspended(ctx, old);
  let row: Bot;
  try {
    row = ctx.store.table('bots').patch(botId, patch);
  } catch (error) {
    if (suspended) restoreJobs(ctx, suspended.before);
    throw error;
  }
  // 主人已取消编制：退役不再需要腾空席位，任务记录保留队友 id，界面按「队友已退役」提示。
  // 从停用（系统隔离）直接归档时关闭隔离告警的逻辑在 archiveStaff 的第二段（P73r2）。
  if (old.lifecycle === 'quarantined' && resume) {
    closeAlert(ctx, 'quarantine', botId);
    await syncAlertItems(ctx);
    // P74r16b：因他被停用而给总管排的、还没有放行的候选（执行链唤醒和普通团队信号）已经过期，移出队列；已经在跑的不处理。
    try { removeStaleSuspendWakes(ctx, row); } catch (error) { ctx.logger.warn('恢复在岗后清理给总管的过期唤醒失败', { botId, error: String(error) }); }
  }
  if (!resume) for (const entry of ctx.store.table('queue').list(entry => entry.botId === botId)) removeEntry(ctx, entry.id);
  if (old.lifecycle === 'draft' && resume) {
    await createBotHome(ctx, row);
    enqueue(ctx, buildCandidate(ctx, { botId, kind: 'trial', variant: 'trial', score: ctx.settings.c02.ownerSalience,
      summary: '主人让你开始试岗', ownerSummary: '你已安排员工开始试岗',
      evidence: [botId], ownerInitiated: true, subjectKey: `trial:${botId}` }));
  } else await refreshBotFiles(ctx, botId);
  if (resume) resumeOwnerMessages(ctx, botId);
  await syncFileWatches(ctx);
  writeOutreachAudit(ctx, 'lifecycle', { botId, from: old.lifecycle, to: row.lifecycle, text: row.activityText }, 'owner');
  postThread(ctx, { thread: botId, from: 'hub', kind: 'system', text: `${old.name}：${row.activityText}` });
  // P74b 第二段：停用后总管私聊落一句并记事件；恢复在岗后，因他停用而受阻的事回到原状态并叫他一次。出错只记日志。
  if (suspended) announceParticipantOff(ctx, row, suspended.after);
  if (resume && (old.lifecycle === 'paused' || old.lifecycle === 'quarantined')) {
    try { resumeJobsOfReinstated(ctx, row); } catch (error) { ctx.logger.warn('恢复在岗后继续他参与的事失败', { botId, error: String(error) }); }
  }
  ctx.emit(HUB_EVENT_SCOPES.bot, botId);
  ctx.emit(HUB_EVENT_SCOPES.activity, botId);
  return row;
}

/** 界面传动作而不是猜目标状态；兼容入口 setLifecycle 继续保留原有转换语义。 */
// P73a：新增 suspend（停用）、reinstate（恢复在岗）、archive（归档，一步完成）；旧动作保留兼容。
export const LifecycleActionSchema = z.enum(['pause', 'resume', 'promote', 'release_quarantine', 'retire', 'suspend', 'reinstate', 'archive']);
export type LifecycleAction = z.infer<typeof LifecycleActionSchema>;

/** 在改表之前校验动作资格，恢复、提前转正和解除隔离各走明确的业务含义。 */
export async function lifecycleAction(ctx: HubContext, raw: unknown): Promise<Bot> {
  const args = input(z.strictObject({ botId: nonempty, action: LifecycleActionSchema }), raw, '生命周期动作');
  const bot = requireBot(ctx, args.botId);
  switch (args.action) {
    case 'pause':
      if (bot.lifecycle !== 'active' && bot.lifecycle !== 'probation') throw new Error('暂停：只有在岗或试岗的机器人可以暂停');
      return setLifecycle(ctx, bot.id, 'paused');
    case 'resume':
      if (bot.lifecycle !== 'paused') throw new Error('恢复：只有已停用的员工可以恢复');
      // P73a：没有试岗了，恢复一律回到在岗。
      return setLifecycle(ctx, bot.id, 'active');
    case 'promote':
      throw new Error('提前转正：已没有试岗这一步');
    case 'release_quarantine':
      if (bot.lifecycle !== 'quarantined') throw new Error('解除隔离：只有已停用（系统隔离）的机器人可以解除隔离');
      return setLifecycle(ctx, bot.id, 'active');
    case 'retire':
      // P73r1（R2）：退役等同于归档，走同一套检查和流程。
      return archiveStaff(ctx, bot.id);
    case 'suspend':
      if (staffStatus(bot).status !== 'on_duty') throw new Error('停用：只有在岗的员工可以停用');
      return setLifecycle(ctx, bot.id, 'paused');
    case 'reinstate':
      // 暂停与隔离都回到在岗；隔离的故障计数由 setLifecycle 沿用解除隔离的清理逻辑清零。
      if (bot.lifecycle !== 'paused' && bot.lifecycle !== 'quarantined') throw new Error('恢复在岗：只有已停用的员工可以恢复');
      return setLifecycle(ctx, bot.id, 'active');
    case 'archive':
      return archiveStaff(ctx, bot.id);
  }
}

/** 归档第一段开始前要备份的状态：员工档案、涉及的项目、队列条目（第一段只改这三类表）。 */
interface ArchiveBackup {
  bot: Bot;
  projects: Project[];
  queue: QueueEntry[];
}
/** 备份第一段会改动的表记录，失败时据此原样恢复。 */
function backupBeforeArchive(ctx: HubContext, botId: string, projectIds: string[]): ArchiveBackup {
  return {
    bot: requireBot(ctx, botId),
    projects: projectIds.map(id => ctx.store.table('projects').get(id)).filter((row): row is Project => row !== null),
    queue: ctx.store.table('queue').list(entry => entry.botId === botId),
  };
}
/** 把备份写回：员工档案、项目、队列条目恢复原样。 */
function restoreArchiveBackup(ctx: HubContext, backup: ArchiveBackup): void {
  ctx.store.table('bots').put(backup.bot);
  for (const project of backup.projects) ctx.store.table('projects').put(project);
  for (const entry of ctx.store.table('queue').list(row => row.botId === backup.bot.id)) ctx.store.table('queue').remove(entry.id);
  for (const entry of backup.queue) ctx.store.table('queue').put(entry);
  ctx.emit(HUB_EVENT_SCOPES.bot, backup.bot.id);
  ctx.emit(HUB_EVENT_SCOPES.overview);
  ctx.emit(HUB_EVENT_SCOPES.office);
  ctx.emit(HUB_EVENT_SCOPES.project, null);
}
/** 第二段的一步：出错只记日志，不影响归档已经成功这个结果。 */
async function bestEffort(ctx: HubContext, what: string, botId: string, work: () => void | Promise<void>): Promise<void> {
  try { await work(); } catch (error) { ctx.logger.warn(`归档收尾失败：${what}`, { botId, error: String(error) }); }
}

/**
 * 归档（唯一入口，P73r1 R1、R2；P73r2 N1 分两段）：「归档」「退役」「设为已退役」都走这里。
 * 第一段只改状态表，有备份，失败就全部恢复并报错：移出只是成员的项目、转为已归档并写归档时间、清队列。
 * 第二段在第一段全部成功之后才做，不参与回滚，出错只记日志：关闭隔离告警及其「待你处理」条目、
 * 刷新家目录文件与监听、写审计、线程里落「已归档」旁白。
 * 这样归档中途失败时，主人看不到任何「已归档」旁白，告警和它的条目保持原样。
 */
export async function archiveStaff(ctx: HubContext, botId: string): Promise<Bot> {
  const bot = requireBot(ctx, botId);
  if (staffStatus(bot).status === 'archived') throw new Error('归档：它已经归档了');
  const check = archiveBotCheck(ctx, bot.id);
  if (!check.canArchive) throw new Error(check.reason ?? '归档：现在不能归档');
  const backup = backupBeforeArchive(ctx, bot.id, check.memberProjects.map(item => item.projectId));
  const now = ctx.clock.now();
  let removedAudits: Record<string, unknown>[] = [];
  let row: Bot;
  try {
    // 第一段：只改状态表。
    removedAudits = removeFromProjects(ctx, bot, check.memberProjects);
    for (const entry of ctx.store.table('queue').list(entry => entry.botId === botId)) removeEntry(ctx, entry.id);
    // 生命周期改变不取消宿主所有权下的在途回合，其终态仍由回合事件接收。
    const inFlight = ctx.store.table('wakes').list(wake => wake.botId === botId && wake.endedAt === null
      && ['delivering', 'running', 'committed'].includes(wake.status)).at(-1);
    const flying = inFlight
      ? { activity: inFlight.variant === 'reflection' ? 'reflecting' as const : inFlight.variant === 'catch_up' ? 'catching_up' as const : 'thinking' as const,
        activityText: '状态已更新，当前回合等待结束' }
      : { activity: 'resting' as const, activityText: '已归档' };
    row = ctx.store.table('bots').patch(botId, { lifecycle: 'retired', archivedAt: now, pausedFrom: null, updatedAt: now, ...flying });
  } catch (error) {
    restoreArchiveBackup(ctx, backup);
    throw new Error(`归档失败，已恢复到归档前的状态：${error instanceof Error ? error.message : String(error)}`);
  }
  // 第二段：第一段全部成功之后才做；每一步独立兜底。
  if (bot.lifecycle === 'quarantined') await bestEffort(ctx, '关闭隔离告警', botId, async () => {
    closeAlert(ctx, 'quarantine', botId);
    await syncAlertItems(ctx);
  });
  await bestEffort(ctx, '刷新家目录文件', botId, () => refreshBotFiles(ctx, botId));
  await bestEffort(ctx, '同步文件监听', botId, () => syncFileWatches(ctx));
  await bestEffort(ctx, '写审计', botId, () => {
    for (const detail of removedAudits) writeOutreachAudit(ctx, 'project_update', detail, 'owner', now);
    writeOutreachAudit(ctx, 'lifecycle', { botId, from: bot.lifecycle, to: 'retired', text: '已归档' }, 'owner');
    writeOutreachAudit(ctx, 'bot_archive', { botId: row.id, name: row.name, at: now }, 'owner');
  });
  await bestEffort(ctx, '线程旁白', botId, () => { postThread(ctx, { thread: botId, from: 'hub', kind: 'system', text: `${bot.name}：已归档` }); });
  // P74b：补上第二块留下的疑点——归档后发给他的交接、他持有的认领、他名下待批的审批单一并处理（各自兜底）。
  await settleArchivedLeftovers(ctx, bot);
  ctx.emit(HUB_EVENT_SCOPES.bot, botId);
  ctx.emit(HUB_EVENT_SCOPES.activity, botId);
  ctx.emit(HUB_EVENT_SCOPES.overview);
  ctx.emit(HUB_EVENT_SCOPES.office);
  return ctx.store.table('bots').get(row.id) ?? row;
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
  /** P73a：可以归档时，归档会把它从这些项目的成员名单里移出（界面二次确认时显示）。 */
  memberProjects: { projectId: string; projectName: string }[];
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
  // P73a 规则，按顺序：已归档、总管、项目负责人、未结事务；只是成员的不拦（归档时自动移出）。
  const ownedProjects = projects.filter(project => project.archivedAt === null && project.ownerBotId === bot.id);
  let reason: string | null = null;
  // 已归档以 archivedAt 为准：lifecycle 为 retired 但还没有归档时间的旧档案，仍可由 archiveBot 补归档。
  if (bot.archivedAt != null) reason = '归档：它已经归档了';
  else if (bot.role === 'chief') reason = '归档：总管不能归档';
  else if (ownedProjects.length > 0) reason = `归档：它是项目「${ownedProjects[0]!.name}」的负责人。请先在项目设置里换一位负责人`;
  else if (openTaskCount > 0) {
    const names = blockers.filter(row => row.openTaskCount > 0).map(row => `项目「${row.projectName}」（${row.openTaskCount} 件）`).join('、');
    reason = `归档：它有 ${openTaskCount} 件进行中或待验收的事务，先交接：${names}`;
  }
  // P74b：正在做一件事（执行者或核对人）的员工不能归档，先请总管改派。
  else reason = archiveBlockedByJob(ctx, bot);
  const memberProjects = reason === null
    ? blockers.filter(row => row.member).map(row => ({ projectId: row.projectId, projectName: row.projectName })) : [];
  return { botId: bot.id, botName: bot.name, canArchive: reason === null, reason,
    projectCount, openTaskCount, projects: blockers, memberProjects };
}

/**
 * 归档时把它从所属项目的成员名单里移出（P73r1 R1.2 选用的做法）：
 * 用不做整项目校验的内部写法，只改成员名单、审计 actor 为主人、detail 带 byArchive。
 * 不走 saveProject：它会逐个校验剩余成员是否在岗，同一项目里另有已归档成员时会失败，留下半改状态。
 * 负责人不会走到这里（归档检查已经拒绝负责人归档），所以不需要处理负责人。
 */
function removeFromProjects(ctx: HubContext, bot: Bot, memberProjects: { projectId: string; projectName: string }[]): Record<string, unknown>[] {
  const now = ctx.clock.now();
  // 只改状态表；审计内容返回给调用方，在归档第二段才写（P73r2）。
  const audits: Record<string, unknown>[] = [];
  for (const item of memberProjects) {
    const project = ctx.store.table('projects').get(item.projectId);
    if (!project || !project.memberBotIds.includes(bot.id)) continue;
    const members = project.memberBotIds.filter(id => id !== bot.id);
    ctx.store.table('projects').put({ ...project, memberBotIds: members, updatedAt: now });
    audits.push({ id: project.id, name: project.name, status: project.status,
      ownerBotId: project.ownerBotId, memberBotIds: members, sharedDir: project.sharedDir,
      criterionCount: project.acceptanceCriteria.length, byArchive: true });
  }
  if (memberProjects.length > 0) ctx.emit(HUB_EVENT_SCOPES.project, null);
  return audits;
}

/**
 * 归档（旧入口，P73r2 N2）：
 * - 已经归档的：报「已经归档了」；
 * - 未归档的员工（在岗或停用）：走与归档动作相同的完整流程（检查、移出成员、转归档），
 *   不再出现「仍在岗却带着归档时间」；
 * - 只有「已退役但没有归档时间」的旧数据，才只补归档时间（沿用检查并移出项目成员），同样全有或全无。
 */
export async function archiveBot(ctx: HubContext, botId: string): Promise<Bot> {
  const bot = requireBot(ctx, botId);
  if (bot.archivedAt != null) throw new Error('归档：它已经归档了');
  if (bot.lifecycle !== 'retired') return archiveStaff(ctx, botId);
  const check = archiveBotCheck(ctx, botId);
  if (!check.canArchive) throw new Error(check.reason ?? '归档：现在不能归档');
  const backup = backupBeforeArchive(ctx, botId, check.memberProjects.map(item => item.projectId));
  const now = ctx.clock.now();
  let audits: Record<string, unknown>[];
  let row: Bot;
  try {
    audits = removeFromProjects(ctx, backup.bot, check.memberProjects);
    row = ctx.store.table('bots').patch(botId, { archivedAt: now, updatedAt: now });
    // 退役时已经清过队列；这里再清一次，避免旧数据里残留候选在归档后仍被调度。
    for (const entry of ctx.store.table('queue').list(entry => entry.botId === botId)) removeEntry(ctx, entry.id);
  } catch (error) {
    restoreArchiveBackup(ctx, backup);
    throw new Error(`归档失败，已恢复到归档前的状态：${error instanceof Error ? error.message : String(error)}`);
  }
  await bestEffort(ctx, '写审计', botId, () => {
    for (const detail of audits) writeOutreachAudit(ctx, 'project_update', detail, 'owner', now);
    writeOutreachAudit(ctx, 'bot_archive', { botId, name: row.name, at: now }, 'owner');
  });
  await settleArchivedLeftovers(ctx, backup.bot);
  ctx.emit(HUB_EVENT_SCOPES.bot, botId);
  ctx.emit(HUB_EVENT_SCOPES.overview);
  ctx.emit(HUB_EVENT_SCOPES.office);
  return ctx.store.table('bots').get(botId) ?? row;
}

/** 已归档的员工仍是项目负责人时给主人看的说明（删除被拒、启动整理告警共用）。 */
export function archivedOwnerText(projectName: string, botName: string): string {
  return `项目「${projectName}」的负责人「${botName}」已归档，请在项目设置里换一位负责人。`;
}

/** 恢复（P73r1 R6.1）：归档后不能恢复为在岗，一律拒绝；记录仍可查看。函数保留是为了命令入口仍给出明确说明。 */
export function restoreArchivedBot(_ctx: HubContext, _botId: string): Bot {
  throw new Error('归档后不能恢复为在岗；记录仍可查看');
}

/**
 * 删除：只删队友的配置与档案（bots 与 botProfiles 两行）。
 * 唤醒账本、线程、任务、产物与审计一律保留；界面查不到名字时显示「已删除的队友」。
 * 只有已归档的队友可以删除，避免把还在名单里的队友误删。
 */
export function deleteArchivedBot(ctx: HubContext, botId: string): void {
  const bot = requireBot(ctx, botId);
  if (bot.archivedAt == null) throw new Error('删除：只有已归档的员工可以删除，请先归档');
  // P73r1（R2.3）：已归档的员工若仍是某个未归档项目的负责人，不能删除，否则项目的负责人会指向已删除的员工。
  const owned = ctx.store.table('projects').list(project => project.archivedAt === null && project.ownerBotId === botId)[0];
  if (owned) throw new Error(archivedOwnerText(owned.name, bot.name));
  ctx.store.table('bots').remove(botId);
  ctx.store.table('botProfiles').remove(botId);
  ctx.store.table('botOrigins').remove(botId);
  for (const entry of ctx.store.table('queue').list(entry => entry.botId === botId)) removeEntry(ctx, entry.id);
  writeOutreachAudit(ctx, 'bot_delete', { botId, name: bot.name }, 'owner');
  ctx.emit(HUB_EVENT_SCOPES.bot, botId);
  ctx.emit(HUB_EVENT_SCOPES.overview);
  ctx.emit(HUB_EVENT_SCOPES.office);
}

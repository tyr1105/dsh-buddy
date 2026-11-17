/**
 * 技能库的写入（P75e 第 3 节）：技能与版本只经这里的三个函数写进 `skills`、`skillVersions` 表。
 *
 * 为什么收口：方案 7.10「技能库内容变化」的全部路径（核对通过、回退、收起、放回、迁移）都要
 * 走同一套校验、物化和事件，各写各的会漏物化或漏发事件，宿主的技能清单就跟存储对不上。
 *
 * 三段式与派活（P74b）一致：先做全部校验，一条都不写；校验不过抛中文错误；
 * 写入成功后物化技能文件（出错只记日志，下次 refreshBotFiles 补上）、发 `bot` 事件
 * （宿主收到后刷新这位员工的技能过滤器，名单变了才让 DSH 重算）。
 */
import { posix } from 'node:path';
import type { HubContext } from '../engine/context.js';
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import type { Bot, Skill, SkillVersion } from '../model/index.js';
import { SkillSchema, SkillVersionSchema, SkillStateSchema } from '../model/skill.js';
import type { z } from 'zod';
type SkillState = z.infer<typeof SkillStateSchema>;
import { SKILL_DEFAULTS as D } from '../config/defaults.js';
import { newId } from '../util/ids.js';
import { writeOutreachAudit } from '../outreach/audit.js';
import { selfSkillsOf, syncSelfSkills } from './files.js';

/** 一次写入的入参（P75e 第 3 节）。 */
export interface WriteSkillVersionInput {
  botId: string;
  /** 已有技能的编号；新建（create、migrate）时为空。 */
  skillId?: string | null;
  /** 新建时的技能信息。 */
  newSkill?: { title: string; whenToUse: string; supplements: string | null } | null;
  /** P75f 迁移用：新建时写上旧经验的来源与原编号；缺省为 null。 */
  legacy?: Skill['legacy'];
  change: 'create' | 'add' | 'merge' | 'migrate';
  sentences: { text: string; sourceIds: string[] }[];
  /** 由哪次技能更新产生；迁移为 null。 */
  updateId: string | null;
  /** 核对人的员工 id；迁移写 'hub'。 */
  checkedBy: string | null;
  categories: string[];
  /** P75f 迁移用：为假时写入后不物化技能文件（迁移收尾统一物化）；缺省为真。 */
  materialize?: boolean;
}

/** 找这位员工；不存在抛中文错误。 */
function botOf(ctx: HubContext, botId: string): Bot {
  const bot = ctx.store.table('bots').get(botId);
  if (!bot) throw new Error('botId：机器人不存在');
  return bot;
}

/** 找这条技能；不存在或不属于这位员工抛中文错误。 */
function skillOf(ctx: HubContext, botId: string, skillId: string): Skill {
  const skill = ctx.store.table('skills').get(skillId);
  if (!skill || skill.botId !== botId) throw new Error('skillId：这条技能不存在或不属于这位员工');
  return skill;
}

/** 这位员工「在用」的自己积累技能条数。 */
export function activeSelfSkillCount(ctx: HubContext, botId: string): number {
  return ctx.store.table('skills').count(row => row.botId === botId && row.state === 'active');
}

/** 生成一个不与现有目录名冲突的新技能（id 后 8 位做目录名；冲突就换一个 id）。 */
function newSkillRow(ctx: HubContext, botId: string, now: number, info: { title: string; whenToUse: string; supplements: string | null }): Skill {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const id = newId('sk', ctx.rng);
    const dirName = `${D.DIR_PREFIX}${id.slice(-8)}`;
    if (ctx.store.table('skills').list(row => row.dirName === dirName).length > 0) continue;
    return SkillSchema.parse({
      id, botId, title: info.title, whenToUse: info.whenToUse, supplements: info.supplements, dirName,
      state: 'active', collapseReason: null, currentVersionNo: 1, categories: [], lastUsedAt: null, legacy: null,
      createdAt: now, updatedAt: now, collapsedAt: null,
    });
  }
  throw new Error('生成技能目录名失败：随机源连续产生重复名字，请重试');
}

/**
 * 写一个新版本（唯一入口之一）。全部校验通过才写；任何一条不过抛中文错误，什么都不写。
 * 返回新写的版本。
 */
export async function writeSkillVersion(ctx: HubContext, input: WriteSkillVersionInput): Promise<SkillVersion> {
  const bot = botOf(ctx, input.botId);
  const now = ctx.clock.now();
  // 出处先校验：句子引用的出处都要在表里、都属于这位员工（后面才轮到目标与条数的检查）。
  const knownSourceIds = new Set(ctx.store.table('skillSources').list(row => row.botId === bot.id).map(row => row.id));
  for (const sentence of input.sentences) {
    for (const id of sentence.sourceIds) {
      if (!knownSourceIds.has(id)) throw new Error(`出处 ${id} 不存在或不属于这位员工，不能写入`);
    }
  }
  // ---- 第一段：全部校验，一条都不写 ----
  const creating = input.skillId == null;
  let skill: Skill | null = null;
  if (creating) {
    if (input.newSkill == null) throw new Error('新建技能必须写明名称和什么时候用');
    if (input.change !== 'create' && input.change !== 'migrate') throw new Error('change：新建只能写 create 或 migrate');
    // 名称不与这位员工已有技能重复（在用与收起的都算，避免两条同名技能）。
    if (ctx.store.table('skills').count(row => row.botId === bot.id && row.title === input.newSkill!.title) > 0) {
      throw new Error(`已有一条叫「${input.newSkill.title}」的技能，请并入已有的技能`);
    }
    // 在用条数上限：满了就不能再新建。
    if (activeSelfSkillCount(ctx, bot.id) >= D.SELF_ACTIVE_MAX) {
      throw new Error(`在用的技能已有 ${D.SELF_ACTIVE_MAX} 条，请并入已有的技能`);
    }
  } else {
    if (input.newSkill != null) throw new Error('给已有技能写新版本时不能再写新技能的信息');
    if (input.change === 'create' || input.change === 'migrate') throw new Error('change：给已有技能写新版本只能写 add 或 merge');
    skill = skillOf(ctx, bot.id, input.skillId!);
  }
  // 出处已在前面临近入口处统一校验过（见函数开头）。
  // 句子按产生方式拼成新版本的正文。
  const current = skill === null ? null : ctx.store.table('skillVersions').list(row => row.skillId === skill!.id && row.no === skill!.currentVersionNo)[0] ?? null;
  const maxNo = skill === null ? 0 : Math.max(...ctx.store.table('skillVersions').list(row => row.skillId === skill!.id).map(row => row.no));
  const newNo = maxNo + 1;
  let sentences: { text: string; sourceIds: string[]; addedInNo: number }[];
  if (input.change === 'create' || input.change === 'migrate') {
    // 新建：全部句子都是第 1 版加入的。
    sentences = input.sentences.map(row => ({ ...row, addedInNo: 1 }));
  } else if (current === null) {
    throw new Error('这条技能没有当前版本，不能新增或合并');
  } else if (input.change === 'add') {
    // 新增：当前版本的句子加上新句子（新句子记新版本号）。
    sentences = [...current.sentences.map(row => ({ text: row.text, sourceIds: row.sourceIds, addedInNo: row.addedInNo })),
      ...input.sentences.map(row => ({ ...row, addedInNo: newNo }))];
  } else {
    // 合并：传入的就是合并后的全文；原技能里已有的句子保留它在原技能里的版本号，新写的句子记新版本号。
    sentences = input.sentences.map(row => {
      const existing = current.sentences.find(old => old.text === row.text);
      return { ...row, addedInNo: existing?.addedInNo ?? newNo };
    });
  }
  // 句数上限（合并后的总数）。
  if (sentences.length > D.SENTENCES_MAX) {
    throw new Error(`这条技能已有 ${sentences.length} 句，先在每周整理时合并`);
  }
  // 收起的技能有新内容等于放回：放回也不能超过在用条数上限。
  if (skill !== null && skill.state === 'collapsed' && activeSelfSkillCount(ctx, bot.id) >= D.SELF_ACTIVE_MAX) {
    throw new Error(`在用的技能已有 ${D.SELF_ACTIVE_MAX} 条，请并入已有的技能`);
  }
  // P75r3 第 4 节：技能行和版本行都在写任何一行之前解析好：每一句非空、不超字数、有出处，句数，标题、「什么时候用」等，
  // 任何一项不合格都在这里抛错，不会留下没有版本的残行（原来先写技能行、后解析版本，不合格时技能行留在表里占在用名额）。
  let newSkillRowValue: Skill | null = null;
  if (creating) {
    skill = newSkillRow(ctx, bot.id, now, input.newSkill!);
    // 新建时把这次出处带来的类别一并记上（去重）；迁移来的同时写上旧经验的来源（legacy）。
    newSkillRowValue = SkillSchema.parse({ ...skill, categories: [...new Set(input.categories)], ...(input.legacy ? { legacy: input.legacy } : {}) });
  }
  const version = SkillVersionSchema.parse({
    id: newId('skv', ctx.rng), skillId: skill!.id, no: newNo, sentences, change: input.change,
    updateId: input.updateId, basedOnNo: input.change === 'create' || input.change === 'migrate' ? null : (current?.no ?? null),
    checkedBy: input.checkedBy, createdAt: now,
  });
  // ---- 第二段：写入 ----
  if (newSkillRowValue !== null) ctx.store.table('skills').put(newSkillRowValue);
  ctx.store.table('skillVersions').put(version);
  if (!creating) {
    ctx.store.table('skills').patch(skill!.id, {
      currentVersionNo: newNo,
      categories: [...new Set([...skill!.categories, ...input.categories])],
      updatedAt: now,
      // 收起的技能有新内容等于放回（方案 7.4）。
      ...(skill!.state === 'collapsed' ? { state: 'active' as SkillState, collapseReason: null, collapsedAt: null } : {}),
    });
  }
  // ---- 第三段：物化与事件（出错只记日志，不影响写入结果；迁移批量写入时不逐条物化，收尾统一做） ----
  if (input.materialize !== false) {
    try { await syncSelfSkills(ctx, botOf(ctx, bot.id)); } catch (error) { ctx.logger.warn('技能文件物化失败', { botId: bot.id, error: String(error) }); }
  }
  ctx.emit(HUB_EVENT_SCOPES.bot, bot.id);
  return version;
}

/**
 * 收起或放回一条技能（唯一入口之二）。
 * 收起记原因与时间；放回清空两者，并检查在用条数上限（超了报错，什么都不改）。
 * 物化、发事件同 writeSkillVersion。返回改后的技能。
 */
export async function setSkillState(ctx: HubContext, skillId: string, state: SkillState, reason?: Skill['collapseReason']): Promise<Skill> {
  const skill = ctx.store.table('skills').get(skillId);
  if (!skill) throw new Error('skillId：这条技能不存在');
  const now = ctx.clock.now();
  if (state === 'collapsed') {
    if (reason == null) throw new Error('收起技能必须写明原因（unused、unknown_source、merged、migrated 之一）');
    ctx.store.table('skills').patch(skillId, { state: 'collapsed', collapseReason: reason, collapsedAt: now, updatedAt: now });
  } else {
    // 放回检查在用条数上限：这条本来就在用时不占新名额。
    if (skill.state !== 'active' && activeSelfSkillCount(ctx, skill.botId) >= D.SELF_ACTIVE_MAX) {
      throw new Error(`在用的技能已有 ${D.SELF_ACTIVE_MAX} 条，请并入已有的技能`);
    }
    // P75r5c（M3）：从「不常用」放回时记下放回的时间（本来就在用的不记），每周整理算「最近用到」时用。
    ctx.store.table('skills').patch(skillId, { state: 'active', collapseReason: null, collapsedAt: null, updatedAt: now,
      ...(skill.state !== 'active' ? { restoredAt: now } : {}) });
    // P75i：从「不常用」放回记一条审计（活动流「技能放回」一行从它生成；自动放回与主人手动放回都经这里）。
    if (skill.state !== 'active') writeOutreachAudit(ctx, 'skill_restore', { botId: skill.botId, skillId, title: skill.title }, 'hub');
  }
  const updated = ctx.store.table('skills').get(skillId)!;
  try { await syncSelfSkills(ctx, botOf(ctx, skill.botId)); } catch (error) { ctx.logger.warn('技能文件物化失败', { botId: skill.botId, error: String(error) }); }
  ctx.emit(HUB_EVENT_SCOPES.bot, skill.botId);
  return updated;
}

/**
 * 回退一条技能到某个版本（唯一入口之三）：版本存在才行；只改当前版本号，不生成新版本；
 * 被回退的版本仍保留，可以再回到它。物化、发事件同上。返回改后的技能。
 */
export async function rollbackSkill(ctx: HubContext, skillId: string, versionNo: number): Promise<Skill> {
  const skill = ctx.store.table('skills').get(skillId);
  if (!skill) throw new Error('skillId：这条技能不存在');
  if (!Number.isInteger(versionNo) || versionNo < 1) throw new Error('versionNo：必须是大于等于 1 的整数');
  const version = ctx.store.table('skillVersions').list(row => row.skillId === skillId && row.no === versionNo)[0];
  if (!version) throw new Error(`versionNo：这条技能没有第 ${versionNo} 版`);
  if (versionNo === skill.currentVersionNo) return skill; // 回到当前版本：什么都不用改
  const now = ctx.clock.now();
  ctx.store.table('skills').patch(skillId, { currentVersionNo: versionNo, updatedAt: now });
  const updated = ctx.store.table('skills').get(skillId)!;
  // P75i：回退记一条审计（活动流「技能回退」一行从它生成，14 天之后事件日志没了审计仍在）；标题一并记下，技能改名或删除后仍能显示。
  writeOutreachAudit(ctx, 'skill_rollback', { botId: skill.botId, skillId, title: skill.title, versionNo }, 'owner');
  try { await syncSelfSkills(ctx, botOf(ctx, skill.botId)); } catch (error) { ctx.logger.warn('技能文件物化失败', { botId: skill.botId, error: String(error) }); }
  ctx.emit(HUB_EVENT_SCOPES.bot, skill.botId);
  return updated;
}

/**
 * 工具守卫看到 `skill` 调用时记「最近用到」（P75e 第 9 节）：技能名（参数 name）是这位员工
 * 在用的自己积累技能的目录名时，只写 lastUsedAt 一个字段；不改守卫的决定；出错吞掉只记日志。
 */
export function markSkillUsed(ctx: HubContext, botId: string, skillName: string, now: number): void {
  try {
    const skill = ctx.store.table('skills').list(row => row.botId === botId && row.dirName === skillName && row.state === 'active')[0];
    if (!skill) return;
    ctx.store.table('skills').patch(skill.id, { lastUsedAt: now });
  } catch (error) {
    try { ctx.logger.warn('记录技能最近用到失败', { botId, error: String(error) }); } catch { /* 记不下来也不能影响工具调用 */ }
  }
}

/**
 * 接到同类的事时自动放回（P75e 第 7 节）：这位执行者收起原因为「久未用」的技能里，
 * 类别含这件事类别的，放回；来源不明、被合并的不放回；在用条数已满时不放回，只记审计。
 */
export async function restoreCollapsedForCategory(ctx: HubContext, botId: string, category: string): Promise<void> {
  for (const skill of selfSkillsOf(ctx, botId)) {
    // P75r2：升级迁移时因在用名额放不下而收起的（migrated）与久未用（unused）同样对待。
    if (skill.state !== 'collapsed' || (skill.collapseReason !== 'unused' && skill.collapseReason !== 'migrated')) continue;
    if (!skill.categories.includes(category)) continue;
    try {
      await setSkillState(ctx, skill.id, 'active');
    } catch (error) {
      // 在用已满等情况：不放回，只记审计。
      writeOutreachAudit(ctx, 'skill_restore_skipped', { botId, skillId: skill.id, category, reason: String(error instanceof Error ? error.message : error) }, botId);
    }
  }
}

/** 供进度与测试核对：本目录之外不得直接写两张表（约定，见任务卡第 3 节）。 */
export const SKILL_STORE_TABLES = ['skills', 'skillVersions'] as const;

/** 家目录技能目录的相对位置（与其他模块共用）。 */
export const SKILLS_DIR_REL = posix.join('.agents', 'skills');

/**
 * 技能库的视图（P75e 第 10 节）：员工卡片上的技能库一栏、技能详情、同类任务对比、技能刻度。
 *
 * 设计：数字与文字全部从表里算，不调用模型。每个视图都有「纯函数」版（输入显式给记录、名字表、预置清单、now、时区）
 * 和「读存储」版（从表里取数后调纯函数）；插件的一致性测试用同一份 zod schema 校验。
 * 视图文字不含内部编号（sk_、b_……）和工具名（hub_）：主人看不懂也不该看到。
 */
import { z } from 'zod';
import type { HubContext } from '../engine/context.js';
import type { JobOutcome, Skill, SkillSource, SkillUpdate, SkillVersion } from '../model/index.js';
import { presetSkillById, type PresetSkillOption } from '../config/preset-skills.js';
import { SKILL_DEFAULTS } from '../config/defaults.js';
import { localParts, startOfLocalDay } from '../util/time.js';
import { selfSkillsOf, versionsOfSkill } from '../skill/files.js';
import { lastTidyAt } from '../skill/tidy-sources.js';
import { parseRetroCardRef } from '../skill/card.js';
import { staffPostName } from '../team/workload.js';
import { jobCategory } from '../project/agreement-category.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** 出处种类给主人看的名字（顺序也是 sourceText 里列出的顺序：评审意见、你的纠正、你的指示、验收结果）。 */
export const SOURCE_KIND_LABELS: Record<SkillSource['kind'], string> = {
  review: '评审意见', owner_correction: '你的纠正', owner_instruction: '你的指示', acceptance: '验收结果', unknown: '来源不明',
};
/**
 * P75r7（A1 第 3 条）：「来自{种类}」的写法。出处种类为「来源不明」时前面不能再加「来自」（不能拼出「来自来源不明」），
 * 直接写「来源不明」；其余种类照旧写「来自{种类}」。所有拼「来自…」的地方都经过这个函数。
 */
export function sourceFromText(kind: SkillSource['kind']): string {
  return kind === 'unknown' ? SOURCE_KIND_LABELS.unknown : `来自${SOURCE_KIND_LABELS[kind]}`;
}
const SOURCE_KIND_ORDER: SkillSource['kind'][] = ['review', 'owner_correction', 'owner_instruction', 'acceptance'];
/** 旧经验的来源在版本文字里的说法（迁移版本用）。 */
const LEGACY_KIND_LABELS: Record<'routine' | 'lesson' | 'memory_md', string> = { routine: '套路', lesson: '规矩', memory_md: '长期记忆' };

/** {M}月{D}日。 */
function md(at: number, tz: string): string {
  const p = localParts(at, tz);
  return `${p.month}月${p.day}日`;
}
/** {HH:mm}。 */
function hm(at: number, tz: string): string {
  const p = localParts(at, tz);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}
/** 本地时区本周一 00:00（「本周更新」的判定线）。 */
function startOfWeekLocal(now: number, tz: string): number {
  let day = startOfLocalDay(now, tz);
  for (let index = 0; index < 8; index += 1) {
    if (localParts(day, tz).weekday === 1) return day;
    day = startOfLocalDay(day - 4 * 60 * 60 * 1000, tz);
  }
  return startOfLocalDay(now, tz);
}
/** 这次更新引用的出处种类里最长的一种（评审意见短、验收结果中、你的纠正与你的指示长）。 */
function tickLength(kinds: SkillSource['kind'][]): 'short' | 'mid' | 'long' {
  if (kinds.includes('owner_correction') || kinds.includes('owner_instruction')) return 'long';
  if (kinds.includes('acceptance')) return 'mid';
  return 'short';
}

// ---------------------------------------------------------------------------
// 视图结构与 schema
// ---------------------------------------------------------------------------

/** 技能库一栏里的一条自己积累技能。 */
export interface SkillRowView {
  skillId: string;
  title: string;
  versionText: string;
  badge: string | null;
  sourceText: string;
  supplementsText: string | null;
}
/** 岗位技能一条：预置或 DSH 技能（没有技能库编号，只读）。 */
export interface RoleSkillRowView { title: string; note: string }
export interface SkillGroupView {
  key: 'self' | 'role' | 'collapsed';
  label: string;
  note: string;
  items: SkillRowView[];
  roleItems: RoleSkillRowView[];
}
export interface SkillTickView { at: number; length: 'short' | 'mid' | 'long' | 'main'; fresh: boolean }
export interface SkillTicksView {
  headText: string;
  legend: string;
  ticks: SkillTickView[];
  lastText: string | null;
}
export interface SkillLibraryView {
  title: string;
  countText: string;
  lastUpdatedText: string | null;
  lastTidyText: string | null;
  groups: SkillGroupView[];
  ticks: SkillTicksView;
}
export interface SkillSentenceView { text: string; sourceText: string }
export interface SkillVersionRowView { no: number; text: string; current: boolean; canRollback: boolean }
export interface SkillCompareRowView { seqText: string; title: string; rounds: number; reworks: number; turns: number }
export interface SkillCompareView {
  title: string;
  headers: string[];
  rows: SkillCompareRowView[];
  note: string | null;
}
export interface SkillDetailView {
  skillId: string;
  title: string;
  headText: string;
  bodyTitle: string;
  sentences: SkillSentenceView[];
  versions: SkillVersionRowView[];
  compare: SkillCompareView | null;
  stateText: string | null;
  canRestore: boolean;
}

export const SkillRowViewSchema = z.strictObject({
  skillId: z.string(), title: z.string(), versionText: z.string(),
  badge: z.string().nullable(), sourceText: z.string(), supplementsText: z.string().nullable(),
});
export const SkillTicksViewSchema = z.strictObject({
  headText: z.string(), legend: z.string(),
  ticks: z.array(z.strictObject({ at: z.number(), length: z.enum(['short', 'mid', 'long', 'main']), fresh: z.boolean() })),
  lastText: z.string().nullable(),
});
export const SkillLibraryViewSchema = z.strictObject({
  title: z.string(), countText: z.string(), lastUpdatedText: z.string().nullable(), lastTidyText: z.string().nullable(),
  groups: z.array(z.strictObject({
    key: z.enum(['self', 'role', 'collapsed']), label: z.string(), note: z.string(),
    items: z.array(SkillRowViewSchema), roleItems: z.array(z.strictObject({ title: z.string(), note: z.string() })),
  })),
  ticks: SkillTicksViewSchema,
});
export const SkillDetailViewSchema = z.strictObject({
  skillId: z.string(), title: z.string(), headText: z.string(), bodyTitle: z.string(),
  sentences: z.array(z.strictObject({ text: z.string(), sourceText: z.string() })),
  versions: z.array(z.strictObject({ no: z.number(), text: z.string(), current: z.boolean(), canRollback: z.boolean() })),
  compare: z.strictObject({
    title: z.string(), headers: z.array(z.string()),
    rows: z.array(z.strictObject({ seqText: z.string(), title: z.string(), rounds: z.number(), reworks: z.number(), turns: z.number() })),
    note: z.string().nullable(),
  }).nullable(),
  stateText: z.string().nullable(), canRestore: z.boolean(),
});

// ---------------------------------------------------------------------------
// 小工具：一行技能的「来自哪里」
// ---------------------------------------------------------------------------

/** 一条技能引用到的全部出处（按全部版本的句子收集，是这条技能的完整学习经历）。 */
export function sourcesOfSkill(versions: SkillVersion[], sources: SkillSource[]): SkillSource[] {
  const wanted = new Set(versions.flatMap(version => version.sentences.flatMap(row => row.sourceIds)));
  const byId = new Map(sources.map(row => [row.id, row]));
  return [...wanted].map(id => byId.get(id)).filter((row): row is SkillSource => row !== undefined);
}

/** SkillRowView.sourceText 的算法（P75e 第 10 节）：出处来自 2 件及以上的事时列各来源的条数，否则写种类和日期。 */
export function skillSourceText(sourceRows: SkillSource[], tz: string): string {
  if (sourceRows.length === 0 || sourceRows.every(row => row.kind === 'unknown')) return '来源不明';
  const jobs = new Set(sourceRows.filter(row => row.jobId !== null).map(row => row.jobId));
  if (jobs.size >= 2) {
    const parts = SOURCE_KIND_ORDER
      .map(kind => ({ kind, count: sourceRows.filter(row => row.kind === kind).length }))
      .filter(row => row.count > 0)
      .map(row => `${SOURCE_KIND_LABELS[row.kind]} ${row.count}`);
    return `来自 ${jobs.size} 件事　${parts.join('、')}`;
  }
  const latest = [...sourceRows].sort((a, b) => b.createdAt - a.createdAt)[0]!;
  return latest.kind === 'unknown' ? '来源不明' : `${sourceFromText(latest.kind)}　${md(latest.createdAt, tz)}`;
}

/** 一条技能的一行视图。 */
function skillRowView(skill: Skill, versions: SkillVersion[], sources: SkillSource[], now: number, tz: string): SkillRowView {
  const usedSources = sourcesOfSkill(versions.filter(row => row.skillId === skill.id), sources);
  const weekStart = startOfWeekLocal(now, tz);
  const badge = versions.some(version => version.skillId === skill.id && version.createdAt > weekStart) ? '本周更新' : null;
  return {
    skillId: skill.id,
    title: skill.title,
    versionText: `第 ${skill.currentVersionNo} 版`,
    badge,
    sourceText: skillSourceText(usedSources, tz),
    supplementsText: skill.supplements === null ? null : `补充自「${skill.supplements}」`,
  };
}

// ---------------------------------------------------------------------------
// 技能刻度（纯函数）
// ---------------------------------------------------------------------------

/** 刻度的纯函数输入。 */
export interface SkillTicksInput {
  updates: SkillUpdate[];
  sources: SkillSource[];
  now: number;
  tz: string;
  botCreatedAt: number;
}

/** 刻度（方案 7.8）：只数核对通过的更新（迁移不产生技能更新，天然不刻）。 */
export function buildSkillTicks(input: SkillTicksInput): SkillTicksView {
  const passed = input.updates.filter(row => row.state === 'passed').sort((a, b) => a.updatedAt - b.updatedAt);
  const byId = new Map(input.sources.map(row => [row.id, row]));
  const kindsOf = (update: SkillUpdate): SkillSource['kind'][] => update.sentences
    .flatMap(row => row.sourceIds.map(id => byId.get(id)?.kind)).filter((kind): kind is SkillSource['kind'] => kind !== undefined);
  const ticks: SkillTickView[] = passed.map(update => ({
    at: update.updatedAt,
    // 合并（每周整理）为主色；其余按出处种类里最长的一种。
    length: update.kind === 'merge' ? 'main' : tickLength(kindsOf(update)),
    fresh: input.now - update.updatedAt < DAY_MS,
  }));
  const latest = passed.at(-1) ?? null;
  let lastText: string | null = null;
  if (latest !== null) {
    const text = latest.kind === 'merge'
      ? `每周整理，合并 ${latest.mergeFromIds.length} 条`
      : `技能更新，${sourceFromText(kindsOf(latest)[0] ?? 'unknown')}`;
    lastText = `最近一道：${md(latest.updatedAt, input.tz)} ${text}`;
  }
  const days = Math.max(0, Math.floor((input.now - input.botCreatedAt) / DAY_MS));
  return { headText: `刻度　${passed.length} 道　入职 ${days} 天`, legend: '短：评审意见　中：验收结果　长：你的纠正　主色：整理合并', ticks, lastText };
}

// ---------------------------------------------------------------------------
// 技能库一栏（纯函数 + 读存储）
// ---------------------------------------------------------------------------

/** 技能库一栏的纯函数输入。 */
export interface SkillLibraryInput {
  botName: string;
  botCreatedAt: number;
  now: number;
  tz: string;
  skills: Skill[];
  versions: SkillVersion[];
  sources: SkillSource[];
  updates: SkillUpdate[];
  presetSelected: PresetSkillOption[];
  dshSkillNames: string[];
  postName: string | null;
  /** P75i：最近一次整理的结束时间（没有整理过为 null）；可省略：旧的调用方不带，省略等于没有整理过。 */
  lastTidyAt?: number | null;
}

/** 技能库一栏的纯函数。 */
export function buildSkillLibraryView(input: SkillLibraryInput): SkillLibraryView {
  const { now, tz } = input;
  const active = input.skills.filter(row => row.state === 'active');
  const collapsed = input.skills.filter(row => row.state === 'collapsed');
  const roleCount = input.presetSelected.length + input.dshSkillNames.length;
  const rowsOf = (rows: Skill[]) => rows.map(row => skillRowView(row, input.versions, input.sources, now, tz));
  const roleItems: RoleSkillRowView[] = [
    ...input.presetSelected.map(option => ({
      title: option.name,
      note: option.audience === 'role' ? `${input.postName ?? ''}岗位自带` : '通用，入职时选定',
    })),
    ...input.dshSkillNames.map(name => ({ title: name, note: 'DSH 技能，入职时选定' })),
  ];
  const latestUpdate = input.skills.length === 0 ? null : Math.max(...input.skills.map(row => row.updatedAt));
  return {
    title: '技能库',
    // P75r7（A4）：没有「不常用」的技能时写「{n} 条」；有时写「在用 {n} 条，不常用 {m} 条」，避免与下面三组合计对不上。
    countText: collapsed.length === 0 ? `${active.length + roleCount} 条` : `在用 ${active.length + roleCount} 条，不常用 ${collapsed.length} 条`,
    lastUpdatedText: latestUpdate === null ? null : `最近更新　${md(latestUpdate, tz)}`,
    // P75i：这位员工最近一次整理（整理做完或有收起）结束的日期「上次整理：{M}月{D}日」；没有整理过为 null。
    lastTidyText: input.lastTidyAt == null ? null : `上次整理：${md(input.lastTidyAt, tz)}`,
    groups: [
      { key: 'self', label: '自己积累', note: `${active.length} 条，${input.botName}自己维护`, items: rowsOf(active), roleItems: [] },
      { key: 'role', label: '岗位技能', note: `${roleCount} 条，预置，只读`, items: [], roleItems },
      { key: 'collapsed', label: '不常用', note: `${collapsed.length} 条`, items: rowsOf(collapsed), roleItems: [] },
    ],
    ticks: buildSkillTicks({ updates: input.updates, sources: input.sources, now, tz, botCreatedAt: input.botCreatedAt }),
  };
}

// ---------------------------------------------------------------------------
// 技能详情（纯函数 + 读存储）
// ---------------------------------------------------------------------------

/** 技能详情的纯函数输入。 */
export interface SkillDetailInput {
  now: number;
  tz: string;
  skill: Skill;
  versions: SkillVersion[];
  sources: SkillSource[];
  /** 这条技能相关的技能更新（版本文字里「合并『x』」要用）。 */
  updates: SkillUpdate[];
  /** 核对人的名字表（botId 到名字）；'hub' 不在表里。 */
  checkerNames: Record<string, string>;
  /** 技能名字表（skillId 到名字；合并与「已并入」要用）。 */
  skillTitles: Record<string, string>;
  /** 这位员工全部同类任务记录（对比时按类别现选）。 */
  outcomes: JobOutcome[];
  /** 收起原因是「被合并」时，并入的那条技能的名字；其余为 null。 */
  mergedIntoTitle: string | null;
}

/** 版本一行的文字（P75e 第 10 节 versions.text）。 */
export function versionRowText(version: SkillVersion, input: SkillDetailInput): string {
  const date = md(version.createdAt, input.tz);
  const checker = version.checkedBy === null || version.checkedBy === 'hub' ? '中心' : input.checkerNames[version.checkedBy] ?? '核对人';
  if (version.change === 'create') return `${date}　建立。${checker}核对通过。`;
  if (version.change === 'migrate') {
    return `${date}　由升级前的${LEGACY_KIND_LABELS[input.skill.legacy?.kind ?? 'memory_md']}迁入。`;
  }
  if (version.change === 'add') {
    const added = version.sentences.filter(row => row.addedInNo === version.no).length;
    return `${date}　新增 ${added} 句。${checker}核对通过。`;
  }
  // merge：被并入的技能名取这次更新记录里的 mergeFromIds。
  const update = input.updates.find(row => row.id === version.updateId);
  const fromTitles = (update?.mergeFromIds ?? []).map(id => input.skillTitles[id] ?? '另一条技能');
  return `${date}　合并${fromTitles.map(title => `「${title}」`).join('')}。${checker}核对通过。`;
}

/** 同类任务对比（P75e 第 10 节、方案 7.1）：第 1 次与最近两次，最多 3 行；note 全部按数字拼出。 */
export function buildSkillCompare(skill: Skill, outcomes: JobOutcome[], versions: SkillVersion[], tz: string): SkillCompareView | null {
  // 类别取这条技能的类别里、这位员工记录最多的一个。
  let best: { category: string; rows: JobOutcome[] } | null = null;
  for (const category of skill.categories) {
    const rows = outcomes.filter(row => row.category === category).sort((a, b) => a.acceptedAt - b.acceptedAt || a.seq - b.seq);
    if (best === null || rows.length > best.rows.length) best = { category, rows };
  }
  if (best === null || best.rows.length < 2) return null;
  const picked: JobOutcome[] = [];
  for (const row of [best.rows[0]!, best.rows[best.rows.length - 2]!, best.rows[best.rows.length - 1]!]) {
    if (row !== undefined && !picked.includes(row)) picked.push(row);
  }
  const first = best.rows[0]!;
  const latest = best.rows[best.rows.length - 1]!;
  // 表下一句：先说最近一次核对，再说验收返工与「原因已记入第几版」。
  const parts: string[] = [];
  if (latest.rounds === 1) parts.push(`第 ${latest.seq} 次核对一次通过`);
  else {
    const diff = first.rounds - latest.rounds;
    const compareText = diff > 0 ? `比第 1 次少 ${diff} 轮` : diff === 0 ? '与第 1 次相同' : `比第 1 次多 ${-diff} 轮`;
    parts.push(`第 ${latest.seq} 次核对 ${latest.rounds} 轮，${compareText}`);
  }
  if (latest.reworks > 0) {
    let rework = `验收仍返工 ${latest.reworks} 次`;
    const later = [...versions].filter(row => row.createdAt > latest.acceptedAt).sort((a, b) => a.no - b.no)[0];
    if (later !== undefined) rework += `，原因已记入第 ${later.no} 版`;
    parts.push(rework);
  }
  return {
    title: `同类任务：${best.category}`,
    headers: ['第几次', '哪件事', '核对轮数', '验收返工', '回合'],
    rows: picked.map(row => ({ seqText: `第 ${row.seq} 次`, title: row.title, rounds: row.rounds, reworks: row.reworks, turns: row.turns })),
    note: `${parts.join('；')}。`,
  };
}

/** 收起说明（stateText）。 */
export function skillStateText(skill: Skill, mergedIntoTitle: string | null, now: number): string | null {
  if (skill.state !== 'collapsed') return null;
  if (skill.collapseReason === 'unknown_source') return '来源不明，已收起。';
  if (skill.collapseReason === 'merged') return `已并入「${mergedIntoTitle ?? '另一条技能'}」。`;
  // P75r2：升级迁移时在用名额放不下而收起的，写事实（不是「没有用到」）。
  if (skill.collapseReason === 'migrated') return `升级时在用的技能超过 ${SKILL_DEFAULTS.SELF_ACTIVE_MAX} 条，移到「不常用」。`;
  const since = skill.lastUsedAt ?? skill.createdAt;
  const days = Math.max(0, Math.floor(((skill.collapsedAt ?? now) - since) / DAY_MS));
  return `${days} 天内没有用到，移到「不常用」。`;
}

/** 技能详情的纯函数。 */
export function buildSkillDetailView(input: SkillDetailInput): SkillDetailView {
  const { skill, tz } = input;
  const versions = [...input.versions].sort((a, b) => b.no - a.no);
  const current = versions.find(row => row.no === skill.currentVersionNo) ?? versions[0]!;
  const byId = new Map(input.sources.map(row => [row.id, row]));
  const sentences = (current?.sentences ?? []).map(row => ({
    text: row.text,
    sourceText: row.sourceIds
      .map(id => byId.get(id)).filter((source): source is SkillSource => source !== undefined)
      .map(source => `第 ${row.addedInNo} 版　${sourceFromText(source.kind)}：${source.label}`)
      .join('；'),
  }));
  return {
    skillId: skill.id,
    title: skill.title,
    headText: `第 ${skill.currentVersionNo} 版　${md(current.createdAt, tz)} ${hm(current.createdAt, tz)}`,
    bodyTitle: '正文　每一句都注明出处',
    sentences,
    versions: versions.map(version => ({
      no: version.no,
      text: versionRowText(version, input),
      current: version.no === skill.currentVersionNo,
      // 回退按钮：非当前版本就可以回退到它（方案 7.4）。
      canRollback: version.no !== skill.currentVersionNo,
    })),
    compare: buildSkillCompare(skill, input.outcomes, input.versions, tz),
    stateText: skillStateText(skill, input.mergedIntoTitle, input.now),
    canRestore: skill.state === 'collapsed',
  };
}

// ---------------------------------------------------------------------------
// 读存储版
// ---------------------------------------------------------------------------

/** 技能库一栏（读存储）。 */
export function skillLibraryView(ctx: HubContext, botId: string): SkillLibraryView {
  const bot = ctx.store.table('bots').get(botId);
  if (!bot) throw new Error('botId：机器人不存在');
  const skills = selfSkillsOf(ctx, botId);
  const versions = ctx.store.table('skillVersions').list(row => skills.some(skill => skill.id === row.skillId));
  const sourceIds = new Set(versions.flatMap(version => version.sentences.flatMap(row => row.sourceIds)));
  const sources = ctx.store.table('skillSources').list(row => row.botId === botId && sourceIds.has(row.id));
  const presetSelected: PresetSkillOption[] = bot.presetSkillIds
    .map(id => presetSkillById(id)).filter((row): row is NonNullable<typeof row> => row !== null)
    .map(row => ({ id: row.id, name: row.name, purpose: row.purpose, ...(row.audience === undefined ? {} : { audience: row.audience }) }));
  return SkillLibraryViewSchema.parse(buildSkillLibraryView({
    botName: bot.name, botCreatedAt: bot.createdAt, now: ctx.clock.now(), tz: ctx.settings.timezone,
    skills, versions, sources,
    updates: ctx.store.table('skillUpdates').list(row => row.botId === botId),
    presetSelected, dshSkillNames: [...bot.dshSkillNames], postName: staffPostName(ctx, bot),
    lastTidyAt: lastTidyAt(ctx, botId),
  }));
}

/** 技能详情（读存储）。 */
export function skillDetailView(ctx: HubContext, skillId: string): SkillDetailView {
  const skill = ctx.store.table('skills').get(skillId);
  if (!skill) throw new Error('skillId：这条技能不存在');
  const versions = versionsOfSkill(ctx, skill.id);
  const sourceIds = new Set(versions.flatMap(version => version.sentences.flatMap(row => row.sourceIds)));
  // 核对人的名字表：版本里出现过的核对人。
  const checkerNames: Record<string, string> = {};
  for (const version of versions) {
    if (version.checkedBy !== null && version.checkedBy !== 'hub' && !(version.checkedBy in checkerNames)) {
      checkerNames[version.checkedBy] = ctx.store.table('bots').get(version.checkedBy)?.name ?? '核对人';
    }
  }
  // 这条技能相关的更新（版本的「合并『x』」要用）与技能名字表。
  const updates = ctx.store.table('skillUpdates').list(row => row.skillId === skill.id);
  const skillTitles: Record<string, string> = {};
  for (const update of updates) {
    if (update.skillId !== null && !(update.skillId in skillTitles)) skillTitles[update.skillId] = ctx.store.table('skills').get(update.skillId)?.title ?? '另一条技能';
    for (const from of update.mergeFromIds) if (!(from in skillTitles)) skillTitles[from] = ctx.store.table('skills').get(from)?.title ?? '另一条技能';
  }
  // 收起原因是「被合并」时：把它列进 mergeFromIds 的那次更新的目标技能名。
  let mergedIntoTitle: string | null = null;
  const mergingUpdate = ctx.store.table('skillUpdates').list(row => row.botId === skill.botId && row.mergeFromIds.includes(skill.id))[0] ?? null;
  if (mergingUpdate !== null && mergingUpdate.skillId !== null) {
    mergedIntoTitle = ctx.store.table('skills').get(mergingUpdate.skillId)?.title ?? null;
  }
  return SkillDetailViewSchema.parse(buildSkillDetailView({
    now: ctx.clock.now(), tz: ctx.settings.timezone, skill, versions,
    sources: ctx.store.table('skillSources').list(row => row.botId === skill.botId && sourceIds.has(row.id)),
    checkerNames, skillTitles, updates, mergedIntoTitle,
    outcomes: ctx.store.table('jobOutcomes').list(row => row.executorId === skill.botId),
  }));
}

/** UiApi 命令的入参校验（P75e 第 10 节；宿主路由由 P75j 接）。 */
export const RollbackSkillInputSchema = z.strictObject({
  skillId: z.string().min(1, 'skillId：不能为空'),
  versionNo: z.number({ error: 'versionNo：必须是整数' }).int('versionNo：必须是整数').min(1, 'versionNo：不能小于 1'),
});
export const RestoreSkillInputSchema = z.strictObject({
  skillId: z.string().min(1, 'skillId：不能为空'),
});
/** P75i：总管私聊里学习选会话的提问卡上点某一段会话（runId 是学习记录编号，option 是被点的选项文字）。 */
export const ChooseLearnSessionInputSchema = z.strictObject({
  runId: z.string().min(1, 'runId：不能为空'),
  option: z.string().min(1, 'option：不能为空'),
});

// ---------------------------------------------------------------------------
// P75g：复盘卡（主题折叠组里的 job_card，refId 为 retro:<runId>:<botId>）
// ---------------------------------------------------------------------------

/** 复盘卡的一行：一条出处，和它被哪次更新引用（或没被引用时的说明）。 */
export interface RetroCardRowView {
  sourceKindText: '评审意见' | '你的纠正' | '验收结果';
  sourceText: string;
  target: string;
  targetDetail: string | null;
}

export interface RetroCardView {
  kind: 'retro';
  head: '复盘';
  title: string;
  countsText: string;
  rows: RetroCardRowView[];
  footer: string | null;
}

export const RetroCardViewSchema = z.strictObject({
  kind: z.literal('retro'),
  head: z.literal('复盘'),
  title: z.string(),
  countsText: z.string(),
  rows: z.array(z.strictObject({
    sourceKindText: z.enum(['评审意见', '你的纠正', '验收结果']),
    sourceText: z.string(),
    target: z.string(),
    targetDetail: z.string().nullable(),
  })),
  footer: z.string().nullable(),
});

/** 复盘卡的纯函数输入：全部由调用方显式给出（读存储版在下面）。 */
export interface RetroCardInput {
  /** 提交人的名字。 */
  submitterName: string;
  /** 这件事的标题。 */
  title: string;
  /** 这位参与者的出处，按记录里 sourceIds 的顺序（src1、src2……的顺序）。 */
  sources: SkillSource[];
  /** 这次复盘这位参与者提交的技能更新（从旧到新）。 */
  updates: SkillUpdate[];
  /** skillId → 技能名称。 */
  skillTitles: Record<string, string>;
  /** skillId → 当前版本号（「第 v 版改为第 v+1 版」用）。 */
  skillCurrentVersions: Record<string, number>;
  /** 核对人 id → 名字；总管由调用方换成「总管」放进来。 */
  checkerNames: Record<string, string>;
  /** reviewId → 核对的轮次与阶段（出处行的「第 r 轮退回第 no 条」用）。 */
  reviewInfo: Record<string, { stage: number; round: number }>;
  /** 这件事的同类任务记录（验收结果那行「记为……第 seq 次数据」用）；没有为 null。 */
  outcome: { seq: number; category: string } | null;
  /** 这件事的类别（验收结果没有被引用时的说明用）。 */
  category: string;
  /** P75h：改写卡（员工按核对人意见改写之后落的卡）：标题后加「（改写）」，计数只写技能更新，出处只列被引用的。 */
  rewrite?: boolean;
}

/** 一条更新新增的句数（2 到 5，上限见 SENTENCES_PER_UPDATE_MAX）对应的汉字。 */
const CHINESE_COUNT: Record<number, string> = { 2: '两', 3: '三', 4: '四', 5: '五' };

/** 复盘卡的纯函数（任务卡第 8 节，逐字）。 */
export function buildRetroCard(input: RetroCardInput): RetroCardView {
  const rows: RetroCardRowView[] = input.sources.map(source => {
    // 出处那一行的左栏。
    let sourceText = source.quote;
    if (source.kind === 'review') {
      const info = source.refs.reviewId !== undefined ? input.reviewInfo[source.refs.reviewId] : undefined;
      const roundText = info === undefined ? '' : info.stage >= 2 ? `第 ${info.stage} 阶段第 ${info.round} 轮` : `第 ${info.round} 轮`;
      sourceText = `${roundText}退回第 ${source.refs.itemNo ?? '?'} 条：「${source.quote}」`;
    } else if (source.kind === 'owner_correction') {
      sourceText = source.refs.itemNo !== undefined
        ? `验收时指出第 ${source.refs.itemNo} 条：「${source.quote}」`
        : `你在主题里说：「${source.quote}」`;
    }
    // 右栏：这条出处被哪次更新引用。
    const citing = input.updates.filter(update => update.sentences.some(sentence => sentence.sourceIds.includes(source.id)));
    if (citing.length > 0) {
      const update = citing[0]!;
      const skillName = update.skillId === null ? update.newSkill?.title ?? '新技能' : input.skillTitles[update.skillId] ?? '技能';
      const isNew = update.skillId === null;
      const detail = update.sentences.filter(sentence => sentence.sourceIds.includes(source.id)).map(sentence => sentence.text).join('；');
      return { sourceKindText: kindTextOf(source), sourceText, target: isNew ? `新建「${skillName}」` : `更新「${skillName}」`, targetDetail: detail };
    }
    if (source.kind === 'acceptance') {
      const seq = input.outcome?.seq ?? 1;
      return { sourceKindText: '验收结果', sourceText, target: '不更新技能', targetDetail: `记为「${input.outcome?.category ?? input.category}」类任务的第 ${seq} 次数据，供下次对比。` };
    }
    return { sourceKindText: kindTextOf(source), sourceText, target: '没有写成技能', targetDetail: null };
  });
  // 底部：每项更新一句，用空格连接。
  const footerParts = input.updates.map(update => {
    const checker = input.checkerNames[update.checkerId] ?? '核对人';
    if (update.skillId === null) {
      return `新建「${update.newSkill?.title ?? '新技能'}」，等${checker}核对。`;
    }
    const title = input.skillTitles[update.skillId] ?? '技能';
    // 已写入的更新（核对通过之后，P75h）技能的当前版本已经是新版本：按更新自己记的新版本号倒推，卡片上的字不随之变化。
    const to = update.versionNo ?? (input.skillCurrentVersions[update.skillId] ?? 1) + 1;
    const from = to - 1;
    // 处数写汉字（两、三、四、五）：设计稿 A 与任务卡第 12 节第 16 条的逐字文字是「两处新增合并为一次更新」。
    return update.sentences.length >= 2
      ? `${CHINESE_COUNT[update.sentences.length] ?? String(update.sentences.length)}处新增合并为一次更新：「${title}」第 ${from} 版改为第 ${to} 版，等${checker}核对。`
      : `「${title}」第 ${from} 版改为第 ${to} 版，等${checker}核对。`;
  });
  return {
    kind: 'retro', head: '复盘',
    title: `${input.submitterName}　${input.title}${input.rewrite === true ? '（改写）' : ''}`,
    countsText: input.rewrite === true
      ? `技能更新 ${input.updates.length} 条`
      : `出处 ${input.sources.length} 条　技能更新 ${input.updates.length} 条`,
    rows,
    footer: footerParts.length === 0 ? null : footerParts.join(' '),
  };
}

/** 出处种类给主人看的名字（复盘卡只用三种）。 */
function kindTextOf(source: SkillSource): RetroCardRowView['sourceKindText'] {
  if (source.kind === 'review') return '评审意见';
  if (source.kind === 'acceptance') return '验收结果';
  return '你的纠正';
}

/**
 * 读存储版：按复盘卡的 refId（retro:<runId>:<botId>，改写卡多带 :rewrite:<updateId>）取数并调纯函数；找不到返回 null。
 * 改写卡只显示那一条更新和它引用的出处。
 */
export function retroCardView(ctx: HubContext, refId: string): RetroCardView | null {
  const ref = parseRetroCardRef(refId);
  if (ref === null) return null;
  const { runId, botId } = ref;
  const run = ctx.store.table('skillRuns').get(runId);
  const bot = ctx.store.table('bots').get(botId);
  if (run === null || bot === null) return null;
  const participant = run.participants.find(row => row.botId === botId);
  if (participant === undefined) return null;
  const job = run.jobId === null ? null : ctx.store.table('jobs').get(run.jobId);
  if (job === null) return null;
  // 普通复盘卡显示这位员工在这次复盘里提交的全部更新；改写卡只显示被改写的那一条（找不到这条更新就没有卡）。
  const updates = ctx.store.table('skillUpdates').list(row => row.runId === run.id && row.botId === botId && (ref.updateId === null || row.id === ref.updateId));
  if (ref.updateId !== null && updates.length === 0) return null;
  const skillTitles: Record<string, string> = {};
  const skillCurrentVersions: Record<string, number> = {};
  for (const update of updates) {
    for (const skillId of [update.skillId, ...update.mergeFromIds]) {
      if (skillId === null || skillId in skillTitles) continue;
      const skill = ctx.store.table('skills').get(skillId);
      if (skill !== null) { skillTitles[skillId] = skill.title; skillCurrentVersions[skillId] = skill.currentVersionNo; }
    }
  }
  const checkerNames: Record<string, string> = {};
  for (const id of [...new Set(updates.map(row => row.checkerId))]) {
    checkerNames[id] = id === job.chiefId ? '总管' : ctx.store.table('bots').get(id)?.name ?? '核对人';
  }
  const reviewInfo: Record<string, { stage: number; round: number }> = {};
  for (const review of ctx.store.table('jobReviews').list(row => row.jobId === job.id)) reviewInfo[review.id] = { stage: review.stage, round: review.round };
  const outcome = ctx.store.table('jobOutcomes').get(job.id);
  // 改写卡只列被引用的出处（任务卡第 5 节）；普通复盘卡列这位员工的全部出处。
  const cited = new Set(updates.flatMap(update => update.sentences.flatMap(sentence => sentence.sourceIds)));
  return RetroCardViewSchema.parse(buildRetroCard({
    submitterName: bot.name,
    title: ctx.store.table('agreements').get(job.agreementId)?.title ?? '这件事',
    sources: participant.sourceIds
      .filter(id => ref.updateId === null || cited.has(id))
      .map(id => ctx.store.table('skillSources').get(id)).filter((row): row is SkillSource => row !== null),
    updates, skillTitles, skillCurrentVersions, checkerNames, reviewInfo,
    outcome: outcome === null ? null : { seq: outcome.seq, category: outcome.category },
    category: jobCategory(ctx, job.id),
    ...(ref.updateId === null ? {} : { rewrite: true }),
  }));
}


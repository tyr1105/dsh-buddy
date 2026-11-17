/**
 * 活动流里的「技能库」一类记录（P75i 第 6 节）：每周整理、技能更新通过与放弃、技能回退与放回、复盘等待过期或回合用完。
 *
 * 为什么从表里生成、不读事件日志：事件日志在内存里只保留 14 天，而这些记录要在几个月之后仍然正确；
 * 整理、更新、复盘的事实都在 skillRuns、skillUpdates、skills 表里；回退和放回只有审计记录（skill_rollback、skill_restore）。
 * 文字全部由中心按记录拼出（不调用模型），逐字照任务卡；不出现内部编号和工具名。
 *
 * 一行记录 = 一个 ActivityRow（kind 为 skill）；整理那一行有「同一组的细项」lines。行的 botId 是这位员工。
 */
import type { HubContext } from '../engine/context.js';
import type { SkillRun, SkillUpdate } from '../model/skill.js';
import { readAuditDetail } from '../outreach/audit.js';
import { jobTitleOf } from '../job/chain.js';
import { internalNameIn } from '../job/owner-text.js';
import { SKILL_DEFAULTS as D } from '../config/defaults.js';
import { MERGE_ABANDON_REASON, MERGE_NOT_ACTIVE_REASON, MERGE_STALE_REASON } from '../skill/merge-reasons.js';
import { sourceFromText } from './skill-views.js';

/** 一行技能库记录（还没有补齐员工颜色和时间文字，由 activityView 统一补）。 */
export interface SkillActivityRow { id: string; at: number; botId: string | null; text: string; lines?: string[] }

/** 核对人的称呼：总管写「总管」（与复盘卡一致），其余取名字。 */
function checkerName(ctx: HubContext, botId: string): string {
  const bot = ctx.store.table('bots').get(botId);
  return bot?.role === 'chief' ? '总管' : bot?.name ?? '员工';
}

/** 员工自己的名字（被整理、提交更新的人）。 */
function ownName(ctx: HubContext, botId: string): string {
  return ctx.store.table('bots').get(botId)?.name ?? '员工';
}

/** 一条技能的名字（找不到时写「技能」）。 */
function skillTitle(ctx: HubContext, skillId: string | null): string {
  return skillId === null ? '技能' : ctx.store.table('skills').get(skillId)?.title ?? '技能';
}

/** 这条更新对应的技能名（新建取新技能的名称）。 */
function updateSkillTitle(ctx: HubContext, update: SkillUpdate): string {
  return update.skillId === null ? update.newSkill?.title ?? '新技能' : skillTitle(ctx, update.skillId);
}

/** 去掉句末的句号、叹号、问号（拼「{reason}；两处出处都保留。」时避免重复标点）。 */
function noEnd(text: string): string {
  return text.trim().replace(/[。.！!？?]+$/u, '');
}

/** 一段话的第一句，句末统一写「。」：「没有发现相互矛盾的条目」「没有发现。其他略」都写成一句带句号的话。 */
function firstSentence(text: string): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  const match = /^(.*?)[。！？!?]/u.exec(flat);
  return `${noEnd(match === null ? flat : match[1]!)}。`;
}

// ---------------------------------------------------------------------------
// 每周整理
// ---------------------------------------------------------------------------

/** 一条整理记录生成的行（零到两行：收起或合并的一组；没有整理成的一句说明）。 */
function tidyRows(ctx: HubContext, run: SkillRun): SkillActivityRow[] {
  const owner = run.participants.find(row => row.role !== 'checker');
  if (owner === undefined) return [];
  const name = ownName(ctx, owner.botId);
  const at = run.endedAt ?? run.createdAt;
  const rows: SkillActivityRow[] = [];
  const collapsed = run.collapsed ?? [];
  const merges = run.merges ?? [];
  const updates = merges.map(item => ({ item, update: ctx.store.table('skillUpdates').get(item.updateId) }));
  // 记录还没有结束（整理唤醒、核对唤醒在路上）时合并的结果还没出来，不生成「合并」的行，等结束再一起写。
  const ended = run.endedAt !== null;
  const passed = updates.filter(row => row.update?.state === 'passed');
  // 1：有合并或收起（或整理过没有可合并的）：一组记录。
  if (ended && (merges.length > 0 || collapsed.length > 0 || run.tidyNote != null)) {
    const checkerIds = [...new Set(passed.map(row => row.update!.checks.at(-1)?.checkerId ?? row.update!.checkerId))];
    const lines: string[] = [];
    // 「{名字}自己积累的技能　{a} 条变为 {b} 条」：整理过（提交了合并）且条数有变化才有（a 等于 b 时不出这一行）；
    // a 是收起之后员工开始整理时在用的自己积累技能条数，b 是核对通过的合并之后的条数（P75r5c：加「自己积累的」，与技能库顶部含岗位技能的数字区分）。
    if (merges.length > 0 && run.activeAtStart !== undefined && passed.length > 0) {
      lines.push(`${name}自己积累的技能　${run.activeAtStart} 条变为 ${run.activeAtStart - passed.length} 条`);
    }
    for (const { item, update } of updates) {
      const from = skillTitle(ctx, update?.mergeFromIds[0] ?? null);
      const into = skillTitle(ctx, update?.skillId ?? null);
      lines.push(mergeLine(ctx, item.reason, update, from, into));
    }
    for (const row of collapsed) {
      const title = skillTitle(ctx, row.skillId);
      // P75r5c（M4、L5）：「自动放回」只对有类别的技能成立（接到同类的事时按类别放回），没有类别的写「可以在技能库里放回」；
      // 来源不明的收起不会自动放回，也写「可以在技能库里放回」，并写明多少天没有用到。
      const categorised = (ctx.store.table('skills').get(row.skillId)?.categories ?? []).length > 0;
      lines.push(row.reason === 'unknown_source'
        ? `收起　「${title}」来源不明，${row.days ?? 30} 天内没有用到，移到「不常用」。不删除，可以在技能库里放回。`
        : `收起　「${title}」${row.days ?? 30} 天内没有用到，移到「不常用」。不删除，${categorised ? '下次接到同类的事自动放回' : '可以在技能库里放回'}。`);
    }
    if (run.tidyNote != null && run.tidyNote.trim() !== '') lines.push(`未改动　${firstSentence(run.tidyNote)}`);
    rows.push({ id: `skill-tidy:${run.id}`, at, botId: owner.botId,
      text: `每周整理　${name}${checkerIds.length > 0 ? `　${checkerIds.map(id => checkerName(ctx, id)).join('、')}核对通过` : ''}`, lines });
  }
  // 2：没有整理成的一句说明（有收起时收起已在上面一组里，没有变化的那一句不再重复）。
  // P75r5c（审查 L5）：没有整理成的几种原因分开写；本周技能库没有变化（no_change）不出行（记录照建，活动流不显示）。
  const reason = owner.reason;
  const statusText = reason === 'busy_all_day' ? '本周未整理：一直有在办的事。'
    : reason === 'no_slot' ? '本周未整理：当天没有排上整理回合。'
      : reason === 'few_skills' ? `在用的技能不到 ${D.TIDY_MIN_SKILLS} 条，未整理。`
        : reason === 'no_checker' ? '本周未做合并：没有可以核对的同事。'
          : owner.state === 'capped' ? '本周没有完成整理：整理回合用完。' : null;
  if (statusText !== null && ended) rows.push({ id: `skill-tidy-note:${run.id}`, at, botId: owner.botId, text: `每周整理　${name}　${statusText}` });
  return rows;
}

/** 合并更新放弃时，更新上记的原因里「原技能有了变化」的两种（check.ts 的两条固定说法）。 */
const MERGE_CHANGED_REASONS: readonly string[] = [MERGE_NOT_ACTIVE_REASON, MERGE_STALE_REASON];

/**
 * 一项合并在整理那一组里的一行（P75r5c 第 5 节第 5、6 条）：
 * - 通过：写第几版、理由；两条原技能的出处在新版本里都有时才写「两处出处都保留」；
 * - 没有写入的几种原因分开写：未通过核对、没有完成核对、原技能有了新版本或已不在用、写入失败。
 */
function mergeLine(ctx: HubContext, reason: string, update: SkillUpdate | null, from: string, into: string): string {
  const head = `合并　「${from}」并入「${into}」`;
  if (update?.state === 'passed') {
    return `${head}第 ${update.versionNo ?? 1} 版。${noEnd(reason)}${bothSourcesKept(ctx, update) ? '；两处出处都保留' : ''}。`;
  }
  if (update === null || update.state === 'checking' || update.state === 'rewrite') return `${head}没有完成核对，未改动。`;
  const why = update.abandonReason ?? '';
  if (why === MERGE_ABANDON_REASON) return `${head}未通过核对，未改动。`;
  if (MERGE_CHANGED_REASONS.includes(why)) return `${head}时原技能已有变化，这次合并作废，未改动。`;
  if (MERGE_UNFINISHED_REASONS.includes(why)) return `${head}没有完成核对，未改动。`;
  return `${head}写入没有成功，未改动。`;
}

/** 合并没有完成核对的几种放弃原因（核对人没有核对或不在岗、回合用完、等待过期）：中心生成的固定说法。 */
const MERGE_UNFINISHED_REASONS: readonly string[] = ['核对人没有核对', '核对人没有在岗', '提交人没有在岗', '复盘回合用完', '整理回合用完', '学习回合用完', '等待超过 7 天'];

/**
 * 通过的合并，两条原技能的出处在新版本里是不是都有：被并入的技能和保留的技能，各自独有的出处都不为空，并且各至少有一个出现在新版本的句子里
 * （P75r6：两条技能共用的出处不算任何一侧的，一侧没有独有出处时中心判断不了内容是否都保留，不写「两处出处都保留」）。
 * 两条原技能的出处取整理时那一版（记了版本号用记下的，没记的取当前版本）。
 */
function bothSourcesKept(ctx: HubContext, update: SkillUpdate): boolean {
  // 一条技能在 maxNo 版（含）之前的全部版本里出现过的出处（没有给 maxNo 时取全部版本）。
  const sourcesOf = (skillId: string | null, maxNo: number | undefined): Set<string> => {
    if (skillId === null) return new Set();
    const versions = ctx.store.table('skillVersions').list(row => row.skillId === skillId && (maxNo === undefined || row.no <= maxNo));
    return new Set(versions.flatMap(version => version.sentences.flatMap(row => row.sourceIds)));
  };
  const fromSources = sourcesOf(update.mergeFromIds[0] ?? null, update.mergeBase?.fromVersionNo);
  // 保留的技能：没有记版本号的旧更新取「写入的新版本之前」的版本。
  const intoSources = sourcesOf(update.skillId, update.mergeBase?.intoVersionNo ?? Math.max(1, (update.versionNo ?? 2) - 1));
  const merged = new Set(update.sentences.flatMap(row => row.sourceIds));
  // P75r6（复验 N3）：只算两侧各自独有的出处（被并入的有、保留的没有的；保留的有、被并入的没有的）。
  // 两侧都有独有的出处、并且合并后的句子各用到至少一个时才算「两处出处都保留」；
  // 出处有重合、一侧没有独有出处时，中心判断不了内容是否都保留，不写这半句。
  const fromOnly = [...fromSources].filter(id => !intoSources.has(id));
  const intoOnly = [...intoSources].filter(id => !fromSources.has(id));
  return fromOnly.length > 0 && intoOnly.length > 0 && fromOnly.some(id => merged.has(id)) && intoOnly.some(id => merged.has(id));
}

// ---------------------------------------------------------------------------
// 技能更新、回退、放回、复盘未完成
// ---------------------------------------------------------------------------

/** 一条通过的技能更新：「技能更新　{名字}　「{技能}」第 {n} 版，来自{种类}（{标签}）。{核对人}核对通过。」；多个出处接「等 {k} 处」。 */
function passedUpdateRow(ctx: HubContext, update: SkillUpdate): SkillActivityRow {
  const sourceIds = [...new Set(update.sentences.flatMap(row => row.sourceIds))];
  const first = sourceIds.map(id => ctx.store.table('skillSources').get(id)).find(row => row !== null && row !== undefined) ?? null;
  const from = first === null ? '' : `，${sourceFromText(first.kind)}（${first.label}）${sourceIds.length > 1 ? `等 ${sourceIds.length} 处` : ''}`;
  const checker = checkerName(ctx, update.checks.at(-1)?.checkerId ?? update.checkerId);
  return { id: `skill-update:${update.id}`, at: update.updatedAt, botId: update.botId,
    text: `技能更新　${ownName(ctx, update.botId)}　「${updateSkillTitle(ctx, update)}」第 ${update.versionNo ?? 1} 版${from}。${checker}核对通过。` };
}

/**
 * 技能更新没有写入的原因（P75r5c 第 5 节第 7 条）：取更新上记的放弃原因（中心生成的固定说法）；
 * 核对不符、改写后仍不符的写「未通过核对」。写入失败时记的是系统错误原文，可能带内部编号，含内部名称或编号形状的一律写「写入没有成功」。
 */
function abandonText(update: SkillUpdate): string {
  const why = (update.abandonReason ?? '').trim();
  if (why === '' || why === '改写后仍不符' || why === MERGE_ABANDON_REASON) return '未通过核对';
  if (internalNameIn(why) !== null || /(?<![a-z0-9])[a-z]{1,4}_[0-9a-z]{6,}/.test(why)) return '写入没有成功';
  return why.replace(/[。！？.!?]+$/u, '');
}

/** 复盘参与者回合用完或等待过期的一行。 */
function retroRows(ctx: HubContext, run: SkillRun): SkillActivityRow[] {
  const job = run.jobId === null ? null : ctx.store.table('jobs').get(run.jobId);
  const title = job === null ? '这件事' : jobTitleOf(ctx, job);
  return run.participants.filter(row => row.role !== 'checker' && (row.state === 'expired' || row.state === 'capped')).map(row => ({
    id: `skill-retro:${run.id}:${row.botId}`, at: run.endedAt ?? run.createdAt, botId: row.botId,
    text: `复盘　${ownName(ctx, row.botId)}　「${title}」的复盘${row.state === 'expired' ? '等待超过 7 天，未进行' : '回合用完，未完成'}。`,
  }));
}

/** 全部技能库记录（未排序、未分页）。 */
export function skillActivityRows(ctx: HubContext): SkillActivityRow[] {
  const rows: SkillActivityRow[] = [];
  for (const run of ctx.store.table('skillRuns').list()) {
    if (run.kind === 'tidy') rows.push(...tidyRows(ctx, run));
    else if (run.kind === 'retro') rows.push(...retroRows(ctx, run));
  }
  for (const update of ctx.store.table('skillUpdates').list()) {
    // 合并更新的结果写在整理那一组里，不另起一行。
    if (update.kind === 'merge') continue;
    if (update.state === 'passed') rows.push(passedUpdateRow(ctx, update));
    else if (update.state === 'abandoned') {
      rows.push({ id: `skill-update:${update.id}`, at: update.updatedAt, botId: update.botId,
        text: `技能更新　${ownName(ctx, update.botId)}　「${updateSkillTitle(ctx, update)}」的一条更新没有写入：${abandonText(update)}。只留在记录里。` });
    }
  }
  for (const audit of ctx.store.log('audit').all()) {
    if (audit.action !== 'skill_rollback' && audit.action !== 'skill_restore') continue;
    const detail = readAuditDetail<{ botId?: string; skillId?: string; title?: string; versionNo?: number }>(audit.detail);
    if (detail?.botId === undefined) continue;
    const title = detail.title ?? skillTitle(ctx, detail.skillId ?? null);
    rows.push(audit.action === 'skill_rollback'
      ? { id: audit.id, at: audit.at, botId: detail.botId, text: `技能回退　${ownName(ctx, detail.botId)}　「${title}」已回退到第 ${detail.versionNo ?? 1} 版。` }
      : { id: audit.id, at: audit.at, botId: detail.botId, text: `技能放回　${ownName(ctx, detail.botId)}　「${title}」已放回。` });
  }
  return rows;
}

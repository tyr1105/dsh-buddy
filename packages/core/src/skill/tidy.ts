/**
 * 每周整理的触发（P75i 第 5.1 节）：每周一 TIDY_HOUR 点（按设置的时区）起，每位在岗员工（含总管）建一条整理记录，
 * 先按规则收起（不调用模型），再看这位员工上周有没有通过的技能更新、在用的技能够不够多，决定要不要排整理唤醒。
 *
 * 做什么（每位员工，依次）：
 * 1. 收起（不调用模型）：在用的自己积累技能里，「最近用到」的时间早于 now - 30 天的收起，记天数；
 *    「最近用到」取最近一次被调用、当前版本建立的时间、最近一次放回的时间三者里最晚的（P75r5c）；
 *    出处全是「来源不明」的，原因记 unknown_source，否则记 unused；「来源不明」不再单独成立，正在用的技能不会因它被收起。
 *    用 setSkillState 收起，可放回。
 * 2. 上周一 00:00 到本周一 00:00 之间这位员工有通过的更新，且收起之后在用的自己积累技能不少于 TIDY_MIN_SKILLS 条：
 *    参与者排队，排整理唤醒（事项键 tidy:<周一日期>:<员工>）；否则参与者记 skipped，记录立即结束：
 *    上周没有通过的更新记 no_change，有更新但在用技能不到 TIDY_MIN_SKILLS 条记 few_skills（P75r5c 分开记，活动流的写法不同）。
 *    要排唤醒但找不到核对人（派活说明第二节第 5 条）：这位员工本周只做收起，参与者记 skipped（原因 no_checker）。
 *
 * 幂等：以（周一日期、员工）为键，已有记录的不再建。中心周一停机、之后启动时本周内补做；当天 TIDY_LAST_HOUR 点之后不再新建
 * （留到第二天），已建而没做成的由 sweepSkillRuns 记 busy_all_day。
 * 迁移（P75b 的升级整理）没有完成时这一轮不做、不建记录：技能库的数据在迁移完成之后才齐，迁移完成后的下一次巡检照常补做。
 *
 * 时间一律用设置的时区和 util/time.ts 的本地时间函数，不自己算时区。整理不给主人发任何通知、不落私聊。
 */
import { SKILL_DEFAULTS as D } from '../config/defaults.js';
import type { HubContext } from '../engine/context.js';
import { parseInput } from '../engine/validation.js';
import { SkillRunSchema, type SkillRun } from '../model/skill.js';
import { localDateKey, localParts, parseLocalDateTime, startOfLocalDay } from '../util/time.js';
import { findSkillChecker } from './checker.js';
import { enqueueSkillWorkUndoable } from './enqueue.js';
import { tidyRunId, tidySubjectKey } from './keys.js';
import { migrationDone } from './learn.js';
import { offDutyReason, patchParticipant } from './retro-plan.js';
import { setSkillState } from './store.js';
import { sourceIdsInSkills, tidySkillsOf } from './tidy-sources.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// 整理记录的编号函数 tidyRunId 在 keys.ts（按键找记录要用它）；这里重新导出，原来的引用方式不变。
export { tidyRunId };

/** 本周一的本地日期（YYYY-MM-DD）：从 now 往回一次退 6 小时，直到本地星期是周一；不会跳过任何一天。 */
export function mondayKeyOf(ctx: HubContext, now: number): string {
  let at = now;
  for (let step = 0; step < 7 * 4 + 1 && localParts(at, ctx.settings.timezone).weekday !== 1; step += 1) at -= 6 * HOUR_MS;
  return localDateKey(at, ctx.settings.timezone);
}

/** 某个本地日期那一天从几点开始（毫秒）：取当天中午再取一天的开始，不碰夏令时缺失的钟点。 */
function dayStartOf(ctx: HubContext, dateKey: string): number {
  return startOfLocalDay(parseLocalDateTime(`${dateKey} 12:00`, ctx.settings.timezone), ctx.settings.timezone);
}

/** 每周整理的巡检（tick 里一项）：到点、本周还没建记录的员工各建一条。出错只影响那一位员工，抛出由 tick 的 safe 记日志。 */
export async function sweepWeeklyTidy(ctx: HubContext, now: number): Promise<void> {
  if (!migrationDone(ctx)) return;
  const tz = ctx.settings.timezone;
  const weekOf = mondayKeyOf(ctx, now);
  const triggerAt = parseLocalDateTime(`${weekOf} ${String(D.TIDY_HOUR).padStart(2, '0')}:00`, tz);
  if (now < triggerAt) return;
  // 当天过了 TIDY_LAST_HOUR 点不再新建：建了也没时间做，留到第二天（本周内补做）。
  if (localParts(now, tz).hour >= D.TIDY_LAST_HOUR) return;
  for (const bot of ctx.store.table('bots').list(row => offDutyReason(row) === null)) {
    // P75r5c（H1）：「本周已建」同样按编号判断，不看他是不是别人记录里的核对人。
    if (ctx.store.table('skillRuns').get(tidyRunId(weekOf, bot.id)) !== null) continue;
    // 到点之后才加入的员工，这一周没有他的整理。
    if (bot.createdAt >= triggerAt) continue;
    try {
      await createTidyRun(ctx, bot.id, weekOf, now);
    } catch (error) {
      ctx.logger.error('每周整理建记录失败', { botId: bot.id, weekOf, error: String(error) });
    }
  }
}

/** 建一位员工本周的整理记录：收起、判断、排唤醒。 */
async function createTidyRun(ctx: HubContext, botId: string, weekOf: string, now: number): Promise<void> {
  // ---- 1：按规则收起（不调用模型）----
  const collapsed: NonNullable<SkillRun['collapsed']> = [];
  for (const { skill, version } of tidySkillsOf(ctx, botId)) {
    // P75r5c（审查 M3、L9）：「最近用到」取三者里最晚的：最近一次被调用、当前版本建立的时间、最近一次放回的时间。
    // 以前只看调用时间（没有时取技能建立时间）：40 天前建、昨天刚写进新版本的技能会被当成 40 天没用；主人放回的技能下周一又被收起。
    const since = Math.max(skill.lastUsedAt ?? 0, version.createdAt, skill.restoredAt ?? 0);
    // 「来源不明」不再单独成立：只有 30 天没有用到的技能才会被收起；这时出处全是来源不明的记来源不明，否则记久未使用。
    // 也就是说正在用的技能不会因为来源不明被收起。
    if (!(since < now - D.UNUSED_COLLAPSE_MS)) continue;
    const sourceKinds = version.sentences.flatMap(row => row.sourceIds).map(id => ctx.store.table('skillSources').get(id)?.kind ?? null);
    const reason: 'unused' | 'unknown_source' = sourceKinds.length > 0 && sourceKinds.every(kind => kind === 'unknown') ? 'unknown_source' : 'unused';
    try {
      await setSkillState(ctx, skill.id, 'collapsed', reason);
      collapsed.push({ skillId: skill.id, reason, days: Math.max(0, Math.floor((now - since) / DAY_MS)) });
    } catch (error) {
      ctx.logger.warn('每周整理收起技能失败', { skillId: skill.id, error: String(error) });
    }
  }
  // ---- 2：上周有通过的更新、收起后在用的技能不少于 TIDY_MIN_SKILLS 条才整理 ----
  const thisMonday = dayStartOf(ctx, weekOf);
  // 上周一：从本周一往前退 3 天落在上周五，再取那一周的周一（不会退进本周）。
  const lastMonday = dayStartOf(ctx, mondayKeyOf(ctx, thisMonday - 3 * DAY_MS));
  const changed = ctx.store.table('skillUpdates').count(row => row.botId === botId && row.state === 'passed'
    && row.updatedAt >= lastMonday && row.updatedAt < thisMonday) > 0;
  const activeSkills = tidySkillsOf(ctx, botId);
  let state: SkillRun['participants'][number]['state'] = 'skipped';
  let reason: SkillRun['participants'][number]['reason'] = 'no_change';
  if (changed && activeSkills.length < D.TIDY_MIN_SKILLS) {
    // P75r5c（审查 L5）：上周有通过的更新、但在用的技能不到 TIDY_MIN_SKILLS 条，与「本周技能库没有变化」分开记。
    reason = 'few_skills';
  } else if (changed) {
    if (findSkillChecker(ctx, botId) === null) reason = 'no_checker';
    else { state = 'queued'; reason = null; }
  }
  const run = parseInput(SkillRunSchema, {
    id: tidyRunId(weekOf, botId), kind: 'tidy', jobId: null, category: null,
    // 出处编号表：记下收起之后在用技能当前版本里出现的出处顺序（唤醒包与 tidy 工具共用，见 tidy-sources.ts）。
    participants: [{ botId, role: 'executor', sourceIds: state === 'queued' ? sourceIdsInSkills(activeSkills) : [], state, reason }],
    turnsUsed: 0, turnCap: D.TIDY_TURN_CAP, tokens: 0, summaryPostedAt: null, createdAt: now,
    endedAt: state === 'queued' ? null : now, weekOf, collapsed, merges: [], tidyNote: null, activeAtStart: activeSkills.length,
  }, '整理记录');
  ctx.store.table('skillRuns').put(run);
  if (state !== 'queued') return;
  // ---- 排整理唤醒（出错只记日志，由 sweepSkillRuns 补排）----
  try {
    const wake = enqueueSkillWorkUndoable(ctx, { runId: run.id, botId, key: tidySubjectKey(weekOf, botId), title: '每周整理' });
    if (wake.entry === null) {
      const off = offDutyReason(ctx.store.table('bots').get(botId));
      if (off !== null) patchParticipant(ctx, run.id, botId, 'skipped', off);
    }
  } catch (error) {
    ctx.logger.warn('每周整理唤醒排队出错，由兜底补排', { runId: run.id, botId, error: String(error) });
  }
}

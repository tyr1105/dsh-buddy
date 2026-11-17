/**
 * 额度会误了交付时间的提示（P76h 第二段，方案 5.6、设计稿场景 E 下半「会耽误交付时才告诉你」）。
 *
 * 为什么要有：额度红灯期间员工不开新回合（员工份额用完，或真实额度用完），到恢复时刻才继续。
 * 如果「恢复时刻 + 这件事还要的回合 × 每回合用时」已经晚于约定的交付时间，主人应该在能做决定的时候知道，
 * 而不是等交付时间过了才发现。只在这种「会误事」的情况下才说，不会误事的事不说。
 *
 * 做法：每个 tick 调用一次 checkDueRisk。
 * - 「已提示」记号（jobNotices.dueRiskNotifiedAt）按额度窗口清：只在窗口起点比记号晚（窗口滚动过）时清空。
 *   P76m（审查 R16）：同一个窗口里灯由红转橙、之后又转红时不清，避免同一条提示在总管私聊里重复落一次。
 * - 灯不是红：清完过期的记号就结束。
 * - 灯是红：对每件进行中（待开工、执行中、核对中、返工中）、有交付时间、还没提示过的事，算预计做完的时刻；
 *   晚于交付时间的收进清单。同一个总管名下的几件合成一条消息，以总管的名义落在总管私聊，再推送一次。
 * - 同一个额度窗口里每件事只提示一次。
 * - P76m（审查 R13）：交付时间已经过去的事已经不算「可能晚」，句子写事实句「已过约定的 …」；
 *   清单里每一件都已过交付时间时，推送标题也写「已过交付时间」，不再写「可能晚于交付时间」。
 *
 * 不处理：已验收、在发布环节的事（交付已经完成，没有交付时间上的风险）；受阻、待你验收的事（不在做）。
 * 改交付时间本身不在这里：主人回复之后由总管照改约定的做法处理。
 * 红灯种类用 quota/plan.ts 的 redKindOf（按额度记录判断），恢复时刻用额度视图的 resetAt，不另写一套。
 */
import type { HubContext } from '../engine/context.js';
import { BUDGET_DEFAULTS } from '../config/defaults.js';
import type { Job } from '../model/job.js';
import { quotaWindowView } from '../api/quota-views.js';
import { notifyOwner } from '../outreach/notify.js';
import { postThread } from '../outreach/thread.js';
import { quotaClockText } from '../quota/clock-text.js';
import { DUE_RISK_REF_PREFIX, DUE_RISK_REF_SEPARATOR } from '../quota/owner-phrases.js';
import { getQuotaPlan, redKindOf, type RedKind } from '../quota/plan.js';
import { getQuotaState } from '../quota/window.js';
import { localParts } from '../util/time.js';
import { projectJob, usedTurnsOf } from './budget.js';
import { jobTitleOf } from './chain.js';
import { latestEstimate } from './estimate.js';
import { inLaunchPhase } from './launch-turns.js';
import { noticeOf, patchNotice } from './notices.js';
import { usageRowOf } from './usage.js';

/** 会受额度红灯影响的状态：正在做、马上要做的事。 */
const RUNNING_STATES: ReadonlyArray<Job['state']> = ['ready', 'doing', 'checking', 'rework'];

/** 清单里的一件事。 */
interface RiskyJob { job: Job; title: string; remaining: number; finishAt: number }

/** 这件事还要几个回合：有预计按 projectJob 的余下；没有预计（旧数据）按 max(1, 预算线 - 已用)。 */
function remainingTurns(ctx: HubContext, job: Job, now: number): number {
  const usage = ctx.store.table('jobUsage').get(job.id) ?? usageRowOf(ctx, job, now);
  const projection = projectJob(job, usage, latestEstimate(ctx, job.agreementId));
  if (projection !== null) return projection.remaining;
  return Math.max(1, job.turnCap - job.turnsUsed);
}

/**
 * 把时刻取整到下一个整点（按设置的时区）；正好是整点的不动。
 * 用本地的分、秒算要补多少，时区不是整小时偏移时也对。
 */
export function ceilToHour(at: number, timezone: string): number {
  const parts = localParts(at, timezone);
  const intoHour = (parts.minute * 60 + parts.second) * 1000 + (((at % 1000) + 1000) % 1000);
  return intoHour === 0 ? at : at + 3_600_000 - intoHour;
}

/**
 * 给主人看的整条消息（纯函数）。每件一段，段间空行：首句只写一次，每件一段，末句一次。
 * 时刻写法：同一天写「HH:mm」，跨日写「{M}月{D}日 HH:mm」（quotaClockText）。
 * P76m（审查 R13）：交付时间已经过去的事写「已过约定的 …」，不写「晚于约定的（过去的时刻）」。
 */
export function dueRiskText(input: {
  redKind: RedKind; resetAt: number; items: ReadonlyArray<{ title: string; remaining: number; finishAt: number; dueAt: number }>;
  now: number; timezone: string;
}): string {
  const clock = (at: number) => quotaClockText(at, input.now, input.timezone);
  const first = input.redKind === 'staff_full'
    ? `员工本窗口的额度已用完，${clock(input.resetAt)} 恢复。`
    : `额度已用完，约 ${clock(input.resetAt)} 恢复。`;
  // 每件一句：还没到交付时间的写「晚于约定的」；已经过去的写事实句「已过约定的」（R13）。
  // 边界用「<」：交付时间正好等于现在时算还没过，仍写「晚于约定的」。
  const perJob = input.items.map(item => {
    const head = `${item.title}还差约 ${item.remaining} 回合，按这个时间做完约在 ${clock(item.finishAt)}`;
    return item.dueAt < input.now
      ? `${head}，已过约定的 ${clock(item.dueAt)}。`
      : `${head}，晚于约定的 ${clock(item.dueAt)}。`;
  });
  // 建议时刻：清单里最晚的预计做完时刻取整到下一个整点。
  const suggested = clock(ceilToHour(Math.max(...input.items.map(item => item.finishAt)), input.timezone));
  const last = input.redKind === 'staff_full'
    ? `你可以让我把交付时间改到 ${suggested} 之后；也可以回复「用我的额度」，员工现在用你留出的部分接着做。`
    : `你可以让我把交付时间改到 ${suggested} 之后。`;
  return [first, ...perJob, last].join('\n\n');
}

/**
 * 每个 tick 调用一次。出错由调用方（hooks.safe）兜底；单个总管的消息落不下去时只影响这一位，不标记已提示，下个 tick 再试。
 */
export async function checkDueRisk(ctx: HubContext, now: number): Promise<void> {
  const quota = getQuotaState(ctx, now);
  // 记号按窗口清（P76m，审查 R16）：只清窗口起点比它晚的记号，也就是上一个窗口留下的。
  // 同一个窗口里灯由红转橙、之后再转红时不动这些记号，同一条提示不在总管私聊里重复落一次（推送另有事项键去重）。
  // 方案 7.8 写的也是「窗口滚动后清空」；原来的写法是「灯不是红就清」，会让同一窗口里重复提示。
  for (const row of ctx.store.table('jobNotices').list(notice => notice.dueRiskNotifiedAt !== null && notice.dueRiskNotifiedAt < quota.windowStartAt)) {
    patchNotice(ctx, row.id, { dueRiskNotifiedAt: null });
  }
  const redKind = redKindOf(getQuotaPlan(ctx, now), quota, ctx.settings);
  // 灯不是红：清完过期的记号就结束。
  if (redKind === null) return;

  // 恢复时刻取额度视图的 resetAt；没有额度窗口时算不出，不提示。
  const resetAt = quotaWindowView(ctx, now).resetAt;
  if (resetAt === null) return;

  // 逐件算预计做完的时刻，晚于交付时间的按总管分组。
  const byChief = new Map<string, RiskyJob[]>();
  const jobs = ctx.store.table('jobs').list(job =>
    RUNNING_STATES.includes(job.state) && job.dueAt !== null && !inLaunchPhase(job) && noticeOf(ctx, job.id).dueRiskNotifiedAt === null);
  for (const job of jobs.sort((a, b) => a.assignedAt - b.assignedAt || a.id.localeCompare(b.id))) {
    const remaining = remainingTurns(ctx, job, now);
    const finishAt = resetAt + remaining * BUDGET_DEFAULTS.AVG_TURN_MS;
    if (finishAt <= job.dueAt!) continue;
    const list = byChief.get(job.chiefId) ?? [];
    list.push({ job, title: jobTitleOf(ctx, job), remaining, finishAt });
    byChief.set(job.chiefId, list);
  }

  for (const [chiefId, items] of byChief) {
    try {
      const text = dueRiskText({ redKind, resetAt, now, timezone: ctx.settings.timezone,
        items: items.map(item => ({ title: item.title, remaining: item.remaining, finishAt: item.finishAt, dueAt: item.job.dueAt! })) });
      const ids = items.map(item => item.job.id);
      // R13：清单里每一件都已经过了交付时间时，标题写事实句「已过交付时间」，不再写「可能晚于」。
      // 只要有一件还没到交付时间（只是按现在的速度会晚），就沿用原来的「可能晚于」：那件确实还只是「可能」。
      const allOverdue = items.every(item => item.job.dueAt! < now);
      const title = items.length === 1
        ? (allOverdue ? `${items[0]!.title}：已过交付时间` : `${items[0]!.title}可能晚于交付时间`)
        : (allOverdue ? `${items.length} 件事已过交付时间` : `${items.length} 件事可能晚于交付时间`);
      // 以总管名义落在总管私聊；refId 的写法是「用我的额度」认领的约定（quota/owner-phrases.ts）。
      postThread(ctx, { thread: chiefId, from: chiefId, kind: 'reply', text, refId: `${DUE_RISK_REF_PREFIX}${ids.join(DUE_RISK_REF_SEPARATOR)}` });
      for (const id of ids) patchNotice(ctx, id, { dueRiskNotifiedAt: now });
      // 推送：这一类提示没有对应的「待你处理」条目，不带条目编号；类别按约定一类。
      await notifyOwner(ctx, {
        category: 'agreement',
        title,
        body: text, subjectKey: `duerisk:${quota.windowStartAt}:${ids.join(DUE_RISK_REF_SEPARATOR)}`, botId: chiefId,
      });
    } catch (error) {
      try { ctx.logger.warn('误交付时间的提示失败', { chiefId, error: String(error) }); } catch { /* 日志出错也不能挡住别的总管。 */ }
    }
  }
}

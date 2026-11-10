/** 内驱触发台账：每天最多两次，同一种内驱触发后暂缓，避免一件挂起的事反复叫醒机器人。 */
import type { HubContext } from '../engine/context.js';
import type { DriveState } from '../model/index.js';
import { botBudgetFor } from '../config/defaults.js';
import { buildCandidate, type Candidate } from '../appraisal/think.js';
import { botUsageToday } from '../quota/usage.js';
import { localDateKey } from '../util/time.js';
import { computeDrives, driveFacts } from './compute.js';

/** 只计算在岗机器人；同一轮多个内驱按分数从高到低使用剩余名额。 */
export function evaluateDrives(ctx: HubContext, now: number): Candidate[] {
  const candidates: Candidate[] = [];
  // 本轮只写内驱状态，输入事实在同步调用内不会改变；每张表只复制一次，按机器人筛选复用。
  const allGoals = ctx.store.table('goals').list();
  const allAgenda = ctx.store.table('agenda').list();
  const allInbox = ctx.store.table('inbox').list();
  const allHandoffs = ctx.store.table('handoffs').list();
  const allCommits = ctx.store.table('commits').list();
  for (const bot of ctx.store.table('bots').list(item => item.lifecycle === 'active' || item.lifecycle === 'probation')) {
    const goals = allGoals.filter(item => item.botId === bot.id);
    const agenda = allAgenda.filter(item => item.botId === bot.id);
    const inbox = allInbox.filter(item => item.botId === bot.id);
    const handoffs = allHandoffs.filter(item => item.from === bot.id);
    const commits = allCommits.filter(item => item.botId === bot.id);
    const budget = botBudgetFor(bot.lifecycle, ctx.settings);
    const used = botUsageToday(ctx, bot.id, now).turns;
    const ratio = budget.dailyTurns > 0 ? used / budget.dailyTurns : 1;
    const values = computeDrives(bot, goals, agenda, inbox, handoffs, commits, ratio, now, ctx.settings);
    const previous = ctx.store.table('drives').get(bot.id);
    const day = localDateKey(now, ctx.settings.timezone);
    const state: DriveState = { id: bot.id, botId: bot.id, ...values,
      firedDay: day, firedToday: previous?.firedDay === day ? previous.firedToday : 0,
      snoozedUntil: { ...previous?.snoozedUntil }, updatedAt: now };
    // 有新进展时清零内驱快照；保留每日名额和暂缓时间，不能用交账绕过防打扰限制。
    const progressed = previous && commits.some(item => item.outcome === 'progress' && item.createdAt > previous.updatedAt && item.createdAt <= now);
    if (progressed) {
      state.stagnation = state.obligation = state.waiting = state.frustration = 0;
    } else if (!bot.onDemand) {
      // P55：听吩咐的队友没有内驱，只有上面的状态快照还在更新。
      for (const fact of driveFacts(bot, goals, agenda, inbox, handoffs, commits, now, ctx.settings)) {
        if (state.firedToday >= ctx.settings.driveDailyCap) break;
        if ((state.snoozedUntil[fact.name] ?? 0) > now) continue;
        const candidate = buildCandidate(ctx, { botId: bot.id, kind: 'drive', score: fact.score,
          summary: fact.summary, ownerSummary: fact.ownerSummary, evidence: fact.evidence, driveName: fact.name, goalId: fact.goalId, now });
        if (candidate.reason.score < candidate.reason.threshold) continue;
        candidates.push(candidate);
        state.firedToday += 1;
        state.snoozedUntil[fact.name] = now + Math.min(ctx.settings.driveSnoozeMs, ctx.settings.driveSnoozeMaxMs);
      }
    }
    ctx.store.table('drives').put(state);
  }
  return candidates;
}

/** 内驱的纯计算：只根据明确传入的事实算分，不读时钟、不发消息，也不修改目标。 */
import type { AgendaItem, Bot, Commit, Goal, Handoff, InboxItem, Settings } from '../model/index.js';
import { resolveSettings } from '../config/defaults.js';
import { fingerprint } from '../util/hash.js';
import { formatDuration } from '../util/time.js';

export type DriveName = 'stagnation' | 'obligation' | 'waiting' | 'frustration';
export interface DriveValues {
  stagnation: number; obligation: number; waiting: number; frustration: number; fatigue: number;
}
export interface DriveFact { name: DriveName; score: number; summary: string; ownerSummary: string; evidence: string[]; goalId?: string }

/** 仅取该机器人已经发生的交账，倒序避免调用方存储顺序影响受挫判断。 */
function recentCommits(bot: Bot, commits: Commit[], now: number): Commit[] {
  return commits.filter(item => item.botId === bot.id && item.createdAt <= now)
    .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
}

/** 保留每种内驱最强的一件事；不能靠多个目标重复占用同一天的触发名额。 */
export function driveFacts(
  bot: Bot, goals: Goal[], agenda: AgendaItem[], inbox: InboxItem[], handoffs: Handoff[],
  commits: Commit[], now: number, settings: Settings,
): DriveFact[] {
  const facts: DriveFact[] = [];
  const config = settings.c02;
  for (const goal of goals) {
    if (goal.botId !== bot.id || goal.status !== 'active') continue;
    const elapsed = now - goal.lastProgressAt;
    if (elapsed <= goal.patienceMs) continue;
    facts.push({ name: 'stagnation', goalId: goal.id, evidence: [goal.id],
      score: Math.min(config.stagnationMax, config.stagnationBase + config.stagnationStep * Math.floor((elapsed - goal.patienceMs) / goal.patienceMs)),
      summary: `目标「${goal.title}」停滞 ${formatDuration(elapsed)}，复盘或换方法`,
      ownerSummary: `目标「${goal.title}」停滞 ${formatDuration(elapsed)}` });
  }
  for (const item of agenda) {
    if (item.botId !== bot.id || item.status !== 'open' || !item.toOwner || item.dueAt === null) continue;
    if (item.dueAt - now > config.obligationSoonMs) continue;
    facts.push({ name: 'obligation', score: item.dueAt <= now ? config.obligationOverdueScore : config.obligationSoonScore,
      summary: `对主人的承诺「${item.title}」${item.dueAt <= now ? '已经到期' : '即将到期'}，请及时处理`,
      ownerSummary: `对你的承诺「${item.title}」${item.dueAt <= now ? '已经到期' : '即将到期'}`,
      evidence: [item.id], goalId: item.goalId ?? undefined });
  }
  const recent = recentCommits(bot, commits, now);
  // 等人只认已经按默认值处理的过期问题；尚未处理的 open 问题不能冒充主人的回复。
  for (const item of inbox) {
    if (item.botId !== bot.id || item.type !== 'question' || item.status !== 'expired') continue;
    if (now - item.createdAt < settings.questionExpiryMs || item.defaultOption === null || item.answer !== item.defaultOption) continue;
    if (item.answeredAt === null || item.answeredAt > now || (recent[0] && recent[0].createdAt >= item.answeredAt)) continue;
    facts.push({ name: 'waiting', score: config.waitingQuestionScore, evidence: [item.id],
      summary: `提问「${item.title}」已超时并按默认选项「${item.defaultOption}」处理，按默认继续`,
      ownerSummary: `提问「${item.title}」已超时并按默认选项「${item.defaultOption}」处理` });
  }
  for (const item of handoffs) {
    if (item.from !== bot.id || item.status !== 'offered' || now - item.createdAt < settings.handoffWaitingMs) continue;
    facts.push({ name: 'waiting', score: settings.handoffWaitingDrive, evidence: [item.id],
      summary: `交接「${item.task}」已等待 ${formatDuration(now - item.createdAt)}，催一下或改派`,
      ownerSummary: `交接「${item.task}」已等待 ${formatDuration(now - item.createdAt)}` });
  }
  const blocked = recent.slice(0, config.frustrationCount);
  if (blocked.length === config.frustrationCount && blocked.every(item => item.outcome === 'blocked' && Boolean(item.blocker?.trim()))
    && new Set(blocked.map(item => fingerprint(item.blocker))).size === 1) {
    facts.push({ name: 'frustration', score: config.frustrationScore, evidence: blocked.map(item => item.id),
      summary: `最近 ${config.frustrationCount} 次都因同一原因受阻：${blocked[0]!.blocker}。换方法或求助，不要再重试同一做法`,
      ownerSummary: `最近 ${config.frustrationCount} 次都因同一原因受阻：${blocked[0]!.blocker}` });
  }
  const strongest = new Map<DriveName, DriveFact>();
  for (const fact of facts) {
    if (fact.score > (strongest.get(fact.name)?.score ?? -1)) strongest.set(fact.name, fact);
  }
  return [...strongest.values()].sort((a, b) => b.score - a.score);
}

/** 第九参数可省略以保持八参数契约；引擎显式传设置，使各可配置规则在运行时生效。 */
export function computeDrives(
  bot: Bot, goals: Goal[], agenda: AgendaItem[], inbox: InboxItem[], handoffs: Handoff[],
  commits: Commit[], budgetUsedRatio: number, now: number, settings: Settings = resolveSettings(),
): DriveValues {
  if (!Number.isFinite(budgetUsedRatio)) throw new Error('已用回合预算比例必须是有限数字');
  const values: DriveValues = { stagnation: 0, obligation: 0, waiting: 0, frustration: 0,
    fatigue: Math.min(1, Math.max(0, budgetUsedRatio)) };
  for (const fact of driveFacts(bot, goals, agenda, inbox, handoffs, commits, now, settings)) values[fact.name] = fact.score;
  return values;
}

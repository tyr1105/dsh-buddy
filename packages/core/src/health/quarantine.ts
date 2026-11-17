/** 隔离依据连续故障或失控用量；只改变单个机器人的生命周期，恢复必须由主人明确操作。 */
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import type { HubContext } from '../engine/context.js';
import { parseInput } from '../engine/validation.js';
import { nonempty, timestamp } from '../model/primitives.js';
import type { WakeTicket } from '../model/wake.js';
import { isSelfWork, selfWorkUsageToday } from '../quota/usage.js';
import { raiseAlert } from './alerts.js';
import { newId } from '../util/ids.js';
import { announceParticipantOff, blockJobsOfSuspended, restoreJobs } from '../job/participants.js';
import { suspendedAlertText, wakeChiefsOfSuspended } from '../job/suspended.js';

// P76c：「连续不交账」与「用量超标」两条停用线都只管「员工自己发起的回合」，全项目只有 quota/usage.ts 的 isSelfWork 这一个定义。
// 原来这里自己写了一个 countsForNoCommitLine（排除主人发起的、直聊的、主人消息叫醒的、一件事里的、主题的、技能类的）；
// 与 isSelfWork 相比它多排除主人直聊与主人消息叫醒两种，isSelfWork 已补上这两条，所以直接引用，不再保留第二份。

/** 连续回合错误只数真实回合 error/timeout，投递错误的四次重排规则独立由 scheduler 处理。 */
export function checkQuarantine(ctx: HubContext, botId: string, now: number, endedWake?: WakeTicket): string | null {
  const bot = ctx.store.table('bots').get(botId);
  if (!bot || bot.lifecycle === 'quarantined') return null;
  const wakes = ctx.store.table('wakes').list(item => item.botId === botId && item.endedAt !== null
    && item.endedAt <= now && (bot.releasedAt === undefined || item.startedAt > bot.releasedAt) && item.dispatchedAt !== null)
    // 同毫秒结束时按表插入顺序取最后一轮，避免读到最早的未交账变体。
    .reverse().sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt));
  const recentErrors = wakes.slice(0, ctx.settings.errorQuarantineCount);
  if (bot.consecutiveErrors >= ctx.settings.errorQuarantineCount && recentErrors.length >= ctx.settings.errorQuarantineCount
    && recentErrors.every(item => item.status === 'error' || item.status === 'timeout')) {
    return `连续 ${ctx.settings.errorQuarantineCount} 次回合出错`;
  }
  if (bot.violations >= ctx.settings.violationQuarantineCount) {
    // P74r16c 第 5 节：写法与闸门守卫里一致（这一支拿不到最近一次的理由，所以不带括号里的那一段）。
    return `越界的动作累计 ${bot.violations} 次`;
  }
  // P75r4 第 1 节：连续不交账的停用线只管「员工自己发起的回合」（旧做法的实际范围）。
  // 判断：最近结束的 noCommitReflectionCount + 1 个回合（设置项名字不改，含义是「允许连续不交账几个回合」；默认 3 个），
  // 每一个都是计入范围内的回合、并且状态都是未交账，才停用。中间夹着不在范围内的回合、出错的回合、已交账的回合，都不算连续。
  // 为什么不再看员工档案上的累计数：那个数把一件事里、主题里、主人消息叫醒的回合也数进去了，真实模型偶尔漏交一次账就会被停用。
  const noCommitWindow = ctx.settings.noCommitReflectionCount + 1;
  const recentRounds = wakes.slice(0, noCommitWindow);
  if (recentRounds.length >= noCommitWindow && recentRounds.every(item => item.status === 'no_commit' && isSelfWork(item, bot.role))) {
    return `连续 ${noCommitWindow} 个回合没有交账`;
  }
  // P76c（方案第 7.3 节）：停用线防的是员工自己发起的工作失控，只按回合数，不再按 token。
  // 只数「员工自己发起的回合」：主人交代的事（带 jobId）、总管为主人派出的、技能类、主题、主人发起的都不算（isSelfWork）。
  // 为什么不再按 token：一位执行者做一件中等的事就可能超过 token 那条线，而那是主人交代的事，不是失控。
  // 只数主人上次恢复员工在岗之后的回合（releasedAt）：否则主人刚恢复，员工会因为当天恢复之前的回合立刻又被停用。
  // 原因文字不写「员工」：告警的句子是「中心停用了{名字}：{原因}。」。
  // P76r1：只在「刚结束的这个回合本身是自己发起的」时检查（调用处把刚结束的唤醒单传进来；没传就是非回合结束的调用，不查这一支）。
  // 理由：闸门已经保证正常情况下自己发起的回合不会超过上限，这条线只是闸门失灵时的保险；上限被调低的当天（含升级当天默认值由 6 变 2），
  // 已做满的员工不该在下一个任何回合结束时被误停用。每天上限为 0（员工不自己开工）时这条线不触发。原因文字按设置的倍数生成。
  const budget = ctx.settings.botDailyTurnBudget;
  if (endedWake !== undefined && budget > 0 && isSelfWork(endedWake, bot.role)) {
    const selfTurns = selfWorkUsageToday(ctx, botId, now, bot.releasedAt).turns;
    const multiplier = ctx.settings.usageQuarantineMultiplier;
    if (selfTurns > 0 && selfTurns >= budget * multiplier) return `自己发起的回合达到每天上限的 ${multiplier} 倍`;
  }
  return null;
}

/** 隔离单个机器人并清队告警，保留事件供总管观察且不影响其他机器人。 */
export function quarantine(ctx: HubContext, botId: string, reason: string, now = ctx.clock.now()): void {
  reason = parseInput(nonempty.trim().min(1, '隔离原因不能为空'), reason, '隔离原因');
  now = parseInput(timestamp, now, '隔离时间');
  const bot = ctx.store.table('bots').get(botId);
  if (!bot) throw new Error(`找不到机器人：${botId}`);
  if (bot.lifecycle !== 'quarantined') ctx.store.log('audit').append({ id: newId('au', ctx.rng),
    at: now, actor: 'hub', action: 'quarantine_event', detail: botId });
  // P74b：被系统隔离也是停用，他参与的事转为受阻（有备份；改员工档案失败就把这些事恢复原样）。
  const suspended = blockJobsOfSuspended(ctx, bot);
  try {
    ctx.store.table('bots').patch(botId, { lifecycle: 'quarantined', activity: 'blocked', activityText: `已停用：${reason}`,
      quarantineReason: reason, retryAt: null, updatedAt: now });
  } catch (error) {
    restoreJobs(ctx, suspended.before);
    throw error;
  }
  for (const entry of ctx.store.table('queue').list(item => item.botId === botId)) ctx.store.table('queue').remove(entry.id);
  // P74r16b：告警正文写明停用的原因，以及每件事停在哪一步、已告诉总管（标题在 outreach/alerts.ts 生成）。
  raiseAlert(ctx, { code: 'quarantine', botId, text: suspendedAlertText(ctx, bot, reason, suspended.after), level: 'P1', immediate: true, at: now });
  announceParticipantOff(ctx, bot, suspended.after);
  // P74r16b：对每件这样的事给总管排一条执行链唤醒（带这件事的编号，越过最短思考间隔），总管才会很快知道并换人或向主人说明。
  wakeChiefsOfSuspended(ctx, bot, reason, suspended.after);
  ctx.emit(HUB_EVENT_SCOPES.activity, botId);
  ctx.emit(HUB_EVENT_SCOPES.bot, botId);
}

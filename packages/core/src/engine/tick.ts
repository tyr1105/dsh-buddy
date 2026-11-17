/** 每分钟按十二个阶段对账；每个阶段和机器人各自隔离故障，任何一步失败都继续后续步骤。 */
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import type { HubContext } from './context.js';
import type { Candidate } from '../appraisal/think.js';
import { detectSleep, catchUpCandidates, maybeWriteHeartbeat, findStuckWakes, checkDeadman, stuckKindOf } from '../health/index.js';
import { endChainTurn } from '../job/chain-turn-end.js';
import { syncFileWatches, flushFileEvents, pollDueWatches, checkExpectations } from '../perception/index.js';
import { collectTimeCandidates, expireWatches } from '../agenda/index.js';
import { evaluateDrives } from '../drives/index.js';
import { expireApprovals, executeReadyOutbox } from '../gate/index.js';
import { expireInbox, syncAlertItems } from '../outreach/index.js';
import { expireHandoffs, expireClaims, checkTeamSignals } from '../peer/index.js';
import { checkTurnLimits, finishTurn } from '../turn/index.js';
import { onDispatchOrTurnError, retryCarry } from '../scheduler/retry.js';
import { buildCandidate } from '../appraisal/think.js';
import { refreshBotFiles } from '../memory/files.js';
import { writeOutreachAudit } from '../outreach/audit.js';
import { flushPushQueue } from '../outreach/notify.js';
import { localDateKey } from '../util/time.js';
import { settleFailedTopicDelivery, sweepStuckTopics } from '../project/topics.js';
import { sweepUnpostedAgreements } from '../project/agreement-cards.js';
import { sweepTeamCards } from '../team/cards.js';
import { sweepTeamSetup } from '../team/setup.js';
import { refundJobTurn } from '../job/turns.js';
import { sweepJobs } from '../job/sweep.js';
import { checkDueRisk } from '../job/due-risk.js';
import { sweepJobOutcomes } from '../job/after-accept.js';
import { refundSkillTurn, sweepSkillRuns } from '../skill/run.js';
import { sweepWeeklyTidy } from '../skill/tidy.js';
import { parseSkillKey } from '../skill/keys.js';

// 已清理日期仅作加速；新实例首次仍读取持久化审计，成功后才缓存。
const prunedDays = new WeakMap<HubContext, string>();

export type SafeStep = (label: string, work: () => void | Promise<unknown>, botId?: string) => Promise<void>;
export interface TickHooks { safe: SafeStep; collect(now: number): void; offer(candidate: Candidate): void; pump(): Promise<void> }

/** 第十步：到期自动转正上限 L2，创建时选择 L0/L1 的仍保留原等级。 */
async function promoteDue(ctx: HubContext, now: number, safe: SafeStep): Promise<void> {
  for (const bot of ctx.store.table('bots').list(b => b.lifecycle === 'probation' && b.probationEndsAt !== null && b.probationEndsAt <= now)) {
    await safe('试岗转正', async () => {
      ctx.store.table('bots').patch(bot.id, { lifecycle: 'active', autonomy: bot.autonomy === 'L3' ? 'L2' : bot.autonomy,
        probationEndsAt: null, updatedAt: now });
      writeOutreachAudit(ctx, 'lifecycle', { botId: bot.id, from: 'probation', to: 'active', reason: '试岗到期自动转正' });
      await refreshBotFiles(ctx, bot.id);
      ctx.emit(HUB_EVENT_SCOPES.bot, bot.id);
      ctx.emit(HUB_EVENT_SCOPES.activity, bot.id);
    }, bot.id);
  }
}

/** 回合上限与卡住分别检查；宿主 cancel 失败也写终态，避免永远占住并发。 */
async function checkHealth(ctx: HubContext, now: number, hooks: TickHooks): Promise<void> {
  await checkTurnLimits(ctx, now);
  const stuck = findStuckWakes(ctx, now);
  for (const wake of stuck) {
    await hooks.safe('取消卡住回合', async () => {
      // 孤儿投递没有真实开始，不记回合用量；释放占位并按投递失败重排。
      if (wake.status === 'delivering') {
        const error = '投递超过两分钟仍未收到开始事件';
        ctx.store.table('wakes').patch(wake.id, { status: 'error', endedAt: now, lastEventAt: now, dispatchedAt: null, error });
        // P74c：没有送达就不算一个回合；重试候选投递时再计数。
        refundJobTurn(ctx, wake);
        // P75r5b：技能类回合同样退还（回合数减一、参与者改回排队中），之后由兜底补排。
        refundSkillTurn(ctx, wake);
        const result = onDispatchOrTurnError(ctx, wake.botId, error, now);
        if (result.action === 'retry') {
          const bot = ctx.store.table('bots').get(wake.botId)!;
          if (bot.activity === 'thinking') ctx.store.table('bots').patch(bot.id, { activity: 'watching', activityText: '投递失败，等待重排', updatedAt: now });
          // 主题回合不重试：这一棒已经跳过，讨论继续往下走，隔一会儿再叫它只会插错话。
          // P76r2（R2）：技能类回合（含学习）不排通用重试：refundSkillTurn 已把参与者改回排队中，技能候选还在队列里，由技能记录的兜底负责。
          if (!wake.topicId && parseSkillKey(wake.subjectKey ?? null) === null) hooks.offer(buildCandidate(ctx, { botId: wake.botId, kind: 'retry', score: ctx.settings.c02.deadmanRetryScore,
            evidence: [wake.id], summary: error, ownerSummary: '上次唤醒没有送达，稍后重新尝试', notBefore: result.retryAt!, now,
            // P74c、P76r1：重试沿用原回合的归属（你发起、总管派出、主题、事情编号）。
            ...retryCarry(wake, bot.role) }));
        }
        if (wake.topicId) settleFailedTopicDelivery(ctx, wake.topicId, wake.botId);
        return;
      }
      // P74r13：按实际原因写事实。10 分钟没有任何事件：确实没有响应，照旧安排重试；总时长超过上限：回合一直在干活，不是没有响应。
      // 一件事里的回合总时长超过上限（60 分钟）被结束后不再自动重试：这件事转受阻，由总管处理（job/chain-turn-end.ts）。
      const kind = stuckKindOf(ctx, wake, now);
      if (wake.jobId && kind === 'hard') { await endChainTurn(ctx, wake, now, 'overtime'); return; }
      try { if (wake.sessionId) await ctx.host.cancel(wake.sessionId); }
      finally {
        await finishTurn(ctx, wake.id, now, 'timeout', kind === 'idle' ? '回合没有响应，中心已停止等待并安排重试'
          : `回合超过 ${Math.round(ctx.settings.turnHardTimeoutMs / 60000)} 分钟，中心已结束本回合并安排重试`);
      }
    }, wake.botId);
  }
  for (const candidate of checkDeadman(ctx, now)) hooks.offer(candidate);
}

/** 逐次构造当时的十二阶段，避免把跨 await 发生的新状态藏进启动快照。 */
export async function runTick(ctx: HubContext, hooks: TickHooks): Promise<void> {
  const now = ctx.clock.now();
  const stages: Array<[string, () => void | Promise<unknown>]> = [
    ['睡眠检测', () => { const downtime = detectSleep(ctx, now); if (downtime) for (const c of catchUpCandidates(ctx, downtime, now)) hooks.offer(c); }],
    ['心跳', () => maybeWriteHeartbeat(ctx, now)],
    ['关注项轮询', async () => { await syncFileWatches(ctx); await flushFileEvents(ctx, now); await pollDueWatches(ctx, now); }],
    ['期望检查', () => { checkExpectations(ctx, now); }],
    ['意图时钟', () => { for (const c of collectTimeCandidates(ctx, now)) hooks.offer(c); }],
    ['内驱', () => { for (const c of evaluateDrives(ctx, now)) hooks.offer(c); }],
    ['过期处理', async () => {
      // 不同子模块也独立兜底，审批失败不能挡住关注取消或锁释放。
      await hooks.safe('提问提议过期', () => expireInbox(ctx, now));
      await hooks.safe('审批过期', () => expireApprovals(ctx, now));
      await hooks.safe('交接过期', () => expireHandoffs(ctx, now));
      expireClaims(ctx, now);
      expireWatches(ctx, now);
      await syncFileWatches(ctx);
      await hooks.safe('已批准出站', () => executeReadyOutbox(ctx));
    }],
    ['回合与健康检查', () => checkHealth(ctx, now, hooks)],
    ['试岗转正', () => promoteDue(ctx, now, hooks.safe)],
    ['保留期清理', async () => {
      const day = localDateKey(now, ctx.settings.timezone);
      if (prunedDays.get(ctx) === day) return;
      if (ctx.store.log('audit').recent(1, a => a.action === 'retention_pruned')[0]?.detail === JSON.stringify(day)) { prunedDays.set(ctx, day); return; }
      await ctx.store.prune(now);
      writeOutreachAudit(ctx, 'retention_pruned', day);
      prunedDays.set(ctx, day);
    }],
    ['调度放行', async () => {
      // P75f：旧复盘的四类触发已下线（shouldReflect 删除）；复盘只在验收后按记录触发（P75g）。
      await hooks.safe('总管信号', () => { checkTeamSignals(ctx, now); });
      // P63：等待名单里的人既没排队也没在跑时按「没接上」处理，保证主题讨论不会永远卡住。
      await hooks.safe('主题讨论兜底', () => { sweepStuckTopics(ctx); });
      // P72b：约定卡迟迟没发出（回合没走到交账路由）时补发。
      await hooks.safe('约定补发', () => { sweepUnpostedAgreements(ctx, now); });
      // P73c：组队卡的卡片或「待你处理」条目缺失时补发；三问答完却没生成组队卡的补生成。
      await hooks.safe('组队卡补发', () => { sweepTeamCards(ctx); });
      await hooks.safe('组队卡补生成', () => { sweepTeamSetup(ctx); });
      // P74c：一件事的巡检（回合上限、兜底叫醒）。放在调度之前：到上限的事先停下并清掉候选，兜底排上的唤醒本 tick 就能放行。
      await hooks.safe('一件事巡检', () => { sweepJobs(ctx, now); });
      // P75b：验收后的同类任务记录没写成（出错只记日志）或升级前验收的事，补写一行；序号没变就不扫（见 job/after-accept.ts）。
      await hooks.safe('同类任务记录兜底', () => sweepJobOutcomes(ctx));
      // P75i：每周一 03:00 起，每位在岗员工建一条整理记录（先按规则收起，再对上周技能库有变化的员工排整理唤醒）。
      await hooks.safe('每周整理', () => sweepWeeklyTidy(ctx, now));
      // P75g：复盘记录的兜底（参与者掉队补排、过期补记、结束时落复盘小结）。
      await hooks.safe('复盘兜底', () => sweepSkillRuns(ctx, now));
      hooks.collect(now);
      await hooks.pump();
    }],
  ];
  for (const [label, work] of stages) await hooks.safe(label, work);
  await hooks.safe('告警同步', () => syncAlertItems(ctx));
  // P76h 第二段：额度红灯期间，会误了交付时间的事以总管名义提示一次并推送（见 job/due-risk.ts）。放在通知整理之前，同一个 tick 的推送一起处理。
  await hooks.safe('误交付时间提示', () => checkDueRisk(ctx, now));
  // P76h：最后整理一次通知队列：免打扰顺延的到点补发、10 分钟合并、发送失败的重试。放在告警同步之后，本 tick 新建的告警条目也能一起处理。
  await hooks.safe('通知整理', () => flushPushQueue(ctx, now, { skipIfBusy: true }));
}

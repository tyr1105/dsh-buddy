/** 每分钟按十二个阶段对账；每个阶段和机器人各自隔离故障，任何一步失败都继续后续步骤。 */
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import type { HubContext } from './context.js';
import type { Candidate } from '../appraisal/think.js';
import { detectSleep, catchUpCandidates, maybeWriteHeartbeat, findStuckWakes, checkDeadman } from '../health/index.js';
import { syncFileWatches, flushFileEvents, pollDueWatches, checkExpectations } from '../perception/index.js';
import { collectTimeCandidates, expireWatches } from '../agenda/index.js';
import { evaluateDrives } from '../drives/index.js';
import { expireApprovals, executeReadyOutbox } from '../gate/index.js';
import { expireInbox, maybeSendDigest, syncAlertItems } from '../outreach/index.js';
import { expireHandoffs, expireClaims, checkTeamSignals } from '../peer/index.js';
import { shouldReflect } from '../reflect/trigger.js';
import { checkTurnLimits, finishTurn } from '../turn/index.js';
import { onDispatchOrTurnError } from '../scheduler/retry.js';
import { buildCandidate } from '../appraisal/think.js';
import { refreshBotFiles } from '../memory/files.js';
import { writeOutreachAudit } from '../outreach/audit.js';
import { localDateKey } from '../util/time.js';

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
        const result = onDispatchOrTurnError(ctx, wake.botId, error, now);
        if (result.action === 'retry') {
          const bot = ctx.store.table('bots').get(wake.botId)!;
          if (bot.activity === 'thinking') ctx.store.table('bots').patch(bot.id, { activity: 'watching', activityText: '投递失败，等待重排', updatedAt: now });
          hooks.offer(buildCandidate(ctx, { botId: wake.botId, kind: 'retry', score: ctx.settings.c02.deadmanRetryScore,
            evidence: [wake.id], summary: error, ownerSummary: '上次唤醒没有送达，稍后重新尝试', notBefore: result.retryAt!, now }));
        }
        return;
      }
      try { if (wake.sessionId) await ctx.host.cancel(wake.sessionId); }
      finally { await finishTurn(ctx, wake.id, now, 'timeout', '回合卡住，中心已停止等待并安排重试'); }
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
    ['日报', () => maybeSendDigest(ctx, now)],
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
      for (const bot of ctx.store.table('bots').list()) await hooks.safe('反思检查', () => { shouldReflect(ctx, bot.id, now); }, bot.id);
      await hooks.safe('总管信号', () => { checkTeamSignals(ctx, now); });
      hooks.collect(now);
      await hooks.pump();
    }],
  ];
  for (const [label, work] of stages) await hooks.safe(label, work);
  await hooks.safe('告警同步', () => syncAlertItems(ctx));
}

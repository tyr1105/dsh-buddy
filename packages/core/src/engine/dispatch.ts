/** 调度器只投递已通过闸门的候选；会话创建、轮换、探针及失败重排共享一个出口。 */
import { ownerReasonSummary } from '../util/owner-text.js';
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import type { HubContext } from './context.js';
import type { QueueEntry, WakeTicket } from '../model/index.js';
import { selectNext } from '../scheduler/select.js';
import { enqueue, removeEntry } from '../scheduler/queue.js';
import { buildCandidate } from '../appraisal/think.js';
import { hasApprovalDecision } from '../util/approval-candidate.js';
import { logAppraisal } from '../appraisal/log.js';
import { onDispatchOrTurnError } from '../scheduler/retry.js';
import { createTicket } from '../wake/ticket.js';
import { buildWakePacket } from '../wake/packet.js';
import { needsRotation } from '../memory/rotation.js';
import { beginQuotaWindow, consumeProbe, maybeAllowProbe, onProbeResult } from '../quota/window.js';
import { postThread } from '../outreach/thread.js';
import { writeOutreachAudit } from '../outreach/audit.js';
import { createDeliveryWaits } from './delivery-wait.js';
import { consumeRelatedPercepts } from '../scheduler/percept-consumption.js';
import { openLedgerForWake, sealLedgerForWake } from '../ledger/service.js';

/** pump 由 Hub 串行入口调用；探针身份仅绑定实际投递的唤醒单。 */
export function createDispatcher(ctx: HubContext) {
  const deliveries = createDeliveryWaits(ctx);
  const redNotified = new Map<string, string>();
  /** 红灯下主人消息保留在队列，并且每条消息只给一次明确回复。 */
  function explainQuota(): void {
    for (const id of redNotified.keys()) if (!ctx.store.table('queue').get(id)) redNotified.delete(id);
    if (ctx.store.table('quota').get('quota')?.light !== 'red') return;
    for (const entry of ctx.store.table('queue').list(q => q.ownerInitiated)) {
      const key = `${entry.id}:${entry.reason.evidence.join(',')}`;
      if (redNotified.get(entry.id) === key) continue;
      redNotified.set(entry.id, key);
      postThread(ctx, { thread: entry.botId, from: 'hub', kind: 'system',
        text: '当前额度不足，消息已保留；窗口恢复并通过探针后继续处理。', refId: entry.id });
    }
  }
  /** 在终态记账后处理探针；额度错误已经重设等待窗口时不得强行解锁。 */
  function finishProbe(): void {
    // 身份与许可一起持久化；审计可能已清理或仅剩旧探针，不能拿历史成功冒充本次成功。
    const state = ctx.store.table('quota').get('quota');
    if (state?.light !== 'red' || !state.probeInFlight) return;
    const wake = state.probeWakeId ? ctx.store.table('wakes').get(state.probeWakeId) : null;
    // 老记录无绑定、丢失唤醒单或终态损坏时按失败再等，既不永久锁死也不猜测成功。
    if (!wake || (wake.endedAt === null && !['delivering', 'running', 'committed'].includes(wake.status))) {
      onProbeResult(ctx, false);
      return;
    }
    if (wake.endedAt === null) return;
    // 主人打断不能证明额度恢复或失败；归还下一真实候选的探针许可，不延长红灯窗口。
    if (wake.status === 'canceled' && wake.canceledBy === 'owner') {
      ctx.store.table('quota').patch('quota', { probeInFlight: false, probeWakeId: null, probeAllowed: true });
      ctx.emit(HUB_EVENT_SCOPES.overview, wake.botId);
      return;
    }
    onProbeResult(ctx, wake.status === 'committed' || wake.status === 'no_commit');
  }
  /** 投递前占并发，投递失败不消费感知也不占用个人回合预算。 */
  async function dispatch(entry: QueueEntry): Promise<boolean> {
    const bot = ctx.store.table('bots').get(entry.botId)!;
    // 高分离线变化可成为主理由，但不能抹掉已经合并的补课上下文。
    if (entry.variant === 'regular' && entry.reason.evidence.some(id => ctx.store.table('downtime').get(id))) {
      entry = { ...entry, variant: 'catch_up' };
    }
    // 主人打断留下的事实随下一次真实唤醒带回，不因恢复未消费就立即重启。
    const deferred = ctx.store.table('percepts').list(p => p.botId === bot.id && p.consumedByWake === null
      && p.deferredByOwner === true && p.createdAt <= ctx.clock.now()).map(p => p.id);
    entry = { ...entry, reason: { ...entry.reason, evidence: [...new Set([...entry.reason.evidence, ...deferred])] } };
    // 旧混合队列、主人打断留下的审批都可能在入队隔离之后出现；复盘先留下独立审批候选，再只带自己的证据。
    if (entry.variant === 'reflection' && hasApprovalDecision(ctx, entry)) {
      const approvalEvidence = entry.reason.evidence.filter(id => hasApprovalDecision(ctx, {
        botId: bot.id, reason: { ...entry.reason, kind: 'percept', evidence: [id] },
      }));
      const approvalIds = new Set(approvalEvidence);
      entry = { ...entry, reason: { ...entry.reason, evidence: entry.reason.evidence.filter(id => !approvalIds.has(id)),
        ...(entry.reason.kind === 'approval_decided' ? { kind: 'reflection' as const,
          summary: '继续此前排队的复盘', ownerSummary: '继续此前排队的复盘' } : {}) } };
      ctx.store.table('queue').patch(entry.id, { reason: entry.reason });
      enqueue(ctx, buildCandidate(ctx, { botId: bot.id, kind: 'approval_decided',
        score: ctx.settings.c02.replySalience, summary: '主人审批结果已有更新，当前状态见审批结果节',
        evidence: approvalEvidence, subjectKey: `approval:deferred:${bot.id}`, now: ctx.clock.now() }));
    }
    let wake: WakeTicket = createTicket(ctx, entry, bot.sessionId);
    const delivery = deliveries.open(wake.id);
    // Promise.race 已结算仍可能尚未恢复 await；每个异步阶段后都要重新核对主人取消事实。
    const assertNotInterrupted = () => {
      if (ctx.store.table('wakes').get(wake.id)?.canceledBy === 'owner') throw new Error('主人已打断本次投递');
    };
    let lateCancelStarted = false;
    const cancelLateSession = async (sessionId: string) => {
      if (lateCancelStarted) return;
      lateCancelStarted = true;
      // 保存迟到身份供工具守卫拒绝旧回合，不重新绑定机器人。
      if (ctx.store.table('wakes').get(wake.id)?.canceledBy === 'owner') ctx.store.table('wakes').patch(wake.id, { sessionId });
      await ctx.host.cancel(sessionId);
    };
    let probe = false;
    try {
      const info = bot.sessionId ? await delivery.wait(ctx.host.sessionInfo(bot.sessionId)) : { exists: false, running: false, contextRatio: null };
      assertNotInterrupted();
      if (info.running) {
        // 主人直聊占用会话时保留候选与感知，临时投递占位不能冒充一次真实回合。
        const now = ctx.clock.now();
        ctx.store.table('wakes').remove(wake.id);
        ctx.store.table('queue').patch(entry.id, { notBefore: now + ctx.settings.tickMs });
        logAppraisal(ctx, { botId: bot.id, at: now, perceptIds: entry.reason.evidence, score: entry.reason.score,
          threshold: entry.reason.threshold, decision: 'suppressed', suppressedBy: 'concurrency', until: now + ctx.settings.tickMs,
          text: `${ownerReasonSummary(entry.reason, ctx)}：主人会话正在运行，结束后再投递` });
        return false;
      }
      probe = consumeProbe(ctx, wake.id);
      const rotate = needsRotation(bot, info, ctx.clock.now(), ctx.settings);
      if (rotate) wake = ctx.store.table('wakes').patch(wake.id, { sessionId: null });
      const packet = await delivery.wait(buildWakePacket(ctx, bot, entry, wake));
      assertNotInterrupted();
      const source = { kind: 'agent-hub' as const, botId: bot.id, wakeId: wake.id, variant: wake.variant };
      let sessionId = bot.sessionId;
      if (rotate) {
        const creating = ctx.host.createSession({ botId: bot.id, title: `${bot.name} · Agent 中心`,
          cwd: bot.homeDir, rolePresetId: `agent-hub-${bot.role}`, permissionPresetId: 'agent-hub-unattended',
          model: bot.model, firstMessage: packet, source });
        // 超时后才返回的新会话没有被绑定；尽力停止它，不能污染下一次成功投递的身份。
        void creating.then(async created => {
          if ((delivery.expired() || ctx.store.table('wakes').get(wake.id)?.canceledBy === 'owner') && created.sessionId) await cancelLateSession(created.sessionId);
        }).catch(error => { try { ctx.logger.warn('迟到投递清理未完成', error); } catch { /* 清理失败也不能抛给宿主。 */ } });
        const created = await delivery.wait(creating);
        if (ctx.store.table('wakes').get(wake.id)?.canceledBy === 'owner' && created.sessionId) {
          void cancelLateSession(created.sessionId).catch(error => { ctx.logger.warn('主人打断后的迟到会话清理失败', error); });
        }
        assertNotInterrupted();
        if (!created.sessionId?.trim()) throw new Error('宿主未返回有效的 sessionId');
        sessionId = created.sessionId;
        ctx.store.table('bots').patch(bot.id, { sessionId, sessionStartedAt: ctx.clock.now() });
      } else await delivery.wait(ctx.host.deliver(sessionId!, packet, source));
      assertNotInterrupted();
      const now = ctx.clock.now();
      beginQuotaWindow(ctx, now);
      ctx.store.table('wakes').patch(wake.id, { sessionId, status: 'running', dispatchedAt: now, lastEventAt: now });
      // 投递成功才开账：并发占用等早退路径不建账本行，避免把临时占位记成真实唤醒。
      try { openLedgerForWake(ctx, wake.id, Math.max(0, now - entry.enqueuedAt)); }
      catch (error) { try { ctx.logger.error('唤醒账本开账失败', error); } catch { /* 开账失败不能阻断投递。 */ } }
      ctx.store.table('bots').patch(bot.id, { activity: 'thinking', activityText: `正在处理：${ownerReasonSummary(entry.reason, ctx)}`,
        retryAt: null, updatedAt: now });
      ctx.runtime.lastDispatchAt = now;
      consumeRelatedPercepts(ctx, entry, wake.id, now);
      removeEntry(ctx, entry.id);
      logAppraisal(ctx, { botId: bot.id, at: now, perceptIds: entry.reason.evidence, score: entry.reason.score,
        threshold: entry.reason.threshold, decision: 'woke', suppressedBy: null,
        text: `${ownerReasonSummary(entry.reason, ctx)}，思考分 ${entry.reason.score.toFixed(2)}，门槛 ${entry.reason.threshold.toFixed(2)}，已唤醒` });
      writeOutreachAudit(ctx, 'wake_dispatched', { wakeId: wake.id, botId: bot.id, probe }, 'hub', now);
      ctx.emit(HUB_EVENT_SCOPES.activity, bot.id);
      ctx.emit(HUB_EVENT_SCOPES.bot, bot.id);
      return true;
    } catch (error) {
      // 打断已经同步完成全部业务收尾，不能被投递 Promise 的拒绝覆盖成故障。
      if (ctx.store.table('wakes').get(wake.id)?.canceledBy === 'owner') return false;
      const now = ctx.clock.now();
      const text = error instanceof Error ? error.message : String(error);
      ctx.logger.error(`机器人 ${bot.id} 投递失败`, error);
      ctx.store.table('wakes').patch(wake.id, { status: 'error', error: text, endedAt: now, lastEventAt: now, dispatchedAt: null });
      // 投递失败也要留一条账本：主人需要区分「没有理由」和「有理由但没送出去」。
      try { sealLedgerForWake(ctx, wake.id, { createIfMissing: true }); }
      catch (sealError) { try { ctx.logger.error('投递失败后封存唤醒账本失败', sealError); } catch { /* 账本故障不阻断故障收尾。 */ } }
      if (delivery.expired() && bot.sessionId) {
        // 旧会话的迟到事件不能冒充重试回合；取消不再阻塞中心，重试会创建新会话。
        if (ctx.store.table('bots').get(bot.id)?.sessionId === bot.sessionId) {
          ctx.store.table('bots').patch(bot.id, { sessionId: null, sessionStartedAt: null });
        }
        void Promise.resolve().then(() => ctx.host.cancel(bot.sessionId!)).catch(error => {
          try { ctx.logger.warn('投递超时后的旧会话取消未完成', error); } catch { /* 不阻塞故障收尾。 */ }
        });
      }
      onDispatchOrTurnError(ctx, bot.id, text, now);
      finishProbe();
      ctx.emit(HUB_EVENT_SCOPES.activity, bot.id);
      ctx.emit(HUB_EVENT_SCOPES.bot, bot.id);
      return false;
    } finally { delivery.close(); }
  }
  /** 每次普通放行后停下；主人发起可接着选择，但仍逐次重查并发与额度。 */
  async function pump(): Promise<void> {
    finishProbe();
    maybeAllowProbe(ctx, ctx.clock.now());
    explainQuota();
    let ordinary = 0;
    // 失败机器人有重排闸门；最多遍历当时的机器人数量，防止零间隔配置无限失败。
    const limit = ctx.store.table('bots').count();
    for (let attempt = 0; attempt < limit; attempt += 1) {
      const entry = selectNext(ctx, ctx.clock.now());
      if (!entry || (!entry.ownerInitiated && ordinary >= ctx.settings.dispatchMaxPerPump)) break;
      const delivered = await dispatch(entry);
      if (delivered && !entry.ownerInitiated) {
        ordinary += 1;
        if (ordinary >= ctx.settings.dispatchMaxPerPump) break;
      }
    }
  }
  return { pump, finishProbe, expireDeliveries: deliveries.expire };
}

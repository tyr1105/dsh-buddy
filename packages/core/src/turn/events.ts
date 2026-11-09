/** 回合事件按会话归属推进；重复终态不再记账，单个宿主或文件异常只记本机器人的错误。 */
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import { interruptWake } from './interrupt.js';
import type { HubContext } from '../engine/context.js';
import { parseInput } from '../engine/validation.js';
import { TurnEventSchema, type TurnEvent } from '../model/host.js';
import type { WakeTicket } from '../model/wake.js';
import { newId } from '../util/ids.js';
import { beginQuotaWindow, restBotsForQuota } from '../quota/window.js';
import { recordUsage } from '../quota/usage.js';
import { onDispatchOrTurnError } from '../scheduler/retry.js';
import { buildCandidate } from '../appraisal/think.js';
import { enqueue, removeEntry } from '../scheduler/queue.js';
import { checkQuarantine, quarantine } from '../health/quarantine.js';
import { raiseAlert } from '../health/alerts.js';
import { processCommit, refreshExpectedBy } from '../commit/process.js';
import { verifyProtectedFiles } from '../memory/index.js';
import { postThread } from '../outreach/thread.js';
import { syncAlertItems } from '../outreach/alerts.js';
import { findOpenWake, createOwnerDirectWake } from './session.js';
import { toolActionLabel } from '../util/action-text.js';
import { recordDshToolAction, sealLedgerForWake } from '../ledger/service.js';
/** 清理的只可能是本次放行前的旧候选，回合进行期间主人新发的消息必须保留。 */
export async function finishTurn(ctx: HubContext, wakeId: string, at: number, status: WakeTicket['status'], errorText?: string): Promise<void> {
    const previous = ctx.store.table('wakes').get(wakeId);
    if (!previous || previous.endedAt !== null)
        return;
    const wake = ctx.store.table('wakes').patch(wakeId, { status, endedAt: at, lastEventAt: Math.max(previous.lastEventAt, at), error: errorText ?? previous.error });
    recordUsage(ctx, { botId: wake.botId, wakeId, tokens: wake.tokensKnown ? wake.tokens : null, steps: wake.steps, packetBytes: wake.packetBytes });
    for (const entry of ctx.store.table('queue').list(q => q.botId === wake.botId && q.enqueuedAt <= wake.startedAt
        && q.reason.kind === wake.reason.kind && q.reason.evidence.every(id => wake.reason.evidence.includes(id))))
        removeEntry(ctx, entry.id);
    if (errorText)
        onDispatchOrTurnError(ctx, wake.botId, errorText, at);
    try {
        await verifyProtectedFiles(ctx, wake.botId);
    }
    catch (error) {
        ctx.logger.error('回合结束时保护文件核对失败', error);
        raiseAlert(ctx, { code: 'protected_verify', botId: wake.botId, level: 'P1', immediate: true, text: '保护文件核对失败，请检查家目录', at });
    }
    const isolation = checkQuarantine(ctx, wake.botId, at);
    if (isolation)
        quarantine(ctx, wake.botId, isolation, at);
    const bot = ctx.store.table('bots').get(wake.botId)!;
    if (bot.lifecycle === 'paused' || bot.lifecycle === 'retired') {
        // 收尾不能把主人暂停/退役覆盖成“继续关注”，也不为停止中的机器人排重试。
        ctx.store.table('bots').patch(bot.id, { activity: 'resting',
            activityText: bot.lifecycle === 'paused' ? '已暂停（你暂停的）' : '已退役', updatedAt: at });
    }
    else if (bot.lifecycle !== 'quarantined' && bot.activity !== 'resting') {
        const commit = wake.commitId ? ctx.store.table('commits').get(wake.commitId) : null;
        const waiting = !wake.ownerDirect && (commit?.ownerQuestion || commit?.outcome === 'needs_owner');
        const blocked = !wake.ownerDirect && commit?.outcome === 'blocked';
        ctx.store.table('bots').patch(bot.id, { activity: waiting ? 'waiting_owner' : blocked ? 'blocked' : 'watching',
            activityText: waiting ? '在等主人回复' : blocked ? `受阻：${commit.blocker}` : '继续关注变化',
            lastThinkAt: bot.lastThinkAt === null || !wake.commitId ? at : bot.lastThinkAt, updatedAt: at });
        if (errorText && bot.retryAt !== null)
            enqueue(ctx, buildCandidate(ctx, { botId: bot.id, kind: 'retry',
                score: ctx.settings.c02.deadmanRetryScore, evidence: [wake.id], summary: `上轮出错，按退避重试：${errorText}`,
                ownerSummary: '上轮处理出错，稍后重新尝试', notBefore: bot.retryAt, now: at }));
    }
    // 出错时仍在 thinking 的机器人直到收尾才可休息；收尾只刷新保护状态，不把普通回合结束算作额度新故障。
    const quota = ctx.store.table('quota').get('quota');
    if (quota?.light === 'red' && !quota.probeInFlight) restBotsForQuota(ctx, quota, at);
    refreshExpectedBy(ctx, wake.botId);
    // 回合终态是唯一同时看到「最终状态 + 交账」的位置；只封存已存在的账本行，
    // 不给主人直聊这种没有投递的回合凭空补账本。
    try { sealLedgerForWake(ctx, wake.id); }
    catch (error) { try { ctx.logger.error('封存唤醒账本失败', error); } catch { /* 账本故障不阻断回合收尾。 */ } }
    await syncAlertItems(ctx);
    ctx.emit(HUB_EVENT_SCOPES.activity, wake.botId);
    ctx.emit(HUB_EVENT_SCOPES.bot, wake.botId);
}
/** 合成交账沿用正常退避与视图刷新，但不能把它当成机器人完成了交账协议。 */
async function synthesizeNoCommit(ctx: HubContext, wake: WakeTicket, at: number): Promise<void> {
    const bot = ctx.store.table('bots').get(wake.botId)!;
    ctx.store.table('wakes').patch(wake.id, { syntheticCommit: true });
    const result = await processCommit(ctx, { botId: bot.id, sessionId: wake.sessionId!, wakeId: wake.id }, {
        outcome: 'no_change', summary: '未交账', worldChanges: [], evidence: [], verification: { level: 'none', notCovered: '机器人未提交交账' },
        blocker: null, nextThink: { mode: 'auto', reason: '未交账，等待新事件并保留轻复查' }, ownerQuestion: null,
        reply: wake.reason.kind === 'owner_message' ? '本轮未交账，中心尚未收到有效答复。' : null,
        report: null, importance: ctx.settings.c03.syntheticCommitImportance, proposals: [],
    });
    if (!result.ok)
        throw new Error(result.error);
    ctx.store.table('bots').patch(bot.id, { consecutiveNoCommit: bot.consecutiveNoCommit + 1, updatedAt: at });
}
/** 校验并处理宿主回合事件，将步骤、结束、错误和主人直聊转为可追溯的中心状态。 */
export async function onTurnEvent(ctx: HubContext, raw: TurnEvent): Promise<void> {
    try {
        const e = parseInput(TurnEventSchema, raw, '回合事件');
        const bot = ctx.store.table('bots').list(b => b.sessionId === e.sessionId)[0];
        if (!bot)
            return;
        let wake = findOpenWake(ctx, e.sessionId);
        if (e.type === 'owner_direct') {
            beginQuotaWindow(ctx, e.at);
            ctx.runtime.ownerActiveAt = e.at;
            if (!wake)
                wake = createOwnerDirectWake(ctx, bot.id, e.sessionId, e.text, e.at);
            else
                ctx.store.table('wakes').patch(wake.id, { ownerInitiated: true, ownerDirect: true,
                    variant: 'regular', reason: { kind: 'owner_message', score: ctx.settings.c02.ownerSalience, threshold: 0, summary: e.text.trim() || '主人直接交谈', evidence: wake.reason.evidence } });
            ctx.store.table('bots').patch(bot.id, { activity: 'thinking', activityText: '正在回答主人', updatedAt: e.at });
            postThread(ctx, { thread: bot.id, from: 'owner', kind: 'chat', text: e.text, refId: wake.id });
            ctx.emit(HUB_EVENT_SCOPES.activity, bot.id);
            ctx.emit(HUB_EVENT_SCOPES.bot, bot.id);
            return;
        }
        if (!wake || e.at < wake.startedAt || e.at < wake.lastEventAt)
            return;
        if (e.type === 'interrupted') {
            interruptWake(ctx, wake.id, e.at);
            return;
        }
        if (e.type === 'started') {
            beginQuotaWindow(ctx, e.at);
            ctx.store.table('wakes').patch(wake.id, { status: wake.commitId ? 'committed' : 'running', dispatchedAt: wake.dispatchedAt ?? e.at, lastEventAt: e.at });
            ctx.store.table('bots').patch(bot.id, { activity: wake.variant === 'reflection' ? 'reflecting' : wake.variant === 'catch_up' ? 'catching_up' : 'thinking', updatedAt: e.at });
        }
        else if (e.type === 'step') {
            ctx.store.table('wakes').patch(wake.id, { lastEventAt: e.at, steps: Math.max(wake.steps, e.steps),
                ...(e.tokens === null ? {} : { tokens: Math.max(wake.tokens, e.tokens), tokensKnown: true }) });
        }
        else if (e.type === 'tool_call') {
            // 过程下钻：把 DSH 工具调用写进本条唤醒的账本。记录失败不能影响回合推进。
            ctx.store.table('wakes').patch(wake.id, { lastEventAt: Math.max(wake.lastEventAt, e.at) });
            try {
                recordDshToolAction(ctx, wake.id, {
                    name: e.name, args: e.args, isError: e.isError, resultText: e.resultText, callId: e.callId,
                });
            }
            catch (error) {
                ctx.logger.error('记录 DSH 工具动作失败', error);
            }
        }
        else if (e.type === 'awaiting_approval') {
            ctx.store.table('wakes').patch(wake.id, { lastEventAt: e.at, awaitingApprovalAt: wake.awaitingApprovalAt ?? e.at });
            raiseAlert(ctx, { code: 'host_approval_wait', botId: bot.id, level: 'P1', immediate: true, at: e.at,
                text: `${toolActionLabel(e.tool)}正在等待宿主权限确认。中心将在 5 分钟后取消回合。\n宿主原文（供核对）：${JSON.stringify({ tool: e.tool, summary: e.summary })}` });
            await syncAlertItems(ctx);
        }
        else if (e.type === 'error')
            await finishTurn(ctx, wake.id, e.at, 'error', e.errorText);
        else {
            if (e.tokens !== null)
                ctx.store.table('wakes').patch(wake.id, { tokens: Math.max(wake.tokens, e.tokens), tokensKnown: true });
            // 先核对，避免合成交账刷新视图时覆盖篡改证据。
            try {
                await verifyProtectedFiles(ctx, bot.id);
            }
            catch (error) {
                ctx.logger.error('结束事件的保护文件预检查失败，将继续完成回合记账', error);
            }
            const afterCheck = ctx.store.table('wakes').get(wake.id)!;
            // 文件核对等待期间主人可能已打断；不能再合成未交账或修改该终态。
            if (afterCheck.endedAt !== null) return;
            if (!afterCheck.commitId && !afterCheck.ownerDirect) {
                try {
                    await synthesizeNoCommit(ctx, afterCheck, e.at);
                }
                catch (error) {
                    ctx.logger.error('合成交账失败，仍将结束回合并保留错误', error);
                }
            }
            const latest = ctx.store.table('wakes').get(wake.id)!;
            if (latest.ownerDirect && !latest.commitId && latest.endedAt === null && e.finalText.trim())
                postThread(ctx, { thread: bot.id, from: bot.id, kind: 'reply', text: e.finalText, refId: wake.id });
            await finishTurn(ctx, wake.id, e.at, latest.commitId && !latest.syntheticCommit ? 'committed' : 'no_commit');
            if (wake.ownerDirect)
                ctx.store.log('audit').append({ id: newId('au', ctx.rng), at: e.at, actor: bot.id, action: 'owner_direct_end', detail: wake.id });
        }
        ctx.emit(HUB_EVENT_SCOPES.activity, bot.id);
        ctx.emit(HUB_EVENT_SCOPES.bot, bot.id);
    }
    catch (error) {
        ctx.logger.error('回合事件处理失败，已隔离本次事件', error);
    }
}

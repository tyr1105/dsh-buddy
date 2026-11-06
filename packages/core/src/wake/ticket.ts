/** 唤醒单先占投递位置：成功投递时间由宿主编排补写，避免失败投递被当成真实思考。 */
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import type { HubContext } from '../engine/context.js';
import { parseInput } from '../engine/validation.js';
import { QueueEntrySchema, type QueueEntry, type WakeTicket } from '../model/wake.js';
import { nonempty } from '../model/primitives.js';
import { newId } from '../util/ids.js';
import { hasApprovalDecision } from '../util/approval-candidate.js';
import { buildCandidate } from '../appraisal/think.js';
import { enqueue } from '../scheduler/queue.js';
/** 先保存可追踪的投递中唤醒单，成功投递时间由宿主编排另行确认。 */
export function createTicket(ctx: HubContext, input: QueueEntry, sessionId: string | null): WakeTicket {
    const entry = parseInput(QueueEntrySchema, input, '唤醒候选');
    parseInput(nonempty.nullable(), sessionId, '会话');
    const bot = ctx.store.table('bots').get(entry.botId);
    if (!bot)
        throw new Error('唤醒候选 botId 对应的机器人不存在');
    const now = ctx.clock.now();
    const forceReflection = bot.consecutiveNoCommit >= ctx.settings.noCommitReflectionCount;
    const approval = hasApprovalDecision(ctx, entry);
    // 连续未交账仍须复盘，但不能把审批执行指令塞进只读回合；先留下独立复盘再处理审批。
    if (forceReflection && approval && !ctx.store.table('queue').count(row => row.botId === bot.id && row.variant === 'reflection')) {
        enqueue(ctx, buildCandidate(ctx, { botId: bot.id, kind: 'reflection', variant: 'reflection',
            score: ctx.settings.c02.nextThinkScore, summary: '连续两次未交账，复盘收口方式',
            ownerSummary: '连续两次没交账，做一次复盘', subjectKey: `reflection:no_commit:${bot.lastThinkAt}`,
            evidence: ctx.store.table('wakes').list(w => w.botId === bot.id && w.status === 'no_commit')
                .slice(-ctx.settings.noCommitReflectionCount).map(w => w.id), now }));
    }
    const ticket: WakeTicket = { id: newId('w', ctx.rng), botId: bot.id, sessionId,
        variant: forceReflection && !approval ? 'reflection' : entry.variant,
        reason: entry.reason, subjectKey: entry.subjectKey, ownerInitiated: entry.ownerInitiated,
        dispatchedAt: null, packetBytes: 0, status: 'delivering', startedAt: now, lastEventAt: now,
        endedAt: null, steps: 0, tokens: 0, tokensKnown: false, steeredAt: null, awaitingApprovalAt: null,
        commitId: null, error: null };
    ctx.store.table('wakes').put(ticket);
    ctx.emit(HUB_EVENT_SCOPES.bot, bot.id);
    ctx.emit(HUB_EVENT_SCOPES.activity, bot.id);
    return ticket;
}

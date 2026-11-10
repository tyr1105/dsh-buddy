/**
 * 中心审批按完整内容哈希绑定一次性批准；界面决定和过期都生成明确的结果感知。
 * P65：在项目主题回合里申请的审批记下来源主题，主人批准或拒绝后接着做的那一回合回到原主题。
 */
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import { z } from 'zod';
import type { HubContext } from '../engine/context.js';
import { parseInput } from '../engine/validation.js';
import { ApprovalSchema, type Approval } from '../model/outreach.js';
import { nonempty, timestamp } from '../model/primitives.js';
import { newId } from '../util/ids.js';
import { sha256Hex, stableStringify } from '../util/hash.js';
import { createInboxItem } from '../outreach/inbox.js';
import { postThread } from '../outreach/thread.js';
import { requestPush } from '../outreach/push.js';
import { recordApprovalDecision } from '../perception/sources.js';
import { buildCandidate } from '../appraisal/think.js';
import { enqueue } from '../scheduler/queue.js';
import { describeAction, approvalDisplayText } from '../util/action-text.js';
import { approvalModelSummary, approvalOwnerSummary } from '../util/owner-text.js';
import { noteTopicOfOpenWake, topicIdOfOpenWake } from '../project/topics.js';
import { followUpTopic, startTopicFollowUp } from '../project/topic-followup.js';
/** 为工具名和规范化参数生成稳定哈希，确保批准不能移用于另一组参数。 */
export function approvalContentHash(tool: string, args: unknown): string {
    return sha256Hex(tool + stableStringify(args));
}
/** 长命令同时保留开头和危险尾部，卡片不以只显示前缀掩盖最后的动作。 */
export function approvalPreview(args: unknown, maxBytes: number, edgeChars: number): string {
    const value = stableStringify(args);
    if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
    const chars = Array.from(value);
    return `${chars.slice(0, edgeChars).join('')}\n……中间省略……\n${chars.slice(-edgeChars).join('')}`;
}
/** 对同一待批内容复用审批单，同时建立主人可操作的收件箱和线程记录。 */
export function prepareApproval(ctx: HubContext, botId: string, tool: string, args: unknown, cls: 'C' | 'D', why: string): { approval: Approval; notify: () => Promise<void> } {
    const input = parseInput(z.strictObject({ botId: nonempty, tool: nonempty, cls: z.enum(['C', 'D']), why: nonempty }), { botId, tool, cls, why }, '审批申请');
    if (!ctx.store.table('bots').get(botId))
        throw new Error('审批 botId 对应的机器人不存在');
    const now = ctx.clock.now();
    const contentHash = approvalContentHash(tool, args);
    const existing = ctx.store.table('approvals').list(a => a.botId === botId && a.contentHash === contentHash && a.status === 'pending' && a.expiresAt > now)[0];
    const actionText = describeAction(tool, args, ctx.settings.c03.actionCommandMaxChars);
    if (existing) {
        // 原内容再次申请时拿到了完整参数：原票和截止时间保持，修正旧摘要与卡片，不重新打扰主人。
        if (existing.actionTextVersion === 2) return { approval: existing, notify: async () => undefined };
        const updated = ctx.store.table('approvals').patch(existing.id, { actionText, actionTextVersion: 2,
            argsPreview: approvalPreview(args, ctx.settings.c03.approvalPreviewMaxBytes, ctx.settings.c03.approvalPreviewEdgeChars) });
        const display = approvalDisplayText(updated, ctx.settings.c03.actionCommandMaxChars, ctx.settings.c03.approvalOwnerParamsMaxChars, stableStringify(args));
        for (const card of ctx.store.table('inbox').list(row => row.type === 'approval' && row.refId === updated.id)) {
            ctx.store.table('inbox').patch(card.id, display);
        }
        ctx.emit(HUB_EVENT_SCOPES.inbox, botId);
        ctx.emit(HUB_EVENT_SCOPES.activity, botId);
        ctx.emit(HUB_EVENT_SCOPES.bot, botId);
        return { approval: updated, notify: async () => undefined };
    }
    // P65：记下这张审批是在哪个主题的回合里申请的（和下面那句主题提示同一个口径），
    // 主人批准或拒绝后，接着做的那一回合回到这个主题；不在主题回合里申请的不记。
    const topicId = topicIdOfOpenWake(ctx, botId);
    const row = parseInput(ApprovalSchema, { id: newId('ap', ctx.rng), botId, tool, actionText, actionTextVersion: 2, actionClass: input.cls,
        argsPreview: approvalPreview(args, ctx.settings.c03.approvalPreviewMaxBytes, ctx.settings.c03.approvalPreviewEdgeChars), contentHash, why,
        status: 'pending', createdAt: now, decidedAt: null, expiresAt: now + ctx.settings.approvalExpiryMs, usedAt: null,
        ...(topicId ? { topicId } : {}) }, '审批单');
    // 同步落表先于任何 await，同一事件循环内的重复申请不会产生两张单。
    ctx.store.table('approvals').put(row);
    const { title, body } = approvalDisplayText(row, ctx.settings.c03.actionCommandMaxChars, ctx.settings.c03.approvalOwnerParamsMaxChars, stableStringify(args));
    const inbox = createInboxItem(ctx, { botId, type: 'approval', title, body,
        options: ['批准', '拒绝'], defaultOption: '拒绝', priority: 'P1', refId: row.id, subjectKey: `approval:${row.id}`, expiresAt: row.expiresAt,
        ...(topicId ? { topicId } : {}) });
    postThread(ctx, { thread: botId, from: 'hub', kind: 'approval', text: body, refId: inbox.id });
    // P63：审批的去处不变，只在主题里留一句提示，主人才知道这边在等它批准。
    noteTopicOfOpenWake(ctx, botId, '这一步要你批准，已放进「待你处理」；批准后它会接着做。', inbox.id);
    /** 落表与决定同步完成，通知可由同步宿主钩子交给中心跟踪。 */
    const notify = async (): Promise<void> => { try {
        const result = await requestPush(ctx, { botId, level: 'P1', title: inbox.title, body: inbox.body, subjectKey: inbox.subjectKey });
        if (result === 'sent')
            ctx.store.table('inbox').patch(inbox.id, { pushed: true });
    }
    catch (error) {
        ctx.logger.warn('审批单已保存，单推失败', String(error));
    }
    };
    ctx.emit(HUB_EVENT_SCOPES.activity, botId);
    ctx.emit(HUB_EVENT_SCOPES.bot, botId);
    return { approval: row, notify };
}

/** 既有异步入口仍等待通知结束，与同步钩子共用同一审批落表逻辑。 */
export async function requestApproval(ctx: HubContext, botId: string, tool: string, args: unknown, cls: 'C' | 'D', why: string): Promise<Approval> {
    const prepared = prepareApproval(ctx, botId, tool, args, cls, why);
    await prepared.notify();
    return prepared.approval;
}
/** 先更新状态再生成感知；重复点击不能重新发票或反转已有决定。 */
export async function decideApproval(ctx: HubContext, id: string, approve: boolean, note = ''): Promise<Approval> {
    parseInput(z.strictObject({ id: nonempty, approve: z.boolean(), note: z.string() }), { id, approve, note }, '审批决定');
    const row = ctx.store.table('approvals').get(id);
    if (!row)
        throw new Error('审批单不存在');
    if (row.status !== 'pending')
        throw new Error('审批单已经处理，不能重复决定');
    const now = ctx.clock.now();
    const status = row.expiresAt <= now ? 'expired' : approve ? 'approved' : 'rejected';
    return finishDecision(ctx, row, status, note, now);
}
/** 统一落实批准、拒绝和过期结果，更新收件箱并生成机器人可追溯的结果候选。 */
function finishDecision(ctx: HubContext, row: Approval, status: 'approved' | 'rejected' | 'expired', note: string, now: number): Approval {
    const updated = ctx.store.table('approvals').patch(row.id, { status, decidedAt: now });
    const summary = approvalModelSummary(row, status, note);
    const ownerSummary = approvalOwnerSummary(row, status, note, ctx);
    ctx.store.log('audit').append({ id: newId('au', ctx.rng), at: now, actor: status === 'expired' ? 'hub' : 'owner', action: 'approval_decided', detail: stableStringify({ id: row.id, status, note }) });
    for (const inbox of ctx.store.table('inbox').list(i => i.refId === row.id && i.type === 'approval' && i.status === 'open')) {
        ctx.store.table('inbox').patch(inbox.id, { status: status === 'expired' ? 'expired' : 'answered', answer: status === 'approved' ? '批准' : '拒绝', answeredAt: now });
    }
    const percept = recordApprovalDecision(ctx, { botId: row.botId, id: `${row.id}:${status}`, summary, at: now });
    // P65：在主题里申请、主人亲手批准或拒绝、主题还能接着聊时，接着做的那一回合回到主题，
    // 并和主题里其他回合一样算主人发起；过期是中心处理的，照旧落私聊。
    const topic = status === 'expired' ? null : followUpTopic(ctx, row.botId, row.topicId);
    const candidate = buildCandidate(ctx, { botId: row.botId, kind: 'approval_decided', score: ctx.settings.c02.replySalience, summary, ownerSummary,
        evidence: [row.id, ...(percept ? [percept.id] : [])], subjectKey: `approval:${row.id}`, now,
        ...(topic ? { topicId: topic.id, ownerInitiated: true } : {}) });
    candidate.priority = ctx.settings.c02.priorities.reply;
    // 审批卡在私聊里，私聊照旧记一笔结果；来自主题的，主题里另落一句同样的话（「你批准了：……」）。
    if (topic) startTopicFollowUp(ctx, { topic, candidate, perceptId: percept?.id ?? null, note: ownerSummary, refId: row.id });
    else enqueue(ctx, candidate);
    postThread(ctx, { thread: row.botId, from: 'hub', kind: 'system', text: ownerSummary, refId: row.id });
    ctx.emit(HUB_EVENT_SCOPES.activity, row.botId);
    ctx.emit(HUB_EVENT_SCOPES.inbox, row.botId);
    ctx.emit(HUB_EVENT_SCOPES.bot, row.botId);
    return updated;
}
/** 只消费当前机器人相同参数且未过期的一次性批准票，防止重复执行。 */
export function consumeTicket(ctx: HubContext, botId: string, tool: string, args: unknown, expectedApprovalId?: string): boolean {
    parseInput(z.strictObject({ botId: nonempty, tool: nonempty }), { botId, tool }, '批准票');
    const now = ctx.clock.now();
    const hash = approvalContentHash(tool, args);
    const row = ctx.store.table('approvals').list(a => (!expectedApprovalId || a.id === expectedApprovalId)
        && a.botId === botId && a.tool === tool && a.contentHash === hash && a.status === 'approved' && a.usedAt === null && a.expiresAt > now)[0];
    if (!row)
        return false;
    ctx.store.table('approvals').patch(row.id, { status: 'used', usedAt: now });
    ctx.emit(HUB_EVENT_SCOPES.activity, botId);
    ctx.emit(HUB_EVENT_SCOPES.bot, botId);
    return true;
}
/** 把已到期的待批或已批准票据转为过期，并通知机器人停止原动作。 */
export async function expireApprovals(ctx: HubContext, now: number): Promise<void> {
    parseInput(timestamp, now, '审批过期时间');
    for (const row of ctx.store.table('approvals').list(a => ['pending', 'approved'].includes(a.status) && a.expiresAt <= now)) {
        finishDecision(ctx, row, 'expired', '', now);
    }
}

/** 收件箱只收需要主人决策的事项；回答和默认处理共用同一路径，并落实被接受的结构化提议。 */
import { z } from 'zod';
import { posix } from 'node:path';
import type { HubContext } from '../engine/context.js';
import { parseInput } from '../engine/validation.js';
import { InboxItemSchema, type InboxItem } from '../model/outreach.js';
import { nonempty, timestamp } from '../model/primitives.js';
import { newId } from '../util/ids.js';
import { recordInboxReply } from '../perception/sources.js';
import { buildCandidate } from '../appraisal/think.js';
import { enqueue } from '../scheduler/queue.js';
import { refreshBotFiles } from '../memory/files.js';
import { upsertRule } from '../memory/rules.js';
import { decideApproval } from '../gate/approvals.js';
import { readAuditDetail, writeOutreachAudit } from './audit.js';
import { postThread } from './thread.js';
import { inboxDefaultOption, inboxOptions, proposalAnswer } from './inbox-options.js';
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
const InboxInputSchema = InboxItemSchema.pick({ botId: true, type: true, title: true, body: true, subjectKey: true }).extend({
    options: z.array(nonempty).optional(), defaultOption: nonempty.nullable().optional(), priority: InboxItemSchema.shape.priority.optional(),
    refId: nonempty.nullable().optional(), expiresAt: timestamp.nullable().optional(), status: InboxItemSchema.shape.status.optional(), answer: InboxItemSchema.shape.answer.optional(),
});
export type InboxInput = z.infer<typeof InboxInputSchema>;
const answerLocks = new WeakMap<HubContext, Map<string, Promise<unknown>>>();
/** 同一事项同时出现在收件箱和线程卡片；机器人详情也会展示等待与提议状态，因此一并刷新。 */
function emitInboxChange(ctx: HubContext, item: Pick<InboxItem, 'botId'>): void {
    ctx.emit(HUB_EVENT_SCOPES.inbox, item.botId);
    ctx.emit(HUB_EVENT_SCOPES.thread, item.botId);
    if (item.botId) ctx.emit(HUB_EVENT_SCOPES.bot, item.botId);
}
/** 一张卡片的人工回答和到期默认串行执行，不能同时接受与拒绝。 */
async function withAnswerLock<T>(ctx: HubContext, id: string, operation: () => Promise<T>): Promise<T> {
    let locks = answerLocks.get(ctx);
    if (!locks) {
        locks = new Map();
        answerLocks.set(ctx, locks);
    }
    const next = (locks.get(id) ?? Promise.resolve()).catch(() => undefined).then(operation);
    locks.set(id, next);
    try {
        return await next;
    }
    finally {
        if (locks.get(id) === next)
            locks.delete(id);
    }
}
/** 校验需要主人动手的事项并补足默认期限，使回答和到期处理使用统一状态。 */
export function createInboxItem(ctx: HubContext, input: InboxInput): InboxItem {
    const value = parseInput(InboxInputSchema, input, '收件箱事项');
    if (value.botId && !ctx.store.table('bots').get(value.botId))
        throw new Error('botId：机器人不存在');
    if (value.type === 'question' && (value.options?.length ?? 0) < 2)
        throw new Error('options：提问至少提供两个选项');
    if (value.type === 'question' && ((value.options?.length ?? 0) > 4 || !value.options?.includes(value.defaultOption ?? '')))
        throw new Error('defaultOption：须属于 2 到 4 个选项之一');
    const now = ctx.clock.now();
    const ttl = value.type === 'question' ? ctx.settings.questionExpiryMs : value.type === 'approval' ? ctx.settings.approvalExpiryMs : value.type === 'proposal' ? ctx.settings.proposalExpiryMs : null;
    const row: InboxItem = { ...value, id: newId('i', ctx.rng),
        options: inboxOptions({ type: value.type, options: value.options ?? [] }),
        defaultOption: inboxDefaultOption({ type: value.type, defaultOption: value.defaultOption ?? null }),
        priority: value.priority ?? (value.type === 'proposal' ? 'P2' : 'P1'), refId: value.refId ?? null, status: value.status ?? 'open',
        answer: value.answer ?? null, pushed: false, createdAt: now, expiresAt: value.expiresAt === undefined ? (ttl === null ? null : now + ttl) : value.expiresAt, answeredAt: null };
    ctx.store.table('inbox').put(row);
    emitInboxChange(ctx, row);
    return row;
}
/** 把主人答案转换为感知和唤醒候选，让等待中的机器人知道同一事项已有回复。 */
function replyCandidate(ctx: HubContext, item: InboxItem, answer: string, at: number, ownerInitiated: boolean): void {
    if (!item.botId)
        return;
    const percept = recordInboxReply(ctx, { botId: item.botId, id: item.id, summary: `主人回复「${item.title}」：${answer}`, at });
    if (percept) {
        const candidate = buildCandidate(ctx, { botId: item.botId, kind: 'inbox_reply', score: ctx.settings.c02.replySalience,
            ownerInitiated, summary: ownerInitiated ? '主人已回答收件箱事项' : '收件箱事项已按默认选项处理', evidence: [percept.id, item.id], inboxId: item.id, subjectKey: item.subjectKey, now: at });
        candidate.priority = ctx.settings.c02.priorities.reply;
        enqueue(ctx, candidate);
    }
}
/** proposed 实体不能靠自然语言“同意”生效，只在此主人的明确接受命令中激活。 */
async function acceptProposal(ctx: HubContext, item: InboxItem): Promise<void> {
    if (!item.refId)
        return;
    const now = ctx.clock.now();
    const watch = ctx.store.table('watches').get(item.refId);
    if (watch && (watch.botId !== item.botId || watch.status !== 'proposed'))
        throw new Error('关注项不属于该提议，或已经不在等待接受状态');
    if (watch?.status === 'proposed' && watch.botId === item.botId) {
        const bot = ctx.store.table('bots').get(watch.botId)!;
        if (watch.expiresAt !== null && watch.expiresAt <= now)
            throw new Error('关注项已到期，不能接受旧提议');
        if (['file', 'log'].includes(watch.kind)) {
            if (!posix.isAbsolute(watch.target))
                throw new Error('target：关注路径必须是绝对路径');
            const target = posix.normalize(watch.target);
            if (!bot.workDataAllowed && ctx.settings.workDataPaths.some(path => target === posix.normalize(path) || target.startsWith(`${posix.normalize(path)}/`)))
                throw new Error('target：当前未授权读取工作数据目录');
        }
        if (ctx.store.table('watches').count(row => row.botId === watch.botId && row.status !== 'expired') > ctx.settings.maxWatchesPerBot)
            throw new Error('关注项已达到上限，暂不能接受');
        // 提议等待期间没有检查义务；主人接受后才从此刻开始计算期限。
        ctx.store.table('watches').patch(watch.id, { status: 'active', updatedAt: now,
            expectation: watch.expectation ? { ...watch.expectation,
                effectiveAt: Math.max(now, watch.expectation.effectiveAt ?? watch.createdAt), lastMissedAt: null } : null });
        await refreshBotFiles(ctx, watch.botId);
        return;
    }
    const goal = ctx.store.table('goals').get(item.refId);
    if (goal?.status === 'proposed' && goal.botId === item.botId) {
        const target = ctx.store.log('audit').recent(Number.MAX_SAFE_INTEGER, row => row.action === 'proposal_target')
            .map(row => readAuditDetail<{
            proposalId: string;
            targetId: string;
        }>(row.detail)).find(row => row?.proposalId === goal.id);
        const old = target ? ctx.store.table('goals').get(target.targetId) : null;
        if (target && (!old || old.botId !== goal.botId))
            throw new Error('提议对应的原目标不存在或不属于该机器人');
        ctx.store.table('goals').put({ ...goal, id: old?.id ?? goal.id, status: 'active', createdAt: old?.createdAt ?? goal.createdAt, updatedAt: now });
        if (old)
            ctx.store.table('goals').remove(goal.id);
        await refreshBotFiles(ctx, goal.botId);
        return;
    }
    const rule = ctx.store.table('rules').get(item.refId);
    if (rule?.status === 'proposed' && (rule.scope === item.botId || rule.scope === 'global'))
        await upsertRule(ctx, {
            id: rule.id, scope: rule.scope, text: rule.text, redLine: rule.redLine, source: rule.source, status: 'active',
        });
}
/** 拒绝或撤回只关闭本提议创建的草稿，原 active 目标不受影响，也不永久占关注项配额。 */
export async function retireProposalRecord(ctx: HubContext, item: InboxItem): Promise<void> {
    if (!item.refId)
        return;
    const watch = ctx.store.table('watches').get(item.refId);
    if (watch?.status === 'proposed' && watch.botId === item.botId) {
        ctx.store.table('watches').patch(watch.id, { status: 'expired', updatedAt: ctx.clock.now() });
        await refreshBotFiles(ctx, watch.botId);
    }
    const goal = ctx.store.table('goals').get(item.refId);
    if (goal?.status === 'proposed' && goal.botId === item.botId) {
        ctx.store.table('goals').patch(goal.id, { status: 'abandoned', updatedAt: ctx.clock.now() });
        await refreshBotFiles(ctx, goal.botId);
    }
    const rule = ctx.store.table('rules').get(item.refId);
    if (rule?.status === 'proposed' && (rule.scope === item.botId || rule.scope === 'global'))
        await upsertRule(ctx, {
            id: rule.id, scope: rule.scope, text: rule.text, redLine: rule.redLine, source: rule.source, status: 'archived',
        });
    if (item.botId) ctx.emit(HUB_EVENT_SCOPES.bot, item.botId);
}
/** 使用内部模式保留 expired 状态，同时仍执行默认回答和唤醒，保证过期与人工回答语义一致。 */
async function applyAnswer(ctx: HubContext, item: InboxItem, answer: string, expired: boolean, at = ctx.clock.now()): Promise<InboxItem> {
    if (item.type === 'approval') {
        if (!item.refId)
            throw new Error('审批事项缺少 refId');
        // 旧 answerInbox 调用仍委托唯一的审批决定路径；新界面应直接调用 decideApproval。
        const normalized = answer.trim().toLowerCase();
        if (!['批准', '拒绝', '接受', 'approve', 'reject'].includes(normalized))
            throw new Error('answer：审批合法值为「批准」「拒绝」，请使用 decideApproval');
        const decision = await decideApproval(ctx, item.refId, ['批准', '接受', 'approve'].includes(normalized));
        expired = decision.status === 'expired';
        answer = decision.status === 'approved' ? '批准' : '拒绝';
    }
    else if (item.type === 'alert') {
        if (answer !== '知道了') throw new Error('answer：告警合法值为「知道了」');
        return closeAlertItem(ctx, item.id);
    }
    else {
        if (item.type === 'proposal') {
            const normalized = proposalAnswer(answer);
            if (normalized === null)
                throw new Error('answer：提议合法值为「接受 / 同意 / 好 / accept」或「不做 / 拒绝 / 不要 / reject」');
            answer = normalized;
            const accepted = answer === '接受';
            if (accepted)
                await acceptProposal(ctx, item);
            else {
                await retireProposalRecord(ctx, item);
                writeOutreachAudit(ctx, 'proposal_rejected', { botId: item.botId, title: item.title }, 'owner');
            }
        }
        // 一期完成验收都交给主人；只有明确通过才完成，否定及其他自由文本保守回到进行中。
        if (item.type === 'question' && item.refId) {
            const goal = ctx.store.table('goals').get(item.refId);
            if (goal?.status === 'done_pending_check' && goal.botId === item.botId) {
                ctx.store.table('goals').patch(goal.id, { status: ['通过', '验收通过', '接受'].includes(answer) ? 'done' : 'active', updatedAt: ctx.clock.now() });
                await refreshBotFiles(ctx, goal.botId);
            }
        }
        replyCandidate(ctx, item, answer, at, !expired);
    }
    const result = ctx.store.table('inbox').patch(item.id, { status: expired ? 'expired' : 'answered', answer, answeredAt: at });
    postThread(ctx, { thread: item.botId ?? 'team', from: expired ? 'hub' : 'owner', kind: 'reply', text: expired ? `「${item.title}」已按默认回答处理：${answer}` : `「${item.title}」：${answer}`, refId: item.id });
    writeOutreachAudit(ctx, 'inbox_answer', { id: item.id, answer, expired }, expired ? 'hub' : 'owner');
    emitInboxChange(ctx, item);
    return result;
}
/** 串行处理一张卡片的主人回答，已过期事项按规定默认处理，避免并发接受与拒绝。 */
export async function answerInbox(ctx: HubContext, id: string, answer: string): Promise<InboxItem> {
    id = parseInput(nonempty, id, 'id');
    answer = parseInput(z.string(), answer, 'answer').trim();
    return withAnswerLock(ctx, id, async () => {
        const item = ctx.store.table('inbox').get(id);
        if (!item || item.status !== 'open')
            throw new Error('id：事项不存在或已处理');
        // 自由文本问题只要求非空；其余类型由各自分支给出完整合法值，而不是笼统的空串错误。
        if (item.type === 'question') answer = parseInput(nonempty.min(1, '回答不能为空'), answer, 'answer');
        if (item.expiresAt !== null && item.expiresAt <= ctx.clock.now()) {
            if (item.type === 'question') {
                await applyAnswer(ctx, item, item.defaultOption ?? '暂不处理', true);
                throw new Error('事项已过期，已按默认回答处理');
            }
            if (item.type === 'proposal') {
                await retireProposalRecord(ctx, item);
                ctx.store.table('inbox').patch(item.id, { status: 'withdrawn', answer: '到期撤回', answeredAt: ctx.clock.now() });
                emitInboxChange(ctx, item);
                throw new Error('提议已过期并撤回');
            }
        }
        return applyAnswer(ctx, item, answer, false);
    });
}
/** 检查问题、提议和告警的期限或恢复状态，落实默认回答、撤回和关闭。 */
export async function expireInbox(ctx: HubContext, now: number): Promise<void> {
    now = parseInput(timestamp, now, '过期检查时间');
    for (const item of ctx.store.table('inbox').list(row => row.status === 'open')) {
        if (item.type === 'alert' && item.refId && ctx.store.table('alerts').get(item.refId)?.status === 'closed') {
            closeAlertItem(ctx, item.id, 'hub');
            continue;
        }
        if (item.type === 'question') {
            if (item.expiresAt !== null && item.expiresAt <= now) {
                await withAnswerLock(ctx, item.id, async () => {
                    const current = ctx.store.table('inbox').get(item.id);
                    if (current?.status === 'open')
                        await applyAnswer(ctx, current, current.defaultOption ?? '暂不处理', true, now);
                });
            }
            else if (now - item.createdAt >= ctx.settings.questionReminderMs && !ctx.store.log('audit').all().some(row => row.action === 'question_reminder' && readAuditDetail<{
                id: string;
            }>(row.detail)?.id === item.id)) {
                writeOutreachAudit(ctx, 'question_reminder', { id: item.id, title: item.title, text: '日报提醒' }, 'hub', now);
            }
        }
        else if (item.type === 'proposal' && item.expiresAt !== null && item.expiresAt <= now) {
            await withAnswerLock(ctx, item.id, async () => {
                const current = ctx.store.table('inbox').get(item.id);
                if (current?.status !== 'open')
                    return;
                await retireProposalRecord(ctx, current);
                ctx.store.table('inbox').patch(item.id, { status: 'withdrawn', answer: '到期撤回', answeredAt: now });
                emitInboxChange(ctx, current);
            });
        }
    }
}
/** 同时关闭告警事实与收件箱卡片，并保留是主人还是中心操作的审计记录。 */
export function closeAlertItem(ctx: HubContext, id: string, actor: 'owner' | 'hub' = 'owner'): InboxItem {
    const item = ctx.store.table('inbox').get(parseInput(nonempty, id, 'id'));
    if (!item || item.type !== 'alert')
        throw new Error('id：告警事项不存在');
    if (item.refId && ctx.store.table('alerts').get(item.refId))
        ctx.store.table('alerts').patch(item.refId, { status: 'closed', count: 0 });
    const result = ctx.store.table('inbox').patch(id, { status: 'closed', answer: actor === 'owner' ? '知道了' : '已关闭', answeredAt: ctx.clock.now() });
    writeOutreachAudit(ctx, 'alert_closed', { id }, actor);
    emitInboxChange(ctx, item);
    return result;
}

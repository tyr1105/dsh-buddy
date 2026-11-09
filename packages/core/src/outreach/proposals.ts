/** 所有提议统一经过价值、置信度、周上限和拒绝冷却，未达门槛只进周日点子池。 */
import { z } from 'zod';
import type { HubContext } from '../engine/context.js';
import { parseInput } from '../engine/validation.js';
import { nonempty, ratio } from '../model/primitives.js';
import type { InboxItem } from '../model/outreach.js';
import { localParts, startOfLocalDay } from '../util/time.js';
import { createInboxItem, retireProposalRecord } from './inbox.js';
import { postThread } from './thread.js';
import { readAuditDetail, writeOutreachAudit } from './audit.js';
import { proposalAnswer } from './inbox-options.js';
import { botMbti } from '../personality/profile.js';
import { personalityBehavior } from '../personality/behavior.js';
const ProposalSchema = z.strictObject({ title: nonempty, detail: nonempty, value: ratio, confidence: ratio, refId: nonempty.nullable().optional(), subjectKey: nonempty.optional() });
export type ProposalInput = z.infer<typeof ProposalSchema>;
/** 按价值、置信度、周限额和拒绝冷却决定提议入箱或进点子池，避免重复打扰主人。 */
export async function submitProposal(ctx: HubContext, botId: string, input: ProposalInput): Promise<InboxItem | null> {
    const value = parseInput(ProposalSchema, input, '提议');
    const bot = ctx.store.table('bots').get(botId);
    if (!bot)
        throw new Error('botId：机器人不存在');
    const now = ctx.clock.now();
    const rejected = ctx.store.table('inbox').list(row => row.botId === botId && row.type === 'proposal' && row.title === value.title
        && proposalAnswer(row.answer ?? '') === '不做' && row.answeredAt !== null && row.answeredAt <= now && now - row.answeredAt < ctx.settings.rejectedProposalCooldownMs).length > 0
        || ctx.store.log('audit').since(now - ctx.settings.rejectedProposalCooldownMs, row => row.action === 'proposal_rejected' && row.at <= now && now - row.at < ctx.settings.rejectedProposalCooldownMs)
            .some(row => {
            const detail = readAuditDetail<{
                botId: string;
                title: string;
            }>(row.detail);
            return detail?.botId === botId && detail.title === value.title;
        });
    if (rejected) {
        writeOutreachAudit(ctx, 'proposal_suppressed', { botId, title: value.title, reason: '同标题在拒绝冷却期内' }, botId);
        return null;
    }
    const weekStart = startOfLocalDay(now - ((localParts(now, ctx.settings.timezone).weekday + 6) % 7) * ctx.settings.c03.dayMs, ctx.settings.timezone);
    const proposed = ctx.store.table('inbox').count(row => row.botId === botId && row.type === 'proposal' && row.createdAt >= weekStart && row.createdAt <= now && row.answer !== 'idea_pool');
    const limited = (bot.lifecycle === 'probation' || bot.autonomy === 'L1') && proposed >= ctx.settings.l1WeeklyProposalCap;
    // 性格只能提高提议底线，不能越过周上限、拒绝冷却或后续的权限审批。
    const mbti = botMbti(ctx, botId);
    const behavior = personalityBehavior(mbti, ctx.settings);
    const minValue = behavior?.proposalMinValue ?? ctx.settings.proposalMinValue;
    const minConfidence = behavior?.proposalMinConfidence ?? ctx.settings.proposalMinConfidence;
    const admitted = !limited && value.value >= minValue && value.confidence >= minConfidence;
    const item = createInboxItem(ctx, { botId, type: 'proposal', title: value.title, body: value.detail, options: ['接受', '不做'], defaultOption: null,
        priority: 'P2', refId: value.refId ?? null, subjectKey: value.subjectKey ?? `proposal:${botId}:${value.title}`, status: admitted ? 'open' : 'closed', answer: admitted ? null : 'idea_pool' });
    writeOutreachAudit(ctx, 'proposal_submitted', { id: item.id, value: value.value, confidence: value.confidence,
        admitted, limited, mbti, minValue, minConfidence }, botId);
    if (!admitted)
        await retireProposalRecord(ctx, item);
    if (admitted)
        postThread(ctx, { thread: botId, from: botId, kind: 'proposal', text: `${value.title}\n${value.detail}`, refId: item.id });
    return item;
}

/** 返回真实去向：点子池没有待主人处理的卡片，不能误报成等待审批。 */
export function proposalResultText(ctx: HubContext, item: InboxItem): string {
    if (item.answer !== 'idea_pool') return '作为提议记录，等待主人决定';
    const record = ctx.store.log('audit').recent(Number.MAX_SAFE_INTEGER, row => row.action === 'proposal_submitted')
        .map(row => readAuditDetail<{ id: string; limited: boolean }>(row.detail)).find(row => row?.id === item.id);
    return record?.limited ? '本周提议额度已用完，已记进点子池' : '未达到提议门槛，已记进点子池';
}

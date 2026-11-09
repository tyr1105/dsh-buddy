/** 目标写入工具：必须依附已有志向；建议等级保存独立提议，不提前覆盖已在执行的目标。 */
import { z } from 'zod';
import { GoalSchema } from '../model/bot.js';
import { localDateKey, parseLocalDateTime } from '../util/time.js';
import { newId } from '../util/ids.js';
import { refreshBotFiles } from '../memory/index.js';
import { submitProposal, proposalResultText } from '../outreach/proposals.js';
import { defineTool, requiredText, effectiveAutonomy, auditTool } from './common.js';
export const GoalUpsertInputSchema = z.strictObject({ id: requiredText.optional(), aspirationId: requiredText, title: requiredText, doneWhen: requiredText,
    period: z.enum(['day', 'week', 'month', 'one_off']), importance: z.number().min(0).max(1).optional(), why: requiredText });
/** 周期用本地日历边界，月末不能用固定三十天代替下月第一天。 */
function periodEnd(now: number, period: 'day' | 'week' | 'month' | 'one_off', timezone: string): number | null {
    if (period === 'one_off')
        return null;
    const date = new Date(`${localDateKey(now, timezone)}T00:00:00Z`);
    if (period === 'month') {
        date.setUTCDate(1);
        date.setUTCMonth(date.getUTCMonth() + 1);
    }
    else
        date.setUTCDate(date.getUTCDate() + (period === 'day' ? 1 : 7 - ((date.getUTCDay() + 6) % 7)));
    return parseLocalDateTime(`${date.toISOString().slice(0, 10)} 00:00`, timezone);
}
export const hubGoalUpsert = defineTool('hub_goal_upsert', '在自己的既有志向下新增或修改目标，必须给出 doneWhen 验收标准与 why；L1 提议，L2 起直接生效并记入日报日志。', GoalUpsertInputSchema, 'L1', async (ctx, tc, args) => {
    const bot = ctx.store.table('bots').get(tc.botId)!;
    const aspiration = ctx.store.table('aspirations').get(args.aspirationId);
    if (!aspiration || aspiration.botId !== tc.botId || aspiration.status !== 'active' || !aspiration.approved)
        throw new Error('aspirationId：必须是自己已批准且有效的志向');
    const old = args.id ? ctx.store.table('goals').get(args.id) : null;
    if (args.id && (!old || old.botId !== tc.botId))
        throw new Error('id：目标不存在或不属于你');
    if (old && ['abandoned', 'done', 'done_pending_check'].includes(old.status))
        throw new Error('id：已完成、已放弃或等待主人验收的目标不能修改，请新建目标');
    const now = ctx.clock.now();
    const direct = ['L2', 'L3'].includes(effectiveAutonomy(bot));
    const row = GoalSchema.parse({ id: direct && old ? old.id : newId('g', ctx.rng), botId: tc.botId, aspirationId: args.aspirationId,
        title: args.title, doneWhen: args.doneWhen, period: args.period, periodEndsAt: old?.period === args.period ? old.periodEndsAt : periodEnd(now, args.period, ctx.settings.timezone),
        importance: args.importance ?? old?.importance ?? ctx.settings.goalImportance, patienceMs: ctx.settings.goalPatienceMsByPeriod[args.period],
        status: direct ? 'active' : 'proposed', verification: old?.verification ?? 'owner', lastProgressAt: old?.lastProgressAt ?? now,
        createdBy: old?.createdBy ?? 'bot', createdAt: direct && old ? old.createdAt : now, updatedAt: now });
    ctx.store.table('goals').put(row);
    let proposalText = '';
    if (!direct) {
        const proposal = await submitProposal(ctx, tc.botId, { title: `目标：${args.title}`, detail: `${args.why}\n完成标准：${args.doneWhen}`, value: ctx.settings.proposalMinValue, confidence: ctx.settings.proposalMinConfidence, refId: row.id });
        if (!proposal) {
            ctx.store.table('goals').remove(row.id);
            return { ok: true, text: '同标题提议仍在拒绝冷却期，本次没有重复提交' };
        }
        proposalText = proposalResultText(ctx, proposal);
        if (old)
            auditTool(ctx, tc.botId, 'proposal_target', JSON.stringify({ proposalId: row.id, targetId: old.id }));
    }
    auditTool(ctx, tc.botId, 'hub_goal_upsert', `${row.id} ${row.status} ${args.title}`);
    await refreshBotFiles(ctx, tc.botId);
    return { ok: true, text: `目标 ${row.id} 已${direct ? '生效，日报会记录本次变化' : proposalText}` };
});

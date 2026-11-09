/** 教训工具：执行等级可维护自己的规矩，影响全体或建议等级时仍需主人决定。 */
import { z } from 'zod';
import type { HubContext } from '../engine/context.js';
import { parseInput } from '../engine/validation.js';
import { upsertRule } from '../memory/index.js';
import { submitProposal, proposalResultText } from '../outreach/proposals.js';
import { defineTool, requiredText, effectiveAutonomy, auditTool } from './common.js';
export const LessonProposeInputSchema = z.strictObject({ text: requiredText, scope: z.enum(['self', 'global']), why: requiredText });
/** 按作用范围和自主等级保存教训为有效规矩或待批提议，避免自动扩大规矩影响。 */
export async function proposeLesson(ctx: HubContext, botId: string, input: z.infer<typeof LessonProposeInputSchema>): Promise<string> {
    const args = parseInput(LessonProposeInputSchema, input, '教训');
    const bot = ctx.store.table('bots').get(botId);
    if (!bot)
        throw new Error('机器人不存在');
    const direct = args.scope === 'self' && ['L2', 'L3'].includes(effectiveAutonomy(bot));
    const rule = await upsertRule(ctx, { scope: args.scope === 'global' ? 'global' : botId, text: args.text, redLine: false, source: 'lesson', status: direct ? 'active' : 'proposed' });
    let proposalText = '';
    if (!direct) {
        const proposal = await submitProposal(ctx, botId, { title: `教训：${args.text}`, detail: args.why, value: ctx.settings.proposalMinValue, confidence: ctx.settings.proposalMinConfidence, refId: rule.id });
        if (!proposal) {
            ctx.store.table('rules').remove(rule.id);
            return '同标题提议仍在拒绝冷却期，本次没有重复提交';
        }
        proposalText = proposalResultText(ctx, proposal);
    }
    auditTool(ctx, botId, 'hub_lesson_propose', `${rule.id} ${rule.status}`);
    return `教训 ${rule.id} 已${direct ? '写入自己的规矩' : proposalText}`;
}
export const hubLessonPropose = defineTool('hub_lesson_propose', '记录一次教训及 why；scope=self 且 L2 起直接成为自己的规矩，global 始终提议。所有等级可用。', LessonProposeInputSchema, 'all', async (ctx, tc, args) => ({ ok: true, text: await proposeLesson(ctx, tc.botId, args) }));

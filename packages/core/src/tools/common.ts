/** 工具共用入口：先验证参数与身份，再检查等级；即使直接调用 handler 也不会绕过权限。 */
import { z } from 'zod';
import type { HubContext } from '../engine/context.js';
import { parseInput } from '../engine/validation.js';
import { ToolContextSchema } from './types.js';
import type { ToolContext, ToolResult, HubTool } from './types.js';
import type { Bot } from '../model/bot.js';
import { newId } from '../util/ids.js';
import { toolJsonSchema } from './json-schema.js';
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
export const requiredText = z.string({ error: '必须是文字' }).trim().min(1, '不能为空或只有空白');
/** 用可信工具上下文核对机器人、会话和唤醒单归属，防止参数冒充其他身份。 */
export function getToolBot(ctx: HubContext, input: ToolContext): Bot {
    const toolCtx = parseInput(ToolContextSchema, input, '工具身份');
    const bot = ctx.store.table('bots').get(toolCtx.botId);
    if (!bot)
        throw new Error('botId：机器人不存在');
    if (bot.sessionId !== toolCtx.sessionId)
        throw new Error('sessionId：不属于这个机器人');
    if (toolCtx.wakeId) {
        const wake = ctx.store.table('wakes').get(toolCtx.wakeId);
        if (!wake || wake.botId !== bot.id || wake.sessionId !== toolCtx.sessionId)
            throw new Error('wakeId：不属于本机器人当前会话');
    }
    return bot;
}
/** 试岗统一按 L1 计算实际权限，其他生命周期保留主人授予的等级。 */
export function effectiveAutonomy(bot: Bot) {
    return bot.lifecycle === 'probation' ? 'L1' : bot.autonomy;
}
/** 拒绝只观察等级调用需要建议或执行能力的工具，集中维护最低权限边界。 */
export function requireL1(bot: Bot): void {
    if (effectiveAutonomy(bot) === 'L0')
        throw new Error('当前自主等级 L0 只观察，不能调用这个工具');
}
/** 记录工具动作及说明，供主人核对自我变更和后续恢复。 */
export function auditTool(ctx: HubContext, botId: string, action: string, detail: string): void {
    ctx.store.log('audit').append({ id: newId('au', ctx.rng), at: ctx.clock.now(), actor: botId, action, detail });
    // 可写工具均在修改业务记录后审计，让议程、目标和关注变化立即刷新对应机器人。
    ctx.emit(HUB_EVENT_SCOPES.bot, botId);
}
/** 异常一律变成可读结果；统一入口和单个工具对象都遵守同一约束。 */
export function defineTool<T>(name: string, description: string, schema: z.ZodType<T>, minimum: 'all' | 'L1', run: (ctx: HubContext, toolCtx: ToolContext, args: T) => Promise<ToolResult> | ToolResult): HubTool {
    return {
        name,
        description,
        schema,
        jsonSchema: toolJsonSchema(schema),
        /** 统一校验参数、身份、生命周期和回合边界，再执行工具并把异常转为中文失败结果。 */
        async handler(ctx, toolCtx, rawArgs) {
            try {
                const args = parseInput(schema, rawArgs, name);
                const bot = getToolBot(ctx, toolCtx);

                if (minimum === 'L1')
                    requireL1(bot);
                const wake = toolCtx.wakeId ? ctx.store.table('wakes').get(toolCtx.wakeId)
                    : ctx.store.table('wakes').list(w => w.botId === bot.id && w.sessionId === toolCtx.sessionId
                        && (['running', 'delivering'].includes(w.status) || (w.status === 'committed' && w.endedAt === null)))
                        .sort((a, b) => b.startedAt - a.startedAt)[0];
                const closing = ['paused', 'retired'].includes(bot.lifecycle) && wake?.endedAt === null
                    && ['running', 'delivering', 'committed'].includes(wake.status) && ['hub_commit', 'hub_reflect_commit'].includes(name);
                if (!['active', 'probation'].includes(bot.lifecycle) && name !== 'hub_state_get' && !closing)
                    throw new Error('机器人当前不在岗，不能修改事项');
                if (wake && name !== 'hub_state_get' && !['hub_commit', 'hub_reflect_commit'].includes(name) && (wake.commitId || !['running', 'delivering'].includes(wake.status)))
                    throw new Error('本轮已结束，不能在交账后继续修改事项');
                const reflectionWrites = ['hub_agenda_upsert', 'hub_agenda_close', 'hub_watch_update', 'hub_watch_propose', 'hub_goal_upsert', 'hub_send', 'hub_handoff', 'hub_claim', 'hub_release'];
                if (wake?.variant === 'reflection' && reflectionWrites.includes(name))
                    throw new Error('反思回合只读；关注调整请写进 hub_reflect_commit，其他事项留到下一回合');
                return await run(ctx, toolCtx, args);
            }
            catch (error) {
                return { ok: false, error: error instanceof Error ? error.message : '工具执行失败，请稍后重试' };
            }
        },
    };
}

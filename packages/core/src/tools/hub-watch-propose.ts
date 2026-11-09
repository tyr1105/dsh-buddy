/** 新增关注项按等级决定直接生效或提议；关注范围与最短间隔在写入前检查。 */
import { z } from 'zod';
import { posix as path } from 'node:path';
import type { HubContext } from '../engine/context.js';
import { parseInput } from '../engine/validation.js';
import { ExpectationWeekdaysSchema, WatchSchema, validateExpectationInterval } from '../model/perception.js';
import { newId } from '../util/ids.js';
import { refreshBotFiles } from '../memory/index.js';
import { submitProposal, proposalResultText } from '../outreach/proposals.js';
import { validateWatchFilter } from '../perception/filter.js';
import { assertWatchPathAccess, WatchAccessDeniedError } from '../perception/access.js';
import { recordViolation } from '../gate/guard.js';
import { defineTool, requiredText, effectiveAutonomy, requireL1, auditTool } from './common.js';
export const WatchProposeInputSchema = z.strictObject({ kind: z.enum(['file', 'log', 'http', 'rss', 'script', 'session']), target: requiredText,
    filter: z.string().nullable().optional(), intervalMinutes: z.number().positive('必须大于 0').optional(),
    expectation: z.strictObject({ text: requiredText, everyMs: z.number().positive().nullable().optional(),
        byLocalTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, '必须是 HH:mm').nullable().optional(),
        weekdays: ExpectationWeekdaysSchema.optional() }).superRefine(validateExpectationInterval).nullable().optional(), why: requiredText });
/** 按完整目录段检查文件归属，避免名称前缀相似的外部目录混入授权范围。 */
const inside = (file: string, base: string) => file === base || file.startsWith(`${base}/`);
/** 预检新增关注的配额、间隔、目标和工作数据边界，判断能否直接生效。 */
export function validateWatchProposal(ctx: HubContext, botId: string, input: z.infer<typeof WatchProposeInputSchema>) {
    const args = parseInput(WatchProposeInputSchema, input, '新增关注项');
    const bot = ctx.store.table('bots').get(botId);
    if (!bot)
        throw new Error('机器人不存在');
    requireL1(bot);
    if (ctx.store.table('watches').count(w => w.botId === botId && ['active', 'paused', 'proposed'].includes(w.status)) >= ctx.settings.maxWatchesPerBot)
        throw new Error('关注项数量已达上限');
    let intervalMs: number | null = null;
    if (['http', 'rss', 'script'].includes(args.kind)) {
        const minimum = args.kind === 'script' ? ctx.settings.scriptMinIntervalMs : ctx.settings.httpMinIntervalMs;
        intervalMs = args.intervalMinutes === undefined ? minimum : args.intervalMinutes * 60000;
        if (intervalMs < minimum)
            throw new Error('intervalMinutes：低于此来源最短轮询间隔');
    }
    else if (args.intervalMinutes !== undefined)
        throw new Error('intervalMinutes：此来源由事件驱动，不能设轮询间隔');
    if (['http', 'rss'].includes(args.kind)) {
        try {
            const url = new URL(args.target);
            if (!['http:', 'https:'].includes(url.protocol))
                throw new Error();
        }
        catch {
            throw new Error('target：必须是有效 http 或 https 地址');
        }
    }
    if (['file', 'log'].includes(args.kind) && !path.isAbsolute(args.target))
        throw new Error('target：文件关注必须使用绝对路径');
    if (['file', 'log'].includes(args.kind)) assertWatchPathAccess(ctx, botId, args.target);
    if (args.expectation && !args.expectation.everyMs && !args.expectation.byLocalTime)
        throw new Error('expectation：必须提供 everyMs 或 byLocalTime');
    validateWatchFilter(args.filter, ctx.settings);
    const level = effectiveAutonomy(bot);
    const local = ['file', 'log'].includes(args.kind) && (inside(path.normalize(args.target), path.normalize(bot.homeDir)) || inside(path.normalize(args.target), path.join(ctx.settings.rootDir, 'shared')));
    const workBoundary = ['file', 'log'].includes(args.kind) && !bot.workDataAllowed && ctx.settings.workDataPaths.some(base => inside(path.normalize(args.target), path.normalize(base)));
    if (workBoundary)
        throw new Error('target：尚未授权读取工作数据目录');
    const direct = ['L2', 'L3'].includes(level) && (local || ['http', 'rss'].includes(args.kind));
    return { args, bot, intervalMs, direct };
}
/** 保存通过校验的关注项，按权限生效或提交提议，并刷新机器人注意力视图。 */
export async function proposeWatch(ctx: HubContext, botId: string, input: z.infer<typeof WatchProposeInputSchema>): Promise<string> {
    const { args, intervalMs, direct } = validateWatchProposal(ctx, botId, input);
    const now = ctx.clock.now();
    const row = WatchSchema.parse({ id: newId('wt', ctx.rng), botId, kind: args.kind, target: args.target, filter: args.filter ?? null, intervalMs,
        expectation: args.expectation ? { text: args.expectation.text, everyMs: args.expectation.everyMs ?? null, byLocalTime: args.expectation.byLocalTime ?? null,
            weekdays: args.expectation.weekdays ?? null, effectiveAt: now, lastSatisfiedAt: null, lastMissedAt: null } : null,
        relevance: ctx.settings.watchRelevanceByCreator.bot, createdBy: 'bot', status: direct ? 'active' : 'proposed', expiresAt: now + ctx.settings.botWatchExpiryMs,
        lastCheckedAt: null, lastFingerprint: null, lastValue: null, why: args.why, createdAt: now, updatedAt: now });
    ctx.store.table('watches').put(row);
    let proposalText = '';
    if (!direct) {
        const proposal = await submitProposal(ctx, botId, { title: `新增关注：${args.target}`, detail: args.why, value: ctx.settings.proposalMinValue, confidence: ctx.settings.proposalMinConfidence, refId: row.id });
        if (!proposal) {
            ctx.store.table('watches').remove(row.id);
            return '同标题提议仍在拒绝冷却期，本次没有重复提交';
        }
        proposalText = proposalResultText(ctx, proposal);
    }
    auditTool(ctx, botId, 'hub_watch_propose', `${row.id} ${row.status}`);
    await refreshBotFiles(ctx, botId);
    return direct ? `关注项 ${row.id} 已生效` : `关注项 ${row.id}：${proposalText}`;
}
export const hubWatchPropose = defineTool('hub_watch_propose', '提出新关注并说明 why；L2 起的本家/shared 文件、http/rss 可直接生效，其他范围或 L1 需主人接受。最多 20 条，轮询不得过快。weekdays 不为空时 everyMs 必须小于 24 小时；每个检查日一份请用 byLocalTime（例如每天 08:20 前）。', WatchProposeInputSchema, 'L1', async (ctx, tc, args) => {
    try { return { ok: true, text: await proposeWatch(ctx, tc.botId, args) }; }
    catch (error) {
        // 只有经过身份验证的机器人主动工具调用计数；主人配置和恢复旧关注不经过这里。
        if (error instanceof WatchAccessDeniedError && error.actionClass === 'protected') await recordViolation(ctx, tc.botId, error.message);
        throw error;
    }
});

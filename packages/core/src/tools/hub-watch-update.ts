/** 关注项只能收窄或调慢：无法证明更窄的正则替换会被拒绝，避免建议等级悄悄扩大注意范围。 */
import { z } from 'zod';
import { posix as path } from 'node:path';
import type { HubContext } from '../engine/context.js';
import { parseInput } from '../engine/validation.js';
import { refreshBotFiles } from '../memory/index.js';
import { validateWatchFilter } from '../perception/filter.js';
import { assertWatchPathAccess, WatchAccessDeniedError } from '../perception/access.js';
import { recordViolation } from '../gate/guard.js';
import { defineTool, requiredText, auditTool, requireL1 } from './common.js';
export const WatchUpdateInputSchema = z.strictObject({ id: requiredText, intervalMinutes: z.number().positive('必须大于 0').optional(),
    filter: z.string().nullable().optional(), status: z.enum(['active', 'paused']).optional() });
/** 验证关注更新只收窄范围或放慢轮询，防止低等级工具悄悄扩大观察权限。 */
export function validateWatchUpdate(ctx: HubContext, botId: string, input: z.infer<typeof WatchUpdateInputSchema>) {
    const args = parseInput(WatchUpdateInputSchema, input, '更新关注项');
    const bot = ctx.store.table('bots').get(botId);
    if (!bot)
        throw new Error('机器人不存在');
    requireL1(bot);
    const old = ctx.store.table('watches').get(args.id);
    if (!old || old.botId !== botId)
        throw new Error('id：关注项不存在或不属于你');
    if (['proposed', 'expired'].includes(old.status))
        throw new Error('status：提议中或已到期关注项不能直接启用');
    if ((args.status ?? old.status) === 'active' && ['file', 'log'].includes(old.kind)) assertWatchPathAccess(ctx, botId, old.target);
    const target = path.normalize(old.target);
    if ((args.status ?? old.status) === 'active' && ['file', 'log'].includes(old.kind) && !bot.workDataAllowed
        && ctx.settings.workDataPaths.some(base => target === path.normalize(base) || target.startsWith(`${path.normalize(base)}/`)))
        throw new Error('target：尚未授权读取工作数据目录');
    let intervalMs = old.intervalMs;
    if (args.intervalMinutes !== undefined) {
        if (!['http', 'rss', 'script'].includes(old.kind))
            throw new Error('intervalMinutes：文件和会话关注是事件驱动，不能设间隔');
        intervalMs = args.intervalMinutes * 60000;
        const minimum = old.kind === 'script' ? ctx.settings.scriptMinIntervalMs : ctx.settings.httpMinIntervalMs;
        if (intervalMs < minimum || (old.intervalMs !== null && intervalMs < old.intervalMs))
            throw new Error('intervalMinutes：只能调慢，且不能低于该来源最短间隔');
    }
    const filter = args.filter === undefined ? old.filter : args.filter?.trim() || null;
    if (old.filter && filter !== old.filter && (!filter || old.filter.startsWith('/') || filter.startsWith('/') || !filter.includes(old.filter)))
        throw new Error('filter：只能收窄现有关键词，不能删除条件或改成无法证明更窄的正则');
    validateWatchFilter(filter, ctx.settings);
    return { old, args, intervalMs, filter };
}
/** 落实已验证的关注变更，保留前后对照审计并刷新只读视图。 */
export async function updateWatch(ctx: HubContext, botId: string, input: z.infer<typeof WatchUpdateInputSchema>): Promise<string> {
    const { old, args, intervalMs, filter } = validateWatchUpdate(ctx, botId, input);
    const now = ctx.clock.now();
    // 暂停期间没有检查义务，恢复时不能立即追讨之前的缺口。
    const expectation = old.expectation && old.status !== 'active' && args.status === 'active'
        ? { ...old.expectation, effectiveAt: Math.max(now, old.expectation.effectiveAt ?? old.createdAt), lastMissedAt: null }
        : old.expectation;
    ctx.store.table('watches').patch(old.id, { intervalMs, filter, status: args.status ?? old.status, expectation, updatedAt: now });
    auditTool(ctx, botId, 'hub_watch_update', JSON.stringify({ id: old.id, from: { intervalMs: old.intervalMs, filter: old.filter, status: old.status }, to: { intervalMs, filter, status: args.status ?? old.status } }));
    await refreshBotFiles(ctx, botId);
    return `已更新关注项 ${old.id}，变化已记入日志`;
}
export const hubWatchUpdate = defineTool('hub_watch_update', '收窄关键词、调慢轮询或暂停自己的已有关注项；不能调快、越过下限或扩宽原过滤条件。L1 起可用。', WatchUpdateInputSchema, 'L1', async (ctx, tc, args) => {
    try { return { ok: true, text: await updateWatch(ctx, tc.botId, args) }; }
    catch (error) {
        // 自主工具重新启用敏感关注属于主动越界，旧记录被中心暂停本身不计数。
        if (error instanceof WatchAccessDeniedError && error.actionClass === 'protected') await recordViolation(ctx, tc.botId, error.message);
        throw error;
    }
});

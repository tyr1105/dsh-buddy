/** 状态工具用中文概览呈现事实和今日预算，避免模型为一个问题读取整份持久化 JSON。 */
import { z } from 'zod';
import { botBudgetFor, dailyThinkCapFor } from '../config/defaults.js';
import { botUsageToday } from '../quota/usage.js';
import { teamSummary } from '../peer/team.js';
import { formatShort } from '../util/time.js';
import { truncateBytes } from '../util/text.js';
import { defineTool } from './common.js';
export const StateGetInputSchema = z.strictObject({ scope: z.enum(['self', 'team']).optional() });
export const hubStateGet = defineTool('hub_state_get', '了解自己的志向、目标、议程、关注、等待事项和今日余量；scope=team 只有总管可看全队。返回不超过 3KB 的中文摘要。', StateGetInputSchema, 'all', (ctx, tc, args) => {
    const bot = ctx.store.table('bots').get(tc.botId)!;
    if (args.scope === 'team') {
        if (bot.role !== 'chief')
            throw new Error('scope：只有总管可以查询 team');
        return { ok: true, text: truncateBytes(`团队现在\n${teamSummary(ctx)}`, ctx.settings.c03.stateMaxBytes) };
    }
    const now = ctx.clock.now();
    const usage = botUsageToday(ctx, bot.id, now);
    const budget = botBudgetFor(bot.lifecycle, ctx.settings);
    /** 把已有事实拼成简短列表，空列表明确显示无，避免把缺内容误当成功。 */
    const describe = (items: string[]) => items.length ? items.join('；') : '无';
    const summary = [`现在：${formatShort(now, now, ctx.settings.timezone)}（北京时间）`, `我：${bot.name}；${bot.activityText}`,
        `志向：${describe(ctx.store.table('aspirations').list(a => a.botId === bot.id && a.status === 'active').map(a => `[${a.id}] ${a.text}`))}`,
        `目标：${describe(ctx.store.table('goals').list(g => g.botId === bot.id && ['active', 'blocked', 'proposed'].includes(g.status)).map(g => `[${g.id}] ${g.title}；完成标准：${g.doneWhen}`))}`,
        `议程：${describe(ctx.store.table('agenda').list(a => a.botId === bot.id && a.status === 'open').sort((a, b) => a.priority - b.priority).map(a => `[${a.id}] ${a.title}${a.dueAt === null ? '' : `，${formatShort(a.dueAt, now, ctx.settings.timezone)}`}`))}`,
        `关注：${describe(ctx.store.table('watches').list(w => w.botId === bot.id && w.status !== 'expired').map(w => `[${w.id}] ${w.target}（${w.status === 'active' ? '生效' : w.status === 'paused' ? '暂停' : '提议'}）`))}`,
        `在等：${describe(ctx.store.table('inbox').list(i => i.botId === bot.id && i.status === 'open').map(i => i.title).concat(ctx.store.table('handoffs').list(h => h.from === bot.id && h.status === 'offered').map(h => `同伴接收 ${h.task}`)))}`,
        `今日余量：${Math.max(0, Math.min(budget.dailyTurns, dailyThinkCapFor(bot.autonomy, bot.lifecycle, ctx.settings)) - usage.turns)} 回合，${Math.max(0, budget.dailyTokens - usage.tokens)} token`];
    // 每节保留独立字节份额，长目标不能挤掉最后的等待事项和预算。
    const allowance = Math.max(0, Math.floor((ctx.settings.c03.stateMaxBytes - summary.length + 1) / summary.length));
    return { ok: true, text: truncateBytes(summary.map(section => truncateBytes(section, allowance)).join('\n'), ctx.settings.c03.stateMaxBytes) };
});

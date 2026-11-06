/** 反思只由四类可追溯事实触发；按本地日限制一次，不能靠每次 tick 反复唤醒。 */
import { z } from 'zod';
import type { HubContext } from '../engine/context.js';
import { parseInput } from '../engine/validation.js';
import { nonempty } from '../model/primitives.js';
import { localDateKey, localParts, startOfLocalDay } from '../util/time.js';
import { buildCandidate } from '../appraisal/think.js';
import { enqueue } from '../scheduler/queue.js';
import { auditTool } from '../tools/common.js';
/** 检查周期结束、主人纠正、连续未交账和周复盘条件，满足日限额后只生成一次候选。 */
export function shouldReflect(ctx: HubContext, botId: string, now: number) {
    parseInput(z.strictObject({ botId: nonempty, now: z.number().int() }), { botId, now }, '反思检查');
    const bot = ctx.store.table('bots').get(botId);
    if (!bot || !['active', 'probation'].includes(bot.lifecycle))
        return null;
    // 绝大多数 tick 没有任何复盘触发条件；先看便宜的业务事实，再读取完整历史去重。
    const partsNow = localParts(now, ctx.settings.timezone);
    const periodDue = ctx.store.table('goals').count(g => g.botId === botId && ['active', 'blocked', 'done_pending_check'].includes(g.status)
        && g.periodEndsAt !== null && g.periodEndsAt <= now) > 0;
    const correction = ctx.store.log('thread').recent(1, m => m.from === 'owner' && m.createdAt <= now
        && (m.thread === botId || m.thread === 'team') && /不对|别再|以后|记住/.test(m.text)).length > 0;
    if (bot.consecutiveNoCommit < ctx.settings.noCommitReflectionCount && !periodDue && !correction
        && !(partsNow.weekday === 0 && partsNow.hour >= ctx.settings.c03.reflectionHour)) return null;
    const day = startOfLocalDay(now, ctx.settings.timezone);
    const reflected = ctx.store.table('wakes').count(w => w.botId === botId && w.variant === 'reflection' && w.startedAt >= day && w.startedAt <= now);
    const scheduled = ctx.store.log('audit').since(day, a => a.actor === botId && a.action === 'reflection_enqueued' && a.at <= now).length;
    if (Math.max(reflected, scheduled) >= ctx.settings.c03.reflectionDailyCap)
        return null;
    if (ctx.store.table('queue').list(q => q.botId === botId && q.variant === 'reflection').length)
        return null;
    if (ctx.store.table('wakes').list(w => w.botId === botId && (['running', 'delivering'].includes(w.status) || (w.status === 'committed' && w.endedAt === null))).length)
        return null;
    const used = ctx.store.log('audit').all().filter(a => a.actor === botId && a.action === 'reflection_trigger').map(a => a.detail);
    const goals = ctx.store.table('goals').list(g => g.botId === botId && ['active', 'blocked', 'done_pending_check'].includes(g.status) && g.periodEndsAt !== null && g.periodEndsAt <= now && !used.includes(`goal:${g.id}:${g.periodEndsAt}`));
    const messages = ctx.store.log('thread').all().filter(m => m.from === 'owner' && m.createdAt <= now && (m.thread === botId || (m.thread === 'team' && ctx.store.table('percepts').list(p => p.botId === botId && p.kind === 'owner_message' && p.location === m.id).length > 0)) && /不对|别再|以后|记住/.test(m.text) && !used.includes(`message:${m.id}`));
    let summary = '';
    let ownerSummary = '';
    let key = '';
    const evidence: string[] = [];
    if (bot.consecutiveNoCommit >= ctx.settings.noCommitReflectionCount) {
        summary = '连续两次未交账，复盘收口方式';
        ownerSummary = '连续两次没交账，做一次复盘';
        key = `no_commit:${bot.lastThinkAt}`;
        evidence.push(...ctx.store.table('wakes').list(w => w.botId === botId && w.status === 'no_commit').slice(-ctx.settings.noCommitReflectionCount).map(w => w.id));
    }
    else if (goals[0]) {
        summary = `目标周期结束：${goals[0].title}`;
        ownerSummary = `目标周期结束：${goals[0].title}`;
        key = `goal:${goals[0].id}:${goals[0].periodEndsAt}`;
        evidence.push(goals[0].id);
    }
    else if (messages[0]) {
        summary = '主人提出纠正，请提炼教训';
        ownerSummary = '按你的纠正做一次复盘';
        key = `message:${messages[0].id}`;
        evidence.push(messages[0].id);
    }
    else {
        const parts = localParts(now, ctx.settings.timezone);
        // 周日的本周从上周一开始；以当前本地日期回退，避免依赖服务器时区。
        const start = day - ((parts.weekday + 6) % 7) * ctx.settings.c03.dayMs;
        const turns = ctx.store.table('wakes').count(w => w.botId === botId && w.startedAt >= start && w.startedAt <= now && w.endedAt !== null);
        if (parts.weekday === 0 && parts.hour >= ctx.settings.c03.reflectionHour && turns >= ctx.settings.c03.reflectionWeekMinTurns) {
            summary = '本周已完成至少三轮，做一次周复盘';
            ownerSummary = '本周例行复盘';
            key = `week:${localDateKey(now, ctx.settings.timezone)}`;
            evidence.push(...ctx.store.table('wakes').list(w => w.botId === botId && w.startedAt >= start && w.startedAt <= now && w.endedAt !== null).map(w => w.id));
        }
    }
    if (!summary || used.includes(key))
        return null;
    const result = enqueue(ctx, buildCandidate(ctx, { botId, kind: 'reflection', variant: 'reflection', score: ctx.settings.c02.nextThinkScore, summary, ownerSummary, evidence, subjectKey: `reflection:${key}`, now }));
    if (result?.variant === 'reflection') {
        auditTool(ctx, botId, 'reflection_enqueued', localDateKey(now, ctx.settings.timezone));
        auditTool(ctx, botId, 'reflection_trigger', key);
    }
    return result;
}

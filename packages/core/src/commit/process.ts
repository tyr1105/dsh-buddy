/** 交账先锁定唯一记录，再更新状态与派生文件；文件失败保留真实交账并显式报告，避免重复执行副作用。 */
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import type { HubContext } from '../engine/context.js';
import { parseInput } from '../engine/validation.js';
import { CommitInputSchema } from './schema.js';
import { newId } from '../util/ids.js';
import { formatShort } from '../util/time.js';
import type { Commit } from '../model/index.js';
import { ToolContextSchema, type ToolContext, type ToolResult } from '../tools/types.js';
import { createOwnerDirectWake, findOpenWake, isOpenWake } from '../turn/session.js';
import { applyNextThink } from '../agenda/next-think.js';
import { afterOutcome } from '../scheduler/pacing.js';
import { computeExpectedBy } from '../health/deadman.js';
import { appendJournal, refreshBotFiles, verifyProtectedFiles } from '../memory/index.js';
import { routeCommit, updateCommitGoals } from './effects.js';
import { backoffReviewsAfterCommit } from '../tools/review-backoff.js';
import { removeEntry } from '../scheduler/queue.js';
import { computeDrives } from '../drives/compute.js';
import { optionalMessageText } from '../util/text.js';
/** 核对回合身份后只接收一次交账，更新目标与下次思考，并隔离各项派生写入失败。 */
export async function processCommit(ctx: HubContext, rawContext: ToolContext, rawArgs: unknown): Promise<ToolResult> {
    try {
        const toolCtx = parseInput(ToolContextSchema, rawContext, '工具上下文');
        const input = parseInput(CommitInputSchema, rawArgs, '交账');
        // 先校验类型，再统一空值；避免模型传入文字 null 冒充给主人回复或主动汇报。
        const args = { ...input, reply: optionalMessageText(input.reply), report: optionalMessageText(input.report) };
        const bot = ctx.store.table('bots').get(toolCtx.botId);
        if (!bot || bot.sessionId !== toolCtx.sessionId)
            throw new Error('交账 botId 与 sessionId 不匹配');
        let wake = toolCtx.wakeId ? ctx.store.table('wakes').get(toolCtx.wakeId) : findOpenWake(ctx, toolCtx.sessionId);
        if (toolCtx.wakeId && !wake)
            throw new Error('交账 wakeId 不存在');
        if (wake && (wake.botId !== bot.id || wake.sessionId !== toolCtx.sessionId))
            throw new Error('交账 wakeId 与当前机器人会话不匹配');
        if (wake?.commitId)
            throw new Error('本轮已交账');
        if (wake && !isOpenWake(wake))
            throw new Error('本轮已结束，不能交账');
        if (wake?.reason.kind === 'owner_message' && !wake.ownerDirect && !args.reply?.trim())
            throw new Error('reply：主人消息唤醒的回合必须回复主人');
        const now = ctx.clock.now();
        wake ??= createOwnerDirectWake(ctx, bot.id, toolCtx.sessionId, '主人直接聊天时的交账', now);
        // 在第一次 await 之前保存 commitId；并发重复调用只能看到“已交账”。
        const commit: Commit = { ...args, id: newId('c', ctx.rng), wakeId: wake.id, botId: bot.id, createdAt: now };
        ctx.store.table('commits').put(commit);
        ctx.store.table('wakes').patch(wake.id, { status: 'committed', commitId: commit.id, lastEventAt: now });
        // 主人暂停或退役不取消在途交账；完成交账时仍显示主人设置的停止状态。
        const stopped = bot.lifecycle === 'paused' || bot.lifecycle === 'retired';
        let updated = ctx.store.table('bots').patch(bot.id, { ...afterOutcome(bot, args.outcome, false), lastThinkAt: now,
            consecutiveNoCommit: 0, consecutiveErrors: 0, retryAt: null,
            activity: stopped ? 'resting' : args.ownerQuestion ? 'waiting_owner' : args.outcome === 'blocked' ? 'blocked' : 'watching',
            activityText: stopped ? bot.lifecycle === 'paused' ? '已暂停（你暂停的）' : '已退役'
                : args.ownerQuestion ? '在等主人回复' : args.outcome === 'blocked' ? `受阻：${args.blocker}` : '继续关注变化', updatedAt: now });
        const reviewWarning = backoffReviewsAfterCommit(ctx, commit, wake);
        // 交账重设了时间意图，旧时钟候选不能再触发第二轮轻复查。
        for (const entry of ctx.store.table('queue').list(q => q.botId === bot.id && q.enqueuedAt <= now && ['light_check', 'next_think'].includes(q.reason.kind)))
            removeEntry(ctx, entry.id);
        const goalQuestions = updateCommitGoals(ctx, commit, wake);
        const patch = applyNextThink(updated, args.nextThink, now, { settings: ctx.settings,
            hasActiveGoal: ctx.store.table('goals').count(g => g.botId === bot.id && g.status === 'active') > 0,
            quotaLight: ctx.store.table('quota').get('quota')?.light ?? 'green' });
        const { warning, ...next } = patch;
        updated = ctx.store.table('bots').patch(bot.id, next);
        refreshExpectedBy(ctx, bot.id);
        // 内驱快照保存受挫事实；不在交账入口消费当天内驱唤醒名额。
        const drive = ctx.store.table('drives').get(bot.id);
        if (drive) {
            const values = computeDrives(updated, ctx.store.table('goals').list(), ctx.store.table('agenda').list(), ctx.store.table('inbox').list(), ctx.store.table('handoffs').list(), ctx.store.table('commits').list(), drive.fatigue, now, ctx.settings);
            ctx.store.table('drives').patch(bot.id, args.outcome === 'progress' || args.outcome === 'done'
                ? { stagnation: 0, obligation: 0, waiting: 0, frustration: 0, updatedAt: now } : { ...values, updatedAt: now });
        }
        const failures: string[] = [];
        for (const [label, effect] of [
            ['保护核对', () => verifyProtectedFiles(ctx, bot.id)],
            ['结果路由', () => routeCommit(ctx, commit, wake, goalQuestions)], ['日志追加', () => appendJournal(ctx, updated, commit, wake)],
            ['视图刷新', () => refreshBotFiles(ctx, bot.id)],
        ] as const) {
            try {
                await effect();
            }
            catch (error) {
                failures.push(`${label}失败`);
                ctx.logger.error(`${label}失败，交账 ${commit.id} 已保留`, error);
                ctx.store.log('audit').append({ id: newId('au', ctx.rng), at: now, actor: bot.id, action: 'commit_effect_error', detail: `${commit.id} ${label}：${String(error)}` });
            }
        }
        ctx.emit(HUB_EVENT_SCOPES.activity, bot.id);
        ctx.emit(HUB_EVENT_SCOPES.bot, bot.id);
        const when = updated.nextThinkAt === null ? '有新事件时（保留轻复查）' : formatShort(updated.nextThinkAt, now, ctx.settings.timezone);
        return { ok: true, text: `已交账：${args.outcome}。下次思考：${when}（理由已记录）。${warning ?? ''}${reviewWarning}${failures.length ? `注意：${failures.join('、')}，详见中心日志。` : ''}` };
    }
    catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}
/** 未消费的紧急感知仍可形成应醒承诺，不能因一次普通交账把它遗忘。 */
export function refreshExpectedBy(ctx: HubContext, botId: string): void {
    const bot = ctx.store.table('bots').get(botId);
    if (!bot)
        return;
    const urgent = ctx.store.table('percepts').list(p => p.botId === botId && p.tier === 'urgent' && p.consumedByWake === null && p.discardedAt === undefined && !p.deferredByOwner);
    ctx.store.table('bots').patch(botId, { expectedBy: computeExpectedBy(bot, urgent.length ? Math.min(...urgent.map(p => p.createdAt)) : null, ctx.settings) });
}

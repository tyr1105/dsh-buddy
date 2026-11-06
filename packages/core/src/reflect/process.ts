/** 反思交账把建议落实到同一套工具规则；节奏建议只留给主人看，绝不擅自改节奏配置。 */
import { z } from 'zod';
import type { HubContext } from '../engine/context.js';
import type { ToolContext, ToolResult } from '../tools/types.js';
import { parseInput } from '../engine/validation.js';
import { getToolBot, requiredText, auditTool, requireL1 } from '../tools/common.js';
import { LessonProposeInputSchema, proposeLesson } from '../tools/hub-lesson-propose.js';
import { WatchProposeInputSchema, proposeWatch, validateWatchProposal } from '../tools/hub-watch-propose.js';
import { WatchUpdateInputSchema, updateWatch, validateWatchUpdate } from '../tools/hub-watch-update.js';
import { RoutineSaveInputSchema } from '../tools/hub-routine-save.js';
import { saveRoutine } from '../routines/index.js';
import { processCommit } from '../commit/process.js';
import { MemoryStore } from '../store/memory-store.js';
export const ReflectCommitInputSchema = z.strictObject({ summary: requiredText.max(500, '摘要不能超过 500 字'),
    lessons: z.array(LessonProposeInputSchema), paceAdvice: z.string().optional(),
    watchChanges: z.array(z.union([WatchUpdateInputSchema, WatchProposeInputSchema])), routineUpdates: z.array(RoutineSaveInputSchema) });
const inFlight = new WeakMap<HubContext, Set<string>>();
/** 先预检整批反思变更再串行落实，部分执行失败保留审计并阻止同轮重放。 */
export async function processReflectCommit(ctx: HubContext, tc: ToolContext, input: unknown): Promise<ToolResult> {
    let lockedWake: string | null = null;
    let beganEffects = false;
    const locks = inFlight.get(ctx) ?? new Set<string>();
    inFlight.set(ctx, locks);
    try {
        const args = parseInput(ReflectCommitInputSchema, input, '反思交账');
        const bot = getToolBot(ctx, tc);
        const wake = tc.wakeId ? ctx.store.table('wakes').get(tc.wakeId) : null;
        if (!wake || wake.variant !== 'reflection')
            throw new Error('wakeId：当前不是复盘回合');
        if (!['active', 'probation'].includes(bot.lifecycle)
            && (!['paused', 'retired'].includes(bot.lifecycle) || args.lessons.length || args.watchChanges.length || args.routineUpdates.length))
            throw new Error('机器人当前不在岗，只能提交无变更的复盘总结收尾');
        if (ctx.store.log('audit').all().some(a => a.action === 'reflection_effect_error' && a.detail.startsWith(`${wake.id} `)))
            throw new Error('上次反思部分执行失败，已保留日志；请在下一回合处理，避免重复变更');
        if (wake.commitId || locks.has(wake.id))
            throw new Error('本轮已交账');
        if (!['running', 'delivering'].includes(wake.status))
            throw new Error('wakeId：本轮已经结束');
        if (args.watchChanges.length)
            requireL1(bot);
        // 在隔离内存表中验证全部关注变更，后项无效时不会留下前半份教训或过滤条件。
        const previewStore = new MemoryStore();
        for (const row of ctx.store.table('bots').list())
            previewStore.table('bots').put(row);
        for (const row of ctx.store.table('watches').list())
            previewStore.table('watches').put(row);
        const preview = { ...ctx, store: previewStore };
        const newCount = args.watchChanges.filter(change => !('id' in change)).length;
        if (previewStore.table('watches').count(w => w.botId === bot.id && w.status !== 'expired') + newCount > ctx.settings.maxWatchesPerBot)
            throw new Error('watchChanges：新增后关注项数量超过上限');
        for (const change of args.watchChanges) {
            if ('id' in change) {
                const value = validateWatchUpdate(preview, bot.id, change);
                previewStore.table('watches').patch(change.id, { intervalMs: value.intervalMs, filter: value.filter, status: value.args.status ?? value.old.status });
            }
            else
                validateWatchProposal(preview, bot.id, change);
        }
        locks.add(wake.id);
        lockedWake = wake.id;
        beganEffects = true;
        for (const lesson of args.lessons)
            await proposeLesson(ctx, bot.id, lesson);
        for (const change of args.watchChanges) {
            if ('id' in change)
                await updateWatch(ctx, bot.id, change);
            else
                await proposeWatch(ctx, bot.id, change);
        }
        for (const routine of args.routineUpdates)
            await saveRoutine(ctx, bot.id, routine);
        if (args.paceAdvice?.trim())
            auditTool(ctx, bot.id, 'reflection_pace_advice', args.paceAdvice);
        // 反思没有实际变更时记 no_change；统一处理器维护日志、nextThink 和回合状态。
        return await processCommit(ctx, tc, { outcome: args.lessons.length || args.watchChanges.length || args.routineUpdates.length ? 'progress' : 'no_change', summary: args.summary,
            worldChanges: [], evidence: [], verification: { level: 'agent', notCovered: '反思建议尚未由主人独立验证' }, blocker: null,
            nextThink: { mode: 'auto', reason: '反思完成，等待下一件需要处理的事' }, ownerQuestion: null,
            reply: wake.ownerInitiated ? args.summary : null, report: null, importance: ctx.settings.c03.reflectCommitImportance, proposals: [] });
    }
    catch (error) {
        if (beganEffects && lockedWake)
            auditTool(ctx, tc.botId, 'reflection_effect_error', `${lockedWake} ${error instanceof Error ? error.message : '执行失败'}`);
        return { ok: false, error: error instanceof Error ? error.message : '反思交账失败' };
    }
    finally {
        if (lockedWake)
            locks.delete(lockedWake);
    }
}

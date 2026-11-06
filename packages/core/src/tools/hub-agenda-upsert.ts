/** 议程写入工具：允许单次意图，限制未来事项数量，并让无变化复查自动拉长间隔。 */
import { z } from 'zod';
import { AgendaItemSchema, type AgendaItem } from '../model/bot.js';
import { parseFlexibleTime } from '../util/time.js';
import { newId } from '../util/ids.js';
import { refreshBotFiles } from '../memory/index.js';
import { acceptHandoffForAgenda } from '../peer/handoffs.js';
import { previousReview, recordReviewSchedule } from './review-backoff.js';
import { defineTool, requiredText, auditTool } from './common.js';
export const AgendaUpsertInputSchema = z.strictObject({ id: requiredText.optional(), kind: z.enum(['task', 'follow_up', 'conditional', 'commitment', 'review']),
    title: requiredText, goalId: requiredText.nullable().optional(), dueAt: requiredText.nullable().optional(), onEvent: requiredText.nullable().optional(),
    abandonWhen: requiredText, priority: z.number().int().min(1).max(5), toOwner: z.boolean().optional() });
export const hubAgendaUpsert = defineTool('hub_agenda_upsert', '新建或修改自己的一次议程；dueAt 用 ISO 或北京时间 YYYY-MM-DD HH:mm，必须写放弃条件，不能拼成固定周期。L0 不可用。', AgendaUpsertInputSchema, 'L1', async (ctx, tc, args) => {
    const now = ctx.clock.now();
    const old = args.id ? ctx.store.table('agenda').get(args.id) : null;
    if (args.id && (!old || old.botId !== tc.botId))
        throw new Error('id：议程不存在或不属于你');
    if (old && old.status !== 'open')
        throw new Error('id：已关闭议程不能重新打开，请新建一次事项');
    if (args.goalId && ctx.store.table('goals').get(args.goalId)?.botId !== tc.botId)
        throw new Error('goalId：目标不存在或不属于你');
    const open = ctx.store.table('agenda').list(a => a.botId === tc.botId && a.status === 'open' && a.id !== old?.id);
    if (open.length >= ctx.settings.maxOpenAgendaPerBot)
        throw new Error('未完成议程数量已达上限');
    let dueAt = args.dueAt === undefined ? old?.dueAt ?? null : args.dueAt === null ? null : parseFlexibleTime(args.dueAt, ctx.settings.timezone);
    if (args.dueAt && dueAt === null)
        throw new Error('dueAt：必须是有效 ISO 时间或北京时间 YYYY-MM-DD HH:mm');
    if (dueAt !== null && dueAt > now + ctx.settings.agendaMaxFutureMs)
        throw new Error('dueAt：不能超过最远 30 天的范围');
    const source = old?.source ?? 'bot';
    const botScheduled = new Set(ctx.store.log('audit').all().filter(a => a.actor === tc.botId && a.action === 'bot_agenda_due').map(a => a.detail));
    if (dueAt !== null && open.filter(a => (a.source === 'bot' || botScheduled.has(a.id)) && a.dueAt !== null).length >= ctx.settings.c03.botDueAgendaCap)
        throw new Error('带 dueAt 的自主议程已达上限，不能用议程拼周期');
    let adjusted = false;
    const previous = args.kind === 'review' ? previousReview(ctx, tc.botId, args.title, old) : null;
    if (args.kind === 'review' && dueAt !== null && previous) {
        const latest = ctx.store.table('wakes').list(w => w.botId === tc.botId && w.reason.evidence.includes(previous.item.id) && w.commitId !== null)
            .map(w => ctx.store.table('commits').get(w.commitId!)).filter(c => c !== null).sort((a, b) => b.createdAt - a.createdAt)[0];
        if (latest?.outcome === 'no_change') {
            const floor = now + previous.interval * ctx.settings.c03.reviewBackoffMultiplier;
            if (floor > now + ctx.settings.agendaMaxFutureMs)
                throw new Error('dueAt：无变化复查所需间隔超过议程范围，请等待事件再复查');
            if (dueAt < floor) { dueAt = floor; adjusted = true; }
        }
    }
    const row: AgendaItem = AgendaItemSchema.parse({ id: old?.id ?? newId('a', ctx.rng), botId: tc.botId,
        kind: args.kind, title: args.title, goalId: args.goalId === undefined ? old?.goalId ?? null : args.goalId,
        dueAt, onEvent: args.onEvent === undefined ? old?.onEvent ?? null : args.onEvent, abandonWhen: args.abandonWhen,
        priority: args.priority, toOwner: args.toOwner ?? old?.toOwner ?? false, source, status: 'open', note: old?.note ?? null,
        createdAt: old?.createdAt ?? now, updatedAt: now });
    if (row.kind === 'conditional' && !row.onEvent)
        throw new Error('onEvent：条件议程必须写明等待的事件');
    ctx.store.table('agenda').put(row);
    recordReviewSchedule(ctx, row, tc.wakeId, previous, adjusted);
    if (row.dueAt !== null) auditTool(ctx, tc.botId, 'bot_agenda_due', row.id);
    acceptHandoffForAgenda(ctx, tc.botId, row.id);
    auditTool(ctx, tc.botId, 'hub_agenda_upsert', row.id);
    await refreshBotFiles(ctx, tc.botId);
    return { ok: true, text: `已保存议程 ${row.id}：${row.title}${adjusted ? '；上次复查没有变化，到期时间已按上次间隔的两倍自动推后' : ''}` };
});

/** 复查预约保存每次到期历史，交账后统一退避，覆盖同轮续建与原地修改两种写法。 */
import type { HubContext } from '../engine/context.js';
import type { AgendaItem, Commit, WakeTicket } from '../model/index.js';
import { readAuditDetail, writeOutreachAudit } from '../outreach/audit.js';
interface ReviewSchedule { id: string; title: string; dueAt: number; previousDueAt: number | null; interval: number; wakeId: string | null; adjusted: boolean }
/** 最近两次不同的到期时间之差才是上次节奏；第一条没有前次时用创建时间。 */
export function previousReview(ctx: HubContext, botId: string, title: string, old: AgendaItem | null): { item: AgendaItem; interval: number } | null {
    const histories = ctx.store.log('audit').all().filter(a => a.actor === botId && a.action === 'review_scheduled')
        .map(a => readAuditDetail<ReviewSchedule>(a.detail)).filter((a): a is ReviewSchedule => a !== null && a.title === title);
    const items = ctx.store.table('agenda').list(a => a.botId === botId && a.kind === 'review' && a.title === title && a.dueAt !== null);
    const item = old?.kind === 'review' && old.title === title && old.dueAt !== null ? old : items.sort((a, b) => b.dueAt! - a.dueAt!)[0];
    if (!item) return null;
    const times = [...new Set([...histories.flatMap(row => [row.dueAt, ...(row.previousDueAt === null ? [] : [row.previousDueAt])]), ...items.map(a => a.dueAt!)])]
        .filter(at => at < item.dueAt!).sort((a, b) => b - a);
    return { item, interval: Math.max(0, item.dueAt! - (times[0] ?? item.createdAt)) };
}
/** 保存足够的历史计算下一轮间隔，不能靠改同一条 open 记录抹去旧预约。 */
export function recordReviewSchedule(ctx: HubContext, row: AgendaItem, wakeId: string | null, previous: ReturnType<typeof previousReview>, adjusted: boolean): void {
    if (row.kind !== 'review' || row.dueAt === null) return;
    writeOutreachAudit(ctx, 'review_scheduled', { id: row.id, title: row.title, dueAt: row.dueAt,
        previousDueAt: previous?.item.dueAt ?? null, interval: previous?.interval ?? row.dueAt - row.createdAt, wakeId, adjusted }, row.botId);
}
/** 同一回合先续约再交 no_change 时，只有交账时才知道需退避；progress 保留原预约。 */
export function backoffReviewsAfterCommit(ctx: HubContext, commit: Commit, wake: WakeTicket): string {
    if (commit.outcome !== 'no_change') return '';
    const schedules = ctx.store.log('audit').all().filter(a => a.actor === commit.botId && a.action === 'review_scheduled')
        .map(a => readAuditDetail<ReviewSchedule>(a.detail)).filter((a): a is ReviewSchedule => a !== null && a.wakeId === wake.id);
    const changed: string[] = [];
    for (const schedule of [...new Map(schedules.map(row => [row.id, row])).values()]) {
        if (schedule.adjusted) continue;
        const handled = wake.reason.evidence.map(id => ctx.store.table('agenda').get(id)).some(item => item?.kind === 'review' && item.title === schedule.title);
        const item = ctx.store.table('agenda').get(schedule.id);
        if (!handled || !item || item.status !== 'open' || item.dueAt === null) continue;
        const floor = commit.createdAt + schedule.interval * ctx.settings.c03.reviewBackoffMultiplier;
        if (item.dueAt >= floor) continue;
        // 超出最远预约范围则等待事件，不保留过密周期。
        const dueAt = floor <= commit.createdAt + ctx.settings.agendaMaxFutureMs ? floor : null;
        ctx.store.table('agenda').patch(item.id, { dueAt, updatedAt: commit.createdAt });
        if (dueAt !== null) writeOutreachAudit(ctx, 'review_scheduled', { ...schedule, dueAt, adjusted: true }, item.botId);
        changed.push(item.title);
    }
    return changed.length ? `无变化复查「${changed.join('、')}」已按上次间隔的两倍自动推后。` : '';
}

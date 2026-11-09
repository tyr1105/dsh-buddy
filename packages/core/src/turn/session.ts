/** 会话与唤醒单绑定：交账后直到宿主结束仍占据同一回合，主人直聊则建立可计量的主人回合。 */
import type { HubContext } from '../engine/context.js';
import type { WakeTicket } from '../model/wake.js';
import { buildCandidate } from '../appraisal/think.js';
import { newId } from '../util/ids.js';
import { createTicket } from '../wake/ticket.js';
/** 把尚未宿主结束的已交账回合也视为占用中，避免提前释放并发名额。 */
export function isOpenWake(wake: WakeTicket): boolean {
    return wake.endedAt === null && ['delivering', 'running', 'committed'].includes(wake.status);
}
/** 取得会话最近一个仍占用中的唤醒单，使宿主事件与真实回合对应。 */
export function findOpenWake(ctx: HubContext, sessionId: string): WakeTicket | null {
    return ctx.store.table('wakes').list(w => w.sessionId === sessionId && isOpenWake(w)).sort((a, b) => b.startedAt - a.startedAt)[0] ?? null;
}
/** 为主人直接在宿主会话中的发言建立已运行唤醒单，保证直聊也可计量和交账。 */
export function createOwnerDirectWake(ctx: HubContext, botId: string, sessionId: string, text: string, at: number): WakeTicket {
    const candidate = buildCandidate(ctx, { botId, kind: 'owner_message', score: ctx.settings.c02.ownerSalience,
        summary: text.trim() || '主人直接在工作会话中交谈', ownerInitiated: true, now: at });
    const wake = createTicket(ctx, { ...candidate, id: newId('q', ctx.rng), enqueuedAt: at }, sessionId);
    return ctx.store.table('wakes').patch(wake.id, { ownerDirect: true, variant: 'regular', status: 'running',
        startedAt: at, lastEventAt: at, dispatchedAt: at });
}

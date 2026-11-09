/** tick 检查真实回合上限；先收口再取消，标记放在 await 前以免并行 tick 重复操作宿主。 */
import type { HubContext } from '../engine/context.js';
import { parseInput } from '../engine/validation.js';
import { timestamp } from '../model/primitives.js';
import { turnLimitsFor } from '../config/defaults.js';
import { isOpenWake } from './session.js';
import { finishTurn } from './events.js';
export const CLOSING_MESSAGE = '【中心通知】已到本轮上限，请立即调用 hub_commit 收口，未完成的部分写进议程。';
const checking = new WeakSet<HubContext>();
/** 逐回合检查资源、收口与审批等待上限，先提醒后取消并隔离单回合处理错误。 */
export async function checkTurnLimits(ctx: HubContext, input: number): Promise<void> {
    const now = parseInput(timestamp, input, '回合检查时间');
    if (checking.has(ctx))
        return;
    checking.add(ctx);
    try {
        for (const wake of ctx.store.table('wakes').list(isOpenWake)) {
            try {
                // 交账就是工作完成；宿主结束事件迟到不能再要求交账或累计错误。
                if (wake.commitId) {
                    const committedAt = ctx.store.table('commits').get(wake.commitId)?.createdAt ?? wake.lastEventAt;
                    if (now >= committedAt + ctx.settings.c03.committedEndGraceMs)
                        await finishTurn(ctx, wake.id, now, 'committed');
                    continue;
                }
                if (!wake.sessionId) continue;
                const approvalExpired = wake.awaitingApprovalAt != null && now >= wake.awaitingApprovalAt + ctx.settings.c03.awaitingApprovalCancelMs;
                const closingExpired = wake.steeredAt !== null && now >= wake.steeredAt + ctx.settings.closingGraceMs;
                if (approvalExpired || closingExpired) {
                    try {
                        await ctx.host.cancel(wake.sessionId);
                    } finally {
                        // 宿主取消接口失败也必须释放中心并发并安排错误重试，不能遗留永久占位。
                        await finishTurn(ctx, wake.id, now, 'timeout', approvalExpired ? '宿主审批框等待超时' : '收口后仍未结束，回合超时');
                    }
                    continue;
                }
                const limit = turnLimitsFor(wake.variant === 'trial' || wake.variant === 'teach' ? wake.variant : wake.ownerInitiated ? 'owner' : wake.variant, ctx.settings);
                if (wake.steeredAt === null && (wake.steps >= limit.steps || wake.tokens >= limit.tokens || now - wake.startedAt >= limit.durationMs)) {
                    ctx.store.table('wakes').patch(wake.id, { steeredAt: now });
                    await ctx.host.steer(wake.sessionId, CLOSING_MESSAGE);
                }
            }
            catch (error) {
                ctx.logger.error(`回合 ${wake.id} 的上限处理失败`, error);
            }
        }
    }
    finally {
        checking.delete(ctx);
    }
}

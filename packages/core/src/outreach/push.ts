/** 单推统一经过免打扰、日预算与主题去重；串行检查防止同时申请透支主人注意力。 */
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import { z } from 'zod';
import type { HubContext } from '../engine/context.js';
import { parseInput } from '../engine/validation.js';
import { nonempty, text } from '../model/primitives.js';
import { PrioritySchema } from '../model/enums.js';
import { isInQuietHours, startOfLocalDay } from '../util/time.js';
import { readAuditDetail, writeOutreachAudit } from './audit.js';
const PushSchema = z.strictObject({ botId: nonempty.nullable(), level: PrioritySchema, title: nonempty, body: text, subjectKey: nonempty });
export type PushInput = z.infer<typeof PushSchema>;
export type PushResult = 'sent' | 'deferred_quiet' | 'over_budget' | 'duplicate';
export interface PushAudit extends PushInput {
    result: PushResult;
    at: number;
}
const locks = new WeakMap<HubContext, Promise<unknown>>();
/** 从审计日志还原成功与被拦截的单推记录，供预算和日报使用。 */
export function pushHistory(ctx: HubContext): PushAudit[] {
    return ctx.store.log('audit').all().filter(row => row.action === 'push')
        .map(row => {
        const detail = readAuditDetail<PushAudit>(row.detail);
        return detail ? { ...detail, at: row.at } : null;
    })
        .filter((row): row is PushAudit => row !== null);
}
/** 按本地日计算全体与单机器人剩余单推名额，P0 紧急事项不消耗普通预算。 */
export function pushesLeft(ctx: HubContext, botId?: string, now = ctx.clock.now()): number {
    const start = startOfLocalDay(now, ctx.settings.timezone);
    const sent = pushHistory(ctx).filter(row => row.result === 'sent' && row.level !== 'P0' && row.at >= start && row.at <= now);
    const whole = Math.max(0, ctx.settings.dailyPushCap - sent.length);
    return botId ? Math.min(whole, Math.max(0, ctx.settings.botDailyPushCap - sent.filter(row => row.botId === botId).length)) : whole;
}
/** 串行检查主题去重、免打扰和预算，宿主通知成功后才记录消耗。 */
export async function requestPush(ctx: HubContext, input: PushInput): Promise<PushResult> {
    const value = parseInput(PushSchema, input, '单推');
    const previous = locks.get(ctx) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(async (): Promise<PushResult> => {
        const now = ctx.clock.now();
        const duplicate = pushHistory(ctx).some(row => row.result === 'sent' && row.subjectKey === value.subjectKey && row.at <= now && now - row.at < ctx.settings.dedupWindowMs);
        let result: PushResult;
        if (duplicate)
            result = 'duplicate';
        else if (value.level !== 'P0' && isInQuietHours(now, ctx.settings.quietHours, ctx.settings.timezone))
            result = 'deferred_quiet';
        else if (value.level !== 'P0' && pushesLeft(ctx, value.botId ?? undefined, now) === 0)
            result = 'over_budget';
        else {
            // 宿主成功返回后才计入已推送；失败不消耗预算，让调用方可以明确处理故障。
            await ctx.host.notify({ title: value.title, body: value.body, level: value.level, botId: value.botId });
            result = 'sent';
        }
        writeOutreachAudit(ctx, 'push', { ...value, result }, 'hub', now);
        ctx.emit(HUB_EVENT_SCOPES.overview, value.botId);
        return result;
    });
    locks.set(ctx, operation);
    return operation;
}

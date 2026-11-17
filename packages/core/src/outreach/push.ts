/**
 * 单推统一经过去重、免打扰；串行检查防止同一主题同时申请重复发出。
 * P76c：每日推送条数上限（全队、每位）已取消，不再有「超出预算」这一支；over_budget 仍留在结果类型里，只为读旧审计。
 */
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import { z } from 'zod';
import type { HubContext } from '../engine/context.js';
import { parseInput } from '../engine/validation.js';
import { nonempty, text } from '../model/primitives.js';
import { PrioritySchema } from '../model/enums.js';
import { isInQuietHours } from '../util/time.js';
import { readAuditDetail, writeOutreachAudit } from './audit.js';
const PushSchema = z.strictObject({ botId: nonempty.nullable(), level: PrioritySchema, title: nonempty, body: text, subjectKey: nonempty });
export type PushInput = z.infer<typeof PushSchema>;
export type PushResult = 'sent' | 'deferred_quiet' | 'over_budget' | 'duplicate';
export interface PushAudit extends PushInput {
    result: PushResult;
    at: number;
}
const locks = new WeakMap<HubContext, Promise<unknown>>();
/** 从审计日志还原成功与被拦截的单推记录，供去重和界面展示使用。 */
export function pushHistory(ctx: HubContext): PushAudit[] {
    return ctx.store.log('audit').all().filter(row => row.action === 'push')
        .map(row => {
        const detail = readAuditDetail<PushAudit>(row.detail);
        return detail ? { ...detail, at: row.at } : null;
    })
        .filter((row): row is PushAudit => row !== null);
}
/** 串行检查主题去重和免打扰，宿主通知成功后才记录。 */
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
        else {
            // 宿主成功返回后才记为已推送；失败不记，让调用方可以明确处理故障。
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

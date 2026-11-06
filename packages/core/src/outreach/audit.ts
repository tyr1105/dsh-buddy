/** 收件箱、推送和只读视图的辅助事实写入审计日志，重启后仍能去重且不新增存储表。 */
import type { HubContext } from '../engine/context.js';
import { newId } from '../util/ids.js';
/** 把交互辅助事实写为结构化审计，支持重启后的去重、预算和日报还原。 */
export function writeOutreachAudit(ctx: HubContext, action: string, detail: unknown, actor = 'hub', at = ctx.clock.now()) {
    const row = { id: newId('au', ctx.rng), at, actor, action, detail: JSON.stringify(detail) };
    ctx.store.log('audit').append(row);
    return row;
}
/** 忽略非本模块的普通文本审计，避免一条旧日志破坏日报与读取状态。 */
export function readAuditDetail<T>(text: string): T | null {
    try {
        return JSON.parse(text) as T;
    }
    catch {
        return null;
    }
}

/** 已读游标单独原子持久化，避免审计日志的内存保留窗口使旧消息重新变未读。 */
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import { z } from 'zod';
import { posix } from 'node:path';
import type { HubContext } from '../engine/context.js';
import { nonempty, timestamp } from '../model/primitives.js';
import { writeOutreachAudit } from './audit.js';
const CursorSchema = z.strictObject({ at: timestamp, ids: z.array(nonempty) });
const StateSchema = z.record(nonempty, CursorSchema);
export type ReadCursor = z.infer<typeof CursorSchema>;
const caches = new WeakMap<HubContext, Record<string, ReadCursor>>();
const locks = new WeakMap<HubContext, Promise<unknown>>();
/** 集中构造中心已读状态文件位置，避免线程游标分散落盘。 */
const statePath = (ctx: HubContext) => posix.join(ctx.settings.rootDir, '.hub/thread-read-state.json');
/** 从独立持久化文件恢复已读游标；无效文件报错保留原件，不悄悄重置状态。 */
export async function loadThreadReadState(ctx: HubContext): Promise<void> {
    const raw = await ctx.fs.readText(statePath(ctx));
    if (raw === null) {
        caches.set(ctx, Object.create(null) as Record<string, ReadCursor>);
        return;
    }
    let value: unknown;
    try {
        value = JSON.parse(raw);
    }
    catch {
        throw new Error('已读状态文件不是合法 JSON，未覆盖原文件');
    }
    const parsed = StateSchema.safeParse(value);
    if (!parsed.success)
        throw new Error('已读状态文件无效，未覆盖原文件');
    caches.set(ctx, parsed.data);
}
/** 读取指定线程的已读游标，仅接受对象自身键，避免原型属性被误作状态。 */
export function cachedReadCursor(ctx: HubContext, thread: string): ReadCursor | null {
    const state = caches.get(ctx);
    return state && Object.hasOwn(state, thread) ? state[thread]! : null;
}
/** 保存时先写磁盘再更新缓存和审计；I/O 失败不把尚未持久化的状态宣称为已读。 */
export async function saveReadCursor(ctx: HubContext, thread: string, at: number): Promise<void> {
    const operation = (locks.get(ctx) ?? Promise.resolve()).catch(() => undefined).then(async () => {
        if (!caches.has(ctx))
            await loadThreadReadState(ctx);
        const old = cachedReadCursor(ctx, thread);
        const cutoff = Math.max(at, old?.at ?? at);
        const ids = ctx.store.log('thread').all().filter(row => row.thread === thread && row.createdAt === cutoff).map(row => row.id);
        const cursor = { at: cutoff, ids: [...new Set([...(old?.at === cutoff ? old.ids : []), ...ids])] };
        const next = { ...caches.get(ctx), [thread]: cursor };
        await ctx.fs.writeTextAtomic(statePath(ctx), JSON.stringify(next));
        caches.set(ctx, next);
        writeOutreachAudit(ctx, 'thread_read', { thread, ...cursor }, 'owner');
        ctx.emit(HUB_EVENT_SCOPES.thread, thread === 'team' ? null : thread);
    });
    locks.set(ctx, operation);
    await operation;
}

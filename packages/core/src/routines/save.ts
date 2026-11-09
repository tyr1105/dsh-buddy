/** 套路同时保存结构化索引和可读清单；同名更新沿用身份与运行次数，并追加修订记录。 */
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import { z } from 'zod';
import { posix } from 'node:path';
import type { HubContext } from '../engine/context.js';
import { parseInput } from '../engine/validation.js';
import { nonempty } from '../model/primitives.js';
import type { Routine } from '../model/team.js';
import { newId } from '../util/ids.js';
import { slugify } from '../util/text.js';
import { localDateKey, formatShort } from '../util/time.js';
import { writeOutreachAudit } from '../outreach/audit.js';
export const RoutineInputSchema = z.strictObject({ name: nonempty, whenToUse: nonempty, steps: z.array(nonempty).min(1, 'steps：至少写一个步骤'), learnedFrom: nonempty.nullable().optional() });
export type RoutineInput = z.infer<typeof RoutineInputSchema>;
const routineLocks = new WeakMap<HubContext, Map<string, Promise<unknown>>>();
/** 同名识别和文件写入在同一串行操作内，避免两次并行保存各建一份记录。 */
async function withRoutineLock<T>(ctx: HubContext, botId: string, operation: () => Promise<T>): Promise<T> {
    let locks = routineLocks.get(ctx);
    if (!locks) {
        locks = new Map();
        routineLocks.set(ctx, locks);
    }
    const next = (locks.get(botId) ?? Promise.resolve()).catch(() => undefined).then(operation);
    locks.set(botId, next);
    try {
        return await next;
    }
    finally {
        if (locks.get(botId) === next)
            locks.delete(botId);
    }
}
/** 原子保存套路清单并追加修订来源，再更新结构化索引以保持文件与事实对应。 */
async function writeRoutine(ctx: HubContext, routine: Routine, verb: string): Promise<void> {
    const bot = ctx.store.table('bots').get(routine.botId);
    if (!bot)
        throw new Error('botId：机器人不存在');
    const path = posix.join(bot.homeDir, 'playbooks', `${routine.slug}.md`);
    const old = await ctx.fs.readText(path);
    const history = old?.split('\n## 修订记录\n').slice(1).join('\n## 修订记录\n').trim() ?? '';
    const when = `${localDateKey(routine.updatedAt, ctx.settings.timezone)} ${formatShort(routine.updatedAt, routine.updatedAt, ctx.settings.timezone).replace('今天 ', '')}`;
    const text = `# ${routine.name}\n\n## 什么时候用\n${routine.whenToUse}\n\n## 步骤\n${routine.steps.map((step, index) => `${index + 1}. ${step}`).join('\n')}\n\n## 学自哪里\n${routine.learnedFrom ?? '机器人实践整理'}\n\n## 修订记录\n${history ? `${history}\n` : ''}- ${when} ${verb}\n`;
    await ctx.fs.writeTextAtomic(path, text, { within: bot.homeDir });
    ctx.store.table('routines').put(routine);
    writeOutreachAudit(ctx, 'routine_save', { id: routine.id, name: routine.name, verb }, routine.botId);
    ctx.emit(HUB_EVENT_SCOPES.bot, routine.botId);
}
/** 串行保存同一机器人的套路，避免并发同名创建导致重复记录。 */
export async function saveRoutine(ctx: HubContext, botId: string, input: RoutineInput): Promise<Routine> {
    return withRoutineLock(ctx, botId, () => saveRoutineUnlocked(ctx, botId, input));
}
/** 校验套路并复用同名身份与使用次数，必要时生成不冲突的文件名。 */
async function saveRoutineUnlocked(ctx: HubContext, botId: string, input: RoutineInput): Promise<Routine> {
    const value = parseInput(RoutineInputSchema, input, '套路');
    if (!ctx.store.table('bots').get(botId))
        throw new Error('botId：机器人不存在');
    const old = ctx.store.table('routines').list(row => row.botId === botId && row.name === value.name)[0];
    const id = old?.id ?? newId('r', ctx.rng);
    let slug = old?.slug ?? slugify(value.name);
    if (!old && ctx.store.table('routines').list(row => row.botId === botId && row.slug === slug).length)
        slug += `-${id.slice(2)}`;
    const now = ctx.clock.now();
    const routine: Routine = { id, botId, name: value.name, slug, whenToUse: value.whenToUse, steps: value.steps,
        learnedFrom: value.learnedFrom === undefined ? old?.learnedFrom ?? null : value.learnedFrom,
        runs: old?.runs ?? 0, lastRunAt: old?.lastRunAt ?? null, createdAt: old?.createdAt ?? now, updatedAt: now };
    await writeRoutine(ctx, routine, old ? '更新套路' : '创建套路');
    return routine;
}
/** 输出名称、适用场景与文件位置，供唤醒包简明列出可用套路。 */
export function routineIndex(ctx: HubContext, botId: string): string {
    return ctx.store.table('routines').list(row => row.botId === botId).map(row => `${row.name}：${row.whenToUse}（playbooks/${row.slug}.md）`).join('\n') || '暂无套路';
}
/** 按现有套路归属取得串行锁，让主人编辑与机器人保存遵循同一顺序。 */
export async function editRoutine(ctx: HubContext, id: string, patch: Partial<RoutineInput>): Promise<Routine> {
    const old = ctx.store.table('routines').get(parseInput(nonempty, id, 'id'));
    if (!old)
        throw new Error('id：套路不存在');
    return withRoutineLock(ctx, old.botId, () => editRoutineUnlocked(ctx, id, patch));
}
/** 校验主人修改并拒绝同名冲突，保留既有使用历史后写入修订记录。 */
async function editRoutineUnlocked(ctx: HubContext, id: string, patch: Partial<RoutineInput>): Promise<Routine> {
    id = parseInput(nonempty, id, 'id');
    const value = parseInput(RoutineInputSchema.partial(), patch, '套路修改');
    const old = ctx.store.table('routines').get(id);
    if (!old)
        throw new Error('id：套路不存在');
    if (value.name && ctx.store.table('routines').count(row => row.botId === old.botId && row.name === value.name && row.id !== old.id))
        throw new Error('name：已有同名套路');
    const routine: Routine = { ...old, ...value, learnedFrom: value.learnedFrom === undefined ? old.learnedFrom : value.learnedFrom, updatedAt: ctx.clock.now() };
    await writeRoutine(ctx, routine, '主人修订');
    return routine;
}

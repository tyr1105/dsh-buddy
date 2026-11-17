/**
 * 记忆的只读查询（P75c）：「旧规矩表还要不要读」「这位员工适用哪些规矩和偏好」。
 *
 * 为什么和写入服务（service.ts）分开：身份文件的渲染（render.ts）要用这两个查询，而写入服务写完要刷新身份文件，
 * 如果放在同一个文件里，渲染和写入会互相引用。把只读查询单独放在这里，渲染只依赖本文件，没有循环。
 * service.ts 会重新导出这里的函数，对外仍是一个入口。
 *
 * 本文件只读存储，不写任何东西。
 */
import { MEMORY_DEFAULTS as D } from '../config/defaults.js';
import type { HubContext } from '../engine/context.js';
import type { Bot } from '../model/bot.js';
import type { Memory } from '../model/memory.js';
import type { Rule } from '../model/team.js';

/**
 * 旧规矩表现在还要不要读（P75r1）：记忆不设开关，任何时候都生效；旧规矩表只在迁移完成之前「一并生效」。
 * 迁移记录的状态不是 done（含没有这一行）时为真；done 之后为假。
 * 为什么不会来回翻转：迁移记录只由迁移（P75f）写，旧规矩表只会从「读」变成「不读」，不会反过来；
 * 而且这个判断不看旧规矩表里有没有内容，员工自己写进一条旧规矩不会让记忆失效。
 */
export function legacyRulesInEffect(ctx: HubContext): boolean {
  return ctx.store.table('migrations').get(D.MIGRATION_ID)?.state !== 'done';
}

/**
 * 旧规矩表里仍然生效、应当读到的规矩（P75r1）。
 * - who 是某位员工：作用于全队或这位员工的规矩；who 是 'all'：只要作用于全队的规矩。
 * - 去掉「已经有对应记忆的」：memories 表里存在 source.legacyRuleId 等于这条规矩 id 的行（不论那一行是什么状态，
 *   包括已删除、已撤销），这条旧规矩就不再列。为什么：避免同一条出现两次，也避免主人删掉记忆后旧规矩又冒出来。
 * - legacyRulesInEffect 为假（迁移已完成）时返回空数组。
 */
export function legacyRulesOf(ctx: HubContext, who: Pick<Bot, 'id'> | 'all'): Rule[] {
  if (!legacyRulesInEffect(ctx)) return [];
  // 已有对应记忆的旧规矩编号（任何状态都算）。
  const migrated = new Set<string>();
  for (const row of ctx.store.table('memories').list()) {
    const legacyId = row.source.legacyRuleId;
    if (legacyId !== undefined && legacyId !== null) migrated.add(legacyId);
  }
  return ctx.store.table('rules').list(row => row.status === 'active' && !migrated.has(row.id)
    && (row.scope === 'global' || (who !== 'all' && row.scope === who.id)));
}

/** 这条记忆是不是会写进身份文件的那种：生效中，且是规矩或偏好（先例不进身份文件）。 */
function isPromptMemory(row: Memory): boolean {
  return row.status === 'active' && (row.kind === 'rule' || row.kind === 'preference');
}

/** 全部生效中的规矩和偏好，不分适用于谁（总管约定段的出处列表读这一组，范围由行尾后缀写明，P75r1）。 */
export function allPromptMemories(ctx: HubContext): Memory[] {
  return ctx.store.table('memories').list(row => isPromptMemory(row));
}

/** 适用于这位员工的规矩和偏好：适用范围是全部员工，或名单里含这位员工。 */
export function memoriesForBot(ctx: HubContext, bot: Pick<Bot, 'id'>): Memory[] {
  return ctx.store.table('memories').list(row => isPromptMemory(row)
    && (row.scope.staff === 'all' || row.scope.staff.includes(bot.id)));
}

/** 适用于全体员工的规矩和偏好（全体守则读这一组）。 */
export function memoriesForAll(ctx: HubContext): Memory[] {
  return ctx.store.table('memories').list(row => isPromptMemory(row) && row.scope.staff === 'all');
}

/**
 * 每条记忆被约定引用的次数（P75d；P75r1 改为按约定份数计）：每份约定对一条记忆最多计 1 次。
 * 取这份约定里版本号最大的、状态为已固定或已被取代的那一版，这一版里至少有一条「我已定的」依据是这条记忆，就计 1。
 * 为什么按份数、只看最新固定的一版：原来每个固定过的版本、每条已定事项都计一次，总管多次修订或多处引用，
 * 就能把一条规矩排到身份文件和出处列表的最前面（审查记录 M5）。最新固定的一版不再引用它，说明这份约定已经不用它，计 0。
 * 为什么每次现算：约定表很小；记忆页、身份文件排序、出处排序都要用，调用方在一次视图或一次渲染里只调用一次、再从结果里取值。
 * 只数约定：写进身份文件被员工读到的次数不计（方案第 15 节第 15 条）。
 */
export function memoryCitations(ctx: HubContext): Map<string, number> {
  const counts = new Map<string, number>();
  for (const agreement of ctx.store.table('agreements').list()) {
    const latest = agreement.versions.filter(row => row.state === 'locked' || row.state === 'replaced').sort((a, b) => b.no - a.no)[0];
    if (latest === undefined) continue;
    // 这一版里被引用的记忆编号去重：同一版两条已定事项引用同一条，只计 1。
    const cited = new Set<string>();
    for (const item of latest.content.decided) {
      const ref = item.basis.ref;
      if (item.basis.kind === 'source' && ref !== null && ref.startsWith('mem_')) cited.add(ref);
    }
    for (const ref of cited) counts.set(ref, (counts.get(ref) ?? 0) + 1);
  }
  return counts;
}

/** 一条记忆被约定引用的次数（单条取值；要排序或批量取值时先调用 memoryCitations 一次）。 */
export function citationCount(ctx: HubContext, memoryId: string): number {
  return memoryCitations(ctx).get(memoryId) ?? 0;
}

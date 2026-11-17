/**
 * UiApi upsertRule 写记忆的写法（P75c，方案 7.10「记忆变化」一行；P75r1 起记忆不设开关，任何时候都走这里，唯一例外见下）。
 *
 * 为什么改写：规矩现在统一存在记忆里，写入全部经 service.ts。旧界面的「写下规矩」命令照常可用，
 * 只是新建改为写一条记忆（来源「你写下的规矩」，原文就是规矩本身），带 id 的修改改为更正，归档改为删除。
 * 返回形状不变（仍是 Rule 的样子），旧界面不用改。
 *
 * 例外：输入带 id、这个 id 是旧规矩表里的一行、并且旧规矩表仍要读（迁移未完成）时不走这里，由调用方照旧改那条旧规矩。
 *
 * 取舍（记入进度记录）：编辑时不支持改适用范围（scope），因为记忆的适用范围由「已记住」和记忆页的更正承担；
 * 「提议中」的规矩状态在记忆里没有对应，拒绝写入。
 */
import type { HubContext } from '../engine/context.js';
import { parseInput } from '../engine/validation.js';
import type { Memory } from '../model/memory.js';
import { z } from 'zod';
import { recordId } from '../model/primitives.js';
import { RuleSchema, type Rule } from '../model/team.js';
import { RuleInputSchema } from '../api/schemas.js';
import { MEMORY_DEFAULTS as D } from '../config/defaults.js';
import { correctMemoryText, setMemoryStatus, writeMemory } from './service.js';

/** 本函数的输入：与旧规矩命令相同，只是 id 还可以是记忆编号（新建时返回给界面的就是记忆编号）。 */
const MemoryRuleInputSchema = RuleInputSchema.extend({ id: z.union([RuleSchema.shape.id, recordId('mem')]).optional() });

/** 把一条记忆换成旧界面认识的规矩形状。 */
function asRule(row: Memory): Rule {
  return { id: row.id, scope: row.scope.staff === 'all' ? 'global' : row.scope.staff[0]!, text: row.text, redLine: row.redLine,
    source: 'owner', status: row.status === 'active' ? 'active' : 'archived', createdAt: row.createdAt };
}

/** 按规矩编号或记忆编号找到记忆（迁移来的规矩用旧编号找）。 */
function findMemory(ctx: HubContext, id: string): Memory | null {
  return ctx.store.table('memories').get(id)
    ?? ctx.store.table('memories').list(row => row.source.legacyRuleId === id)[0] ?? null;
}

/** upsertRule 的记忆写法：新建写记忆；带 id 的修改更正；archived 改删除。 */
export async function upsertRuleAsMemory(ctx: HubContext, raw: unknown): Promise<Rule> {
  const value = parseInput(MemoryRuleInputSchema, raw, '规矩');
  if (value.status === 'proposed') throw new Error('status：记忆里没有「提议中」的规矩，请直接写下规矩或不写');
  if (value.scope !== 'global' && !ctx.store.table('bots').get(value.scope)) throw new Error('scope：机器人不存在');
  if (value.id !== undefined) {
    const old = findMemory(ctx, value.id);
    if (old === null) throw new Error('id：规矩不存在');
    let row = old;
    if (value.status === 'archived') row = await setMemoryStatus(ctx, old.id, 'deleted', 'owner');
    else if (old.status === 'active') {
      row = await correctMemoryText(ctx, old.id, value.text, 'owner', '你在规矩里更正', value.redLine === undefined ? {} : { redLine: value.redLine });
    }
    return asRule(row);
  }
  const created = await writeMemory(ctx, { kind: 'rule', text: value.text, example: null, redLine: value.redLine ?? false,
    scope: { staff: value.scope === 'global' ? 'all' : [value.scope], projects: 'all' },
    source: { kind: 'owner_edit', messageIds: [], quote: [...value.text.trim()].slice(0, D.QUOTE_MAX_CHARS).join(''), threadId: null } });
  return asRule(value.status === 'archived' ? await setMemoryStatus(ctx, created.id, 'deleted', 'owner') : created);
}

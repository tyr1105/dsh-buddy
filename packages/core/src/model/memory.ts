/**
 * 记忆模型（P75b，第四块）：关于主人和项目的事实，全队一份；以及升级时一次性迁移的进度记录。
 *
 * 记忆分三种存储类型：偏好、规矩、先例（「项目背景」不存，由记忆页按项目页现算）。
 * 只有主人的原话、主人定了的约定、主人在记忆页的编辑能写入记忆，所以每条都带原话原文（由中心抄出）。
 *
 * 为什么新建一张表而不复用 rules 表：规矩表是 strictObject，加字段会让旧版本整条读不出；迁移期间旧表保持不动，
 * 迁移失败时旧的规矩照常生效（方案 5.6）。
 *
 * 本文件只定义结构与校验，不读时钟、不读存储。上限来自 config/defaults.ts 的 MEMORY_DEFAULTS。
 */
import { z } from 'zod';
import { MEMORY_DEFAULTS as D } from '../config/defaults.js';
import { count, nonempty, recordId, text, timestamp } from './primitives.js';

/** 非空（去首尾空白后仍有内容）且不超过 max 个完整字符。 */
function line(max: number) {
  return nonempty
    .refine(value => value.trim().length > 0, '不能为空')
    .refine(value => [...value].length <= max, `不能超过 ${max} 字`);
}

/** 记忆的类型：偏好、规矩、先例。 */
export const MEMORY_KINDS = ['preference', 'rule', 'precedent'] as const;
/** 记忆的来源：主人原话 / 已固定的约定 / 主人在记忆页的编辑 / 迁移来的旧规矩 / 迁移来的旧教训。 */
export const MEMORY_SOURCE_KINDS = ['owner_words', 'agreement', 'owner_edit', 'legacy_owner_rule', 'legacy_lesson'] as const;
/** 记忆的状态：生效 / 已撤销 / 已删除 / 已被更正后的新说法取代 / 已被主人否掉（P76p，先例才有）。 */
export const MEMORY_STATUSES = ['active', 'undone', 'deleted', 'replaced', 'refuted'] as const;

/** 适用范围里的一项：字面量 all，或非空的 id 数组（空数组没有意义，必须拒绝）。 */
function scopeOf(idPrefix: string, label: string) {
  return z.union([
    z.literal('all'),
    z.array(recordId(idPrefix)).min(1, `${label}：不能是空数组；要适用于全部请写 all`),
  ], { error: `${label}：必须是 all 或非空的 id 数组` });
}

/** 迁移来的两种来源：升级前的主人规矩与教训，正文按旧规矩表原样迁入，不受字数上限限制（P75r2）。 */
export const LEGACY_MEMORY_SOURCE_KINDS: readonly string[] = ['legacy_owner_rule', 'legacy_lesson'];

/** 一条新写入的记忆正文（偏好、规矩）的校验：非空且不超过 TEXT_MAX_CHARS 字；更正文字时用它。 */
export const MemoryTextSchema = line(D.TEXT_MAX_CHARS);

/** 一条记忆。 */
export const MemorySchema = z.strictObject({
  id: recordId('mem'),
  kind: z.enum(MEMORY_KINDS, { error: '类型必须是 preference、rule、precedent 之一' }),
  // 偏好、规矩：总管按主人原话写的一句；先例：中心拼「问题：选定项」。
  // P75r2：这里只要求非空；字数上限放在整行的补充校验里，按来源种类判断（迁移来的旧规矩不限字数）。
  text: nonempty.refine(value => value.trim().length > 0, '不能为空'),
  example: line(D.EXAMPLE_MAX_CHARS).nullable(),
  redLine: z.boolean({ error: '必须是布尔值' }),
  scope: z.strictObject({
    staff: scopeOf('b', 'scope.staff'),
    projects: scopeOf('prj', 'scope.projects'),
  }),
  source: z.strictObject({
    kind: z.enum(MEMORY_SOURCE_KINDS, { error: '来源类型必须是 owner_words、agreement、owner_edit、legacy_owner_rule、legacy_lesson 之一' }),
    messageIds: z.array(nonempty), // 主人原话的消息
    quote: line(D.QUOTE_MAX_CHARS), // 原话原文，中心抄出
    threadId: nonempty.nullable(), // 在哪个对话里说的
    // 以下四项只有特定来源才有（先例才有约定三项；迁移来的才有 legacyRuleId），没有时可省略
    agreementId: recordId('agr').nullable().optional(),
    versionNo: z.number({ error: '必须是整数' }).int('必须是整数').min(1, '不能小于 1').nullable().optional(),
    pendingKey: nonempty.nullable().optional(),
    legacyRuleId: nonempty.nullable().optional(),
  }),
  category: nonempty.nullable(), // 先例的类别
  status: z.enum(MEMORY_STATUSES, { error: '状态必须是 active、undone、deleted、replaced、refuted 之一' }),
  // 更正前的旧说法，最多保留 HISTORY_MAX 条（超出时由服务丢掉最早的）。
  // P75d 在同一版本内扩展：action 记这一项是更正还是删除；wakeId、replyMessageId、threadId 记对话里更正、删除是哪个回合、
  // 挂在哪条回复下面、在哪个对话里；undone 记这一次更正或删除是否已被撤销。新增的几项都有默认值，P75c 写下的旧行照常能读。
  // P75r1 再扩展 messageIds、quote：对话里更正、删除时主人那句话的消息编号和原文。
  history: z.array(z.strictObject({
    text,
    at: timestamp,
    by: z.enum(['owner', 'chief', 'hub'], { error: '更正人必须是 owner、chief、hub 之一' }),
    note: text,
    action: z.enum(['corrected', 'deleted', 'refuted'], { error: 'action 必须是 corrected、deleted、refuted 之一' }).default('corrected'),
    wakeId: nonempty.nullable().default(null),
    replyMessageId: nonempty.nullable().default(null),
    threadId: nonempty.nullable().default(null),
    undone: z.boolean({ error: '必须是布尔值' }).default(false),
    // P75r1：对话里更正、删除时，记下是主人哪句话让它被改的（由中心从消息里抄，不经模型）；记忆页上主人自己点的更正、删除留空。
    // 都有默认值，P75d 及以前写下的旧行（没有这两项）照常能读。
    messageIds: z.array(nonempty).default([]),
    quote: z.string({ error: '必须是文字' }).refine(value => [...value].length <= D.QUOTE_MAX_CHARS, `不能超过 ${D.QUOTE_MAX_CHARS} 字`).default(''),
  }), { error: 'history：必须是数组' }).max(D.HISTORY_MAX, `最多保留 ${D.HISTORY_MAX} 条`),
  noteWakeId: nonempty.nullable(), // 「已记住」是哪个回合记下的
  replyMessageId: nonempty.nullable(), // 「已记住」挂在哪条回复下面
  createdAt: timestamp,
  updatedAt: timestamp,
  endedAt: timestamp.nullable(),
}).superRefine((row, ctx) => {
  // 整行的补充校验：除迁移来的旧规矩、旧教训外，正文不能超过 TEXT_MAX_CHARS 字（错误落在 text 字段上）。
  if (!LEGACY_MEMORY_SOURCE_KINDS.includes(row.source.kind) && [...row.text].length > D.TEXT_MAX_CHARS) {
    ctx.addIssue({ code: 'custom', path: ['text'], message: `不能超过 ${D.TEXT_MAX_CHARS} 字` });
  }
});
export type Memory = z.infer<typeof MemorySchema>;

/** 迁移进度的状态：写入中 / 失败 / 完成。 */
export const MIGRATION_STATES = ['writing', 'failed', 'done'] as const;

/**
 * 升级时一次性迁移的进度记录（P75f 用，P75b 只定义表和结构）。
 * written 记下已经写进各张新表的行 id，失败时按它删掉；steps 记下第三段各步骤的完成标记，下次启动接着做。
 */
export const MigrationSchema = z.strictObject({
  id: nonempty,
  state: z.enum(MIGRATION_STATES, { error: '迁移状态必须是 writing、failed、done 之一' }),
  attempts: count,
  written: z.record(z.string(), z.array(nonempty), { error: 'written：必须是「表名到 id 数组」的对象' }),
  steps: z.record(z.string(), z.boolean({ error: '必须是布尔值' }), { error: 'steps：必须是「步骤名到是否完成」的对象' }),
  error: nonempty.nullable(),
  // P75r2：完成时记下没能整理进技能库的条数（套路条数、教训条数、长期记忆的员工数）；旧记录没有这一项。
  skipped: z.strictObject({ routines: count, lessons: count, memoryFiles: count }).optional(),
  updatedAt: timestamp,
});
export type Migration = z.infer<typeof MigrationSchema>;

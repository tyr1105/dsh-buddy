/**
 * 记忆页的视图（P75d，方案 7.5，设计稿 E「关于你的记忆」）：全队共用的一份记忆，按四类列出，供 P75k 画页面。
 *
 * 为什么拆成纯函数和读存储两层：buildMemoryPage 只吃显式给出的数据（记忆行、项目、标题表、名字表、被引用次数、now、时区），
 * 不碰存储和时钟，插件的样例和测试可以直接调用；memoryPageView 只负责把存储里的数据收集起来再交给它。
 *
 * 四类与顺序（与设计稿 E 一致）：规矩（固定规则排在最后）、决定和先例（先例之后是项目页的决策）、偏好、项目背景。
 * 「项目背景」不存表，按项目页现算：每个未归档、背景不为空的项目一条，正文是背景第一句。
 * 已撤销、已取代的不显示；已删除的只在 deleted 列表里出现 24 小时。
 * 文字里不出现任何编号和工具名（memoryId 只给界面当按钮参数用）。
 */
import { z } from 'zod';
import { MEMORY_DEFAULTS as D } from '../config/defaults.js';
import type { HubContext } from '../engine/context.js';
import type { Memory } from '../model/memory.js';
import { memoryCitations } from '../memory/memory-read.js';
import { localParts } from '../util/time.js';
import { memoryScopeLine, quoteLineOf } from './memory-text.js';

const TAB_KEYS = ['all', 'preference', 'rule', 'precedent', 'background'] as const;
const GROUP_KEYS = ['rule', 'precedent', 'preference', 'background'] as const;
export type MemoryTabKey = (typeof TAB_KEYS)[number];

export const MemoryEntryViewSchema = z.strictObject({
  memoryId: z.string().nullable(),
  text: z.string(),
  sourceLine: z.string(),
  scopeLine: z.string().nullable(),
  /** P75r1：来源是主人原话的规矩、偏好为「你说：「{原话前 40 个字}」」，其余为 null（先例、迁移来的规矩、主人在记忆页写的、固定规则、项目页内容）。 */
  quoteLine: z.string().nullable(),
  citedText: z.string().nullable(),
  actions: z.strictObject({ correct: z.boolean(), delete: z.boolean() }),
  readonlyNote: z.string().nullable(),
  historyNote: z.string().nullable(),
  link: z.strictObject({ kind: z.literal('project'), projectId: z.string() }).nullable(),
});
export type MemoryEntryView = z.infer<typeof MemoryEntryViewSchema>;

export const MemoryPageViewSchema = z.strictObject({
  title: z.literal('关于你的记忆'),
  intro: z.literal('全队共用这一份。员工只能读，不能自己改；只有你的原话、你定了的约定和项目页会写进来。'),
  total: z.number().int(),
  tabs: z.array(z.strictObject({
    key: z.enum(TAB_KEYS),
    label: z.enum(['全部', '偏好', '规矩', '决定和先例', '项目背景']),
    count: z.number().int(),
  })),
  groups: z.array(z.strictObject({ key: z.enum(GROUP_KEYS), label: z.string(), entries: z.array(MemoryEntryViewSchema) })),
  deleted: z.array(z.strictObject({ memoryId: z.string(), text: z.string(), canUndo: z.boolean() })),
});
export type MemoryPageView = z.infer<typeof MemoryPageViewSchema>;

/** 纯函数的输入：记忆页需要的全部数据。 */
export interface MemoryPageInput {
  memories: readonly Memory[];
  projects: ReadonlyArray<{ id: string; name: string; background: string; decisions: ReadonlyArray<{ text: string; at: number }> }>;
  agreementTitles: ReadonlyMap<string, string>;
  /** 员工名字表（也用来认出「总管私聊」：对话编号是员工编号）。 */
  botNames: ReadonlyMap<string, string>;
  /** 主题标题表。 */
  topicTitles: ReadonlyMap<string, string>;
  projectNames: ReadonlyMap<string, string>;
  citations: ReadonlyMap<string, number>;
  now: number;
  timezone: string;
}

/** 「M月D日」。 */
function dateText(at: number, timezone: string): string {
  const parts = localParts(at, timezone);
  return `${parts.month}月${parts.day}日`;
}

/** 去掉句末的句号。 */
function bare(text: string): string {
  return text.trim().replace(/[。.]+$/u, '');
}

/** 出处一行（六种写法，见任务卡第 9 节）。 */
function sourceLineOf(row: Memory, input: MemoryPageInput): string {
  const date = dateText(row.createdAt, input.timezone);
  switch (row.source.kind) {
    case 'owner_words': {
      const thread = row.source.threadId;
      if (thread !== null && input.botNames.has(thread)) return `你在总管私聊里说的，${date}`;
      return `你在「${(thread === null ? undefined : input.topicTitles.get(thread)) ?? '已删除的主题'}」里说的，${date}`;
    }
    case 'owner_edit':
    case 'legacy_owner_rule': return `你写下的规矩，${date}`;
    case 'legacy_lesson': return `你批准的提议，${date}`;
    case 'agreement': {
      const title = input.agreementTitles.get(row.source.agreementId ?? '') ?? '已删除的约定';
      return `先例：${title}约定第 ${row.source.versionNo ?? 1} 版，你于 ${date} 定了`;
    }
  }
}

/** 一条记忆的一行视图。范围一行与「已记住」一行用同一个函数（memory-text.ts）。 */
function entryOf(row: Memory, input: MemoryPageInput): MemoryEntryView {
  const cited = input.citations.get(row.id) ?? 0;
  const lastCorrection = row.history.filter(item => item.action === 'corrected' && !item.undone).at(-1);
  // P75r1：最近一次未撤销的更正记下了主人原话时，写「原为「旧」。你说：「原话」」；没有原话（记忆页上主人自己改的、旧形状）只写「原为「旧」。」。
  const correctionQuote = lastCorrection === undefined ? null : quoteLineOf(lastCorrection.quote);
  return {
    memoryId: row.id, text: row.text, sourceLine: sourceLineOf(row, input),
    scopeLine: row.kind === 'precedent' ? null : memoryScopeLine(row, input.botNames, input.projectNames),
    // P75r7（A6）：有生效的更正时不显示「你说」原话（它是旧说法，与新正文并列会被读成主人说过新正文；原话已在「原为」里）；没有更正时照旧。
    quoteLine: row.source.kind === 'owner_words' && lastCorrection === undefined ? quoteLineOf(row.source.quote) : null,
    citedText: cited > 0 ? `被引用 ${cited} 次` : null,
    actions: { correct: true, delete: true }, readonlyNote: null,
    historyNote: lastCorrection === undefined ? null : `原为「${bare(lastCorrection.text)}」。${correctionQuote ?? ''}`,
    link: null,
  };
}

/** 生成记忆页视图（纯函数）。 */
export function buildMemoryPage(input: MemoryPageInput): MemoryPageView {
  const live = input.memories.filter(row => row.status === 'active');
  const byKind = (kind: Memory['kind']): Memory[] => live.filter(row => row.kind === kind).sort((a, b) => b.createdAt - a.createdAt);
  const fixed: MemoryEntryView[] = D.FIXED_RULES.map(text => ({ memoryId: null, text, sourceLine: '产品固定规则', scopeLine: null, quoteLine: null, citedText: null,
    actions: { correct: false, delete: false }, readonlyNote: '不能更正或删除', historyNote: null, link: null }));
  const rules = [...byKind('rule').map(row => entryOf(row, input)), ...fixed];
  const precedents = byKind('precedent').map(row => entryOf(row, input));
  // 项目页的决策：放在「决定和先例」里、先例之后；来自未归档的项目。
  const open = input.projects;
  const decisions: MemoryEntryView[] = open.flatMap(project => project.decisions.map(item => ({ project, item })))
    .sort((a, b) => b.item.at - a.item.at)
    .map(({ project, item }) => ({ memoryId: null, text: item.text, sourceLine: `来自「${project.name}」的项目页`, scopeLine: null, quoteLine: null, citedText: null,
      actions: { correct: false, delete: false }, readonlyNote: null, historyNote: null, link: { kind: 'project' as const, projectId: project.id } }));
  const preferences = byKind('preference').map(row => entryOf(row, input));
  const backgrounds: MemoryEntryView[] = open.filter(project => project.background.trim() !== '').map(project => ({
    memoryId: null, text: [...project.background.trim().split(/[。.]/u)[0]!.trim()].slice(0, 80).join(''), sourceLine: `来自「${project.name}」的项目页`,
    scopeLine: null, quoteLine: null, citedText: null, actions: { correct: false, delete: false }, readonlyNote: '在项目页里修改', historyNote: null,
    link: { kind: 'project' as const, projectId: project.id } }));
  const groups = [
    { key: 'rule' as const, label: '规矩', entries: rules },
    { key: 'precedent' as const, label: '决定和先例', entries: [...precedents, ...decisions] },
    { key: 'preference' as const, label: '偏好', entries: preferences },
    { key: 'background' as const, label: '项目背景', entries: backgrounds },
  ];
  const total = groups.reduce((sum, group) => sum + group.entries.length, 0);
  const count = (key: (typeof GROUP_KEYS)[number]): number => groups.find(group => group.key === key)!.entries.length;
  const deleted = input.memories.filter(row => row.status === 'deleted' && row.endedAt !== null && input.now - row.endedAt <= D.DELETE_UNDO_MS)
    .sort((a, b) => b.endedAt! - a.endedAt!)
    .map(row => ({ memoryId: row.id, text: `已删除「${bare(row.text)}」。`, canUndo: true }));
  return {
    title: '关于你的记忆', intro: '全队共用这一份。员工只能读，不能自己改；只有你的原话、你定了的约定和项目页会写进来。',
    total,
    tabs: [
      { key: 'all', label: '全部', count: total }, { key: 'preference', label: '偏好', count: count('preference') },
      { key: 'rule', label: '规矩', count: count('rule') }, { key: 'precedent', label: '决定和先例', count: count('precedent') },
      { key: 'background', label: '项目背景', count: count('background') },
    ],
    groups, deleted,
  };
}

/** 读存储版：收集数据交给纯函数。 */
export function memoryPageView(ctx: HubContext): MemoryPageView {
  const projects = ctx.store.table('projects').list(row => row.archivedAt === null && row.status !== 'archived');
  return buildMemoryPage({
    memories: ctx.store.table('memories').list(),
    projects: projects.map(p => ({ id: p.id, name: p.name, background: p.context.background, decisions: p.context.decisions.map(d => ({ text: d.text, at: d.at })) })),
    agreementTitles: new Map(ctx.store.table('agreements').list().map(row => [row.id, row.title])),
    botNames: new Map(ctx.store.table('bots').list().map(row => [row.id, row.name])),
    topicTitles: new Map(ctx.store.table('projectTopics').list().map(row => [row.id, row.title])),
    projectNames: new Map(ctx.store.table('projects').list().map(row => [row.id, row.name])),
    citations: memoryCitations(ctx), now: ctx.clock.now(), timezone: ctx.settings.timezone,
  });
}

/** 总览里给左栏与总管右侧栏用的条数：与记忆页的 total 相同。 */
export function memoryCount(ctx: HubContext): number {
  return memoryPageView(ctx).total;
}

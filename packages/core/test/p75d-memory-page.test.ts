/**
 * P75d 的测试（四）：记忆页视图（纯函数 buildMemoryPage 与读存储的 memoryPageView）。
 * 覆盖：四类与计数（含固定规则、项目背景）、出处一行六种写法、范围一行三种、被引用次数、固定规则不可操作、
 * 删除后 24 小时内出现在已删除列表、文字不含内部编号和工具名、纯函数与读存储版本结果一致、视图通过导出的 schema。
 */
import { describe, expect, it } from 'vitest';
import { MemoryPageViewSchema, buildMemoryPage, memoryPageView, type MemoryPageInput } from '../src/api/index.js';
import { MEMORY_DEFAULTS } from '../src/config/defaults.js';
import type { HubContext } from '../src/engine/context.js';
import { correctMemoryText, setMemoryStatus, writeMemory } from '../src/memory/service.js';
import { localParts } from '../src/util/time.js';
import { chiefDraftsAnother } from './p74b-fixtures.js';
import { jobFix, memoriesOf, ownerSays, speak, type JobFix } from './p75c-fixtures.js';

/** 总管起草一份约定并交账（待确认）：同时建出项目和主题。 */
async function draft(fix: JobFix, title: string): Promise<string> {
  await ownerSays(fix, fix.chief.id, `帮我做${title}`);
  const id = await chiefDraftsAnother(fix, title, { category: '表单页' });
  await speak(fix, fix.chief, '这件事有 2 项需要你定。确认前不会开工。', { outcome: 'needs_owner' });
  return id;
}

/** 与 memoryPageView 收集数据的口径一致的输入（测试里独立再写一遍，用来核对两个版本结果相同）。 */
function inputOf(ctx: HubContext, citations: Map<string, number> = new Map()): MemoryPageInput {
  const open = ctx.store.table('projects').list(row => row.archivedAt === null && row.status !== 'archived');
  return {
    memories: ctx.store.table('memories').list(),
    projects: open.map(p => ({ id: p.id, name: p.name, background: p.context.background, decisions: p.context.decisions.map(d => ({ text: d.text, at: d.at })) })),
    agreementTitles: new Map(ctx.store.table('agreements').list().map(row => [row.id, row.title])),
    botNames: new Map(ctx.store.table('bots').list().map(row => [row.id, row.name])),
    topicTitles: new Map(ctx.store.table('projectTopics').list().map(row => [row.id, row.title])),
    projectNames: new Map(ctx.store.table('projects').list().map(row => [row.id, row.name])),
    citations, now: ctx.clock.now(), timezone: ctx.settings.timezone,
  };
}

/** 搭一个有项目、主题、约定、背景、决策的环境，并写入各种来源和范围的记忆。 */
async function setup() {
  const fix = await jobFix();
  const agreementId = await draft(fix, '报价页');
  const agreement = fix.ctx.store.table('agreements').get(agreementId)!;
  const project = fix.ctx.store.table('projects').get(agreement.projectId)!;
  fix.ctx.store.table('projects').patch(project.id, { context: { background: '这是给运营用的报价项目。后面还有别的话。', conventions: '',
    decisions: [{ id: 'dc_0000000001', text: '周报每周五发', by: 'owner', at: fix.ctx.clock.now() }], glossary: [] } });
  const base = { example: null, redLine: false, scope: { staff: 'all' as const, projects: 'all' as const } };
  const words = (threadId: string) => ({ kind: 'owner_words' as const, messageIds: [], quote: '以后都这样', threadId });
  const r1 = await writeMemory(fix.ctx, { ...base, kind: 'rule', text: '规矩一', example: '例子', scope: { staff: [fix.engineer.id], projects: [project.id] }, source: words(fix.chief.id) });
  const r2 = await writeMemory(fix.ctx, { ...base, kind: 'rule', text: '规矩二', example: '例子', source: words(agreement.topicId) });
  const r3 = await writeMemory(fix.ctx, { ...base, kind: 'rule', text: '规矩三', example: '例子', source: { kind: 'owner_edit', messageIds: [], quote: '规矩三', threadId: null } });
  const r4 = await writeMemory(fix.ctx, { ...base, kind: 'rule', text: '规矩四', example: '例子', source: { kind: 'legacy_owner_rule', messageIds: [], quote: '规矩四', threadId: null, legacyRuleId: 'ru_0000000001' } });
  const p1 = await writeMemory(fix.ctx, { ...base, kind: 'preference', text: '偏好一', scope: { staff: 'all', projects: [project.id] },
    source: { kind: 'legacy_lesson', messageIds: [], quote: '偏好一', threadId: null, legacyRuleId: 'ru_0000000002' } });
  const pr = await writeMemory(fix.ctx, { ...base, kind: 'precedent', text: '问题：选项', category: '表单页', refresh: false,
    source: { kind: 'agreement', messageIds: [], quote: '问题：选项', threadId: null, agreementId, versionNo: 2, pendingKey: 'k' } });
  return { fix, agreement, project, r1, r2, r3, r4, p1, pr };
}

describe('记忆页视图', () => {
  it('四类与计数：规矩（含 4 条固定规则）、决定和先例（先例加项目页决策）、偏好、项目背景；总条数与总览的 memoryCount 一致', async () => {
    const { fix } = await setup();
    const view = memoryPageView(fix.ctx);
    expect(view.groups.map(group => group.key)).toEqual(['rule', 'precedent', 'preference', 'background']);
    expect(view.groups.map(group => group.entries.length)).toEqual([4 + MEMORY_DEFAULTS.FIXED_RULES.length, 2, 1, 1]);
    expect(view.total).toBe(8 + 2 + 1 + 1);
    expect(view.tabs).toEqual([
      { key: 'all', label: '全部', count: 12 }, { key: 'preference', label: '偏好', count: 1 }, { key: 'rule', label: '规矩', count: 8 },
      { key: 'precedent', label: '决定和先例', count: 2 }, { key: 'background', label: '项目背景', count: 1 },
    ]);
    expect(view.title).toBe('关于你的记忆');
    expect(view.intro).toBe('全队共用这一份。员工只能读，不能自己改；只有你的原话、你定了的约定和项目页会写进来。');
    expect(fix.hub.api.overview().memoryCount).toBe(12);
    // 先例在前、项目页决策在后；项目背景取第一句。
    const [precedent, decision] = view.groups[1]!.entries;
    expect(precedent!.memoryId).not.toBeNull();
    expect(decision).toMatchObject({ memoryId: null, text: '周报每周五发', sourceLine: '来自「报价页」的项目页' });
    expect(view.groups[3]!.entries[0]).toMatchObject({ memoryId: null, text: '这是给运营用的报价项目', readonlyNote: '在项目页里修改', link: { kind: 'project' } });
    expect(decision!.link).toMatchObject({ kind: 'project' });
  });

  it('出处一行六种写法与范围一行三种', async () => {
    const { fix, r1, r2, r3, r4, p1, pr } = await setup();
    const view = memoryPageView(fix.ctx);
    const find = (id: string) => view.groups.flatMap(group => group.entries).find(entry => entry.memoryId === id)!;
    const date = (at: number) => { const p = localParts(at, fix.ctx.settings.timezone); return `${p.month}月${p.day}日`; };
    expect(find(r1.id).sourceLine).toBe(`你在总管私聊里说的，${date(r1.createdAt)}`);
    expect(find(r2.id).sourceLine).toBe(`你在「报价页」里说的，${date(r2.createdAt)}`);
    expect(find(r3.id).sourceLine).toBe(`你写下的规矩，${date(r3.createdAt)}`);
    expect(find(r4.id).sourceLine).toBe(`你写下的规矩，${date(r4.createdAt)}`);
    expect(find(p1.id).sourceLine).toBe(`你批准的提议，${date(p1.createdAt)}`);
    expect(find(pr.id).sourceLine).toBe(`先例：报价页约定第 2 版，你于 ${date(pr.createdAt)} 定了`);
    const fixed = view.groups[0]!.entries.at(-1)!;
    expect(fixed.sourceLine).toBe('产品固定规则');
    // 范围一行：员工有名单且项目有名单、全部员工且全部项目、全部员工但项目有名单；先例没有范围。
    expect(find(r1.id).scopeLine).toBe('用于林舟，仅用于报价页');
    expect(find(r2.id).scopeLine).toBe('用于全部员工、全部项目');
    expect(find(p1.id).scopeLine).toBe('用于全部员工，仅用于报价页');
    expect(find(pr.id).scopeLine).toBeNull();
    expect(fixed.scopeLine).toBeNull();
  });

  it('被引用 0 次为 null、2 次为「被引用 2 次」；固定规则不可操作；更正后写「原为……」', async () => {
    const { fix, r1, r2 } = await setup();
    await correctMemoryText(fix.ctx, r1.id, '规矩一（改）', 'owner', '你在记忆页更正');
    const view = buildMemoryPage(inputOf(fix.ctx, new Map([[r1.id, 2]])));
    const find = (id: string) => view.groups.flatMap(group => group.entries).find(entry => entry.memoryId === id)!;
    expect(find(r1.id)).toMatchObject({ citedText: '被引用 2 次', historyNote: '原为「规矩一」。', text: '规矩一（改）', actions: { correct: true, delete: true }, readonlyNote: null });
    expect(find(r2.id)).toMatchObject({ citedText: null, historyNote: null });
    const fixed = view.groups[0]!.entries.slice(-MEMORY_DEFAULTS.FIXED_RULES.length);
    expect(fixed.map(entry => entry.text)).toEqual([...MEMORY_DEFAULTS.FIXED_RULES]);
    for (const entry of fixed) expect(entry).toMatchObject({ memoryId: null, actions: { correct: false, delete: false }, readonlyNote: '不能更正或删除' });
  });

  it('P75r7（A6）：有生效的更正时不显示「你说」原话，没有更正时照旧显示；A5：固定规则说明行不再重复出处', async () => {
    const { fix, r1, r2 } = await setup();
    await correctMemoryText(fix.ctx, r1.id, '规矩一（改）', 'owner', '你在记忆页更正');
    const view = buildMemoryPage(inputOf(fix.ctx));
    const find = (id: string) => view.groups.flatMap(group => group.entries).find(entry => entry.memoryId === id)!;
    // 更正过的这条：有「原为」，没有「你说」；没更正的那条：仍有「你说」。
    expect(find(r1.id).historyNote).not.toBeNull();
    expect(find(r1.id).quoteLine).toBeNull();
    expect(find(r2.id).historyNote).toBeNull();
    expect(find(r2.id).quoteLine).toBe('你说：「以后都这样」');
    // 固定规则：出处行写「产品固定规则」，说明行只写「不能更正或删除」，两行不重复。
    const fixed = view.groups[0]!.entries.slice(-MEMORY_DEFAULTS.FIXED_RULES.length);
    for (const entry of fixed) {
      expect(entry.sourceLine).toBe('产品固定规则');
      expect(entry.readonlyNote).toBe('不能更正或删除');
    }
  });

  it('删除后 24 小时内在已删除列表，之后消失；已撤销、已取代的不显示', async () => {
    const { fix, r1, r2, r3, pr } = await setup();
    await setMemoryStatus(fix.ctx, r1.id, 'deleted', 'owner');
    await setMemoryStatus(fix.ctx, r2.id, 'undone', 'owner');
    await setMemoryStatus(fix.ctx, pr.id, 'replaced', 'hub');
    const endedAt = fix.ctx.store.table('memories').get(r1.id)!.endedAt!;
    const view = memoryPageView(fix.ctx);
    expect(view.deleted).toEqual([{ memoryId: r1.id, text: '已删除「规矩一」。', canUndo: true }]);
    const shown = view.groups.flatMap(group => group.entries).map(entry => entry.memoryId);
    expect(shown).toContain(r3.id);
    expect(shown).not.toContain(r1.id);
    expect(shown).not.toContain(r2.id);
    expect(shown).not.toContain(pr.id);
    // 过了 24 小时：纯函数用显式 now，不必推进时钟。
    const later = buildMemoryPage({ ...inputOf(fix.ctx), now: endedAt + MEMORY_DEFAULTS.DELETE_UNDO_MS + 1 });
    expect(later.deleted).toEqual([]);
    expect(buildMemoryPage({ ...inputOf(fix.ctx), now: endedAt + MEMORY_DEFAULTS.DELETE_UNDO_MS }).deleted).toHaveLength(1);
  });

  it('文字不含任何编号和工具名；纯函数与读存储版本结果相同；视图通过导出的 schema', async () => {
    const { fix } = await setup();
    const view = memoryPageView(fix.ctx);
    expect(MemoryPageViewSchema.safeParse(view).success).toBe(true);
    expect(buildMemoryPage(inputOf(fix.ctx))).toEqual(view);
    const texts = [view.title, view.intro, ...view.tabs.map(tab => tab.label), ...view.groups.flatMap(group => [group.label,
      ...group.entries.flatMap(entry => [entry.text, entry.sourceLine, entry.scopeLine, entry.citedText, entry.readonlyNote, entry.historyNote])]),
    ...view.deleted.map(item => item.text)].filter((item): item is string => item !== null);
    for (const text of texts) expect(text).not.toMatch(/mem_|\bb_[0-9a-z]{10}|hub_|prj_|agr_/);
    // UiApi 读取入口与存储版一致。
    expect(fix.hub.api.memoryPage()).toEqual(view);
    expect(memoriesOf(fix.ctx).length).toBeGreaterThan(0);
  });
});

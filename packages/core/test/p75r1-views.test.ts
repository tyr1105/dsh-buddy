/**
 * P75r1 第 5 节的测试：「已记住」一行和记忆页带上主人的原话（quoteLine）与适用范围（scopeLine）。
 *
 * 对应审查记录 M2：原来「已记住」一行只显示总管写的文字和类型，主人当场看不到原话和范围，无从核对总管记下的内容。
 * 两处的范围一行由同一个函数生成（api/memory-text.ts）；原话压成一行后取前 40 个字，超出加「…」，恰好 40 个字不加。
 */
import { describe, expect, it } from 'vitest';
import { memoryPageView } from '../src/api/index.js';
import { memoryScopeLine, quoteLineOf } from '../src/api/memory-text.js';
import { writeMemory } from '../src/memory/service.js';
import { jobFix, memoriesOf, noted, type JobFix } from './p75c-fixtures.js';

/** 主人说 ownerText、总管记下并回复；返回这条「已记住」一行的原话行、范围行，以及记忆页上同一条的原话行、范围行。 */
async function viewsOf(fix: JobFix, ownerText: string, extra: Record<string, unknown> = {}) {
  const { memory, reply } = await noted(fix, ownerText, extra);
  const note = fix.hub.api.thread(fix.chief.id).messages.find(row => row.id === reply.id)!.memoryNotes![0]!;
  const entry = memoryPageView(fix.ctx).groups.flatMap(group => group.entries).find(row => row.memoryId === memory.id)!;
  return { memory, note, entry };
}

describe('主人原话一行：前 40 个字、压成一行', () => {
  it('超过 40 个字：只取前 40 个字，末尾加「…」', async () => {
    const fix = await jobFix();
    const text = `以后${'提示文字都用请字开头'.repeat(5)}`; // 2 + 50 = 52 个字
    const { note, entry } = await viewsOf(fix, text);
    const expected = `你说：「${[...text].slice(0, 40).join('')}…」`;
    expect(note.quoteLine).toBe(expected);
    expect(entry.quoteLine).toBe(expected);
  });

  it('恰好 40 个字：原样，不加「…」', async () => {
    const fix = await jobFix();
    const text = `以后${'字'.repeat(38)}`; // 恰好 40 个字
    expect([...text]).toHaveLength(40);
    const { note, entry } = await viewsOf(fix, text);
    expect(note.quoteLine).toBe(`你说：「${text}」`);
    expect(entry.quoteLine).toBe(`你说：「${text}」`);
  });

  it('多行：压成一行（换行变成空格）', async () => {
    const fix = await jobFix();
    const { note, entry } = await viewsOf(fix, '以后提示都用请字开头\n按钮都用圆角');
    expect(note.quoteLine).toBe('你说：「以后提示都用请字开头 按钮都用圆角」');
    expect(entry.quoteLine).toBe('你说：「以后提示都用请字开头 按钮都用圆角」');
  });

  it('纯函数：空原话返回 null；41 个字加「…」，40 个字不加', () => {
    expect(quoteLineOf('  \n ')).toBeNull();
    expect(quoteLineOf('字'.repeat(40))).toBe(`你说：「${'字'.repeat(40)}」`);
    expect(quoteLineOf('字'.repeat(41))).toBe(`你说：「${'字'.repeat(40)}…」`);
  });
});

describe('适用范围一行：三种形状，两处写法完全相同', () => {
  it('全部员工全部项目、某位员工、某位员工加某个项目', async () => {
    const shapes: Array<{ extra: Record<string, unknown>; line: string }> = [
      { extra: {}, line: '用于全部员工、全部项目' },
      { extra: { staff: '林舟' }, line: '用于林舟' },
      { extra: { staff: '林舟', projects: '季度战役' }, line: '用于林舟，仅用于季度战役' },
    ];
    for (const shape of shapes) {
      const fix = await jobFix();
      const { note, entry } = await viewsOf(fix, '以后提示文字都用「请」字开头', shape.extra);
      expect(note.scopeLine, shape.line).toBe(shape.line);
      expect(entry.scopeLine, shape.line).toBe(shape.line);
    }
  });

  it('员工或项目已不存在时写「已离队的员工」「已删除的项目」（同一个函数）', () => {
    const scope = { staff: ['b_zzzzzzzzzz'], projects: ['prj_zzzzzzzzzz'] };
    expect(memoryScopeLine({ scope }, new Map(), new Map())).toBe('用于已离队的员工，仅用于已删除的项目');
  });
});

describe('先例、迁移来的规矩、主人在记忆页写的：记忆页的 quoteLine 为 null', () => {
  it('来源不是主人原话的，quoteLine 都是 null；固定规则、项目页内容也是 null', async () => {
    const fix = await jobFix();
    const base = { example: null, redLine: false, scope: { staff: 'all' as const, projects: 'all' as const } };
    await writeMemory(fix.ctx, { ...base, kind: 'precedent', text: '问题：选项', category: '表单页', refresh: false,
      source: { kind: 'agreement', messageIds: [], quote: '问题：选项', threadId: null, agreementId: 'agr_0000000001', versionNo: 1, pendingKey: 'k' } });
    await writeMemory(fix.ctx, { ...base, kind: 'rule', text: '迁移来的规矩', example: '例子',
      source: { kind: 'legacy_owner_rule', messageIds: [], quote: '迁移来的规矩', threadId: null, legacyRuleId: 'ru_0000000001' } });
    await writeMemory(fix.ctx, { ...base, kind: 'rule', text: '记忆页写的规矩', example: '例子',
      source: { kind: 'owner_edit', messageIds: [], quote: '记忆页写的规矩', threadId: null } });
    expect(memoriesOf(fix.ctx)).toHaveLength(3);
    const entries = memoryPageView(fix.ctx).groups.flatMap(group => group.entries);
    expect(entries.length).toBeGreaterThanOrEqual(3 + 4); // 三条记忆加四条固定规则
    for (const entry of entries) expect(entry.quoteLine, entry.text).toBeNull();
  });
});

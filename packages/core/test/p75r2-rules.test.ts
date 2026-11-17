/**
 * P75r2 第 1 节：旧规矩迁成记忆，正文原样迁入（不限字数、允许换行）；红线在身份文件里一字不缺。
 * 夹具与真实情况一致（见 p75r2-fixtures.ts）；每条规则一个正例一个反例。
 */
import { posix } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runP75Migration } from '../src/migrate/p75-storage.js';
import { legacyQuote } from '../src/migrate/p75-plan.js';
import { renderBotAgentsMd, renderRootAgentsMd } from '../src/memory/render.js';
import { writeMemory } from '../src/memory/service.js';
import { MemorySchema } from '../src/model/memory.js';
import { legacyWorld, putRule, record, ruleId } from './p75r2-fixtures.js';

const OWNER_EDIT = { kind: 'owner_edit' as const, messageIds: [], quote: '手写', threadId: null };

describe('P75r2 第 1 节：旧规矩原样迁入', () => {
  it('一条 5000 字、带换行的主人规矩迁入后，记忆正文与原文逐字相同；quote 取前 300 字、换行换成空格', async () => {
    const { ctx } = await legacyWorld();
    // 100 行，每行 49 个字加一个换行，共 5000 个字符。
    const original = Array.from({ length: 100 }, (_, index) => `${String(index % 10)}${'规'.repeat(48)}\n`).join('');
    expect([...original].length).toBe(5000);
    putRule(ctx, ruleId(1), { text: original, redLine: true, createdAt: 321 });
    await runP75Migration(ctx);
    expect(record(ctx)).toMatchObject({ state: 'done', error: null });
    const rows = ctx.store.table('memories').list();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text).toBe(original);
    expect(rows[0]).toMatchObject({ kind: 'rule', redLine: true, createdAt: 321, status: 'active', scope: { staff: 'all', projects: 'all' } });
    expect(rows[0]!.source).toMatchObject({ kind: 'legacy_owner_rule', legacyRuleId: ruleId(1) });
    const quote = rows[0]!.source.quote;
    expect([...quote].length).toBe(300);
    expect(quote).toBe(original.replace(/\n/g, ' ').slice(0, 300));
    expect(quote.includes('\n')).toBe(false);
    // 旧表一行没动。
    expect(ctx.store.table('rules').get(ruleId(1))!.text).toBe(original);
  });

  it('来源是旧教训（全队）的规矩同样原样迁入；前后空白也不去掉', async () => {
    const { ctx } = await legacyWorld();
    const original = ` 先核实再引用，${'长'.repeat(400)}\n`;
    putRule(ctx, ruleId(2), { text: original, source: 'lesson' });
    await runP75Migration(ctx);
    const row = ctx.store.table('memories').list()[0]!;
    expect(row.source.kind).toBe('legacy_lesson');
    expect(row.text).toBe(original);
  });

  it('quote 的截取：不足 300 字全取，换行换成一个空格（CRLF 算一个换行）', () => {
    expect(legacyQuote('第一行\n第二行')).toBe('第一行 第二行');
    expect(legacyQuote('第一行\r\n第二行')).toBe('第一行 第二行');
    expect(legacyQuote('短')).toBe('短');
    expect([...legacyQuote('字'.repeat(301))].length).toBe(300);
  });

  it('反例：普通来源的记忆超过 120 个字仍被拒（121 字拒、120 字收）', async () => {
    const { ctx } = await legacyWorld();
    const base = { kind: 'rule' as const, example: null, redLine: false, scope: { staff: 'all' as const, projects: 'all' as const }, source: OWNER_EDIT };
    await expect(writeMemory(ctx, { ...base, text: '字'.repeat(121) })).rejects.toThrow(/不能超过 120 字/);
    await expect(writeMemory(ctx, { ...base, text: '字'.repeat(120) })).resolves.toMatchObject({ text: '字'.repeat(120) });
    // 来源是迁移的才放开：同样 121 字，来源 legacy_owner_rule 写得进。
    const legacy = await writeMemory(ctx, { ...base, text: '字'.repeat(121), source: { ...OWNER_EDIT, kind: 'legacy_owner_rule', legacyRuleId: ruleId(9) } });
    expect([...legacy.text].length).toBe(121);
  });

  it('反例：MemorySchema 对普通来源 121 字的报错落在 text 字段，对 legacy 来源不报；空白正文两种来源都拒', () => {
    const row = { id: 'mem_0000000001', kind: 'rule', text: '字'.repeat(121), example: null, redLine: false,
      scope: { staff: 'all', projects: 'all' }, source: { kind: 'owner_words', messageIds: [], quote: '原话', threadId: null }, category: null,
      status: 'active', history: [], noteWakeId: null, replyMessageId: null, createdAt: 1, updatedAt: 1, endedAt: null };
    const bad = MemorySchema.safeParse(row);
    expect(bad.success).toBe(false);
    expect(bad.error!.issues.some(issue => issue.path.join('.') === 'text' && issue.message === '不能超过 120 字')).toBe(true);
    expect(MemorySchema.safeParse({ ...row, source: { ...row.source, kind: 'legacy_lesson' } }).success).toBe(true);
    expect(MemorySchema.safeParse({ ...row, text: '   ', source: { ...row.source, kind: 'legacy_lesson' } }).success).toBe(false);
  });

  it('员工已不存在的规矩：跳过并记审计（其余照迁）', async () => {
    const { ctx, other } = await legacyWorld();
    putRule(ctx, ruleId(3), { scope: 'b_0000000009', text: '已删除员工的规矩' });
    putRule(ctx, ruleId(4), { scope: other.id, text: '评审甲的规矩' });
    await runP75Migration(ctx);
    expect(record(ctx)).toMatchObject({ state: 'done' });
    expect(ctx.store.table('memories').list().map(row => row.text)).toEqual(['评审甲的规矩']);
    const skips = ctx.store.log('audit').all().filter(row => row.action === 'p75_migration_skip');
    expect(skips).toHaveLength(1);
    expect(skips[0]!.detail).toContain(ruleId(3));
  });
});

describe('P75r2 第 1 节：身份文件里红线一字不缺', () => {
  /** 一条 3000 字的红线加 30 条普通规矩（都作用于全队），迁移后渲染。 */
  async function redLineWorld() {
    const { ctx, chiefBot } = await legacyWorld();
    const red = `不得对外泄露报名名单：${'红线细则，'.repeat(590)}到此为止。`;
    expect([...red].length).toBeGreaterThan(2900);
    putRule(ctx, ruleId(1), { text: red, redLine: true, createdAt: 10 });
    for (let index = 0; index < 30; index += 1) putRule(ctx, ruleId(100 + index), { text: `普通规矩 ${index}：${'细'.repeat(30)}`, createdAt: 20 + index });
    await runP75Migration(ctx);
    return { ctx, chiefBot, red };
  }

  it('3000 字红线：个人身份文件与全体守则里都一字不缺，排在这一段最前；普通规矩放不下时写「另有 30 条未列出。」', async () => {
    const { ctx, chiefBot, red } = await redLineWorld();
    for (const md of [renderBotAgentsMd(ctx, chiefBot), renderRootAgentsMd(ctx),
      (await ctx.fs.readText(posix.join(chiefBot.homeDir, 'AGENTS.md')))!, (await ctx.fs.readText('/hub/AGENTS.md'))!]) {
      expect(md).toContain(`- 红线：${red}`);
    }
    const md = renderBotAgentsMd(ctx, chiefBot);
    const section = md.slice(md.indexOf('## 主人的规矩与偏好'));
    expect(section.split('\n')[1]).toBe(`- 红线：${red}`);
    expect(section).toContain('另有 30 条未列出。');
    expect(section).not.toContain('- 规矩：普通规矩 0');
    // 固定部分（交账协议）仍在。
    expect(md).toContain('## 交账协议');
  });

  it('反例：同样长的普通规矩（非红线）仍按整条截断，不受保护', async () => {
    const { ctx, chiefBot } = await legacyWorld();
    const long = `普通长规矩：${'长'.repeat(2000)}`;
    putRule(ctx, ruleId(1), { text: long, redLine: false });
    putRule(ctx, ruleId(2), { text: '短规矩', redLine: false, createdAt: 5 });
    await runP75Migration(ctx);
    const md = renderBotAgentsMd(ctx, chiefBot);
    expect(md).not.toContain(long);
    expect(md).toContain('- 规矩：短规矩');
    expect(md).toContain('另有 1 条未列出。');
  });

  it('红线不超过上限时与原来一致：红线在前、普通规矩接在后面、没有「未列出」', async () => {
    const { ctx, chiefBot } = await legacyWorld();
    putRule(ctx, ruleId(1), { text: '先给主人看', redLine: false, createdAt: 1 });
    putRule(ctx, ruleId(2), { text: '不得删除文件', redLine: true, createdAt: 2 });
    await runP75Migration(ctx);
    const md = renderBotAgentsMd(ctx, chiefBot);
    const section = md.slice(md.indexOf('## 主人的规矩与偏好'));
    expect(section.split('\n').slice(1, 3)).toEqual(['- 红线：不得删除文件', '- 规矩：先给主人看']);
    expect(section).not.toContain('未列出');
  });
});

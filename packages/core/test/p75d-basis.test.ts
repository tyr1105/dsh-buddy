/**
 * P75d 的测试（二）：对齐时引用记忆（规矩、偏好、先例）。
 * 一、只用唤醒包里的文字调用成功（规矩和先例的编号都取自总管唤醒包「可引用的出处」）；
 * 二、resolveBasis 与依据标签；三、约定段的三组出处（顺序、条数、字节上限、记忆不可用时一字不变）。
 */
import { describe, expect, it } from 'vitest';
import { agreementCardView, basisLabelOf, basisLookupOf } from '../src/api/agreement-views.js';
import { MEMORY_DEFAULTS } from '../src/config/defaults.js';
import { flushJobHooks } from '../src/job/agreement-hooks.js';
import { resolveBasis } from '../src/project/agreement-content.js';
import { setMemoryStatus, writeMemory } from '../src/memory/service.js';
import { buildAgreementsBody } from '../src/wake/chief-packet.js';
import { localParts } from '../src/util/time.js';
import type { HubContext } from '../src/engine/context.js';
import type { Memory } from '../src/model/memory.js';
import { chiefDraftsAnother } from './p74b-fixtures.js';
import { bot, callTool, chiefHears, jobFix, noted, ownerSays, speak, type JobFix } from './p75c-fixtures.js';

/** 总管起草一份约定并交账（待确认）。 */
async function draft(fix: JobFix, title: string, category: string): Promise<string> {
  await ownerSays(fix, fix.chief.id, `帮我做${title}`);
  const id = await chiefDraftsAnother(fix, title, { category });
  await speak(fix, fix.chief, '这件事有 2 项需要你定。确认前不会开工。', { outcome: 'needs_owner' });
  return id;
}

/** 起草并让主人说「定了」固定，结束这一回合。 */
async function draftAndLock(fix: JobFix, title: string, category: string): Promise<string> {
  const id = await draft(fix, title, category);
  await ownerSays(fix, fix.chief.id, '定了');
  await flushJobHooks(fix.ctx);
  await speak(fix, fix.chief, '约定已固定。', { outcome: 'progress' });
  return id;
}

/** 直接写一条记忆（规矩、偏好、先例）。 */
async function mem(ctx: HubContext, kind: Memory['kind'], text: string, patch: Partial<Parameters<typeof writeMemory>[1]> = {}): Promise<Memory> {
  return writeMemory(ctx, { kind, text, example: kind === 'rule' ? '例子' : null, redLine: false, scope: { staff: 'all', projects: 'all' },
    source: kind === 'precedent'
      ? { kind: 'agreement', messageIds: [], quote: text, threadId: null, agreementId: 'agr_0000000001', versionNo: 1, pendingKey: 'k' }
      : { kind: 'owner_words', messageIds: [], quote: '以后都这样', threadId: null },
    category: kind === 'precedent' ? '表单页' : null, ...patch });
}

describe('只用唤醒包里的文字调用成功', () => {
  it('规矩和先例的编号取自唤醒包；提交约定成功；约定卡标签和 memoryId 正确', async () => {
    const fix = await jobFix();
    const { memory: rule } = await noted(fix);
    const first = await draftAndLock(fix, '报价页甲', '表单页');
    const packet = await chiefHears(fix, '再做一个报价页，同样的类型');
    // 只用正则从「可引用的出处」里取编号。
    const section = packet.slice(packet.indexOf('可引用的出处（basis.ref 只能写这些编号）：'));
    expect(section).toContain('主人的规矩与偏好：');
    expect(section).toContain('先例（按类别，同类的事先看这里）：');
    const ruleId = /^(mem_[0-9a-z]{10})：页面上的提示文字/m.exec(section)![1]!;
    const precedentId = /^(mem_[0-9a-z]{10})：表单页｜报价从哪里取：公开接口（报价页甲约定第 1 版）/m.exec(section)![1]!;
    expect(ruleId).toBe(rule.id);
    const result = await callTool(fix, fix.chief, 'hub_agreement_submit', {
      title: '报价页乙', summary: '做第二个报价页', category: '表单页',
      sketch: { layout: 'page', screens: [{ title: '报价页', blocks: [{ kind: 'title', text: '每日报价' }] }] },
      pending: [{ key: 'style', question: '页面风格', options: ['简洁', '丰富'], suggested: '简洁', reason: '你没有说' }],
      decided: [
        { text: '提示文字用「请」字开头', basis: { kind: 'source', ref: ruleId } },
        { text: '报价从公开接口取', basis: { kind: 'source', ref: precedentId } },
      ],
      scopeIn: ['报价页'], scopeOut: ['历史曲线'], doneWhen: ['打开页面能看到报价', '点刷新后数据更新', '接口失败时有提示'],
    });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    const second = fix.ctx.store.table('agreements').list().find(row => row.id !== first)!;
    const card = agreementCardView(fix.ctx, second, second.versions[0]!);
    const date = localParts(rule.createdAt, fix.ctx.settings.timezone);
    expect(card.decided.map(row => row.basisLabel)).toEqual([`出处：你的规矩（${date.month}月${date.day}日）`, '出处：先例，报价页甲约定第 1 版']);
    expect(card.decided.map(row => row.memoryId)).toEqual([ruleId, precedentId]);
  });
});

describe('resolveBasis 与依据标签', () => {
  it('mem_ 生效中的通过（refText 取记忆文字）；已删除、不存在的被拒', async () => {
    const fix = await jobFix();
    const rule = await mem(fix.ctx, 'rule', '提示文字用请字开头');
    const out = resolveBasis(fix.ctx, fix.chief.id, [{ text: 'x', basis: { kind: 'source', ref: rule.id } }]);
    expect(out[0]!.basis).toEqual({ kind: 'source', ref: rule.id, refText: '提示文字用请字开头' });
    await setMemoryStatus(fix.ctx, rule.id, 'deleted', 'owner');
    expect(() => resolveBasis(fix.ctx, fix.chief.id, [{ text: 'x', basis: { kind: 'source', ref: rule.id } }])).toThrow(/找不到出处/);
    expect(() => resolveBasis(fix.ctx, fix.chief.id, [{ text: 'x', basis: { kind: 'source', ref: 'mem_zzzzzzzzzz' } }])).toThrow(/找不到出处 mem_zzzzzzzzzz/);
  });

  // P75r1：原来的断言是「迁移没完成时 ru_ 编号仍按旧规矩表解析、ref 不变」；现在只要有对应的生效记忆，不论迁移完成与否，ref 都改写成记忆编号。
  it('旧 ru_ 编号按 legacyRuleId 映射到生效的记忆，ref 被改写；没有对应记忆时迁移未完成按旧规矩，迁移完成后找不到报错', async () => {
    const fix = await jobFix();
    // P75f：中心启动已自动迁移记 done；这里模拟「升级前」，把记录置为未完成。
    fix.ctx.store.table('migrations').put({ id: MEMORY_DEFAULTS.MIGRATION_ID, state: 'failed', attempts: 0, written: {}, steps: {}, error: null, updatedAt: 1 });
    fix.ctx.store.table('rules').put({ id: 'ru_0000000001', scope: 'global', text: '旧规矩', redLine: false, source: 'owner', status: 'active', createdAt: 1 } as never);
    fix.ctx.store.table('rules').put({ id: 'ru_0000000003', scope: 'global', text: '没迁的旧规矩', redLine: false, source: 'owner', status: 'active', createdAt: 1 } as never);
    // 还没有对应记忆、迁移未完成：按旧规矩处理，ref 不变。
    expect(resolveBasis(fix.ctx, fix.chief.id, [{ text: 'x', basis: { kind: 'source', ref: 'ru_0000000001' } }])[0]!.basis.ref).toBe('ru_0000000001');
    const memory = await mem(fix.ctx, 'rule', '旧规矩（已迁移）', { source: { kind: 'legacy_owner_rule', messageIds: [], quote: '旧规矩', threadId: null, legacyRuleId: 'ru_0000000001' } });
    // 有了对应的生效记忆：迁移还没完成也改写成记忆编号；没有对应记忆的那一条仍按旧规矩。
    expect(resolveBasis(fix.ctx, fix.chief.id, [{ text: 'x', basis: { kind: 'source', ref: 'ru_0000000001' } }])[0]!.basis)
      .toEqual({ kind: 'source', ref: memory.id, refText: '旧规矩（已迁移）' });
    expect(resolveBasis(fix.ctx, fix.chief.id, [{ text: 'x', basis: { kind: 'source', ref: 'ru_0000000003' } }])[0]!.basis.ref).toBe('ru_0000000003');
    fix.ctx.store.table('migrations').put({ id: MEMORY_DEFAULTS.MIGRATION_ID, state: 'done', attempts: 1, written: {}, steps: {}, error: null, updatedAt: 1 });
    const mapped = resolveBasis(fix.ctx, fix.chief.id, [{ text: 'x', basis: { kind: 'source', ref: 'ru_0000000001' } }])[0]!.basis;
    expect(mapped).toEqual({ kind: 'source', ref: memory.id, refText: '旧规矩（已迁移）' });
    expect(() => resolveBasis(fix.ctx, fix.chief.id, [{ text: 'x', basis: { kind: 'source', ref: 'ru_0000000002' } }])).toThrow(/找不到出处 ru_0000000002/);
    // 迁移完成后，没有对应记忆的旧规矩不再能被引用。
    expect(() => resolveBasis(fix.ctx, fix.chief.id, [{ text: 'x', basis: { kind: 'source', ref: 'ru_0000000003' } }])).toThrow(/找不到出处 ru_0000000003/);
  });

  it('标签：规矩、偏好、先例三种写法；已删除加「（已删除）」；查不到写出处原文；ru_、dc_、通行做法等写法不变', async () => {
    const fix = await jobFix();
    const rule = await mem(fix.ctx, 'rule', '规矩甲');
    const preference = await mem(fix.ctx, 'preference', '偏好甲');
    const precedent = await mem(fix.ctx, 'precedent', '问题：选项');
    const lookup = basisLookupOf(fix.ctx);
    const date = localParts(rule.createdAt, fix.ctx.settings.timezone);
    const label = (ref: string, text = 'x') => basisLabelOf({ kind: 'source', ref, refText: text }, lookup);
    expect(label(rule.id)).toBe(`出处：你的规矩（${date.month}月${date.day}日）`);
    expect(label(preference.id)).toBe(`出处：你的偏好（${date.month}月${date.day}日）`);
    expect(label(precedent.id)).toBe('出处：先例，已删除的约定约定第 1 版');
    await setMemoryStatus(fix.ctx, rule.id, 'deleted', 'owner');
    expect(basisLabelOf({ kind: 'source', ref: rule.id, refText: 'x' }, basisLookupOf(fix.ctx))).toBe(`出处：你的规矩（${date.month}月${date.day}日）（已删除）`);
    expect(label('mem_zzzzzzzzzz', '原文一句')).toBe('出处：原文一句');
    // 旧写法不变。
    expect(label('ru_0000000001', '老规矩')).toBe('依据：你定过的规矩「老规矩」');
    expect(label('dc_0000000001', '周报每周五发')).toBe('依据：项目决定「周报每周五发」');
    expect(basisLabelOf({ kind: 'convention', ref: null, refText: null })).toBe('依据：通行做法');
    expect(basisLabelOf({ kind: 'trial', ref: null, refText: null })).toBe('依据：需要试过才知道');
    expect(basisLabelOf({ kind: 'judgement', ref: null, refText: null })).toBe('依据：我的判断');
  });
});

describe('约定段的三组出处', () => {
  const entry = { reason: { evidence: [] as string[] } } as never;
  const body = (fix: JobFix) => buildAgreementsBody(fix.ctx, bot(fix, fix.chief.id), entry, fix.ctx.clock.now());

  it('三组顺序：规矩与偏好、先例、（项目页决策）；本回合有待确认约定时它的类别排第一组', async () => {
    const fix = await jobFix();
    await mem(fix.ctx, 'rule', '规矩甲');
    await mem(fix.ctx, 'preference', '偏好甲');
    const a = await draftAndLock(fix, '数据页甲', '数据整理');
    fix.ctx.clock.advance(5 * 60_000);
    const b = await draftAndLock(fix, '表单页乙', '表单页'); // 更晚固定：没有待确认约定时「表单页」组排第一
    expect(a).not.toBe(b);
    let text = body(fix);
    expect(text.indexOf('主人的规矩与偏好：')).toBeGreaterThan(-1);
    expect(text.indexOf('主人的规矩与偏好：')).toBeLessThan(text.indexOf('先例（按类别，同类的事先看这里）：'));
    expect(text.indexOf('｜多久刷新一次：每天（表单页乙')).toBeLessThan(text.indexOf('｜多久刷新一次：每天（数据页甲'));
    await draft(fix, '数据页丙', '数据整理'); // 待确认：类别「数据整理」
    text = body(fix);
    expect(text).toContain('先例（按类别，同类的事先看这里）：\nmem_');
    expect(text.indexOf('数据整理｜多久刷新一次')).toBeLessThan(text.indexOf('表单页｜多久刷新一次'));
  });

  it('合计不超过 16 条；造 30 条先例时整段不超过 3 KB，先截先例，规矩仍在', async () => {
    const fix = await jobFix();
    const rules: Memory[] = [];
    for (let i = 0; i < 10; i += 1) rules.push(await mem(fix.ctx, i % 2 === 0 ? 'rule' : 'preference', `${'规矩'.repeat(30)}${i}`));
    for (let i = 0; i < 30; i += 1) await mem(fix.ctx, 'precedent', `${'问'.repeat(40)}${i}：${'答'.repeat(45)}`, { category: i % 2 === 0 ? '表单页' : '展示页' });
    const text = body(fix);
    const ids = text.match(/^mem_[0-9a-z]{10}/gm)!;
    expect(ids.length).toBeLessThanOrEqual(16);
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(3 * 1024);
    expect(text.match(/^mem_[0-9a-z]{10}：[^｜\n]*$/gm)!.length).toBe(8); // 规矩与偏好最多 8 条，且都在
    expect(text).toContain('类别（category 只能写这些）');
    // 先例在字节紧张时被先截：显示的先例条数少于 8。
    expect((text.match(/约定第 \d+ 版）/g) ?? []).length).toBeLessThan(8);
  });

  // P75r1：原来的断言是「旧规矩未迁移时整段与改动前一字不差（只列旧规矩，不列先例）」；
  // 现在旧规矩表在迁移完成之前并入「主人的规矩与偏好」一组（接在记忆之后），先例照常列出。
  it('旧规矩未迁移时并入「主人的规矩与偏好」一组；迁移完成后不再出现', async () => {
    const fix = await jobFix();
    // P75f：同上，模拟「升级前」。
    fix.ctx.store.table('migrations').put({ id: MEMORY_DEFAULTS.MIGRATION_ID, state: 'failed', attempts: 0, written: {}, steps: {}, error: null, updatedAt: 1 });
    fix.ctx.store.table('rules').put({ id: 'ru_0000000001', scope: 'global', text: '所有对外文字先给主人看', redLine: false, source: 'owner', status: 'active', createdAt: 1 } as never);
    await mem(fix.ctx, 'precedent', '问题：选项');
    const text = body(fix);
    expect(text).toMatch(/^可引用的出处（basis\.ref 只能写这些编号）：\n主人的规矩与偏好：\nru_0000000001：所有对外文字先给主人看\n先例（按类别，同类的事先看这里）：\nmem_[0-9a-z]{10}：/);
    expect(text.endsWith('类别（category 只能写这些）：表单页、展示页、数据整理、数据核对、文档撰写、调研报告、脚本工具、问题排查、设计稿、其他。')).toBe(true);
    fix.ctx.store.table('migrations').put({ id: MEMORY_DEFAULTS.MIGRATION_ID, state: 'done', attempts: 1, written: {}, steps: {}, error: null, updatedAt: 1 });
    expect(body(fix)).not.toContain('ru_0000000001');
  });
});

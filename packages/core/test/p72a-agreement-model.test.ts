/**
 * P72a 约定模型与纯函数测试：内容校验规则、版本与状态的一致性、合并、key 对齐、版本对比、默契度、选择、固定。
 * 每条规则至少一个正例一个反例；这里不碰存储和随机数，全部是纯函数。
 */
import { describe, expect, it } from 'vitest';
import { AGREEMENT_DEFAULTS as D } from '../src/config/defaults.js';
import {
  AgreementContentSchema, AgreementSchema, parseWithPaths, type AgreementContent,
} from '../src/model/agreement.js';
import {
  AgreementSubmitInputSchema, alignPendingKeys, applyChoices, computeAdoption, diffContent, mergeContentInput,
} from '../src/project/agreement-content.js';
import { applyLock } from '../src/project/agreements.js';
import { agreementFixture, contentFixture, submitFixture, versionFixture } from './p72a-agreement-fixtures.js';

/** 校验一份内容；返回错误文字（通过则返回 null）。 */
function problem(content: unknown): string | null {
  const result = AgreementContentSchema.safeParse(content);
  return result.success ? null : result.error.issues.map(issue => `${issue.path.join('.')}：${issue.message}`).join('；');
}
const pendingItem = (n: number) => ({ key: `k${n}`, question: `问题${n}`, options: ['甲', '乙'], suggested: '甲', reason: '理由', chosen: null });

describe('草图', () => {
  it('合法的 page、flow、concept 各通过一次', () => {
    expect(problem(contentFixture())).toBeNull();
    expect(problem({ ...contentFixture(), sketch: { layout: 'flow', steps: [{ text: '收集', actor: '总管', mark: 1 }, { text: '汇总', note: '一句话' }] } })).toBeNull();
    expect(problem({ ...contentFixture(), sketch: { layout: 'concept',
      nodes: [{ id: 'a', text: '来源' }, { id: 'b', text: '页面', mark: 2 }], links: [{ from: 'a', to: 'b', text: '供数' }] } })).toBeNull();
  });
  it('page 带了 steps 被拒', () => {
    const c = contentFixture();
    expect(problem({ ...c, sketch: { ...c.sketch, steps: [{ text: 'a' }, { text: 'b' }] } })).toMatch(/sketch\.steps：page 草图不能带 steps/);
  });
  it('page 没有 screens、flow 少于 2 步、concept 少于 2 个节点都被拒', () => {
    expect(problem({ ...contentFixture(), sketch: { layout: 'page' } })).toMatch(/screens/);
    expect(problem({ ...contentFixture(), sketch: { layout: 'flow', steps: [{ text: '只有一步' }] } })).toMatch(/steps/);
    expect(problem({ ...contentFixture(), sketch: { layout: 'concept', nodes: [{ id: 'a', text: '孤零零' }] } })).toMatch(/nodes/);
  });
  it('concept 的 link 指向不存在的节点被拒，节点 id 重复被拒', () => {
    const nodes = [{ id: 'a', text: '来源' }, { id: 'b', text: '页面' }];
    expect(problem({ ...contentFixture(), sketch: { layout: 'concept', nodes, links: [{ from: 'a', to: 'zz' }] } })).toMatch(/links\.0\.to：连线终点「zz」不是已有节点/);
    expect(problem({ ...contentFixture(), sketch: { layout: 'concept', nodes: [nodes[0], nodes[0]] } })).toMatch(/重复/);
  });
  it('mark 大于待定项数被拒，等于待定项数通过', () => {
    const c = contentFixture(); // 两个待定项
    const withMark = (mark: number) => ({ ...c, sketch: { layout: 'page', screens: [{ title: 't', blocks: [{ kind: 'text', text: 'x', mark }] }] } });
    expect(problem(withMark(2))).toBeNull();
    expect(problem(withMark(3))).toMatch(/序号 3 超过了待你定的事项数/);
  });
  it('只有 table 块能带 rows，table 的行列数有上限', () => {
    const c = contentFixture();
    const block = (b: Record<string, unknown>) => ({ ...c, sketch: { layout: 'page', screens: [{ title: 't', blocks: [b] }] } });
    expect(problem(block({ kind: 'table', text: '表', rows: [['a', 'b'], ['c', 'd']] }))).toBeNull();
    expect(problem(block({ kind: 'text', text: '文', rows: [['a', 'b']] }))).toMatch(/只有 table 块能带 rows/);
    expect(problem(block({ kind: 'table', text: '表', rows: [['a']] }))).toMatch(/每行至少 2 格/);
    expect(problem(block({ kind: 'table', text: '表', rows: [['a', 'b'], ['a', 'b'], ['a', 'b'], ['a', 'b'], ['a', 'b']] }))).toMatch(/最多 4 行/);
  });
});

describe('待定项', () => {
  it('0 项、6 项被拒，1 项、5 项通过', () => {
    const c = { ...contentFixture(), sketch: { layout: 'flow', steps: [{ text: 'a' }, { text: 'b' }] } };
    expect(problem({ ...c, pending: [] })).toMatch(/至少 1 项/);
    expect(problem({ ...c, pending: [1, 2, 3, 4, 5, 6].map(pendingItem) })).toMatch(/最多 5 项/);
    expect(problem({ ...c, pending: [pendingItem(1)] })).toBeNull();
    expect(problem({ ...c, pending: [1, 2, 3, 4, 5].map(pendingItem) })).toBeNull();
  });
  it('suggested 不在 options 里被拒，且错误点出路径', () => {
    const c = contentFixture();
    const text = (() => { try { parseWithPaths(AgreementContentSchema, { ...c, pending: [c.pending[0], { ...c.pending[1], suggested: '别的' }] }, '约定内容'); return ''; } catch (e) { return (e as Error).message; } })();
    expect(text).toContain('pending[1].suggested：建议项必须是选项之一');
  });
  it('options 去首尾空白后重复被拒，key 重复被拒', () => {
    const c = contentFixture();
    expect(problem({ ...c, pending: [{ ...c.pending[0], options: ['公开接口', ' 公开接口 '] }] })).toMatch(/不能重复/);
    expect(problem({ ...c, pending: [c.pending[0], { ...c.pending[1], key: 'source' }] })).toMatch(/key「source」重复/);
  });
  it('options 少于 2 个、多于 4 个被拒；chosen 不在 options 里被拒', () => {
    const c = contentFixture();
    expect(problem({ ...c, pending: [{ ...c.pending[0], options: ['公开接口'] }] })).toMatch(/至少 2 个/);
    expect(problem({ ...c, pending: [{ ...c.pending[0], options: ['a', 'b', 'c', 'd', 'e'], suggested: 'a' }] })).toMatch(/最多 4 个/);
    expect(problem({ ...c, pending: [{ ...c.pending[0], chosen: '不存在' }] })).toMatch(/已选项必须是选项之一/);
  });
});

describe('已定事项、范围、怎样算做完', () => {
  it('doneWhen 2 条、6 条被拒，3 条、5 条通过', () => {
    const c = contentFixture();
    expect(problem({ ...c, doneWhen: ['a', 'b'] })).toMatch(/至少 3 条/);
    expect(problem({ ...c, doneWhen: ['a', 'b', 'c', 'd', 'e', 'f'] })).toMatch(/最多 5 条/);
    expect(problem({ ...c, doneWhen: ['a', 'b', 'c'] })).toBeNull();
    expect(problem({ ...c, doneWhen: ['a', 'b', 'c', 'd', 'e'] })).toBeNull();
  });
  it('scopeIn 空数组被拒，scopeOut 空数组通过', () => {
    const c = contentFixture();
    expect(problem({ ...c, scopeIn: [] })).toMatch(/范围内至少 1 条/);
    expect(problem({ ...c, scopeOut: [] })).toBeNull();
  });
  it('依据：source 必须带出处和原文，其他类型不能带', () => {
    const c = contentFixture();
    const decided = (basis: unknown) => ({ ...c, decided: [{ text: '定了', basis }] });
    expect(problem(decided({ kind: 'source', ref: 'ru_0000000001', refText: '规矩原文' }))).toBeNull();
    expect(problem(decided({ kind: 'source', ref: null, refText: null }))).toMatch(/source 类型的依据必须同时有出处和出处原文/);
    expect(problem(decided({ kind: 'trial', ref: 'ru_0000000001', refText: null }))).toMatch(/不能带出处/);
  });
  it('单条超长被拒（按完整字符计，一个汉字算 1）', () => {
    const c = contentFixture();
    expect(problem({ ...c, summary: '字'.repeat(D.SUMMARY_MAX_CHARS) })).toBeNull();
    expect(problem({ ...c, summary: '字'.repeat(D.SUMMARY_MAX_CHARS + 1) })).toMatch(/不能超过 120 字/);
  });
});

describe('内容字节上限', () => {
  /** 全部写满的 ASCII 内容，体积远低于 8 KB。 */
  function asciiHeavy(): AgreementContent {
    const a = (n: number) => 'a'.repeat(n);
    return {
      summary: a(120), sketch: { layout: 'flow', steps: [{ text: a(40) }, { text: a(40) }] },
      pending: [1, 2, 3, 4, 5].map(n => ({ key: `k${n}`, question: a(60), options: [a(29) + 'x', a(29) + 'y'], suggested: a(29) + 'x', reason: a(80), chosen: null })),
      decided: Array.from({ length: 8 }, () => ({ text: a(100), basis: { kind: 'judgement' as const, ref: null, refText: null } })),
      scopeIn: Array.from({ length: 6 }, () => a(60)), scopeOut: Array.from({ length: 6 }, () => a(60)),
      doneWhen: Array.from({ length: 5 }, () => a(100)),
    };
  }
  function bytesOf(c: AgreementContent) { return Buffer.byteLength(JSON.stringify(c), 'utf8'); }
  /** 所有可以改写的文字位置：每个位置能读、能写。 */
  function slots(c: AgreementContent): { get: () => string; set: (v: string) => void }[] {
    const out: { get: () => string; set: (v: string) => void }[] = [{ get: () => c.summary, set: v => { c.summary = v; } }];
    for (const item of c.pending) {
      out.push({ get: () => item.question, set: v => { item.question = v; } }, { get: () => item.reason, set: v => { item.reason = v; } });
    }
    for (const item of c.decided) out.push({ get: () => item.text, set: v => { item.text = v; } });
    for (const list of [c.scopeIn, c.scopeOut, c.doneWhen]) list.forEach((_, i) => out.push({ get: () => list[i]!, set: v => { list[i] = v; } }));
    return out;
  }
  /** 把一个 ASCII 的 a 换成汉字（UTF-8 多占 2 字节）；成功返回 true，没有可换的位置返回 false。 */
  function swapOne(c: AgreementContent): boolean {
    for (const slot of slots(c)) {
      const at = slot.get().indexOf('a');
      if (at >= 0) { slot.set(slot.get().slice(0, at) + '字' + slot.get().slice(at + 1)); return true; }
    }
    return false;
  }
  it('略低于 8 KB 通过，再多一个汉字就被拒', () => {
    const c = asciiHeavy();
    expect(bytesOf(c)).toBeLessThan(D.CONTENT_MAX_BYTES);
    expect(problem(c)).toBeNull();
    // 一个一个换，直到再换一个就会超限：此时离上限只差 1 到 2 字节。
    while (bytesOf(c) + 2 <= D.CONTENT_MAX_BYTES) expect(swapOne(c)).toBe(true);
    expect(bytesOf(c)).toBeGreaterThanOrEqual(D.CONTENT_MAX_BYTES - 1);
    expect(problem(c)).toBeNull();
    // 再多一个汉字：超过上限，被拒。
    expect(swapOne(c)).toBe(true);
    expect(bytesOf(c)).toBeGreaterThan(D.CONTENT_MAX_BYTES);
    expect(problem(c)).toMatch(/约定内容太长/);
  });
});

describe('AgreementSchema', () => {
  it('合法记录通过', () => {
    expect(AgreementSchema.safeParse(agreementFixture()).success).toBe(true);
  });
  it('两个 pending 版本被拒', () => {
    const r = AgreementSchema.safeParse(agreementFixture({ versions: [versionFixture(1), versionFixture(2)] }));
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error)).toContain('待确认的版本最多只能有一个');
  });
  it('state 为 locked 却没有 locked 版本被拒', () => {
    const r = AgreementSchema.safeParse(agreementFixture({ state: 'locked', versions: [versionFixture(1, { state: 'superseded' })] }));
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error)).toContain('必须恰有一个已固定的版本');
  });
  it('版本号不连续、state 为 pending 但最新版不是 pending、withdrawn 缺信息都被拒', () => {
    expect(AgreementSchema.safeParse(agreementFixture({ versions: [versionFixture(2)] })).success).toBe(false);
    expect(AgreementSchema.safeParse(agreementFixture({ state: 'pending', versions: [versionFixture(1, { state: 'locked' })] })).success).toBe(false);
    expect(AgreementSchema.safeParse(agreementFixture({ state: 'withdrawn' })).success).toBe(false);
  });
  it('已固定且只有一个 locked 版本、没有 pending 版本时通过', () => {
    const locked = versionFixture(1, { state: 'locked', lockedAt: 5, lockedVia: 'button', choices: { source: '公开接口', refresh: '每天' } });
    expect(AgreementSchema.safeParse(agreementFixture({ state: 'locked', versions: [locked] })).success).toBe(true);
  });
});

describe('提交参数', () => {
  it('合法参数通过；根节点是严格对象，多余字段被拒', () => {
    expect(AgreementSubmitInputSchema.safeParse(submitFixture()).success).toBe(true);
    expect(AgreementSubmitInputSchema.safeParse({ ...submitFixture(), chosen: 1 }).success).toBe(false);
  });
  it('待定项里不能带 chosen，已定事项的依据里不能带 refText', () => {
    const p = submitFixture() as { pending: Record<string, unknown>[]; decided: { basis: Record<string, unknown> }[] };
    expect(AgreementSubmitInputSchema.safeParse({ ...p, pending: [{ ...p.pending[0], chosen: '甲' }] }).success).toBe(false);
    expect(AgreementSubmitInputSchema.safeParse({ ...p, decided: [{ text: 'x', basis: { kind: 'trial', refText: 'y' } }] }).success).toBe(false);
  });
});

describe('mergeContentInput', () => {
  it('新建缺 sketch 和 doneWhen 时错误里同时列出两项；decided 缺省也报错，空数组可以', () => {
    const input = AgreementSubmitInputSchema.parse(submitFixture());
    const { sketch: _s, doneWhen: _d, ...rest } = input;
    expect(() => mergeContentInput(null, rest)).toThrow(/缺少：sketch、doneWhen/);
    const { decided: _x, ...noDecided } = input;
    expect(() => mergeContentInput(null, noDecided)).toThrow(/decided/);
    expect(mergeContentInput(null, { ...input, decided: [] }).decided).toEqual([]);
  });
  it('新建时 pending 的 chosen 置 null，decided 的 refText 置 null', () => {
    const merged = mergeContentInput(null, AgreementSubmitInputSchema.parse(submitFixture()));
    expect(merged.pending.every(item => item.chosen === null)).toBe(true);
    expect(merged.decided[0]!.basis).toEqual({ kind: 'judgement', ref: null, refText: null });
  });
  it('修订时只给 summary，其余沿用上一版（含 pending 的 chosen 被清空）', () => {
    const prev = { ...contentFixture(), pending: contentFixture().pending.map(item => ({ ...item, chosen: item.suggested })) };
    const merged = mergeContentInput(prev, { summary: '改了一句话' });
    expect(merged.summary).toBe('改了一句话');
    expect(merged.sketch).toEqual(prev.sketch);
    expect(merged.doneWhen).toEqual(prev.doneWhen);
    expect(merged.pending.map(item => item.key)).toEqual(['source', 'refresh']);
    expect(merged.pending.every(item => item.chosen === null)).toBe(true);
  });
});

describe('alignPendingKeys', () => {
  const prev = [{ key: 'old', question: '报价从哪里取' }, { key: 'keep', question: '多久刷新' }];
  it('问题原文相同、key 不同时改回原 key', () => {
    const out = alignPendingKeys(prev, [{ key: 'brand-new', question: '报价从哪里取' }, { key: 'keep', question: '多久刷新' }]);
    expect(out.map(item => item.key)).toEqual(['old', 'keep']);
  });
  it('问题原文不同时不改', () => {
    const out = alignPendingKeys(prev, [{ key: 'brand-new', question: '换了个问题' }, { key: 'keep', question: '多久刷新' }]);
    expect(out.map(item => item.key)).toEqual(['brand-new', 'keep']);
  });
  it('key 在 prev 里还在时不动；一个旧项只被认领一次', () => {
    const out = alignPendingKeys(prev, [{ key: 'x1', question: '报价从哪里取' }, { key: 'x2', question: '报价从哪里取' }]);
    expect(out.map(item => item.key)).toEqual(['old', 'x2']);
  });
});

describe('diffContent', () => {
  const base = contentFixture();
  const clone = (): AgreementContent => JSON.parse(JSON.stringify(base));
  it('prev 为 null 或完全相同返回空数组', () => {
    expect(diffContent(null, base)).toEqual([]);
    expect(diffContent(base, clone())).toEqual([]);
  });
  it('只改 summary 只有一条 summary 标记', () => {
    expect(diffContent(base, { ...clone(), summary: '换一句话' })).toEqual([{ section: 'summary', kind: 'changed' }]);
  });
  it('草图不同记一条 sketch changed', () => {
    const next = clone();
    (next.sketch.screens![0]!.blocks[0]!).text = '改过的标题';
    expect(diffContent(base, next)).toEqual([{ section: 'sketch', kind: 'changed' }]);
  });
  it('pending 增、删、改各产生对应标记且带 key', () => {
    const next = clone();
    next.pending[0]!.reason = '换了理由'; // 改
    next.pending.splice(1, 1); // 删 refresh
    next.pending.push({ key: 'extra', question: '新问题', options: ['甲', '乙'], suggested: '甲', reason: '理由', chosen: null }); // 增
    expect(diffContent(base, next)).toEqual([
      { section: 'pending', kind: 'changed', key: 'source' },
      { section: 'pending', kind: 'added', key: 'extra' },
      // P72h H1：removed 标记现在带上被删条目的原文（待定项为问题原文），界面写「删去：某某」。
      { section: 'pending', kind: 'removed', key: 'refresh', text: '多久刷新一次' },
    ]);
  });
  it('doneWhen 多一条记 added 带 index，少一条记 removed，改一条记 changed', () => {
    const more = clone(); more.doneWhen.push('新增的一条');
    expect(diffContent(base, more)).toEqual([{ section: 'doneWhen', kind: 'added', index: 3 }]);
    const fewer = clone(); fewer.scopeOut = [];
    // P72h H1：removed 标记带上被删条目的原文。
    expect(diffContent(base, fewer)).toEqual([{ section: 'scopeOut', kind: 'removed', index: 0, text: '历史曲线' }]);
    const edited = clone(); edited.scopeIn[1] = '改了';
    expect(diffContent(base, edited)).toEqual([{ section: 'scopeIn', kind: 'changed', index: 1 }]);
  });
  it('decided 的依据 kind 或 ref 变了也算 changed', () => {
    const next = clone(); next.decided[0]!.basis = { kind: 'convention', ref: null, refText: null };
    expect(diffContent(base, next)).toEqual([{ section: 'decided', kind: 'changed', index: 0 }]);
  });
});

describe('computeAdoption 与 applyChoices', () => {
  /** 设计稿 A3 的例子：4 项，第 1 项建议原文被改，其余按建议。 */
  function four(firstSuggestions: string[]): AgreementContent {
    return { ...contentFixture(), pending: firstSuggestions.map((s, i) => ({ key: `k${i + 1}`, question: `问${i + 1}`, options: ['甲', '乙', '丙'], suggested: s, reason: '理由', chosen: null })) };
  }
  it('A3 的例子得 3 / 4', () => {
    const first = four(['甲', '甲', '乙', '丙']);
    const lockedPending = four(['乙', '甲', '乙', '丙']).pending.map(item => ({ ...item, chosen: item.suggested }));
    expect(computeAdoption(first, { ...first, pending: lockedPending })).toEqual({ adopted: 3, total: 4 });
  });
  it('主人在确认时选了非建议项，该项不算采纳', () => {
    const first = four(['甲', '甲', '乙', '丙']);
    const lockedPending = first.pending.map(item => ({ ...item, chosen: item.key === 'k2' ? '乙' : item.suggested }));
    expect(computeAdoption(first, { ...first, pending: lockedPending })).toEqual({ adopted: 3, total: 4 });
  });
  it('第 1 版没有的 key 不算采纳', () => {
    const first = four(['甲', '甲']);
    const locked = four(['甲', '甲', '乙']);
    const lockedPending = locked.pending.map(item => ({ ...item, chosen: item.suggested }));
    expect(computeAdoption(first, { ...locked, pending: lockedPending })).toEqual({ adopted: 2, total: 3 });
  });
  it('applyChoices：未知 key 被拒', () => {
    expect(() => applyChoices(contentFixture(), { nope: '甲' })).toThrow(/choices\.nope：没有这个待定项/);
  });
  it('applyChoices：选项不在 options 里被拒', () => {
    expect(() => applyChoices(contentFixture(), { source: '火星' })).toThrow(/choices\.source：「火星」不是这一项的选项之一/);
  });
  it('applyChoices：未给的项取建议，且不改入参', () => {
    const c = contentFixture();
    const out = applyChoices(c, { source: '手工表格' });
    expect(out.pending.map(item => item.chosen)).toEqual(['手工表格', '每天']);
    expect(c.pending.every(item => item.chosen === null)).toBe(true);
  });
});

describe('applyLock', () => {
  const lock = (agreement = agreementFixture(), patch: Partial<Parameters<typeof applyLock>[1]> = {}) =>
    applyLock(agreement, { version: 1, via: 'button', choices: null, at: 9000, confirmMessageId: 'm_0000000009', ...patch });
  it('最新 pending 版成功固定并写 chosen、固定信息和默契度', () => {
    const agreement = agreementFixture();
    const out = lock(agreement, { choices: { source: '手工表格' } });
    expect(out.state).toBe('locked');
    expect(out.updatedAt).toBe(9000);
    const v = out.versions[0]!;
    expect(v).toMatchObject({ state: 'locked', lockedAt: 9000, lockedVia: 'button', confirmMessageId: 'm_0000000009', choices: { source: '手工表格', refresh: '每天' } });
    expect(v.content.pending.map(item => item.chosen)).toEqual(['手工表格', '每天']);
    expect(v.adoption).toEqual({ adopted: 1, total: 2 });
    // 不改入参
    expect(agreement.state).toBe('pending');
    expect(agreement.versions[0]!.content.pending[0]!.chosen).toBeNull();
  });
  it('用旧版本号被拒，错误里有最新版号', () => {
    const agreement = agreementFixture({ versions: [versionFixture(1, { state: 'superseded' }), versionFixture(2)] });
    expect(() => lock(agreement, { version: 1 })).toThrow('这一版已被第 2 版取代，请在最新一版上确认');
    expect(lock(agreement, { version: 2 }).state).toBe('locked');
  });
  it('已固定的约定再锁被拒；已撤下的约定被拒', () => {
    const locked = lock();
    expect(() => lock(locked)).toThrow('约定已经固定');
    const withdrawn = agreementFixture({ state: 'withdrawn', withdrawn: { at: 1, reason: '不做了', wakeId: null, noticeMessageId: null }, versions: [versionFixture(1, { state: 'superseded' })] });
    expect(() => lock(withdrawn)).toThrow('约定已撤下');
  });
  it('选项不合法被拒', () => {
    expect(() => lock(agreementFixture(), { choices: { source: '火星' } })).toThrow(/choices\.source/);
  });
  it('第二次确认（reopen 后）adoption 为 null，前一个 locked 版变 replaced', () => {
    const first = lock();
    // reopen：追加一个 pending 版，约定回到 pending，上一版保持 locked。
    const reopened = AgreementSchema.parse({ ...first, state: 'pending', versions: [...first.versions, versionFixture(2, { source: 'owner_reopen' })] });
    const second = applyLock(reopened, { version: 2, via: 'text', choices: null, at: 9500, confirmMessageId: null });
    expect(second.versions.map(v => v.state)).toEqual(['replaced', 'locked']);
    expect(second.versions[1]!.adoption).toBeNull();
    expect(second.versions[1]!).toMatchObject({ lockedVia: 'text', lockedAt: 9500, confirmMessageId: null });
    expect(second.state).toBe('locked');
  });
});

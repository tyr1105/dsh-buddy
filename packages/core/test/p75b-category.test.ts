/**
 * P75b 的测试二：约定的类别（hub_agreement_submit 的 category 参数、旁表 agreementTags、唤醒包里的类别表、总管守则的一句话）。
 * 走真实 Hub：总管的唤醒包只给文字，类别词表必须从文字里取得到，不从代码常量偷看；
 * 模拟故障时包住 store.table（与 p74e-b2 的做法一致）。
 */
import { describe, expect, it } from 'vitest';
import { AGREEMENT_DEFAULTS as AD, SKILL_DEFAULTS } from '../src/config/defaults.js';
import { agreementCategory } from '../src/project/agreement-category.js';
import { AGREEMENTS_TITLE, CHIEF_RULES_TEXT, buildAgreementsBody } from '../src/wake/chief-packet.js';
import { AgreementSchema } from '../src/model/agreement.js';
import { byteLength } from '../src/util/text.js';
import { agreementFixture, contentFixture, versionFixture } from './p72a-agreement-fixtures.js';
import { turnContext } from './c03-turn-fixtures.js';
import { callTool, chiefDrafts, lockAgreement, newAgreementArgs, ownerSays, setup, speak } from './p72b-fixtures.js';
import { lastPacket } from './p63-topic-fixtures.js';

/** 从总管唤醒包的文字里取类别词表（约定段末尾那一行）。 */
function categoriesIn(packet: string): string[] {
  const match = /类别（category 只能写这些）：(.+?)。(?:\n|$)/.exec(packet);
  expect(match, '唤醒包约定段里应该有类别表').not.toBeNull();
  return match![1]!.split('、');
}

/** 让 agreementTags 的 put 失败一次（表对象每次取都是新的，所以换掉 store.table）；返回恢复函数。 */
function failTagWrite(ctx: { store: unknown }): () => void {
  const store = ctx.store as { table: (name: string) => object };
  const originalTable = store.table.bind(store);
  store.table = (name: string) => {
    const table = originalTable(name);
    if (name !== 'agreementTags') return table;
    return new Proxy(table, {
      get(target, prop) {
        if (prop === 'put') return () => { throw new Error('磁盘写入失败'); };
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
  return () => { store.table = originalTable; };
}

describe('4 类别：只靠唤醒包文字就能提交成功', () => {
  it('取约定段末尾的类别表，用正则取出第一个类别，提交新约定成功，agreementTags 有这一行', async () => {
    const fix = await setup();
    await ownerSays(fix, fix.chief.id, '帮我做个报名页');
    const packet = lastPacket(fix, fix.chief);
    const section = packet.split(`${AGREEMENTS_TITLE}\n`)[1]!.split('\n\n## ')[0]!;
    // 词表在约定段最末一行，且排在「可引用的出处」之后。
    expect(section.trimEnd().split('\n').at(-1)).toMatch(/^类别（category 只能写这些）：/);
    expect(section.indexOf('类别（category')).toBeGreaterThan(section.indexOf('暂无可引用的出处'));
    const first = categoriesIn(packet)[0]!;
    expect(categoriesIn(packet)).toEqual([...SKILL_DEFAULTS.CATEGORIES]);
    const result = await callTool(fix, fix.chief, 'hub_agreement_submit', newAgreementArgs({ category: first }));
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    const agreement = fix.ctx.store.table('agreements').list()[0]!;
    expect(fix.ctx.store.table('agreementTags').list()).toEqual([{ id: agreement.id, category: first, setAt: fix.ctx.clock.now() }]);
    expect(agreementCategory(fix.ctx, agreement.id)).toBe(first);
  });

  it('总管守则第 2 条含新增的一句，位置在「约定卡就是给主人的提问。」之后、「这件事属于你负责的」之前', () => {
    expect(CHIEF_RULES_TEXT).toContain('约定卡就是给主人的提问。提交时 category 填这件事属于哪类工作，从约定段末尾的类别表里选一个。\n   这件事属于你负责的');
    // 只多了这一句：去掉它之后与原来的第 2 条衔接处一字不差。
    expect(CHIEF_RULES_TEXT.replace('提交时 category 填这件事属于哪类工作，从约定段末尾的类别表里选一个。', ''))
      .toContain('约定卡就是给主人的提问。\n   这件事属于你负责的');
  });

  it('约定段很长被截断时，类别表仍在最末一行，整段不超过上限', async () => {
    const { ctx, bot, entry } = await turnContext('regular', { role: 'chief' });
    // 12 条规矩、一份很长的待确认约定：不加类别表就会超过上限。
    for (let i = 0; i < 12; i += 1) {
      ctx.store.table('rules').put({ id: `ru_${String(i).padStart(10, '0')}`, text: `规矩${i}`.padEnd(60, '矩'), scope: 'global', redLine: false, source: 'owner', status: 'active', createdAt: 1000 + i });
    }
    const content = {
      ...contentFixture(),
      decided: Array.from({ length: 8 }, (_, i) => ({ text: `已定的事${i}`.padEnd(100, '定'), basis: { kind: 'judgement' as const, ref: null, refText: null } })),
      doneWhen: Array.from({ length: 5 }, (_, i) => `做完的标准${i}`.padEnd(100, '完')),
    };
    ctx.store.table('agreements').put(AgreementSchema.parse(agreementFixture({ botId: bot.id, versions: [versionFixture(1, { content })] })));
    const body = buildAgreementsBody(ctx, bot, entry, ctx.clock.now());
    expect(byteLength(body)).toBeLessThanOrEqual(AD.PACKET_MAX_BYTES);
    expect(body.split('\n').at(-1)).toBe(`类别（category 只能写这些）：${SKILL_DEFAULTS.CATEGORIES.join('、')}。`);
  });
});

describe('5 类别：默认、拒绝、修订、故障', () => {
  it('新建时不填写成「其他」', async () => {
    const fix = await setup();
    const id = await chiefDrafts(fix);
    expect(fix.ctx.store.table('agreementTags').get(id)).toMatchObject({ category: '其他' });
    expect(agreementCategory(fix.ctx, id)).toBe('其他');
    // 没有标签的约定（旧数据）读出来也是「其他」。
    expect(agreementCategory(fix.ctx, 'agr_zzzzzzzzzz')).toBe('其他');
  });

  it('填词表外的被拒，错误点出 category 和词表，且不产生约定、项目、标签', async () => {
    const fix = await setup();
    await ownerSays(fix, fix.chief.id, '帮我做个页面');
    const projectsBefore = fix.ctx.store.table('projects').count();
    const result = await callTool(fix, fix.chief, 'hub_agreement_submit', newAgreementArgs({ category: '随便写的类别' }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('category：只能写这些类别之一：表单页、展示页、数据整理');
    expect(fix.ctx.store.table('agreements').count()).toBe(0);
    expect(fix.ctx.store.table('agreementTags').count()).toBe(0);
    expect(fix.ctx.store.table('projects').count()).toBe(projectsBefore);
  });

  it('修订时填了就改、不填不动；固定后的小改动（amend）同样', async () => {
    const fix = await setup();
    const id = await chiefDrafts(fix, { category: '表单页' });
    // 第一次修订：不填 category，标签不动。
    await speak(fix, fix.chief, '好的');
    await ownerSays(fix, fix.chief.id, '多加一条验收');
    const more = ['打开页面能看到今天的报价', '点刷新后数据更新', '接口失败时有提示', '页面在手机上能看'];
    expect(await callTool(fix, fix.chief, 'hub_agreement_submit', { agreementId: id, changeNote: '加一条验收', doneWhen: more })).toMatchObject({ ok: true });
    expect(agreementCategory(fix.ctx, id)).toBe('表单页');
    // 第二次修订：填 category，标签改掉。
    await speak(fix, fix.chief, '好的');
    await ownerSays(fix, fix.chief.id, '这其实是个数据核对的活');
    expect(await callTool(fix, fix.chief, 'hub_agreement_submit', {
      agreementId: id, changeNote: '改成数据核对', category: '数据核对', doneWhen: [...more, '核对结果能导出'],
    })).toMatchObject({ ok: true });
    expect(agreementCategory(fix.ctx, id)).toBe('数据核对');
    // 修订填了词表外的类别被拒，标签不动，约定版本不增加。
    await speak(fix, fix.chief, '好的');
    await ownerSays(fix, fix.chief.id, '再改一下');
    const bad = await callTool(fix, fix.chief, 'hub_agreement_submit', { agreementId: id, changeNote: '再改', category: '乱写', summary: '另一句话复述' });
    expect(bad.ok).toBe(false);
    expect(agreementCategory(fix.ctx, id)).toBe('数据核对');
    expect(fix.ctx.store.table('agreements').get(id)!.versions).toHaveLength(3);
    // 固定之后的 amend：填了就改。
    lockAgreement(fix.ctx, id);
    await speak(fix, fix.chief, '好的');
    await ownerSays(fix, fix.chief.id, '只是换个说法');
    expect(await callTool(fix, fix.chief, 'hub_agreement_submit', { agreementId: id, mode: 'amend', changeNote: '换个说法', summary: '换个说法的一句话复述', category: '设计稿' })).toMatchObject({ ok: true });
    expect(agreementCategory(fix.ctx, id)).toBe('设计稿');
    // amend 不填：不动。
    await speak(fix, fix.chief, '好的');
    await ownerSays(fix, fix.chief.id, '再换个说法');
    expect(await callTool(fix, fix.chief, 'hub_agreement_submit', { agreementId: id, mode: 'amend', changeNote: '再换个说法', summary: '第三个说法的一句话复述' })).toMatchObject({ ok: true });
    expect(agreementCategory(fix.ctx, id)).toBe('设计稿');
  });

  it('标签写入失败时，新建的约定也不产生（撤回约定写入），工具报错', async () => {
    const fix = await setup();
    await ownerSays(fix, fix.chief.id, '帮我做个页面');
    const restore = failTagWrite(fix.ctx);
    const result = await callTool(fix, fix.chief, 'hub_agreement_submit', newAgreementArgs({ category: '展示页' }));
    restore();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('磁盘写入失败');
    expect(fix.ctx.store.table('agreements').count()).toBe(0);
    expect(fix.ctx.store.table('agreementTags').count()).toBe(0);
  });

  it('标签写入失败时，修订不产生新版本，原标签不动', async () => {
    const fix = await setup();
    const id = await chiefDrafts(fix, { category: '表单页' });
    await speak(fix, fix.chief, '好的');
    await ownerSays(fix, fix.chief.id, '换成展示页');
    const before = JSON.stringify(fix.ctx.store.table('agreements').get(id));
    const restore = failTagWrite(fix.ctx);
    const result = await callTool(fix, fix.chief, 'hub_agreement_submit', { agreementId: id, changeNote: '改类别', category: '展示页', summary: '一句新的复述' });
    restore();
    expect(result.ok).toBe(false);
    expect(JSON.stringify(fix.ctx.store.table('agreements').get(id))).toBe(before);
    expect(agreementCategory(fix.ctx, id)).toBe('表单页');
  });
});

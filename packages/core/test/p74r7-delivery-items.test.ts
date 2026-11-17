/**
 * P74r7 第 1 节的测试：「交付时核对」的条目只能是写了交付时间的那一条。
 * 包括：判断「写了时间」的函数覆盖的写法与反例；派活时全部条目都写进来被拒（真实总管这次的写法）；
 * 写了时间的一条、两条通过；三条被拒；没写时间的一条被拒；被拒后改对再派成功；
 * 约定改版本时按原文换算后原文里没有时间的条目从交付时核对里去掉。
 */
import { describe, expect, it } from 'vitest';
import { hasTimeMention } from '../src/job/time-mention.js';
import { mapDeliveryItems, remapItems } from '../src/job/item-remap.js';
import { agreementIdIn } from './p73d-fixtures.js';
import { lastPacket } from './p74d-fixtures.js';
import { assignArgs, callTool, chiefDrafts, jobFix, ownerSays, speak } from './p74b-fixtures.js';

/** 后半句（两种拒绝文字共用）。 */
const REST = '其余条目要由执行者附证据、核对人核对。没有这样的条目就不写这一项。';
const RULE = '这一项只写到了交付那一刻才能判断的条目，也就是写了交付时间的那一条（例如「11 月 17 日 18:00 前交给你验收」）。';

describe('hasTimeMention：写了时间的各种写法', () => {
  it.each([
    '11月17日前交付', '11 月 17 日 18:00 前交给你验收', '17号之前给我', '周三前给我', '星期三交付', '下周三交付',
    '明天给我', '后天给我', '月底前完成', '18:00 前交付', '18 点前交付', '3 天内给我', '48 小时内给我', '2026-11-17 前',
    '三天以内完成', '下周交付', '本周五前',
  ])('写了时间：%s', text => {
    expect(hasTimeMention(text)).toBe(true);
  });

  it.each([
    '打开页面能看到报价', '点刷新后数据更新', '接口失败时有提示', '发布之前先确认', '列表至少 3 条数据', '页面加载快', '',
  ])('没有写时间：%s', text => {
    expect(hasTimeMention(text)).toBe(false);
  });
});

describe('派活时检查 deliveryItems', () => {
  /** 五条里没有一条写时间（真实总管这次约定的写法，原文是同类的句子）。 */
  const NO_TIME = ['页面展示三个套餐', '每个套餐有价格和权益', '点击购买进入下单页', '移动端排版不错位', '页面可以通过链接访问'];
  /** 其中第 1、3 条写了时间。 */
  const WITH_TIME = ['11 月 17 日 18:00 前交给你验收', '每个套餐有价格和权益', '17 号前页面可以通过链接访问', '移动端排版不错位', '点击购买进入下单页'];

  async function start(doneWhen: string[]) {
    const fix = await jobFix();
    await chiefDrafts(fix as never, { title: '会员定价页', doneWhen });
    await speak(fix, fix.chief, '这件事有 2 项需要你定。确认前不会开工。', { outcome: 'needs_owner' });
    await ownerSays(fix, fix.chief.id, '定了');
    const agreementId = agreementIdIn(lastPacket(fix, fix.chief));
    return { fix, agreementId };
  }
  const assign = (fix: Awaited<ReturnType<typeof start>>['fix'], id: string, deliveryItems: number[]) =>
    callTool(fix, fix.chief, 'hub_job_manage', assignArgs(id, { deliveryItems }));

  it('真实总管这次的写法：五条全部写进 deliveryItems，被拒，文字逐字相同', async () => {
    const { fix, agreementId } = await start(NO_TIME);
    const result = await assign(fix, agreementId, [1, 2, 3, 4, 5]);
    expect(result).toEqual({ ok: false, error: `deliveryItems：最多 2 条，这次写了 5 条。${RULE}${REST}` });
    expect(fix.ctx.store.table('jobs').list()).toHaveLength(0);
  });

  it('三条被拒（即使三条都写了时间）', async () => {
    const { fix, agreementId } = await start(['17 号前交付', '18:00 前验收', '明天给我看', '页面展示三个套餐']);
    const result = await assign(fix, agreementId, [1, 2, 3]);
    expect(result).toEqual({ ok: false, error: `deliveryItems：最多 2 条，这次写了 3 条。${RULE}${REST}` });
  });

  it('没有写时间的一条被拒，文字逐字相同，原文只取前 30 字', async () => {
    const long = '页面展示三个套餐，每个套餐都有价格、权益说明和购买按钮';
    const { fix, agreementId } = await start([long, '17 号前交付', '移动端排版不错位']);
    const result = await assign(fix, agreementId, [1]);
    expect(result).toEqual({
      ok: false,
      error: `deliveryItems：${RULE}第 1 条「${[...long].slice(0, 30).join('')}」里没有写时间，不能写进来；${REST}`,
    });
  });

  it('写了时间的一条通过；两条都写了时间也通过', async () => {
    const one = await start(WITH_TIME);
    expect(await assign(one.fix, one.agreementId, [1])).toMatchObject({ ok: true });
    expect(one.fix.ctx.store.table('jobs').list()[0]).toMatchObject({ deliveryItems: [1] });
    const two = await start(WITH_TIME);
    expect(await assign(two.fix, two.agreementId, [1, 3])).toMatchObject({ ok: true });
    expect(two.fix.ctx.store.table('jobs').list()[0]).toMatchObject({ deliveryItems: [1, 3] });
  });

  it('被拒后改对（只写带时间的一条）再派成功', async () => {
    const { fix, agreementId } = await start(WITH_TIME);
    expect((await assign(fix, agreementId, [1, 2, 3])).ok).toBe(false);
    expect((await assign(fix, agreementId, [2])).ok).toBe(false);
    expect(await assign(fix, agreementId, [1])).toMatchObject({ ok: true });
  });

  it('不写 deliveryItems 照常派活', async () => {
    const { fix, agreementId } = await start(NO_TIME);
    expect(await assign(fix, agreementId, [])).toMatchObject({ ok: true });
  });
});

describe('约定新版本换算条目', () => {
  // P74r15 改了预期：原来断言「换算后原文里没写时间的条目被去掉并记日志」（[1]，日志里有第 2 条）；
  // 现在断言原文没有变的条目一律保留（[1, 2]）：判断规则变了，主人已经确认的「交付时核对」条目不该被悄悄改掉。
  it('换算后原文没有变的条目一律保留，不再按「有没有写时间」重新判断', () => {
    const prev = ['17 号前交付', '页面展示三个套餐'];
    const next = ['17 号前交付', '页面展示三个套餐'];
    const remap = remapItems(prev, next);
    expect(mapDeliveryItems([1, 2], remap)).toEqual([1, 2]);
  });
});

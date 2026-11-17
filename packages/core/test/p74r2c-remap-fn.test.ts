/**
 * P74r2c 的单元测试：条目对应的纯函数（job/item-remap.ts）。
 * 覆盖：全部不变、中间插入、删去、改写、删去一条同时新增一条（条数不变）、有重复原文；
 * 以及顺序检查、交付时核对条目的换算、待改条目与受阻关联条目的换算、中心重排的交回记录。
 * 不需要夹具：都是在传入的数据上计算。
 */
import { describe, expect, it } from 'vitest';
import {
  buildRemappedSubmission, checkDeliveryItems, clip20, firstReordered, flippedDeliveryItems, isCenterRemapped, lostDeliveryItems,
  mapDeliveryItems, remapBlockedNo, remapItems, remapUnmet, submissionTexts,
} from '../src/job/item-remap.js';
import type { JobSubmission } from '../src/model/job.js';

/** 把 Map 转成便于比较的普通数组（按键排序）。 */
const pairs = (map: Map<number, number>): Array<[number, number]> => [...map.entries()].sort((a, b) => a[0] - b[0]);

describe('remapItems：按原文对应', () => {
  it('全部不变：每条对应自己，没有新增和删去，changed 为假', () => {
    const r = remapItems(['甲', '乙', '丙'], ['甲', '乙', '丙']);
    expect(pairs(r.toNew)).toEqual([[1, 1], [2, 2], [3, 3]]);
    expect(r.added).toEqual([]);
    expect(r.removed).toEqual([]);
    expect(r.changed).toBe(false);
  });

  it('在最前面插入一条：旧的依次后移一位，新增的是第 1 条', () => {
    const r = remapItems(['甲', '乙', '丙'], ['新', '甲', '乙', '丙']);
    expect(pairs(r.toNew)).toEqual([[1, 2], [2, 3], [3, 4]]);
    expect(r.added).toEqual([1]);
    expect(r.removed).toEqual([]);
    expect(r.changed).toBe(true);
  });

  it('删去中间一条：后面的前移，被删的旧序号列在 removed', () => {
    const r = remapItems(['甲', '乙', '丙', '丁'], ['甲', '丙', '丁']);
    expect(pairs(r.toNew)).toEqual([[1, 1], [3, 2], [4, 3]]);
    expect(r.removed).toEqual([2]);
    expect(r.added).toEqual([]);
    expect(r.changed).toBe(true);
  });

  it('改写一条：旧的那条进 removed，新的那条进 added，其余照旧', () => {
    const r = remapItems(['甲', '乙', '丙'], ['甲', '乙改', '丙']);
    expect(pairs(r.toNew)).toEqual([[1, 1], [3, 3]]);
    expect(r.removed).toEqual([2]);
    expect(r.added).toEqual([2]);
  });

  it('删去第 1 条同时在末尾新增一条（条数不变）：靠原文区分，不是「全部没变」', () => {
    const r = remapItems(['甲', '乙', '丙'], ['乙', '丙', '丁']);
    expect(pairs(r.toNew)).toEqual([[2, 1], [3, 2]]);
    expect(r.removed).toEqual([1]);
    expect(r.added).toEqual([3]);
    expect(r.changed).toBe(true);
  });

  it('有重复原文：按出现的先后依次对应，不会两条对到同一条上', () => {
    const r = remapItems(['同', '乙', '同'], ['同', '同', '乙']);
    // 旧第 1 个「同」对新第 1 个「同」，旧第 2 个「同」（旧序号 3）对新第 2 个「同」。
    expect(pairs(r.toNew)).toEqual([[1, 1], [2, 3], [3, 2]]);
    expect(r.added).toEqual([]);
    expect(r.removed).toEqual([]);
    // 重复原文删去一份：先出现的先对应，多出来的旧的算删去。
    const fewer = remapItems(['同', '同', '乙'], ['乙', '同']);
    expect(pairs(fewer.toNew)).toEqual([[1, 2], [3, 1]]);
    expect(fewer.removed).toEqual([2]);
  });
});

describe('firstReordered：沿用条目的相对顺序', () => {
  it('插入、删去、改写都不算顺序变化', () => {
    expect(firstReordered(remapItems(['甲', '乙', '丙'], ['新', '甲', '乙', '丙']))).toBeNull();
    expect(firstReordered(remapItems(['甲', '乙', '丙'], ['甲', '丙']))).toBeNull();
    expect(firstReordered(remapItems(['甲', '乙', '丙'], ['甲', '乙改', '丙']))).toBeNull();
  });

  it('两条对调：返回位置变了的那一条在新版本里的序号', () => {
    expect(firstReordered(remapItems(['甲', '乙', '丙'], ['乙', '甲', '丙']))).toBe(1);
    // 旧顺序甲(1)->3，乙(2)->1：看到乙时新序号回头，位置变了的是新版本第 1 条。
    expect(firstReordered(remapItems(['甲', '乙', '丙'], ['乙', '丙', '甲']))).toBe(1);
  });
});

describe('clip20、checkDeliveryItems', () => {
  it('超过 20 个字截断加省略号，不超过原样', () => {
    expect(clip20('短句')).toBe('短句');
    expect(clip20('一二三四五六七八九十一二三四五六七八九十')).toBe('一二三四五六七八九十一二三四五六七八九十');
    expect(clip20('一二三四五六七八九十一二三四五六七八九十多')).toBe('一二三四五六七八九十一二三四五六七八九十…');
  });

  it('序号越界、不是整数、重复都被拒，文字与派活时一致', () => {
    expect(() => checkDeliveryItems([4], 3)).toThrow('deliveryItems：序号 4 不在「怎样算做完」的范围内（1 到 3）');
    expect(() => checkDeliveryItems([0], 3)).toThrow('不在「怎样算做完」的范围内');
    expect(() => checkDeliveryItems([1.5], 3)).toThrow('不在「怎样算做完」的范围内');
    expect(() => checkDeliveryItems([1, 1], 3)).toThrow('deliveryItems：序号不能重复');
    expect(() => checkDeliveryItems([1, 3], 3)).not.toThrow();
  });
});

describe('交付时核对、待改、受阻关联的换算', () => {
  const r = remapItems(['甲', '乙', '丙'], ['新', '甲', '丙改', '乙']);
  // 对应：甲 1->2，乙 2->4，丙（改写）没有对应。

  it('交付时核对的条目换成新序号，被改写的不再算；lost 列出对不上的旧序号', () => {
    expect(mapDeliveryItems([1, 3], r)).toEqual([2]);
    expect(lostDeliveryItems([1, 3], r)).toEqual([3]);
    expect(mapDeliveryItems([2, 1], r)).toEqual([2, 4]);
  });

  it('是否交付时核对的状态变了的条目：对应上了、状态不同', () => {
    expect(flippedDeliveryItems([1], [2], r)).toEqual([]);
    expect(flippedDeliveryItems([1], [4], r)).toEqual([2, 4]);
  });

  it('待改条目：序号换新，问题和改到什么程度算过原样；原文改写的去掉；按新序号排序', () => {
    const unmet = [{ no: 3, problem: '丙的问题', fixTo: '丙怎么改' }, { no: 2, problem: '乙的问题', fixTo: '乙怎么改' }];
    expect(remapUnmet(unmet, r)).toEqual([{ no: 4, problem: '乙的问题', fixTo: '乙怎么改' }]);
    expect(remapUnmet([{ no: 1, problem: 'p', fixTo: 'f' }], r)).toEqual([{ no: 2, problem: 'p', fixTo: 'f' }]);
  });

  it('受阻关联的条目：原文还在换新序号，否则置空，本来为空保持为空', () => {
    expect(remapBlockedNo(2, r)).toBe(4);
    expect(remapBlockedNo(3, r)).toBeNull();
    expect(remapBlockedNo(null, r)).toBeNull();
  });
});

describe('中心重排的交回记录', () => {
  /** 一条 4 条目的交回：第 2、3 条各带一项证据。 */
  function submission(): JobSubmission {
    const evidence = (id: string) => ({ id, kind: 'test' as const, path: null, url: null, summary: `证据 ${id}`, command: null, check: { status: 'unchecked' as const, detail: '' } });
    const item = (no: number, text: string, ev: string[]) => ({ no, text, selfCheck: 'met' as const, note: `说明${no}`, evidence: ev.map(evidence) });
    return {
      id: 'jsb_aaaaaaaaaa', jobId: 'job_aaaaaaaaaa', stage: 1, round: 2, executorId: 'b_aaaaaaaaaa', versionNo: 1, changeNote: '做了',
      items: [item(1, '甲', ['ev1']), item(2, '乙', ['ev2']), item(3, '丙', ['ev3']), item(4, '丁', ['ev4'])],
      deliverables: ['交付/a.html'], preview: null, createdAt: 100,
    };
  }

  it('删去第 2 条：3 条、新序号、原文说明证据原样、版本号是新版本、标明重排自哪一次交回；原记录不动', () => {
    const source = submission();
    const remap = remapItems(submissionTexts(source), ['甲', '丙', '丁']);
    const rebuilt = buildRemappedSubmission(source, remap, 2, 'jsb_bbbbbbbbbb', 200);
    expect(rebuilt.items.map(row => [row.no, row.text, row.note])).toEqual([[1, '甲', '说明1'], [2, '丙', '说明3'], [3, '丁', '说明4']]);
    expect(rebuilt.items.map(row => row.evidence.map(ev => ev.id))).toEqual([['ev1'], ['ev3'], ['ev4']]);
    expect(rebuilt).toMatchObject({ id: 'jsb_bbbbbbbbbb', stage: 1, round: 2, versionNo: 2, createdAt: 200, remappedFrom: 'jsb_aaaaaaaaaa', changeNote: '做了' });
    // 原记录没有被改。
    expect(source.items).toHaveLength(4);
    expect(source.versionNo).toBe(1);
    expect(source.remappedFrom).toBeUndefined();
  });

  it('isCenterRemapped：只认中心重排的记录，执行者的交回不是', () => {
    const source = submission();
    const rebuilt = buildRemappedSubmission(source, remapItems(submissionTexts(source), ['甲', '乙', '丙']), 2, 'jsb_bbbbbbbbbb', 200);
    expect(isCenterRemapped(rebuilt)).toBe(true);
    expect(isCenterRemapped(source)).toBe(false);
  });
});

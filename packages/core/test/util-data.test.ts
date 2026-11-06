/** 文本、指纹、ID 与统计验收；包含中文字节上限、对象顺序与错误输入，防止静默丢失信息。 */
import { describe, expect, it } from 'vitest';
import { byteLength, lineDiff, slugify, stripHtml, truncateBytes } from '../src/util/text.js';
import { fingerprint, sha1Hex, sha256Hex, stableStringify } from '../src/util/hash.js';
import { newId } from '../src/util/ids.js';
import { coefficientOfVariation, mean, stddev } from '../src/util/stats.js';

describe('文本处理', () => {
  it('UTF-8 字节数区别中文与 ASCII', () => {
    expect(byteLength('中文abc')).toBe(9);
  });
  it('未超字节预算保持原文', () => {
    expect(truncateBytes('中文', 6)).toBe('中文');
  });
  it('截断中文保留完整字符、完整标记且不超预算', () => {
    const text = truncateBytes('中文内容'.repeat(10), 31);
    expect(text).toBe('中文内容…（已截断）');
    expect(byteLength(text)).toBeLessThanOrEqual(31);
    expect(text).not.toContain('\uFFFD');
  });
  it('截断不切断四字节 Unicode 字符', () => {
    const rareHan = String.fromCodePoint(0x20000);
    const text = truncateBytes(rareHan.repeat(20), 23);
    expect(text).toBe(rareHan + '…（已截断）');
    expect(byteLength(text)).toBeLessThanOrEqual(23);
  });
  it.each([0, 1, 2, 3, 7, 17, 18])('预算过小仍严格限制字节：%s', (budget) => {
    const text = truncateBytes('中文内容'.repeat(10), budget);
    expect(byteLength(text)).toBeLessThanOrEqual(budget);
    expect(text).not.toContain('\uFFFD');
  });
  it('非法预算明确拒绝', () => {
    expect(() => truncateBytes('abc', -1)).toThrow('maxBytes');
    expect(() => truncateBytes('abc', 1.5)).toThrow('maxBytes');
  });
  it('去除脚本样式、注释并解码命名和数字实体', () => {
    expect(stripHtml('<style>a{}</style><script>alert(1)</script><!-- 隐藏 --><p>你好&nbsp;&amp; &#20013; &#x6587;</p><div>&lt;内容&gt;</div>')).toBe('你好 & 中 文 <内容>');
  });
  it('保留未知或非法实体，不抛异常', () => {
    expect(stripHtml('<b>&unknown; &#x110000;</b>')).toBe('&unknown; &#x110000;');
  });
  it.each(['价格 a < b 时保留正文', '方向 <- 左', '比较式 a<b', '喜爱 <3'])('正文中的尖括号不会吞掉后续标签之前的内容：%s', (text) => {
    expect(stripHtml(`${text}<p>最新价格</p>`)).toBe(`${text} 最新价格`);
  });
  it('分别清理文档声明、XML 声明和真正标签', () => {
    expect(stripHtml('<?xml version="1.0"?><!DOCTYPE html><DIV class="price">价格</DIV><br/>更新')).toBe('价格 更新');
  });
  it('原型属性名实体保持原文，合法实体仍正常解码', () => {
    expect(stripHtml('&constructor; &toString; &valueOf; &AMP;')).toBe('&constructor; &toString; &valueOf; &');
  });
  it('行差异使用集合并归一化 Windows 换行', () => {
    expect(lineDiff('a\r\nb\r\nb', 'b\nc')).toEqual({ added: ['c'], removed: ['a'], changeRatio: 2 / 3 });
  });
  it('未变化的行与空内容差异为零', () => {
    expect(lineDiff('a\nb', 'a\nb')).toEqual({ added: [], removed: [], changeRatio: 0 });
    expect(lineDiff('', '')).toEqual({ added: [], removed: [], changeRatio: 0 });
  });
  it('全文新增或删除比例为一', () => {
    expect(lineDiff('', 'a\nb')).toEqual({ added: ['a', 'b'], removed: [], changeRatio: 1 });
    expect(lineDiff('a\nb', '').changeRatio).toBe(1);
  });
  it('slug 保留中文并统一符号与大小写', () => {
    expect(slugify('  每日报告 / My Report !! ')).toBe('每日报告-my-report');
  });
  it('slug 为空时回退，最长 40 个字符', () => {
    expect(slugify(' !! / ')).toBe('routine');
    expect([...slugify('中'.repeat(50))]).toHaveLength(40);
    expect(slugify('a'.repeat(39) + ' --- b')).toBe('a'.repeat(39));
  });
});

describe('稳定序列化和哈希', () => {
  it('递归排序对象键且去掉 undefined', () => {
    const a = { b: { y: 2, x: 1 }, a: 0, missing: undefined };
    const b = { a: 0, b: { x: 1, y: 2 } };
    expect(stableStringify(a)).toBe('{"a":0,"b":{"x":1,"y":2}}');
    expect(stableStringify(a)).toBe(stableStringify(b));
  });
  it('数组去掉 undefined 但其余元素保序', () => {
    expect(stableStringify([2, undefined, 1])).toBe('[2,1]');
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]));
  });
  it('共享对象不是循环引用', () => {
    const shared = { x: 1 };
    expect(stableStringify([shared, shared])).toBe('[{"x":1},{"x":1}]');
  });
  it('循环引用和非 JSON 值拒绝序列化', () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => stableStringify(cycle)).toThrow('循环');
    expect(() => stableStringify(Number.NaN)).toThrow('非有限');
    expect(() => stableStringify(1n)).toThrow('JSON');
  });
  it('sha1 与 sha256 对应已知向量', () => {
    expect(sha1Hex('abc')).toBe('a9993e364706816aba3e25717850c26c9cd0d89d');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
  it('指纹固定 16 位并保留各参数边界', () => {
    expect(fingerprint({ b: 2, a: 1 })).toBe(fingerprint({ a: 1, b: 2 }));
    expect(fingerprint('ab', 'c')).not.toBe(fingerprint('a', 'bc'));
    expect(fingerprint('hello')).toMatch(/^[a-f0-9]{16}$/);
  });
  it('指纹匹配固定 SHA-1 向量的前 16 位', () => {
    expect(fingerprint('hello')).toBe('2b598ac4c54a2977');
    expect(fingerprint('hello')).toBe(sha1Hex('["hello"]').slice(0, 16));
  });
});

describe('注入式 ID 与统计', () => {
  it('固定随机源生成精确 10 位小写 base36 后缀', () => {
    expect(newId('b', { next: () => 0 })).toBe('b_0000000000');
    expect(newId('asp', { next: () => 0.999999 })).toBe('asp_zzzzzzzzzz');
  });
  it('随机源不合法时拒绝生成 ID', () => {
    expect(() => newId('b', { next: () => 1 })).toThrow('随机源');
    expect(() => newId('b', { next: () => -0.1 })).toThrow('随机源');
  });
  it('计算均值与总体标准差', () => {
    expect(mean([1, 2, 3])).toBe(2);
    expect(stddev([1, 2, 3])).toBeCloseTo(Math.sqrt(2 / 3));
  });
  it('空样本和单样本的波动为零', () => {
    expect(mean([])).toBe(0);
    expect(stddev([])).toBe(0);
    expect(stddev([3])).toBe(0);
    expect(coefficientOfVariation([])).toBe(0);
    expect(coefficientOfVariation([3])).toBe(0);
  });
  it('变异系数区分均匀与变化间隔，零均值返回零', () => {
    expect(coefficientOfVariation([5, 5, 5])).toBe(0);
    expect(coefficientOfVariation([1, 1, 10])).toBeGreaterThan(0.5);
    expect(coefficientOfVariation([0, 0])).toBe(0);
  });
  it('拒绝不有限的统计样本', () => {
    expect(() => mean([Number.NaN])).toThrow('样本');
    expect(() => stddev([Infinity])).toThrow('样本');
    expect(() => coefficientOfVariation([-Infinity])).toThrow('样本');
  });
});

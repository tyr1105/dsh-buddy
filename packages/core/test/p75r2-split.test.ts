/**
 * P75r2 第 2.1 节：切句 splitSentences 与按名额分组 packUnits（纯函数）。
 * 每条规则一个正例一个反例；通用断言：各句首尾相接（不计去掉的空白和换行）等于原文，每句都不超过上限。
 */
import { describe, expect, it } from 'vitest';
import { SKILL_DEFAULTS } from '../src/config/defaults.js';
import { dedupeTitle, oneLine, packUnits, splitSentences } from '../src/migrate/p75-split.js';

const MAX = SKILL_DEFAULTS.SENTENCE_MAX_CHARS;
const size = (text: string) => [...text].length;
/** 去掉所有空白和换行，用来比较「首尾相接等于原文」。 */
const squash = (text: string) => text.replace(/\s+/g, '');

/** 通用断言：不丢字、每句不超限、没有空句。 */
function expectLossless(original: string, sentences: string[]) {
  expect(squash(sentences.join(''))).toBe(squash(original));
  for (const sentence of sentences) {
    expect(size(sentence)).toBeLessThanOrEqual(MAX);
    expect(sentence.trim()).not.toBe('');
    expect(sentence).toBe(sentence.trim());
  }
}

describe('P75r2 切句', () => {
  it('没有标点的 200 字：按上限硬切成 80、80、40', () => {
    const text = Array.from({ length: 200 }, (_, index) => String.fromCharCode(0x4e00 + index)).join('');
    const sentences = splitSentences(text);
    expect(sentences.map(size)).toEqual([80, 80, 40]);
    expectLossless(text, sentences);
  });

  it('只有逗号的 200 字：按逗号切开后依次合并回去，每句不超限、不丢字', () => {
    const text = Array.from({ length: 40 }, (_, index) => `第${String(index).padStart(2, '0')}段文字内容，`).join('') + '结尾';
    expect(size(text)).toBeGreaterThan(200 - 1);
    const sentences = splitSentences(text);
    expectLossless(text, sentences);
    // 合并是尽量装满：除最后一句外，每句再并上下一句的第一小段就会超限，所以句数不会比「按上限均分」多出很多。
    expect(sentences.length).toBeLessThanOrEqual(Math.ceil(size(text) / MAX) + 1);
    // 标点留在前一小段的末尾：不以逗号开头。
    for (const sentence of sentences) expect(sentence.startsWith('，')).toBe(false);
  });

  it('带句号的长段：句号保留在句末，每句一句话', () => {
    const one = '先打开报名表核对每一行的日期是否填写完整并且格式一致。';
    const text = one.repeat(6);
    expect(size(text)).toBeGreaterThan(MAX);
    const sentences = splitSentences(text);
    expect(sentences).toEqual(Array.from({ length: 6 }, () => one));
    expectLossless(text, sentences);
    for (const sentence of sentences) expect(sentence.endsWith('。')).toBe(true);
  });

  it('带换行的多行：换行不保留，每行各自成句，不超限的行不再按标点拆', () => {
    const text = '第一行。还有半句\n\n第二行\n第三行！';
    const sentences = splitSentences(text);
    expect(sentences).toEqual(['第一行。还有半句', '第二行', '第三行！']);
    expectLossless(text, sentences);
  });

  it('反例：不超限的一段原样一句（含句号也不拆），空白和空段丢弃', () => {
    expect(splitSentences('报名表在共享盘。导出用表格格式。')).toEqual(['报名表在共享盘。导出用表格格式。']);
    expect(splitSentences('   \n  \n')).toEqual([]);
    expect(splitSentences('')).toEqual([]);
  });

  it('混合：长段里有句号也有无标点的超长小段，全部不丢字、不超限', () => {
    const text = `${'短句。'.repeat(3)}${'甲'.repeat(150)}，${'乙'.repeat(30)}！结尾`;
    const sentences = splitSentences(text);
    expectLossless(text, sentences);
  });
});

describe('P75r2 按名额分组 packUnits', () => {
  const unit = (count: number, tag: string) => Array.from({ length: count }, (_, index) => `${tag}${index}`);

  it('放得下就装在同一组；放不下整个单元时另起一组，一个单元不拆到两组', () => {
    const groups = packUnits([unit(5, 'a'), unit(5, 'b'), unit(5, 'c')]);
    // 5+5=10，再装 5 会超过 12：c 另起一组。
    expect(groups.map(group => group.map(part => part.unit))).toEqual([[0, 1], [2]]);
    expect(groups.map(group => group.reduce((sum, part) => sum + part.items.length, 0))).toEqual([10, 5]);
  });

  it('反例：单元自己超过 12 句才拆，每 12 句一段，最后不满的一段继续装后面的单元', () => {
    const groups = packUnits([unit(3, 'a'), unit(30, 'b'), unit(2, 'c')]);
    expect(groups.map(group => group.map(part => [part.unit, part.items.length]))).toEqual([
      [[0, 3]], [[1, 12]], [[1, 12]], [[1, 6], [2, 2]],
    ]);
  });

  it('没有句子的单元不进任何组；全空返回空数组', () => {
    expect(packUnits([[], unit(1, 'x'), []]).map(group => group.map(part => part.unit))).toEqual([[1]]);
    expect(packUnits([[], []])).toEqual([]);
  });
});

describe('P75r2 标题类字段', () => {
  it('oneLine：换行和制表符（连续的合并）换成一个空格；反例：普通空格不动', () => {
    expect(oneLine('a\tb\nc\r\n\r\nd')).toBe('a b c d');
    expect(oneLine('a b')).toBe('a b');
  });

  it('dedupeTitle：同名加（2）（3）；总长不超过 20 字', () => {
    const used = new Set<string>();
    expect(dedupeTitle('我的做法', used)).toBe('我的做法');
    expect(dedupeTitle('我的做法', used)).toBe('我的做法（2）');
    expect(dedupeTitle('我的做法', used)).toBe('我的做法（3）');
    const long = '长'.repeat(25);
    const first = dedupeTitle(long, used);
    const second = dedupeTitle(long, used);
    expect(size(first)).toBe(20);
    expect(size(second)).toBeLessThanOrEqual(20);
    expect(second.endsWith('（2）')).toBe(true);
  });
});

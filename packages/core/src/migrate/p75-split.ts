/**
 * P75r2 迁移用的文字小工具：切句、按名额分组、技能名称去重、标题类字段去换行。
 *
 * 为什么单独成文件：这些都是不读存储的纯函数，迁移的计划段和测试都要直接用它们；
 * 放在一起便于逐条测试「不丢字、每句不超限」。
 * 迁移的原则是：旧数据由员工（模型）写，长度和形状没有保证，切句与分组必须保证「不丢字、不超限、不整次失败」。
 */
import { SKILL_DEFAULTS as SD } from '../config/defaults.js';

/** 句末标点：切在它之后，标点留在前一句的末尾。 */
const END_MARKS = new Set(['。', '！', '？', '；', '!', '?', ';']);
/** 逗号类标点：句子仍然超长时再按它切，标点留在前一小段的末尾。 */
const COMMA_MARKS = new Set(['，', '、', ',']);

/** 完整字符数（一个汉字、一个标点各算一个）。 */
const size = (text: string): number => [...text].length;

/** 在每个标点之后切开（标点留在前一段末尾）；没有标点的尾巴单独成一段。 */
function cutAfter(text: string, marks: Set<string>): string[] {
  const out: string[] = [];
  let buffer = '';
  for (const char of text) {
    buffer += char;
    if (marks.has(char)) { out.push(buffer); buffer = ''; }
  }
  if (buffer !== '') out.push(buffer);
  return out;
}

/** 按上限硬切：每段不超过 max 个字符。 */
function hardCut(text: string, max: number): string[] {
  const chars = [...text];
  const out: string[] = [];
  for (let index = 0; index < chars.length; index += max) out.push(chars.slice(index, index + max).join(''));
  return out;
}

/**
 * 把一段文字切成每句不超过 SENTENCE_MAX_CHARS 个字的句子，不丢字（审查 L5）：
 * 1. 先按换行切（换行不保留）；一行不超上限就是一句；
 * 2. 超长的行按句末标点切（标点留在句末）；
 * 3. 仍然超长的，按逗号类标点切，再把相邻的小段在不超上限的前提下依次合并回去；
 * 4. 仍然超长的小段按上限硬切；
 * 5. 每段去掉首尾空白，空段丢弃。
 * 各句首尾相接（不计去掉的空白和换行）等于原文。
 */
export function splitSentences(raw: string): string[] {
  const max = SD.SENTENCE_MAX_CHARS;
  const out: string[] = [];
  const push = (piece: string) => { const value = piece.trim(); if (value !== '') out.push(value); };
  for (const line of raw.split(/\r\n|\r|\n/)) {
    if (size(line.trim()) <= max) { push(line); continue; }
    for (const sentence of cutAfter(line, END_MARKS)) {
      if (size(sentence.trim()) <= max) { push(sentence); continue; }
      // 句子仍然超长：按逗号切成小段，再把相邻小段尽量合并回去（合并后不超上限）。
      const merged: string[] = [];
      let current = '';
      for (const segment of cutAfter(sentence, COMMA_MARKS)) {
        if (size(segment) > max) {
          // 单个小段自己就超长：先收掉手头合并的，再单独放（后面硬切）。
          if (current !== '') { merged.push(current); current = ''; }
          merged.push(segment);
        } else if (size(current) + size(segment) <= max) {
          current += segment;
        } else {
          merged.push(current);
          current = segment;
        }
      }
      if (current !== '') merged.push(current);
      for (const piece of merged) for (const cut of hardCut(piece, max)) push(cut);
    }
  }
  return out;
}

/**
 * 把若干「单元」（一个步骤、一条教训）依次装进技能：每条技能最多 SENTENCES_MAX 句。
 * 一个单元的各句不拆到两条技能里：当前这条放不下整个单元时另起一条；单元自己就超过上限的才拆（从新的一条起，每 12 句一条）。
 * 返回分好的组：每组是若干「（单元序号, 这一段的句子）」，按原顺序，不含空组；没有句子的单元不进任何组。
 */
export function packUnits<T>(units: T[][]): Array<Array<{ unit: number; items: T[] }>> {
  const max = SD.SENTENCES_MAX;
  const groups: Array<Array<{ unit: number; items: T[] }>> = [];
  let current: Array<{ unit: number; items: T[] }> = [];
  let used = 0;
  const close = () => { if (current.length > 0) groups.push(current); current = []; used = 0; };
  units.forEach((items, unit) => {
    if (items.length === 0) return;
    if (items.length > max) {
      // 单元自己就超过上限：先收掉当前这条，再每 max 句一条（最后不满的一条还可以接着装后面的单元）。
      close();
      for (let start = 0; start < items.length; start += max) {
        const part = items.slice(start, start + max);
        if (start + max < items.length) groups.push([{ unit, items: part }]);
        else { current = [{ unit, items: part }]; used = part.length; }
      }
      return;
    }
    if (used + items.length > max) close();
    current.push({ unit, items });
    used += items.length;
  });
  close();
  return groups;
}

/** 标题类字段（技能名称、什么时候用）里的换行和制表符换成一个空格（连续的合并成一个）；其他控制字符见 cleanControl。 */
export function oneLine(text: string): string {
  return text.replace(/[\r\n\t]+/g, ' ');
}

/**
 * 控制字符：与技能字段（model/skill.ts 的 CONTROL_CHARS）拒绝的是同一组——C0（含换行、回车、制表符）、DEL、C1、行分隔符、段分隔符。
 * 为什么在这里再写一遍：model/ 不在本次改动范围；测试 p75r4-sanitize 逐个字符核对两边一致，改一边忘了另一边会立刻失败。
 * 用字符串转义构造，源码里不放特殊字符本身。
 */
const CONTROL_CHARS_ALL = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]', 'g');

/**
 * P75r4 第 2 节：把文字里每一个制表符和其他控制字符各换成一个空格，再去掉首尾空白。
 * 为什么：旧数据由员工（模型）写，常见从表格里抄来的制表符；技能字段不接受控制字符，
 * 不先换掉的话，一个字符就会让整句、整组被拒绝。换完为空的由调用方按空句规则处理。
 */
export function cleanControl(text: string): string {
  return text.replace(CONTROL_CHARS_ALL, ' ').trim();
}

/** 技能名称去重：同名时加「（2）」「（3）」等后缀（总长不超过 TITLE_MAX_CHARS）。 */
export function dedupeTitle(raw: string, used: Set<string>): string {
  const base = [...raw.trim()].slice(0, SD.TITLE_MAX_CHARS).join('');
  if (!used.has(base)) { used.add(base); return base; }
  for (let n = 2; ; n += 1) {
    const suffix = `（${n}）`;
    const room = Math.max(1, SD.TITLE_MAX_CHARS - [...suffix].length);
    const candidate = [...base].slice(0, room).join('') + suffix;
    if (!used.has(candidate)) { used.add(candidate); return candidate; }
  }
}

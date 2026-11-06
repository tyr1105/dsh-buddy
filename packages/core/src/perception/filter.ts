/** 关注过滤只接受关键词或受限正则；先拒绝危险语法，再匹配有界文本，保护宿主事件线程。 */
import type { Settings } from '../model/settings.js';
import { truncateBytes } from '../util/text.js';

/** 创建、修改和旧数据匹配共用校验，防止从其他入口带入灾难性回溯表达式。 */
export function validateWatchFilter(filter: string | null | undefined, settings: Settings): void {
  if (!filter || !filter.startsWith('/') || !filter.endsWith('/')) return;
  const source = filter.slice(1, -1);
  if (source.length > settings.c02.watchFilterRegexMaxChars) throw new Error('filter：正则表达式不能超过 200 字符');
  if (/\\(?:[1-9]|k<)/.test(source)) throw new Error('filter：不支持反向引用');
  // 分组只允许普通分组与非捕获分组，不支持环视等复杂执行语义。
  if (/\(\?(?!:)/.test(source)) throw new Error('filter：不支持环视或命名分组');
  const groups: Array<{ quantified: boolean; alternative: boolean }> = [{ quantified: false, alternative: false }];
  let previousGroup: { quantified: boolean; alternative: boolean } | null = null;
  let inClass = false;
  let variableQuantifiers = 0;
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!;
    if (char === '\\') { i++; previousGroup = null; continue; }
    if (char === '[') inClass = true;
    if (inClass) { if (char === ']') inClass = false; continue; }
    if (char === '(') { groups.push({ quantified: false, alternative: false }); previousGroup = null; if (source.slice(i + 1, i + 3) === '?:') i += 2; continue; }
    if (char === ')') {
      previousGroup = groups.length > 1 ? groups.pop()! : null;
      if (previousGroup?.quantified) groups[groups.length - 1]!.quantified = true;
      if (previousGroup?.alternative) groups[groups.length - 1]!.alternative = true;
      continue;
    }
    if (char === '|') groups[groups.length - 1]!.alternative = true;
    if ('*+?'.includes(char) || (char === '{' && /^\{\d+(?:,\d*)?\}/.test(source.slice(i)))) {
      if (previousGroup?.quantified || previousGroup?.alternative) throw new Error('filter：不支持嵌套量词或重复的分支分组');
      // 相邻多个可变重复也可能形成组合回溯（a+a+a+b）；保守子集最多容许一个。
      if ('*+?'.includes(char) || /^\{\d+,/.test(source.slice(i))) variableQuantifiers++;
      if (variableQuantifiers > 1) throw new Error('filter：受限正则最多包含一个可变重复量词');
      groups[groups.length - 1]!.quantified = true;
      if (char === '{') i += /^\{\d+(?:,\d*)?\}/.exec(source.slice(i))![0].length - 1;
    }
    previousGroup = null;
  }
  try { new RegExp(source); } catch { throw new Error('filter：正则表达式无效'); }
}

/** 旧持久数据也先经过同一拒绝策略；无效规则不执行正则，只按未命中处理。 */
export function matchesWatchFilter(filter: string | null, text: string, settings: Settings): boolean {
  if (!filter) return true;
  const bounded = truncateBytes(text, settings.c02.watchFilterMaxBytes);
  try {
    validateWatchFilter(filter, settings);
    return filter.startsWith('/') && filter.endsWith('/') ? new RegExp(filter.slice(1, -1)).test(bounded) : bounded.includes(filter);
  } catch { return false; }
}

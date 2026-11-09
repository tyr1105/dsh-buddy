/** 文本处理只操作输入内容，不访问外部环境；字节预算按 UTF-8 计算，避免中文被截成乱码。 */

const TRUNCATION_MARK = '…（已截断）';

/** 可选回复与汇报的空值不产生消息；只识别完整 null 占位，保留正文及其原有排版。 */
export function optionalMessageText(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed === '' || trimmed === 'null' ? null : value;
}

/** 计算正文的实际 UTF-8 字节数，供存储和输出共用同一预算口径。 */
export function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** 按完整 Unicode 码点累积字节，不能直接截取字节数组或 UTF-16 下标。 */
function prefixWithinBytes(text: string, maxBytes: number): string {
  let result = '';
  let used = 0;
  for (const character of text) {
    const size = byteLength(character);
    if (used + size > maxBytes) break;
    result += character;
    used += size;
  }
  return result;
}

/** 若预算连完整提示也放不下，仅保留提示中可容纳的前缀，优先保证字节上限。 */
export function truncateBytes(text: string, maxBytes: number): string {
  if (!Number.isInteger(maxBytes) || maxBytes < 0) throw new Error('maxBytes 必须是非负整数字节数');
  if (byteLength(text) <= maxBytes) return text;
  const markBytes = byteLength(TRUNCATION_MARK);
  if (maxBytes < markBytes) return prefixWithinBytes(TRUNCATION_MARK, maxBytes);
  return prefixWithinBytes(text, maxBytes - markBytes) + TRUNCATION_MARK;
}

/** 去掉不供阅读的块和标签，再解码实体；实体中的尖括号属于正文，不二次当标签删掉。 */
export function stripHtml(html: string): string {
  // Map 不继承对象原型；未知实体不能误取 constructor 等内置属性。
  const entities = new Map([
    ['amp', '&'], ['lt', '<'], ['gt', '>'], ['quot', '"'], ['apos', "'"],
    ['nbsp', ' '], ['ensp', ' '], ['emsp', ' '], ['ndash', '–'], ['mdash', '—'],
    ['hellip', '…'], ['copy', '©'], ['reg', '®'],
  ]);
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<!DOCTYPE\b[^>]*>/gi, ' ')
    .replace(/<\?xml\b[\s\S]*?\?>/gi, ' ')
    // 标签必须以英文字母起头，且不能跨过另一个 <，保住 a<b 后面的正文。
    .replace(/<\/?[A-Za-z][^<>]*>/g, ' ')
    .replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (original, entity: string) => {
      if (!entity.startsWith('#')) return entities.get(entity.toLowerCase()) ?? original;
      const point = entity.slice(0, 2).toLowerCase() === '#x' ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : original;
    })
    .replace(/\s+/g, ' ').trim();
}

/** 用行集合求新增与删除；差异占并集的比例，对重复行不重复计数。 */
export function lineDiff(oldText: string, newText: string): { added: string[]; removed: string[]; changeRatio: number } {
  const lines = (text: string): Set<string> => new Set(text === '' ? [] : text.replace(/\r\n?/g, '\n').split('\n'));
  const oldLines = lines(oldText);
  const newLines = lines(newText);
  const added = [...newLines].filter((line) => !oldLines.has(line));
  const removed = [...oldLines].filter((line) => !newLines.has(line));
  const total = new Set([...oldLines, ...newLines]).size;
  return { added, removed, changeRatio: total === 0 ? 0 : (added.length + removed.length) / total };
}

/** 保留中文字母和数字，把符号压成单个连字符；按码点限制长度以免截断字符。 */
export function slugify(name: string): string {
  const normalized = name.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
  return [...normalized].slice(0, 40).join('').replace(/-+$/g, '') || 'routine';
}

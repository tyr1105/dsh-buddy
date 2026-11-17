/**
 * 记忆视图里两句共用的文字（P75r1）：适用范围一行、主人原话一行。
 *
 * 为什么单独一个文件：「已记住」一行（memory-views.ts）和记忆页（memory-page-views.ts）都要显示这两句，
 * 必须是同一个函数生成的，两处才不会写法不一致。主人要当场核对：总管记下的内容是不是自己说的那件事、范围有没有被放大。
 * 纯函数，只吃显式给出的数据，不碰存储和时钟。
 */
import { MEMORY_DEFAULTS as D } from '../config/defaults.js';
import type { Memory } from '../model/memory.js';

/**
 * 适用范围一行（规矩、偏好）：三种形状——「用于全部员工、全部项目」「用于林舟」「用于林舟，仅用于报价页」。
 * 员工或项目已不存在时写「已离队的员工」「已删除的项目」。
 */
export function memoryScopeLine(row: Pick<Memory, 'scope'>, botNames: ReadonlyMap<string, string>, projectNames: ReadonlyMap<string, string>): string {
  const staff = row.scope.staff === 'all' ? '全部员工' : row.scope.staff.map(id => botNames.get(id) ?? '已离队的员工').join('、');
  if (row.scope.projects !== 'all') return `用于${staff}，仅用于${row.scope.projects.map(id => projectNames.get(id) ?? '已删除的项目').join('、')}`;
  return row.scope.staff === 'all' ? '用于全部员工、全部项目' : `用于${staff}`;
}

/**
 * 主人原话一行：「你说：「{原话}」」。原话压成一行后取前 QUOTE_VIEW_CHARS（40）个字，超出的在末尾加「…」；恰好 40 个字不加。
 * 原话为空（旧形状的记录没有记下）时返回 null。
 */
export function quoteLineOf(quote: string): string | null {
  const oneLine = [...quote.replace(/\s+/g, ' ').trim()];
  if (oneLine.length === 0) return null;
  const shown = oneLine.slice(0, D.QUOTE_VIEW_CHARS).join('');
  return `你说：「${shown}${oneLine.length > D.QUOTE_VIEW_CHARS ? '…' : ''}」`;
}

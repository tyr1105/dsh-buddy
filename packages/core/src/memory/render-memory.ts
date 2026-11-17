/**
 * 把记忆整理成身份文件里的「主人的规矩与偏好」段（P75c）。
 *
 * 排版规则（方案 7.5「写进提示词」）：
 * - 顺序：红线、规矩、偏好；同类内按被引用次数多的在前，再按更新时间新的在前。
 * - 每条一行：「- 红线：{text}」「- 规矩：{text}（例如：{example}）」「- 偏好：{text}」；
 *   适用范围不是全部项目时，行尾加「（仅用于{项目名、项目名}）」。
 * - 整段不超过 AGENTS_SECTION_MAX_BYTES（2 KB），按整条截断，不把一条规矩切成半句；
 *   有被截掉的，末行写「另有 {n} 条未列出。」；一条也没有时写「暂无」。
 *
 * 为什么按整条截断：半句规矩可能意思相反（「不要……」被截成「要……」之外的残句），宁可整条不列并如实告知有几条没列。
 * 本文件只读存储，不写任何东西。
 */
import { MEMORY_DEFAULTS as D } from '../config/defaults.js';
import type { HubContext } from '../engine/context.js';
import type { Memory } from '../model/memory.js';
import { byteLength } from '../util/text.js';
import { memoryCitations } from './memory-read.js';

/** 排序用的类别序号：红线 0、规矩 1、偏好 2。 */
function classRank(row: Memory): number {
  if (row.redLine) return 0;
  return row.kind === 'rule' ? 1 : 2;
}

/** 一条记忆的一行文字（不含换行）。 */
export function memoryLine(ctx: HubContext, row: Memory): string {
  const head = row.redLine ? '红线' : row.kind === 'rule' ? '规矩' : '偏好';
  // 红线一行只写文字；普通规矩带例子；偏好没有例子。
  const example = row.kind === 'rule' && !row.redLine && row.example !== null ? `（例如：${row.example}）` : '';
  let scope = '';
  if (row.scope.projects !== 'all') {
    const names = row.scope.projects.map(id => ctx.store.table('projects').get(id)?.name ?? '已删除的项目');
    scope = `（仅用于${names.join('、')}）`;
  }
  return `- ${head}：${row.text}${example}${scope}`;
}

/** 按规则排序：类别、被引用次数（多的在前）、更新时间（新的在前）。 */
export function sortMemories(ctx: HubContext, rows: readonly Memory[]): Memory[] {
  // 被引用次数一次现算（排序里要反复比较，不能每次比较都重算）。
  const cited = memoryCitations(ctx);
  const countOf = (id: string): number => cited.get(id) ?? 0;
  return [...rows].sort((a, b) => classRank(a) - classRank(b)
    || countOf(b.id) - countOf(a.id) || b.updatedAt - a.updatedAt);
}

/** 「规矩与偏好」段的正文，以及整段里必须原样保留的行数（调用方整体截断时，这几行不能被截掉）。 */
export interface MemorySectionParts {
  text: string;
  /**
   * 有红线时等于整段的行数（红线正文里的换行也各算一行；整段本身已受 2 KB 上限约束，红线超出的部分除外，
   * 连「另有 n 条未列出。」那一行也保留，让员工知道有几条没列）；没有红线为 0（整段仍可被整体截断）。
   */
  protectedLines: number;
}

/**
 * 生成「规矩与偏好」段的正文：红线全部列出、排在最前、不受字节上限截断（P75r2）；
 * 其余的整条截断、超出时末行写明几条未列出；没有记忆时写「暂无」。
 * 为什么红线不截断：红线是主人明确说「不能越过」的事，一条很长的红线整条放不下而被「另有 n 条未列出」替代，等于没写。
 * 其余条目可用的字节数是上限减去红线占用的字节数（不够就一条也不列，末行写明几条未列出）。
 */
export function memorySectionParts(ctx: HubContext, rows: readonly Memory[]): MemorySectionParts {
  if (rows.length === 0) return { text: '暂无', protectedLines: 0 };
  // 红线（redLine 为真）全部列出，不受上限截断；其余条目的字节上限 = 上限减红线占的字节。
  // sortMemories 已把红线排在最前，这里按是否红线分开即可（两组内部顺序不变）。
  const sorted = sortMemories(ctx, rows);
  const red = sorted.filter(row => row.redLine).map(row => memoryLine(ctx, row));
  const others = sorted.filter(row => !row.redLine).map(row => memoryLine(ctx, row));
  const max = D.AGENTS_SECTION_MAX_BYTES;
  /** 汇总：有红线时整段都标为必须保留。 */
  const finish = (lines: string[]): MemorySectionParts => {
    const text = lines.join('\n');
    return { text, protectedLines: red.length === 0 ? 0 : text.split('\n').length };
  };
  if (byteLength([...red, ...others].join('\n')) <= max) return finish([...red, ...others]);
  // 红线之外没有别的条目：只列红线，没有「未列出」可说。
  if (others.length === 0) return finish(red);
  // 放不下：从末尾一条一条去掉其余条目，直到「红线 + 保留的几条 + 末行说明」在上限之内（说明里的条数随去掉的条数变化，每次重算）。
  const kept = [...others];
  const tail = (): string => `另有 ${others.length - kept.length} 条未列出。`;
  while (kept.length > 0 && byteLength([...red, ...kept, tail()].join('\n')) > max) kept.pop();
  return finish([...red, ...kept, tail()]);
}

/** 生成「规矩与偏好」段的正文（只要文字时用）。 */
export function memorySection(ctx: HubContext, rows: readonly Memory[]): string {
  return memorySectionParts(ctx, rows).text;
}

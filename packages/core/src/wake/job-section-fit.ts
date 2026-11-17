/**
 * 「你手上的事」段超过上限时的逐级压缩（P74r2d 第 1 条，替换 P74r1 的「按条删」做法；对应审查发现 G5、G11）。
 *
 * 为什么不再整条删条目：模型只看得到唤醒包，被删掉的条目、证据、做法说明，它无从得知；
 * 而核对人必须对每一条给结论，执行者必须逐条交回。所以改成逐级压缩：每一级把可以缩短的文字缩短，
 * 压到放得下为止；任何一级都不删下面这些：
 * - 末尾的做法说明（怎样交回、怎样提交结论、怎样提问和说明做不下去、不要直接找主人）；
 * - 执行者这一轮要改的条目的序号、核对人要给结论的每一条的序号；
 * - 每一项证据的编号和路径（或链接）。
 *
 * 四级压缩（具体每一级缩什么，由三种读者的写法自己决定，见 job-section.ts、job-section-chief.ts）：
 * - 第一级：证据的中心检查结果为正常时不写检查说明；路径改写成相对主题文件夹的路径，开头写一行说明；
 * - 第二级：证据的说明截到 40 字；
 * - 第三级：条目原文截到 60 字，清单后写一行「条目全文见约定文件」（只在真的截短了条目原文时才写）；
 * - 第四级：要改的条目的问题和「改到什么程度算过」各截到 120 字；总管的回答截到 600 字并写明放不下。
 * 四级之后仍超过上限（按参数上限推算不应出现）：记一条错误日志，按第四级的结果输出，允许超过上限，不做整段截断。
 *
 * 没有被压缩（第零级）时，输出就是各行按顺序拼接，与压缩逻辑无关。
 */
import { byteLength } from '../util/text.js';

/** 压缩级别：0 表示没有压缩，1 至 4 对应上面的四级。 */
export type CompressLevel = 0 | 1 | 2 | 3 | 4;

/** 最高级。 */
export const MAX_COMPRESS_LEVEL: CompressLevel = 4;

/** 可成行的清单：items 是全部条目；render 把条目拼成这一行的文字，没有条目时返回 null（整行不出现）。 */
export interface FlexRow {
  items: string[];
  render: (kept: string[]) => string | null;
}

/** 一段正文：开头的行、清单、清单后的补充说明（第三级的「条目全文见约定文件」）、末尾的做法说明。 */
export interface JobBodyParts {
  head: string[];
  flex: FlexRow[];
  /** 清单之后、做法说明之前的一行（没有就不写）。 */
  note?: string | null;
  tail: string[];
}

/** 把一段正文拼成文字：开头、清单、补充说明、末尾，逐行用换行连接。 */
export function composeJobBody(parts: JobBodyParts): string {
  const middle = parts.flex.flatMap(row => {
    const text = row.render(row.items);
    return text === null ? [] : [text];
  });
  return [...parts.head, ...middle, ...(parts.note ? [parts.note] : []), ...parts.tail].join('\n');
}

/** 压缩的结果：正文、实际用到的级别、四级之后是否仍超过上限。 */
export interface FitResult { text: string; level: CompressLevel; overflow: boolean }

/**
 * 从第零级起逐级压缩，第一个不超过 maxBytes 的就是结果。
 * build 按级别生成这一段正文；四级之后仍超限时，调用 onOverflow（让调用方记日志），照第四级的结果输出。
 */
export function fitJobBody(build: (level: CompressLevel) => JobBodyParts, maxBytes: number, onOverflow?: (bytes: number) => void): FitResult {
  let text = '';
  for (const level of [0, 1, 2, 3, 4] as const) {
    text = composeJobBody(build(level));
    if (byteLength(text) <= maxBytes) return { text, level, overflow: false };
  }
  onOverflow?.(byteLength(text));
  return { text, level: MAX_COMPRESS_LEVEL, overflow: true };
}

/** 截到 max 个字，超过时在后面加「…」（不计入 max）；返回截后的文字和有没有被截短。 */
export function clipWithEllipsis(text: string, max: number): { text: string; clipped: boolean } {
  const chars = [...text];
  return chars.length <= max ? { text, clipped: false } : { text: `${chars.slice(0, max).join('')}…`, clipped: true };
}

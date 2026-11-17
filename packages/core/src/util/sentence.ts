/**
 * 拼句子时的句末标点（P74r15 第 3 节）。
 *
 * 为什么需要：受阻说明、事实句常常自己已经以句号结尾（「老大的一个回合超过 60 分钟，中心已结束它。」），
 * 拼进更长的话时又在后面接「。」，主人就会看到「。。」。凡是「前一段文字 + 句号」的拼法都经过这个函数：
 * 前一段已经以句号、问号、叹号（全角、半角）结尾的不再加句号，否则补一个全角句号。
 */

/** 以句号、问号、叹号结尾（全角或半角，后面可以有空白）。 */
const ENDS_WITH_STOP = /[。？！.?!][\s]*$/u;

/** 去掉末尾空白；已经以句号、问号、叹号结尾的原样返回，否则补「。」。空文字原样返回。 */
export function closeSentence(text: string): string {
  const trimmed = text.replace(/[\s]+$/u, '');
  if (trimmed === '' || ENDS_WITH_STOP.test(trimmed)) return trimmed;
  return `${trimmed}。`;
}

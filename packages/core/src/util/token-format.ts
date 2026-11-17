/**
 * token 数量的显示写法：把很长的数字换算成带单位的短写法，给主人看。
 *
 * 为什么有这个文件：界面和核心拼给主人看的句子里，token（模型用量的计数单位）原来直接写完整数字，
 * 例如「1636469 token」，位数多了不好读。主人要求自动换算成 K、M、B、T 单位（2026-11-13，看板 P80）。
 *
 * 这是一个纯函数：只做数字到文字的换算，不读时间、文件或任何外部状态。
 * 界面（packages/plugin）里还有一份逐字相同的实现（src/shared/token-format.ts），原因是插件的
 * 浏览器端产物不能直接引用核心的总入口；两份的输出由插件测试逐条对照，改这里时两处同改。
 */

/** 单位表：K 千、M 百万、B 十亿、T 万亿。下标 0 对应「不换算」。 */
const UNITS = ['', 'K', 'M', 'B', 'T'] as const;

/**
 * 把 count 除以 divisor 之后保留三位有效数字：小于 10 保留两位小数，小于 100 保留一位，其余取整。
 * 先用整数乘以放大倍数再除，最后才缩回：这样 9995 除以 1000 这类恰好在 5 上的数不会被浮点误差判成 9.99。
 */
function threeSignificant(count: number, divisor: number): number {
  const value = count / divisor;
  const decimals = value < 10 ? 2 : value < 100 ? 1 : 0;
  const scale = 10 ** decimals;
  return Math.round((count * scale) / divisor) / scale;
}

/**
 * 把 token 数量写成带单位的短写法。
 *
 * 规则：
 * 1. 不是有限数、小于 0 的按 0；小数先四舍五入成整数。
 * 2. 小于 1000 原样写数字。
 * 3. 1000 及以上选「除以单位后不小于 1」的最大单位，保留三位有效数字；
 *    四舍五入后变成 1000 的，进到下一个单位；末尾多余的 0 和小数点去掉。
 * 4. 单位大写，数字和单位之间没有空格；超过 T 仍用 T，数字取整，不再往上换。
 */
export function formatTokenCount(n: number): string {
  // 第 1 步：规整输入。NaN、无穷大、负数一律当 0。
  const count = Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
  if (count < 1000) return String(count);

  // 第 2 步：选最大的、除下来不小于 1 的单位（最多到 T）。
  let unit = 1;
  while (unit < UNITS.length - 1 && count >= 1000 ** (unit + 1)) unit += 1;

  // 第 3 步：保留三位有效数字；变成 1000 且还有更大单位时进位，写成 1 加下一个单位。
  const rounded = threeSignificant(count, 1000 ** unit);
  if (rounded >= 1000 && unit < UNITS.length - 1) return `1${UNITS[unit + 1]}`;

  // String(number) 不会输出多余的 0（60 写成 "60"，1.5 写成 "1.5"），正好满足「去掉末尾 0」。
  return `${rounded}${UNITS[unit]}`;
}

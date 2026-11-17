/**
 * token 数量的显示写法（界面用的一份）。
 *
 * 为什么放一份在这里：这个函数的权威实现在核心（packages/core/src/util/token-format.ts）。
 * 插件的浏览器端产物不能引用核心的总入口（会把只有 Node 才有的模块一起打进浏览器包），
 * 而为这一个纯函数新增核心的子路径出口，要同时改核心的包配置和预览打包别名，不值得，
 * 所以这里放一份相同的实现；`test/p80-token-units.test.ts` 用同一张例子表逐条断言两份输出相同。
 * 改这里时核心那份同改。
 *
 * 另有 formatTokenTitle：界面上显示换算后数字的元素，鼠标悬停时显示完整数字（带千位分隔符）。
 */

/** 单位表：K 千、M 百万、B 十亿、T 万亿。下标 0 对应「不换算」。 */
const UNITS = ['', 'K', 'M', 'B', 'T'] as const

/**
 * 把 count 除以 divisor 之后保留三位有效数字：小于 10 保留两位小数，小于 100 保留一位，其余取整。
 * 先用整数乘以放大倍数再除，最后才缩回：这样 9995 除以 1000 这类恰好在 5 上的数不会被浮点误差判成 9.99。
 */
function threeSignificant(count: number, divisor: number): number {
  const value = count / divisor
  const decimals = value < 10 ? 2 : value < 100 ? 1 : 0
  const scale = 10 ** decimals
  return Math.round((count * scale) / divisor) / scale
}

/**
 * 把 token 数量写成带单位的短写法，规则与核心那份完全相同：
 * 小于 1000 原样；1000 及以上取最大单位（K、M、B、T），三位有效数字，进位到 1000 时进下一个单位，
 * 去掉多余的 0；不是有限数或小于 0 的按 0；超过 T 仍用 T。
 */
export function formatTokenCount(n: number): string {
  const count = Number.isFinite(n) && n > 0 ? Math.round(n) : 0
  if (count < 1000) return String(count)
  let unit = 1
  while (unit < UNITS.length - 1 && count >= 1000 ** (unit + 1)) unit += 1
  const rounded = threeSignificant(count, 1000 ** unit)
  if (rounded >= 1000 && unit < UNITS.length - 1) return `1${UNITS[unit + 1]}`
  return `${rounded}${UNITS[unit]}`
}

/**
 * 悬停提示：`{带千位分隔符的完整数字} token`，例如 `1,636,469 token`。
 * 先按同样的口径规整输入（非法值按 0、小数取整），再用固定的英文分隔符，不随浏览器语言变化。
 */
export function formatTokenTitle(n: number): string {
  const count = Number.isFinite(n) && n > 0 ? Math.round(n) : 0
  return `${count.toLocaleString('en-US')} token`
}

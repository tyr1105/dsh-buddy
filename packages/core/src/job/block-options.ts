/**
 * 「待你处理」里预计消耗条目、「没有进展」条目的选项文字（P74r5 第 1 节，P76f 改写）：只在这里定义一次。
 *
 * 为什么单独一个文件：条目的建立（budget-ask.ts、cap.ts、stall.ts）、条目建立时的选项校验（outreach/inbox.ts）、
 * 答复的校验和分流（blocked-answer.ts、budget-answer.ts）都要用同一份文字，各写各的字面量会在改字时漏掉一处。
 * 这个文件不依赖别的业务文件，谁都可以引用而不产生循环引用。
 *
 * 用词（主人定的书面说法）：「暂停」（可以恢复）与「已停止」（这件事不再做，终点）只差一个字，所以不用「先停下」；
 * 「再提醒一次」代替口语的「再叫一次」。
 *
 * P76f：「将超出预计」与「回合用到上限」合成一个条目，三个办法：「追加 {n} 个回合」「缩小范围」「暂停」（budgetOptions）。
 * 旧存档里开着的条目选项是「再给 8 个回合」「暂停」：只用于识别旧条目（LEGACY_TOP_UP_OPTION），答复时按「追加 8 个回合」处理。
 */

/** 两类条目共用的「暂停」选项：这件事转为「你已暂停」，之后总管 resume 才能恢复。 */
export const HOLD_OPTION = '暂停';

/** 「没有进展」条目的「再提醒一次」选项。 */
export const RETRY_OPTION = '再提醒一次';

/** 预计消耗条目的「缩小范围」选项。 */
export const NARROW_OPTION = '缩小范围';

/** 旧存档里「回合用到上限」条目的追加选项文字：只用于识别旧条目，新条目不再建。 */
export const LEGACY_TOP_UP_OPTION = '再给 8 个回合';

/** 旧条目的追加回合数，也是选办法、恢复时回合已用完而自动追加的回合数（这两处原来用 JOB_DEFAULTS 里固定的追加数）。 */
export const LEGACY_TOP_UP_TURNS = 8;

/** 追加回合选项的文字：「追加 {n} 个回合」。 */
export const topUpOptionOf = (n: number): string => `追加 ${n} 个回合`;

/** 预计消耗条目的三个答案（按钮文字）：追加 n 个回合、缩小范围、暂停。 */
export function budgetOptions(n: number): [string, string, string] {
  return [topUpOptionOf(n), NARROW_OPTION, HOLD_OPTION];
}

/** 「追加 {n} 个回合」选项的写法：n 为 1 到 99 的整数。 */
const TOP_UP_PATTERN = /^追加 ([1-9]\d?) 个回合$/;

/** 从选项文字里读出追加的回合数；不是追加选项返回 null。 */
export function topUpCountOf(text: string): number | null {
  const match = TOP_UP_PATTERN.exec(text);
  return match === null ? null : Number(match[1]);
}

/** 答复文字对应的办法：追加（带回合数）、缩小范围、暂停；都不是返回 null。旧选项「再给 8 个回合」按追加 8 个处理。 */
export type BudgetChoice = { kind: 'top_up'; n: number } | { kind: 'narrow' } | { kind: 'hold' };
export function budgetChoiceOf(text: string): BudgetChoice | null {
  if (text === LEGACY_TOP_UP_OPTION) return { kind: 'top_up', n: LEGACY_TOP_UP_TURNS };
  const n = topUpCountOf(text);
  if (n !== null) return { kind: 'top_up', n };
  if (text === NARROW_OPTION) return { kind: 'narrow' };
  if (text === HOLD_OPTION) return { kind: 'hold' };
  return null;
}

/** 条目建立时的选项校验：新条目必须是 budgetOptions 的形状；旧条目的两项仍认。返回错误文字，通过返回 null。 */
export function capOptionsProblem(options: readonly string[]): string | null {
  if (options.length === 2 && options[0] === LEGACY_TOP_UP_OPTION && options[1] === HOLD_OPTION) return null;
  if (options.length === 3 && topUpCountOf(options[0]!) !== null && options[1] === NARROW_OPTION && options[2] === HOLD_OPTION) return null;
  return `options：预计消耗条目的选项必须是「追加 n 个回合」（n 为 1 到 99 的整数）「${NARROW_OPTION}」「${HOLD_OPTION}」；旧条目是「${LEGACY_TOP_UP_OPTION}」「${HOLD_OPTION}」`;
}

/** 预计消耗条目的事项键：job:<jobId>:cap:<当时的预算线>。 */
export function capSubjectKey(jobId: string, turnCap: number): string {
  return `job:${jobId}:cap:${turnCap}`;
}

/** 「没有进展」条目没有可接手的人时的两个答案。 */
export const STALL_OPTIONS: [string, string] = [RETRY_OPTION, HOLD_OPTION];

/** 「换{名字}接手」选项的写法（P76g）：名字至少一个字，不含换行。 */
const TAKE_OVER_PATTERN = /^换([^\n]+)接手$/;

/** 「换{名字}接手」选项的文字。 */
export const takeOverOptionOf = (name: string): string => `换${name}接手`;

/** 从选项文字里读出要换上的人的名字；不是这种选项返回 null。 */
export function takeOverNameOf(text: string): string | null {
  const match = TAKE_OVER_PATTERN.exec(text);
  return match === null ? null : match[1]!;
}

/** 「没有进展」条目的全部选项：有可接手的人时在最前面加一项「换{名字}接手」。 */
export function stallOptionsOf(takeOverName: string | null): string[] {
  return takeOverName === null ? [...STALL_OPTIONS] : [takeOverOptionOf(takeOverName), ...STALL_OPTIONS];
}

/** 条目建立时的选项校验（没有进展）：两项，或「换{名字}接手」加两项。返回错误文字，通过返回 null。 */
export function stallOptionsProblem(options: readonly string[]): string | null {
  if (options.length === 2 && options[0] === RETRY_OPTION && options[1] === HOLD_OPTION) return null;
  if (options.length === 3 && takeOverNameOf(options[0]!) !== null && options[1] === RETRY_OPTION && options[2] === HOLD_OPTION) return null;
  return `options：没有进展条目的选项必须是「${RETRY_OPTION}」「${HOLD_OPTION}」，有可接手的人时在最前面加一项「换{名字}接手」`;
}

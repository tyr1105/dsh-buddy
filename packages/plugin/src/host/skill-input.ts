/**
 * 技能库四个入口的参数检查（P75j）：两个读取入口（技能库、技能详情）和两个命令（回退、放回）。
 *
 * 为什么单独成文件：真引擎门面（real-hub.ts）和离线样例门面（hub-facade.ts）都要用同一套检查，
 * 这样离线模式里缺参数、类型不对时看到的错误文字，与接真引擎之后完全一样。
 * core 的命令入口自己也会用 zod 再校验一次，但 zod 对「完全没传」这种情况给的是英文提示，
 * 所以宿主在边界先查一遍，错误一律是中文，并写明哪一项不对。
 */

/** 技能库入口的错误：message 就是给主人或开发者看的中文。 */
function badInput(message: string): never {
  throw new Error(message)
}

/** 取一个必填的非空文字参数；缺了、不是文字、只有空白都报中文错误。 */
export function requireSkillText(input: Record<string, unknown>, key: string): string {
  const value = input[key]
  if (value === undefined || value === null) badInput(`${key}：缺少这一项`)
  if (typeof value !== 'string') badInput(`${key}：必须是文字`)
  if (value.trim() === '') badInput(`${key}：不能为空`)
  return value
}

/** 取一个必填的正整数参数（版本号从 1 起）。 */
export function requireSkillVersionNo(input: Record<string, unknown>, key: string): number {
  const value = input[key]
  if (value === undefined || value === null) badInput(`${key}：缺少这一项`)
  if (typeof value !== 'number' || !Number.isInteger(value)) badInput(`${key}：必须是整数`)
  if (value < 1) badInput(`${key}：不能小于 1`)
  return value
}

/** 回退命令的参数：{ skillId, versionNo }，其余字段一律丢弃（界面传来的多余字段不进 core）。 */
export function rollbackSkillInput(raw: Record<string, unknown>): { skillId: string; versionNo: number } {
  return { skillId: requireSkillText(raw, 'skillId'), versionNo: requireSkillVersionNo(raw, 'versionNo') }
}

/** 放回命令的参数：{ skillId }。 */
export function restoreSkillInput(raw: Record<string, unknown>): { skillId: string } {
  return { skillId: requireSkillText(raw, 'skillId') }
}

/**
 * 记忆与学习选会话相关命令的参数检查（P75k）：撤销记住、更正、删除、撤销删除、撤销更正，以及学习选会话。
 *
 * 为什么单独成文件：真引擎门面（real-hub.ts）和离线样例门面（hub-facade.ts）都要用同一套检查，
 * 这样离线模式里缺参数、类型不对时看到的错误文字，与接真引擎之后完全一样（与 skill-input.ts 同一做法）。
 * core 的命令入口自己也会用 zod 再校验一次，但 zod 对「完全没传」这种情况给的是英文提示，
 * 所以宿主在边界先查一遍，错误一律是中文，并写明哪一项不对。
 * 只取命令需要的字段，界面传来的多余字段一律丢弃，不进 core。
 */

/** 记忆命令入口的错误：message 就是给主人或开发者看的中文。 */
function badInput(message: string): never {
  throw new Error(message)
}

/** 取一个必填的非空文字参数；缺了、不是文字、只有空白都报中文错误。 */
export function requireMemoryText(input: Record<string, unknown>, key: string): string {
  const value = input[key]
  if (value === undefined || value === null) badInput(`${key}：缺少这一项`)
  if (typeof value !== 'string') badInput(`${key}：必须是文字`)
  if (value.trim() === '') badInput(`${key}：不能为空`)
  return value
}

/** 撤销记住、删除、撤销删除、撤销更正这四个命令的参数：{ memoryId }。 */
export function memoryIdInput(raw: Record<string, unknown>): { memoryId: string } {
  return { memoryId: requireMemoryText(raw, 'memoryId') }
}

/** 更正命令的参数：{ memoryId, text }（文字长度与空白由 core 校验，错误同样是中文）。 */
export function correctMemoryInput(raw: Record<string, unknown>): { memoryId: string; text: string } {
  return { memoryId: requireMemoryText(raw, 'memoryId'), text: requireMemoryText(raw, 'text') }
}

/** 学习选会话命令的参数：{ runId, option }（runId 是提问卡视图里的学习记录编号，option 是被点的那个选项的文字）。 */
export function chooseLearnSessionInput(raw: Record<string, unknown>): { runId: string; option: string } {
  return { runId: requireMemoryText(raw, 'runId'), option: requireMemoryText(raw, 'option') }
}

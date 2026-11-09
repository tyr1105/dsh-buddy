/**
 * 项目会话里的 @ 队友规则（P37）。
 *
 * 为什么单独成文件：@ 只允许出现在「项目工作会话」里，候选人也必须同时满足
 * 「是这个项目的成员」「是在册队友」「不是正在对话的队友本人」。这些判断散在
 * 组件里，换个入口就会漏掉一条；收成纯函数后，普通会话不传上下文就不会有 @，
 * 项目会话的候选名单也能用固定输入单测钉死。
 */
import type { BotCard, ProjectViewRow } from '../../shared/views.js'

/** @ 菜单里的一项：只带画菜单需要的最小字段。 */
export interface MentionMember {
  botId: string
  name: string
  color: string
  initials: string
}

/**
 * 可 @ 的项目成员：项目成员名单 ∩ 在册队友。
 * - 名单里已失效（队友被删/改名查不到）的成员跳过，避免 @ 到一个不存在的人；
 * - 已退役的队友跳过：它不再处理项目里的事；
 * - 排除当前正在对话的队友本人（@ 自己没有意义）；
 * - 成员名单重复时只保留第一次出现，按项目里的成员顺序输出，菜单顺序稳定。
 */
export function mentionMembers(
  row: ProjectViewRow,
  bots: readonly BotCard[],
  excludeBotId: string,
): MentionMember[] {
  const byId = new Map(bots.map(bot => [bot.id, bot]))
  const seen = new Set<string>()
  const out: MentionMember[] = []
  for (const member of row.members) {
    if (member.invalid) continue
    if (seen.has(member.botId)) continue
    seen.add(member.botId)
    if (member.botId === excludeBotId) continue
    const bot = byId.get(member.botId)
    if (bot === undefined || bot.lifecycle === 'retired') continue
    out.push({ botId: bot.id, name: bot.name, color: bot.color, initials: bot.initials })
  }
  return out
}

/**
 * 把「@名字」插到光标处（或替换选中的文字），返回新文本与新光标位置。
 * 补空格规则：前面紧挨着字就补一个空格，避免出现「帮我@巡检员」；
 * 后面紧挨着字也补一个，避免「@巡检员看一下」粘成一个词；已有空白不重复补。
 */
export function insertMention(
  text: string,
  start: number,
  end: number,
  name: string,
): { text: string; caret: number } {
  const safeStart = Math.max(0, Math.min(start, text.length))
  const safeEnd = Math.max(safeStart, Math.min(end, text.length))
  const before = text.slice(0, safeStart)
  const after = text.slice(safeEnd)
  const lead = before === '' || /\s$/.test(before) ? '' : ' '
  const trail = after === '' || /^\s/.test(after) ? '' : ' '
  const inserted = `${lead}@${name}${trail}`
  return { text: before + inserted + after, caret: safeStart + inserted.length }
}

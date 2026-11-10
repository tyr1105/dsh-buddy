/**
 * 新会话页 @ 队友的规则（P57）。
 *
 * 主人定的口径，都在队友模式的新会话页：
 * - 没选项目：输入框最前面 @ 一位队友，这句话直接发给它本人，页面跳到和它的对话，
 *   DSH 自己的模型不跑；没有 @ 就是普通的 DSH 会话，不插手。
 * - 选了项目：@ 列项目成员，点名只是在文字里写上「@名字」，发送由项目标签统一接管。
 *
 * 为什么发给本人只能写在最前面、一次一位：要接管回车，宿主的「认领」机制
 * 只允许输入框开头的标记接管发送。写在句中的 @ 接管不了，所以干脆不列队友，
 * 菜单里继续只有文件和对话，不会选了之后发不出去。
 *
 * 为什么单独成文件：候选名单和该不该列都是纯逻辑，放在这里能用固定输入单测钉死；
 * 和宿主服务打交道的部分全部在 new-session-bridge.tsx。
 */
import type { BotCard } from '../../shared/views.js'

/** 在宿主 @ 菜单里的来源名。 */
export const TEAMMATE_SOURCE_NAME = 'dsh-buddy-teammates'
/** 输入框里那个标签的认领名：用来认出标签是不是我们放的。 */
export const TEAMMATE_CLAIM_NAME = 'dsh-buddy-direct-message'

/** 这次 @ 走哪条路：direct 发给队友本人，project 在项目主题里点名。 */
export type MentionRoute = 'direct' | 'project'

/** 判断要不要列队友需要知道的全部情况，由接线层从宿主和仓库里读好传进来。 */
export interface MentionSituation {
  /** 左栏当前是不是队友模式：对话模式保持 DSH 原样。 */
  teamMode: boolean
  /** 当前会话是不是还没发过消息的新会话：进行中的会话不插手，否则话会被转走。 */
  blankSession: boolean
  /** 用户打了 @" ：宿主约定这种写法只搜文件。 */
  quoted: boolean
  /** @ 的位置：leading 在开头（前面只有空白），inline 在句中。 */
  position: 'leading' | 'inline'
  /** 新会话页是否选了项目。 */
  projectSelected: boolean
}

/**
 * 这次 @ 列不列人、走哪条路；null 表示不列。
 * 选了项目时写在哪都行：点名只是文字，回车由开头的项目标签接管。
 */
export function mentionRoute(situation: MentionSituation): MentionRoute | null {
  if (!situation.teamMode || !situation.blankSession || situation.quoted) return null
  if (situation.projectSelected) return 'project'
  return situation.position === 'leading' ? 'direct' : null
}

/** 菜单分组标题：选之前就告诉主人，选了之后这句话会发给谁。 */
export const MENTION_SECTION_TITLE = '队友 · 发给本人'

/**
 * 能被 @ 的队友：已归档、已退役的不列（它们不再接活），其余按总览顺序。
 * 搜索同时匹配名字和执行风格，和左栏搜索框一个口径，不区分大小写。
 */
export function mentionableTeammates(bots: readonly BotCard[], query: string): BotCard[] {
  const q = query.trim().toLowerCase()
  return bots.filter(bot =>
    bot.archived !== true
    && bot.lifecycle !== 'retired'
    && (q === '' || `${bot.name} ${bot.roleLabel}`.toLowerCase().includes(q)))
}

/** 认领标签占用的文本：宿主要求带一个尾随空格，后面的字才算消息正文。 */
export function mentionToken(name: string): string {
  return `@${name} `
}

/** 还没写字时输入框里的提示，告诉主人回车之后会发生什么。 */
export function directHint(name: string): string {
  return `写下要发给 ${name} 的话，回车发送`
}

/**
 * 从标签文字反查队友：切换工作区后草稿带到新会话时，宿主只给我们这段文字。
 * 名字完全相等才算，避免「@小」误认成「小李」。
 */
export function teammateFromToken(bots: readonly BotCard[], token: string): BotCard | undefined {
  const spelled = token.trim()
  if (!spelled.startsWith('@')) return undefined
  const name = spelled.slice(1)
  return mentionableTeammates(bots, '').find(bot => bot.name === name)
}

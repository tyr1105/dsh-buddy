/**
 * 线程气泡分组与「打开工作会话」分支判定（纯逻辑部分）。
 * 气泡规则（任务卡「总控在沙箱里看到的问题」第 3 条）：
 * - 主人消息靠右、主色淡底气泡；机器人消息靠左、中性底气泡带头像与名字；
 * - 中心/日报/系统消息居中、小字、无气泡；汇报（report）气泡左侧加细色条；
 * - 连续同一发送者的消息合并头像（只有每组第一条显示头像与名字）。
 */
import type { ThreadMessageView } from '../../shared/views.js'

/** 一条消息的渲染判定：居中消息与主人消息不显示头像；同组后续消息不重复头像。 */
export interface MessageSlot { message: ThreadMessageView; showHeader: boolean }

/** 居中的中心消息（system / digest：无气泡小字；report 归机器人气泡）。 */
export function isCenterMessage(m: ThreadMessageView): boolean {
  return m.kind === 'system' || m.kind === 'digest'
}

/** 两个元素是否属于同一个「头像组」：居中消息自成一格；其余按发送者分组。 */
function sameGroup(a: ThreadMessageView, b: ThreadMessageView): boolean {
  if (isCenterMessage(a) || isCenterMessage(b)) return false
  return a.from === b.from
}

/** 连续同一发送者合并头像：每组第一条 showHeader=true。 */
export function groupMessages(messages: readonly ThreadMessageView[]): MessageSlot[] {
  const out: MessageSlot[] = []
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i]!
    const prev = i > 0 ? messages[i - 1]! : null
    out.push({ message, showHeader: prev === null || !sameGroup(prev, message) })
  }
  return out
}

/** 自动贴底判定的输入：上一帧与这一帧的最后一条消息 id、用户是否已在底部附近。 */
export interface StickInput {
  prevLastId: string | null
  lastId: string | null
  /** 用户滚动位置是否在底部附近（阈值由调用方定，约 120px）。 */
  nearBottom: boolean
}

/**
 * 新一帧要不要自动滚到底部（交互审查第 2 条）：
 * - 刚切到这个线程（没有上一帧）：贴底，从最新开始看；
 * - 最后一条消息没变（只是「加载更早」往前拼了旧消息、或已有消息状态更新）：
 *   绝不贴底——用户正在读历史，滚走会被硬拽回底部；
 * - 来了新消息：只有用户本来就在底部附近才跟着滚（正在往上翻旧消息就不打扰）。
 */
export function shouldStickToBottom(input: StickInput): boolean {
  if (input.prevLastId === null) return true
  if (input.lastId === input.prevLastId) return false
  return input.nearBottom
}

/** 判定一次键盘事件是不是「用户真的想发送」（交互审查第 3 条）：
 *  中文输入法在拼音组合态按回车只是上屏候选词（isComposing / keyCode 229），
 *  这时不算发送；否则打一半的拼音会被直接发出去。 */
export function isSendEnter(event: { key: string; isComposing?: boolean; keyCode?: number; shiftKey?: boolean }): boolean {
  if (event.key !== 'Enter') return false
  if (event.isComposing === true) return false
  if (event.keyCode === 229) return false
  if (event.shiftKey === true) return false
  return true
}

/** 历史前插补回新增高度；新回复仅在原来接近底部时跟随，计算不依赖宿主滚动。 */
export function threadScrollTop(input: {
  previousHeight: number; previousTop: number; viewportHeight: number
  height: number; previousLastId: string | null; lastId: string | null
}): number {
  if (input.previousLastId === null) return Math.max(0, input.height - input.viewportHeight)
  if (input.previousLastId === input.lastId) return input.previousTop + Math.max(0, input.height - input.previousHeight)
  const nearBottom = input.previousHeight - input.previousTop - input.viewportHeight < 120
  return nearBottom ? Math.max(0, input.height - input.viewportHeight) : input.previousTop
}

/**
 * 打开工作会话的分支判定（verified-T5 Q4-3 的完整口径，含 workspaces.state==='error'）。
 * 传入三个客户端服务（uiWorkspace / sessions / workspaces），拿不到服务算 unavailable。
 */
export type OpenSessionResult = 'opened' | 'loading' | 'archived' | 'unavailable'

export function openBotSessionWith(ctx: unknown, sessionId: string): OpenSessionResult {
  const c = ctx as { get?: (name: string) => any } | null | undefined
  const get = c?.get?.bind(c)
  if (typeof get !== 'function') return 'unavailable'
  const ws = get('uiWorkspace')
  const sessions = get('sessions')
  const workspaces = get('workspaces')
  if (!ws || !sessions || !workspaces) return 'unavailable'
  let list: any, wsList: any
  try {
    list = sessions.list?.getSnapshot?.()
    wsList = workspaces.list?.getSnapshot?.()
  } catch {
    return 'unavailable'
  }
  if (wsList?.state === 'error') return 'unavailable'   // 官方第一步：工作区列表出错
  if (list?.phase === 'pending' || wsList?.phase === 'pending') return 'loading'
  if (wsList?.archivedSessionIds?.includes(sessionId)) return 'archived'
  if (list?.ids && !list.ids.includes(sessionId)) return 'unavailable'
  try { ws.openSession(sessionId) } catch { return 'unavailable' }
  return 'opened'
}

/** 各分支给主人看的一句话。 */
export const OPEN_SESSION_HINTS: Readonly<Record<OpenSessionResult, string | null>> = {
  opened: null,
  loading: '会话列表加载中。请稍后重试。',
  archived: '工作会话已归档。请先在会话列表中恢复。',
  unavailable: '工作会话打开失败。请确认会话仍存在。',
}

/**
 * 右侧边栏「在办的事」里的一行（P33，P64 改为侧边栏用）：事项名加状态。
 *
 * 整行是一个按钮：这件事有主题就进那条讨论，没有主题的老事务去它所在的项目页。
 * 行内不判断状态，文案和受阻标记都读工作会话投影给的字段。
 */
import type { ReactNode } from 'react'
import type { WorkSession } from '../logic/work-session.js'

export function WorkSessionRow(props: {
  session: WorkSession
  onOpen: (session: WorkSession) => void
}): ReactNode {
  const session = props.session
  return (
    <button
      type="button"
      className={`ah-work-session${session.blocked ? ' ah-work-session-blocked' : ''}`}
      aria-label={`打开「${session.title}」，${session.statusLabel}`}
      onClick={() => props.onOpen(session)}
    >
      <span className="ah-work-session-title">{session.title}</span>
      <span className={`ah-tag${session.blocked ? ' ah-tag-wait' : ''}`}>{session.statusLabel}</span>
    </button>
  )
}

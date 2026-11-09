/**
 * 工作会话一行（P33）：标题、状态标签与「完成并归档」。
 *
 * 为什么单独成组件：队友主页的「在做 / 已归档」两段都要画同一种行，
 * 以后看板与左栏树也会复用；行内不判断状态，能否交账只读工作会话投影给的字段。
 * 「完成并归档」只对进行中的会话出现：受阻要先恢复，待验收/已通过不能再交。
 */
import type { ReactNode } from 'react'
import type { WorkSession } from '../logic/work-session.js'

export function WorkSessionRow(props: {
  session: WorkSession
  /** 有请求在飞：按钮只禁用，不把整行藏掉。 */
  busy: boolean
  onOpen: (session: WorkSession) => void
  onComplete: (session: WorkSession) => void
}): ReactNode {
  const session = props.session
  return (
    <div className={`ah-work-session${session.blocked ? ' ah-work-session-blocked' : ''}`}>
      {/* 整块标题区可点：打开这个队友的线程，并在右栏定位最近一次工作；返回路径由线程头提供。 */}
      <button
        type="button"
        className="ah-work-session-main"
        onClick={() => props.onOpen(session)}
        aria-label={`打开工作会话：${session.title}`}
      >
        <span className="ah-work-session-title">{session.title}</span>
        <span className="ah-work-session-meta">
          <span className={`ah-tag${session.blocked ? ' ah-tag-wait' : ''}`}>{session.statusLabel}</span>
          {session.pendingCheck ? <span>待验收</span> : null}
          {session.projectArchived ? <span>项目已归档，只读</span> : null}
        </span>
      </button>
      {session.canComplete ? (
        <div className="ah-work-session-actions">
          <button
            type="button"
            className="ah-btn ah-btn-ghost"
            disabled={props.busy}
            onClick={() => props.onComplete(session)}
          >{props.busy ? '提交中…' : '完成并归档'}</button>
        </div>
      ) : null}
    </div>
  )
}

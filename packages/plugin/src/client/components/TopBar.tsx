/**
 * 顶栏：标题「队友」、现在时间与免打扰状态、额度灯、收件箱计数、活动流入口、
 * 设置齿轮、新建队友按钮（D03：活动流与设置各有其页）。
 */
import type { ReactNode } from 'react'
import type { OverviewView } from '../../shared/views.js'
import type { PageView } from '../hub-state.js'

/** 设置齿轮图标（内联 SVG，currentColor 跟随主题）。 */
function GearIcon(): ReactNode {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" className="ah-gear-icon">
      <path fill="currentColor" d="M8 5.2A2.8 2.8 0 1 0 8 10.8 2.8 2.8 0 0 0 8 5.2zm0 1.5a1.3 1.3 0 1 1 0 2.6 1.3 1.3 0 0 1 0-2.6z" />
      <path fill="currentColor" d="M7.1 1h1.8l.3 1.6c.5.1 1 .3 1.4.6l1.5-.7 1.3 1.3-.7 1.5c.3.4.5.9.6 1.4l1.6.3v1.8l-1.6.3c-.1.5-.3 1-.6 1.4l.7 1.5-1.3 1.3-1.5-.7c-.4.3-.9.5-1.4.6L8.9 15H7.1l-.3-1.6c-.5-.1-1-.3-1.4-.6l-1.5.7-1.3-1.3.7-1.5c-.3-.4-.5-.9-.6-1.4L1.1 8.6V6.8l1.6-.3c.1-.5.3-1 .6-1.4l-.7-1.5 1.3-1.3 1.5.7c.4-.3.9-.5 1.4-.6L7.1 1z" opacity="0.55" />
    </svg>
  )
}

export function TopBar(props: {
  overview: OverviewView
  view: PageView
  onOpenInbox: () => void
  onOpenActivity: () => void
  onOpenSettings: () => void
  onBack: () => void
  onNewBot: () => void
}): ReactNode {
  const o = props.overview
  // 「返回」放在标题左侧（交互审查第 6 条）：从收件箱/设置回主视图是往左的动线，
  // 原来排最右（「新建队友」旁边）动线是反的。
  const back = props.view === 'main' ? null : <button type="button" className="ah-btn" onClick={props.onBack}>返回</button>
  return (
    <header className="ah-topbar">
      <div className="ah-topbar-title">
        {back}
        <h1>队友</h1>
        <span className="ah-topbar-now">{o.nowText}{o.quietNow ? ' · 免打扰中' : ''}</span>
      </div>
      <div className="ah-topbar-status">
        <span className={`ah-dot ah-dot-${o.quota.light === 'green' ? 'ok' : o.quota.light === 'yellow' ? 'warn' : 'danger'}`}>
          <span className="ah-dot-circle" aria-hidden="true" />
          {o.quota.lightLabel} · {o.quota.usedText}
        </span>
        <button type="button" className="ah-btn" onClick={props.onOpenActivity}>活动流</button>
        <button type="button" className="ah-btn ah-btn-icon" aria-label="设置" title="设置" onClick={props.onOpenSettings}><GearIcon />设置</button>
        <button type="button" className="ah-btn" onClick={props.onOpenInbox}>
          收件箱{o.inbox.total > 0 ? `（${o.inbox.total}）` : ''}
        </button>
        <button type="button" className="ah-btn ah-btn-primary" onClick={props.onNewBot}>新建队友</button>
      </div>
    </header>
  )
}

/**
 * 界面共用的小组件：头像、圆点、骨架行、失败重试、空态。
 * 设计约束：颜色只用 --dsw-alias-* 主题 token；空态写下一步能做什么（16.0.3）。
 */
import type { ReactNode } from 'react'

/**
 * 圆形头像：BotCard.color 做彩色圆底（数据驱动的颜色走内联样式）、initials 白字居中。
 * 默认直径 32px（列表/头部），线程里用 28px（任务卡「总控在沙箱里看到的问题」第 1 条）。
 */
export function Avatar(props: { color: string | null | undefined; initials: string; size?: number }): ReactNode {
  const style: Record<string, string> = {
    width: `${props.size ?? 32}px`, height: `${props.size ?? 32}px`,
    background: props.color || 'var(--dsw-alias-accent-muted)',
    color: 'var(--dsw-alias-text-on-accent, currentColor)',
  }
  return <span className="ah-avatar" style={style} aria-hidden="true">{props.initials}</span>
}

/** 状态圆点 + 文字：颜色从不单独表达含义，旁边一定有文字（16.0.3 第 4 条）。 */
export function Dot(props: { tone: 'ok' | 'warn' | 'busy' | 'idle' | 'danger'; label: string }): ReactNode {
  return (
    <span className={`ah-dot ah-dot-${props.tone}`}>
      <span className="ah-dot-circle" aria-hidden="true" />
      {props.label}
    </span>
  )
}

/** 骨架行：加载超过 300ms 由调用方切换显示。 */
export function Skeleton(props: { rows?: number }): ReactNode {
  const rows = props.rows ?? 3
  return (
    <div className="ah-skeleton" aria-busy="true" aria-label="加载中">
      {Array.from({ length: rows }, (_, i) => <div key={i} className="ah-skeleton-row" />)}
    </div>
  )
}

/** 接口失败：一句原因 + 重试按钮。 */
export function RetryBox(props: { message: string; onRetry: () => void }): ReactNode {
  return (
    <div className="ah-retry" role="alert">
      <span>{props.message}</span>
      <button type="button" className="ah-btn" onClick={props.onRetry}>重试</button>
    </div>
  )
}

/** 空态：写下一步能做什么，不写「暂无数据」。 */
export function EmptyHint(props: { text: string }): ReactNode {
  return <div className="ah-empty">{props.text}</div>
}

/** 未读红点：unread > 0 时显示数字。 */
export function UnreadBadge(props: { count: number }): ReactNode {
  if (props.count <= 0) return null
  return <span className="ah-unread" aria-label={`${props.count} 条未读`}>{props.count > 99 ? '99+' : props.count}</span>
}

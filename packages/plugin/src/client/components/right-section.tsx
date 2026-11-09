/**
 * 右栏折叠分区（从 RightPanel 抽出，供右栏各分区共用）：
 * 默认只展开「档案」「目标」；有待办时由调用方传 open + badge，
 * 把需要主人动手的内容直接推到眼前，不用先猜它在哪个折叠块里。
 * chip 用于「不是待办、但值得一眼看见」的状态（如机器人正在做事），
 * 与待办计数徽标互斥：同一时刻标题上只出现一种标记，避免层级打架。
 */
import type { ReactNode } from 'react'

export function Section(props: { title: string; open?: boolean; badge?: number; chip?: string; children: ReactNode }): ReactNode {
  return (
    <details className="ah-right-section" open={props.open ?? (props.title === '档案' || props.title === '目标')}>
      <summary>
        {props.title}
        {props.chip ? <span className="ah-section-badge ah-section-badge-live">{props.chip}</span> : null}
        {!props.chip && props.badge !== undefined && props.badge > 0 ? <span className="ah-section-badge">{props.badge} 项待办</span> : null}
      </summary>
      <div className="ah-section-content">{props.children}</div>
    </details>
  )
}

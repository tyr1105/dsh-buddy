/**
 * 团队空间左栏共享的小零件（U01 第 45 轮从 team-sidebar-nav.tsx 拆出）：
 * 展开箭头、办公室/项目图标、会话状态点配色、队友选中判定。
 *
 * 为什么独立：主组件在第 43 轮接入真实裁切测量后超过 400 行指引，
 * 把无状态的展示零件与纯函数集中到这里，主组件只保留状态、测量与三组编排；
 * 收起态图标列与两个分组组件也复用同一份图标和判定，避免各画各的。
 */
import type { ReactNode } from 'react'
import type { PageView } from '../hub-state.js'

/** 展开箭头：纯 CSS 旋转，收起时朝右、展开时朝下。 */
export function Chevron(props: { open: boolean }): ReactNode {
  return (
    <svg className={`ah-nav-chevron${props.open ? ' ah-nav-chevron-open' : ''}`} viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
      <path d="M4 2.5 8 6l-4 3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** 办公室图标：一张桌子加一盏灯，和像素办公室的语义一致。 */
export function OfficeIcon(): ReactNode {
  return (
    <svg className="ah-nav-icon" viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
      <path d="M2 11.5h12M3.5 11.5V8h9v3.5M4.5 8V5.2h7V8M8 2.2v3" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** 项目图标（收起态用）：一个文件夹，避免灰块分不清项目与会话。 */
export function FolderIcon(): ReactNode {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
      <path d="M1.8 4.2c0-.6.4-1 1-1h3l1.4 1.6h5c.6 0 1 .4 1 1v5.8c0 .6-.4 1-1 1H2.8c-.6 0-1-.4-1-1z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  )
}

/** 当前选中的队友行：只在主视图下高亮，别的页面不抢焦点。 */
export function isBotActive(view: PageView, selectedThread: string, botId: string): boolean {
  return view === 'main' && selectedThread === botId
}

/** 设置齿轮图标（内联 SVG，currentColor 跟随主题）。 */
export function GearIcon(): ReactNode {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" className="ah-gear-icon">
      <path fill="currentColor" d="M8 5.2A2.8 2.8 0 1 0 8 10.8 2.8 2.8 0 0 0 8 5.2zm0 1.5a1.3 1.3 0 1 1 0 2.6 1.3 1.3 0 0 1 0-2.6z" />
      <path fill="currentColor" d="M7.1 1h1.8l.3 1.6c.5.1 1 .3 1.4.6l1.5-.7 1.3 1.3-.7 1.5c.3.4.5.9.6 1.4l1.6.3v1.8l-1.6.3c-.1.5-.3 1-.6 1.4l.7 1.5-1.3 1.3-1.5-.7c-.4.3-.9.5-1.4.6L8.9 15H7.1l-.3-1.6c-.5-.1-1-.3-1.4-.6l-1.5.7-1.3-1.3.7-1.5c-.3-.4-.5-.9-.6-1.4L1.1 8.6V6.8l1.6-.3c.1-.5.3-1 .6-1.4l-.7-1.5 1.3-1.3 1.5.7c.4-.3.9-.5 1.4-.6L7.1 1z" opacity="0.55" />
    </svg>
  )
}

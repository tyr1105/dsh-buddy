/**
 * 左栏收起态的 36px 图标列（P44，U01 第 45 轮从主组件拆出）。
 *
 * 纪律：顺序与展开态完全一致——办公室 → 队友 → 新建队友 → 项目 → 新建项目 → 待你处理；
 * 收起态不渲染搜索框与内联表单，身份全部靠 title/aria-label，
 * 读屏能念出名字、鼠标悬停能看到全名，键盘仍可逐格到达。
 * 组件纯展示：数据与回调都由 TeamSidebarNav 传入，自身不持有状态。
 */
import type { ReactNode } from 'react'
import type { BotCard } from '../../shared/views.js'
import type { PageView } from '../hub-state.js'
import type { SidebarProjectNode } from '../logic/sidebar-groups.js'
import { Avatar } from './Ui.js'
import { FolderIcon, GearIcon, OfficeIcon, isBotActive } from './sidebar-nav-parts.js'

export interface CompactRailProps {
  view: PageView
  selectedThread: string
  bots: BotCard[]
  workspaceProjects: SidebarProjectNode[]
  inboxTotal: number
  /** 宿主没给新建项目回调时（降级环境）不画这个加号。 */
  canNewProject: boolean
  onOpenOffice: () => void
  onSelectBot: (botId: string) => void
  onNewBot: () => void
  onNewProject: () => void
  /** 项目图标点击：打开项目页（P48 前的并发重构已在使用，这里补齐契约）。 */
  onOpenProject: (projectId: string) => void
  onOpenInbox: () => void
  onOpenSettings: () => void
}

export function CompactRail(props: CompactRailProps): ReactNode {
  return (
    <nav className="ah-botlist ah-sidebar-nav ah-sidebar-nav-rail" aria-label="团队空间导航（图标）">
      <button type="button" className={`ah-rail-btn${props.view === 'office' ? ' ah-selected' : ''}`} title="办公室" aria-label="办公室" onClick={props.onOpenOffice}>
        <OfficeIcon />
      </button>
      <div className="ah-rail-sep" role="presentation" />
      {props.bots.map(bot => (
        <button
          key={bot.id}
          type="button"
          className={`ah-rail-btn ah-rail-bot${isBotActive(props.view, props.selectedThread, bot.id) ? ' ah-selected' : ''}`}
          title={bot.roleLabel === '' ? bot.name : `${bot.name} · ${bot.roleLabel}`}
          aria-label={bot.name}
          onClick={() => props.onSelectBot(bot.id)}
        >
          <Avatar color={bot.color} initials={bot.initials} />
          {bot.unread > 0 ? <span className="ah-rail-dot" aria-hidden="true" /> : null}
        </button>
      ))}
      <button type="button" className="ah-rail-btn" title="新建队友" aria-label="新建队友" onClick={props.onNewBot}>＋</button>
      <div className="ah-rail-sep" role="presentation" />
      {props.workspaceProjects.map(project => (
        <button
          key={project.projectId}
          type="button"
          className={`ah-rail-btn${project.active ? ' ah-selected' : ''}`}
          title={`${project.name} · ${project.topicCount} 条会话`}
          aria-label={`项目：${project.name}`}
          onClick={() => props.onOpenProject(project.projectId)}
        >
          <FolderIcon />
        </button>
      ))}
      {/* 收起态也保留新建项目入口（P44-R2）：与队友加号同构，只是退成图标。 */}
      {props.canNewProject ? (
        <button type="button" className="ah-rail-btn" title="新建项目" aria-label="新建项目" onClick={props.onNewProject}>＋</button>
      ) : null}
      <div className="ah-rail-sep" role="presentation" />
      <button
        type="button"
        className="ah-rail-btn ah-rail-inbox"
        title={props.inboxTotal > 0 ? `待你处理：${props.inboxTotal} 件` : '待你处理'}
        aria-label="待你处理"
        onClick={props.onOpenInbox}
      >
        <span aria-hidden="true">!</span>
        {props.inboxTotal > 0 ? <span className="ah-rail-dot" aria-hidden="true" /> : null}
      </button>
      <button type="button" className="ah-rail-btn" title="设置" aria-label="设置" onClick={props.onOpenSettings}>
        <GearIcon />
      </button>
    </nav>
  )
}

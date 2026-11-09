/**
 * 顶栏：当前位置、页面导航（动态 / 资料 / 项目）、额度灯、跳转、设置、新建队友。
 *
 * P1-1（2026-11-09 评审）：办公室与「待你处理」的主入口在左栏，顶栏不再放同名同目的地的
 * 第二套按钮；原来中间的导航位改成「当前位置」面包屑——从主视图离开后仍能一眼看出在哪，
 * 也能点「队友」回去。顶栏只保留左栏不承担的页面入口。
 */
import type { ReactNode } from 'react'
import type { OverviewView } from '../../shared/views.js'
import type { PageView } from '../hub-state.js'
import { quotaMeaning } from '../logic/quota.js'

/** 当前位置文案：与页面标题、跳转面板使用同一套叫法，不另起名字。 */
const PAGE_TITLES: Record<Exclude<PageView, 'main'>, string> = {
  office: '办公室',
  inbox: '待你处理',
  activity: '动态',
  resource: '设置',
  project: '项目',
  settings: '设置',
}

export function TopBar(props: {
  overview: OverviewView
  view: PageView
  /** 打开资料授权矩阵页（V2-PH2-04）：顺序有测试与走查脚本断言。 */
  /** 打开项目页（V2-PH4-02）：顺序有测试与走查脚本断言。 */
  onOpenProject: () => void
  onOpenActivity: () => void
  /** 面包屑里的「队友」：只在非主视图时出现，点它回到主视图。 */
  onBack: () => void
  onNewBot: () => void
  /** 打开跳转面板（WCAG 2.4.5）：单个入口，不占常驻布局。 */
  onOpenPalette: () => void
}): ReactNode {
  const o = props.overview
  // 额度灯不再显示「绿灯」：主人需要知道的是「还能不能让队友干活」，不是灯的颜色。
  const quota = quotaMeaning(o.quota.light)
  // U11 文案定稿（audit #01/#02）：页头副标题是一张状态条，先说人再说事。
  // 「在忙」与左栏办公室组同一个口径：activity === 'thinking' 的队友数；
  // 卡在主人这儿的件数取待你处理总数。免打扰时段目前没有「立即恢复」动作，
  // 只说提醒攒着、结束后一起给（定稿里的「立即恢复」入口尚未实现，见 questions.md）。
  const busyCount = o.bots.filter(bot => bot.activity === 'thinking').length
  const statusLine = o.quietNow
    ? '免打扰开着。提醒先攒着，结束了一起给你。'
    : `${busyCount} 个队友在忙。${o.inbox.total} 件事卡在你这儿。`
  // 面包屑：主视图只写「队友」；离开主视图后「队友」可点回主视图，右侧是当前页面名。
  // 这里只做「我在哪」的表达，不放与左栏重复的办公室/待你处理入口。
  return (
    <header className="ah-topbar">
      <div className="ah-topbar-title">
        <span className="ah-brand-mark" aria-hidden="true">B</span>
        <div><h1>DSH Buddy</h1><span className="ah-topbar-now">{statusLine}</span></div>
      </div>
      <nav className="ah-topbar-nav" aria-label="页面导航">
        {props.view === 'main' ? (
          <span className="ah-topbar-here" aria-current="page">队友</span>
        ) : props.view === 'settings' || props.view === 'resource' ? (
          // 设置是全局配置，不显示「队友 /」路径。
          <span className="ah-topbar-here" aria-current="page">设置</span>
        ) : (
          <>
            <button type="button" className="ah-btn ah-btn-ghost" onClick={props.onBack}>队友</button>
            <span className="ah-topbar-sep" aria-hidden="true">/</span>
            <span className="ah-topbar-here" aria-current="page">{PAGE_TITLES[props.view]}</span>
          </>
        )}
        {/* 设置页只管全局配置，不放「动态」「项目」这些工作入口；要离开时走左侧导航。 */}
        {props.view === 'settings' || props.view === 'resource' ? null : (
          <>
            <span className="ah-topbar-divider" role="presentation" />
            <button type="button" className="ah-btn ah-btn-ghost" aria-current={props.view === 'activity' ? 'page' : undefined} onClick={props.onOpenActivity}>动态</button>
            <button type="button" className="ah-btn ah-btn-ghost" aria-current={props.view === 'project' ? 'page' : undefined} onClick={props.onOpenProject}>项目</button>
          </>
        )}
      </nav>
      <div className="ah-topbar-status">
        <span
          title={`${o.nowText} · ${quota.hint} · ${o.quota.usedText}`}
          aria-label={`额度：${quota.label}，${o.quota.usedText}。${quota.hint}`}
          className={`ah-quota ah-dot ah-dot-${o.quota.light === 'green' ? 'ok' : o.quota.light === 'yellow' ? 'warn' : 'danger'}`}
        >
          <span className="ah-dot-circle" aria-hidden="true" />
          {/* 窄窗只收起文字、保留灯点（见 workspace.css 1100 容器断点）：
              「还能不能让队友干活」的状态信号不能在小窗口整条消失。 */}
          <span className="ah-quota-text">{quota.label} · {o.quota.usedText}</span>
        </span>
        <button
          type="button"
          className="ah-btn ah-btn-ghost"
          aria-haspopup="dialog"
          aria-keyshortcuts="Meta+K Control+K"
          title="跳转（⌘K 或 Ctrl+K）"
          onClick={props.onOpenPalette}
        >跳转</button>
        <button type="button" className="ah-btn ah-btn-primary" onClick={props.onNewBot}>新建队友</button>
      </div>
    </header>
  )
}

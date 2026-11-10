/**
 * 顶栏：品牌和状态句、额度灯。
 *
 * P61（主人 2026-11-10）：中间那条「队友 / 当前页 | 动态 | 项目」切换，所有页面都删掉了。
 * 为什么删：左栏已经是唯一的主导航（队友、项目、办公室、待你处理、设置都在那里），
 * 顶栏再放一套只会让人分不清该点哪个。回队友页走左栏，项目从左栏「工作区」进；
 * 动态页不再有常驻入口，需要时从「跳转」面板（⌘K / Ctrl+K 快捷键）进。
 *
 * P61（主人 2026-11-10 再次要求）：顶栏右侧的「新建队友」和「跳转」两个按钮也删了。
 * 为什么删：新建队友的入口留在左栏队友组的「＋」；跳转面板只靠 ⌘K / Ctrl+K 打开
 * （快捷键监听在 HubPage 里，不在顶栏），顶栏不再需要任何回调，只负责显示状态。
 */
import type { ReactNode } from 'react'
import type { OverviewView } from '../../shared/views.js'
import { quotaMeaning } from '../logic/quota.js'

export function TopBar(props: {
  overview: OverviewView
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
  return (
    <header className="ah-topbar">
      <div className="ah-topbar-title">
        <span className="ah-brand-mark" aria-hidden="true">B</span>
        <div><h1>DSH Buddy</h1><span className="ah-topbar-now">{statusLine}</span></div>
      </div>
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
      </div>
    </header>
  )
}

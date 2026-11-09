/**
 * 左栏：团队行（未读数）+「队友」分组树（头像、名字、角色、活动一行省略、未读红点、
 * waitingOwner 时「等你」标签、成员项目子行），分组标题右侧常驻「新建队友」加号，
 * 底部「收件箱」入口。
 */
import { useState, type ReactNode } from 'react'
import type { BotCard, OverviewView, ProjectViewRow } from '../../shared/views.js'
import { UnreadBadge } from './Ui.js'
import { TeamTree } from './TeamTree.js'

export function BotList(props: {
  overview: OverviewView
  selected: string
  onSelect: (threadId: string) => void
  onOpenInbox: () => void
  notice?: string | null
  /** 项目视图（P37）：给「队友」分组树挂成员项目子行；还没加载时为 null。 */
  projects?: readonly ProjectViewRow[] | null
  /** 分组标题右侧的「新建队友」加号：不传就不显示（例如只读嵌入场景）。 */
  onNewBot?: () => void
  /** 点项目子行时打开项目页。 */
  onOpenProject?: (projectId: string) => void
}): ReactNode {
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const bots = props.overview.bots.filter(b => `${b.name} ${b.roleLabel}`.toLowerCase().includes(q))
  // 线程 id 与真引擎一致：团队线程是 'team'，机器人线程就是它的 id（core thread() 的约定）。
  const threadOf = (botId: string) => botId
  return (
    <nav className="ah-botlist" aria-label="队友列表">
      {/* 标题与右侧动作共用一个槽位（P27）：计数与「新建队友」加号保持同一间距；
          P37 起加号常驻这里，队友再多也不用到页面里找入口。 */}
      <div className="ah-botlist-head">
        <span>队友</span>
        <span className="ah-botlist-head-actions">
          <span>{props.overview.bots.length} 位</span>
          {props.onNewBot ? (
            <button type="button" className="ah-botlist-add" aria-label="新建队友" title="新建队友" onClick={props.onNewBot}>＋</button>
          ) : null}
        </span>
      </div>
      <input className="ah-bot-search" aria-label="搜索队友" placeholder="搜索名字或角色" value={query} onChange={e => setQuery(e.target.value)} />
      <div className="ah-botlist-rows">
      <button
        type="button"
        className={`ah-bot-row${props.selected === 'team' ? ' ah-selected' : ''}`}
        onClick={() => props.onSelect('team')}
      >
        <span className="ah-avatar ah-avatar-team" aria-hidden="true">B</span>
        <span className="ah-bot-row-main">
          <span className="ah-bot-row-name">团队全景</span>
          {/* WCAG 1.4.12：单行预览在用户加大字距/词距后会更早省略，全文经 title 悬停可取；
              与个人队友行（TeamTree）同一口径，团队行不能例外。 */}
          <span className="ah-bot-row-activity" title={props.overview.team.lastMessageText ?? '全队的汇报与提问均汇总于此。'}>{props.overview.team.lastMessageText ?? '全队的汇报与提问均汇总于此。'}</span>
        </span>
        <UnreadBadge count={props.overview.team.unread} />
      </button>
      <TeamTree
        bots={bots}
        projects={props.projects ?? null}
        selectedBotId={props.selected !== '' && props.selected !== 'team' ? props.selected : null}
        onSelectBot={(id) => props.onSelect(threadOf(id))}
        onOpenProject={props.onOpenProject}
      />
      {bots.length === 0 ? <p className="ah-empty">{q ? '暂无匹配队友。请更换搜索词。' : '暂无队友。点击上方「＋」新建。'}</p> : null}
      </div>
      <div className="ah-botlist-footer">
        {props.notice ? <p className="ah-empty" role="alert">{props.notice}</p> : null}
        {/* U01 第 32 轮（3.2.4 一致标识）：这个入口与顶栏「待你处理」是同一个目的地，
            名字必须固定出现；第二行才是随件数变化的状态句，避免同一入口两套叫法。 */}
        <button type="button" className="ah-btn ah-inbox-entry" onClick={props.onOpenInbox}>
          <span className="ah-inbox-entry-name">待办</span>
          <span className="ah-inbox-entry-sub">
            {props.overview.inbox.total > 0 ? `${props.overview.inbox.total} 件事待办` : '暂无待办。0 件需要处理。'}
          </span>
        </button>
      </div>
    </nav>
  )
}

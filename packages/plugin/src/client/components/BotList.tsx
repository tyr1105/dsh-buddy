/**
 * 左栏：团队行（未读数）+ 每个机器人一行（头像、名字、角色、活动一行省略、未读红点、
 * waitingOwner 时「等你」标签），底部「收件箱」入口。
 */
import type { ReactNode } from 'react'
import type { BotCard, OverviewView } from '../../shared/views.js'
import { Avatar, UnreadBadge } from './Ui.js'

function BotRow(props: { bot: BotCard; selected: boolean; onSelect: (id: string) => void }): ReactNode {
  const b = props.bot
  return (
    <button type="button" className={`ah-bot-row${props.selected ? ' ah-selected' : ''}`} onClick={() => props.onSelect(b.id)}>
      <Avatar color={b.color} initials={b.initials} />
      <span className="ah-bot-row-main">
        <span className="ah-bot-row-name">
          {b.name}
          <span className="ah-bot-row-role">{b.roleLabel}</span>
          {b.waitingOwner ? <span className="ah-tag ah-tag-wait">等你</span> : null}
        </span>
        <span className="ah-bot-row-activity" title={b.activityText}>{b.activityText}</span>
      </span>
      <UnreadBadge count={b.unread} />
    </button>
  )
}

export function BotList(props: {
  overview: OverviewView
  selected: string
  onSelect: (threadId: string) => void
  onOpenInbox: () => void
}): ReactNode {
  // 线程 id 与真引擎一致：团队线程是 'team'，机器人线程就是它的 id（core thread() 的约定）。
  const threadOf = (botId: string) => botId
  return (
    <nav className="ah-botlist" aria-label="队友列表">
      <button
        type="button"
        className={`ah-bot-row${props.selected === 'team' ? ' ah-selected' : ''}`}
        onClick={() => props.onSelect('team')}
      >
        <span className="ah-avatar ah-avatar-team" aria-hidden="true">队</span>
        <span className="ah-bot-row-main">
          <span className="ah-bot-row-name">团队</span>
          <span className="ah-bot-row-activity">{props.overview.team.lastMessageText ?? '机器人的交接和汇报会抄送到这里'}</span>
        </span>
        <UnreadBadge count={props.overview.team.unread} />
      </button>
      {props.overview.bots.map((bot) => (
        <BotRow key={bot.id} bot={bot} selected={props.selected === threadOf(bot.id)} onSelect={(id) => props.onSelect(threadOf(id))} />
      ))}
      <div className="ah-botlist-footer">
        <button type="button" className="ah-inbox-entry" onClick={props.onOpenInbox}>
          收件箱{props.overview.inbox.total > 0 ? `（${props.overview.inbox.total}）` : ''}
        </button>
      </div>
    </nav>
  )
}

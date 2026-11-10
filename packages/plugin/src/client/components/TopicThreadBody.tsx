/**
 * 主题聊天的楼层（P63）：第一条是主题卡片，下面写「N 条回复」，再往下一条一层。
 *
 * 主人要的是飞书话题那种盖楼：所有人（包括主人自己）都在同一列，头像、名字、时间、正文，
 * 不分左右，也不做楼中楼。中心的提示弱化成一行小字，只有「这轮讨论到上限」要看得清，
 * 否则主人会以为队友卡住了。消息怎么分组、算不算到上限，规则都在 logic/topics.ts。
 */
import type { ReactNode } from 'react'
import type { ThreadMessageView } from '../../shared/views.js'
import { isCenterMessage } from '../logic/thread.js'
import { isTopicCapNote, type TopicThreadModel } from '../logic/topics.js'
import { InboxCard, type CardActions } from './Cards.js'
import { Avatar } from './Ui.js'

/** 群聊里主人就是「你」；队友的名字由 core 给，查不到时 core 已经写成「已删除的队友」。 */
function displayName(message: ThreadMessageView): string {
  return message.from === 'owner' ? '你' : message.fromName
}

/** 中心的提示：一行小字居中；到上限那一句用醒目样式。 */
function TopicNote(props: { message: ThreadMessageView }): ReactNode {
  const strong = isTopicCapNote(props.message)
  return (
    <p className={`ah-topic-note${strong ? ' ah-topic-note-strong' : ''}`} role={strong ? 'status' : undefined}>
      {props.message.text}
    </p>
  )
}

/** 一层楼：头像、名字、时间、正文。提问、审批这类卡片沿用线程里的同一个组件。 */
function TopicFloor(props: { message: ThreadMessageView; actions: CardActions; busyInboxId: string | null }): ReactNode {
  const { message } = props
  const name = displayName(message)
  return (
    <article className="ah-topic-floor">
      <Avatar color={message.fromColor} initials={name.slice(0, 1)} size={28} />
      <div className="ah-topic-floor-main">
        <p className="ah-topic-floor-meta"><strong>{name}</strong><span>{message.timeText}</span></p>
        {message.card
          ? <InboxCard card={message.card} actions={props.actions} busy={props.busyInboxId === message.card.inboxId} />
          : <div className="ah-topic-floor-text">{message.text}</div>}
      </div>
    </article>
  )
}

export function TopicThreadBody(props: {
  model: TopicThreadModel
  /** 正在回复的队友名字；为空时不显示那一行。 */
  replying: readonly string[]
  actions: CardActions
  busyInboxId: string | null
}): ReactNode {
  const { model } = props
  return (
    <div className="ah-topic">
      {model.opening !== null ? (
        <section className="ah-topic-card" aria-label="主题">
          <p className="ah-topic-floor-meta"><strong>{displayName(model.opening)}</strong><span>{model.opening.timeText}</span></p>
          <div className="ah-topic-card-text">{model.opening.text}</div>
        </section>
      ) : null}
      <p className="ah-topic-count">{model.countText}</p>
      {model.floors.map(message => isCenterMessage(message)
        ? <TopicNote key={message.id} message={message} />
        : <TopicFloor key={message.id} message={message} actions={props.actions} busyInboxId={props.busyInboxId} />)}
      {props.replying.length > 0 ? <p className="ah-topic-replying" role="status">{props.replying.join('、')} 正在回复…</p> : null}
    </div>
  )
}

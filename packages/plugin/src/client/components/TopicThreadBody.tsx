/**
 * 主题聊天的楼层（P63）：第一条是主题卡片，下面写「N 条回复」，再往下一条一层。
 *
 * 主人要的是飞书话题那种盖楼：所有人（包括主人自己）都在同一列，头像、名字、时间、正文，
 * 不分左右，也不做楼中楼。中心的提示弱化成一行小字，只有「这轮讨论到上限」要看得清，
 * 否则主人会以为队友卡住了。消息怎么分组、算不算到上限，规则都在 logic/topics.ts。
 * P72：主题有约定时，第一层换成约定面板（AgreementPanel），原来的第一条消息和其他消息一样作为楼层。
 *
 * P74h：线程视图带 floors（core 的 topicFloorsView）时，楼层与「工作往来」折叠组（WorkFold）
 * 交替着画，总数行改用 floors.countText（「共 N 条记录：给你的 a 条，员工之间的往来 b 条（已收起）」）；
 * 没有 floors 的旧主题照旧。P74i-m2（第四次审查高-1）：线程只带最新一页消息，楼层里比这更早的
 * 不画，改在楼层列表最上面写一行「更早的 n 条记录还没有加载。」（旁边放「加载更早」入口），
 * 任何情况下都不把找不到视图的消息画成没有作者的灰色小字。
 */
import type { ReactNode } from 'react'
import type { AgreementPanelView, JobProgressView, ThreadMessageView, TopicFloorsView } from '../../shared/views.js'
import { JOB_TEXT, floorEarlierCount, floorsCountText } from '../logic/job.js'
import { isCenterMessage } from '../logic/thread.js'
import { isTopicCapNote, type TopicThreadModel } from '../logic/topics.js'
import { AgreementCard } from './AgreementCard.js'
import { AgreementPanel } from './AgreementPanel.js'
import { InboxCard, type CardActions } from './Cards.js'
import { JobCard } from './JobCard.js'
import { isDrawableJobCard } from '../../shared/job-card-kinds.js'
import { Avatar } from './Ui.js'
import { WorkFold } from './WorkFold.js'
import { MemoryNotes } from './MemoryNoteRow.js'

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
export function TopicFloor(props: {
  message: ThreadMessageView; actions: CardActions; busyInboxId: string | null
  /** P75k：楼层项（core 的 floors）自带的「已记住」行；消息视图里没有时用它。 */
  notes?: ThreadMessageView['memoryNotes']
}): ReactNode {
  const { message } = props
  const name = displayName(message)
  // P74i-m1（走查 G-5）：回执是主题里独立的一张事实卡片，不显示头像、名字和时间。
  const receipt = message.jobCard?.kind === 'receipt'
  return (
    <article className="ah-topic-floor">
      {!receipt ? <Avatar color={message.fromColor} initials={name.slice(0, 1)} size={28} /> : null}
      <div className="ah-topic-floor-main">
        {!receipt ? <p className="ah-topic-floor-meta"><strong>{name}</strong><span>{message.timeText}</span></p> : null}
        {/* P72：约定卡先于普通卡片判断；约定找不到对应版本时 agreement 为 null，退回显示 text。 */}
        {message.agreement
          ? <AgreementCard card={message.agreement} onConfirm={props.actions.onConfirmAgreement} onOpenMemory={props.actions.onOpenMemory} />
          // 白名单之外的卡片种类（核心以后新增、界面还没画的）退回后面的标题行。
          : message.jobCard && isDrawableJobCard(message.jobCard)
            ? <JobCard card={message.jobCard} />
            : message.card
              ? <InboxCard card={message.card} actions={props.actions} busy={props.busyInboxId === message.card.inboxId} />
              : message.kind === 'job_card'
                // P74i 的交付卡、回执还没有视图：先只显示标题（core 落消息时把标题写在 text 里）。
                ? <p className="ah-topic-floor-text ah-job-card-pending">{message.text}</p>
                : <div className="ah-topic-floor-text">{message.text}</div>}
        {/* P75k：这条消息下面的「已记住」「已删除」「已更正」行，缩进与正文对齐。 */}
        <MemoryNotes notes={message.memoryNotes ?? props.notes} onUndo={props.actions.onUndoMemory} />
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
  /** P72：主题有约定时给出；第一层画约定面板，所有消息都作为楼层（model.opening 此时为 null）。 */
  agreement?: AgreementPanelView | null
  /** P74h：主题的进度行（约定面板底部画）；没有进行中的事时不带。 */
  progress?: JobProgressView | null
  /** P74h：楼层与工作往来折叠分组（core 的 topicFloorsView）；带它时按它画，总数行用它的 countText。 */
  floors?: TopicFloorsView
  /** P74i-m2（第四次审查高-1）：还有更早的记录没加载时，把「加载更早」入口放在提示行旁边；没有则不传。 */
  onLoadEarlier?: () => void
}): ReactNode {
  const { model } = props
  // 楼层项是 core 的原始消息；名字、时间、卡片在消息视图里，按 id 对回去。
  const viewsById = new Map(model.floors.map(message => [message.id, message]))
  // P74i-m2（第四次审查高-1）：线程只带最新一页消息，而楼层按主题的全部消息算。
  // 只画「已加载的消息里最早一条」及其之后的楼层；更早的楼层不画，在最上面写一行提示
  // （旁边放「加载更早」入口）。开头那条已作为主题卡显示时，楼层里不再画它（不重复）。
  // 任何情况下都不把找不到视图的消息画成灰色小字（此前页外的楼层全被画成没有作者的居中灰字）。
  const floors = props.floors
  const openingId = model.opening?.id ?? null
  // P74i-m3（第 5 节）：主题卡（opening）不在 viewsById 里（viewsById 只有它之后的楼层），
  // 但它已经加载并显示了；此前把它当成「更早的、没加载的」，样例里写出「更早的 1 条记录还没有加载」。
  const loadedId = (messageId: string): boolean => messageId === openingId || viewsById.has(messageId)
  const earlierCount = floors !== undefined ? floorEarlierCount(floors.items, loadedId) : 0
  const started = earlierCount === 0 || (floors !== undefined && floors.items.some(item =>
    item.kind === 'fold' ? item.messages.some(entry => loadedId(entry.message.id)) : loadedId(item.message.id)))
  return (
    <div className="ah-topic">
      {props.agreement ? <AgreementPanel panel={props.agreement} progress={props.progress ?? null} onOpenMemory={props.actions.onOpenMemory} /> : null}
      {model.opening !== null ? (
        <section className="ah-topic-card" aria-label="主题">
          <p className="ah-topic-floor-meta"><strong>{displayName(model.opening)}</strong><span>{model.opening.timeText}</span></p>
          <div className="ah-topic-card-text">{model.opening.text}</div>
        </section>
      ) : null}
      {/* 总数行：带 floors 时用 core 算的那句（写清多少条已收起），旧主题照旧用「N 条回复」。 */}
      <p className="ah-topic-count">{props.floors ? floorsCountText(props.floors, loadedId) : model.countText}</p>
      {floors !== undefined && earlierCount > 0 ? (
        <p className="ah-topic-earlier">
          <span>{JOB_TEXT.floorsEarlierNote.replace('{}', String(earlierCount))}</span>
          {props.onLoadEarlier ? <button type="button" className="ah-btn ah-btn-ghost" onClick={props.onLoadEarlier}>加载更早</button> : null}
        </p>
      ) : null}
      {floors !== undefined && started
        ? floors.items.map(item => item.kind === 'fold'
          // 整组都没加载的折叠组也不画（它属于更早的未加载记录，已算进顶上的提示行）。
          ? (item.messages.some(entry => loadedId(entry.message.id))
              ? <WorkFold key={item.id} fold={item} views={viewsById} />
              : null)
          : (() => {
            // 楼层项按 id 找回消息视图；页外的更早楼层已在上面算进提示行，这里只画有视图的。
            const view = viewsById.get(item.message.id)
            if (view === undefined || view.id === openingId) return null
            return isCenterMessage(view)
              ? <TopicNote key={view.id} message={view} />
              : <TopicFloor key={view.id} message={view} actions={props.actions} busyInboxId={props.busyInboxId} notes={item.memoryNotes} />
          })())
        : floors === undefined
          ? model.floors.map(message => isCenterMessage(message)
            ? <TopicNote key={message.id} message={message} />
            : <TopicFloor key={message.id} message={message} actions={props.actions} busyInboxId={props.busyInboxId} />)
          : null}
      {props.replying.length > 0 ? <p className="ah-topic-replying" role="status">{props.replying.join('、')} 正在回复…</p> : null}
    </div>
  )
}

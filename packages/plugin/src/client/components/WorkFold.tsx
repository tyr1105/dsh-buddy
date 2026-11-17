/**
 * 工作往来折叠组（P74h，设计稿场景 A、B1、C）：员工之间（含员工和总管之间）的一段往来，
 * 默认收起成两行（「工作往来」加参与者、条数、日期范围，和「最近：…」一句），展开后每条一行。
 *
 * 为什么用原生 details/summary：折叠、键盘（Enter 或空格）展开收起、读屏状态都是浏览器自带的，
 * 不用自己再写一套，也就不会漏掉键盘可达。展开状态记在组件状态里（按组 id 挂载），刷新后回到收起。
 * 每条往来的头部写「{发出者} → {接收者}」（core 的视图已算好名字；没有接收者时只写发出者），
 * 中心提示（from 为 hub）画成居中小字。交回卡、核对卡（kind 为 job_card）在组内按卡片画出。
 * 组里的消息比给主人的楼层小一号（样式在 workspace.css）。
 */
import { useState, type ReactNode } from 'react'
import type { ThreadMessageView } from '../../shared/views.js'
import { JOB_TEXT, foldLatestText, foldSummary, workHead, workTimeOf, type FoldItem } from '../logic/job.js'
import { JobCard } from './JobCard.js'
import { isDrawableJobCard } from '../../shared/job-card-kinds.js'

/** 组内一条往来（core 的 FoldedMessage：消息加「谁 → 谁」）。 */
type FoldEntry = FoldItem['messages'][number]

/**
 * 组内的一条：中心提示居中；卡片消息画卡片；其余是一条「谁 → 谁」的小号往来。
 * 写成普通函数而不是子组件（与约定卡同一取舍）：整棵树是连续的元素，测试能直接检查行头和卡片。
 * P74i-m2（低-2）：行头的时间用消息视图里核心按中心时区算好的 timeText（找不到视图才退回本机算法）。
 * P74i-m2（高-1）：没有视图的消息（线程只带最新一页时组里更早的几条）不画——组只列已加载的，
 * 末尾另起一行说明还有几条没加载（见 WorkFold）。
 */
function foldRow(entry: FoldEntry, view: ThreadMessageView | undefined): ReactNode {
  const message = entry.message
  // 中心提示（from 为 hub）：居中小字，不算参与者（core 算摘要时已排除）。
  if (message.from === 'hub') {
    return <p key={message.id} className="ah-work-note">{message.text}</p>
  }
  // 交回卡、核对卡、交付卡：core 的消息视图里带 jobCard；没有视图（还没加载）的整条不在这里画。
  if (message.kind === 'job_card') {
    const card = view?.jobCard
    if (card === undefined || card === null) return null
    // 不在白名单内的种类（核心以后新增、界面还没画的）整条跳过（也不取截图编号）。
    if (!isDrawableJobCard(card)) return null
    // 截图定位参数只有交回卡、核对卡、交付卡有（三轮不过卡、回执、复盘卡、技能核对卡没有这两个字段）。
    const shotRef = (card.kind === 'submission' || card.kind === 'review' || card.kind === 'delivery')
      && card.evidenceJobId !== null && card.evidenceSubmissionId !== null
      ? { jobId: card.evidenceJobId, submissionId: card.evidenceSubmissionId }
      : null
    return (
      <div key={message.id} className="ah-work-row ah-work-card-row">
        <p className="ah-work-meta"><strong>{workHead(entry.fromName, entry.toNames)}</strong>　{workTimeOf(view, message.createdAt)}</p>
        <JobCard card={card} shotRef={shotRef} />
      </div>
    )
  }
  if (view === undefined) return null
  return (
    <div key={message.id} className="ah-work-row">
      <p className="ah-work-meta"><strong>{workHead(entry.fromName, entry.toNames)}</strong>　{workTimeOf(view, message.createdAt)}</p>
      <div className="ah-work-text">{message.text}</div>
    </div>
  )
}

export function WorkFold(props: { fold: FoldItem; views: ReadonlyMap<string, ThreadMessageView> }): ReactNode {
  const { fold } = props
  // 展开状态记在组件状态里（每个组按 id 挂载一次）；刷新后组件重建，回到收起。
  // P74i-m2（低-3）：楼层项的 key 用 core 给的折叠组 id（见 TopicThreadBody），前面增减楼层时展开的那组不会跳。
  const [open, setOpen] = useState(false)
  const missingCount = fold.messages.filter(entry => !props.views.has(entry.message.id)).length
  return (
    <details
      className="ah-work-fold"
      open={open}
      onToggle={event => { try { setOpen(Boolean((event.target as HTMLDetailsElement | null)?.open)) } catch { /* 状态读不到时保持原样 */ } }}
    >
      <summary>
        <span className="ah-work-fold-line">
          {/* P75k：整组都是复盘类往来（复盘卡、核对卡、小结）时 core 给 label（「复盘」），折叠行开头显示它；其余组仍是「工作往来」。 */}
          <strong>{fold.label ?? JOB_TEXT.workFold}</strong>
          <span>{foldSummary(fold)}</span>
          <span className="ah-work-fold-toggle">{open ? JOB_TEXT.foldOpen : JOB_TEXT.foldExpand}</span>
        </span>
        <span className="ah-work-fold-latest">{foldLatestText(fold)}</span>
      </summary>
      <div className="ah-work-fold-body">
        {/* P74i-m2（第四次审查高-1）：组里只列已加载的消息；更早的没加载的不画，
            末尾一行说明还有几条（标题那两行仍是 core 按整组算的，照常显示）。 */}
        {fold.messages.map(entry => foldRow(entry, props.views.get(entry.message.id)))}
        {missingCount > 0 ? (
          <p className="ah-work-fold-missing">{JOB_TEXT.foldEarlierNote.replace('{}', String(missingCount))}</p>
        ) : null}
      </div>
    </details>
  )
}

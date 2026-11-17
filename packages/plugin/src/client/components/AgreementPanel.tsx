/**
 * 主题第一层的约定面板（P72e）：有约定的主题，第一层不再是「第一条消息」，而是约定本身，
 * 放在原来主题卡片的位置（沿用 ah-topic-card 的外框），在「N 条回复」之上，永远在最上面。
 *
 * 内容：「约定」标签、第 N 版、状态（已固定或待你确认）；一句话；
 * 「查看全文」（展开成只读的约定卡全文，这里不放「定了」按钮，要确认请回总管私聊或待你处理）；
 * 改过几次就写几次：「改过 N 次，查看改动」，展开后每版一行（版本、时间、一句话、来源），
 * 已固定的版本标「固定」。修订记录是 core 记下来的固定记录，不是总管现场总结，所以不会漏改或说错。
 *
 * P74h：主题视图有 progress 时（这件事进行中），面板最下方画进度行（JobProgress）：
 * 现在到哪一步、第几轮、在等谁、交付时间，全部由中心算出，不调用模型。
 *
 * 为什么修订列表用原生 details：折叠、键盘操作、读屏状态都是浏览器自带的，不用自己再写一套。
 */
import { useState, type ReactNode } from 'react'
import type { AgreementPanelView, JobProgressView } from '../../shared/views.js'
import { AGR_TEXT, revisionLineText, revisionToggleText, stateLabelOf, versionText } from '../logic/agreement.js'
import { AgreementCard } from './AgreementCard.js'
import { JobProgress } from './JobProgress.js'

export function AgreementPanel(props: {
  panel: AgreementPanelView
  progress?: JobProgressView | null
  /** P75r7（B11）：已定事项的出处引用了一条记忆时，只读的全文里它同样可以点（打开「关于你的记忆」并定位到那一条）；不传时出处是文字。 */
  onOpenMemory?: (memoryId: string) => void
}): ReactNode {
  const { current, revisions, revisionCount } = props.panel
  const [showFull, setShowFull] = useState(false)
  const fullId = `agr-panel-full-${current.agreementId}`
  return (
    <section className="ah-topic-card ah-agr-panel" aria-label={AGR_TEXT.tag} data-agreement-id={current.agreementId}>
      <div className="ah-card-head ah-agr-head">
        <span className="ah-card-type">{AGR_TEXT.tag}</span>
        <span className="ah-card-title">{versionText(current.versionNo)}</span>
        <span className={`ah-agr-state${current.state === 'locked' ? ' is-locked' : ''}`}>{stateLabelOf(current)}</span>
      </div>
      <div className="ah-topic-card-text">{current.summary.text}</div>
      <div className="ah-agr-panel-links">
        <button type="button" className="ah-btn ah-btn-ghost" aria-expanded={showFull} aria-controls={fullId}
          onClick={() => setShowFull(open => !open)}>{showFull ? AGR_TEXT.hideFull : AGR_TEXT.viewFull}</button>
        {revisionCount > 0 ? (
          <details className="ah-agr-revisions">
            <summary>{revisionToggleText(revisionCount)}</summary>
            <ul className="ah-agr-rev">
              {revisions.map(row => (
                <li key={row.no} data-locked={row.locked ? 'true' : 'false'}>{revisionLineText(row)}</li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>
      {showFull ? (
        <div id={fullId} className="ah-agr-panel-full">
          <AgreementCard card={current} readOnly startExpanded onOpenMemory={props.onOpenMemory} />
        </div>
      ) : null}
      {/* 进度行放面板最下方：约定之后紧接着「现在到哪一步、在等谁」，不用进对话问一句「到哪了」。 */}
      {props.progress != null ? <JobProgress progress={props.progress} /> : null}
    </section>
  )
}

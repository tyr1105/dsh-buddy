/**
 * 内嵌卡片：提问 / 审批 / 提议 / 告警（D06 第 4 条起按视图给的 options 渲染按钮）。
 * - 按钮文案完全来自 card.options（core 保证审批是['批准','拒绝']、提议是['接受','不做']、
 *   告警是['知道了']、提问是机器人自定的 2–4 项），点哪项就原样回传哪项；
 * - 默认选项主色填充并标注「默认」；
 * - 结果文字按状态写（D07 第 11 条）：answered「你选了：X」、expired「已过期，已按
 *   默认：X」、withdrawn「已撤回」、closed「已关闭」——不是主人作答的不冒充主人选的；
 * - 有效期带含义（D07 第 18 条）：提问「…前未答复按默认处理」、审批「…前有效，过期
 *   视为拒绝」、提议「…前未答复自动撤回」；
 * - 提交失败要看得见（D07 第 11 条）：按钮恢复可点并显示错误，自由文本草稿保留；
 *   只有成功才保持禁用。
 * 提交分流（审批用 approvalId、其他用 inboxId）在 logic/cards.ts，组件只负责展示。
 */
import { useState, type ReactNode } from 'react'
import { cardSubmission, cardResultText, expiryMeaningOf, isApproveOption, type CardPayload } from '../logic/cards.js'
import { isSendEnter } from '../logic/thread.js'

export type { CardPayload } from '../logic/cards.js'

export const CARD_TYPE_LABELS: Readonly<Record<CardPayload['type'], string>> = {
  question: '提问', approval: '审批', proposal: '提议', alert: '告警',
}

/**
 * 卡片操作统一出口：把「点了哪张卡的哪一项（附言）」交给上层按 cardSubmission 分流。
 * 返回 Promise<错误文字 | null>（D07 第 11 条）：失败时卡片要显示原因并复位按钮。
 */
export interface CardActions {
  onPick(card: CardPayload, option: string, note?: string): Promise<string | null>
}

export function InboxCard(props: {
  card: CardPayload
  actions: CardActions
  busy: boolean
  /** 收件箱平铺后，紧急程度只由卡片自己的标签表达；线程内卡片不传。 */
  priority?: 'P0' | 'P1' | 'P2'
}): ReactNode {
  const c = props.card
  const [picked, setPicked] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [freeText, setFreeText] = useState('')
  const [note, setNote] = useState('')
  const [rejectingGoal, setRejectingGoal] = useState(false)
  const resultText = cardResultText(c)
  const answered = resultText !== null
  const busy = props.busy || picked !== null

  /** 点了某个选项：记下禁用并按提交规则交给上层；失败复位按钮并显示原因。 */
  const pick = (option: string): void => {
    setPicked(option)
    setError(null)
    void props.actions.onPick(c, option, c.type === 'approval' ? note : undefined)
      .then(failure => { if (failure !== null) { setPicked(null); setError(failure) } })
      .catch(e => { setPicked(null); setError(e instanceof Error ? e.message : String(e)) })
  }

  return (
    <div className={`ah-card ah-card-${c.type}${answered ? ' ah-card-done' : ''}`} data-answered={answered ? 'true' : 'false'}>
      <div className="ah-card-head">
        <span className="ah-card-type">{CARD_TYPE_LABELS[c.type]}</span>
        {props.priority ? <span className={`ah-card-priority ah-card-priority-${props.priority.toLowerCase()}`}>{props.priority}</span> : null}
        <span className="ah-card-title">{c.title}</span>
      </div>
      <p className="ah-card-body">{c.body}</p>
      {expiryMeaningOf(c) ? <p className="ah-card-expire">{expiryMeaningOf(c)}</p> : null}
      {answered ? (
        <p className="ah-card-answer">{resultText}</p>
      ) : (
        <>
          <div className="ah-card-options">
            {/* 全部按钮按视图 options 渲染：审批的「批准」主色、「拒绝」警示色，其余默认项主色。 */}
            {!rejectingGoal && c.options.map(option => (
              <button key={option} type="button"
                className={c.type === 'approval'
                  ? (isApproveOption(option) ? 'ah-btn ah-btn-primary' : 'ah-btn ah-btn-danger')
                  : option === c.defaultOption ? 'ah-btn ah-btn-primary' : 'ah-btn'}
                disabled={busy}
                onClick={() => c.goalId && option === '未通过' ? setRejectingGoal(true) : pick(option)}>
                {option}{option === c.defaultOption && c.type !== 'approval' ? '（默认）' : ''}
              </button>
            ))}
          </div>
          {rejectingGoal ? (
            <div className="ah-card-options" aria-label="验收未通过原因">
              {['没做', '做错', '不符预期', '未通过'].map(reason => (
                <button key={reason} type="button" className="ah-btn" disabled={busy} onClick={() => pick(reason === '不符预期' ? '不是你要的' : reason)}>{reason}</button>
              ))}
              <button type="button" className="ah-btn ah-btn-ghost" disabled={busy} onClick={() => setRejectingGoal(false)}>取消</button>
            </div>
          ) : null}
          {/* 仅有 placeholder 不构成稳定可达名称（WCAG 4.1.2）：补 aria-label，读屏直接报「审批附言」。 */}
          {c.type === 'approval' && picked === null ? (
            <input className="ah-card-note" aria-label="审批附言（可不填）" value={note} placeholder="附一句话（可不填）" disabled={busy}
              onChange={e => setNote(e.target.value)} />
          ) : null}
          {c.type === 'question' && picked === null ? (
            <div className="ah-card-freetext">
              {/* 失败后草稿保留（D07 第 11 条）：输入框回到可用状态，freeText 没被清。 */}
              {/* 同上：placeholder 只作视觉提示，可达名称由 aria-label 承担。 */}
              <input aria-label="或填写回答" value={freeText} placeholder="或填写回答" disabled={busy}
                onChange={e => setFreeText(e.target.value)}
                onKeyDown={e => {
                  // 中文输入法组合态的回车只是上屏候选词，不算发送（交互审查第 3 条）。
                  if (isSendEnter(e.nativeEvent) && freeText.trim() !== '') pick(freeText.trim())
                }} />
              <button type="button" className="ah-btn" disabled={busy || freeText.trim() === ''}
                onClick={() => pick(freeText.trim())}>发送</button>
            </div>
          ) : null}
          {error ? <p className="ah-card-error" role="alert">{error}</p> : null}
        </>
      )}
    </div>
  )
}

// 保留具名再导出，方便上层引用提交规则（也可直接 from '../logic/cards.js'）。
export { cardSubmission }

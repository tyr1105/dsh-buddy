/**
 * 审批卡的正文块（P69 B2）：把「这一步要批准什么」说成主人看得懂的话。
 * 从上到下四段：
 *   1. 一句人话（approval.actionText，由 core 生成，不带原始命令）；
 *   2. 「原因：……」（approval.ownerReason），没有就整行不显示；
 *   3. 风险提示（approval.riskNote），有才显示；
 *   4. 原始命令或参数（approval.argsPreview）默认收起，点「查看原始命令」才展开。
 * 为什么原始命令要收起：绝大多数主人只需要看那句话就能决定，原文是给想核对细节的人看的。
 * 无障碍：开关是原生 button（Tab 能到，回车和空格自带开合），aria-expanded 告诉读屏当前是展开还是收起。
 * 旧审批记录没有 approval 字段时，调用方不渲染这个组件，继续显示原来的正文。
 */
import { useState, type ReactNode } from 'react'
import type { ApprovalParts } from '../logic/cards.js'

/** 展开按钮和命令框的文字，集中放一处，登记在 docs/copy/strings.json。 */
export const APPROVAL_SHOW_RAW = '查看原始命令'
export const APPROVAL_HIDE_RAW = '收起原始命令'
/** P74i：三行说明（费用、能否撤回、批准之后）的三个标签。 */
export const APPROVAL_NOTE_LABELS = { cost: '费用', undo: '能否撤回', after: '批准之后' } as const

export function ApprovalBlock(props: {
  approval: ApprovalParts
  /** 用来拼 aria-controls 的 id，保证同一页多张卡不撞名。 */
  idBase: string
}): ReactNode {
  const { approval } = props
  const [open, setOpen] = useState(false)
  const rawId = `ah-approval-raw-${props.idBase}`
  // P74r20：展开时优先显示命令全文（argsFull，核心给的），没有（旧数据、全文已不存在）就显示 argsPreview。
  const rawText = approval.argsFull != null && approval.argsFull.trim() !== '' ? approval.argsFull : approval.argsPreview
  const hasRaw = rawText.trim() !== ''
  return (
    <div className="ah-approval">
      <p className="ah-approval-action">{approval.actionText}</p>
      {approval.ownerReason ? <p className="ah-approval-reason">{`原因：${approval.ownerReason}`}</p> : null}
      {approval.riskNote ? <p className="ah-approval-risk">{approval.riskNote}</p> : null}
      {/* P74g/P74i：属于一件事的审批带「由{员工}执行」一行（总管名义、执行者做事），在三行说明之前。 */}
      {approval.onBehalfOf !== null ? <p className="ah-approval-onbehalf">{approval.onBehalfOf}</p> : null}
      {/* P74g/P74i：三行「费用、能否撤回、批准之后」（notes 不为 null 时才有），在原因与风险之后、原始命令之前。 */}
      {approval.notes !== null ? (
        <dl className="ah-approval-notes">
          <div className="ah-approval-note"><dt>{APPROVAL_NOTE_LABELS.cost}</dt><dd>{approval.notes.cost}</dd></div>
          <div className="ah-approval-note"><dt>{APPROVAL_NOTE_LABELS.undo}</dt><dd>{approval.notes.undo}</dd></div>
          <div className="ah-approval-note"><dt>{APPROVAL_NOTE_LABELS.after}</dt><dd>{approval.notes.after}</dd></div>
        </dl>
      ) : null}
      {hasRaw ? (
        <>
          {/* 文字按钮：原生 button，键盘回车和空格都能开合；aria-expanded 让读屏读出状态。 */}
          <button type="button" className="ah-approval-toggle" aria-expanded={open}
            aria-controls={open ? rawId : undefined} onClick={() => setOpen(v => !v)}>
            {open ? APPROVAL_HIDE_RAW : APPROVAL_SHOW_RAW}
          </button>
          {/* 收起时整块不渲染，所以默认看不到原文；展开后等宽字体、可换行。 */}
          {open ? <pre id={rawId} className="ah-approval-raw">{rawText}</pre> : null}
        </>
      ) : null}
    </div>
  )
}

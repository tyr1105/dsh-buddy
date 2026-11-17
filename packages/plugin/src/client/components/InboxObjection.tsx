/**
 * 「待你处理」里一个条目的「表示不同意并写一句话」控件（P79）。
 *
 * 做什么：给条目提供两块界面——
 * - button：次要按钮（要修改、有不符、都不合适），由条目的卡片放在确认按钮旁边；
 * - panel：点开后在条目下面出现的输入框、「发送」「取消」，以及发送成功后多出的一行说明。
 * 两块共用同一份状态，所以用「渲染函数」的形式交给调用方摆放：调用方决定按钮画在卡片的哪一行。
 *
 * 为什么这样设计：
 * - 发送只调用 send（调用方传入的，就是对话输入框发消息用的那条路径），不新造任何「拒绝」记录；
 * - 发送成功：条目不消失（约定、组队、验收等流程不变），输入框收起、草稿清掉、条目上多一行说明，
 *   并通知上层显示成功提示；那一行记在模块级（logic/inbox-objection.ts），页面离开再回来仍在；
 * - 发送失败：显示错误，输入框和草稿都保留，可以再发；
 * - 确认按钮在这期间仍然可点（本组件不碰卡片上的按钮状态）；
 * - 反过来（P74i-m4，第 2 节）：条目正在提交确认、选办法、验收时，次要按钮与输入框禁用；已经处理完之后不再显示，
 *   否则会在「已确认」之后还能发出「要修改」，条目上写出与事实相反的话。状态由上层（InboxPane）经 lock 传入。
 */
import { useState, type ReactNode } from 'react'
import { isSendEnter } from '../logic/thread.js'
import { OBJECTION_CANCEL, OBJECTION_SEND, rememberSent, sentLineOf, type ObjectionLock, type ObjectionSpec } from '../logic/inbox-objection.js'
import { OBJECTION_CHAR_LIMIT, charCountHint } from '../logic/char-count.js'

/**
 * 按钮的可达名称：按钮上显示的字加条目标题（P74i-m5，第 6 节第 1 条，走查 N-7）。
 * 同一页有多条条目时，每条都有「要修改」「发送」「取消」，读屏听不出是哪一条；
 * 可达名称以显示的字开头（便于语音控制按显示的字找到按钮），后面接条目标题；界面上显示的文字不变。
 */
export function accessibleNameOf(label: string, itemTitle: string): string {
  return itemTitle === '' ? label : `${label}：${itemTitle}`
}

export function ObjectionHost(props: {
  spec: ObjectionSpec
  /** 条目标题：用于按钮的可达名称，让同一页上多条条目的同名按钮分得清。 */
  itemTitle?: string
  /** 条目编号加条目内容（objectionKey），用来记住「已提出……」这一行。 */
  itemKey: string
  /** 条目的提交状态（默认 none）：submitting 时禁用，done 时不显示按钮与输入框。 */
  lock?: ObjectionLock
  /** 把一句话发到对应的对话；返回错误文字或 null（成功）。 */
  send: (text: string) => Promise<string | null>
  /** 发送成功后通知上层显示成功提示。 */
  onSent: (notice: string) => void
  /** 渲染函数：拿到按钮和输入区两块，由调用方摆放。 */
  children: (parts: { button: ReactNode; panel: ReactNode }) => ReactNode
}): ReactNode {
  const { spec } = props
  /** 输入框是否展开。 */
  const [open, setOpen] = useState(false)
  /** 输入框里的草稿；取消和发送成功后清掉，失败时保留。 */
  const [draft, setDraft] = useState('')
  /** 正在发送：期间输入框和按钮不可用，避免重复发送同一句话。 */
  const [sending, setSending] = useState(false)
  /** 发送失败的原因；再次发送或取消时清掉。 */
  const [error, setError] = useState<string | null>(null)
  /** 这个条目当前版本已发送过时，条目上多出的那一行。 */
  const sentLine = sentLineOf(props.itemKey)
  const text = draft.trim()

  /** 点「发送」：空输入不发；成功后收起并通知上层，失败保留草稿并显示原因。 */
  const submit = (): void => {
    if (sending || lock === 'submitting' || lock === 'done' || text === '') return
    setSending(true)
    setError(null)
    void props.send(text)
      .then(failure => {
        setSending(false)
        if (failure !== null) { setError(failure); return }
        rememberSent(props.itemKey, spec.pendingLine)
        setOpen(false)
        setDraft('')
        props.onSent(spec.successNotice)
      })
      .catch((caught: unknown) => {
        setSending(false)
        setError(caught instanceof Error ? caught.message : String(caught))
      })
  }

  /** 点「取消」：收起输入框，草稿清掉。 */
  const cancel = (): void => {
    setOpen(false)
    setDraft('')
    setError(null)
  }

  const lock: ObjectionLock = props.lock ?? 'none'
  /** 提交中：按钮与输入框都不可用；已处理完：根本不画（已展开的输入框随之收起，草稿丢弃）。 */
  const frozen = sending || lock === 'submitting'
  const itemTitle = props.itemTitle ?? ''
  const countHint = charCountHint(draft.length, OBJECTION_CHAR_LIMIT)
  // 次要按钮（与确认按钮并排时是次要的样子：ah-btn，不带 ah-btn-primary）；可达名称带条目标题。
  const button = lock === 'done' ? null : (
    <button type="button" className="ah-btn" aria-label={accessibleNameOf(spec.buttonLabel, itemTitle)} aria-expanded={open} disabled={lock === 'submitting'} onClick={() => setOpen(true)}>{spec.buttonLabel}</button>
  )
  const panel = (
    <>
      {sentLine !== null ? <p className="ah-inbox-objection-sent" data-objection-sent="true">{sentLine}</p> : null}
      {open && lock !== 'done' ? (
        <div className="ah-inbox-objection">
          {/* 仅有 placeholder 不构成稳定的可达名称：补 aria-label，与占位文字同一句。 */}
          {/* P74i-m5（第 5 节）：字数上限 500，接近上限时在输入框下面写字数，到上限时写明已到上限。 */}
          <input className="ah-inbox-objection-input" aria-label={spec.fieldLabel} placeholder={spec.fieldLabel} value={draft} disabled={frozen}
            maxLength={OBJECTION_CHAR_LIMIT}
            onChange={event => setDraft((event.target as HTMLInputElement).value)}
            onKeyDown={event => {
              // 中文输入法组合态的回车只是上屏候选词，不算发送。
              if (isSendEnter(event.nativeEvent) && text !== '' && !frozen) submit()
            }} />
          {countHint !== null ? <p className="ah-inbox-objection-count" aria-live="polite">{countHint}</p> : null}
          <div className="ah-inbox-objection-actions">
            <button type="button" className="ah-btn ah-btn-primary" aria-label={accessibleNameOf(OBJECTION_SEND, itemTitle)} disabled={frozen || text === ''} onClick={submit}>{OBJECTION_SEND}</button>
            <button type="button" className="ah-btn ah-btn-ghost" aria-label={accessibleNameOf(OBJECTION_CANCEL, itemTitle)} disabled={frozen} onClick={cancel}>{OBJECTION_CANCEL}</button>
          </div>
          {error !== null ? <p className="ah-card-error" role="alert">{error}</p> : null}
        </div>
      ) : null}
    </>
  )
  return props.children({ button, panel })
}

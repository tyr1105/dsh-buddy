/**
 * 通用二次确认弹窗：危险 / 可逆动作（归档、恢复等）先让主人确认后果。
 *
 * 为什么单独成文件：项目页与资料页都要用同一个确认框；原先它放在编制弹窗文件里，
 * 编制整层取消后这里保留一份与编制无关的实现，文案全部由调用方按动作给全。
 */
import type { ReactNode } from 'react'
import { useDialogFocus } from './use-dialog-focus.js'

export function ConfirmDialog(props: {
  title: string
  text: string
  confirmText: string
  busy: boolean
  error: string | null
  onCancel: () => void
  onConfirm: () => void
  /** 确认按钮的语气：危险操作（归档）用 danger，可逆恢复用 primary。 */
  tone?: 'danger' | 'primary'
}): ReactNode {
  const ref = useDialogFocus(props.onCancel, props.busy)
  return (
    <div className="ah-dialog-mask" ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={props.title}>
      <div className="ah-dialog ah-dialog-wide ah-prj-dialog">
        <header className="ah-wizard-head">
          <h2>{props.title}</h2>
          <button type="button" className="ah-btn ah-btn-ghost" disabled={props.busy} onClick={props.onCancel}>关闭</button>
        </header>
        <div className="ah-prj-form"><p>{props.text}</p></div>
        {props.error ? <p className="ah-settings-error" role="alert">{props.error}</p> : null}
        <footer className="ah-dialog-actions">
          <button type="button" className="ah-btn" disabled={props.busy} onClick={props.onCancel}>取消</button>
          <button type="button" className={`ah-btn ${props.tone === 'primary' ? 'ah-btn-primary' : 'ah-btn-danger'}`}
            disabled={props.busy} onClick={props.onConfirm}>{props.busy ? '处理中…' : props.confirmText}</button>
        </footer>
      </div>
    </div>
  )
}

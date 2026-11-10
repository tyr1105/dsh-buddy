/**
 * 项目页弹窗共用小件（V2-PH4-04 从 project-dialogs.tsx 抽出）：
 * - DialogShell：遮罩 + 宽对话框 + 头部关闭，焦点圈定走 useDialogFocus
 *   （打开聚焦、Tab 不外逃、Esc 关闭、提交中不关闭），项目页所有模态表单共用；
 * - FieldError：字段级错误，命令错误优先显示在外壳底部，避免同一句红字出现两遍；
 * - botText：队友选项的一行文案（名字＋生命周期），项目表单里选负责人和成员时用。
 * 单独成文件是为了让 project-dialogs.tsx 聚焦项目表单本身，也方便其他弹窗复用外壳。
 */
import { type ReactNode } from 'react'
import type { BotOption } from '../logic/project-page.js'
import { useDialogFocus } from './use-dialog-focus.js'

/** 弹窗外壳：遮罩 + 宽对话框 + 头部关闭；焦点管理与资料弹窗完全一致。 */
export function DialogShell(props: {
  title: string
  busy: boolean
  onClose: () => void
  children: ReactNode
  footer: ReactNode
  error?: string | null
  /** 个别弹窗要自己的布局时（比如编辑队友的中间滚动）追加的类名。 */
  className?: string
}): ReactNode {
  const ref = useDialogFocus(props.onClose, props.busy)
  return (
    <div className="ah-dialog-mask" ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={props.title}>
      <div className={`ah-dialog ah-dialog-wide ah-prj-dialog${props.className ? ` ${props.className}` : ''}`}>
        <header className="ah-wizard-head">
          <h2>{props.title}</h2>
          <button type="button" className="ah-btn ah-btn-ghost" disabled={props.busy} onClick={props.onClose}>关闭</button>
        </header>
        <div className="ah-prj-form">{props.children}</div>
        {props.error ? <p className="ah-settings-error" role="alert">{props.error}</p> : null}
        <footer className="ah-dialog-actions">{props.footer}</footer>
      </div>
    </div>
  )
}

/** 队友一行的显示文案：名字＋生命周期，让主人勾选时知道选的是谁。 */
export function botText(option: BotOption): string {
  const lifecycle = option.lifecycle === 'probation' ? '试岗' : option.lifecycle === 'active' ? '在岗' : option.lifecycle
  return `${option.name}（${lifecycle}）`
}

/**
 * 字段级错误（命令错误 props.error 优先，避免两处红字互相打架）。
 * id 由调用方传入：出错控件用 aria-describedby 指向这里，焦点落到控件上时
 * 读屏会把错误再念一遍（role=alert 负责提交瞬间的即时播报，两者互补不冲突）。
 */
export function FieldError(props: { show: boolean; message?: string | null; id?: string }): ReactNode {
  if (!props.show || !props.message) return null
  return <p className="ah-settings-error" id={props.id} role="alert">{props.message}</p>
}

/**
 * 资料新建 / 编辑弹窗（P50）：名称、类型、位置，以及「谁能读」。
 *
 * 授权合并在这一个表单里：选「指定队友可读」时直接勾选队友。弹窗用同一套焦点圈定
 * （useDialogFocus：打开聚焦、Tab 不外逃、Esc 关闭、提交中不关闭）与同一套字段
 * 样式；busy/error 由页面统一持有（core 回的中文错误原样显示在弹窗内，不关窗、
 * 不丢输入）。所有提交入参在这里按 core zod 的形状拼好（strictObject，多余键会被
 * 拒）。前端只做「空、超长、明显不是 http(s)/绝对路径」的前置校验，路径越界与
 * 对象存在性交给 core 兜底，不复制 core 的规则。
 */
import { useRef, useState, type ReactNode } from 'react'
import type { ResourceViewRow } from '../../shared/views.js'
import {
  RESOURCE_KIND_OPTIONS, RESOURCE_SENSITIVITY_OPTIONS,
  buildSaveResourceInput, validateResourceAccess, validateResourceForm,
  type FormResourceKind, type GrantSubjectOption, type ResourceFormError, type ResourceSensitivity,
} from '../logic/resource-page.js'
import { useDialogFocus } from './use-dialog-focus.js'

/** 弹窗外壳：遮罩 + 宽对话框 + 头部关闭；焦点管理与项目弹窗一致。 */
function DialogShell(props: {
  title: string
  busy: boolean
  onClose: () => void
  children: ReactNode
  footer: ReactNode
  error?: string | null
}): ReactNode {
  const ref = useDialogFocus(props.onClose, props.busy)
  return (
    <div className="ah-dialog-mask" ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={props.title}>
      <div className="ah-dialog ah-dialog-wide ah-res-dialog">
        <header className="ah-wizard-head">
          <h2>{props.title}</h2>
          <button type="button" className="ah-btn ah-btn-ghost" disabled={props.busy} onClick={props.onClose}>关闭</button>
        </header>
        <div className="ah-res-form">{props.children}</div>
        {props.error ? <p className="ah-settings-error" role="alert">{props.error}</p> : null}
        <footer className="ah-dialog-actions">{props.footer}</footer>
      </div>
    </div>
  )
}

/** 表单提交的内容：资料本身，以及选了指定队友时勾选的队友。 */
export interface ResourceFormSubmit {
  resource: Record<string, unknown>
  botIds: string[]
}

/** 「谁能读」两个选项各自的一句话说明。 */
const ACCESS_HINTS: Readonly<Record<ResourceSensitivity, string>> = {
  normal: '所有在岗和试岗的队友都能读',
  restricted: '只有下面勾选的队友能读',
}

/** 资料新建 / 编辑对话框。 */
export function ResourceFormDialog(props: {
  editing: ResourceViewRow | null
  busy: boolean
  /** 命令失败时 core 的中文错误（页面持有，弹窗不关、输入不丢）。 */
  error: string | null
  onClose: () => void
  onSubmit: (value: ResourceFormSubmit) => void
  /** 可以授权的队友。 */
  bots: readonly GrantSubjectOption[]
}): ReactNode {
  const initial = props.editing?.resource
  const [name, setName] = useState(initial?.name ?? '')
  // 编辑时类型必然是 dir/file/url（note 本期无法创建）；新建默认目录。
  const [kind, setKind] = useState<FormResourceKind>(
    initial && initial.kind !== 'note' ? initial.kind : 'dir',
  )
  const [locator, setLocator] = useState(initial?.locator ?? '')
  // 新建时不预选：必须明确决定谁能读，避免手滑把资料开放给全队。
  const [access, setAccess] = useState<ResourceSensitivity | null>(initial?.sensitivity ?? null)
  const [botIds, setBotIds] = useState<string[]>(() => (props.editing?.grants ?? []).filter(g => g.subjectName !== null).map(g => g.subjectId))
  const [fieldError, setFieldError] = useState<ResourceFormError | null>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  const locatorRef = useRef<HTMLInputElement>(null)

  const editing = props.editing !== null

  const submit = (): void => {
    const error = validateResourceForm({ name, kind, locator, sensitivity: access ?? 'restricted' }) ?? validateResourceAccess(access, botIds)
    if (error) {
      setFieldError(error)
      // 把焦点送到出错字段：主人不用自己找是哪一项。
      if (error.field === 'name') nameRef.current?.focus()
      else if (error.field === 'locator') locatorRef.current?.focus()
      return
    }
    props.onSubmit({
      resource: buildSaveResourceInput({ name, kind, locator, sensitivity: access ?? 'restricted' }, props.editing?.resource.id),
      // 全员可读时不改动已有授权，之后切回指定队友还能沿用。
      botIds: access === 'restricted' ? botIds : (props.editing?.grants ?? []).map(g => g.subjectId),
    })
  }

  const toggleBot = (id: string, on: boolean): void => {
    setBotIds(prev => on ? [...prev, id] : prev.filter(item => item !== id))
    setFieldError(null)
  }

  // 命令错误（props.error）显示在外壳底部；本地字段错误在没有命令错误时就地显示在字段下。
  // 两处互斥渲染同一句只播一遍：外壳绝不再兜底 fieldError，避免读屏双播报。
  const fieldErrorText = props.error === null && fieldError ? fieldError.message : null

  return (
    <DialogShell title={editing ? `编辑资料：${initial?.name ?? ''}` : '新资料'} busy={props.busy} error={props.error} onClose={props.onClose}
      footer={<>
        <button type="button" className="ah-btn" disabled={props.busy} onClick={props.onClose}>取消</button>
        <button type="button" className="ah-btn ah-btn-primary" disabled={props.busy} onClick={submit}>{props.busy ? '保存中…' : '保存资料'}</button>
      </>}>
      <div className="ah-wizard-field">
        <label>资料名称（1–120 字）
          <input ref={nameRef} value={name} disabled={props.busy} autoFocus maxLength={120}
            aria-invalid={fieldError?.field === 'name' && fieldErrorText !== null || undefined}
            aria-describedby={fieldError?.field === 'name' && fieldErrorText ? 'ah-res-err-name' : undefined}
            onChange={e => { setName(e.target.value); setFieldError(null) }} placeholder="例如：竞品打法手册" />
        </label>
        {fieldError?.field === 'name' && fieldErrorText ? <p className="ah-settings-error" id="ah-res-err-name" role="alert">{fieldErrorText}</p> : null}
      </div>
      <div className="ah-wizard-grid">
        <label className="ah-wizard-field">类型
          <select value={kind} disabled={props.busy || editing} onChange={e => { setKind(e.target.value as FormResourceKind); setFieldError(null) }}>
            {RESOURCE_KIND_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
      </div>
      {editing ? (
        <p className="ah-right-kv">类型创建后不能修改（目录、文件、链接的读取方式与边界不同）；要换类型请新建一条资料。</p>
      ) : null}
      <div className="ah-wizard-field">
        <label>{kind === 'url' ? '链接地址（http 或 https，1–1000 字）' : '位置（共享目录内的绝对路径，1–1000 字）'}
          <input ref={locatorRef} value={locator} disabled={props.busy} maxLength={1000}
            aria-invalid={fieldError?.field === 'locator' && fieldErrorText !== null || undefined}
            aria-describedby={fieldError?.field === 'locator' && fieldErrorText ? 'ah-res-err-locator' : undefined}
            onChange={e => { setLocator(e.target.value); setFieldError(null) }}
            placeholder={kind === 'url' ? 'https://example.com/...' : '/path/to/shared/...'} />
        </label>
        {fieldError?.field === 'locator' && fieldErrorText ? <p className="ah-settings-error" id="ah-res-err-locator" role="alert">{fieldErrorText}</p> : null}
        {kind !== 'url' ? (
          <p className="ah-right-kv">目录和文件必须放在数据目录下的 shared 文件夹里。</p>
        ) : null}
      </div>
      <fieldset className="ah-res-access">
        <legend>谁能读</legend>
        {RESOURCE_SENSITIVITY_OPTIONS.map(option => (
          <label key={option.value} className="ah-res-access-option">
            <input type="radio" name="ah-res-access" checked={access === option.value} disabled={props.busy}
              onChange={() => { setAccess(option.value); setFieldError(null) }} />
            <span>{option.label}<small>{ACCESS_HINTS[option.value]}</small></span>
          </label>
        ))}
        {access === 'restricted' ? (
          props.bots.length > 0 ? (
            <div className="ah-res-bots" role="group" aria-label="选择能读的队友">
              {props.bots.map(bot => (
                <label key={bot.id}>
                  <input type="checkbox" checked={botIds.includes(bot.id)} disabled={props.busy} onChange={e => toggleBot(bot.id, e.target.checked)} />
                  <span>{bot.label}</span>
                </label>
              ))}
            </div>
          ) : <p className="ah-empty">暂无队友。请先在主视图新建队友。</p>
        ) : null}
        {fieldError?.field === 'access' && fieldErrorText ? <p className="ah-settings-error" role="alert">{fieldErrorText}</p> : null}
      </fieldset>
    </DialogShell>
  )
}

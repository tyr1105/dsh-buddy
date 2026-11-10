/**
 * 项目的新建 / 编辑弹窗（P60）：项目名、负责人、成员、文件路径、背景，底部放项目状态动作。
 *
 * 为什么只有这五项：主人要的是「开会话说诉求，负责人自己安排」，派活、验收项这些都拿掉了。
 * 外壳复用 DialogShell（遮罩、Tab 圈定、Esc 关闭）；命令错误由页面持有，失败时弹窗不关、输入不丢。
 * 暂停 / 恢复 / 完成 / 归档放在底部靠左，和保存分开，免得误点；归档的二次确认由页面弹出。
 */
import { useRef, useState, type ReactNode } from 'react'
import type { ProjectViewRow } from '../../shared/views.js'
import {
  PROJECT_BACKGROUND_MAX, PROJECT_MEMBER_MAX, PROJECT_NAME_MAX, PROJECT_SHARED_DIR_MAX,
  initialProjectForm, ownerChoices, validateProjectForm, withMembers,
  type ProjectFormError, type ProjectFormValues,
} from '../logic/project-form.js'
import { canManageProject, projectStatusActions, type BotOption, type ProjectStatusAction } from '../logic/project-page.js'
import { DialogShell, FieldError, botText } from './prj-dialog-shell.js'

export function ProjectFormDialog(props: {
  /** null 表示新建项目。 */
  editing: ProjectViewRow | null
  options: BotOption[]
  /** 总览是否已加载：候选为空时区分「还没加载」与「真的没有可用队友」。 */
  botsLoaded?: boolean
  busy: boolean
  /** 命令失败时 core 的中文错误。 */
  error: string | null
  /** 状态动作成功后的一句话；弹窗不关，提示留在这里。 */
  note: string | null
  onClose: () => void
  onSubmit: (values: ProjectFormValues) => void
  onStatusAction: (action: ProjectStatusAction) => void
  onArchive: () => void
}): ReactNode {
  const [values, setValues] = useState<ProjectFormValues>(() => initialProjectForm(props.editing, props.options))
  // 现任负责人的快照：旧项目的负责人如果是建议风格，不换人时不算违规。
  const [initialOwnerId] = useState(values.ownerBotId)
  const [fieldError, setFieldError] = useState<ProjectFormError | null>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  const ownerRef = useRef<HTMLSelectElement>(null)
  const membersRef = useRef<HTMLFieldSetElement>(null)
  const dirRef = useRef<HTMLInputElement>(null)
  const backgroundRef = useRef<HTMLTextAreaElement>(null)

  const editing = props.editing
  const atCap = values.memberBotIds.length >= PROJECT_MEMBER_MAX
  const choices = ownerChoices(values, props.options, initialOwnerId)
  // 命令错误显示在外壳底部，没有命令错误时才显示字段错误，同一句话不出现两遍。
  const localError = props.error === null ? fieldError : null

  const update = (partial: Partial<ProjectFormValues>): void => {
    setValues(prev => ({ ...prev, ...partial }))
    setFieldError(null)
  }

  /** 勾选成员时顺带维护负责人：规则在 withMembers，默认选总管。 */
  const toggleMember = (botId: string): void => {
    setValues(prev => withMembers(
      prev,
      prev.memberBotIds.includes(botId) ? prev.memberBotIds.filter(id => id !== botId) : [...prev.memberBotIds, botId],
      props.options,
    ))
    setFieldError(null)
  }

  const submit = (): void => {
    const problem = validateProjectForm(values, props.options, initialOwnerId)
    if (problem !== null) {
      setFieldError(problem)
      // 焦点跟着错误走，主人不用自己找是哪一项。
      if (problem.field === 'name') nameRef.current?.focus()
      else if (problem.field === 'owner') ownerRef.current?.focus()
      else if (problem.field === 'members') membersRef.current?.focus()
      else if (problem.field === 'sharedDir') dirRef.current?.focus()
      else backgroundRef.current?.focus()
      return
    }
    props.onSubmit(values)
  }

  return (
    <DialogShell
      title={editing !== null ? `编辑项目：${editing.project.name}` : '新项目'}
      className="ah-teammate-edit ah-prj-edit"
      busy={props.busy}
      error={props.error}
      onClose={props.onClose}
      footer={<>
        {/* 项目状态动作靠左、保存靠右，两类动作分开放；新建时没有状态可改。 */}
        <div className="ah-teammate-life" role="group" aria-label="项目状态">
          {editing !== null ? projectStatusActions(editing.project.status).map(action => (
            <button key={action.command} type="button" className="ah-btn" disabled={props.busy}
              onClick={() => props.onStatusAction(action)}>{action.label}</button>
          )) : null}
          {editing !== null && canManageProject(editing.project.status) ? (
            <button type="button" className="ah-btn ah-btn-ghost" disabled={props.busy} onClick={props.onArchive}>归档</button>
          ) : null}
          {props.note !== null ? <span className="ah-teammate-life-note" role="status">{props.note}</span> : null}
        </div>
        <div className="ah-teammate-save">
          <button type="button" className="ah-btn" disabled={props.busy} onClick={props.onClose}>取消</button>
          <button type="button" className="ah-btn ah-btn-primary" disabled={props.busy} onClick={submit}>保存</button>
        </div>
      </>}
    >
      <div className="ah-wizard-field">
        <label>项目名称
          <input ref={nameRef} value={values.name} disabled={props.busy} autoFocus maxLength={PROJECT_NAME_MAX}
            aria-invalid={localError?.field === 'name' || undefined}
            aria-describedby={localError?.field === 'name' ? 'ah-prj-form-err-name' : undefined}
            onChange={e => update({ name: e.target.value })} placeholder="例如：竞品周报自动化" />
        </label>
        <FieldError id="ah-prj-form-err-name" show={localError?.field === 'name'} message={localError?.message} />
      </div>

      <div className="ah-wizard-field">
        <label>负责人（诉求默认发给 TA，由 TA 安排大家）
          <select ref={ownerRef} value={values.ownerBotId} disabled={props.busy}
            aria-invalid={localError?.field === 'owner' || undefined}
            aria-describedby={localError?.field === 'owner' ? 'ah-prj-form-err-owner' : undefined}
            onChange={e => update({ ownerBotId: e.target.value })}>
            {values.ownerBotId === '' ? <option value="">{choices.length === 0 ? '先在下面勾选成员' : '请选择'}</option> : null}
            {choices.map(choice => <option key={choice.botId} value={choice.botId} disabled={choice.disabled}>{choice.name}</option>)}
          </select>
        </label>
        <FieldError id="ah-prj-form-err-owner" show={localError?.field === 'owner'} message={localError?.message} />
      </div>

      <fieldset className="ah-prj-field ah-prj-members" ref={membersRef} tabIndex={-1}
        aria-invalid={localError?.field === 'members' || undefined}
        aria-describedby={localError?.field === 'members' ? 'ah-prj-form-err-members' : undefined}>
        <legend>成员（{values.memberBotIds.length}/{PROJECT_MEMBER_MAX}）</legend>
        {props.options.length === 0 ? (
          <p className="ah-right-kv">
            {props.botsLoaded === false ? '队友列表加载中，请稍候。' : '暂无可选队友（已退役不计入）。请先在左侧「队友」组点击「＋」新建，再回来勾选。'}
          </p>
        ) : (
          <div className="ah-prj-check-list">
            {props.options.map(option => {
              const checked = values.memberBotIds.includes(option.botId)
              return (
                <label key={option.botId} className={!checked && atCap ? 'ah-prj-check-disabled' : ''}>
                  <input type="checkbox" checked={checked} disabled={props.busy || (!checked && atCap)}
                    onChange={() => toggleMember(option.botId)} />
                  {botText(option)}
                </label>
              )
            })}
          </div>
        )}
        <FieldError id="ah-prj-form-err-members" show={localError?.field === 'members'} message={localError?.message} />
      </fieldset>

      <div className="ah-wizard-field">
        <label>文件路径（可不填，留空由中心给默认路径）
          <input ref={dirRef} value={values.sharedDir} disabled={props.busy} maxLength={PROJECT_SHARED_DIR_MAX}
            aria-invalid={localError?.field === 'sharedDir' || undefined}
            aria-describedby={localError?.field === 'sharedDir' ? 'ah-prj-form-err-dir' : undefined}
            onChange={e => update({ sharedDir: e.target.value })} />
        </label>
        <FieldError id="ah-prj-form-err-dir" show={localError?.field === 'sharedDir'} message={localError?.message} />
      </div>

      <div className="ah-wizard-field">
        <label>项目背景（可不填，负责人会随项目推进更新）
          <textarea ref={backgroundRef} rows={4} value={values.background} disabled={props.busy} maxLength={PROJECT_BACKGROUND_MAX}
            aria-invalid={localError?.field === 'background' || undefined}
            aria-describedby={localError?.field === 'background' ? 'ah-prj-form-err-background' : undefined}
            onChange={e => update({ background: e.target.value })} />
        </label>
        <FieldError id="ah-prj-form-err-background" show={localError?.field === 'background'} message={localError?.message} />
      </div>
    </DialogShell>
  )
}

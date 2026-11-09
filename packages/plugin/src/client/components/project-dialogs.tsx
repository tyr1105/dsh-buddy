/**
 * 项目页的四个表单弹窗（V2-PH4-02 / F12 / F08 尾巴）：项目新建/编辑表单、任务新建/编辑表单、
 * 驳回任务表单、关联产物表单。五模式派活对话框在同目录 dispatch-task-dialog.tsx（V2-PH4-04 拆出）。
 *
 * 为什么集中在一个文件：它们都是遮住项目页的模态表单，共用同一套焦点圈定
 * （useDialogFocus：打开聚焦、Tab 不外逃、Esc 关闭、提交中不关闭）与同一套字段
 * 样式；busy/error 由页面统一持有（core 回的中文错误原样显示在弹窗内，不关窗、
 * 不丢输入——驳回理由尤其如此，失败时主人刚写的理由必须留在框里）。所有提交入参
 * 在这里按 core zod 的形状拼好（strictObject，多余键会被拒）。前端只做「空、超长、
 * 负责人没勾进成员、成员超上限」这类不用查数据就能发现的错，成员/队友是否存在、
 * 状态机是否合法都由 core 兜底，不复制 core 的规则。
 */
import { useRef, useState, type ReactNode } from 'react'
import type { ProjectTaskView, ProjectViewRow } from '../../shared/views.js'
import {
  PROJECT_CHARTER_MAX, PROJECT_CONVENTIONS_MAX, PROJECT_CRITERION_MAX, PROJECT_CRITERION_TEXT_MAX,
  PROJECT_CRITERION_VERIFY_MAX, PROJECT_MEMBER_MAX, PROJECT_NAME_MAX, PROJECT_SHARED_DIR_MAX, PROJECT_VISION_MAX,
  TASK_DETAIL_MAX, TASK_REJECT_REASON_MAX, TASK_TITLE_MAX,
  buildAttachTaskArtifactInput, buildRejectTaskInput, buildSaveProjectInput, buildSaveTaskInput,
  initialProjectForm, initialTaskForm, validateArtifactChoice, validateProjectForm, validateRejectReason, validateTaskForm,
  type CriterionFormValues, type ProjectFormError, type ProjectFormValues, type TaskFormValues,
} from '../logic/project-form.js'
import type { BotOption } from '../logic/project-page.js'
import { DialogShell, FieldError, botText } from './prj-dialog-shell.js'

/**
 * 项目新建 / 编辑对话框：名称、一句话目标、项目目录、成员队友（多选）、负责人（单选）、
 * 验收项（可增删改、可勾「已满足」）。成员上限 20：到上限后未勾的队友禁用并说明；
 * 负责人只能从已勾成员里选，取消勾选负责人时负责人自动回到「未指定」。
 * 状态不在这里改（只许走暂停/恢复/完成/归档）。前置校验失败时聚焦第一个出错字段
 * （一次只报一项）。
 */
export function ProjectFormDialog(props: {
  editing: ProjectViewRow | null
  /** 可选队友（总览里未退役的队友 + 视图里防御性补齐的项目成员），失效队友不在此列。 */
  options: BotOption[]
  /** 总览是否已加载：候选为空时区分「还没加载」与「真的没有可用队友」。 */
  botsLoaded?: boolean
  busy: boolean
  /** 命令失败时 core 的中文错误（页面持有，弹窗不关、输入不丢）。 */
  error: string | null
  onClose: () => void
  onSubmit: (raw: Record<string, unknown>) => void
}): ReactNode {
  const [values, setValues] = useState<ProjectFormValues>(() => initialProjectForm(props.editing))
  const [fieldError, setFieldError] = useState<ProjectFormError | null>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  const charterRef = useRef<HTMLTextAreaElement>(null)
  const visionRef = useRef<HTMLTextAreaElement>(null)
  const conventionsRef = useRef<HTMLTextAreaElement>(null)
  const membersRef = useRef<HTMLFieldSetElement>(null)
  const ownerRef = useRef<HTMLFieldSetElement>(null)
  const criteriaRef = useRef<HTMLFieldSetElement>(null)
  const dirRef = useRef<HTMLInputElement>(null)

  const editing = props.editing !== null
  const atCap = values.memberBotIds.length >= PROJECT_MEMBER_MAX

  /** 勾选/取消一个成员队友；取消的若是当前负责人，负责人一并回到「未指定」。 */
  const toggleMember = (id: string): void => {
    setValues(prev => {
      const picked = prev.memberBotIds.includes(id)
        ? prev.memberBotIds.filter(m => m !== id)
        : [...prev.memberBotIds, id]
      const ownerBotId = prev.ownerBotId === id ? '' : prev.ownerBotId
      return { ...prev, memberBotIds: picked, ownerBotId }
    })
    setFieldError(null)
  }

  /** 验收项增删改：全部只改本地表单，保存时才整表提交给 core 校验。 */
  const addCriterion = (): void => {
    setValues(prev => prev.acceptanceCriteria.length >= PROJECT_CRITERION_MAX
      ? prev
      : { ...prev, acceptanceCriteria: [...prev.acceptanceCriteria, { id: null, text: '', verify: '', status: 'open' }] })
    setFieldError(null)
  }
  const updateCriterion = (index: number, patch: Partial<CriterionFormValues>): void => {
    setValues(prev => ({
      ...prev,
      acceptanceCriteria: prev.acceptanceCriteria.map((item, i) => i === index ? { ...item, ...patch } : item),
    }))
    setFieldError(null)
  }
  const removeCriterion = (index: number): void => {
    setValues(prev => ({ ...prev, acceptanceCriteria: prev.acceptanceCriteria.filter((_, i) => i !== index) }))
    setFieldError(null)
  }

  const submit = (): void => {
    const error = validateProjectForm(values)
    if (error) {
      setFieldError(error)
      // 把焦点送到出错字段：主人不用自己找是哪一项。
      if (error.field === 'name') nameRef.current?.focus()
      else if (error.field === 'charter') charterRef.current?.focus()
      else if (error.field === 'vision') visionRef.current?.focus()
      else if (error.field === 'conventions') conventionsRef.current?.focus()
      else if (error.field === 'members') membersRef.current?.focus()
      else if (error.field === 'owner') ownerRef.current?.focus()
      else if (error.field === 'criteria') criteriaRef.current?.focus()
      else dirRef.current?.focus()
      return
    }
    props.onSubmit(buildSaveProjectInput(values, props.editing?.project.id))
  }

  // 命令错误优先显示在外壳底部；没有命令错误时才显示本地字段错误。
  const localError = props.error === null ? fieldError : null
  // 已勾成员对应的选项（负责人单选只列这些，且保持队友目录顺序）。
  const memberOptions = props.options.filter(o => values.memberBotIds.includes(o.botId))

  // 本地字段错误只显示在对应字段下方，外壳底部只放 core 回的命令错误，避免同一句话出现两遍。
  return (
    <DialogShell title={editing ? `编辑项目：${props.editing?.project.name ?? ''}` : '新项目'} busy={props.busy}
      error={props.error} onClose={props.onClose}
      footer={<>
        <button type="button" className="ah-btn" disabled={props.busy} onClick={props.onClose}>取消</button>
        <button type="button" className="ah-btn ah-btn-primary" disabled={props.busy} onClick={submit}>
          {props.busy ? '保存中…' : '保存项目'}
        </button>
      </>}>
      <div className="ah-wizard-field">
        <label>项目名称（1–{PROJECT_NAME_MAX} 字）
          <input ref={nameRef} value={values.name} disabled={props.busy} autoFocus maxLength={PROJECT_NAME_MAX}
            aria-invalid={localError?.field === 'name' || undefined}
            aria-describedby={localError?.field === 'name' ? 'ah-prj-form-err-name' : undefined}
            onChange={e => setValues(prev => ({ ...prev, name: e.target.value }))}
            onInput={() => setFieldError(null)} placeholder="例如：竞品周报自动化" />
        </label>
        <FieldError id="ah-prj-form-err-name" show={localError?.field === 'name'} message={localError?.message} />
      </div>
      <div className="ah-wizard-field">
        <label>一句话目标（可不填，≤{PROJECT_CHARTER_MAX} 字）：做成什么样算完
          <textarea ref={charterRef} rows={2} value={values.charter} disabled={props.busy} maxLength={PROJECT_CHARTER_MAX}
            aria-invalid={localError?.field === 'charter' || undefined}
            aria-describedby={localError?.field === 'charter' ? 'ah-prj-form-err-charter' : undefined}
            onChange={e => setValues(prev => ({ ...prev, charter: e.target.value }))}
            onInput={() => setFieldError(null)} />
        </label>
        <FieldError id="ah-prj-form-err-charter" show={localError?.field === 'charter'} message={localError?.message} />
      </div>
      {/* P34 两层：愿景与约定是「队友项目版本」里的两段说明，允许为空，旧项目保存后可按需补写。 */}
      <div className="ah-wizard-field">
        <label>愿景（可不填，≤{PROJECT_VISION_MAX} 字）：这个项目为什么存在、最终要去哪
          <textarea ref={visionRef} rows={2} value={values.vision} disabled={props.busy} maxLength={PROJECT_VISION_MAX}
            aria-invalid={localError?.field === 'vision' || undefined}
            aria-describedby={localError?.field === 'vision' ? 'ah-prj-form-err-vision' : undefined}
            onChange={e => setValues(prev => ({ ...prev, vision: e.target.value }))}
            onInput={() => setFieldError(null)} />
        </label>
        <FieldError id="ah-prj-form-err-vision" show={localError?.field === 'vision'} message={localError?.message} />
      </div>
      <div className="ah-wizard-field">
        <label>约定（可不填，≤{PROJECT_CONVENTIONS_MAX} 字）：队友之间怎么配合、什么必须先问主人
          <textarea ref={conventionsRef} rows={2} value={values.conventions} disabled={props.busy} maxLength={PROJECT_CONVENTIONS_MAX}
            aria-invalid={localError?.field === 'conventions' || undefined}
            aria-describedby={localError?.field === 'conventions' ? 'ah-prj-form-err-conventions' : undefined}
            onChange={e => setValues(prev => ({ ...prev, conventions: e.target.value }))}
            onInput={() => setFieldError(null)} />
        </label>
        <FieldError id="ah-prj-form-err-conventions" show={localError?.field === 'conventions'} message={localError?.message} />
      </div>
      <fieldset className="ah-prj-field ah-prj-members" ref={membersRef} tabIndex={-1}
        aria-invalid={localError?.field === 'members' || undefined}
        aria-describedby={localError?.field === 'members' ? 'ah-prj-form-err-members' : undefined}>
        <legend>成员队友（{values.memberBotIds.length}/{PROJECT_MEMBER_MAX}）：任务只能派给成员队友</legend>
        {props.options.length === 0 ? (
          // 空候选给明确下一步（P44-R2）：总览未加载与真的没有可用队友是两种不同的处境，
          // 不能都用「先新建队友，或等总览加载出来」让主人猜。
          <p className="ah-right-kv">
            {props.botsLoaded === false
              ? '队友列表加载中，请稍候；也可先保存项目，之后在项目页「编辑」中补充成员。'
              : '暂无可选队友（已退役不计入）。请先在左侧「队友」组点击「＋」新建，再返回勾选为成员。'}
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
      <fieldset className="ah-prj-field" ref={ownerRef} tabIndex={-1}
        aria-invalid={localError?.field === 'owner' || undefined}
        aria-describedby={localError?.field === 'owner' ? 'ah-prj-form-err-owner' : undefined}>
        <legend>负责人（可不填；只能从成员里选）</legend>
        <div className="ah-prj-check-list">
          <label>
            <input type="radio" name="prj-owner" checked={values.ownerBotId === ''} disabled={props.busy}
              onChange={() => setValues(prev => ({ ...prev, ownerBotId: '' }))} />
            未指定
          </label>
          {memberOptions.map(option => (
            <label key={option.botId}>
              <input type="radio" name="prj-owner" checked={values.ownerBotId === option.botId} disabled={props.busy}
                onChange={() => setValues(prev => ({ ...prev, ownerBotId: option.botId }))} />
              {botText(option)}
            </label>
          ))}
        </div>
        <FieldError id="ah-prj-form-err-owner" show={localError?.field === 'owner'} message={localError?.message} />
      </fieldset>
      <fieldset className="ah-prj-field ah-prj-criteria-edit" ref={criteriaRef} tabIndex={-1}
        aria-invalid={localError?.field === 'criteria' || undefined}
        aria-describedby={localError?.field === 'criteria' ? 'ah-prj-form-err-criteria' : undefined}>
        <legend>验收项（{values.acceptanceCriteria.length}/{PROJECT_CRITERION_MAX}）：写清怎么算满足，验收任务时对照检查</legend>
        {values.acceptanceCriteria.length === 0 ? (
          <p className="ah-right-kv">暂无验收项。点击「添加」新建；验收时以此为对照标准。</p>
        ) : (
          <div className="ah-prj-criteria-rows">
            {values.acceptanceCriteria.map((criterion, index) => (
              <div key={criterion.id ?? `new-${index}`} className="ah-prj-criteria-row">
                <div className="ah-prj-criteria-row-head">
                  <span className="ah-prj-block-label">第 {index + 1} 条</span>
                  <label className="ah-prj-criteria-met"
                    title={criterion.id === null ? '新验收项保存后才能标记为已满足' : undefined}>
                    <input type="checkbox" checked={criterion.status === 'met'}
                      disabled={props.busy || criterion.id === null}
                      onChange={e => updateCriterion(index, { status: e.target.checked ? 'met' : 'open' })} />
                    已满足
                  </label>
                  <button type="button" className="ah-btn ah-btn-ghost" disabled={props.busy}
                    onClick={() => removeCriterion(index)}>删除</button>
                </div>
                <input value={criterion.text} disabled={props.busy} maxLength={PROJECT_CRITERION_TEXT_MAX}
                  aria-label={`第 ${index + 1} 条验收标准`}
                  onChange={e => updateCriterion(index, { text: e.target.value })}
                  placeholder="验收标准，例如：周报每周一 09:00 前出现在项目目录" />
                <input value={criterion.verify} disabled={props.busy} maxLength={PROJECT_CRITERION_VERIFY_MAX}
                  aria-label={`第 ${index + 1} 条验证方式`}
                  onChange={e => updateCriterion(index, { verify: e.target.value })}
                  placeholder="怎么验证（可不填），例如：打开产出文件看发布时间" />
              </div>
            ))}
          </div>
        )}
        <div className="ah-prj-criteria-foot">
          <button type="button" className="ah-btn ah-btn-ghost"
            disabled={props.busy || values.acceptanceCriteria.length >= PROJECT_CRITERION_MAX}
            onClick={addCriterion}>＋ 添加验收项</button>
          {values.acceptanceCriteria.length >= PROJECT_CRITERION_MAX
            ? <span className="ah-right-kv">已达 {PROJECT_CRITERION_MAX} 条上限</span> : null}
        </div>
        <FieldError id="ah-prj-form-err-criteria" show={localError?.field === 'criteria'} message={localError?.message} />
      </fieldset>
      <div className="ah-wizard-field">
        <label>项目目录（可不填，≤{PROJECT_SHARED_DIR_MAX} 字）：保存时中心会在 projects 子树下创建这个文件夹
          <input ref={dirRef} value={values.sharedDir} disabled={props.busy} maxLength={PROJECT_SHARED_DIR_MAX}
            aria-invalid={localError?.field === 'sharedDir' || undefined}
            aria-describedby={localError?.field === 'sharedDir' ? 'ah-prj-form-err-dir' : undefined}
            onChange={e => setValues(prev => ({ ...prev, sharedDir: e.target.value }))}
            onInput={() => setFieldError(null)} placeholder="留空由中心给默认路径" />
        </label>
        <FieldError id="ah-prj-form-err-dir" show={localError?.field === 'sharedDir'} message={localError?.message} />
      </div>
      {editing ? (
        <p className="ah-right-kv">成员名单保存后立即生效：取消勾选的队友将移出成员，其名下任务会在问题区提示并需重新指派。项目状态请用卡片上的暂停 / 完成 / 归档按钮修改。</p>
      ) : null}
    </DialogShell>
  )
}

/**
 * 任务新建 / 编辑对话框：标题、说明、指派队友。
 * 选项只含项目当前的有效成员队友（空=待认领）；状态不在这里改，只许走
 * 标记受阻 / 恢复 / 交账 / 验收 / 驳回这些流转命令。
 */
export function TaskFormDialog(props: {
  /** 所属项目行：取 projectId 与成员队友选项。 */
  row: ProjectViewRow
  /** null=新建任务；非 null=编辑这条任务。 */
  editing: ProjectTaskView | null
  assigneeOptions: BotOption[]
  busy: boolean
  error: string | null
  onClose: () => void
  onSubmit: (raw: Record<string, unknown>) => void
}): ReactNode {
  const [values, setValues] = useState<TaskFormValues>(() => initialTaskForm(props.editing))
  const [fieldError, setFieldError] = useState<{ field: 'title' | 'detail'; message: string } | null>(null)
  const titleRef = useRef<HTMLInputElement>(null)
  const detailRef = useRef<HTMLTextAreaElement>(null)

  const editing = props.editing !== null

  const submit = (): void => {
    const error = validateTaskForm(values)
    if (error) {
      setFieldError(error)
      if (error.field === 'title') titleRef.current?.focus()
      else detailRef.current?.focus()
      return
    }
    props.onSubmit(buildSaveTaskInput(props.row.project.id, values, props.editing?.task.id))
  }

  // 本地字段错误就地渲染（FieldError），外壳底部只放命令错误：同一句不双渲染、读屏不念两遍。
  const localError = props.error === null ? fieldError : null

  return (
    <DialogShell title={editing ? `编辑任务：${props.editing?.task.title ?? ''}` : `新任务（${props.row.project.name}）`}
      busy={props.busy} error={props.error} onClose={props.onClose}
      footer={<>
        <button type="button" className="ah-btn" disabled={props.busy} onClick={props.onClose}>取消</button>
        <button type="button" className="ah-btn ah-btn-primary" disabled={props.busy} onClick={submit}>
          {props.busy ? '保存中…' : '保存任务'}
        </button>
      </>}>
      <div className="ah-wizard-field">
        <label>任务标题（1–{TASK_TITLE_MAX} 字）
          <input ref={titleRef} value={values.title} disabled={props.busy} autoFocus maxLength={TASK_TITLE_MAX}
            aria-invalid={localError?.field === 'title' || undefined}
            aria-describedby={localError?.field === 'title' ? 'ah-task-form-err-title' : undefined}
            onChange={e => setValues(prev => ({ ...prev, title: e.target.value }))}
            onInput={() => setFieldError(null)} placeholder="例如：产出第 45 周周报初稿" />
        </label>
        <FieldError id="ah-task-form-err-title" show={localError?.field === 'title'} message={localError?.message} />
      </div>
      <div className="ah-wizard-field">
        <label>任务说明（可不填，≤{TASK_DETAIL_MAX} 字）：要交什么、注意什么
          <textarea ref={detailRef} rows={4} value={values.detail} disabled={props.busy} maxLength={TASK_DETAIL_MAX}
            aria-invalid={localError?.field === 'detail' || undefined}
            aria-describedby={localError?.field === 'detail' ? 'ah-task-form-err-detail' : undefined}
            onChange={e => setValues(prev => ({ ...prev, detail: e.target.value }))}
            onInput={() => setFieldError(null)} />
        </label>
        <FieldError id="ah-task-form-err-detail" show={localError?.field === 'detail'} message={localError?.message} />
      </div>
      <div className="ah-wizard-field">
        <label>指派给谁（只能派给项目成员队友；不选就是待认领）
          <select value={values.assigneeBotId} disabled={props.busy}
            onChange={e => setValues(prev => ({ ...prev, assigneeBotId: e.target.value }))}>
            <option value="">待认领</option>
            {props.assigneeOptions.map(option => <option key={option.botId} value={option.botId}>{botText(option)}</option>)}
          </select>
        </label>
        {props.assigneeOptions.length === 0 ? (
          <p className="ah-right-kv">项目暂无在岗成员队友。请先编辑项目勾选成员；否则任务将标记为「待认领」。</p>
        ) : null}
      </div>
      {editing && props.editing ? (
        <p className="ah-right-kv">当前状态：{props.editing.statusLabel}。状态只能用任务行上的按钮推进，编辑保存不会改状态。</p>
      ) : null}
    </DialogShell>
  )
}

/**
 * 驳回任务对话框：理由必填（trim 后 1–500 字），提交后 core 把任务退回「进行中」。
 * 失败时弹窗不关、理由不丢（页面持有 error，本组件持有输入）。字数在右下角实时提示。
 */
export function RejectTaskDialog(props: {
  task: ProjectTaskView
  busy: boolean
  error: string | null
  onClose: () => void
  onSubmit: (raw: Record<string, unknown>) => void
}): ReactNode {
  const [reason, setReason] = useState('')
  const [fieldError, setFieldError] = useState<string | null>(null)
  const reasonRef = useRef<HTMLTextAreaElement>(null)

  const submit = (): void => {
    const error = validateRejectReason(reason)
    if (error) {
      setFieldError(error)
      reasonRef.current?.focus()
      return
    }
    props.onSubmit(buildRejectTaskInput(props.task.task.id, reason))
  }

  const trimmedLength = reason.trim().length
  const over = trimmedLength > TASK_REJECT_REASON_MAX
  // 命令错误才放外壳底部；本地校验错误就地显示在输入框下方，便于 aria-describedby 关联。
  const localError = props.error === null ? fieldError : null

  return (
    <DialogShell title={`驳回任务：${props.task.task.title}`} busy={props.busy}
      error={props.error} onClose={props.onClose}
      footer={<>
        <button type="button" className="ah-btn" disabled={props.busy} onClick={props.onClose}>取消</button>
        <button type="button" className="ah-btn ah-btn-danger" disabled={props.busy} onClick={submit}>
          {props.busy ? '提交中…' : '确认驳回'}
        </button>
      </>}>
      <p className="ah-right-kv">驳回后任务退回「进行中」，执行者按驳回理由返工。请说明问题与修改要求（1–{TASK_REJECT_REASON_MAX} 字）。</p>
      <div className="ah-wizard-field">
        <textarea ref={reasonRef} rows={5} value={reason} disabled={props.busy} autoFocus maxLength={TASK_REJECT_REASON_MAX + 20}
          aria-label="驳回理由" placeholder="例如：信源只覆盖了三家，缺的两家补上；结论里补上原文链接。"
          aria-invalid={localError !== null || undefined}
          aria-describedby={localError !== null ? 'ah-task-reject-err' : undefined}
          onChange={e => { setReason(e.target.value); setFieldError(null) }} />
        <p className={`ah-prj-count${over ? ' ah-prj-count-over' : ''}`} aria-live="polite">
          {trimmedLength}/{TASK_REJECT_REASON_MAX}
        </p>
        <FieldError id="ah-task-reject-err" show={localError !== null} message={localError} />
      </div>
    </DialogShell>
  )
}

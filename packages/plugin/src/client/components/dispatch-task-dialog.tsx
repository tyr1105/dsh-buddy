/**
 * 派活对话框（V2-PH4-04）：统一承接 core dispatchTask 的五种模式——
 * 派活（todo）/ 恢复并派活（blocked）/ 重新派活（rejected）/ 催办（doing 同队友）/
 * 改派（doing 换人）。标题、按钮、底部后果解释、成功轻提示全部按 DISPATCH_MODE_COPY 换文案。
 *
 * 队友选择器沿用既有约束：只列在岗/试岗的项目成员队友（core 同样要求）。
 * 催办模式队友固定为任务当前承接队友、不可改；改派模式默认不预选，
 * 引导主人另选一位（选回原队友 core 语义等同催办，UI 不强行拦）。留言可选、≤500 字，
 * trim 后为空则不带 note。失败时弹窗不关、队友选择与留言都不丢（busy/error 由页面持有）。
 * 从 project-dialogs.tsx 拆出是因为该文件加本框后超过单文件 400 行上限。
 */
import { useRef, useState, type ReactNode } from 'react'
import type { ProjectTaskView } from '../../shared/views.js'
import {
  DISPATCH_NOTE_MAX, buildDispatchTaskInput, validateDispatchBot, validateDispatchNote,
} from '../logic/project-form.js'
import { DISPATCH_MODE_COPY, type BotOption, type DispatchMode } from '../logic/project-page.js'
import { DialogShell, FieldError, botText } from './prj-dialog-shell.js'

export function DispatchTaskDialog(props: {
  /** 所属项目 id：dispatchTask 入参必须带 projectId 防跨项目误派。 */
  projectId: string
  task: ProjectTaskView
  /** 五种模式之一，决定全部文案与队友选择器是否锁定。 */
  mode: DispatchMode
  /** 项目当前可接活的成员队友。 */
  options: BotOption[]
  busy: boolean
  error: string | null
  onClose: () => void
  onSubmit: (raw: Record<string, unknown>) => void
}): ReactNode {
  const copy = DISPATCH_MODE_COPY[props.mode]
  // 催办：队友锁定为当前承接队友（动作表只在有承接人时给入口，这里防御性回退空串）。
  const fixedBot = props.mode === 'nudge' ? (props.task.assigneeBotId ?? '') : null
  // 恢复/重新派活/新派默认沿用任务已指派且在选项里的队友；改派默认不预选，引导另选。
  const preselected = fixedBot
    ?? (props.mode === 'reassign' ? '' : (props.options.find(o =>
      o.botId === props.task.assigneeBotId)?.botId ?? ''))
  const [botId, setBotId] = useState(preselected)
  const [note, setNote] = useState('')
  const [botError, setBotError] = useState<string | null>(null)
  const [noteError, setNoteError] = useState<string | null>(null)
  const botRef = useRef<HTMLSelectElement>(null)
  const noteRef = useRef<HTMLTextAreaElement>(null)

  const submit = (): void => {
    // 先查队友再查留言，聚焦到第一个出错控件；催办队友锁定也防一道空值。
    const botProblem = validateDispatchBot(botId)
    if (botProblem) {
      setBotError(botProblem)
      setNoteError(null)
      botRef.current?.focus()
      return
    }
    const noteProblem = validateDispatchNote(note)
    if (noteProblem) {
      setNoteError(noteProblem)
      setBotError(null)
      noteRef.current?.focus()
      return
    }
    props.onSubmit(buildDispatchTaskInput(props.projectId, props.task.task.id, botId, note))
  }

  // 催办队友理论上必在成员选项里；总览没加载等极端情况下补一条只读选项，不瞎编名字。
  const shownOptions = fixedBot !== null && !props.options.some(o => o.botId === fixedBot)
    ? [...props.options, {
      botId: fixedBot,
      name: props.task.assigneeBotName ?? fixedBot,
      lifecycle: 'active' as const,
    }]
    : props.options

  const trimmedLength = note.trim().length
  const over = trimmedLength > DISPATCH_NOTE_MAX
  // 外壳底部只放 core 回来的命令错误（全局、不绑字段）；本地校验错误只在对应字段
  // 下方显示一次，避免同一句红字在字段下和外壳底部出现两遍（走查截图抓到过重复）。
  // 命令错误在场时隐藏字段级错误，让两类错误互不打架。
  const localBotError = props.error === null ? botError : null
  const localNoteError = props.error === null ? noteError : null

  return (
    <DialogShell title={`${copy.verb}：${props.task.task.title}`} busy={props.busy}
      error={props.error} onClose={props.onClose}
      footer={<>
        <button type="button" className="ah-btn" disabled={props.busy} onClick={props.onClose}>取消</button>
        <button type="button" className="ah-btn ah-btn-primary" disabled={props.busy} onClick={submit}>
          {props.busy ? copy.busy : copy.confirm}
        </button>
      </>}>
      <p className="ah-right-kv">{copy.explain}</p>
      <div className="ah-wizard-field">
        <label>{fixedBot !== null ? '当前承接队友（催办不换人）' : '派给哪位队友'}
          <select ref={botRef} value={botId} disabled={props.busy || fixedBot !== null}
            autoFocus={fixedBot === null}
            aria-invalid={localBotError !== null || undefined}
            aria-describedby={localBotError !== null ? 'ah-dispatch-err-bot' : undefined}
            onChange={e => { setBotId(e.target.value); setBotError(null) }}>
            {fixedBot !== null ? null : <option value="">选择队友</option>}
            {shownOptions.map(option => (
              <option key={option.botId} value={option.botId}>{botText(option)}</option>
            ))}
          </select>
        </label>
        {props.options.length === 0 ? (
          <p className="ah-right-kv">项目还没有在岗的成员队友：先编辑项目勾选成员，并确认队友处于在岗或试岗状态。</p>
        ) : null}
        <FieldError id="ah-dispatch-err-bot" show={localBotError !== null} message={localBotError} />
      </div>
      <div className="ah-wizard-field">
        <label>给队友留言（可不填，≤{DISPATCH_NOTE_MAX} 字）：原话会直接发到队友的线程
          <textarea ref={noteRef} rows={4} value={note} disabled={props.busy}
            autoFocus={fixedBot !== null} maxLength={DISPATCH_NOTE_MAX + 20}
            aria-label="派活留言" placeholder="可选：补一句具体要求，例如：今天下班前先给一版初稿；卡住就说明原因。"
            aria-invalid={localNoteError !== null || undefined}
            aria-describedby={localNoteError !== null ? 'ah-dispatch-err-note' : undefined}
            onChange={e => { setNote(e.target.value); setNoteError(null) }} />
        </label>
        <p className={`ah-prj-count${over ? ' ah-prj-count-over' : ''}`} aria-live="polite">
          {trimmedLength}/{DISPATCH_NOTE_MAX}
        </p>
        <FieldError id="ah-dispatch-err-note" show={localNoteError !== null} message={localNoteError} />
      </div>
    </DialogShell>
  )
}

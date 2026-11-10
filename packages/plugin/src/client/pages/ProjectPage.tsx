/**
 * 项目页（P60，决策 DC35）：主人觉得原来的项目看板「不知所云」，现在只留四块——
 * 有哪些队友、当前事务清单（谁在跟进、什么状态）、项目背景、项目文件路径。
 *
 * 显示当前选中的项目；从跳转面板进来还没选时，给一个简单的项目名列表。
 * 派活、验收、看板这些都拿掉了：主人在项目里新开一条会话说诉求，负责人自己安排，
 * 事务清单由负责人维护，这里只读。
 * 本页只做三件事：把 core 组装好的事实摆清楚、把主人的改动拼成命令、把 core 回的中文错误就近显示。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { CommandResult, Lifecycle, ProjectView, ProjectViewRow, Role } from '../../shared/views.js'
import { Skeleton } from '../components/Ui.js'
import { ConfirmDialog } from '../components/confirm-dialog.js'
import { ProjectFormDialog } from '../components/project-dialogs.js'
import { useToastPlacement } from '../components/use-toast-placement.js'
import { buildSaveBackgroundInput, buildSaveProjectInput, type ProjectFormValues } from '../logic/project-form.js'
import {
  PROJECT_BACKGROUND_EMPTY_TEXT, PROJECT_EMPTY_TEXT, PROJECT_MEMBERS_EMPTY_TEXT, PROJECT_TASKS_EMPTY_TEXT,
  backgroundMetaText, botOptions, canManageProject, canOpenTopic, projectMemberRows, projectPathRows, projectPickRows, projectTaskRows,
  type ProjectPathRow, type ProjectStatusAction,
} from '../logic/project-page.js'

/** 成功轻提示停留时长（与办公室/资料页一致 2.2 秒）。 */
const SUCCESS_TOAST_MS = 2200

/** 一行路径：完整显示，旁边一个复制按钮。复制失败时说一句，路径本身可以手动选中。 */
function PathRow(props: { row: ProjectPathRow }): ReactNode {
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle')
  const copy = (): void => {
    void Promise.resolve()
      .then(() => navigator.clipboard.writeText(props.row.value))
      .then(() => setState('done'), () => setState('failed'))
  }
  return (
    <div className="ah-prj-path">
      <span className="ah-prj-path-label">{props.row.label}</span>
      <code className="ah-prj-path-value">{props.row.value}</code>
      <button type="button" className="ah-btn ah-btn-ghost" aria-label={`复制${props.row.label}`} onClick={copy}>
        {state === 'done' ? '已复制' : state === 'failed' ? '没复制上，请手动选中' : '复制'}
      </button>
    </div>
  )
}

/** 选中项目后的四块内容。导出是为了单独测这四块，页面本身只在这个文件里用它。 */
export function ProjectBoard(props: { row: ProjectViewRow; onOpenTopic: (topicId: string) => void }): ReactNode {
  const { row } = props
  const members = projectMemberRows(row)
  const tasks = projectTaskRows(row)
  const backgroundMeta = backgroundMetaText(row.background)
  return (
    <div className="ah-prj-board">
      <section className="ah-prj-block" aria-label="有哪些队友">
        <h3>有哪些队友</h3>
        {members.length === 0 ? <p className="ah-prj-note">{PROJECT_MEMBERS_EMPTY_TEXT}</p> : (
          <ul className="ah-prj-members-list">
            {members.map(member => (
              <li key={member.botId} className={member.invalid ? 'ah-prj-member-gone' : undefined}>
                <span className="ah-prj-member-name">{member.name}</span>
                {member.isOwner ? <span className="ah-tag ah-tag-wait">负责人</span> : null}
                {member.roleLabel !== null ? <span className="ah-prj-note">{member.roleLabel}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="ah-prj-block" aria-label="当前事务清单">
        <h3>当前事务清单</h3>
        {tasks.length === 0 ? <p className="ah-prj-note">{PROJECT_TASKS_EMPTY_TEXT}</p> : (
          <ul className="ah-prj-items">
            {tasks.map(task => {
              const body = <>
                <span className="ah-prj-item-title">{task.title}</span>
                <span className="ah-prj-note">{task.assignee}</span>
                <span className="ah-tag">{task.statusLabel}</span>
              </>
              // 有主题的事务点一下进那条讨论；没有主题的就是一行文字，不做成点了没反应的按钮。
              return (
                <li key={task.id}>
                  {task.topicId !== null
                    ? <button type="button" className="ah-prj-item ah-prj-item-link" onClick={() => props.onOpenTopic(task.topicId!)}>{body}</button>
                    : <div className="ah-prj-item">{body}</div>}
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <section className="ah-prj-block" aria-label="项目背景">
        <h3>项目背景</h3>
        {row.background.text.trim() === ''
          ? <p className="ah-prj-note">{PROJECT_BACKGROUND_EMPTY_TEXT}</p>
          : <p className="ah-prj-background">{row.background.text}</p>}
        {backgroundMeta !== null ? <p className="ah-prj-note">{backgroundMeta}</p> : null}
      </section>

      <section className="ah-prj-block" aria-label="项目文件路径">
        <h3>项目文件路径</h3>
        {projectPathRows(row.path).map(item => <PathRow key={item.label} row={item} />)}
      </section>
    </div>
  )
}

export function ProjectPage(props: {
  project: ProjectView | null
  loading: boolean
  onRetry: () => void
  /** 执行命令（HubPage 注入 hub.command）；失败由弹窗就近显示中文原因。 */
  run: (name: string, input: Record<string, unknown>) => Promise<CommandResult>
  /** 命令成功后刷新项目视图。 */
  onRefresh: () => Promise<unknown> | unknown
  /** 总览队友：提供成员和负责人的候选。 */
  bots: ReadonlyArray<{ id: string; name: string; lifecycle: Lifecycle; role: Role }>
  /** 总览是否已加载：成员候选为空时据此区分「还没加载」与「真的没有可用队友」。 */
  botsLoaded?: boolean
  /** 当前选中的项目；null 时显示项目名列表。 */
  selectedProjectId: string | null
  onSelectProject: (projectId: string) => void
  /** 进一条主题聊天。 */
  onOpenTopic: (topicId: string) => void
  /**
   * 「新开会话」（P60，2026-11-10）：直接进这个项目的一张空聊天（草稿主题），
   * 第一句发出去才真正建成；本页不再弹「先写一句」的输入框。
   */
  onNewTopic: (projectId: string) => void
  /** 左栏「工作区」加号请求打开新建表单。 */
  openNewProject?: boolean
  /** 表单已打开，父层据此把一次性请求归位。 */
  onNewProjectOpened?: () => void
  /** 项目保存成功：把项目 id 交给父层，页面和左栏立刻选中它。 */
  onProjectSaved?: (projectId: string) => void
}): ReactNode {
  /** 编辑弹窗：null=没开；editingId 为 null 表示新建。只记 id，状态动作后才能读到最新的项目。 */
  const [form, setForm] = useState<{ editingId: string | null } | null>(null)
  /** 叠在弹窗上的二次确认：归档，或恢复已归档的项目。 */
  const [confirming, setConfirming] = useState<'archive' | 'restore' | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // WCAG 2.4.11：提示会完全罩住键盘焦点时翻到底部，避免焦点按钮被轻提示遮挡。
  const toastPlacement = useToastPlacement(toast !== null)

  // 卸载时清掉轻提示定时器，避免对已卸载组件 setState。
  useEffect(() => () => { if (toastTimer.current !== null) clearTimeout(toastTimer.current) }, [])

  // 左栏「工作区」加号：打开新建表单，打开后立刻告诉父层请求已消费，同一次请求不会反复弹。
  useEffect(() => {
    if (props.openNewProject !== true) return
    setError(null)
    setNote(null)
    setForm({ editingId: null })
    props.onNewProjectOpened?.()
  }, [props.openNewProject, props.onNewProjectOpened])

  /** 顶部中间成功轻提示：2.2 秒自动消失；连续成功重新计时，只显示最新一条。 */
  const showSuccess = (text: string): void => {
    setToast(text)
    if (toastTimer.current !== null) clearTimeout(toastTimer.current)
    try {
      toastTimer.current = setTimeout(() => {
        toastTimer.current = null
        setToast(null)
      }, SUCCESS_TOAST_MS)
    } catch { /* 定时器不可用时轻提示静默不显示，不影响功能 */ }
  }

  if (props.project === null) {
    return (
      <section className="ah-prj" aria-label="项目">
        {props.loading ? <Skeleton rows={6} /> : (
          <div className="ah-retry">
            项目读取失败。点击「重试」；仍失败请检查 DSH 运行状态。
            <button type="button" className="ah-btn" onClick={props.onRetry}>重试</button>
          </div>
        )}
      </section>
    )
  }

  const view = props.project
  const options = botOptions(props.bots, view)
  const row = view.projects.find(item => item.project.id === props.selectedProjectId) ?? null
  const editing = form === null || form.editingId === null ? null : view.projects.find(item => item.project.id === form.editingId) ?? null
  const closeForm = (): void => { if (!busy) setForm(null) }

  /** 跑一条命令：成功刷新，失败把 core 的中文错误留给弹窗。返回是否成功。 */
  const runCommand = async (name: string, input: Record<string, unknown>): Promise<boolean> => {
    if (busy) return false
    setBusy(true)
    setError(null)
    setNote(null)
    try {
      const result = await props.run(name, input)
      if (!result.ok) { setError(result.error); return false }
      await props.onRefresh()
      return true
    } catch (e) {
      // 宿主层兜底：任何意外都只影响本页，绝不能带崩 DSH。
      setError(e instanceof Error ? e.message : String(e))
      return false
    } finally {
      setBusy(false)
    }
  }

  /** 保存项目：先存项目，新建时拿到 id 再存背景；背景失败时项目已经存上了，转成编辑态，重试不会多建一个。 */
  const submitProject = async (values: ProjectFormValues): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    setNote(null)
    try {
      const saved = await props.run('saveProject', buildSaveProjectInput(values, editing))
      if (!saved.ok) { setError(saved.error); return }
      const created = saved.data as { id?: unknown } | undefined
      const projectId = editing?.project.id ?? (typeof created?.id === 'string' ? created.id : null)
      const backgroundInput = projectId === null ? null : buildSaveBackgroundInput(projectId, values, editing)
      if (backgroundInput !== null) {
        const context = await props.run('saveProjectContext', backgroundInput)
        if (!context.ok) {
          await props.onRefresh()
          setForm({ editingId: projectId })
          setError(`项目已保存，背景没有存上：${context.error}`)
          return
        }
      }
      setForm(null)
      await props.onRefresh()
      if (projectId !== null) props.onProjectSaved?.(projectId)
      showSuccess('项目已保存。')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  /** 暂停、恢复、完成：弹窗不关，表单里没保存的改动不丢。 */
  const runStatusAction = async (action: ProjectStatusAction): Promise<void> => {
    if (editing === null) return
    if (await runCommand(action.command, { id: editing.project.id })) setNote(action.okText)
  }

  const confirmArchive = async (target: ProjectViewRow): Promise<void> => {
    if (await runCommand('archiveProject', { id: target.project.id })) {
      setConfirming(null)
      setForm(null)
      showSuccess('已归档。历史记录保留，可恢复。')
    }
  }

  const confirmRestore = async (target: ProjectViewRow): Promise<void> => {
    if (await runCommand('restoreProject', { id: target.project.id })) {
      setConfirming(null)
      showSuccess('已恢复。下一步：待安排。')
    }
  }

  const confirmTarget = editing ?? row
  const archived = row !== null && !canManageProject(row.project.status)

  return (
    <section className="ah-prj" aria-label="项目">
      {row === null ? (
        <>
          <header className="ah-prj-head">
            <div className="ah-prj-head-main"><h2>项目</h2></div>
            <button type="button" className="ah-btn ah-btn-primary" onClick={() => { setError(null); setNote(null); setForm({ editingId: null }) }}>＋ 新项目</button>
          </header>
          {view.projects.length === 0 ? <div className="ah-empty ah-prj-empty">{PROJECT_EMPTY_TEXT}</div> : (
            <ul className="ah-prj-pick">
              {projectPickRows(view).map(item => (
                <li key={item.id}>
                  <button type="button" className="ah-prj-item ah-prj-item-link" onClick={() => props.onSelectProject(item.id)}>
                    <span className="ah-prj-item-title">{item.name}</span>
                    <span className="ah-tag">{item.statusLabel}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <>
          <header className="ah-prj-head">
            <div className="ah-prj-head-main">
              <h2>{row.project.name}</h2>
              <span className="ah-tag">{row.statusLabel}</span>
            </div>
            <div className="ah-prj-head-actions">
              {/* 只有进行中的项目给这个按钮（暂停、完成、归档照旧不给）；点了直接进空聊天，第一句发出才建成。 */}
              {canOpenTopic(row.project.status) ? (
                <button type="button" className="ah-btn ah-btn-primary" onClick={() => props.onNewTopic(row.project.id)}>新开会话</button>
              ) : null}
              {archived
                ? <button type="button" className="ah-btn" onClick={() => { setError(null); setConfirming('restore') }}>恢复项目</button>
                : <button type="button" className="ah-btn" onClick={() => { setError(null); setNote(null); setForm({ editingId: row.project.id }) }}>编辑</button>}
            </div>
          </header>
          <ProjectBoard row={row} onOpenTopic={props.onOpenTopic} />
        </>
      )}

      {/* 成功轻提示：live 区域空态也常驻，消息到来时只更新同一节点内的文本，读屏才稳定播报（WCAG 4.1.3）。 */}
      <div ref={toastPlacement.layerRef}
        className={`ah-toast-layer${toastPlacement.below ? ' ah-toast-layer-below' : ''}`}
        aria-live="polite" aria-atomic="false">
        {toast !== null ? <div className="ah-toast">{toast}</div> : null}
      </div>

      {form !== null ? (
        <ProjectFormDialog key={form.editingId ?? 'new'} editing={editing} options={options} botsLoaded={props.botsLoaded}
          busy={busy} error={confirming === null ? error : null} note={note} onClose={closeForm}
          onSubmit={values => void submitProject(values)}
          onStatusAction={action => void runStatusAction(action)}
          onArchive={() => { setError(null); setConfirming('archive') }} />
      ) : null}
      {/* 二次确认叠在编辑弹窗上面，取消后回到还没保存的表单。 */}
      {confirming === 'archive' && confirmTarget !== null ? (
        <ConfirmDialog title={`归档项目：${confirmTarget.project.name}`} busy={busy} error={error}
          onCancel={() => { if (!busy) setConfirming(null) }} onConfirm={() => void confirmArchive(confirmTarget)}
          confirmText="归档项目"
          text={`归档后，「${confirmTarget.project.name}」只读，里面的会话不能再发言。项目和记录都还在，可以恢复。`} />
      ) : null}
      {confirming === 'restore' && confirmTarget !== null ? (
        <ConfirmDialog title={`恢复项目：${confirmTarget.project.name}`} busy={busy} error={error} tone="primary"
          onCancel={() => { if (!busy) setConfirming(null) }} onConfirm={() => void confirmRestore(confirmTarget)}
          confirmText="恢复项目"
          text={`恢复后「${confirmTarget.project.name}」回到进行中，可以继续编辑和开会话；原有记录都还在。`} />
      ) : null}
    </section>
  )
}

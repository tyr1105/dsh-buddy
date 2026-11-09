/**
 * 项目页（V2-PH4-02）：消费 core 的 ProjectView，把「立目标 → 派任务 → 执行者交账 →
 * 主人验收」整条线摆成一页。
 *
 * 为什么这样组织：和办公室页/资料页同一纪律——本页只做三件事：把 core 组装好的项目
 * 事实摆清楚、把主人的改动拼成 core zod 规定的命令入参、把 core 回的中文错误就近
 * 显示。任务能不能流转、驳回理由合不合法、负责人是不是成员、项目状态能不能改，最终
 * 都由 core 判定；前端只拦「空、超长、负责人没勾进成员」这类不用查数据就能发现的错。
 *
 * 产品核心：执行者交账只到「待验收」，任务行上必须有显眼的「验收通过 / 驳回」；
 * 驳回必填理由且失败不丢输入；已通过是终态，不给任何动作按钮；归档项目只读陈列，
 * 唯一入口是「恢复项目」（F08 尾巴补的 restoreProject，二次确认后回到进行中）。
 *
 * F12 / V2-PH4-04 派活：待办「派活」、受阻「恢复并派活」、被驳回「重新派活」、
 * 进行中任务可「催办」（指派队友固定）或「改派」（另选项目成员队友），全部先开对话框、
 * 可附留言，统一走 core dispatchTask；暂停/完成/归档项目不显示派活类入口。
 */
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import type {
  ArtifactListView, CommandResult, Lifecycle, ProjectTaskView, ProjectView, ProjectViewRow,
} from '../../shared/views.js'
import {
  PROJECT_ZONES, DISPATCH_MODE_COPY, canManageProject, canRestoreProject,
  botCatalogue, issueLevelLabel, memberBrief, ownerBrief, progressPercent, projectEmptyText,
  projectSections, projectSummaryParts,
  taskAssigneeOptions, taskGroups, workspaceDirDisplay,
  type BotCatalogue, type DispatchMode, type ProjectZone, type TaskTransitionAction,
} from '../logic/project-page.js'
import { Skeleton } from '../components/Ui.js'
import { WorkBoardView } from '../components/work-board.js'
import { buildWorkBoard, type WorkBoardCard, type WorkBoardCommand } from '../logic/work-board.js'
import { boardCardActions, projectBoardItems, type WorkBoardActionKind } from '../logic/work-board-source.js'
import { ProjectFormDialog, RejectTaskDialog, TaskFormDialog } from '../components/project-dialogs.js'
import { ProjectContextDialog, ProjectContextPanel } from '../components/project-context-panel.js'
import { AttachArtifactDialog } from '../components/attach-artifact-dialog.js'
import { DispatchTaskDialog } from '../components/dispatch-task-dialog.js'
import { useToastPlacement } from '../components/use-toast-placement.js'
import { ConfirmDialog } from '../components/confirm-dialog.js'
// 状态标签与任务行展示件在同目录 project-task-row.tsx（V2-PH4-04 拆出；F08 尾巴补产物区）。
import { StatusTag, TaskRow } from './project-task-row.js'

/** 成功轻提示停留时长（与办公室/资料页一致 2.2 秒）。 */
const SUCCESS_TOAST_MS = 2200

/**
 * 当前打开的弹窗：可辨识联合保证每种弹窗拿到自己需要的上下文。
 * export 给同目录 project-task-row.tsx 的任务行点击回传动作用（仅类型引用，编译后擦除）。
 */
export type DialogState =
  | { kind: 'projectForm'; editing: ProjectViewRow | null }
  | { kind: 'taskForm'; row: ProjectViewRow; editing: ProjectTaskView | null }
  | { kind: 'dispatch'; row: ProjectViewRow; task: ProjectTaskView; mode: DispatchMode }
  | { kind: 'attachArtifact'; row: ProjectViewRow; task: ProjectTaskView }
  | { kind: 'reject'; task: ProjectTaskView }
  | { kind: 'archiveProject'; row: ProjectViewRow }
  | { kind: 'restoreProject'; row: ProjectViewRow }
  // P39：共享上下文编辑（四段正文、决策与术语表）。
  | { kind: 'projectContext'; row: ProjectViewRow }

/** 项目级状态流转（暂停/恢复/完成）：合法性（边）由 core 判，页面只按状态给按钮。 */
type ProjectStatusAction = 'pause' | 'resume' | 'complete'

/** 一张项目卡：目标/负责人/成员/验收项/问题/任务分组与行内操作；归档卡只读。 */
function ProjectCard(props: {
  row: ProjectViewRow
  catalogue: BotCatalogue
  archived: boolean
  busy: boolean
  /** 左栏刚刚点过这个项目：短暂高亮，主人能确认落点（P44-R2）。 */
  focused?: boolean
  onAction: (dialog: DialogState) => void
  onCommand: (action: TaskTransitionAction, task: ProjectTaskView) => void
  onStatusAction: (kind: ProjectStatusAction, row: ProjectViewRow) => void
  onOpenWake: (botId: string, wakeId: string) => void
  /** P39：采纳/驳回队友的上下文建议（与页面其他操作共用统一提交）。 */
  onContextApprove: (proposalId: string) => void
  onContextReject: (proposalId: string) => void
}): ReactNode {
  const { row, archived } = props
  const p = row.project
  const owner = ownerBrief(row)
  const groups = taskGroups(row.tasks)
  const manageable = canManageProject(p.status)
  // U05：正文只给目录名，完整路径收进悬停提示；空路径显示「未设置」。
  const workspaceDir = workspaceDirDisplay(row.layers.original.workspaceDir)
  return (
    <article className={`ah-prj-card${archived ? ' ah-prj-card-archived' : ''}${props.focused ? ' ah-prj-card-focus' : ''}`}
      data-project-id={p.id}>
      <header className="ah-prj-card-head">
        <div className="ah-prj-card-head-main">
          <h4>{p.name} <StatusTag label={row.statusLabel} archived={archived} /></h4>
          <p className="ah-prj-meta">
            <span>进度：已通过 {row.taskCounts.accepted}/{row.taskCounts.total}（{progressPercent(row)}%）· 待验收 {row.taskCounts.done_pending_check}</span>
            <span className={owner.invalid ? 'ah-org-issue-text' : ''}
              title={owner.invalid && owner.botId !== null ? `内部 id：${owner.botId}` : undefined}>
              负责人：{owner.text}
            </span>
          </p>
          {p.charter ? <p className="ah-prj-charter">目标：{p.charter}</p> : null}
          {/* P34 两层（DC15）：同一工作区只读地分成「原始版本」与「队友项目版本」两块。 */}
          <div className="ah-prj-layers" aria-label="项目两层">
            <div className="ah-prj-layer">
              <div className="ah-prj-layer-head">
                <span className="ah-prj-layer-name">原始版本</span>
                <span className="ah-tag">只读</span>
              </div>
              <p className="ah-prj-meta">DSH 原生会话与设置保持原样，插件不改动。</p>
              <p className="ah-prj-meta ah-prj-dir" title={workspaceDir.title}>
                工作区：{workspaceDir.label}
              </p>
            </div>
            <div className="ah-prj-layer">
              <div className="ah-prj-layer-head">
                <span className="ah-prj-layer-name">队友项目版本</span>
                <span className="ah-prj-meta">成员 {row.layers.team.memberCount} · 验收 {row.layers.team.criterionCount} 条</span>
              </div>
              {row.layers.team.vision
                ? <p className="ah-prj-layer-text">愿景：{row.layers.team.vision}</p>
                : <p className="ah-prj-meta">愿景：暂未填写。点击「编辑」添加。</p>}
              {row.layers.team.conventions
                ? <p className="ah-prj-layer-text">约定：{row.layers.team.conventions}</p>
                : <p className="ah-prj-meta">约定：暂未填写。点击「编辑」添加。</p>}
            </div>
          </div>
          {/* P39：共享上下文是队友干活的共同前提，摆在项目两层之后、成员之前。 */}
          <ProjectContextPanel row={row} canEdit={manageable} busy={props.busy}
            onEdit={() => props.onAction({ kind: 'projectContext', row })}
            onApprove={props.onContextApprove} onReject={props.onContextReject} />
        </div>
        {manageable ? (
          <div className="ah-prj-ops">
            <button type="button" className="ah-btn ah-btn-ghost" disabled={props.busy}
              onClick={() => props.onAction({ kind: 'projectForm', editing: row })}>编辑</button>
            {p.status === 'active' ? (
              <button type="button" className="ah-btn ah-btn-ghost" disabled={props.busy}
                title="暂停期间不派新任务，成员变更保留"
                onClick={() => props.onStatusAction('pause', row)}>暂停</button>
            ) : null}
            {p.status === 'paused' ? (
              <button type="button" className="ah-btn ah-btn-ghost" disabled={props.busy}
                onClick={() => props.onStatusAction('resume', row)}>恢复</button>
            ) : null}
            {p.status === 'active' || p.status === 'paused' ? (
              <button type="button" className="ah-btn ah-btn-ghost" disabled={props.busy}
                title="标记完成；仍有待办/待验收任务时项目问题区会提醒"
                onClick={() => props.onStatusAction('complete', row)}>完成</button>
            ) : null}
            <button type="button" className="ah-btn ah-btn-danger" disabled={props.busy}
              onClick={() => props.onAction({ kind: 'archiveProject', row })} title="归档后只读陈列，数据保留">归档</button>
          </div>
        ) : (
          <div className="ah-prj-ops">
            <span className="ah-prj-meta">已归档 · 只读</span>
            {canRestoreProject(p.status) ? (
              <button type="button" className="ah-btn ah-btn-ghost" disabled={props.busy}
                title="恢复后回到进行中，原有任务与验收记录原样保留"
                onClick={() => props.onAction({ kind: 'restoreProject', row })}>恢复项目</button>
            ) : null}
          </div>
        )}
      </header>

      {/* 项目级问题置顶于卡内：错误在前、提醒在后，失效队友/交账未完成都在这里点名。 */}
      {row.issues.length > 0 ? (
        <ul className="ah-prj-issues">
          {row.issues.map((issue, i) => (
            <li key={`${issue.code}-${i}`} className={`ah-prj-issue ah-prj-issue-${issue.level}`}
              title={issue.subjectBotId ? `内部 id：${issue.subjectBotId}` : undefined}>
              <span className="ah-prj-issue-level">{issueLevelLabel(issue.level)}</span>
              {issue.text}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="ah-prj-members" aria-label="项目成员">
        <span className="ah-prj-block-label">成员（{row.members.length}）</span>
        {row.members.length === 0 ? <span className="ah-prj-meta">暂无成员。点击「编辑」添加。</span> : row.members.map(m => {
          const brief = memberBrief(m)
          return (
            <span key={m.botId} className={`ah-tag ah-prj-member${brief.invalid ? ' ah-prj-member-gone' : ''}`}
              title={brief.invalid && brief.botId !== null ? `内部 id：${brief.botId}` : undefined}>
              {brief.text}
            </span>
          )
        })}
      </div>

      {row.criteria.length > 0 ? (
        <ul className="ah-prj-criteria" aria-label="验收项">
          {row.criteria.map(c => (
            <li key={c.id} className={c.status === 'met' ? 'ah-prj-criterion-met' : ''}>
              <span className="ah-tag">{c.statusLabel}</span>
              <span>{c.text}</span>
              {c.verify ? <span className="ah-prj-meta">怎么验：{c.verify}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="ah-prj-tasks">
        <div className="ah-prj-tasks-head">
          <span className="ah-prj-block-label">任务（{row.taskCounts.total}）</span>
          {manageable ? (
            <button type="button" className="ah-btn ah-btn-ghost" disabled={props.busy}
              onClick={() => props.onAction({ kind: 'taskForm', row, editing: null })}>＋ 新任务</button>
          ) : null}
        </div>
        {groups.length === 0 ? <p className="ah-prj-meta">暂无任务。点击「＋ 新任务」添加。</p> : groups.map(group => (
          <div key={group.status} className="ah-prj-task-group">
            <h5>{group.label}（{group.tasks.length}）</h5>
            <ul>
              {group.tasks.map(task => (
                <TaskRow key={task.task.id} row={row} task={task} catalogue={props.catalogue}
                  busy={props.busy} onAction={props.onAction} onCommand={props.onCommand}
                  onOpenWake={props.onOpenWake} />
              ))}
            </ul>
          </div>
        ))}
      </div>
    </article>
  )
}

/** 项目页：加载给骨架；数据到齐后按「计数/新建 → 进行中/暂停/完成 → 归档折叠区」铺陈。 */
export function ProjectPage(props: {
  project: ProjectView | null
  loading: boolean
  onRetry: () => void
  /** 执行命令（HubPage 注入 hub.command）；失败由弹窗就近显示中文原因。 */
  run: (name: string, input: Record<string, unknown>) => Promise<CommandResult>
  /** 命令成功后刷新项目视图（HubPage 注入 refreshProject）。 */
  onRefresh: () => Promise<unknown> | unknown
  /** 总览队友（含生命周期）：提供成员/负责人/指派选项，派活只列在岗/试岗。 */
  bots: ReadonlyArray<{ id: string; name: string; lifecycle: Lifecycle }>
  /** 按需读某个队友的产物索引（HubPage 注入 hub.botArtifacts；不参与整页刷新）。 */
  loadBotArtifacts: (botId: string) => Promise<ArtifactListView | null>
  /** 点任务行「关联唤醒」：切到该队友并展开右栏这次唤醒的账本（HubPage 注入）。 */
  onOpenWake: (botId: string, wakeId: string) => void
  /** 总览是否已加载：成员候选为空时据此区分「还没加载」与「真的没有可用队友」。 */
  botsLoaded?: boolean
  /** 左栏点项目行要定位的项目 id（P44-R2）：滚动到卡片并临时高亮。 */
  focusProjectId?: string | null
  /** 定位信号序号：同一个项目连续点击也要重新滚动一次。 */
  focusSeq?: number
  /** 左栏「工作区」加号请求打开新建表单（P44-R2）：与页内「＋ 新项目」同一个对话框。 */
  openNewProject?: boolean
  /** 表单已打开，父层据此把一次性请求归位。 */
  onNewProjectOpened?: () => void
  /** 项目保存成功：把新项目 id 交给父层，让左栏立刻选中它。 */
  onProjectSaved?: (projectId: string) => void
}): ReactNode {
  const [dialog, setDialog] = useState<DialogState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  /** 项目页的两种看法：列表（默认，按项目铺陈）与四列看板（同一份任务记录）。 */
  const [mode, setMode] = useState<'list' | 'board'>('list')
  /** 看板的解释型提示（例如任务在最新视图里被删掉时）。 */
  const [boardNotice, setBoardNotice] = useState<string | null>(null)
  /** 左栏定位后短暂高亮的项目 id（P44-R2）：强调完就撤，不改变卡片常态。 */
  const [focusedProjectId, setFocusedProjectId] = useState<string | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 项目卡片的滚动容器：按 data-project-id 找到目标卡片再滚过去。 */
  const sectionRef = useRef<HTMLElement | null>(null)
  const focusHighlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // WCAG 2.4.11：提示会完全罩住键盘焦点时翻到底部，避免焦点按钮被轻提示遮挡。
  const toastPlacement = useToastPlacement(toast !== null)
  /**
   * 归档折叠区（U01 第 41 轮）：顶栏「归档 N」是跳转锚点，点击后展开该区并滚动定位。
   * 看板模式下归档区不挂载，要先切回列表再等一帧，所以保存 details 的引用做重试。
   */
  const archivedRef = useRef<HTMLDetailsElement | null>(null)

  // 卸载时清掉轻提示定时器，避免对已卸载组件 setState（回调异常也不带崩宿主）。
  useEffect(() => () => {
    if (toastTimer.current !== null) clearTimeout(toastTimer.current)
    if (focusHighlightTimer.current !== null) clearTimeout(focusHighlightTimer.current)
  }, [])

  // 左栏「工作区」加号（P44-R2）：打开与页内「＋ 新项目」完全相同的表单，
  // 打开后立刻告诉父层请求已消费，同一次请求不会把表单反复弹出来。
  useEffect(() => {
    if (props.openNewProject !== true) return
    setError(null)
    setDialog({ kind: 'projectForm', editing: null })
    props.onNewProjectOpened?.()
  }, [props.openNewProject, props.onNewProjectOpened])

  /**
   * 左栏点项目行（P44-R2）：滚到目标项目卡并短暂高亮，证明进的是被点的那一个。
   * 卡片可能还没渲染出来（项目视图刚刷新），最多等 10 帧；失败静默收手，
   * 不影响页面其他功能。
   */
  useEffect(() => {
    const target = props.focusProjectId ?? null
    if (target === null || props.project === null) return
    let frames = 0
    const scrollToTarget = (): void => {
      const container = sectionRef.current
      // 目标是归档项目时先把归档区展开，否则卡片在折叠区里滚不过去。
      const isArchived = props.project?.projects.some(row => row.project.id === target && row.project.status === 'archived') === true
      if (isArchived && archivedRef.current !== null) archivedRef.current.open = true
      const card = container?.querySelector<HTMLElement>(`[data-project-id="${target}"]`) ?? null
      if (card === null) {
        frames += 1
        if (frames < 10 && typeof requestAnimationFrame === 'function') requestAnimationFrame(scrollToTarget)
        return
      }
      try {
        setMode('list')
        card.scrollIntoView({ block: 'center' })
        setFocusedProjectId(target)
        if (focusHighlightTimer.current !== null) clearTimeout(focusHighlightTimer.current)
        focusHighlightTimer.current = setTimeout(() => {
          focusHighlightTimer.current = null
          setFocusedProjectId(null)
        }, 1800)
      } catch { /* 定位失败只影响这一跳 */ }
    }
    scrollToTarget()
  }, [props.focusSeq, props.focusProjectId, props.project])

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

  /** 统一提交：成功关窗、刷新、轻提示；失败把 core 的中文错误留在弹窗里，输入不丢。 */
  const submit = async (name: string, input: Record<string, unknown>, successText: string): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await props.run(name, input)
      if (result.ok) {
        setDialog(null)
        await props.onRefresh()
        showSuccess(successText)
      } else {
        setError(result.error)
      }
    } catch (e) {
      // 宿主层兜底：任何意外都只影响本页，绝不能带崩 DSH（红线 5 的界面侧呼应）。
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  /**
   * 项目表单提交（P44-R2）：与统一 submit 同一套成功/失败处理，额外把 core 回的
   * 新项目 id 交给父层——保存成功后左栏工作区立刻新增该行并处于选中态。
   */
  const submitProject = async (input: Record<string, unknown>): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await props.run('saveProject', input)
      if (result.ok) {
        const saved = result.data as { id?: unknown } | undefined
        const projectId = typeof saved?.id === 'string' ? saved.id : null
        setDialog(null)
        await props.onRefresh()
        if (projectId !== null) props.onProjectSaved?.(projectId)
        showSuccess('项目已保存。')
      } else {
        setError(result.error)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
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
  const sections = projectSections(view)
  const catalogue = botCatalogue(props.bots, view)
  const emptyText = projectEmptyText(view)
  const close = (): void => { if (!busy) setDialog(null) }

  /**
   * 顶栏「归档 N」锚点（U01 第 41 轮）：看板模式下归档区不挂载，先切回列表，
   * 再等折叠区挂载后展开、滚动定位并把焦点交给折叠标题——键盘与读屏用户也落在目的地。
   * 任何一步失败都静默收手，不报错也不滚到错误位置；回调整体 try/catch 不带崩宿主。
   */
  const jumpToArchived = (): void => {
    try {
      if (mode !== 'list') setMode('list')
      let frames = 0
      const openAndScroll = (): void => {
        const el = archivedRef.current
        if (el === null) {
          // 看板切列表后归档区晚几帧才挂载；最多等 10 帧，仍没有就放弃（不假装成功）。
          frames += 1
          if (frames < 10 && typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(openAndScroll)
          }
          return
        }
        try {
          el.open = true
          // 即时滚动（不用 smooth）：减少动效偏好下也安全，与 InboxPane 的定位口径一致；
          // 顶部预留由 CSS scroll-margin-top 负责，不被吸顶栏遮住。
          el.scrollIntoView({ block: 'start' })
          const summaryEl = el.querySelector('summary')
          if (summaryEl instanceof HTMLElement) summaryEl.focus()
        } catch { /* 定位失败只影响这一跳，不阻断页面 */ }
      }
      openAndScroll()
    } catch { /* 锚点任何意外都不带崩页面 */ }
  }

  /** 任务行即时动作（卡住/交账/验收通过）；驳回与五种派活都先开弹框，不走这里。 */
  const runTaskAction = (action: TaskTransitionAction, task: ProjectTaskView): void => {
    const owner = task.assigneeBotName ?? '待安排'
    const text = action.kind === 'block' ? `已标记受阻。下一步：解除受阻，负责人 ${owner}。`
      : action.kind === 'reportDone' ? '已提交。下一步：验收，负责人 待安排。'
        : '已完成。下一步：待安排。'
    void submit(action.command, { id: task.task.id }, text)
  }

  /** P39：采纳/驳回队友的上下文建议；采纳后 core 会写正文文件并追加留痕。 */
  const approveContext = (proposalId: string): void => {
    void submit('approveProjectContextProposal', { id: proposalId }, '已采纳队友建议。')
  }
  const rejectContext = (proposalId: string): void => {
    void submit('rejectProjectContextProposal', { id: proposalId }, '已驳回上下文建议。')
  }

  /** 项目状态流转（暂停/恢复/完成）即时执行；归档走二次确认弹框，不在这里直接发。 */
  const runStatusAction = (kind: ProjectStatusAction, row: ProjectViewRow): void => {
    const command = kind === 'pause' ? 'pauseProject' : kind === 'resume' ? 'resumeProject' : 'completeProject'
    const text = kind === 'pause' ? '已暂停。下一步：恢复，负责人 待安排。'
      : kind === 'resume' ? '已恢复。下一步：待安排。'
        : '已完成。下一步：归档，负责人 待安排。'
    void submit(command, { id: row.project.id }, text)
  }

  /**
   * 看板：与列表同一份任务记录，只换一种看法。卡片动作由纯函数按「任务状态 ×
   * 项目状态」给出；真正流转仍走 core 命令，看板不在本地改状态。
   */
  const board = buildWorkBoard(projectBoardItems(view))
  const rowsById = new Map(view.projects.map(row => [row.project.id, row]))
  const taskById = new Map<string, { row: ProjectViewRow; task: ProjectTaskView }>()
  for (const row of view.projects) for (const task of row.tasks) taskById.set(task.task.id, { row, task })
  const actionsOf = (card: WorkBoardCard): WorkBoardActionKind[] =>
    boardCardActions(card.status, rowsById.get(card.projectId)?.project.status ?? 'archived', 'project')

  /** 看板动作：领取/改派先开对话框选队友，交账/验收直接发命令，驳回先收理由。 */
  const runBoardAction = (kind: WorkBoardActionKind, card: WorkBoardCard): void => {
    const found = taskById.get(card.id)
    if (!found) {
      setBoardNotice(`任务「${card.title}」已不在最新视图。刷新页面后重试；仍失败请检查 DSH 运行状态。`)
      return
    }
    setBoardNotice(null)
    if (kind === 'claim' || kind === 'reassign') {
      setDialog({ kind: 'dispatch', row: found.row, task: found.task, mode: kind === 'claim' ? 'assign' : 'reassign' })
    } else if (kind === 'reject') {
      setDialog({ kind: 'reject', task: found.task })
    } else if (kind === 'accept') {
      void submit('acceptTask', { id: card.id }, '已完成。下一步：待安排。')
    } else {
      void submit('reportDone', { id: card.id }, '已提交。下一步：验收，负责人 待安排。')
    }
  }

  /** 拖拽落列：能到这里的都是 workBoardMove 判过的合法方向，复用同一套按钮动作。
   *  「在做拖回待领」已在纯逻辑层判非法，由看板自己弹原因，不会进到这里。 */
  const runBoardMove = (card: WorkBoardCard, command: WorkBoardCommand): void => {
    runBoardAction(command, card)
  }

  return (
    <section className="ah-prj" aria-label="项目" ref={sectionRef}>
      <header className="ah-prj-head">
        <div className="ah-prj-head-main">
          <h2>项目</h2>
          {/* U01 第 41 轮：计数拆段渲染，「归档 N」在有归档项目时是跳转锚点
              （展开归档区并滚动定位）；纯文本与 projectSummary() 共用同一组分段。 */}
          <span className="ah-prj-summary">
            {projectSummaryParts(view).map((part, i) => {
              const separator = i === 0 ? null : part.key === 'tasks' ? '｜' : '·'
              if (part.key === 'archived' && part.count > 0) {
                return (
                  <Fragment key={part.key}>
                    {separator}
                    <button type="button" className="ah-prj-summary-link" onClick={jumpToArchived}
                      aria-label={`展开并定位到归档区，共 ${part.count} 个归档项目`}
                      title="展开归档区并滚动定位">{part.text}</button>
                  </Fragment>
                )
              }
              return <Fragment key={part.key}>{separator}{part.text}</Fragment>
            })}
          </span>
        </div>
        <div className="ah-settings-actions">
          {/* P35：列表与看板是同一份任务记录的两种看法；切换只改呈现，不触发数据写入。 */}
          <div className="ah-seg" role="group" aria-label="项目看法">
            <button type="button" className={`ah-seg-btn${mode === 'list' ? ' ah-seg-on' : ''}`}
              aria-pressed={mode === 'list'} onClick={() => { setMode('list'); setBoardNotice(null) }}>列表</button>
            <button type="button" className={`ah-seg-btn${mode === 'board' ? ' ah-seg-on' : ''}`}
              aria-pressed={mode === 'board'} onClick={() => { setMode('board'); setBoardNotice(null) }}>看板</button>
          </div>
          <button type="button" className="ah-btn ah-btn-primary"
            onClick={() => setDialog({ kind: 'projectForm', editing: null })}>＋ 新项目</button>
        </div>
      </header>

      {emptyText !== null ? (
        <div className="ah-empty ah-prj-empty">{emptyText}</div>
      ) : null}

      {mode === 'board' ? (
        // P35 看板：项目与列表同一份记录；归档项目不进看板（它们只在列表的归档区只读陈列）。
        <WorkBoardView board={board} actionsOf={actionsOf} onAction={runBoardAction}
          onMove={runBoardMove} notice={boardNotice} busy={busy} />
      ) : (
        <>
          {PROJECT_ZONES.map(({ zone, title }: { zone: ProjectZone; title: string }) => {
            if (zone === 'archived') return null // 归档区单独折叠渲染
            const rows = sections[zone]
            if (rows.length === 0) return null
            return (
              <section key={zone} className="ah-prj-zone" aria-label={title}>
                <h3>{title}（{rows.length}）</h3>
                <div className="ah-prj-list">
                  {rows.map(row => (
                    <ProjectCard key={row.project.id} row={row} catalogue={catalogue} archived={false}
                      busy={busy} focused={focusedProjectId === row.project.id}
                      onAction={setDialog} onCommand={runTaskAction} onStatusAction={runStatusAction}
                      onOpenWake={props.onOpenWake} onContextApprove={approveContext} onContextReject={rejectContext} />
                  ))}
                </div>
              </section>
            )
          })}

          {/* 归档区默认折叠：归档项目只读陈列，只留「恢复项目」一个写入口。
              id/ref 供顶栏「归档 N」锚点展开与滚动定位（U01 第 41 轮）。 */}
          {sections.archived.length > 0 ? (
            <details className="ah-prj-archived" id="ah-prj-archived" ref={archivedRef}>
              <summary>归档（{sections.archived.length}）</summary>
              <div className="ah-prj-list">
                {sections.archived.map(row => (
                  <ProjectCard key={row.project.id} row={row} catalogue={catalogue} archived
                    busy={busy} focused={focusedProjectId === row.project.id}
                    onAction={setDialog} onCommand={runTaskAction} onStatusAction={runStatusAction}
                    onOpenWake={props.onOpenWake} onContextApprove={approveContext} onContextReject={rejectContext} />
                ))}
              </div>
            </details>
          ) : null}
        </>
      )}

      {/* 成功轻提示：沿用全局 toast 视觉语言（顶部中间、不拦截点击），状态只属于本页。
          WCAG 4.1.3：live 区域空态也常驻，消息到来时只更新同一节点内的文本，读屏才稳定播报；
          aria-atomic=false 保证只念新提示。 */}
      <div ref={toastPlacement.layerRef}
        className={`ah-toast-layer${toastPlacement.below ? ' ah-toast-layer-below' : ''}`}
        aria-live="polite" aria-atomic="false">
        {toast !== null ? <div className="ah-toast">{toast}</div> : null}
      </div>

      {/* 弹窗层：按当前 dialog 种类渲染，busy/error 全页共用一份。 */}
      {dialog?.kind === 'projectForm' ? (
        <ProjectFormDialog editing={dialog.editing} options={catalogue.options} botsLoaded={props.botsLoaded}
          busy={busy} error={error}
          onClose={close}
          onSubmit={raw => void submitProject(raw)} />
      ) : null}
      {dialog?.kind === 'taskForm' ? (
        <TaskFormDialog row={dialog.row} editing={dialog.editing}
          assigneeOptions={taskAssigneeOptions(dialog.row, catalogue)} busy={busy} error={error} onClose={close}
          onSubmit={raw => void submit('saveTask', raw, dialog.editing ? '任务修改已保存。' : '任务已新建。')} />
      ) : null}
      {dialog?.kind === 'dispatch' ? (
        <DispatchTaskDialog projectId={dialog.row.project.id} task={dialog.task} mode={dialog.mode}
          options={taskAssigneeOptions(dialog.row, catalogue)}
          busy={busy} error={error} onClose={close}
          onSubmit={raw => {
            const botId = typeof raw.assigneeBotId === 'string' ? raw.assigneeBotId : ''
            const owner = catalogue.options.find(o => o.botId === botId)?.name ?? '待安排'
            void submit('dispatchTask', raw, `${DISPATCH_MODE_COPY[dialog.mode].success}。下一步：执行，负责人 ${owner}。`)
          }} />
      ) : null}
      {dialog?.kind === 'attachArtifact' ? (
        <AttachArtifactDialog task={dialog.task} bots={props.bots} loadArtifacts={props.loadBotArtifacts}
          busy={busy} error={error} onClose={close}
          onSubmit={raw => void submit('attachTaskArtifact', raw, '已关联产物。')} />
      ) : null}
      {dialog?.kind === 'reject' ? (
        <RejectTaskDialog task={dialog.task} busy={busy} error={error} onClose={close}
          onSubmit={raw => void submit('rejectTask', raw, '已驳回。下一步：返工，负责人 待安排。')} />
      ) : null}
      {dialog?.kind === 'archiveProject' ? (
        <ConfirmDialog title={`归档项目：${dialog.row.project.name}`} busy={busy} error={error}
          onCancel={close} onConfirm={() => void submit('archiveProject', { id: dialog.row.project.id }, '已归档。历史记录保留，可恢复。')}
          confirmText="归档项目"
          text={`归档后，「${dialog.row.project.name}」会进下面的归档区，只读。成员不能再往里汇报结果。项目、任务和验收记录都还在。`} />
      ) : null}
      {dialog?.kind === 'projectContext' ? (
        <ProjectContextDialog row={dialog.row} busy={busy} error={error} onClose={close}
          onSubmit={raw => void submit('saveProjectContext', raw, '共享上下文已保存。')} />
      ) : null}
      {dialog?.kind === 'restoreProject' ? (
        <ConfirmDialog title={`恢复项目：${dialog.row.project.name}`} busy={busy} error={error} tone="primary"
          onCancel={close} onConfirm={() => void submit('restoreProject', { id: dialog.row.project.id }, '已恢复。下一步：待安排。')}
          confirmText="恢复项目"
          text={`恢复后「${dialog.row.project.name}」回到进行中，可继续编辑项目、派发与验收任务；原有任务与验收记录保留。`} />
      ) : null}
    </section>
  )
}

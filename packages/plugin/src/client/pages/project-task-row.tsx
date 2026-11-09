/**
 * 项目任务行展示件（V2-PH4-04 从 ProjectPage.tsx 纯搬移拆出）：
 * - StatusTag：项目卡头的项目状态小标签（颜色从不单独表达含义，旁边必有文字）；
 * - WakeLinks：任务行「关联唤醒」链接列，每个唤醒一枚小链接，点开跳右栏账本；
 * - TaskRow：一条任务行——标题/状态标签/指派人/关联产物与唤醒/状态流转按钮，
 *   待验收行整行高亮。
 *
 * 为什么单独成文件：ProjectPage.tsx 同时装着项目卡、四分区铺陈、六类弹窗编排与
 * 任务行渲染，整体超过 AGENTS.md「单文件尽量不超过 400 行」的上限；这三个组件只
 * 负责把 ProjectTaskView 摆成 DOM、把点击翻译成页面级动作（开哪个弹窗、发哪条
 * 即时命令），自身不持状态、不拼命令入参，和页面编排是两件事，拆出后两边都聚焦。
 * 本次为纯搬移：文案、class、data/aria 属性、点击行为一律不变；页面弹窗状态联合
 * DialogState 仍归 ProjectPage 持有，这里只用 type-only import 引用，编译后擦除，
 * 不产生运行时循环依赖。
 */
import type { ReactNode } from 'react'
import type { ProjectTaskView, ProjectTaskWakeView, ProjectViewRow } from '../../shared/views.js'
import {
  artifactBrief, assigneeBrief, canAttachArtifact, canEditTask, taskTransitionActions,
  wakeLinkState, wakeLinkTitle,
  type BotCatalogue, type TaskTransitionAction,
} from '../logic/project-page.js'
import type { DialogState } from './ProjectPage.js'

/** 项目状态小标签（颜色从不单独表达含义，旁边必有文字）。 */
export function StatusTag(props: { label: string; archived?: boolean }): ReactNode {
  return <span className={`ah-tag${props.archived ? ' ah-prj-tag-archived' : ' ah-prj-tag-status'}`}>{props.label}</span>
}

/**
 * 任务行「关联唤醒」：每个唤醒一枚小链接，点开选中该队友并跳到右栏的这次唤醒账本。
 * 账本查不到或队友已删除时不假装可点，按钮禁用并用 title / aria-label 说明原因。
 */
function WakeLinks(props: {
  wakes: ProjectTaskWakeView[]
  onOpenWake: (botId: string, wakeId: string) => void
}): ReactNode {
  if (props.wakes.length === 0) return null
  return (
    <span className="ah-prj-task-wakes">
      <span>关联唤醒 {props.wakes.length}</span>
      {props.wakes.map(wake => {
        const state = wakeLinkState(wake)
        const title = wakeLinkTitle(wake)
        // WCAG 2.5.3：名称必须包含按钮上可见的时间文字，语音用户念出时间才能命中；
        // 时间在前、用途与摘要在后，视觉零改动。
        return (
          <button key={wake.wakeId} type="button" className="ah-prj-wake-link"
            disabled={state !== 'open'} title={title}
            aria-label={`${wake.openedText ?? '查不到记录'}（打开这次唤醒的账本：${title}）`}
            onClick={() => { if (wake.botId !== null) props.onOpenWake(wake.botId, wake.wakeId) }}>
            {wake.openedText ?? '查不到记录'}
          </button>
        )
      })}
    </span>
  )
}

/** 一条任务行：标题、状态、指派人、关联产物与唤醒、状态流转按钮；待验收行整行高亮。 */
export function TaskRow(props: {
  row: ProjectViewRow
  task: ProjectTaskView
  catalogue: BotCatalogue
  busy: boolean
  onAction: (dialog: DialogState) => void
  onCommand: (action: TaskTransitionAction, task: ProjectTaskView) => void
  onOpenWake: (botId: string, wakeId: string) => void
}): ReactNode {
  const { row, task } = props
  const pending = task.task.status === 'done_pending_check'
  const editable = canEditTask(task, row.project.status)
  // 关联产物：归档项目与已通过任务不给入口（与 core 拒绝口径一致）。
  const attachable = canAttachArtifact(task, row.project.status)
  // 指派行直接来自视图（assigneeBotName / assigneeInvalid），不再反查队友目录。
  const assignee = assigneeBrief(task)
  // 动作表是纯函数：派活类入口只在 active 项目出现，催办/改派只在有承接人时出现。
  const actions = taskTransitionActions(task, row.project.status)
  return (
    <li className={`ah-prj-task${pending ? ' ah-prj-task-pending' : ''}`}>
      <div className="ah-prj-task-main">
        <p className="ah-prj-task-title">
          <span className="ah-tag ah-prj-task-status">{task.statusLabel}</span>
          {task.task.title}
        </p>
        <p className="ah-prj-task-meta">
          <span className={assignee.invalid ? 'ah-org-issue-text' : ''}
            title={assignee.invalid && assignee.botId !== null ? `内部 id：${assignee.botId}` : undefined}>
            指派：{assignee.text}
          </span>
          {task.artifactCount > 0 ? <span>关联产物 {task.artifactCount} 个</span> : null}
          <WakeLinks wakes={task.wakes} onOpenWake={props.onOpenWake} />
          {task.task.detail ? <span className="ah-prj-task-detail" title={task.task.detail}>说明：{task.task.detail}</span> : null}
        </p>
        {pending ? (
          <p className="ah-prj-task-pending-hint">执行者已交账，待验收：通过后完成；驳回需填写理由，任务退回进行中。</p>
        ) : null}
        {/* 验收前提醒：core 按任务状态与关联产物算出的事实，只提醒不阻断。 */}
        {task.acceptance.hints.length > 0 ? (
          <ul className="ah-prj-task-hints" aria-label="验收前提醒">
            {task.acceptance.hints.map((hint, index) => (
              <li key={index}>{hint}</li>
            ))}
          </ul>
        ) : null}
        {/* 已关联产物：版本号、标题、结论与生成时间；旧版本显式标注，避免主人误以为是最新。 */}
        {task.artifacts.length > 0 ? (
          <ul className="ah-prj-task-artifacts" aria-label="关联产物">
            {task.artifacts.map(artifact => (
              <li key={artifact.versionId}>
                <span>{artifactBrief(artifact)}{artifact.isLatest ? '' : '（旧版本）'}</span>
                {artifact.createdText !== null ? <span className="ah-prj-meta">{artifact.createdText}</span> : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <div className="ah-prj-task-ops">
        {attachable ? (
          <button type="button" className="ah-btn ah-btn-ghost" disabled={props.busy}
            title="将队友交出的某一版产物关联到本任务；验收通过时一并记录产物通过。"
            onClick={() => props.onAction({ kind: 'attachArtifact', row, task })}>关联产物</button>
        ) : null}
        {editable ? (
          <button type="button" className="ah-btn ah-btn-ghost" disabled={props.busy}
            onClick={() => props.onAction({ kind: 'taskForm', row, editing: task })}>编辑</button>
        ) : null}
        {actions.map(action => (
          <button key={`${action.kind}-${action.dispatchMode ?? ''}`} type="button"
            className={`ah-btn ${action.tone === 'primary' ? 'ah-btn-primary' : action.tone === 'danger' ? 'ah-btn-danger' : 'ah-btn-ghost'}`}
            disabled={props.busy}
            onClick={() => {
              // 驳回先开理由弹框；五种派活模式先开队友/留言弹框；其余动作直接发命令。
              if (action.needsReason) props.onAction({ kind: 'reject', task })
              else if (action.kind === 'dispatch' && action.dispatchMode !== null) {
                props.onAction({ kind: 'dispatch', row, task, mode: action.dispatchMode })
              } else props.onCommand(action, task)
            }}>
            {action.label}
          </button>
        ))}
      </div>
    </li>
  )
}

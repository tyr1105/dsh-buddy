/**
 * 队友归档 / 恢复 / 删除的弹窗（P48）。
 *
 * 为什么单独成文件：左栏在宿主侧栏与页面内降级列两处渲染，弹窗必须跟着左栏走，
 * 不能各写一套；归档前的拦截提示还要列出受影响的项目和「去处理」入口。
 * P73f：已归档区只剩「删除」，「恢复」去掉了（归档后不能恢复为在岗）；归档的二次确认改在编辑员工弹窗里做，
 * 这里的「archive」「blocked」两种弹窗暂时没有入口，保留是因为无障碍契约测试按这个文件登记弹窗挂载点。
 * 删除的后果：不可撤销但保留历史。
 */
import type { ReactNode } from 'react'
import { ConfirmDialog } from './confirm-dialog.js'
import { useDialogFocus } from './use-dialog-focus.js'

/** 阻止归档的单个项目：项目名、是否仍是成员、它在这个项目里的未结任务数。 */
export interface ArchiveBlockerProject {
  projectId: string
  projectName: string
  member: boolean
  openTaskCount: number
}

/** 服务端归档前置校验结果（与 core ArchiveBotCheck 同形）。 */
export interface ArchiveCheckInfo {
  canArchive: boolean
  reason: string | null
  projectCount: number
  openTaskCount: number
  projects: ArchiveBlockerProject[]
}

/** 当前要显示的弹窗；kind 决定文案与按钮。 */
export type ArchiveDialogRequest =
  | { kind: 'archive'; botId: string; botName: string }
  | { kind: 'blocked'; botName: string; info: ArchiveCheckInfo }
  | { kind: 'delete'; botId: string; botName: string }

export function BotArchiveDialog(props: {
  request: ArchiveDialogRequest
  busy: boolean
  error: string | null
  onCancel: () => void
  onConfirm: () => void
  /** 拦截弹窗里的「去处理」：跳到受影响项目，由父层决定布局。 */
  onOpenProject: (projectId: string) => void
}): ReactNode {
  const { request } = props
  if (request.kind === 'blocked') {
    return <BlockedDialog botName={request.botName} info={request.info} onCancel={props.onCancel} onOpenProject={props.onOpenProject} />
  }
  if (request.kind === 'archive') {
    return (
      <ConfirmDialog
        title={`归档「${request.botName}」`}
        text="归档后它从左栏名单移入「已归档」，不再接活，腾出 1 个名额；记录保留可查。归档后不能恢复为在岗。"
        confirmText="归档"
        busy={props.busy}
        error={props.error}
        tone="primary"
        onCancel={props.onCancel}
        onConfirm={props.onConfirm}
      />
    )
  }
  return (
    <ConfirmDialog
      title={`删除「${request.botName}」`}
      text="只删除它的配置与档案；唤醒账本、工作会话、任务和产物都会保留，相关历史显示「已删除的员工」。此操作不可撤销。"
      confirmText="删除"
      busy={props.busy}
      error={props.error}
      tone="danger"
      onCancel={props.onCancel}
      onConfirm={props.onConfirm}
    />
  )
}

/** 拦截弹窗：说清缺哪一项，逐个项目给出未结任务数与「去处理」。 */
function BlockedDialog(props: {
  botName: string
  info: ArchiveCheckInfo
  onCancel: () => void
  onOpenProject: (projectId: string) => void
}): ReactNode {
  const ref = useDialogFocus(props.onCancel, false)
  return (
    <div className="ah-dialog-mask" ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={`暂不可归档${props.botName}`}>
      <div className="ah-dialog ah-dialog-wide ah-prj-dialog">
        <header className="ah-wizard-head">
          <h2>暂不可归档「{props.botName}」</h2>
          <button type="button" className="ah-btn ah-btn-ghost" onClick={props.onCancel}>关闭</button>
        </header>
        <div className="ah-prj-form">
          <p>{props.info.reason ?? '请先交接该员工负责的项目与任务，再归档。'}</p>
          {props.info.projects.length > 0 ? (
            <ul className="ah-archive-blockers">
              {props.info.projects.map(project => (
                <li key={project.projectId}>
                  <span className="ah-archive-blocker-name">{project.projectName}</span>
                  <span className="ah-archive-blocker-meta">
                    {project.member ? '仍是成员' : ''}
                    {project.member && project.openTaskCount > 0 ? ' · ' : ''}
                    {project.openTaskCount > 0 ? `${project.openTaskCount} 个未结任务` : ''}
                  </span>
                  <button type="button" className="ah-btn ah-btn-ghost" onClick={() => props.onOpenProject(project.projectId)}>查看</button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <footer className="ah-dialog-actions">
          <button type="button" className="ah-btn ah-btn-primary" onClick={props.onCancel}>关闭</button>
        </footer>
      </div>
    </div>
  )
}

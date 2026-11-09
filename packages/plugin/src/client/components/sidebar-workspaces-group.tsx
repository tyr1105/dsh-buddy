/**
 * 左栏第三组「工作区」（P44，U01 第 45 轮从主组件拆出）。
 *
 * 项目是母、会话是子，母子都在左栏内展开；组头加号与项目页共用同一个
 * 新建项目表单。滚动提示（U01 第 43 轮）放在组头之下、滚动列表之外，
 * 是否出现由父层的真实裁切测量决定，本组件只按 clipped 渲染；
 * 内层列表的 ref 由父层传入，测量逻辑仍集中在主组件一处。
 */
import type { ReactNode, Ref } from 'react'
import type { SidebarProjectNode, SidebarSession } from '../logic/sidebar-groups.js'
import { SIDEBAR_GROUP_TITLES } from '../logic/sidebar-groups.js'
import { Chevron, sessionDotClass } from './sidebar-nav-parts.js'
import type { SidebarFormState } from './sidebar-session-form.js'

export interface WorkspacesGroupProps {
  expanded: boolean
  onToggle: () => void
  projects: SidebarProjectNode[]
  /** 项目视图还没加载：空态说「还没读出来」，不假装没有工作。 */
  projectUnloaded: boolean
  /** 当前线程对应的会话 id：子行显示选中态（P44-R2）。 */
  activeTaskId?: string | null
  notice?: string | null
  /** 内层列表是否被真实裁切，控制滚动提示（U01 第 43 轮）。 */
  clipped: boolean
  canNewProject: boolean
  onNewProject: () => void
  /** 项目视图没读出来时的重试（U11 #06）：不传只显示提示，不显示按钮。 */
  onRetry?: () => void
  onToggleProject: (node: SidebarProjectNode) => void
  onOpenProject: (projectId: string) => void
  onOpenProjectForm: (projectId: string) => void
  onOpenSession: (session: SidebarSession) => void
  /** 父层测量内层溢出用的 ref，挂在 .ah-nav-rows 上。 */
  rowsRef: Ref<HTMLDivElement>
  form: SidebarFormState | null
  /** 父层构造好的项目内联表单节点；无表单时为 null。 */
  formNode: ReactNode
}

export function WorkspacesGroup(props: WorkspacesGroupProps): ReactNode {
  return (
    <section className="ah-nav-group ah-nav-group-workspaces">
      <div className="ah-nav-group-head">
        <button
          type="button"
          className="ah-nav-group-toggle"
          aria-expanded={props.expanded}
          onClick={props.onToggle}
        >
          <Chevron open={props.expanded} />
          <span className="ah-nav-group-title">{SIDEBAR_GROUP_TITLES.workspaces}</span>
          {/* 标题已有「工作区」语义，计数缩成「N 个」，全文由 title 保留。 */}
          <span className="ah-nav-group-count" title={`${props.projects.length} 个项目`}>{props.projects.length} 个</span>
        </button>
        {/* 与「队友」组同构的常驻加号（P44-R2）：折叠时也留在标题右侧，
            点击走项目页同一个新建表单，不做第二套实现。 */}
        {props.canNewProject ? (
          <button type="button" className="ah-botlist-add" aria-label="新建项目" title="新建项目" onClick={props.onNewProject}>＋</button>
        ) : null}
      </div>
      {props.expanded ? (
        <>
        {/* 滚动提示放在列表外侧、组头之下（U01 第 43 轮 P2-L1）：不随内层滚动滚没，
            矮视口外层裁切时组头可见就能看到提示；是否出现只认 ResizeObserver 实测的真实裁切。 */}
        {props.clipped ? (
          <p className="ah-nav-scroll-hint">共 {props.projects.length} 个项目，列表内滚动</p>
        ) : null}
        <div className="ah-nav-rows" ref={props.rowsRef}>
          {props.projects.length === 0 ? (
            /* U11 #06：读不出来按「现象—动作—检查」走，并就地给重试（父层传了才显示）。 */
            props.projectUnloaded ? (
              <div className="ah-retry" role="alert">
                <span>读不出来。点重试。还不行，看看 DSH 是不是关了。</span>
                {props.onRetry ? <button type="button" className="ah-btn" onClick={props.onRetry}>重试</button> : null}
              </div>
            ) : (
              <p className="ah-empty">暂无项目。点击上方「＋」新建。</p>
            )
          ) : null}
          {props.projects.map(project => (
            <div key={project.projectId} className="ah-nav-project">
              <div className="ah-nav-project-row">
                <button
                  type="button"
                  className="ah-nav-disclosure"
                  aria-label={project.expanded ? `收起${project.name}` : `展开${project.name}`}
                  aria-expanded={project.expanded}
                  onClick={() => props.onToggleProject(project)}
                >
                  <Chevron open={project.expanded} />
                </button>
                <button
                  type="button"
                  className={`ah-nav-project-name${project.active ? ' ah-selected' : ''}`}
                  title={project.name}
                  onClick={() => props.onOpenProject(project.projectId)}
                >
                  <span className="ah-nav-project-label">{project.name}</span>
                  <span className="ah-nav-project-count">{project.sessionCount}</span>
                </button>
                <button
                  type="button"
                  className="ah-nav-row-add"
                  aria-label={`在${project.name}新建会话`}
                  title={`在${project.name}新建会话`}
                  onClick={() => props.onOpenProjectForm(project.projectId)}
                >＋</button>
              </div>
              {project.expanded ? (
                <div className="ah-nav-sessions">
                  {project.sessions.length === 0 ? <p className="ah-nav-empty">暂无会话。点击项目行「＋」新建。</p> : null}
                  {project.sessions.map(session => {
                    // P2-N3：当前线程对应的那条子行要有选中态，两条相似会话才能一眼分辨。
                    const current = props.activeTaskId !== undefined && props.activeTaskId === session.id
                    return (
                      <button
                        key={session.id}
                        type="button"
                        className={`ah-nav-session${session.blocked ? ' ah-nav-session-blocked' : ''}${current ? ' ah-nav-session-current' : ''}`}
                        title={`${session.title} · ${session.statusLabel}`}
                        aria-current={current ? 'true' : undefined}
                        onClick={() => props.onOpenSession(session)}
                      >
                        <span className={sessionDotClass(session)} aria-hidden="true" />
                        <span className="ah-nav-session-title">{session.title}</span>
                        {session.pendingCheck ? <span className="ah-nav-session-flag">待验收</span> : null}
                      </button>
                    )
                  })}
                  {props.form !== null && props.form.fromBotId === null && props.form.projectId === project.projectId ? props.formNode : null}
                </div>
              ) : null}
            </div>
          ))}
          {props.notice ? <p className="ah-empty" role="alert">{props.notice}</p> : null}
        </div>
        </>
      ) : null}
    </section>
  )
}

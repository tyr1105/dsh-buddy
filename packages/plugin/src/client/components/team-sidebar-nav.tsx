/**
 * 团队空间左栏的三组导航（P44）：办公室 → 队友 → 工作区。
 *
 * 为什么重做：主人核对截图后发现团队空间里有两套侧栏——原生侧栏还留着工作区、
 * 我们只补了一列队友树，办公室也只在顶栏。这个组件是左栏的唯一组合根：
 * 宿主侧栏与页面内降级列都渲染它，三组自上而下、每组可折叠，
 * 工作区在左栏内展开「项目 → 会话」母子结构，不再和原生列表分叉。
 *
 * U01 第 45 轮拆分（本文件曾长到 580 行，超出 400 行指引）：
 * - sidebar-nav-parts：图标、状态点、选中判定等无状态零件；
 * - sidebar-nav-rail：收起态 36px 图标列；
 * - sidebar-session-form：两个入口共用的内联新建会话表单；
 * - sidebar-teammates-group / sidebar-workspaces-group：第二、三组的展示。
 * 本文件保留 props 契约、全部状态与事件处理、滚动裁切测量（第 43 轮）、
 * 办公室组与底部「待你处理」，以及固定的三组编排顺序。
 *
 * 纪律：
 * - 顺序、排序、会话口径全部来自 logic/sidebar-groups，组件不自己决定；
 * - 队友组标题右侧常驻「新建队友」，搜索保留；队友行与项目行各有自己的加号；
 * - 新建会话只发一个 saveTask（父层执行），成功后由父层决定是否直接打开线程；
 * - 收起态只画图标列（36px），不渲染搜索与表单，键盘仍可用 aria-label 识别。
 */
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import type { BotCard, OverviewView, ProjectView } from '../../shared/views.js'
import type { PageView } from '../hub-state.js'
import {
  SIDEBAR_GROUP_TITLES,
  buildWorkspaceProjects,
  collectSidebarProjects,
  isGroupExpanded,
  projectsForBot,
  shouldShowWorkspaceScrollHint,
  toggleGroup,
  type SidebarGroupId,
  type SidebarProjectNode,
  type SidebarSession,
} from '../logic/sidebar-groups.js'
import { Chevron, GearIcon, OfficeIcon } from './sidebar-nav-parts.js'
import {
  BotArchiveDialog,
  type ArchiveCheckInfo,
  type ArchiveDialogRequest,
} from './bot-archive-dialog.js'
import { CompactRail } from './sidebar-nav-rail.js'
import { SidebarSessionForm, type SidebarFormState } from './sidebar-session-form.js'
import { TeammatesGroup } from './sidebar-teammates-group.js'
import { WorkspacesGroup } from './sidebar-workspaces-group.js'

/** 新建会话的入参：父层据此发 saveTask 并刷新。 */
export interface NewSessionInput {
  projectId: string
  assigneeBotId: string | null
  title: string
}

export interface TeamSidebarNavProps {
  overview: OverviewView
  /** 项目视图还没加载时为 null：工作区组显示「还没读出来」，不假装没有工作。 */
  project: ProjectView | null
  view: PageView
  mainFace: 'thread' | 'home'
  selectedThread: string
  /** 宿主侧栏收起态：只画图标列。 */
  compact?: boolean
  notice?: string | null
  /** 当前线程对应的左栏会话 id（P44-R2）：子行据此显示选中态。 */
  activeTaskId?: string | null
  /** 当前打开的项目 id（P44-R2）：项目行据此显示选中态。 */
  activeProjectId?: string | null
  onOpenOffice: () => void
  onSelectBot: (botId: string) => void
  onOpenInbox: () => void
  /** 打开设置页（P51）：全局配置的唯一入口。 */
  onOpenSettings: () => void
  onNewBot: () => void
  /** 工作区组标题右侧常驻加号（P44-R2）：打开与项目页同一个新建项目表单。 */
  onNewProject?: () => void
  /** 工作区项目视图迟迟没读出来时的重试（U11 #06）：宿主侧栏不传时不显示重试按钮。 */
  onRetryProject?: () => void
  onOpenProject: (projectId: string) => void
  onOpenSession: (session: SidebarSession) => void
  /** 父层负责发命令与刷新；返回中文错误，null 表示成功。 */
  onCreateSession?: (input: NewSessionInput) => Promise<string | null>
  /**
   * P48 归档链路：先校验再执行，父层只负责发命令与刷新。
   * 校验失败时返回中文字符串；成功返回受影响项目与任务数（canArchive 为 false 时界面拦截）。
   */
  onCheckArchive?: (botId: string) => Promise<ArchiveCheckInfo | string>
  /** 归档 / 恢复 / 删除都返回中文错误，null 表示成功。 */
  onArchiveBot?: (botId: string) => Promise<string | null>
  onRestoreArchivedBot?: (botId: string) => Promise<string | null>
  onDeleteArchivedBot?: (botId: string) => Promise<string | null>
}

export function TeamSidebarNav(props: TeamSidebarNavProps): ReactNode {
  const [collapsedGroups, setCollapsedGroups] = useState<SidebarGroupId[]>([])
  /** undefined 表示按默认规则（有会话就展开），用户点过之后才变成显式集合。 */
  const [expandedProjectIds, setExpandedProjectIds] = useState<string[] | undefined>(undefined)
  const [query, setQuery] = useState('')
  /** 正在新建会话的表单：项目 id + 固定指派（给队友新建时为该队友）。 */
  const [form, setForm] = useState<SidebarFormState | null>(null)
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  /** P48：已归档折叠区默认收起；归档成功后自动展开，让主人看到它去了哪里。 */
  const [archivedOpen, setArchivedOpen] = useState(false)
  /** 当前归档 / 恢复 / 删除弹窗；null 表示没有。 */
  const [archiveRequest, setArchiveRequest] = useState<ArchiveDialogRequest | null>(null)
  const [archiveBusy, setArchiveBusy] = useState(false)
  const [archiveError, setArchiveError] = useState<string | null>(null)
  /** 队友组内的局部提示（归档校验失败、命令报错），不挤占工作区提示位。 */
  const [teammateNotice, setTeammateNotice] = useState<string | null>(null)
  /**
   * 工作区列表是否真的被裁切（U01 第 43 轮）：不再用「项目数 > 4」猜，
   * 而是实测内层限高溢出或外层滚动区裁切，提示只在裁切真实发生时出现。
   */
  const [workspaceClipped, setWorkspaceClipped] = useState(false)
  /** 外层三组滚动区与工作区内层列表：两个容器任一溢出都算裁切。 */
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const rowsRef = useRef<HTMLDivElement | null>(null)
  /** 最新测量函数放进 ref，ResizeObserver 回调永远调到最新一次渲染的闭包。 */
  const measureRef = useRef<() => void>(() => {})

  const overviewBots = props.overview.bots
  const q = query.trim().toLowerCase()
  /** 搜索命中的全部队友；下面再按「是否归档」分成在名单与折叠区两段。 */
  const matchedBots = useMemo(
    () => overviewBots.filter(bot => `${bot.name} ${bot.roleLabel}`.toLowerCase().includes(q)),
    [overviewBots, q],
  )
  const activeBots = useMemo(() => matchedBots.filter(bot => bot.archived !== true), [matchedBots])
  const archivedBots = useMemo(() => matchedBots.filter(bot => bot.archived === true), [matchedBots])
  /**
   * 收起态图标列的队友名单（U01 第 46 轮修 P53 遗留）：
   * rail 里没有搜索框，展开态搜索框里残留的词不能带进来——否则搜过一个名字再收起，
   * 图标列就只剩命中的人（搜无命中词时一个都不剩），而收起态没有任何地方清除搜索词，
   * 主人会以为队友丢了。所以 rail 永远列全部在岗队友，口径与组头计数一致，已归档不进 rail。
   */
  const railBots = useMemo(() => overviewBots.filter(bot => bot.archived !== true), [overviewBots])
  /** 组头计数只算在名单的队友；已归档另有折叠区计数，避免同一个名字被算两次。 */
  const activeTotalBots = railBots.length
  const sidebarProjects = useMemo(() => collectSidebarProjects(props.project), [props.project])
  const workspaceProjects = useMemo(
    () => buildWorkspaceProjects({
      projects: sidebarProjects,
      expandedProjectIds,
      activeProjectId: props.activeProjectId ?? null,
    }),
    [sidebarProjects, expandedProjectIds, props.activeProjectId],
  )
  const botById = useMemo(() => new Map(overviewBots.map(bot => [bot.id, bot])), [overviewBots])
  /** 可新建会话的项目：进行中或暂停；已完成/归档不再加活。 */
  const creatable = sidebarProjects.filter(project => project.status === 'active' || project.status === 'paused')

  const toggleGroupCollapsed = (groupId: SidebarGroupId): void => {
    setCollapsedGroups(prev => toggleGroup(prev, groupId))
  }

  /** 手动展开/收起项目：第一次点击时把默认展开结果固化成显式集合。 */
  const toggleProject = (node: SidebarProjectNode): void => {
    const current = expandedProjectIds ?? workspaceProjects.filter(item => item.expanded).map(item => item.projectId)
    setExpandedProjectIds(
      current.includes(node.projectId)
        ? current.filter(id => id !== node.projectId)
        : [...current, node.projectId],
    )
  }

  /** 打开「给项目新建会话」：默认待领（不指派），成员下拉可选。 */
  const openProjectForm = (projectId: string): void => {
    setForm({ projectId, botId: null, fromBotId: null })
    setTitle('')
    setFormError(null)
    if (!(expandedProjectIds ?? []).includes(projectId)) {
      const current = expandedProjectIds ?? workspaceProjects.filter(item => item.expanded).map(item => item.projectId)
      if (!current.includes(projectId)) setExpandedProjectIds([...current, projectId])
    }
  }

  /** 打开「给队友新建会话」：项目只列它参与的可加活项目，指派固定为它。 */
  const openBotForm = (botId: string): void => {
    const own = projectsForBot(creatable, botId)
    setForm({ projectId: own[0]?.id ?? '', botId, fromBotId: botId })
    setTitle('')
    setFormError(own.length === 0 ? '它还没进任何项目。打开项目页，把它加进去，再派活。' : null)
  }

  const closeForm = (): void => {
    setForm(null)
    setTitle('')
    setFormError(null)
  }

  const submitForm = (event: FormEvent): void => {
    event.preventDefault()
    if (form === null || busy) return
    const name = title.trim()
    // U11 #12：说清缺什么、上限多少（core 实际上限 120 字，audit 写的 60 与实现不一致，见 questions.md）。
    if (name === '') { setFormError('还差一个名字。填 1 到 120 个字，再点「新建会话」。'); return }
    if (form.projectId === '') { setFormError('未选择项目。请先选择项目。'); return }
    if (props.onCreateSession === undefined) { setFormError('这里建不了。先去项目页，把队友加进成员。'); return }
    setBusy(true)
    setFormError(null)
    void props.onCreateSession({ projectId: form.projectId, assigneeBotId: form.botId, title: name })
      .then((error) => {
        if (error !== null) { setFormError(error); return }
        closeForm()
      })
      .catch((error: unknown) => { setFormError(error instanceof Error ? error.message : String(error)) })
      .finally(() => setBusy(false))
  }

  /**
   * 归档链路（P48）：先向服务端要校验结果，再决定弹确认框还是拦截框。
   * 归档成功自动展开已归档区；恢复成功后收起区保留在原位，主人可以继续操作。
   */
  const beginArchive = (bot: BotCard): void => {
    if (props.onCheckArchive === undefined) { setTeammateNotice('暂不可归档队友。请稍后重试。'); return }
    setTeammateNotice(null)
    setArchiveError(null)
    void props.onCheckArchive(bot.id).then(result => {
      if (typeof result === 'string') {
        setArchiveRequest({ kind: 'blocked', botName: bot.name,
          info: { canArchive: false, reason: result, projectCount: 0, openTaskCount: 0, projects: [] } })
        return
      }
      setArchiveRequest(result.canArchive
        ? { kind: 'archive', botId: bot.id, botName: bot.name }
        : { kind: 'blocked', botName: bot.name, info: result })
    }).catch((error: unknown) => setTeammateNotice(error instanceof Error ? error.message : String(error)))
  }
  const beginRestore = (bot: BotCard): void => {
    setArchiveError(null)
    setArchiveRequest({ kind: 'restore', botId: bot.id, botName: bot.name })
  }
  const beginDelete = (bot: BotCard): void => {
    setArchiveError(null)
    setArchiveRequest({ kind: 'delete', botId: bot.id, botName: bot.name })
  }
  const closeArchiveDialog = (): void => {
    if (archiveBusy) return
    setArchiveRequest(null)
    setArchiveError(null)
  }
  const confirmArchiveDialog = (): void => {
    if (archiveRequest === null || archiveRequest.kind === 'blocked' || archiveBusy) return
    const action = archiveRequest.kind === 'archive' ? props.onArchiveBot
      : archiveRequest.kind === 'restore' ? props.onRestoreArchivedBot : props.onDeleteArchivedBot
    if (action === undefined) { setArchiveError('暂不可执行该操作。请稍后重试。'); return }
    const request = archiveRequest
    setArchiveBusy(true)
    setArchiveError(null)
    void action(request.botId).then(error => {
      if (error !== null) { setArchiveError(error); return }
      setArchiveRequest(null)
      setTeammateNotice(null)
      // 归档成功后展开折叠区，让主人马上看到它移到了哪里。
      if (request.kind === 'archive') setArchivedOpen(true)
    }).catch((error: unknown) => {
      setArchiveError(error instanceof Error ? error.message : String(error))
    }).finally(() => setArchiveBusy(false))
  }

  const officeExpanded = isGroupExpanded(collapsedGroups, 'office')
  const teammatesExpanded = isGroupExpanded(collapsedGroups, 'teammates')
  const workspacesExpanded = isGroupExpanded(collapsedGroups, 'workspaces')
  const compact = props.compact === true

  /**
   * 实测两个容器的溢出事实：
   * - 内层 .ah-nav-rows：scrollHeight 超过 clientHeight 说明撞到 360px 组内限高；
   * - 外层 .ah-nav-scroll：rows 盒底跑出滚动区盒底，说明矮视口把工作区裁掉了。
   * 1px 容差吸收亚像素取整，避免边界态提示闪烁。布尔判定交给纯函数，组件只采几何。
   */
  const measureWorkspaceClip = (): void => {
    const rows = rowsRef.current
    const scroll = scrollRef.current
    if (rows === null || scroll === null) {
      setWorkspaceClipped(false)
      return
    }
    const rowsOverflow = rows.scrollHeight > rows.clientHeight + 1
    const outerClip = rows.getBoundingClientRect().bottom > scroll.getBoundingClientRect().bottom + 1
    setWorkspaceClipped(shouldShowWorkspaceScrollHint({ rowsOverflow, outerClip, groupExpanded: workspacesExpanded }))
  }
  measureRef.current = measureWorkspaceClip

  // 每次渲染后补测一次：项目展开/收起、过滤、表单撑高都会改内容高度，
  // 但元素自身盒尺寸可能被 max-height 顶住而不触发 ResizeObserver。
  useEffect(() => { measureWorkspaceClip() })
  // 视口变化只改容器尺寸、不触发 React 渲染：用 ResizeObserver 兜住窗口拖拽与宿主侧栏缩放。
  // 依赖带上 compact：收起时这两个容器被卸载，要断开监听；重新展开是一套新的 DOM，要重新盯住，
  // 否则展开后窗口再怎么变，「列表内滚动」的提示都不会更新。
  useEffect(() => {
    const scroll = scrollRef.current
    if (scroll === null) return
    const observer = new ResizeObserver(() => measureRef.current())
    observer.observe(scroll)
    if (rowsRef.current !== null) observer.observe(rowsRef.current)
    return () => observer.disconnect()
  }, [workspacesExpanded, compact])

  // 收起态：只画图标列。顺序与展开态一致，靠 title/aria-label 让读屏与悬停都能认人。
  // 这个分支必须排在所有 hook 之后：提前 return 会让展开和收起的 hook 数量不一样，
  // 窗口一缩窄 React 就报错（#300），整个左栏变成「这块没显示出来，刷新试试」。
  // 收起态下两个容器都不存在，上面的测量会得到「没有裁切」，监听直接跳过，不会报错。
  // 队友名单用 railBots 而非 activeBots：rail 没有搜索框，不吃展开态残留的搜索词（第 46 轮）。
  if (compact) {
    return (
      <CompactRail
        view={props.view}
        selectedThread={props.selectedThread}
        bots={railBots}
        workspaceProjects={workspaceProjects}
        inboxTotal={props.overview.inbox.total}
        canNewProject={props.onNewProject !== undefined}
        onOpenOffice={props.onOpenOffice}
        onSelectBot={props.onSelectBot}
        onNewBot={props.onNewBot}
        /* 加号只在 canNewProject 时渲染，没有回调时这个空函数永远不会被触发。 */
        onNewProject={props.onNewProject ?? (() => {})}
        onOpenProject={props.onOpenProject}
        onOpenInbox={props.onOpenInbox}
        onOpenSettings={props.onOpenSettings}
      />
    )
  }

  // 表单的派生数据：队友表单的可选项目、项目表单的成员名单、表单标题里的队友名。
  const botFormProjects = form?.fromBotId === null || form === null ? [] : projectsForBot(creatable, form.fromBotId)
  const formMembers = form === null ? [] : sidebarProjects.find(project => project.id === form.projectId)?.memberBotIds ?? []
  const formBot = form?.fromBotId === null || form === null ? null : botById.get(form.fromBotId) ?? null
  /** 两个入口共用同一个表单节点；form 为 null 时不挂载，状态全部留在本组件。 */
  const formNode = form === null ? null : (
    <SidebarSessionForm
      form={form}
      memberOptions={formMembers.map(id => ({ id, name: botById.get(id)?.name ?? id }))}
      title={title}
      busy={busy}
      error={formError}
      onTitleChange={setTitle}
      onMemberChange={botId => setForm(prev => prev === null ? prev : { ...prev, botId })}
      onCancel={closeForm}
      onSubmit={submitForm}
    />
  )

  return (
    <nav className="ah-botlist ah-sidebar-nav" aria-label="团队空间导航">
      {/* 三组放进独立滚动区（P44-R2）：底部「待你处理」固定在导航最下方，
          三组全展开时只滚这一块，入口任何视口下都不被顶出首屏。 */}
      <div className="ah-nav-scroll" ref={scrollRef}>
      {/* 第一组：办公室。入口就是这一行，不再只靠顶栏 Tab。 */}
      <section className="ah-nav-group">
        <div className="ah-nav-group-head">
          <button
            type="button"
            className="ah-nav-group-toggle"
            aria-expanded={officeExpanded}
            onClick={() => toggleGroupCollapsed('office')}
          >
            <Chevron open={officeExpanded} />
            <span className="ah-nav-group-title">{SIDEBAR_GROUP_TITLES.office}</span>
            {/* 办公室组只报「多少人正在忙」：待你处理的总数归底部唯一入口，
                这里再报一个同样的数字最容易误读（P2-3）。 */}
            <span className="ah-nav-group-count">
              {(() => {
                // U11 #03：计数只报真人数；零在忙时把梗放这一句，且全左栏只此一处幽默。
                const thinking = overviewBots.filter(bot => bot.activity === 'thinking').length
                return thinking > 0 ? `${thinking} 人在忙` : '办公室还空着。没人搬砖，也没人摸鱼。'
              })()}
            </span>
          </button>
          {/* 办公室组没有动作按钮：补一个同宽占位（U01 第 43 轮 P2-O1），
              让三组计数右缘落在同一条线上；aria-hidden 且不可聚焦，不进 Tab 序列。 */}
          <span className="ah-nav-group-head-spacer" aria-hidden="true" />
        </div>
        {officeExpanded ? (
          <button
            type="button"
            className={`ah-nav-item ah-nav-office${props.view === 'office' ? ' ah-selected' : ''}`}
            aria-current={props.view === 'office' ? 'page' : undefined}
            onClick={props.onOpenOffice}
          >
            <OfficeIcon />
            <span className="ah-nav-item-name">进入办公室</span>
          </button>
        ) : null}
      </section>

      {/* 第二组：队友。标题右侧常驻新建入口，搜索框只过滤这一组。 */}
      <TeammatesGroup
        expanded={teammatesExpanded}
        onToggle={() => toggleGroupCollapsed('teammates')}
        totalBots={activeTotalBots}
        query={query}
        onQueryChange={setQuery}
        team={props.overview.team}
        view={props.view}
        mainFace={props.mainFace}
        selectedThread={props.selectedThread}
        bots={activeBots}
        archivedBots={archivedBots}
        archivedOpen={archivedOpen}
        onToggleArchived={() => setArchivedOpen(prev => !prev)}
        notice={teammateNotice}
        onBeginArchive={beginArchive}
        onBeginRestore={beginRestore}
        onBeginDelete={beginDelete}
        onSelectBot={props.onSelectBot}
        onNewBot={props.onNewBot}
        onOpenBotForm={openBotForm}
        onBotFormProjectChange={projectId => setForm(prev => prev === null ? prev : { ...prev, projectId })}
        form={form}
        botFormProjects={botFormProjects}
        formBot={formBot}
        formNode={formNode}
      />

      {/* 第三组：工作区。项目是母、会话是子，母子都在左栏内展开。 */}
      <WorkspacesGroup
        expanded={workspacesExpanded}
        onToggle={() => toggleGroupCollapsed('workspaces')}
        projects={workspaceProjects}
        projectUnloaded={props.project === null}
        activeTaskId={props.activeTaskId ?? null}
        notice={props.notice ?? null}
        clipped={workspaceClipped}
        canNewProject={props.onNewProject !== undefined}
        onNewProject={props.onNewProject ?? (() => {})}
        onRetry={props.onRetryProject}
        onToggleProject={toggleProject}
        onOpenProject={props.onOpenProject}
        onOpenProjectForm={openProjectForm}
        onOpenSession={props.onOpenSession}
        rowsRef={rowsRef}
        form={form}
        formNode={formNode}
      />
      </div>

      <div className="ah-botlist-footer">
        <button type="button" className="ah-btn ah-inbox-entry" aria-label="待你处理" onClick={props.onOpenInbox}>
          <span className="ah-inbox-entry-name">待你处理</span>
          <span className="ah-inbox-entry-sub">
            {props.overview.inbox.total > 0 ? `${props.overview.inbox.total} 件事等你` : '没人找你。它们都在忙。'}
          </span>
        </button>
        <button
          type="button"
          className={`ah-nav-item ah-nav-settings${props.view === 'settings' || props.view === 'resource' ? ' ah-selected' : ''}`}
          aria-current={props.view === 'settings' || props.view === 'resource' ? 'page' : undefined}
          onClick={props.onOpenSettings}
        >
          <GearIcon />
          <span className="ah-nav-item-name">设置</span>
        </button>
      </div>
      {/* 归档 / 恢复 / 删除的确认与拦截都挂在左栏自己身上，宿主侧栏与页面内降级列共用。 */}
      {archiveRequest !== null ? (
        <BotArchiveDialog
          request={archiveRequest}
          busy={archiveBusy}
          error={archiveError}
          onCancel={closeArchiveDialog}
          onConfirm={confirmArchiveDialog}
          onOpenProject={projectId => {
            setArchiveRequest(null)
            setArchiveError(null)
            props.onOpenProject(projectId)
          }}
        />
      ) : null}
    </nav>
  )
}

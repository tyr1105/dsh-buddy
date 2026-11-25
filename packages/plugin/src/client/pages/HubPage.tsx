/**
 * 中心页：像聊天软件的三栏页面——左队友列表、中对话线程/收件箱/活动流/设置、右侧边栏（默认收起）。
 * 点队友直接进对话（P64）；忙碌状态、额度、在办的事放在按需展开的右侧边栏。
 * 数据全部来自 HubStore（唯一仓库）；加载超过 300ms 显示骨架；宿主连不上整页提示；
 * 每个页面块外包 BlockBoundary（出错只显示「这块没显示出来，刷新试试」）。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { KnowledgeConnectionState } from '@agent-hub/core'
import type { HubStore, PageView } from '../hub-state.js'
import { createStore, useStore, type Store } from '../store.js'
import { TopBar } from '../components/TopBar.js'
import { CommandPalette } from '../components/command-palette.js'
import type { CommandActionId } from '../logic/command-palette.js'
import { TeamSidebarNav, type NewSessionInput } from '../components/team-sidebar-nav.js'
import { ThreadPane, type ThreadHeaderInfo } from '../components/ThreadPane.js'
import { RightPanel } from '../components/RightPanel.js'
import { TeammateEditHost } from '../components/teammate-edit-host.js'
import { InboxPane } from '../components/InboxPane.js'
import { ActivityPane } from '../components/ActivityPane.js'
import { SettingsPane } from '../components/SettingsPane.js'
import { OfficeReplayPage } from './office-replay-page.js'
import { ResourcePage } from './ResourcePage.js'
import { ProjectPage } from './ProjectPage.js'
import { addTeammatesFromTemplates, createTeammate } from '../logic/wizard-create.js'
import { NewBotWizard } from '../components/NewBotWizard.js'
import { MemoryPage } from './MemoryPage.js'
import { undoCommandOf } from '../logic/memory.js'
import { settingsSectionOfView } from '../logic/settings-sections.js'
import { restoreEditFocus } from '../logic/edit-focus.js'
import { BlockBoundary } from '../components/ErrorBoundary.js'
import { Skeleton } from '../components/Ui.js'
import type { CardActions } from '../components/Cards.js'
import { cardSubmission } from '../logic/cards.js'
import { teamCardActions } from '../logic/team-actions.js'
import { modelTiers } from '@agent-hub/core/team'
import { displayRoleLabel, isChiefEntry } from '../logic/agreement.js'
import { OPEN_SESSION_HINTS, openBotSessionWith } from '../logic/thread.js'
import { STATUS_OK_TEXT, headerStatusAction, staffAllTargets } from '../logic/lifecycle.js'
import { collectWorkSessions, sessionsForBot, type WorkSession } from '../logic/work-session.js'
import { findTopic, isTopicThreadId, openNewTopic, topicPaneInfo } from '../logic/topics.js'
import { sendDraftFirstMessage, sidebarSelectedThread, topicDraftThreadId } from '../logic/topic-draft.js'
import { TopicDraftPane } from '../components/topic-draft-pane.js'
import { isNoThread, landingSurface } from '../logic/missing-teammate.js'
import { createOwnerSeenReporter } from '../logic/owner-seen.js'
import { FilePreviewPane } from '../components/FilePreviewPane.js'
import { closeFilePreview, filePreviewStore } from '../logic/file-preview.js'

/**
 * 没有外部定位来源时的空仓库（P43）：保证 useStore 始终被调用，
 * 不因可选属性破坏 hooks 顺序；null 表示「没有待定位的收件箱项」。
 */
const EMPTY_INBOX_FOCUS = createStore<string | null>(null)

/** 骨架判定：加载中的视图超过 300ms 才显示骨架（16.0.3 第 9 条）。 */
function useSlowLoading(loading: boolean): boolean {
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    if (!loading) { setSlow(false); return }
    const timer = setTimeout(() => setSlow(true), 300)
    return () => clearTimeout(timer)
  }, [loading])
  return slow
}

export function HubPage(props: {
  hub: HubStore
  clientCtx: unknown
  sidebarInHost?: boolean
  /** 从应用内提示点进来时要定位的收件箱项（P43）：消费一次后清空。 */
  inboxFocus?: Store<string | null>
}): ReactNode {
  const hub = props.hub
  const state = useStore(hub)
  // P74i-m2（第二次，第 4 节第 1 条）：「待你处理」里约定确认条目下面的说明，改为只看条目自己带的
  // agreementJobSplit、agreementStop（核心 P74r8 给出）；此处原先从已打开的对话里收集约定 id 的写法已去掉。
  const [rightOpen, setRightOpen] = useState(false)
  /** 正在编辑的员工 id（P78）：null 表示「编辑员工」弹窗没开；两个入口共用这一个状态。 */
  const [editStaffId, setEditStaffId] = useState<string | null>(null)
  /**
   * P74i-m4（第 5 节第 2 条）：打开「编辑员工」弹窗时记下触发它的元素，关弹窗后把焦点还回去。
   * 两个入口（右栏按钮、「更多」菜单项）点下去之后都会从页面上消失，弹窗自己记的触发元素随之失效，
   * 焦点会落到页面最外层；这里在弹窗关闭后补一次：原按钮还在就回原按钮，不在就回左栏里这位员工那一行。
   */
  const editOpenerRef = useRef<HTMLElement | null>(null)
  const lastEditIdRef = useRef<string | null>(null)
  const openEditStaff = (botId: string): void => {
    try { editOpenerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null } catch { editOpenerRef.current = null }
    setEditStaffId(botId)
  }
  useEffect(() => {
    const was = lastEditIdRef.current
    lastEditIdRef.current = editStaffId
    // 只在「刚从打开变成关闭」时处理；此时弹窗已卸载（它自己的还焦点逻辑已先执行）。
    if (editStaffId !== null || was === null) return
    const opener = editOpenerRef.current
    editOpenerRef.current = null
    restoreEditFocus(opener, was, selector => document.querySelector<HTMLElement>(selector))
  }, [editStaffId])
  const [busyInboxId, setBusyInboxId] = useState<string | null>(null)
  const [threadError, setThreadError] = useState<string | null>(null)
  const [wizardOpen, setWizardOpen] = useState(false)
  /** 跳转面板（WCAG 2.4.5）：打开时覆盖在页面上，关闭后不渲染、不占布局。 */
  const [paletteOpen, setPaletteOpen] = useState(false)
  /**
   * 从「待你处理」跳进来的是哪条线程：头部据此显示「返回待你处理」。
   * 记线程 id 而不是一个开关（P64）：宿主侧栏点别的队友时页面收不到通知，
   * 记了 id，切到别的线程回程钮自然就不成立，不会挂在不相干的对话上。
   */
  const [inboxReturnThread, setInboxReturnThread] = useState<string | null>(null)
  /** P72g B2：从待你处理的约定条目点「查看对话」进总管私聊时，要滚到的那份约定；用过一次就由 ThreadPane 消费，换线程时清掉。 */
  const [focusAgreementId, setFocusAgreementId] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  /** 试跑提示归属的机器人：它的线程里出现第一条回复后自动消失（D04 3c-3）。 */
  const [noticeAutoClearBot, setNoticeAutoClearBot] = useState<string | null>(null)
  /** 跳到动态页时替主人先筛好的队友（P64）：点某位队友的唤醒记录进来才有值。 */
  const [activityBotId, setActivityBotId] = useState<string | null>(null)
  /** 从办公室门口点进来时要聚焦的收件箱卡（F04）；普通进入收件箱为 null。 */
  const [focusInboxId, setFocusInboxId] = useState<string | null>(null)

  /**
   * P76k：页面可见时上报「你正在看」（ownerSeen）——挂载时一次，之后每 5 分钟一次；
   * 页面由隐藏变为可见时立刻再报一次，隐藏时停。节奏由 logic/owner-seen.ts 控制（可用假计时器单测）。
   * 失败只记日志；旧宿主没有这个命令时，第一次收到「未知命令」之后不再调用。
   */
  const ownerSeenSupported = useRef(true)
  useEffect(() => {
    const node = typeof document === 'undefined' ? null : document
    const hidden = (): boolean => node === null || node.visibilityState === 'hidden'
    const reporter = createOwnerSeenReporter({
      hidden,
      report: () => {
        if (!ownerSeenSupported.current) return
        void hub.command('ownerSeen', {}).then(result => {
          try {
            if (!result.ok && result.error.includes('未知命令')) ownerSeenSupported.current = false
          } catch { /* 结果处理失败只影响是否继续上报 */ }
        }).catch(() => undefined)
      },
    })
    reporter.reportNow()
    if (!hidden()) reporter.start()
    const onVisibility = (): void => { reporter.onVisibilityChange() }
    try { node?.addEventListener('visibilitychange', onVisibility) } catch { /* 环境没有 document 时只影响上报 */ }
    return () => {
      reporter.stop()
      try { node?.removeEventListener('visibilitychange', onVisibility) } catch { /* 忽略 */ }
    }
  }, [hub])

  /** P76k：收起离开期间摘要；成功后重拉线程，让它从视图里消失。 */
  const dismissAway = async (threadId: string): Promise<void> => {
    const result = await hub.command('dismissAwaySummary', {})
    if (!result.ok) throw new Error(result.error)
    await hub.refreshThread(threadId)
  }

  const selectedThread = state.selectedThread
  /**
   * P60 草稿主题：中栏摆着「新开会话」的空聊天时，本页把它当成单独的视图 'topic-draft'。
   * 这样下面所有「页面正摆着选中线程（view === 'main'）」的判断自动不成立：不给上一条线程标已读、
   * 不开它的右侧边栏、不留它的回程钮。仓库里的 view 仍是 'main'；换页、切线程都会清掉草稿。
   */
  const topicDraft = state.view === 'main' ? state.topicDraft : null
  // P71：团队全景下线后，主视图没有选中任何对话时摆办公室。仓库本身已经这样归一，这里再兜一次底，
  // 万一哪条旧路径把页面停在「主视图 + 没有选中」，也不会出现一页空对话或去拉一条不存在的线程。
  const view: PageView | 'topic-draft' = topicDraft !== null ? 'topic-draft' : landingSurface(state.view, selectedThread).view

  // 首次挂载拉全部基础视图；此后由 SSE changed 事件驱动刷新。
  useEffect(() => {
    void hub.refreshAll()
    void hub.refreshSettings()
  }, [hub])
  /**
   * P76k：设置页打开时拉一次「最近 7 天的用量」表。只读视图，失败只在设置页那一块显示原因；
   * 不放进 refreshAll：这块只有设置页用，别的页面不必为它多发一次请求。
   */
  useEffect(() => {
    if (view !== 'settings') return
    void hub.refreshWeeklyUsage()
  }, [hub, view])
  // P58：选中某位队友时，等名册到手再拉对话，因为本地记住的 id 可能早已不存在。
  // 这个布尔值只在名册第一次到手时翻转，不会造成多拉。P71：没有选中任何对话时什么都不拉。
  const threadLoadable = !isNoThread(selectedThread) && state.overview !== null
  useEffect(() => {
    if (state.connectionDown || !threadLoadable) return
    setThreadError(null)
    void hub.refreshThread(selectedThread).catch(() => setThreadError('线程读取失败。点击「重试」；仍失败请确认插件未停用。'))
  }, [hub, selectedThread, state.connectionDown, threadLoadable])

  // W12：文件预览侧栏和员工侧边栏同一个位置，一次只开一个（同 DSH 右侧栏只有一栏）。
  // 打开预览时收起员工侧边栏；展开员工侧边栏时关掉预览；换页、换对话时关掉预览（文件属于原来那张卡）。
  const previewOpen = useStore(filePreviewStore) !== null
  useEffect(() => { if (previewOpen) setRightOpen(false) }, [previewOpen])
  useEffect(() => { if (rightOpen) closeFilePreview() }, [rightOpen])
  useEffect(() => { closeFilePreview() }, [view, selectedThread])

  // P58：选中的队友已不存在、仓库把选中退回办公室时（P71 前是团队全景），页面里跟这位队友绑定的状态也要归位，
  // 否则会留着旧提示条，下次选别人时右侧边栏也会莫名打开。
  // 挂载时也会跑一次，这些状态本来就是初始值，等于什么都没做。
  // 这段必须排在下面几个「接住定位请求」的 effect 前面：同一轮里既退出又有新请求时，新请求要赢。
  const selectionExitSeq = state.selectionExitSeq
  useEffect(() => {
    setInboxReturnThread(null)
    setRightOpen(false)
    setNotice(null)
    setNoticeAutoClearBot(null)
  }, [selectionExitSeq])

  // P43：提示点进来时，外层先记下目标收件箱项、再切队友模式打开中心页；
  // 页面挂载（或已在页内）后消费一次：切到收件箱、定位并描边那一项，然后清空。
  // 清空是必须的——否则之后每次重挂载都会被同一条旧目标拽回收件箱。
  const inboxFocusStore = props.inboxFocus ?? EMPTY_INBOX_FOCUS
  const pendingInboxFocus = useStore(inboxFocusStore)
  useEffect(() => {
    if (pendingInboxFocus === null) return
    setFocusInboxId(pendingInboxFocus)
    hub.setView('inbox')
    void hub.refreshInbox()
    inboxFocusStore.set(null)
  }, [hub, inboxFocusStore, pendingInboxFocus])

  // 离开对话页或换了线程，「从待你处理来」这件事就结束了，回程钮不再留着。
  useEffect(() => {
    if (view !== 'main' || selectedThread !== inboxReturnThread) setInboxReturnThread(null)
  }, [view, selectedThread, inboxReturnThread])

  // P37：宿主一级侧栏的「新建队友」加号把请求写进仓库计数；有没处理的请求就开向导。
  // P53：接住后立刻清零，不再用 ref 记「挂载时的值」。主人在别的页面点加号时，
  // 请求比本页挂载还早，原来的写法把它当成历史吞掉，只切了页面、弹窗不出现。
  const newBotRequest = state.newBotRequest
  useEffect(() => {
    if (newBotRequest === 0) return
    hub.clearNewBotRequest()
    setWizardOpen(true)
  }, [hub, newBotRequest])

  // P44-R2：左栏「工作区」加号与项目页「＋ 新项目」走同一个表单。
  // 侧栏只写请求计数，这里换成一次性布尔交给项目页打开，消费后立刻归位，
  // 避免重挂载时又把新建表单弹一遍。P53：请求同样接住后清零，挂载前点的也不丢。
  const [pendingNewProject, setPendingNewProject] = useState(false)
  const newProjectRequest = state.newProjectRequest
  useEffect(() => {
    if (newProjectRequest === 0) return
    hub.clearNewProjectRequest()
    setPendingNewProject(true)
  }, [hub, newProjectRequest])

  // 选中机器人时拉它的详情。
  const overview = state.overview
  const selectedBot = overview?.bots.find(b => b.id === selectedThread) ?? null
  useEffect(() => {
    if (selectedBot && !state.bots[selectedBot.id]) void hub.refreshBot(selectedBot.id)
  }, [hub, selectedBot, state.bots])
  // P75k：页面停在「关于你的记忆」却还没有视图时（例如从上次的页面状态恢复）取一次；入口点击时仓库已经取过。
  const memoryMissing = view === 'memory' && state.memoryPage === null && state.memoryError === null
  useEffect(() => {
    if (memoryMissing) void hub.refreshMemory()
  }, [hub, memoryMissing])

  // 工作会话投影（P33）：项目视图还没到时是 null，右侧边栏显示骨架，不假装没有工作。
  const workSessions = state.project === null ? null : collectWorkSessions(state.project)
  const selectedSessions = selectedBot !== null && workSessions !== null
    ? sessionsForBot(workSessions, selectedBot.id)
    : null

  // P76j：选中一位员工时取一次它的「在办的事」；总览刷新后（有回合、有条目、有约定变化）
  // 再取一次，右栏的消耗与「在等」跟着更新。取不到时 store 里没有这个键，右栏退回工作会话列表。
  const selectedBotId = selectedBot?.id ?? null
  useEffect(() => {
    if (selectedBotId === null) return
    void hub.refreshActiveJobs(selectedBotId)
  }, [hub, selectedBotId, overview])

  /**
   * 当前线程是项目主题时的页面信息（P63）。只看 id 前缀来判断，
   * 项目视图还没到时也按主题模式画，等视图到了再补上项目名和成员。
   */
  const topicThread = isTopicThreadId(selectedThread)
  const foundTopic = topicThread ? findTopic(state.project, selectedThread) : null
  const topicInfo = topicThread ? topicPaneInfo(foundTopic, state.threads[selectedThread]?.title ?? null, overview?.bots ?? []) : null

  // P63：页面把主题摆出来才算读过。看着的时候新楼层还在进来，未读数一变就再标一次，左栏的点才不会一直亮着。
  const topicUnread = foundTopic?.topic.unread ?? 0
  useEffect(() => {
    if (view !== 'main' || !isTopicThreadId(selectedThread) || topicUnread === 0) return
    void hub.command('markThreadRead', { threadId: selectedThread }).then(() => hub.refreshProject()).catch(() => undefined)
  }, [hub, view, selectedThread, topicUnread])

  // P68：私聊同理。仓库的 selectThread 只在「点进去」那一下标已读，主人开着对话时队友又回了新消息，
  // 左栏这位队友的未读点就一直亮着。这里照主题的写法：页面正摆着这条私聊（view === 'main'）、
  // 名册里它的未读数大于 0 时，再标一次已读并刷新名册。
  // - P71：团队全景下线，原来给团队线程补的那份处理跟着收掉，这里只管队友私聊。
  // - 名册里查不到这个 id（已删除的队友）时 selectedBot 为 null，未读数按 0 算，不发标已读（P58 的规矩）。
  // - 不会循环：未读为 0 不发；标完刷新名册后未读归 0，依赖变了但条件不成立，就停了；
  //   标已读失败时未读数不变、依赖不变，effect 不会重跑。
  const chatUnread = selectedBot?.unread ?? 0
  useEffect(() => {
    if (view !== 'main' || isTopicThreadId(selectedThread) || chatUnread === 0) return
    void hub.command('markThreadRead', { threadId: selectedThread }).then(() => hub.refreshOverview()).catch(() => undefined)
  }, [hub, view, selectedThread, chatUnread])

  // 试跑提示只在试跑排队或进行中显示（D04 3c-3 / D07 第 19 条）：该机器人线程出现
  // 第一条回复，或试跑唤醒单已结束（无论有没有回复）就消失。
  useEffect(() => {
    if (noticeAutoClearBot === null || notice === null) return
    const thread = state.threads[noticeAutoClearBot]
    if (thread?.messages.some(m => m.kind === 'reply')) {
      setNotice(null)
      setNoticeAutoClearBot(null)
      return
    }
    const wakes = state.bots[noticeAutoClearBot]?.wakes
    if (wakes !== undefined) {
      const trial = wakes.find(w => w.variant === 'trial')
      // 详情里能看到试跑唤醒单、而它已不在队列/进行中：试跑结束，提示撤下。
      if (trial !== undefined && !['delivering', 'running'].includes(trial.status)) {
        setNotice(null)
        setNoticeAutoClearBot(null)
      }
    }
  }, [notice, noticeAutoClearBot, state.threads, state.bots])

  // 「中心正在启动」自动恢复（D07 第 12 条）：每 2 秒重拉一次全部视图，成功即停；
  // 引擎启动失败时显示失败原因（downMessage），不再停在「正在启动」。
  useEffect(() => {
    if (!state.connectionDown || state.downReason !== 'starting') return
    const timer = setInterval(() => {
      void hub.refreshAll().catch(() => undefined)
      void hub.refreshSettings().catch(() => undefined)
    }, 2_000)
    return () => clearInterval(timer)
  }, [hub, state.connectionDown, state.downReason])

  // 打开「待你处理」：普通入口不聚焦；从办公室门口点具体一张卡时带上 inboxId（F04）。
  const openInbox = (inboxId?: string): void => {
    setFocusInboxId(inboxId ?? null)
    hub.setView('inbox')
    void hub.refreshInbox()
  }

  /**
   * 原来跳到右栏「为什么醒」的入口（项目页任务行、办公室）统一落到这里（P64）：
   * 右侧边栏不再放账本，改去动态页，并替主人筛好这位队友，打开就能看到它最近醒了几次、做了什么。
   */
  const openActivityFor = (botId: string): void => {
    setActivityBotId(botId)
    hub.setView('activity')
    void hub.refreshActivity()
  }

  /** 右侧边栏点一件事：有主题就进那条讨论，没有主题的老事务去它所在的项目页。 */
  const openWorkSession = (session: WorkSession): void => {
    if (session.topicId !== null) hub.selectThread(session.topicId)
    else hub.requestProject(session.projectId)
  }

  /**
   * 左栏队友行加号的「新建会话」（P63）：开一个主题并进去。
   * 项目页「新开会话」和项目行加号从 P60（2026-11-10）起改走草稿主题，见下面的 TopicDraftPane。
   */
  const createSession = (input: NewSessionInput): Promise<string | null> => openNewTopic(hub, input.projectId, input.text)

  /** 删除已归档员工：成功后刷新总览、项目与办公室，失败把中文错误交回弹窗。（P73f：归档改在编辑员工弹窗里做。） */
  const runBotArchiveCommand = async (name: string, botId: string): Promise<string | null> => {
    try {
      const result = await hub.command(name, { botId })
      if (!result.ok) return result.error
      await Promise.all([hub.refreshOverview(), hub.refreshProject(), hub.refreshOffice()])
      return null
    } catch (e) {
      return e instanceof Error ? e.message : String(e)
    }
  }

  const overviewLoading = overview === null
  const showSkeleton = useSlowLoading(overviewLoading || (view === 'main' && state.threads[selectedThread] === undefined && !threadError))

  // 收件箱/线程卡片上的操作（D06 第 4 条）：按 cardSubmission 分流——审批卡用
  // approvalId 走 decideApproval（绝不把 inboxId 当 approvalId），其他卡走 answerInbox。
  // 卡片作答（D07 第 11 条）：失败要把原因返回给卡片显示（按钮恢复可点），不再只进 console。
  /**
   * P75k：记忆命令（「已记住」行的撤销，记忆页的更正、删除、撤销删除）的统一执行：成功后重取记忆页、当前线程（「已记住」行改字）
   * 和总览（左栏与总管右侧栏的条数）；失败把原因交回那一行显示，按钮复位。
   */
  const runMemoryCommand = async (name: string, input: Record<string, unknown>): Promise<string | null> => {
    try {
      const result = await hub.command(name, input)
      if (!result.ok) return result.error
      await Promise.all([hub.refreshMemory(), hub.refreshThread(selectedThread), hub.refreshOverview()])
      return null
    } catch (e) {
      return e instanceof Error ? e.message : String(e)
    }
  }
  const cardActions: CardActions = {
    // P75k：「已记住」「已删除」「已更正」行上的「撤销」，按动作选命令（undoMemory、undoDeleteMemory、undoCorrectMemory）。
    onUndoMemory: note => runMemoryCommand(undoCommandOf(note), { memoryId: note.memoryId }),
    // P75k：约定卡已定事项的出处点开记忆页并定位到那一条。
    onOpenMemory: memoryId => hub.requestMemory(memoryId),
    onPick: async (card, option, note) => {
      setBusyInboxId(card.inboxId)
      try {
        const submission = cardSubmission(card, option, note)
        if ('error' in submission) return submission.error
        const result = await hub.command(submission.name, submission.input)
        if (!result.ok) return result.error
        await Promise.all([hub.refreshInbox(), hub.refreshOverview()])
        return null
      } catch (e) {
        return e instanceof Error ? e.message : String(e)
      } finally { setBusyInboxId(null) }
    },
    // P72：约定卡上点「定了」。命令名和入参（agreementId、version、choices）由 core 校验；
    // 成功后刷新当前线程、总览、待你处理和项目（主题第一层也要变成「已固定」）。失败把原因交回卡片显示。
    onConfirmAgreement: async (agreementId, version, choices) => {
      try {
        const result = await hub.command('confirmAgreement', { agreementId, version, choices })
        if (!result.ok) return result.error
        await Promise.all([hub.refreshThread(selectedThread), hub.refreshInbox(), hub.refreshOverview(), hub.refreshProject()])
        return null
      } catch (e) {
        return e instanceof Error ? e.message : String(e)
      }
    },
    // P73e：三问卡回答、组队卡编辑与确认、第二问的选择文件夹。接线集中在 logic/team-actions.ts。
    ...teamCardActions(hub, () => selectedThread, props.clientCtx),
  }

  // 线程头部信息：主题用主题名，队友用名册里的名片，名册里查不到时用线程标题兜底。
  const header: ThreadHeaderInfo | null = topicInfo !== null ? {
    name: topicInfo.title, roleLabel: null, activityText: null, nextThinkText: null, staffStatus: null, thinking: false,
  } : selectedBot ? {
    name: selectedBot.name,
    roleLabel: displayRoleLabel(selectedBot),
    activityText: selectedBot.activityText,
    nextThinkText: selectedBot.nextThinkText,
    staffStatus: selectedBot.staffStatus,
    thinking: selectedBot.activity === 'thinking',
  } : { name: state.threads[selectedThread]?.title ?? '员工', roleLabel: null, activityText: null, nextThinkText: null, staffStatus: null, thinking: false }

  // 打断当前回合（D06 第 2 条）：interruptBot 经路由命令交给 core（取消、线程消息
  // 与感知恢复都由 core 完成），插件不再自己 cancel 或写系统消息。
  const interrupt = (): void => {
    if (!selectedBot) return
    void (async () => {
      const result = await hub.command('interruptBot', { botId: selectedBot.id })
      setNotice(result.ok ? '已打断。下次唤醒时继续。' : result.error)
      await Promise.all([hub.refreshThread(selectedBot.id), hub.refreshOverview()])
    })()
  }

  // 「打开工作会话」与暂停/恢复（线程头部；sessionId 在详情视图里）。
  const openSession = (): void => {
    const sessionId = selectedBot ? state.bots[selectedBot.id]?.profile.sessionId : null
    if (!sessionId) { setNotice('工作会话打开失败。请确认会话仍存在。'); return }
    const result = openBotSessionWith(props.clientCtx, sessionId)
    setNotice(OPEN_SESSION_HINTS[result])
  }
  const togglePause = (): void => {
    if (!selectedBot) return
    // P73f：线程头部的快捷按钮只有「停用」「恢复在岗」，走 lifecycleAction 的 suspend、reinstate，动作由纯函数按状态选。
    const picked = headerStatusAction(selectedBot.staffStatus)
    if (picked === null) return
    const action = picked
    void (async () => {
      const result = await hub.command('lifecycleAction', { botId: selectedBot.id, action })
      setNotice(result.ok ? STATUS_OK_TEXT[action] : result.error)
      await Promise.all([hub.refreshOverview(), hub.refreshBot(selectedBot.id)])
    })()
  }

  // 设置页保存与全体暂停/恢复。
  const saveSettings = async (patch: Record<string, unknown>): Promise<string | null> => {
    const result = await hub.command('updateSettings', patch)
    if (result.ok) await hub.refreshSettings()
    return result.ok ? null : result.error
  }
  // P38 知识库连接自检：只读、不落设置；失败把命令错误文案交页面展示。
  const testKnowledgeConnection = async (config: Record<string, unknown>): Promise<KnowledgeConnectionState | string> => {
    const result = await hub.command('testKnowledgeConnection', config)
    if (result.ok && result.data) return result.data as KnowledgeConnectionState
    return result.ok ? '自检无返回结果。请稍后重试；仍失败请检查知识库连接配置。' : result.error
  }
  const lifecycleAll = async (action: 'suspend' | 'reinstate'): Promise<string | null> => {
    if (!overview) return '总览读取失败。请稍后重试；仍失败请检查 DSH 运行状态。'
    // P73f：目标选取是纯函数（staffAllTargets）：全部停用只动在岗的，全部恢复在岗只动停用的，按 staffStatus 选。
    const targets = staffAllTargets(overview.bots, action).map(id => overview.bots.find(b => b.id === id)!)
    let failed = 0
    for (const bot of targets) {
      // 全部停用、全部恢复在岗同样走 lifecycleAction（逐个执行，失败只计数）。
      const result = await hub.command('lifecycleAction', { botId: bot.id, action })
      if (!result.ok) failed += 1
    }
    await hub.refreshOverview()
    return failed === 0 ? null : `有 ${failed} 位员工操作未成功。请重试，或在对话页点「查看状态」后用「编辑员工」单独操作；仍失败请检查 DSH 运行状态。`
  }

  /**
   * ⌘K / Ctrl+K 打开或收起跳转面板（WCAG 2.4.5）。
   * 用 window 级监听而不是给某个按钮绑快捷键，保证主人在任何视图里都能叫出面板；
   * 回调包 try/catch，异常只影响这一次快捷键，不影响宿主。
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      try {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
          event.preventDefault()
          setPaletteOpen(open => !open)
        }
      } catch {
        // 快捷键处理失败不冒泡到宿主；下一次按键仍可正常使用。
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  /**
   * 跳转面板选了一个页面：切视图并拉对应表面，和左栏入口同口径。
   * 动态页从这里进是看全队，把之前替主人筛的队友清掉。
   */
  const handlePaletteNavigate = (target: PageView): void => {
    setActivityBotId(null)
    if (target === 'main') { hub.setView('main'); return }
    if (target === 'inbox') { openInbox(); return }
    hub.setView(target)
    if (target === 'office') void hub.refreshOffice()
    else if (target === 'resource') void hub.refreshResource()
    else if (target === 'project') void hub.refreshProject()
    else if (target === 'activity') void hub.refreshActivity()
    else if (target === 'settings') void hub.refreshSettings()
  }

  /** 跳转面板选了一个动作：只做面板里列出的两件小事，不悄悄扩成第二个设置页。 */
  const handlePaletteAction = (action: CommandActionId): void => {
    if (action === 'new-bot') {
      setWizardOpen(true)
      return
    }
    void hub.refreshAll()
    void hub.refreshSettings()
  }

  if (state.connectionDown) {
    // D05 第 13 条：停用与启动中给对应提示（含恢复办法），不要一律说「连不上」。
    const hint = state.downReason === 'disabled'
      ? '中心已停用：删除 ~/AgentHub/.hub/DISABLED 后重启 DSH 即可恢复。'
      : state.downReason === 'starting'
        ? '中心正在启动，稍后自动恢复。'
        : state.downReason === 'failed'
          ? `中心启动失败：${state.downMessage ?? '原因未知，请查看 DSH 日志'}。请修复后重启 DSH；仍失败请检查 DSH 日志。`
          : 'Agent 中心连接失败（插件可能停用或在重载）。点击「重试」；仍失败请检查 DSH 运行状态。'
    return (
      <div className="ah-page ah-page-down" data-plugin-page="agent-hub">
        <div className="ah-down">
          <p>{hint}</p>
          <button type="button" className="ah-btn" onClick={() => void hub.refreshAll()}>重试</button>
        </div>
      </div>
    )
  }

  return (
    <div className="ah-page" data-plugin-page="agent-hub">
      {/* WCAG 2.4.1 跳过区块：键盘用户进插件第一站就是它，激活后焦点直接落正文，
          不用每页 Tab 穿过整组顶栏；视觉上隐藏，聚焦时才出现在左上角。 */}
      <a
        className="ah-skip-link"
        href="#ah-main"
        onClick={(event) => {
          event.preventDefault()
          document.getElementById('ah-main')?.focus()
        }}
      >跳到主内容</a>
      {overview ? (
        <BlockBoundary label="顶栏">
          <TopBar overview={overview} />
        </BlockBoundary>
      ) : showSkeleton ? <header className="ah-topbar"><Skeleton rows={1} /></header> : null}

      {/* 建队友 + 存色的两步编排见 logic/wizard-create（createBot → updateBot color）。 */}
      {wizardOpen && overview ? (
        <BlockBoundary label="新建员工">
          <NewBotWizard
            existingBots={overview.bots}
            modelOptions={state.settings?.modelOptions ?? []}
            modelOptionsError={state.settings ? null : state.settingsError}
            // P73e：轻档是否可用（目录里有轻量模型）；模板卡片底部据此写档位，规则与 core 组队卡同一份（modelTiers）。
            lightAvailable={modelTiers(
              (state.settings?.modelOptions ?? []).flatMap(option => option.value === null ? [] : [{ provider: option.value.provider, model: option.value.model, label: option.label }]),
              state.settings?.settings.defaultModel ?? null,
            ).lightAvailable}
            presetSkillOptions={state.settings?.presetSkillOptions ?? []}
            dshSkillOptions={state.settings?.dshSkillOptions ?? []}
            onCreate={input => createTeammate(hub, input)}
            // P52：传完整名册（含退役和归档），名字被占时要能自动加序号。
            onCreateFromTemplates={templates => addTeammatesFromTemplates(hub, templates, overview.bots)}
            onOpenThread={(botId, warning) => {
              setWizardOpen(false)
              hub.selectThread(botId)
              // 提示条改放线程顶部（D04 3c-3），该机器人第一次交账（线程出现 reply）后自动消失。
              // P72h H3：新建员工不再自动试跑，没有「正在试跑」提示；只有创建时带了警告才显示警告本身。
              if (warning) {
                setNotice(warning)
                setNoticeAutoClearBot(botId)
              }
              void hub.refreshOverview()
            }}
            onClose={() => setWizardOpen(false)}
          />
        </BlockBoundary>
      ) : null}

      {/* 跳过链接的落点：tabIndex=-1 让容器可被编程聚焦但不进 Tab 环；
          地标由宿主/预览壳的 main 承担，这里不重复声明 role=main。 */}
      <div
        id="ah-main"
        tabIndex={-1}
        className={`ah-body${rightOpen && selectedBot && view === 'main' ? ' ah-body-right' : ''}`}
      >
        {!props.sidebarInHost && overview ? (
          <BlockBoundary label="团队空间左栏">
            <TeamSidebarNav
              overview={overview}
              project={state.project}
              view={state.view}
              // P60：草稿主题摆在中栏时左栏哪一行都不亮。
              selectedThread={sidebarSelectedThread(state)}
              activeProjectId={view === 'project' ? state.activeProjectId : null}
              onOpenOffice={() => { hub.setView('office'); void hub.refreshOffice() }}
              // 点队友直接进对话（P64）；团队全景已在 P71 下线。
              onSelectBot={threadId => hub.selectThread(threadId)}
              onOpenInbox={() => openInbox()}
              onOpenSettings={() => { hub.setView('settings'); void hub.refreshSettings() }}
              onNewBot={() => setWizardOpen(true)}
              onNewProject={() => {
                // 与宿主侧栏加号同一条路径：切到项目页 + 发一次打开表单的请求。
                hub.setView('project')
                void hub.refreshProject()
                hub.requestNewProject()
              }}
              onRetryProject={() => hub.refreshProject()}
              onOpenProject={(projectId) => {
                // P1：带上被点的项目 id，项目页据此定位并高亮对应项目。
                hub.requestProject(projectId)
                void hub.refreshProject()
              }}
              onOpenTopic={topicId => hub.selectThread(topicId)}
              onCreateSession={createSession}
              onOpenTopicDraft={projectId => hub.openTopicDraft(projectId)}
              onDeleteArchivedBot={botId => runBotArchiveCommand('deleteArchivedBot', botId)}
            />
          </BlockBoundary>
        ) : !props.sidebarInHost && showSkeleton ? <Skeleton rows={6} /> : null}

        {view === 'office' ? (
          <BlockBoundary label="办公室">
            <OfficeReplayPage
              run={hub.command}
              office={state.office}
              loading={state.office === null}
              // P76k：午休牌与窗口弧读额度窗口视图（总览里 core 已给）；休息时段按设置时区写在牌上。
              quotaWindow={overview?.quota?.window ?? null}
              timezone={state.settings?.settings?.timezone}
              onNewBot={() => setWizardOpen(true)}
              onRetry={() => void hub.refreshOffice()}
              onOpenBot={(botId, wakeId) => {
                // P64：账本和产物都不在右侧边栏了。点账本去动态页看记录，其余直接进和它的对话。
                if (wakeId) openActivityFor(botId)
                else hub.selectThread(botId)
              }}
              onOpenInbox={openInbox}
              loadTrail={botId => hub.wakeRows(botId)}
            />
          </BlockBoundary>
        ) : view === 'project' ? (
          <BlockBoundary label="项目">
            <ProjectPage
              project={state.project}
              loading={state.project === null}
              onRetry={() => void hub.refreshProject()}
              run={(name, input) => hub.command(name, input)}
              onRefresh={() => hub.refreshProject()}
              bots={overview ? overview.bots.map(b => ({ id: b.id, name: b.name, lifecycle: b.lifecycle, role: b.role })) : []}
              botsLoaded={overview !== null}
              selectedProjectId={state.activeProjectId}
              onSelectProject={projectId => hub.requestProject(projectId)}
              onOpenTopic={topicId => hub.selectThread(topicId)}
              onNewTopic={projectId => hub.openTopicDraft(projectId)}
              openNewProject={pendingNewProject}
              onNewProjectOpened={() => setPendingNewProject(false)}
              onProjectSaved={(projectId) => {
                // 新建成功后左栏立刻选中它，主人一眼看到刚建的项目。
                setPendingNewProject(false)
                hub.setActiveProject(projectId)
              }}
            />
          </BlockBoundary>
        ) : view === 'inbox' ? (
          <BlockBoundary label="收件箱">
            <InboxPane
              inbox={state.inbox}
              loading={state.inbox === null}
              error={null}
              onRetry={() => void hub.refreshInbox()}
              actions={cardActions}
              busyId={busyInboxId}
              onOpenThread={(id, agreementId) => { setInboxReturnThread(id); setFocusAgreementId(agreementId ?? null); hub.selectThread(id) }}
              focusInboxId={focusInboxId}
              // P79：「要修改」「有不符」「都不合适」写的那句话，走对话输入框发消息用的同一条路径（hub.send），
              // 失败把原因交回条目显示（草稿保留）。
              onSendMessage={async (threadId, text) => {
                try {
                  await hub.send(threadId, text)
                  return null
                } catch (e) {
                  return e instanceof Error ? e.message : String(e)
                }
              }}
            />
          </BlockBoundary>
        ) : view === 'activity' ? (
          <BlockBoundary label="活动流">
            <ActivityPane
              key={activityBotId ?? 'all'}
              initialBotId={activityBotId}
              activity={state.activity}
              bots={overview?.bots ?? []}
              error={state.activityError}
              onRetry={() => void hub.refreshActivity()}
              onLoadMore={() => {
                const last = state.activity?.rows.at(-1)?.id
                if (last) void hub.refreshActivity(last)
              }}
            />
          </BlockBoundary>
        ) : view === 'settings' || view === 'resource' || view === 'memory' ? (
          <BlockBoundary label="设置">
            <SettingsPane
              settings={state.settings}
              loadError={state.settingsError}
              overview={overview}
              weeklyUsage={state.weeklyUsage}
              weeklyUsageError={state.weeklyUsageError}
              onRetryWeeklyUsage={() => void hub.refreshWeeklyUsage()}
              loading={state.settings === null}
              onRetry={() => void hub.refreshSettings()}
              onRetryOverview={() => void hub.refreshOverview()}
              onSave={saveSettings}
              onPauseAll={() => lifecycleAll('suspend')}
              onResumeAll={() => lifecycleAll('reinstate')}
              onTestKnowledge={testKnowledgeConnection}
              // P86：内部视图 memory（约定卡出处跳转、从上次页面状态恢复）也落在设置页，直接选中「关于你的记忆」分区。
              requestedSection={settingsSectionOfView(view) ?? null}
              onOpenSection={id => {
                if (id === 'resources') void hub.refreshResource()
                if (id === 'memory') {
                  // 点导航进记忆分区：页面状态切到 memory（重新取一次视图）；已经在这一分区时只重取。
                  if (view === 'memory') void hub.refreshMemory()
                  else hub.requestMemory()
                } else if (view === 'memory') {
                  // 离开记忆分区：页面状态退回普通设置页，之后再有跳转请求时才能重新选中记忆分区。
                  hub.setView('settings')
                }
              }}
              memory={(
                <BlockBoundary label="关于你的记忆">
                  <MemoryPage
                    page={state.memoryPage}
                    error={state.memoryError}
                    onRetry={() => void hub.refreshMemory()}
                    focusMemoryId={state.memoryFocusId}
                    onFocusDone={() => hub.clearMemoryFocus()}
                    commands={{
                      correct: (memoryId, text) => runMemoryCommand('correctMemory', { memoryId, text }),
                      remove: memoryId => runMemoryCommand('deleteMemory', { memoryId }),
                      undoDelete: memoryId => runMemoryCommand('undoDeleteMemory', { memoryId }),
                      // 项目背景、项目页决策：点「去项目页」打开对应项目页（与左栏点项目行同一条路径）。
                      openProject: projectId => { hub.requestProject(projectId); void hub.refreshProject() },
                    }}
                  />
                </BlockBoundary>
              )}
              resources={(
                <ResourcePage
                  resource={state.resource}
                  loading={state.resource === null}
                  onRetry={() => void hub.refreshResource()}
                  run={(name, input) => hub.command(name, input)}
                  onRefresh={() => hub.refreshResource()}
                  bots={overview ? overview.bots.map(b => ({ id: b.id, name: b.name, lifecycle: b.lifecycle })) : []}
                />
              )}
            />
          </BlockBoundary>
        ) : topicDraft !== null ? (
          // P60：项目里「新开会话」的空聊天。key 带打开序号，再点一次就是一张全新的白纸。
          <BlockBoundary label="新会话">
            <TopicDraftPane
              key={topicDraftThreadId(topicDraft)}
              draft={topicDraft}
              project={state.project}
              bots={overview?.bots ?? []}
              onSendFirst={(projectId, text) => sendDraftFirstMessage(hub, projectId, text)}
            />
          </BlockBoundary>
        ) : (
          <BlockBoundary label="对话线程">
            <ThreadPane
              key={selectedThread}
              threadId={selectedThread}
              thread={state.threads[selectedThread] ?? null}
              loading={state.threads[selectedThread] === undefined}
              header={header}
              inputPlaceholderName={state.threads[selectedThread]?.title ?? '员工'}
              chiefEntry={topicInfo === null && selectedBot !== null && isChiefEntry(selectedBot)}
              banner={notice}
              onBannerDismiss={() => { setNotice(null); setNoticeAutoClearBot(null) }}
              onLoadEarlier={() => {
                const t = state.threads[selectedThread]
                if (t?.hasMore && t.oldestId) void hub.refreshThread(selectedThread, t.oldestId)
              }}
              onSend={(text) => hub.send(selectedThread, text)}
              actions={cardActions}
              busyInboxId={busyInboxId}
              onRetry={() => void hub.refreshThread(selectedThread)}
              error={threadError}
              onOpenSession={openSession}
              onTogglePause={togglePause}
              onInterrupt={interrupt}
              rightCollapsed={view === 'main' && !rightOpen && selectedBot !== null}
              onExpandRight={() => setRightOpen(true)}
              onEditStaff={() => { if (selectedBot !== null) openEditStaff(selectedBot.id) }}
              focusAgreementId={inboxReturnThread === selectedThread ? focusAgreementId : null}
              fromInbox={inboxReturnThread === selectedThread}
              onBackToInbox={() => openInbox()}
              topic={topicInfo}
              onDismissAway={() => dismissAway(selectedThread)}
            />
          </BlockBoundary>
        )}
        {/* 窄屏抽屉的遮罩：宽屏由 CSS 隐藏；点一下就把侧边栏收起。 */}
        {view === 'main' && rightOpen && selectedBot ? (
          <div className="ah-right-scrim" aria-hidden="true" onClick={() => setRightOpen(false)} />
        ) : null}
        {view === 'main' && rightOpen && selectedBot && overview ? (
          <BlockBoundary label="员工侧边栏">
            <RightPanel
              key={selectedBot?.id ?? 'none'}
              card={selectedBot}
              detail={state.bots[selectedBot.id] ?? null}
              // P75j：技能库一栏的视图随员工详情一起取，取失败只记在这一栏里，点「重试」重新取。
              skillLibrary={state.skillLibraries[selectedBot.id] ?? null}
              skillLibraryError={state.skillLibraryErrors[selectedBot.id] ?? null}
              onRetrySkillLibrary={() => { void hub.refreshSkillLibrary(selectedBot.id) }}
              light={overview.quota.light}
              costs={overview.costs}
              sessions={selectedSessions}
              onOpenSession={openWorkSession}
              // P76j：「在办的事」读 core 的视图（旧宿主没有这条路由时保持 null，右栏退回工作会话列表）。
              activeJobs={state.activeJobs[selectedBot.id] ?? null}
              onOpenJob={(topicId: string) => hub.selectThread(topicId)}
              // 本窗口额度只在总管有；旧宿主与旧样例没有 quota.window，整栏不画。
              quotaWindow={selectedBot.role === 'chief' ? overview.quota.window ?? null : null}
              onOpenActivity={() => handlePaletteNavigate('activity')}
              onCollapse={() => setRightOpen(false)}
              // P74i-m3（第 2 节）：从右栏（窄屏时是抽屉）点「编辑员工」，先收起抽屉再打开弹窗。
              // 抽屉开着时会把 .ah-body 里除自己和遮罩外的全部子节点设为不可操作，而编辑弹窗的遮罩
              // 也是 .ah-body 的子节点，会被一起设成不可操作，弹窗出现却点不动；关掉弹窗后不重新打开抽屉。
              onEdit={() => { openEditStaff(selectedBot.id); setRightOpen(false) }}
              // P73f：「模型与额度」一行写档位（标准档、轻档）；档位对应哪个模型由模型目录和默认模型算出（modelTiers，与组队卡同一份规则）。
              // 设置还没读到时不传，一行里改写模型显示名，不猜档位。
              tiers={state.settings === null ? null : modelTiers(
                state.settings.modelOptions.flatMap(option => option.value === null ? [] : [{ provider: option.value.provider, model: option.value.model, label: option.label }]),
                state.settings.settings.defaultModel ?? null,
              )}
            />
          </BlockBoundary>
        ) : null}
        {/* P78：「编辑员工」弹窗只此一份，右侧栏底部按钮和对话页「更多」里的入口都把 editStaffId 置位；
            不依赖右侧栏是否展开。editStaffId 记的是员工 id，切到别的员工时自然不再匹配，不会把弹窗带过去。 */}
        {view === 'main' && selectedBot && overview ? (
          <BlockBoundary label="编辑员工">
            <TeammateEditHost
              key={selectedBot.id}
              open={editStaffId === selectedBot.id}
              detail={state.bots[selectedBot.id] ?? null}
              roster={overview.bots}
              modelOptions={state.settings?.modelOptions ?? []}
              modelOptionsError={state.settings ? null : state.settingsError}
              onRetrySettings={() => void hub.refreshSettings()}
              presetSkillOptions={state.settings?.presetSkillOptions ?? []}
              dshSkillOptions={state.settings?.dshSkillOptions ?? []}
              run={(name, input) => hub.command(name, input)}
              onRefresh={() => { void hub.refreshBot(selectedBot.id); void hub.refreshOverview() }}
              onClose={() => setEditStaffId(null)}
            />
          </BlockBoundary>
        ) : null}
        {/* W12：卡片上点 md 时，页面最右边的文件预览侧栏（与 DSH 自带的文件预览同一个样子）。 */}
        <BlockBoundary label="文件预览">
          <FilePreviewPane />
        </BlockBoundary>
      </div>

      {/* 跳转面板：打开时才挂载——useDialogFocus 要在挂载渲染期抓住触发钮用于还焦；
          关闭即卸载，页面里没有它的任何节点，不占常驻布局。 */}
      {paletteOpen ? (
        <CommandPalette
          open
          onClose={() => setPaletteOpen(false)}
          onNavigate={handlePaletteNavigate}
          onAction={handlePaletteAction}
        />
      ) : null}
    </div>
  )
}

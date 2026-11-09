/**
 * 队友主页：像聊天软件的三栏页面——左队友列表、中对话线程/收件箱/活动流/设置、右详情（可收起）。
 * 数据全部来自 HubStore（唯一仓库）；加载超过 300ms 显示骨架；宿主连不上整页提示；
 * 每个页面块外包 BlockBoundary（出错只显示「这块没显示出来，刷新试试」）。
 */
import { useEffect, useState, type ReactNode } from 'react'
import type { KnowledgeConnectionState } from '@agent-hub/core'
import type { HubStore, PageView } from '../hub-state.js'
import { createStore, useStore, type Store } from '../store.js'
import { TopBar } from '../components/TopBar.js'
import { CommandPalette } from '../components/command-palette.js'
import type { CommandActionId } from '../logic/command-palette.js'
import { TeamSidebarNav, type NewSessionInput } from '../components/team-sidebar-nav.js'
import type { ArchiveCheckInfo } from '../components/bot-archive-dialog.js'
import { ThreadPane, type ThreadHeaderInfo } from '../components/ThreadPane.js'
import { RightPanel } from '../components/RightPanel.js'
import { InboxPane } from '../components/InboxPane.js'
import { ActivityPane } from '../components/ActivityPane.js'
import { SettingsPane } from '../components/SettingsPane.js'
import { OfficeReplayPage } from './office-replay-page.js'
import { ResourcePage } from './ResourcePage.js'
import { ProjectPage } from './ProjectPage.js'
import { TeammateHomePage } from './TeammateHomePage.js'
import { addTeammatesFromTemplates, createTeammate } from '../logic/wizard-create.js'
import { NewBotWizard } from '../components/NewBotWizard.js'
import { TeachDialog } from '../components/TeachDialog.js'
import { FirstTeammate } from '../components/office-start.js'
import { BlockBoundary } from '../components/ErrorBoundary.js'
import { Skeleton } from '../components/Ui.js'
import type { CardActions } from '../components/Cards.js'
import { cardSubmission } from '../logic/cards.js'
import { OPEN_SESSION_HINTS, openBotSessionWith } from '../logic/thread.js'
import { lifecycleAllTargets, pauseResumeAction } from '../logic/lifecycle.js'
import { collectWorkSessions, sessionsForBot, type WorkSession } from '../logic/work-session.js'
import type { WorkBoardCard } from '../logic/work-board.js'
import { mentionMembers } from '../logic/mentions.js'

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
  const [rightOpen, setRightOpen] = useState(false)
  const [busyInboxId, setBusyInboxId] = useState<string | null>(null)
  const [threadError, setThreadError] = useState<string | null>(null)
  const [wizardOpen, setWizardOpen] = useState(false)
  const [teachOpen, setTeachOpen] = useState(false)
  /** 跳转面板（WCAG 2.4.5）：打开时覆盖在页面上，关闭后不渲染、不占布局。 */
  const [paletteOpen, setPaletteOpen] = useState(false)
  /** 当前线程是否是从收件箱跳转来的：决定头部是否显示「返回收件箱」。 */
  const [fromInbox, setFromInbox] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  /** 试跑提示归属的机器人：它的线程里出现第一条回复后自动消失（D04 3c-3）。 */
  const [noticeAutoClearBot, setNoticeAutoClearBot] = useState<string | null>(null)
  /** 从办公室桌上产出下钻时要展开的账本 id（F03）：只对当前打开的队友生效。 */
  const [focusWakeId, setFocusWakeId] = useState<string | null>(null)
  /** 从办公室桌上产物下钻时要展开的产物头 id（F08）：右栏自动选中并读取最新一版。 */
  const [focusArtifactId, setFocusArtifactId] = useState<string | null>(null)
  /** 从办公室门口点进来时要聚焦的收件箱卡（F04）；普通进入收件箱为 null。 */
  const [focusInboxId, setFocusInboxId] = useState<string | null>(null)
  /** 当前线程是否从队友主页的工作会话进入（P33）：线程头显示「返回队友主页」。 */
  const [fromHome, setFromHome] = useState(false)
  /** 当前项目会话属于哪个项目（P37）：决定输入框是否出现 @ 与候选成员。 */
  const [mentionProjectId, setMentionProjectId] = useState<string | null>(null)
  /** 队友主页上的一次性提示（交账结果等）；切换队友或进入线程即清空。 */
  const [homeNotice, setHomeNotice] = useState<string | null>(null)
  /** 正在交账的工作会话 id：只禁用那一行的按钮。 */
  const [homeBusyTaskId, setHomeBusyTaskId] = useState<string | null>(null)
  /**
   * 当前线程里正在看哪条工作会话（P1-2）：侧栏子行和队友主页都带任务 id 进来，
   * 线程头据此显示这条会话的标题与状态——同一队友同项目的两条子行才不会看起来一样。
   */
  const [openedTaskId, setOpenedTaskId] = useState<string | null>(null)

  const selectedThread = state.selectedThread
  const view = state.view
  /** 主视图表面（P33）：对话线程或队友主页；放在仓库里，左栏与宿主侧栏共用。 */
  const mainFace = state.mainFace

  // 首次挂载拉全部基础视图；此后由 SSE changed 事件驱动刷新。
  useEffect(() => {
    void hub.refreshAll()
    void hub.refreshSettings()
  }, [hub])
  useEffect(() => {
    if (state.connectionDown) return
    setThreadError(null)
    void hub.refreshThread(selectedThread).catch(() => setThreadError('线程读取失败。点击「重试」；仍失败请确认插件未停用。'))
  }, [hub, selectedThread, state.connectionDown])

  // P43：提示点进来时，外层先记下目标收件箱项、再切队友模式打开中心页；
  // 页面挂载（或已在页内）后消费一次：切到收件箱、定位并描边那一项，然后清空。
  // 清空是必须的——否则之后每次重挂载都会被同一条旧目标拽回收件箱。
  const inboxFocusStore = props.inboxFocus ?? EMPTY_INBOX_FOCUS
  const pendingInboxFocus = useStore(inboxFocusStore)
  useEffect(() => {
    if (pendingInboxFocus === null) return
    setFromInbox(false)
    setFocusInboxId(pendingInboxFocus)
    hub.setView('inbox')
    void hub.refreshInbox()
    inboxFocusStore.set(null)
  }, [hub, inboxFocusStore, pendingInboxFocus])

  // P44：左栏点开一条工作会话。侧栏只负责写信号（选中线程已在仓库里切好），
  // 页面负责把「返回队友主页」、项目 @ 上下文、右栏账本展开这几件本地状态补齐，
  // 然后清空信号，避免重挂载时又被旧目标拽回同一条线程。
  const sessionOpen = state.sessionOpen
  useEffect(() => {
    if (sessionOpen === null) return
    setFromInbox(false)
    setFromHome(true)
    setMentionProjectId(sessionOpen.projectId)
    setHomeNotice(null)
    setFocusArtifactId(null)
    setOpenedTaskId(sessionOpen.taskId)
    setFocusWakeId(sessionOpen.wakeId)
    setRightOpen(sessionOpen.wakeId !== null)
    hub.clearWorkSession()
  }, [hub, sessionOpen])

  // P37：宿主一级侧栏的「新建队友」加号把请求写进仓库计数；有没处理的请求就开向导。
  // P53：接住后立刻清零，不再用 ref 记「挂载时的值」。主人在别的页面点加号时，
  // 请求比本页挂载还早，原来的写法把它当成历史吞掉，只切了页面、弹窗不出现。
  const newBotRequest = state.newBotRequest
  useEffect(() => {
    if (newBotRequest === 0) return
    hub.clearNewBotRequest()
    setFromInbox(false)
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
    setFromInbox(false)
    setPendingNewProject(true)
  }, [hub, newProjectRequest])

  // 选中机器人时拉它的详情；打开教学时拉最近会话。
  const overview = state.overview
  const selectedBot = overview?.bots.find(b => b.id === selectedThread) ?? null
  useEffect(() => {
    if (selectedBot && !state.bots[selectedBot.id]) void hub.refreshBot(selectedBot.id)
  }, [hub, selectedBot, state.bots])
  useEffect(() => {
    if (teachOpen) void hub.refreshRecentSessions()
  }, [hub, teachOpen])

  // 回到队友主页就清掉「从主页进入线程」的标记，避免以后进别的线程时还挂着回程钮。
  useEffect(() => {
    if (mainFace === 'home') setFromHome(false)
  }, [mainFace])

  // 工作会话投影（P33）：项目视图还没到时不假装没有工作，页面显示骨架与重试。
  const workSessions = state.project === null ? null : collectWorkSessions(state.project)
  const selectedSessions = selectedBot !== null && workSessions !== null
    ? sessionsForBot(workSessions, selectedBot.id)
    : null
  /**
   * 线程头要显示的当前工作会话（P1-2）：只认从工作会话入口进来的那一次，
   * 任务被交账/改状态后查不到就自然不显示，不拿旧标题冒充。
   */
  const openedTask = fromHome && openedTaskId !== null && workSessions !== null
    ? workSessions.find(session => session.id === openedTaskId) ?? null
    : null

  /**
   * @ 上下文（P37）：只有「从项目工作会话进入、且还停在那条线程」时才成立。
   * 从普通入口或左栏直接进线程都会清掉 fromHome，所以私聊里永远不会有 @。
   */
  const mentionRow = fromHome && mentionProjectId !== null && state.project !== null
    ? state.project.projects.find(row => row.project.id === mentionProjectId) ?? null
    : null
  const mention = mentionRow !== null && selectedThread !== 'team'
    ? { projectName: mentionRow.project.name, members: mentionMembers(mentionRow, overview?.bots ?? [], selectedThread) }
    : null

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
    setFromInbox(false)
    setFromHome(false)
    setMentionProjectId(null)
    setOpenedTaskId(null)
    setFocusInboxId(inboxId ?? null)
    hub.setView('inbox')
    void hub.refreshInbox()
  }

  /**
   * 从项目页任务行下钻到项目引用的那次唤醒（F08 尾巴）：切到队友线程、展开右栏，
   * 右栏的账本区会按 focusWakeId 直接展开这次唤醒；不在最近 50 条里时按 wakeId 单独拉详情。
   */
  const openWake = (botId: string, wakeId: string): void => {
    setFromInbox(false)
    setFromHome(false)
    setMentionProjectId(null)
    setOpenedTaskId(null)
    setFocusWakeId(wakeId)
    setFocusArtifactId(null)
    setRightOpen(true)
    hub.setView('main')
    hub.selectThread(botId)
  }

  /**
   * 打开一条工作会话（P33）：进入该队友的线程，头部给「返回队友主页」；
   * 有最近一次唤醒就顺手展开右栏账本，让主人直接看到这次工作的证据。
   */
  const openWorkSession = (session: WorkSession): void => {
    setFromInbox(false)
    setFromHome(true)
    // 项目会话才有 @（P37）：记下项目，输入框按项目成员给出候选。
    setMentionProjectId(session.projectId)
    setHomeNotice(null)
    setFocusArtifactId(null)
    // P1-2：带上任务 id，线程头显示的就是这一条会话，不再只按队友区分。
    setOpenedTaskId(session.id)
    setFocusWakeId(session.latestWakeId)
    setRightOpen(session.latestWakeId !== null)
    hub.selectThread(session.assigneeBotId)
    // P44-R2：selectThread 会清空子行选中态，这里补回当前这条会话，左栏才亮对那一行。
    hub.setActiveTask(session.id)
  }

  /**
   * 队友主页头部「打开对话」（U01 r46）：进这个队友的普通私聊线程。
   * 与工作会话行一样置 fromHome，线程头部给「← 返回队友主页」，来回都不迷路；
   * 但不带项目/任务上下文：没有 @ 候选、不展开账本、不挂任务头，就是一条纯对话。
   * 这条入口补上了新队友还没有工作会话时「第一次对话无路可走」的断点。
   */
  const openTeammateThread = (): void => {
    if (!selectedBot) return
    setFromInbox(false)
    setFromHome(true)
    setMentionProjectId(null)
    setHomeNotice(null)
    setOpenedTaskId(null)
    setFocusWakeId(null)
    setFocusArtifactId(null)
    setRightOpen(false)
    hub.selectThread(selectedBot.id)
  }

  /**
   * 左栏内联新建会话（P44）：只发一条 saveTask；成功后刷新项目与总览，
   * 有指派就直接打开该队友线程（复用 requestWorkSession 的交接），
   * 没有指派就停在当前页，任务会出现在项目页的待领区。
   */
  const createSession = async (input: NewSessionInput): Promise<string | null> => {
    try {
      const result = await hub.command('saveTask', {
        projectId: input.projectId,
        title: input.title,
        assigneeBotId: input.assigneeBotId,
      })
      if (!result.ok) return result.error
      const created = result.data as { id?: unknown } | undefined
      const taskId = typeof created?.id === 'string' ? created.id : ''
      await Promise.all([hub.refreshProject(), hub.refreshOverview()])
      // P1-2：新任务也带着自己的 id 打开，线程头才能落到这条会话本身。
      if (input.assigneeBotId !== null && taskId !== '') {
        hub.requestWorkSession(input.assigneeBotId, input.projectId, taskId, null)
      }
      return null
    } catch (e) {
      return e instanceof Error ? e.message : String(e)
    }
  }

  /** P48：归档前置校验；失败转成中文错误字符串，左栏据此弹拦截框。 */
  const checkArchive = async (botId: string): Promise<ArchiveCheckInfo | string> => {
    try {
      const result = await hub.command('archiveBotCheck', { botId })
      if (!result.ok) return result.error
      return result.data as ArchiveCheckInfo
    } catch (e) {
      return e instanceof Error ? e.message : String(e)
    }
  }
  /** 归档 / 恢复 / 删除共用：成功后刷新总览、项目与办公室，失败把中文错误交回弹窗。 */
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

  /**
   * 完成并归档（P33）：只发 reportDone——任务从进行中推进到「待验收」，
   * 工作会话随之从「在做」落到「已归档」。不直接改本地状态，等刷新回填。
   */
  const completeWork = (session: WorkSession): void => {
    if (!session.canComplete) return
    void (async () => {
      setHomeBusyTaskId(session.id)
      try {
        const result = await hub.command('reportDone', { id: session.id })
        setHomeNotice(result.ok ? `「${session.title}」已提交。下一步：验收，负责人 待安排。` : result.error)
        await Promise.all([hub.refreshProject(), hub.refreshOverview()])
      } catch (e) {
        setHomeNotice(e instanceof Error ? e.message : String(e))
      } finally {
        setHomeBusyTaskId(null)
      }
    })()
  }

  /**
   * P35 看板领取：让当前队友领走一条待领事项。只发 dispatchTask（core 负责
   * 校验项目进行中、队友在岗且是成员、议程名额），成功与否等刷新回填，不本地改状态。
   */
  const claimTaskForBot = (card: WorkBoardCard): void => {
    if (!selectedBot) return
    void (async () => {
      setHomeBusyTaskId(card.id)
      try {
        const result = await hub.command('dispatchTask', {
          projectId: card.projectId, taskId: card.id, botId: selectedBot.id,
        })
        setHomeNotice(result.ok ? `任务「${card.title}」已派给「${selectedBot.name}」，进行中。` : result.error)
        await Promise.all([hub.refreshProject(), hub.refreshOverview()])
      } catch (e) {
        setHomeNotice(e instanceof Error ? e.message : String(e))
      } finally {
        setHomeBusyTaskId(null)
      }
    })()
  }

  /** P35 看板交账：把进行中的工作推进到待验收，和列表里的「完成并归档」同一条命令。 */
  const submitTaskForBot = (card: WorkBoardCard): void => {
    void (async () => {
      setHomeBusyTaskId(card.id)
      try {
        const result = await hub.command('reportDone', { id: card.id })
        setHomeNotice(result.ok ? `「${card.title}」已提交。下一步：验收，负责人 待安排。` : result.error)
        await Promise.all([hub.refreshProject(), hub.refreshOverview()])
      } catch (e) {
        setHomeNotice(e instanceof Error ? e.message : String(e))
      } finally {
        setHomeBusyTaskId(null)
      }
    })()
  }

  const overviewLoading = overview === null
  const showSkeleton = useSlowLoading(overviewLoading || (view === 'main' && state.threads[selectedThread] === undefined && !threadError))

  // 收件箱/线程卡片上的操作（D06 第 4 条）：按 cardSubmission 分流——审批卡用
  // approvalId 走 decideApproval（绝不把 inboxId 当 approvalId），其他卡走 answerInbox。
  // 卡片作答（D07 第 11 条）：失败要把原因返回给卡片显示（按钮恢复可点），不再只进 console。
  const cardActions: CardActions = {
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
  }

  // 线程头部信息（团队线程没有）。
  const header: ThreadHeaderInfo | null = selectedThread === 'team' ? null : selectedBot ? {
    name: selectedBot.name,
    roleLabel: selectedBot.roleLabel,
    activityText: selectedBot.activityText,
    nextThinkText: selectedBot.nextThinkText,
    lifecycle: selectedBot.lifecycle,
    thinking: selectedBot.activity === 'thinking',
  } : { name: state.threads[selectedThread]?.title ?? '队友', roleLabel: null, activityText: null, nextThinkText: null, lifecycle: null, thinking: false }

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
    // D06 第 3 条 / D07 第 24 条：暂停/恢复走 lifecycleAction，动作由纯函数按状态选。
    const picked = pauseResumeAction(selectedBot.lifecycle)
    if (picked === null) return
    const action = picked
    void (async () => {
      const result = await hub.command('lifecycleAction', { botId: selectedBot.id, action })
      setNotice(result.ok ? (action === 'pause' ? '已暂停。暂停期间的变化仍记录，可恢复。' : '已恢复。下一步：待安排。') : result.error)
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
  const lifecycleAll = async (target: 'paused' | 'active'): Promise<string | null> => {
    if (!overview) return '总览读取失败。请稍后重试；仍失败请检查 DSH 运行状态。'
    const action = target === 'paused' ? 'pause' : 'resume'
    // D07 第 24 条：目标选取也是纯函数（lifecycleAllTargets），与按钮表同一份规则。
    const targets = lifecycleAllTargets(overview.bots, target).map(id => overview.bots.find(b => b.id === id)!)
    let failed = 0
    for (const bot of targets) {
      // D06 第 3 条：全体暂停/恢复同样走 lifecycleAction（逐个执行，失败只计数）。
      const result = await hub.command('lifecycleAction', { botId: bot.id, action })
      if (!result.ok) failed += 1
    }
    await hub.refreshOverview()
    return failed === 0 ? null : `有 ${failed} 个队友操作未成功。请重试或进入队友详情单独操作；仍失败请检查 DSH 运行状态。`
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
   * 跳转面板选了一个页面：与顶栏按钮同口径——先归位收件箱来源标记，
   * 再切视图并拉对应表面，避免面板与顶栏两套入口行为漂移。
   */
  const handlePaletteNavigate = (target: PageView): void => {
    setFromInbox(false)
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
      setFromInbox(false)
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
          <TopBar
            overview={overview}
            view={view}
            onOpenProject={() => { setFromInbox(false); hub.setView('project'); void hub.refreshProject() }}
            onOpenActivity={() => { setFromInbox(false); hub.setView('activity'); void hub.refreshActivity() }}
            onNewBot={() => { setFromInbox(false); setWizardOpen(true) }}
            onBack={() => { setFromInbox(false); hub.setView('main') }}
            onOpenPalette={() => setPaletteOpen(true)}
          />
        </BlockBoundary>
      ) : showSkeleton ? <header className="ah-topbar"><Skeleton rows={1} /></header> : null}

      {/* 建队友 + 存色的两步编排见 logic/wizard-create（createBot → updateBot color）。 */}
      {wizardOpen && overview ? (
        <BlockBoundary label="新建队友">
          <NewBotWizard
            existingBots={overview.bots}
            // 第一件事只能放进未归档项目（已归档项目不能再加任务）。
            projects={state.project === null ? [] : state.project.projects
              .filter(row => row.project.status !== 'archived')
              .map(row => ({ id: row.project.id, name: row.project.name }))}
            modelOptions={state.settings?.modelOptions ?? []}
            modelOptionsError={state.settings ? null : state.settingsError}
            presetSkillOptions={state.settings?.presetSkillOptions ?? []}
            onCreate={(input, color, firstTask) => createTeammate(hub, input, color, firstTask)}
            // P52：传完整名册（含退役和归档），名字被占时要能自动加序号。
            onCreateFromTemplates={templates => addTeammatesFromTemplates(hub, templates, overview.bots)}
            onOpenThread={(botId, warning) => {
              setWizardOpen(false)
              setFromInbox(false)
              setFromHome(false)
              setMentionProjectId(null)
              hub.selectThread(botId)
              // 提示条改放线程顶部（D04 3c-3），该机器人第一次交账（线程出现 reply）后自动消失。
              // 第一件事没落进项目时不挡创建，把原因并进同一条提示。
              setNotice(`${warning ? `${warning} ` : ''}正在试跑：先进行自我介绍，请稍候。`)
              setNoticeAutoClearBot(botId)
              void hub.refreshOverview()
            }}
            onClose={() => setWizardOpen(false)}
          />
        </BlockBoundary>
      ) : null}

      {teachOpen && selectedBot ? (
        <BlockBoundary label="教它技能">
          <TeachDialog
            botName={selectedBot.name}
            sessions={state.recentSessions}
            onTeach={async (sessionId, note) => {
              const result = await hub.command('teach', { botId: selectedBot.id, sessionId, note })
              if (!result.ok) return result.error
              setTeachOpen(false)
              await Promise.all([hub.refreshThread(selectedBot.id), hub.refreshBot(selectedBot.id)])
              return null
            }}
            onClose={() => setTeachOpen(false)}
          />
        </BlockBoundary>
      ) : null}

      {/* 跳过链接的落点：tabIndex=-1 让容器可被编程聚焦但不进 Tab 环；
          地标由宿主/预览壳的 main 承担，这里不重复声明 role=main。 */}
      <div
        id="ah-main"
        tabIndex={-1}
        className={`ah-body${rightOpen && selectedBot && view === 'main' && mainFace === 'thread' ? ' ah-body-right' : ''}`}
      >
        {!props.sidebarInHost && overview ? (
          <BlockBoundary label="团队空间左栏">
            <TeamSidebarNav
              overview={overview}
              project={state.project}
              view={view}
              mainFace={mainFace}
              selectedThread={selectedThread}
              activeTaskId={state.activeTaskId}
              activeProjectId={view === 'project' ? state.activeProjectId : null}
              onOpenOffice={() => { setFromInbox(false); hub.setView('office'); void hub.refreshOffice() }}
              onSelectBot={(threadId) => {
                setFromInbox(false)
                setFromHome(false)
                setMentionProjectId(null)
                setHomeNotice(null)
                setOpenedTaskId(null)
                setFocusWakeId(null)
                setFocusArtifactId(null)
                // 团队全景进对话线程；点队友先进它的主页（P33）。
                if (threadId === 'team') hub.selectThread(threadId)
                else hub.selectTeammate(threadId)
              }}
              onOpenInbox={() => openInbox()}
              onOpenSettings={() => { setFromInbox(false); hub.setView('settings'); void hub.refreshSettings() }}
              onNewBot={() => { setFromInbox(false); setWizardOpen(true) }}
              onNewProject={() => {
                setFromInbox(false)
                setFromHome(false)
                setMentionProjectId(null)
                setOpenedTaskId(null)
                // 与宿主侧栏加号同一条路径：切到项目页 + 发一次打开表单的请求。
                hub.setView('project')
                void hub.refreshProject()
                hub.requestNewProject()
              }}
              onRetryProject={() => hub.refreshProject()}
              onOpenProject={(projectId) => {
                setFromInbox(false)
                setFromHome(false)
                setMentionProjectId(null)
                setOpenedTaskId(null)
                // P1：带上被点的项目 id，项目页据此定位并高亮对应项目。
                hub.requestProject(projectId)
                void hub.refreshProject()
              }}
              onOpenSession={session => hub.requestWorkSession(session.assigneeBotId, session.projectId, session.id, session.latestWakeId)}
              onCreateSession={createSession}
              onCheckArchive={checkArchive}
              onArchiveBot={botId => runBotArchiveCommand('archiveBot', botId)}
              onRestoreArchivedBot={botId => runBotArchiveCommand('restoreArchivedBot', botId)}
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
              onNewBot={() => setWizardOpen(true)}
              onRetry={() => void hub.refreshOffice()}
              onOpenBot={(botId, wakeId, artifactId) => {
                // 从办公室下钻：选中队友并展开右栏；点桌上产物时带上产物头，点账本时带上唤醒。
                setFromInbox(false)
                setFromHome(false)
                setMentionProjectId(null)
                setFocusWakeId(wakeId ?? null)
                setFocusArtifactId(artifactId ?? null)
                setRightOpen(true)
                hub.selectThread(botId)
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
              bots={overview ? overview.bots.map(b => ({ id: b.id, name: b.name, lifecycle: b.lifecycle })) : []}
              botsLoaded={overview !== null}
              loadBotArtifacts={botId => hub.botArtifacts(botId)}
              onOpenWake={openWake}
              focusProjectId={state.activeProjectId}
              focusSeq={state.projectOpenSeq}
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
              onOpenThread={id => { setFromHome(false); setMentionProjectId(null); setFromInbox(true); hub.selectThread(id) }}
              focusInboxId={focusInboxId}
            />
          </BlockBoundary>
        ) : view === 'activity' ? (
          <BlockBoundary label="活动流">
            <ActivityPane
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
        ) : view === 'settings' || view === 'resource' ? (
          <BlockBoundary label="设置">
            <SettingsPane
              settings={state.settings}
              loadError={state.settingsError}
              overview={overview}
              loading={state.settings === null}
              onRetry={() => void hub.refreshSettings()}
              onRetryOverview={() => void hub.refreshOverview()}
              onSave={saveSettings}
              onPauseAll={() => lifecycleAll('paused')}
              onResumeAll={() => lifecycleAll('active')}
              onTestKnowledge={testKnowledgeConnection}
              requestedSection={view === 'resource' ? 'resources' : null}
              onOpenSection={id => { if (id === 'resources') void hub.refreshResource() }}
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
        ) : mainFace === 'home' && selectedBot ? (
          // 队友主页（P33）：中栏看「它在做什么」；右栏只在对话线程面出现。
          <BlockBoundary label="队友主页">
            <TeammateHomePage
              bot={selectedBot}
              sessions={selectedSessions}
              project={state.project}
              loading={state.project === null}
              notice={homeNotice}
              busyTaskId={homeBusyTaskId}
              onRetry={() => void hub.refreshProject()}
              onOpenSession={openWorkSession}
              onComplete={completeWork}
              onOpenThread={openTeammateThread}
              onClaimTask={claimTaskForBot}
              onSubmitTask={submitTaskForBot}
            />
          </BlockBoundary>
        ) : (
          <BlockBoundary label="对话线程">
            <ThreadPane
              key={selectedThread}
              threadId={selectedThread}
              intro={overview?.bots.length === 0 && selectedThread === 'team'
                ? <FirstTeammate onNewBot={() => setWizardOpen(true)} /> : undefined}
              thread={state.threads[selectedThread] ?? null}
              loading={state.threads[selectedThread] === undefined}
              header={header}
              inputPlaceholderName={state.threads[selectedThread]?.title ?? '队友'}
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
              onTeach={() => setTeachOpen(true)}
              onOpenSession={openSession}
              onTogglePause={togglePause}
              onInterrupt={interrupt}
              rightCollapsed={view === 'main' && !rightOpen && selectedBot !== null}
              onExpandRight={() => setRightOpen(true)}
              fromInbox={fromInbox}
              onBackToInbox={() => openInbox()}
              fromHome={fromHome}
              onBackHome={() => {
                // 回到原队友主页；主页不标已读，线程里的消息才算读过。
                setFromHome(false)
                setMentionProjectId(null)
                hub.selectTeammate(selectedThread)
              }}
              mention={mention}
              openedTask={openedTask === null ? null : {
                title: openedTask.title,
                projectName: openedTask.projectName,
                statusLabel: openedTask.statusLabel,
              }}
            />
          </BlockBoundary>
        )}
        {/* 窄屏抽屉的遮罩：宽屏由 CSS 隐藏；点一下就把详情收起。 */}
        {view === 'main' && mainFace === 'thread' && rightOpen && selectedBot ? (
          <div className="ah-right-scrim" aria-hidden="true" onClick={() => setRightOpen(false)} />
        ) : null}
        {view === 'main' && mainFace === 'thread' && rightOpen && selectedBot ? (
          <BlockBoundary label="详情">
            <RightPanel
              key={selectedBot?.id ?? 'none'}
              bot={selectedBot ? state.bots[selectedBot.id] ?? null : null}
              modelOptions={state.settings?.modelOptions ?? []}
              modelOptionsError={state.settings ? null : state.settingsError}
              presetSkillOptions={state.settings?.presetSkillOptions ?? []}
              onRetrySettings={() => void hub.refreshSettings()}
              clientCtx={props.clientCtx}
              run={(name, input) => hub.command(name, input)}
              onRefresh={() => { if (selectedBot) void hub.refreshBot(selectedBot.id); void hub.refreshOverview() }}
              onTeach={() => setTeachOpen(true)}
              onCollapse={() => setRightOpen(false)}
              ledgers={state.ledgers}
              ledgerErrors={state.ledgerErrors}
              onLoadLedger={wakeId => void hub.refreshLedgerDetail(wakeId)}
              focusWakeId={focusWakeId}
              focusArtifactId={focusArtifactId}
            />
          </BlockBoundary>
        ) : null}
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

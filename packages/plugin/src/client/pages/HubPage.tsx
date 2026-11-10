/**
 * 中心页：像聊天软件的三栏页面——左队友列表、中对话线程/收件箱/活动流/设置、右侧边栏（默认收起）。
 * 点队友直接进对话（P64）；忙碌状态、额度、在办的事放在按需展开的右侧边栏。
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
import { findTopic, isTopicThreadId, openNewTopic, topicPaneInfo } from '../logic/topics.js'
import { sendDraftFirstMessage, sidebarSelectedThread, topicDraftThreadId } from '../logic/topic-draft.js'
import { TopicDraftPane } from '../components/topic-draft-pane.js'

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
  /**
   * 从「待你处理」跳进来的是哪条线程：头部据此显示「返回待你处理」。
   * 记线程 id 而不是一个开关（P64）：宿主侧栏点别的队友时页面收不到通知，
   * 记了 id，切到别的线程回程钮自然就不成立，不会挂在不相干的对话上。
   */
  const [inboxReturnThread, setInboxReturnThread] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  /** 试跑提示归属的机器人：它的线程里出现第一条回复后自动消失（D04 3c-3）。 */
  const [noticeAutoClearBot, setNoticeAutoClearBot] = useState<string | null>(null)
  /** 跳到动态页时替主人先筛好的队友（P64）：点某位队友的唤醒记录进来才有值。 */
  const [activityBotId, setActivityBotId] = useState<string | null>(null)
  /** 从办公室门口点进来时要聚焦的收件箱卡（F04）；普通进入收件箱为 null。 */
  const [focusInboxId, setFocusInboxId] = useState<string | null>(null)

  const selectedThread = state.selectedThread
  /**
   * P60 草稿主题：中栏摆着「新开会话」的空聊天时，本页把它当成单独的视图 'topic-draft'。
   * 这样下面所有「页面正摆着选中线程（view === 'main'）」的判断自动不成立：不给上一条线程标已读、
   * 不开它的右侧边栏、不留它的回程钮。仓库里的 view 仍是 'main'；换页、切线程都会清掉草稿。
   */
  const topicDraft = state.view === 'main' ? state.topicDraft : null
  const view: PageView | 'topic-draft' = topicDraft !== null ? 'topic-draft' : state.view

  // 首次挂载拉全部基础视图；此后由 SSE changed 事件驱动刷新。
  useEffect(() => {
    void hub.refreshAll()
    void hub.refreshSettings()
  }, [hub])
  // P58：选中某位队友时，等名册到手再拉对话，因为本地记住的 id 可能早已不存在。
  // 团队线程不依赖名册，照旧立刻拉；这个布尔值只在名册第一次到手时翻转，不会造成多拉。
  const threadLoadable = selectedThread === 'team' || state.overview !== null
  useEffect(() => {
    if (state.connectionDown || !threadLoadable) return
    setThreadError(null)
    void hub.refreshThread(selectedThread).catch(() => setThreadError('线程读取失败。点击「重试」；仍失败请确认插件未停用。'))
  }, [hub, selectedThread, state.connectionDown, threadLoadable])

  // P58：选中的队友已不存在、仓库把选中退回团队全景时，页面里跟这位队友绑定的状态也要归位，
  // 否则团队全景上会留着旧提示条，下次选别人时右侧边栏和教学弹窗也会莫名打开。
  // 挂载时也会跑一次，这些状态本来就是初始值，等于什么都没做。
  // 这段必须排在下面几个「接住定位请求」的 effect 前面：同一轮里既退出又有新请求时，新请求要赢。
  const selectionExitSeq = state.selectionExitSeq
  useEffect(() => {
    setInboxReturnThread(null)
    setRightOpen(false)
    setTeachOpen(false)
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

  // 选中机器人时拉它的详情；打开教学时拉最近会话。
  const overview = state.overview
  const selectedBot = overview?.bots.find(b => b.id === selectedThread) ?? null
  useEffect(() => {
    if (selectedBot && !state.bots[selectedBot.id]) void hub.refreshBot(selectedBot.id)
  }, [hub, selectedBot, state.bots])
  useEffect(() => {
    if (teachOpen) void hub.refreshRecentSessions()
  }, [hub, teachOpen])

  // 工作会话投影（P33）：项目视图还没到时是 null，右侧边栏显示骨架，不假装没有工作。
  const workSessions = state.project === null ? null : collectWorkSessions(state.project)
  const selectedSessions = selectedBot !== null && workSessions !== null
    ? sessionsForBot(workSessions, selectedBot.id)
    : null

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
  // - 团队线程（'team'）也是私聊同类的线程，未读数在 overview.team.unread，一并处理。
  // - 名册里查不到这个 id（已删除的队友）时 selectedBot 为 null，未读数按 0 算，不发标已读（P58 的规矩）。
  // - 不会循环：未读为 0 不发；标完刷新名册后未读归 0，依赖变了但条件不成立，就停了；
  //   标已读失败时未读数不变、依赖不变，effect 不会重跑。
  // 少数夹具/占位名册没有 team 字段，所以按可选读取，缺了就当 0。
  const teamUnread = (overview?.team as { unread?: number } | undefined)?.unread ?? 0
  const chatUnread = selectedThread === 'team' ? teamUnread : (selectedBot?.unread ?? 0)
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
  const header: ThreadHeaderInfo | null = selectedThread === 'team' ? null : topicInfo !== null ? {
    name: topicInfo.title, roleLabel: null, activityText: null, nextThinkText: null, lifecycle: null, thinking: false,
  } : selectedBot ? {
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
    return failed === 0 ? null : `有 ${failed} 个队友操作未成功。请重试，或在对话页点「查看状态」后用「编辑队友」单独操作；仍失败请检查 DSH 运行状态。`
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
        <BlockBoundary label="新建队友">
          <NewBotWizard
            existingBots={overview.bots}
            modelOptions={state.settings?.modelOptions ?? []}
            modelOptionsError={state.settings ? null : state.settingsError}
            presetSkillOptions={state.settings?.presetSkillOptions ?? []}
            dshSkillOptions={state.settings?.dshSkillOptions ?? []}
            onCreate={input => createTeammate(hub, input)}
            // P52：传完整名册（含退役和归档），名字被占时要能自动加序号。
            onCreateFromTemplates={templates => addTeammatesFromTemplates(hub, templates, overview.bots)}
            onOpenThread={(botId, warning) => {
              setWizardOpen(false)
              hub.selectThread(botId)
              // 提示条改放线程顶部（D04 3c-3），该机器人第一次交账（线程出现 reply）后自动消失。
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
              // 团队全景和队友都直接进对话（P64）。
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
              onOpenThread={id => { setInboxReturnThread(id); hub.selectThread(id) }}
              focusInboxId={focusInboxId}
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
              fromInbox={inboxReturnThread === selectedThread}
              onBackToInbox={() => openInbox()}
              topic={topicInfo}
            />
          </BlockBoundary>
        )}
        {/* 窄屏抽屉的遮罩：宽屏由 CSS 隐藏；点一下就把侧边栏收起。 */}
        {view === 'main' && rightOpen && selectedBot ? (
          <div className="ah-right-scrim" aria-hidden="true" onClick={() => setRightOpen(false)} />
        ) : null}
        {view === 'main' && rightOpen && selectedBot && overview ? (
          <BlockBoundary label="队友侧边栏">
            <RightPanel
              key={selectedBot?.id ?? 'none'}
              card={selectedBot}
              detail={state.bots[selectedBot.id] ?? null}
              light={overview.quota.light}
              costs={overview.costs}
              sessions={selectedSessions}
              onOpenSession={openWorkSession}
              onCollapse={() => setRightOpen(false)}
              roster={overview.bots}
              modelOptions={state.settings?.modelOptions ?? []}
              modelOptionsError={state.settings ? null : state.settingsError}
              onRetrySettings={() => void hub.refreshSettings()}
              presetSkillOptions={state.settings?.presetSkillOptions ?? []}
              dshSkillOptions={state.settings?.dshSkillOptions ?? []}
              run={(name, input) => hub.command(name, input)}
              onRefresh={() => { void hub.refreshBot(selectedBot.id); void hub.refreshOverview() }}
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

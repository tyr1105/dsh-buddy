/**
 * 界面数据仓库：唯一的数据来源（api + SSE 都汇到这里），组件只读仓库。
 * 收到 changed 事件就重拉受影响的视图；connection/reset 重拉全部（官方 schedule 的模式）。
 * D03 起：页面视图切换（主视图/收件箱/活动流/设置）也放仓库，应用内提示点击后
 * 能从任何页面跳回收件箱；新到的 P0/P1 收件箱项在这里变成 4 秒应用内提示。
 */
import { api, type ChangedEvent } from './api.js'
import { createStore, type Store } from './store.js'
import { newUrgentInbox } from './logic/feeds.js'
import { refreshPlan } from './logic/scopes.js'
import {
  canRequestById, exitMissingSelection, isMissingFromRoster, isMissingTopic, nextGoneIds, nextGoneTopicIds,
  shouldExitSelection, shouldExitTopicSelection, TEAM_THREAD_ID,
} from './logic/missing-teammate.js'
import { isTopicThreadId } from './logic/topics.js'
import type { TopicDraft } from './logic/topic-draft.js'
import type { CommandResult } from '../shared/views.js'
import type { ActivityView, BotView, InboxItemView, InboxView, OfficeView, OverviewView, ProjectView, RecentSessionView, ResourceView, SettingsView, ThreadView, WakeLedgerRow, WakeLedgerView } from '../shared/views.js'

/** 应用内提示（shell.overlay 上的一条，4 秒自动消失）。 */
export interface HubToast { id: string; text: string; inboxItemId: string }

export type PageView = 'main' | 'office' | 'resource' | 'project' | 'inbox' | 'activity' | 'settings'

export interface HubState {
  overview: OverviewView | null
  /** 办公室投影（F03）：纯投影，刷新时整份替换。 */
  office: OfficeView | null
  /** 资料授权矩阵（V2-PH2-04）：资料行、授权展开行与计数，刷新时整份替换。 */
  resource: ResourceView | null
  /** 项目容器（V2-PH4-02）：项目行、任务展开与问题，刷新时整份替换。 */
  project: ProjectView | null
  inbox: InboxView | null
  activity: ActivityView | null
  settings: SettingsView | null
  recentSessions: RecentSessionView[]
  bots: Record<string, BotView>
  threads: Record<string, ThreadView>
  /**
   * 按唤醒单 id 缓存的账本详情（F02 最小读法）：按需拉取，不参与全局刷新。
   * null 表示这次唤醒确实没有账本，和「还没拉」严格区分。
   * P64 拿掉右栏账本后暂时没有页面读它，数据通道先留着，动态页要展开账本时直接接。
   */
  ledgers: Record<string, WakeLedgerView | null>
  /** 单个账本拉取失败的原因（不影响整页连接状态，界面上给「重试」）。 */
  ledgerErrors: Record<string, string>
  /** 宿主连不上时整页提示。 */
  connectionDown: boolean
  /** 连不上的原因（D05 第 13 条 + D07 第 12 条）：disabled=已停用；starting=启动中；failed=启动失败；null=普通连不上。 */
  downReason: 'disabled' | 'starting' | 'failed' | null
  /** 断开/失败的具体原因（failed 时显示给主人）。 */
  downMessage: string | null
  /**
   * 设置视图拉取失败的原因（D07 第 2 条）：设置读不到不等于连不上——只有网络错误、
   * 尚未就绪、已停用才整页提示；其余（如模型目录坏了）在这里记一句，设置页与
   * 各模型下拉处显示原因和「重试」。
   */
  settingsError: string | null
  /**
   * 动态首屏拉取失败的原因（U01 第 32 轮）：只有一个接口读不到时不该端走整页，
   * 在动态页内给原因与「重试」；网络级故障仍走 connectionDown 整页面板。
   */
  activityError: string | null
  /** 当前页面视图（主视图 / 收件箱 / 活动流 / 设置）。 */
  view: PageView
  /** 当前选中的线程：'team'、队友 id 或项目主题 id（ptp_ 开头，P63）。 */
  selectedThread: string
  /**
   * 选中的队友已不存在、被自动退回团队全景的次数（P58）。
   * 页面看到数字变化，就把跟这位队友绑定的局部状态（返回按钮、右栏、提示条等）一起归位。
   */
  selectionExitSeq: number
  /**
   * 新建队友请求计数（P37）：左栏「队友」分组标题右侧的加号写这里。
   * 用计数而不是布尔：每次点击都是新请求，中心页看到数字变化就打开向导，
   * 不会因为上一次向导已关闭而漏掉下一次点击。
   * P53：非零表示「有请求还没被中心页接住」，接住后清零；中心页挂载晚于请求时也不丢。
   */
  newBotRequest: number
  /**
   * 新建项目请求计数（P44-R2）：左栏「工作区」组标题右侧的加号写这里。
   * 与 newBotRequest 同一模式：非零即待处理，项目页接住后清零，首次点击不被挂载差吞掉。
   */
  newProjectRequest: number
  /**
   * 项目页显示哪个项目（P60）：点左栏项目行、新建成功后写这里，
   * 项目行据此显示选中态；离开项目页时清空，再从跳转面板进来就是项目名列表。
   */
  activeProjectId: string | null
  /**
   * 草稿主题（P60，2026-11-10）：项目里「新开会话」先进一个空聊天，第一句发出去才真正建主题。
   * 非 null 且 view 为 'main' 时，中栏摆的是这张草稿，不是 selectedThread。
   * 单独放一个字段、不塞进 selectedThread：选中值会记进本地、会拿去请求楼层和标已读，
   * 草稿不该有这些副作用。切线程、换页面都会把它清掉，所以「没发就离开」什么都不留下。
   */
  topicDraft: TopicDraft | null
  /** 应用内提示列表（顶部 4 秒提示）。 */
  toasts: HubToast[]
}

export type HubStore = Store<HubState> & {
  refreshOverview(): Promise<void>
  refreshOffice(): Promise<void>
  /** 拉取资料授权矩阵（资料/授权/计数）。 */
  refreshResource(): Promise<void>
  /** 拉取项目容器（项目/成员/验收项/任务/问题）。 */
  refreshProject(): Promise<void>
  refreshInbox(): Promise<void>
  refreshActivity(before?: string): Promise<void>
  refreshSettings(): Promise<void>
  refreshRecentSessions(): Promise<void>
  refreshBot(botId: string): Promise<void>
  refreshThread(threadId: string, before?: string): Promise<void>
  /** 拉一次唤醒的账本详情（按需调用）。 */
  refreshLedgerDetail(wakeId: string): Promise<void>
  /**
   * 某个队友最近的唤醒账本行（P36 轨迹面板用）。按需直读，不进全局状态：
   * 轨迹只在打开面板时读一次，没必要参与整页刷新。
   */
  wakeRows(botId: string): Promise<WakeLedgerRow[]>
  refreshAll(): Promise<void>
  onChanged(event: ChangedEvent): void
  markDown(reason?: 'disabled' | 'starting' | 'failed' | null, message?: string | null): void
  /** SSE 重连成功（D05 第 12 条）：清除断开态并补拉全部与当前线程。 */
  onReconnected(): void
  send(threadId: string, text: string): Promise<void>
  command(name: string, input: Record<string, unknown>): Promise<CommandResult>
  selectThread(threadId: string): void
  /** 请求打开「新建队友」向导（P37）：宿主侧栏加号与中心页之间的唯一信号。 */
  requestNewBot(): void
  /** HubPage 接住新建队友请求后清零（P53）：重挂载不会再弹一次。 */
  clearNewBotRequest(): void
  /** 请求打开「新建项目」表单（P44-R2）：工作区组标题加号与项目页之间的唯一信号。 */
  requestNewProject(): void
  /** HubPage 接住新建项目请求后清零（P53）：重挂载不会再弹一次。 */
  clearNewProjectRequest(): void
  /** 点左栏项目行（P44-R2）：切到项目页、记下选中的项目。 */
  requestProject(projectId: string): void
  /** 新建项目成功后选中它（P44-R2）。 */
  setActiveProject(projectId: string | null): void
  /** 在项目里开一张草稿主题（P60）：中栏切到空聊天，不发任何命令。 */
  openTopicDraft(projectId: string): void
  setView(view: PageView): void
  dismissToast(id: string): void
}

/** 应用内提示显示时长（任务卡第 7 节：4 秒）。 */
const TOAST_MS = 4000

/**
 * 按消息 id 合并两段线程消息（D07 第 14 条）：base 的顺序为准（更早的历史在前，
 * 或已加载的列表在前），fresh 里同 id 的消息覆盖旧状态（卡片作答、已读等），
 * fresh 里新出现的消息追加在尾部。绝不用最新一页整页替换——那会把主人翻出来的
 * 更早历史冲掉。
 */
export function mergeThreadMessages(
  base: ReadonlyArray<ThreadView['messages'][number]>,
  fresh: ReadonlyArray<ThreadView['messages'][number]>,
): Array<ThreadView['messages'][number]> {
  const index = new Map(base.map((m, i) => [m.id, i]))
  const out = [...base]
  for (const message of fresh) {
    const at = index.get(message.id)
    if (at === undefined) { index.set(message.id, out.length); out.push(message) }
    else out[at] = message
  }
  return out
}

function emptyState(): HubState {
  return {
    overview: null, office: null, resource: null, project: null, inbox: null, activity: null, settings: null, recentSessions: [], bots: {}, threads: {},
    ledgers: {}, ledgerErrors: {},
    connectionDown: false, downReason: null, downMessage: null, settingsError: null, activityError: null,
    view: 'main', selectedThread: 'team', selectionExitSeq: 0, newBotRequest: 0, newProjectRequest: 0,
    activeProjectId: null, topicDraft: null, toasts: [],
  }
}

/**
 * 从错误文字里识别断开原因（D05 第 13 条 + D07 第 12 条）：
 * 停用 / 启动中 / 启动失败要给对应的提示，不是一律「连不上」。
 */
function reasonOfError(message: string): 'disabled' | 'starting' | 'failed' | null {
  if (message.includes('已停用')) return 'disabled'
  if (message.includes('尚未就绪')) return 'starting'
  if (message.includes('启动失败')) return 'failed'
  return null
}

/** 是否网络级错误（连不上插件本体）：只有这类才把整页标成「连不上」（D07 第 2 条）。 */
function isNetworkError(message: string): boolean {
  return message.includes('网络错误')
}

/** 一次名册或项目视图请求的凭据（P58、P63）：order 是发出顺序，selectionSerial 是发出时主人选中过几次线程。 */
interface RosterTicket { order: number; selectionSerial: number }

/** 建仓库（整个插件唯一一份；index.tsx 在 apply 里创建并传给组件）。 */
export function createHubStore(): HubStore {
  const store = createStore<HubState>(emptyState())
  const patch = (partial: Partial<HubState>) => store.update((prev) => ({ ...prev, ...partial }))
  const guard = async (fn: () => Promise<Partial<HubState>>): Promise<void> => {
    try {
      patch(await fn())
      if (store.getSnapshot().connectionDown) patch({ connectionDown: false, downReason: null, downMessage: null })
    } catch (error) {
      // 拉取失败：标连接断开（整页提示），具体视图保持原值，界面给「重试」；
      // 停用/启动中/启动失败的错误文字会被识别成对应原因，页面显示对应提示。
      const message = error instanceof Error ? error.message : String(error)
      console.error('[agent-hub] 拉取数据失败:', error)
      patch({ connectionDown: true, downReason: reasonOfError(message), downMessage: reasonOfError(message) === 'failed' ? message : null })
    }
  }

  // ---------- P58：选中的队友已不存在（判断规则在 logic/missing-teammate，这里只接线） ----------

  /** 主人主动选中线程的次数：用来判断手里的名册是不是比这次选中旧。 */
  let selectionSerial = 0
  /** 名册请求的发出序号和已落地的最新序号：后发的请求先回来时，先发的旧名册直接丢弃。 */
  let rosterIssued = 0
  let rosterLanded = 0
  /** 名册已确认不存在的队友 id：这些 id 不再请求详情和对话。 */
  let goneIds: ReadonlySet<string> = new Set()
  /** 项目视图请求的发出序号和已落地的最新序号（P63）：道理和名册一样，晚到的旧视图直接丢弃。 */
  let projectIssued = 0
  let projectLanded = 0
  /** 项目视图已确认不存在的主题 id：这些 id 不再请求楼层。 */
  let goneTopicIds: ReadonlySet<string> = new Set()

  /** 发名册请求前领一张票：记下发出顺序和当时的选中次数。 */
  const rosterTicket = (): RosterTicket => ({ order: ++rosterIssued, selectionSerial })

  /** 现在能不能按 id 请求详情和对话：refreshBot、refreshThread 的统一闸门。 */
  const mayRequestById = (id: string): boolean => {
    const { overview, selectedThread } = store.getSnapshot()
    return canRequestById({
      id, goneIds: isTopicThreadId(id) ? goneTopicIds : goneIds,
      selectedThread, rosterLoaded: overview !== null, selectedThisSession: selectionSerial > 0,
    })
  }

  /**
   * 一份新名册落地：写进仓库，并核对当前选中。
   * 写名册和退出选中放在同一次更新里，页面不会渲染出「名册没有它、选中还是它」的中间状态，
   * 也就不会在这个间隙里再用旧 id 发请求。
   */
  const landRoster = (overview: OverviewView, ticket: RosterTicket): void => {
    if (ticket.order < rosterLanded) return
    rosterLanded = ticket.order
    const { overview: previous, selectedThread } = store.getSnapshot()
    goneIds = nextGoneIds(goneIds, previous, overview)
    const exit = shouldExitSelection({
      selectedThread, roster: overview, goneIds, selectedAfterRequest: ticket.selectionSerial !== selectionSerial,
    })
    if (exit) goneIds = new Set(goneIds).add(selectedThread)
    store.update(prev => (exit ? exitMissingSelection({ ...prev, overview }) : { ...prev, overview }))
  }

  /**
   * 一份新的项目视图落地（P63）：写进仓库，并核对当前选中的主题还在不在。
   * 和名册一样放在同一次更新里，页面不会渲染出「项目里没有它、选中还是它」的中间状态。
   */
  const landProject = (project: ProjectView, ticket: RosterTicket): void => {
    if (ticket.order < projectLanded) return
    projectLanded = ticket.order
    const { project: previous, selectedThread } = store.getSnapshot()
    goneTopicIds = nextGoneTopicIds(goneTopicIds, previous, project)
    const exit = shouldExitTopicSelection({
      selectedThread, project, goneIds: goneTopicIds, selectedAfterRequest: ticket.selectionSerial !== selectionSerial,
    })
    if (exit) goneTopicIds = new Set(goneTopicIds).add(selectedThread)
    store.update(prev => (exit ? exitMissingSelection({ ...prev, project }) : { ...prev, project }))
  }

  /**
   * 按 id 的请求失败后，重新拉一次名册，核实是不是这位队友没了。
   * 只看名册、不看错误文案；名册也拉不到（断网、引擎没起来）就返回 false，按原来的「连不上」处理。
   * 这里直接调接口、不走 guard：核实本身不能改「连不上」状态，
   * 否则状态一翻转，页面又会重拉线程，形成新的循环。
   */
  const confirmGone = async (id: string): Promise<boolean> => {
    // 主题不在名册里，拿名册核对只会得出错误结论；它的存亡由项目视图判断。
    if (id === TEAM_THREAD_ID || isTopicThreadId(id)) return false
    const ticket = rosterTicket()
    let overview: OverviewView
    try { overview = await api.overview() } catch { return false }
    landRoster(overview, ticket)
    if (!isMissingFromRoster(id, overview)) return false
    goneIds = new Set(goneIds).add(id)
    return true
  }

  /** 收件箱刷新后：新到的 P0/P1 项弹 4 秒应用内提示（SSE 驱动，不轮询）。 */
  const applyInbox = (next: InboxView, prevItems: readonly InboxItemView[] | null): Partial<HubState> => {
    const fresh = prevItems === null ? [] : newUrgentInbox(prevItems, next.items)
    for (const item of fresh) {
      const toast: HubToast = { id: `toast-${item.id}`, text: `${item.botName ?? '中心'}：${item.title}`, inboxItemId: item.id }
      store.update(prev => ({ ...prev, toasts: [...prev.toasts.filter(t => t.id !== toast.id), toast] }))
      // 4 秒后自动消失；定时器异常不影响数据。
      try {
        setTimeout(() => {
          try {
            store.update(prev => ({ ...prev, toasts: prev.toasts.filter(t => t.id !== toast.id) }))
          } catch { /* 忽略 */ }
        }, TOAST_MS)
      } catch { /* 忽略 */ }
    }
    return { inbox: next }
  }

  const hub: HubStore = {
    ...store,
    /** 总览同时也是名册：拉到后由 landRoster 写入并核对选中（P58），失败走通用 guard，选中不动。 */
    async refreshOverview() {
      const ticket = rosterTicket()
      await guard(async () => {
        landRoster(await api.overview(), ticket)
        return {}
      })
    },
    /** 办公室投影（F03）：一次拉一屏，失败走通用 guard（整页提示与重试）。 */
    async refreshOffice() { await guard(async () => ({ office: await api.office() })) },
    /** 资料授权矩阵：失败走通用 guard，页面显示中文错误与「重试」。 */
    async refreshResource() { await guard(async () => ({ resource: await api.resource() })) },
    /** 项目容器：拉到后由 landProject 写入并核对选中的主题（P63）；失败走通用 guard，选中不动。 */
    async refreshProject() {
      const ticket: RosterTicket = { order: ++projectIssued, selectionSerial }
      await guard(async () => {
        landProject(await api.project(), ticket)
        return {}
      })
    },
    async refreshInbox() {
      const prevItems = store.getSnapshot().inbox?.items ?? null
      await guard(async () => applyInbox(await api.inbox(), prevItems))
    },
    async refreshActivity(before?) {
      try {
        const next = await api.activity(before ? { before } : undefined)
        // 「加载更多」：旧一页接在已有列表后面（合并在 updater 里做，D07 第 9 条）；
        // 首拉直接替换。
        if (!before) patch({ activity: next, activityError: null })
        else store.update(prev => ({
          ...prev,
          activity: prev.activity === null ? next : { rows: [...prev.activity.rows, ...next.rows], hasMore: next.hasMore },
        }))
        if (store.getSnapshot().connectionDown) patch({ connectionDown: false, downReason: null, downMessage: null })
      } catch (error) {
        // 动态首屏读不到不等于中心连不上（与设置页同口径，U01 第 32 轮）：网络错误、
        // 尚未就绪、已停用、启动失败仍整页提示；其余（如活动查询 500）只在动态页内
        // 记原因并给「重试」，不端走顶栏与当前页面。已有列表时刷新失败保持旧口径。
        const message = error instanceof Error ? error.message : String(error)
        console.error('[agent-hub] 拉取活动流失败:', error)
        const reason = reasonOfError(message)
        if (reason !== null) patch({ connectionDown: true, downReason: reason, downMessage: reason === 'failed' ? message : null })
        else if (isNetworkError(message) || store.getSnapshot().activity !== null) {
          patch({ connectionDown: true, downReason: null, downMessage: null })
        }
        else patch({ activityError: message })
      }
    },
    /**
     * 设置拉取（D07 第 2 条）：不走会标 connectionDown 的通用 guard——设置读不到
     * 不等于连不上。只有网络错误、「尚未就绪」「已停用」「启动失败」才整页提示；
     * 其余（例如宿主模型目录坏了）把中文原因存进 settingsError，设置页与各模型
     * 下拉处显示原因和「重试」；旧的 settings 保持原值。
     */
    async refreshSettings() {
      try {
        const settings = await api.settings()
        patch({ settings, settingsError: null })
        if (store.getSnapshot().connectionDown) patch({ connectionDown: false, downReason: null, downMessage: null })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error('[agent-hub] 拉取设置失败:', error)
        const reason = reasonOfError(message)
        if (reason !== null) patch({ connectionDown: true, downReason: reason, downMessage: reason === 'failed' ? message : null })
        else if (isNetworkError(message)) patch({ connectionDown: true, downReason: null, downMessage: null })
        else patch({ settingsError: message })
      }
    },
    async refreshRecentSessions() { await guard(async () => ({ recentSessions: await api.recentSessions() })) },
    /**
     * 机器人详情（D07 第 9 条）：先拿到详情，再在 updater 里合并进**最新**状态——
     * 两条 bot 推送挨着到时，后返回的请求不能把另一台刚拉到的新详情改回旧值。
     */
    async refreshBot(botId) {
      // 主题 id 不是队友，绝不能拿去拉 /bot：断线重连时「当前选中」可能就是主题。
      if (isTopicThreadId(botId) || !mayRequestById(botId)) return
      try {
        const view = await api.bot(botId)
        store.update(prev => ({ ...prev, bots: { ...prev.bots, [botId]: view } }))
        if (store.getSnapshot().connectionDown) patch({ connectionDown: false, downReason: null, downMessage: null })
      } catch (error) {
        // P58：先核实是不是队友没了。是的话中心本身是好的，不标「连不上」，也不喊错。
        if (await confirmGone(botId)) return
        const message = error instanceof Error ? error.message : String(error)
        console.error('[agent-hub] 拉取机器人详情失败:', error)
        patch({ connectionDown: true, downReason: reasonOfError(message), downMessage: reasonOfError(message) === 'failed' ? message : null })
      }
    },
    /**
     * 线程（D07 第 14/9 条）：带 before 是「加载更早」，把旧一页拼在已有列表前面；
     * 不带 before 是最新一页，**按消息 id 合并**进已加载的列表——更新已有消息与
     * 卡片状态、追加新消息，保留主人翻出来的更早历史（只在切换线程时才重置，
     * 见 selectThread）。合并一律在 updater 里做，避免并发覆盖。
     */
    async refreshThread(threadId, before?) {
      if (!mayRequestById(threadId)) return
      try {
        const thread = await api.thread(threadId, before ? { before } : undefined)
        store.update(prev => {
          const loaded = prev.threads[threadId]
          if (loaded === undefined) return { ...prev, threads: { ...prev.threads, [threadId]: thread } }
          // 带 before：旧一页在前（滚动位置不跳）；不带：已加载列表在前、最新一页
          // 按 id 合并（保住更早的历史，更新卡片状态、追加新消息）。
          const messages = before
            ? mergeThreadMessages(thread.messages, loaded.messages)
            : mergeThreadMessages(loaded.messages, thread.messages)
          const oldest = messages[0]?.id ?? null
          return { ...prev, threads: { ...prev.threads, [threadId]: { ...thread, messages, hasMore: thread.hasMore || loaded.hasMore, oldestId: oldest } } }
        })
        if (store.getSnapshot().connectionDown) patch({ connectionDown: false, downReason: null, downMessage: null })
      } catch (error) {
        // P58：和详情同一口径。现在的线程接口查不到队友也返回 200，这里防的是它以后改成报错。
        if (await confirmGone(threadId)) return
        const message = error instanceof Error ? error.message : String(error)
        console.error('[agent-hub] 拉取线程失败:', error)
        patch({ connectionDown: true, downReason: reasonOfError(message), downMessage: reasonOfError(message) === 'failed' ? message : null })
      }
    },
    /**
     * 账本详情（F02 最小读法）：按需拉，不进全局刷新。
     * 失败不标整页断开——账本读不到只影响这一块，原因记在该唤醒单上供「重试」。
     */
    async refreshLedgerDetail(wakeId) {
      try {
        const ledger = await api.wakeLedgerDetail(wakeId)
        store.update(prev => {
          const ledgerErrors = { ...prev.ledgerErrors }
          delete ledgerErrors[wakeId]
          return { ...prev, ledgers: { ...prev.ledgers, [wakeId]: ledger }, ledgerErrors }
        })
        if (store.getSnapshot().connectionDown) patch({ connectionDown: false, downReason: null, downMessage: null })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error('[agent-hub] 拉取唤醒账本失败:', error)
        store.update(prev => ({ ...prev, ledgerErrors: { ...prev.ledgerErrors, [wakeId]: message } }))
      }
    },
    async refreshAll() {
      await Promise.all([hub.refreshOverview(), hub.refreshOffice(), hub.refreshResource(), hub.refreshProject(), hub.refreshInbox(), hub.refreshActivity()])
    },
    /**
     * 轨迹面板的数据口：一次拉该队友最近 100 次唤醒的账本行（接口上限），按天往前翻才有东西看。
     * 失败原样抛给面板，由面板在自己的范围里显示「读不到」并给重试，不标整页断开。
     */
    wakeRows(botId) {
      return api.wakeLedger(botId, { limit: 100 })
    },
    onChanged(event) {
      void (async () => {
        try {
          // D06 第 5 条：按 core 的九范围词表（HUB_EVENT_SCOPES）定向刷新，
          // 不再匹配内部表名；映射规则集中在 refreshPlan（可单测）。
          const plan = refreshPlan(event.scope, event.botId)
          const jobs: Array<Promise<void>> = []
          const rosterDone = plan.overview ? hub.refreshOverview() : Promise.resolve()
          jobs.push(rosterDone)
          if (plan.office) jobs.push(hub.refreshOffice())
          // 资料变化在 core 里发的是 overview scope：计划里 resource 与 overview 同口径。
          if (plan.resource) jobs.push(hub.refreshResource())
          // 项目/任务变化发 project scope：定向刷项目页（计划里同时带总览）。
          if (plan.project) jobs.push(hub.refreshProject())
          // P58：详情排在名册之后。删除队友的事件里带着它的 id，先看到新名册才知道它已经没了，
          // 同时发出去就会白打一次报错请求。
          for (const botId of plan.bots) jobs.push(rosterDone.then(() => hub.refreshBot(botId)))
          for (const threadId of plan.threads) jobs.push(hub.refreshThread(threadId))
          if (plan.inbox) jobs.push(hub.refreshInbox())
          if (plan.activity) jobs.push(hub.refreshActivity())
          if (plan.settings) jobs.push(hub.refreshSettings())
          // 账本变化：重拉已经展开过的那些（通常只有一个，失败只影响那一块）。
          if (plan.ledgers) {
            for (const wakeId of Object.keys(store.getSnapshot().ledgers)) jobs.push(hub.refreshLedgerDetail(wakeId))
          }
          await Promise.all(jobs)
        } catch (error) { console.error('[agent-hub] 处理变化事件出错:', error) }
      })()
    },
    markDown(reason: 'disabled' | 'starting' | 'failed' | null = null, message: string | null = null) {
      patch({ connectionDown: true, downReason: reason, downMessage: reason === 'failed' ? message : null })
    },
    onReconnected() {
      if (store.getSnapshot().connectionDown) patch({ connectionDown: false, downReason: null, downMessage: null })
      // 断线期间漏掉的变化补拉一遍：全部基础视图 + 设置 + 当前线程 + 当前机器人的
      // 详情；其他已缓存的机器人详情与已展开的账本标为过期（清掉，界面按需重拉），
      // 否则编辑队友里的生命周期按钮会一直停在断线前的旧状态（D07 第 13 条）。
      const { selectedThread: selected, overview: rosterBefore } = store.getSnapshot()
      const viewsDone = hub.refreshAll()
      void hub.refreshSettings()
      const reloadDetails = (): void => {
        store.update(prev => ({ ...prev, bots: {}, ledgers: {}, ledgerErrors: {} }))
        // 重新读选中：名册核对后，它可能已经退回了团队全景。
        const current = store.getSnapshot().selectedThread
        void hub.refreshThread(current)
        if (current !== 'team') void hub.refreshBot(current)
      }
      // P58：断线期间队友可能被删、数据可能被清空，手里有旧名册时要等新名册回来，确认它还在再补拉。
      // 清缓存也要等：页面看到详情缓存空了会立刻按旧名册拉详情，那样又是一次报错请求。
      // 团队线程不依赖名册；手里还没有名册时等也等不出什么，从本地恢复的选中由统一闸门拦住。
      if (selected === 'team' || rosterBefore === null) reloadDetails()
      else void viewsDone.then(reloadDetails)
    },
    async send(threadId, text) {
      const result = await api.command('sendMessage', { threadId, text })
      if (!result.ok) throw new Error(result.error)
      await hub.refreshThread(threadId)
    },
    command(name, input) { return api.command(name, input) },
    selectThread(threadId) {
      selectionSerial += 1
      // 点队友或主题都直接进对话（P64、P63）。切换时清掉目标线程的旧缓存，进去拉最新一页。
      // P60：选了任何线程都离开草稿（包括草稿发出第一句后切进新主题），草稿不留痕迹。
      store.update(prev => {
        if (prev.selectedThread === threadId) return { ...prev, view: 'main', topicDraft: null }
        const threads = { ...prev.threads }
        delete threads[threadId]
        return { ...prev, selectedThread: threadId, view: 'main', threads, topicDraft: null }
      })
      // P63：主题的「已读」由中心页负责，页面真的把这条主题摆出来才算读过。
      // 这里只管核对：手头的项目视图里没有它（刚建好的，或已被删的）就重拉一次，确认没了退回团队全景。
      if (isTopicThreadId(threadId)) {
        if (isMissingTopic(threadId, store.getSnapshot().project)) void hub.refreshProject()
        return
      }
      // P58：手头名册里查不到这个 id（刚建好的，或已被删的）：马上重拉名册核对，确认没了就退回团队全景。
      // 这种情况不发标已读：对一个可能不存在的队友标已读没有意义，失败了还会吞掉这次核对。
      if (isMissingFromRoster(threadId, store.getSnapshot().overview)) { void hub.refreshOverview(); return }
      // 选中即已读：顺手把未读清掉（失败不影响展示）。
      void api.command('markThreadRead', { threadId }).then(() => hub.refreshOverview()).catch(() => undefined)
    },
    /** 加号请求开向导：只加计数，开不开由中心页决定（侧栏收起时也不丢请求）。 */
    requestNewBot() {
      store.update(prev => ({ ...prev, newBotRequest: prev.newBotRequest + 1 }))
    },
    clearNewBotRequest() {
      store.update(prev => (prev.newBotRequest === 0 ? prev : { ...prev, newBotRequest: 0 }))
    },
    /** 工作区组加号请求新建项目：只加计数，表单由项目页打开（唯一实现）。 */
    requestNewProject() {
      store.update(prev => ({ ...prev, newProjectRequest: prev.newProjectRequest + 1 }))
    },
    clearNewProjectRequest() {
      store.update(prev => (prev.newProjectRequest === 0 ? prev : { ...prev, newProjectRequest: 0 }))
    },
    /** 点项目行：进项目页并记下目标项目。 */
    requestProject(projectId) {
      store.update(prev => ({ ...prev, view: 'project', activeProjectId: projectId, topicDraft: null }))
    },
    setActiveProject(projectId) { patch({ activeProjectId: projectId }) },
    /**
     * 开草稿主题（P60）：只改前端状态，不建主题、不发命令。
     * seq 每次加一，同一个项目再点一次也是一张全新的空白聊天。
     * 收掉项目页选中态：中栏已经是聊天了，左栏不该还亮着项目行。
     */
    openTopicDraft(projectId) {
      store.update(prev => ({
        ...prev, view: 'main', activeProjectId: null,
        topicDraft: { projectId, seq: (prev.topicDraft?.seq ?? 0) + 1 },
      }))
    },
    /** 换页时收掉项目选中态（P44-R2）：不这样做，离开项目页后左栏还会亮着旧行。换页也离开草稿（P60）。 */
    setView(view) {
      store.update(prev => ({ ...prev, view, activeProjectId: null, topicDraft: null }))
    },
    dismissToast(id) { store.update(prev => ({ ...prev, toasts: prev.toasts.filter(t => t.id !== id) })) },
  }
  return hub
}

/** SSE 断线重连的退避间隔（D05 第 12 条）：1/2/5/10 秒，之后稳定在 10 秒。 */
const RECONNECT_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000]
/** 连续连不上多久才把整页换成「连不上」（D05 第 12 条：短断线不打扰主人）。 */
const DOWN_AFTER_MS = 30_000

/**
 * 建立唯一一条 SSE 连接（index.tsx 放进 ctx.effect）。
 * 断开后按 1/2/5/10 秒退避重连；重连成功清除断开态并补拉；只有连续 30 秒连不上
 * 才 markDown 显示「连不上」——不能一断就整页报错。
 */
export function connectEvents(hub: HubStore): () => void {
  let closed = false
  let source: EventSource | null = null
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let attempt = 0
  let downTimer: ReturnType<typeof setTimeout> | null = null

  const clearDownTimer = (): void => {
    if (downTimer !== null) { clearTimeout(downTimer); downTimer = null }
  }

  const scheduleReconnect = (): void => {
    if (closed) return
    const wait = RECONNECT_BACKOFF_MS[Math.min(attempt, RECONNECT_BACKOFF_MS.length - 1)]
    attempt += 1
    retryTimer = setTimeout(open, wait)
  }

  const open = (): void => {
    if (closed) return
    try { source = new EventSource('agent-hub/events') } catch (error) {
      console.error('[agent-hub] 建立 SSE 连接失败:', error)
      scheduleReconnect()
      return
    }
    source.onopen = () => {
      attempt = 0
      clearDownTimer()
      hub.onReconnected()
    }
    source.addEventListener('changed', (event) => {
      try {
        hub.onChanged(JSON.parse((event as MessageEvent<string>).data) as ChangedEvent)
      } catch (error) {
        console.error('[agent-hub] 解析 changed 事件失败:', error)
      }
    })
    source.onerror = () => {
      // 浏览器的自动重连不可控（保活注释会让它永不报错），改为手动关掉再按退避重连。
      try { source?.close() } catch { /* 已关 */ }
      source = null
      if (downTimer === null && !closed) downTimer = setTimeout(() => { if (!closed) hub.markDown(null) }, DOWN_AFTER_MS)
      scheduleReconnect()
    }
  }

  open()
  return () => {
    closed = true
    clearDownTimer()
    if (retryTimer !== null) clearTimeout(retryTimer)
    try { source?.close() } catch { /* 已关 */ }
  }
}

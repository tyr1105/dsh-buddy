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
import type { CommandResult } from '../shared/views.js'
import type { ActivityView, ArtifactListView, BotView, InboxItemView, InboxView, OfficeView, OverviewView, ProjectView, RecentSessionView, ResourceView, SettingsView, ThreadView, WakeLedgerRow, WakeLedgerView } from '../shared/views.js'

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
   * 按唤醒单 id 缓存的账本详情（F02 最小读法）：只在右栏展开某一项时才拉，
   * 不参与全局刷新。null 表示这次唤醒确实没有账本，和「还没拉」严格区分。
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
  /**
   * 主视图里显示哪一面（P33）：thread=对话线程，home=队友主页。
   * 放进仓库而不是页面局部状态，左栏（含宿主侧栏）点谁都能一致地切换。
   */
  mainFace: 'thread' | 'home'
  /** 当前选中的线程（'team' 或机器人 id）。 */
  selectedThread: string
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
   * 左栏工作区当前选中的项目（P44-R2）：点项目行、新建成功后写这里，
   * 项目行据此显示选中态；离开项目页时清空。
   */
  activeProjectId: string | null
  /** 项目定位信号（P44-R2）：每次点项目行/新建成功 +1，项目页据此滚动并高亮目标项目。 */
  projectOpenSeq: number
  /**
   * 当前线程对应的左栏工作会话 id（P44-R2 选中态）：侧栏据此高亮那条子行。
   * 只有在主视图的线程面才成立；切到主页、别的页面或普通线程时清空。
   */
  activeTaskId: string | null
  /**
   * 左栏点开一条工作会话（P44）：侧栏在宿主里、页面在另一处，
   * 中间靠这个信号交接——页面消费一次后清空，和 inboxFocus 同一模式。
   * taskId 让同一队友、同一项目下的多条会话各有落点，不会都落到同一个线程。
   * serial 让「连续点同一条会话」也能触发一次新的定位。
   */
  sessionOpen: { botId: string; projectId: string; taskId: string; wakeId: string | null; serial: number } | null
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
  /** 拉一次唤醒的账本详情（右栏展开时按需调用）。 */
  refreshLedgerDetail(wakeId: string): Promise<void>
  /**
   * 某个队友当前可读的产物索引（F08 尾巴「关联产物」弹窗用）。
   * 按需直读 api，不写进全局状态：只有弹窗打开时才需要，没必要参与整页刷新。
   */
  botArtifacts(botId: string): Promise<ArtifactListView | null>
  /**
   * 某个队友最近的唤醒账本行（P36 轨迹面板用）。和 botArtifacts 一样按需直读，
   * 不进全局状态：轨迹只在打开面板时读一次，没必要参与整页刷新。
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
  /** 打开某个队友的主页（P33）：不标记线程已读，只有真正进线程才算读过。 */
  selectTeammate(botId: string): void
  /** 请求打开「新建队友」向导（P37）：宿主侧栏加号与中心页之间的唯一信号。 */
  requestNewBot(): void
  /** HubPage 接住新建队友请求后清零（P53）：重挂载不会再弹一次。 */
  clearNewBotRequest(): void
  /** 请求打开「新建项目」表单（P44-R2）：工作区组标题加号与项目页之间的唯一信号。 */
  requestNewProject(): void
  /** HubPage 接住新建项目请求后清零（P53）：重挂载不会再弹一次。 */
  clearNewProjectRequest(): void
  /** 点左栏项目行（P44-R2）：切到项目页、记下选中的项目并发出定位信号。 */
  requestProject(projectId: string): void
  /** 新建项目成功后选中它（P44-R2）：只改选中态，不再触发一次额外滚动。 */
  setActiveProject(projectId: string | null): void
  /** 记录当前线程对应的左栏会话（P44-R2 选中态）；传 null 清空。 */
  setActiveTask(taskId: string | null): void
  /**
   * 从左栏打开一条工作会话（P44）：切到该队友的线程并记下项目、任务与唤醒，
   * 页面消费 sessionOpen 后负责展开右栏、标记「返回队友主页」并显示这条任务的上下文。
   */
  requestWorkSession(botId: string, projectId: string, taskId: string, wakeId: string | null): void
  /** 页面消费完一次会话定位后清空，避免重挂载又被旧目标拽回去。 */
  clearWorkSession(): void
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
    view: 'main', mainFace: 'thread', selectedThread: 'team', newBotRequest: 0, newProjectRequest: 0,
    activeProjectId: null, projectOpenSeq: 0, activeTaskId: null,
    sessionOpen: null, toasts: [],
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
    async refreshOverview() { await guard(async () => ({ overview: await api.overview() })) },
    /** 办公室投影（F03）：一次拉一屏，失败走通用 guard（整页提示与重试）。 */
    async refreshOffice() { await guard(async () => ({ office: await api.office() })) },
    /** 资料授权矩阵：失败走通用 guard，页面显示中文错误与「重试」。 */
    async refreshResource() { await guard(async () => ({ resource: await api.resource() })) },
    /** 项目容器：失败同样走通用 guard（整页提示与重试），不做局部容错。 */
    async refreshProject() { await guard(async () => ({ project: await api.project() })) },
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
      try {
        const view = await api.bot(botId)
        store.update(prev => ({ ...prev, bots: { ...prev.bots, [botId]: view } }))
        if (store.getSnapshot().connectionDown) patch({ connectionDown: false, downReason: null, downMessage: null })
      } catch (error) {
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
        const message = error instanceof Error ? error.message : String(error)
        console.error('[agent-hub] 拉取线程失败:', error)
        patch({ connectionDown: true, downReason: reasonOfError(message), downMessage: reasonOfError(message) === 'failed' ? message : null })
      }
    },
    /**
     * 账本详情（F02 最小读法）：只在右栏展开一次唤醒时按需拉，不进全局刷新。
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
    /** 关联产物弹窗：一次拉该队友的产物索引；读不到就返回 null，由弹窗显示原因。 */
    async botArtifacts(botId) {
      const view = await api.bot(botId)
      return view.artifacts ?? null
    },
    /**
     * 轨迹面板的数据口：一次拉该队友的唤醒账本行，页面拿去做本地自然日分组。
     * 失败原样抛给面板，由面板在自己的范围里显示「读不到」并给重试，不标整页断开。
     */
    wakeRows(botId) {
      return api.wakeLedger(botId)
    },
    onChanged(event) {
      void (async () => {
        try {
          // D06 第 5 条：按 core 的九范围词表（HUB_EVENT_SCOPES）定向刷新，
          // 不再匹配内部表名；映射规则集中在 refreshPlan（可单测）。
          const plan = refreshPlan(event.scope, event.botId)
          const jobs: Array<Promise<void>> = []
          if (plan.overview) jobs.push(hub.refreshOverview())
          if (plan.office) jobs.push(hub.refreshOffice())
          // 资料变化在 core 里发的是 overview scope：计划里 resource 与 overview 同口径。
          if (plan.resource) jobs.push(hub.refreshResource())
          // 项目/任务变化发 project scope：定向刷项目页（计划里同时带总览）。
          if (plan.project) jobs.push(hub.refreshProject())
          for (const botId of plan.bots) jobs.push(hub.refreshBot(botId))
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
      // 否则右栏的生命周期按钮会一直停在断线前的旧状态（D07 第 13 条）。
      const selected = store.getSnapshot().selectedThread
      store.update(prev => ({ ...prev, bots: {}, ledgers: {}, ledgerErrors: {} }))
      void hub.refreshAll()
      void hub.refreshSettings()
      void hub.refreshThread(selected)
      if (selected !== 'team') void hub.refreshBot(selected)
    },
    async send(threadId, text) {
      const result = await api.command('sendMessage', { threadId, text })
      if (!result.ok) throw new Error(result.error)
      await hub.refreshThread(threadId)
    },
    command(name, input) { return api.command(name, input) },
    selectThread(threadId) {
      // 进线程就是「对话」面（P33）；主页只由 selectTeammate 进入。
      // 普通线程不对应左栏某条工作会话，顺手清掉子行选中态（P44-R2）。
      store.update(prev => {
        if (prev.selectedThread === threadId) return { ...prev, view: 'main', mainFace: 'thread', activeTaskId: null }
        const threads = { ...prev.threads }
        delete threads[threadId]
        return { ...prev, selectedThread: threadId, view: 'main', mainFace: 'thread', threads, activeTaskId: null }
      })
      // 选中即已读：顺手把未读清掉（失败不影响展示）。
      void api.command('markThreadRead', { threadId }).then(() => hub.refreshOverview()).catch(() => undefined)
    },
    /**
     * 打开队友主页（P33）：只切表面，不标记线程已读——主页没有展示消息内容，
     * 把未读清掉会让主人漏掉它说过的话。线程缓存也保留，真正进线程时再按需刷新。
     */
    selectTeammate(botId) {
      store.update(prev => ({ ...prev, selectedThread: botId, view: 'main', mainFace: 'home', activeTaskId: null }))
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
    /** 点项目行：进项目页并记下目标项目，项目页按 projectOpenSeq 滚动定位。 */
    requestProject(projectId) {
      store.update(prev => ({
        ...prev,
        view: 'project',
        activeProjectId: projectId,
        projectOpenSeq: prev.projectOpenSeq + 1,
        activeTaskId: null,
      }))
    },
    setActiveProject(projectId) { patch({ activeProjectId: projectId }) },
    setActiveTask(taskId) { patch({ activeTaskId: taskId }) },
    /**
     * 左栏点工作会话（P44）：一次切到目标线程并写定位信号。
     * 线程缓存要清掉——和 selectThread 一样，进入线程时重新拉最新一页；
     * 但这里不顺手标已读，交给页面消费后再按真实进入行为处理。
     */
    requestWorkSession(botId, projectId, taskId, wakeId) {
      store.update(prev => {
        const threads = { ...prev.threads }
        delete threads[botId]
        const serial = (prev.sessionOpen?.serial ?? 0) + 1
        return {
          ...prev,
          selectedThread: botId,
          view: 'main',
          mainFace: 'thread',
          // 左栏子行选中态（P44-R2）：点开哪条会话就选中哪条，刷新后仍能看出当前线程。
          activeTaskId: taskId,
          activeProjectId: projectId,
          sessionOpen: { botId, projectId, taskId, wakeId, serial },
          threads,
        }
      })
    },
    clearWorkSession() {
      store.update(prev => (prev.sessionOpen === null ? prev : { ...prev, sessionOpen: null }))
    },
    /**
     * 换页时收掉左栏选中态（P44-R2）：项目选中只在项目页成立，
     * 会话选中只在主视图成立；不这样做，从项目页或线程页离开后左栏还会亮着旧行。
     */
    setView(view) {
      store.update(prev => ({
        ...prev,
        view,
        activeProjectId: null,
        activeTaskId: view === 'main' ? prev.activeTaskId : null,
      }))
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

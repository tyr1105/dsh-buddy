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
import type { ActivityView, BotView, InboxItemView, InboxView, OverviewView, RecentSessionView, SettingsView, ThreadView } from '../shared/views.js'

/** 应用内提示（shell.overlay 上的一条，4 秒自动消失）。 */
export interface HubToast { id: string; text: string; inboxItemId: string }

export type PageView = 'main' | 'inbox' | 'activity' | 'settings'

export interface HubState {
  overview: OverviewView | null
  inbox: InboxView | null
  activity: ActivityView | null
  settings: SettingsView | null
  recentSessions: RecentSessionView[]
  bots: Record<string, BotView>
  threads: Record<string, ThreadView>
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
  /** 当前页面视图（主视图 / 收件箱 / 活动流 / 设置）。 */
  view: PageView
  /** 当前选中的线程（'team' 或机器人 id）。 */
  selectedThread: string
  /** 应用内提示列表（顶部 4 秒提示）。 */
  toasts: HubToast[]
}

export type HubStore = Store<HubState> & {
  refreshOverview(): Promise<void>
  refreshInbox(): Promise<void>
  refreshActivity(before?: string): Promise<void>
  refreshSettings(): Promise<void>
  refreshRecentSessions(): Promise<void>
  refreshBot(botId: string): Promise<void>
  refreshThread(threadId: string, before?: string): Promise<void>
  refreshAll(): Promise<void>
  onChanged(event: ChangedEvent): void
  markDown(reason?: 'disabled' | 'starting' | 'failed' | null, message?: string | null): void
  /** SSE 重连成功（D05 第 12 条）：清除断开态并补拉全部与当前线程。 */
  onReconnected(): void
  send(threadId: string, text: string): Promise<void>
  command(name: string, input: Record<string, unknown>): Promise<CommandResult>
  selectThread(threadId: string): void
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
    overview: null, inbox: null, activity: null, settings: null, recentSessions: [], bots: {}, threads: {},
    connectionDown: false, downReason: null, downMessage: null, settingsError: null,
    view: 'main', selectedThread: 'team', toasts: [],
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
    async refreshInbox() {
      const prevItems = store.getSnapshot().inbox?.items ?? null
      await guard(async () => applyInbox(await api.inbox(), prevItems))
    },
    async refreshActivity(before?) {
      try {
        const next = await api.activity(before ? { before } : undefined)
        // 「加载更多」：旧一页接在已有列表后面（合并在 updater 里做，D07 第 9 条）；
        // 首拉直接替换。
        if (!before) patch({ activity: next })
        else store.update(prev => ({
          ...prev,
          activity: prev.activity === null ? next : { rows: [...prev.activity.rows, ...next.rows], hasMore: next.hasMore },
        }))
        if (store.getSnapshot().connectionDown) patch({ connectionDown: false, downReason: null, downMessage: null })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error('[agent-hub] 拉取活动流失败:', error)
        patch({ connectionDown: true, downReason: reasonOfError(message), downMessage: reasonOfError(message) === 'failed' ? message : null })
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
    async refreshAll() {
      await Promise.all([hub.refreshOverview(), hub.refreshInbox(), hub.refreshActivity()])
    },
    onChanged(event) {
      void (async () => {
        try {
          // D06 第 5 条：按 core 的六范围词表（HUB_EVENT_SCOPES）定向刷新，
          // 不再匹配内部表名；映射规则集中在 refreshPlan（可单测）。
          const plan = refreshPlan(event.scope, event.botId)
          const jobs: Array<Promise<void>> = []
          if (plan.overview) jobs.push(hub.refreshOverview())
          for (const botId of plan.bots) jobs.push(hub.refreshBot(botId))
          for (const threadId of plan.threads) jobs.push(hub.refreshThread(threadId))
          if (plan.inbox) jobs.push(hub.refreshInbox())
          if (plan.activity) jobs.push(hub.refreshActivity())
          if (plan.settings) jobs.push(hub.refreshSettings())
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
      // 详情；其他已缓存的机器人详情标为过期（清掉，选中时 HubPage 会重拉），
      // 否则右栏的生命周期按钮会一直停在断线前的旧状态（D07 第 13 条）。
      const selected = store.getSnapshot().selectedThread
      store.update(prev => ({ ...prev, bots: {} }))
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
      // 切换线程时重置该线程的已加载历史（D07 第 14 条）：合并只在同一线程内进行，
      // 切走再回来要拿最新一页，避免跨线程拼出脏数据。重复点同一线程不重置
      //（主人翻出来的更早历史不能因为又点了一下左栏就被冲掉）。
      store.update(prev => {
        if (prev.selectedThread === threadId) return { ...prev, view: 'main' }
        const threads = { ...prev.threads }
        delete threads[threadId]
        return { ...prev, selectedThread: threadId, view: 'main', threads }
      })
      // 选中即已读：顺手把未读清掉（失败不影响展示）。
      void api.command('markThreadRead', { threadId }).then(() => hub.refreshOverview()).catch(() => undefined)
    },
    setView(view) { patch({ view }) },
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

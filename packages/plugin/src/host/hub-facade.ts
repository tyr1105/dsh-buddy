/**
 * HubFacade：界面接口要用的门面。宿主路由只调它，不关心背后是样例还是真引擎。
 * D01 提供 FixtureHub（样例数据模式）；D02 会提供接真实引擎的实现，路由与界面都不改。
 */
import type {
  ActivityView, BotView, CommandResult, InboxView, OverviewView, RecentSessionView, SettingsView, ThreadMessageView, ThreadView,
} from '../shared/views.js'
import {
  fixtureActivity, fixtureBots, fixtureInbox, fixtureOverview, fixtureRecentSessions, fixtureSettings, fixtureThreads,
} from '../shared/fixtures.js'

/** 变化事件：告诉界面哪个范围的数据变了（scope ∈ overview | thread | inbox | activity | bot | settings）。 */
export interface ChangedEvent { scope: string; botId?: string }

export type ChangeListener = (event: ChangedEvent) => void

export interface HubFacade {
  overview(): Promise<OverviewView>
  bot(botId: string): Promise<BotView>
  thread(threadId: string, opts?: { before?: string; limit?: number }): Promise<ThreadView>
  inbox(): Promise<InboxView>
  activity(opts?: { before?: string; limit?: number }): Promise<ActivityView>
  settings(): Promise<SettingsView>
  recentSessions(): Promise<RecentSessionView[]>
  command(name: string, input: Record<string, unknown>): Promise<CommandResult>
  /** 订阅变化；返回取消订阅的函数。 */
  subscribe(fn: ChangeListener): () => void
}

/** 深拷贝一份样例，避免界面拿到会被后续操作改动的对象。 */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/**
 * FixtureHub：返回样例数据的门面实现。
 * command('sendMessage') 会真的把主人消息追加进样例线程，并在 2 秒后追加一条机器人回复，
 * 并发出 changed 事件——用于在沙箱里看实时推送（SSE）效果。
 * 其余命令一律返回 { ok: true }（D01 不接真引擎）。
 */
export class FixtureHub implements HubFacade {
  private threads: ThreadView[] = clone(fixtureThreads)
  private listeners = new Set<ChangeListener>()
  private seq = 0
  /** 定时器句柄：宿主卸载时由 index.ts 清理，避免泄漏。 */
  readonly pendingTimers = new Set<ReturnType<typeof setTimeout>>()

  private emit(event: ChangedEvent): void {
    for (const fn of [...this.listeners]) {
      try { fn(event) } catch (error) { console.error('[agent-hub] 订阅回调出错:', error) }
    }
  }

  subscribe(fn: ChangeListener): () => void {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }

  private findThread(threadId: string): ThreadView | undefined {
    return this.threads.find((t) => t.threadId === threadId)
  }

  async overview(): Promise<OverviewView> { return clone(fixtureOverview) }

  async bot(botId: string): Promise<BotView> {
    const view = fixtureBots[botId]
    if (!view) throw new Error(`没有这个机器人：${botId}`)
    return clone(view)
  }

  async thread(threadId: string, opts?: { before?: string; limit?: number }): Promise<ThreadView> {
    const t = this.findThread(threadId)
    if (!t) throw new Error(`没有这个线程：${threadId}`)
    const limit = Math.max(1, Math.min(opts?.limit ?? 50, 100))
    let msgs = [...t.messages]
    if (opts?.before) {
      const i = msgs.findIndex((m) => m.id === opts.before)
      if (i >= 0) msgs = msgs.slice(0, i)
    }
    const page = msgs.slice(-limit)
    const oldest = page[0]
    return clone({
      threadId: t.threadId, title: t.title, messages: page,
      hasMore: msgs.length > page.length, oldestId: oldest ? oldest.id : null,
    })
  }

  async inbox(): Promise<InboxView> { return clone(fixtureInbox) }

  async activity(opts?: { before?: string; limit?: number }): Promise<ActivityView> {
    const limit = Math.max(1, Math.min(opts?.limit ?? 30, 100))
    let rows = [...fixtureActivity.rows].sort((a, b) => b.at - a.at)
    if (opts?.before) {
      const i = rows.findIndex((r) => r.id === opts.before)
      if (i >= 0) rows = rows.slice(i + 1)
    }
    const page = rows.slice(0, limit)
    return clone({ rows: page, hasMore: rows.length > page.length })
  }

  async settings(): Promise<SettingsView> { return clone(fixtureSettings) }

  async recentSessions(): Promise<RecentSessionView[]> { return clone(fixtureRecentSessions) }

  async command(name: string, input: Record<string, unknown>): Promise<CommandResult> {
    if (name === 'sendMessage') {
      const threadId = String(input.threadId ?? '')
      const text = String(input.text ?? '').trim()
      if (!threadId) return { ok: false, error: 'threadId 不能为空' }
      if (!text) return { ok: false, error: '消息内容不能为空' }
      const t = this.findThread(threadId)
      if (!t) return { ok: false, error: `没有这个线程：${threadId}` }
      // 1) 主人消息立刻进线程。
      const ownerId = `own-${Date.now()}-${this.seq++}`
      t.messages.push({
        id: ownerId, thread: t.threadId, from: 'owner', fromName: '我', fromColor: null,
        kind: 'chat', text, createdAt: Date.now(), timeText: '刚刚', card: null,
      })
      this.emit({ scope: 'thread', botId: threadId })
      this.emit({ scope: 'overview' })
      // 2) 2 秒后追加一条机器人的样例回复（看实时推送效果用）。
      const timer = setTimeout(() => {
        this.pendingTimers.delete(timer)
        const bot = fixtureOverview.bots.find((b) => b.id === threadId)
        const fromName = t.threadId === 'team' ? '总管' : (bot?.name ?? '队友')
        const fromColor = bot?.color ?? 'var(--dsw-alias-accent)'
        t.messages.push({
          id: `bot-${Date.now()}-${this.seq++}`, thread: t.threadId, from: bot?.id ?? 'hub',
          fromName, fromColor, kind: 'reply',
          text: '（样例回复）收到。这是 D01 样例数据模式的自动回应，接上真实引擎后就是它的真话了。',
          createdAt: Date.now(), timeText: '刚刚', card: null,
        })
        this.emit({ scope: 'thread', botId: threadId })
        this.emit({ scope: 'overview' })
      }, 2000)
      this.pendingTimers.add(timer)
      return { ok: true }
    }
    // 其余命令：D01 一律成功（不接真引擎）。
    return { ok: true }
  }
}

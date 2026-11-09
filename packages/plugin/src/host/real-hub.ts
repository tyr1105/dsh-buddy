/**
 * 真引擎门面：把 D01 的 HubFacade 接口接到 core Hub 的 UiApi 上（字段不变，
 * 路由与界面零改动）。包含三件东西：
 * - RealHubFacade：视图直通 hub.api；command(name, input) 用命令表分发并在边界
 *   校验参数（中文错误）；subscribe 直通 hub.subscribe（SSE 由此驱动）。
 * - LazyHubFacade：apply 时引擎还没起（init 是异步的），路由先挂在一个可延迟
 *   赋值的门面上；未就绪时访问返回中文错误而不是崩。
 * - DisabledHub：rootDir/.hub/DISABLED 存在时只提供界面（显示已停用），不启动引擎。
 */
import type { Hub, UiApi, CommandResult } from '@agent-hub/core'
import type { BotView, SettingsView, ThreadView } from '../shared/views.js'
import type { HubFacade, ChangedEvent, ChangeListener } from './hub-facade.js'

// ---------- 参数校验小工具（中文错误，说清哪一项不对） ----------

const bad = (error: string): CommandResult => ({ ok: false, error })

function reqStr(input: Record<string, unknown>, key: string): string {
  const value = input[key]
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${key}：必须是 non-empty 字符串`)
  return value
}

function optStr(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(`${key}：必须是字符串`)
  return value
}

function reqBool(input: Record<string, unknown>, key: string): boolean {
  const value = input[key]
  if (typeof value !== 'boolean') throw new Error(`${key}：必须是布尔值`)
  return value
}

/** 命令表：name → (api, input)。每条都在边界校验，UiApi 内部还会用 zod 再校验一次。 */
export function dispatchCommand(api: UiApi, name: string, raw: Record<string, unknown>): Promise<CommandResult> {
  const run = (work: () => Promise<CommandResult>): Promise<CommandResult> =>
    work().catch(error => bad(error instanceof Error ? error.message : String(error)))
  try {
    switch (name) {
      case 'createBot': return run(() => api.createBot(raw))
      case 'updateBot': return run(() => api.updateBot(reqStr(raw, 'botId'), raw.patch))
      case 'setLifecycle': return run(() => api.setLifecycle(reqStr(raw, 'botId'), reqStr(raw, 'lifecycle') as never))
      // M07：生命周期动作与主人打断都改走 core 的命令入口（UiApi 内部再用 zod 校验）。
      case 'lifecycleAction': return run(() => api.lifecycleAction(raw))
      case 'interruptBot': return run(() => api.interruptBot(raw))
      case 'sendMessage': return run(() => api.sendMessage(reqStr(raw, 'threadId'), reqStr(raw, 'text')))
      case 'answerInbox': return run(() => api.answerInbox(reqStr(raw, 'id'), reqStr(raw, 'answer')))
      case 'decideApproval': return run(() => api.decideApproval(reqStr(raw, 'id'), reqBool(raw, 'approve'), optStr(raw, 'note')))
      case 'upsertAspiration': return run(() => api.upsertAspiration(raw))
      case 'upsertGoal': return run(() => api.upsertGoal(raw))
      case 'closeGoal': return run(() => api.closeGoal(reqStr(raw, 'id'), raw.outcome as boolean | 'done' | 'active' | 'abandoned'))
      case 'upsertWatch': return run(() => api.upsertWatch(raw))
      case 'decideWatchProposal': return run(() => api.decideWatchProposal(reqStr(raw, 'id'), reqBool(raw, 'approve')))
      case 'upsertRule': return run(() => api.upsertRule(raw))
      case 'editRoutine': return run(() => api.editRoutine(reqStr(raw, 'id'), raw.patch))
      case 'teach': return run(() => api.teach(reqStr(raw, 'botId'), reqStr(raw, 'sessionId'), reqStr(raw, 'note')))
      case 'pokeBot': return run(() => api.pokeBot(reqStr(raw, 'botId'), optStr(raw, 'text')))
      case 'updateSettings': return run(() => api.updateSettings(raw))
      case 'markThreadRead': return run(() => api.markThreadRead(reqStr(raw, 'threadId')))
      default: return Promise.resolve(bad(`未知命令：${name}；请更新插件后重试`))
    }
  } catch (error) {
    return Promise.resolve(bad(error instanceof Error ? error.message : String(error)))
  }
}

// ---------- 真引擎门面 ----------

/** 推送渠道直读存储的最小形状（core 的 FileStore.settings 表；D07 第 6 条）。 */
export interface PushChannelStore {
  table(name: 'settings'): { get(id: string): { pushChannel?: unknown } | null | undefined }
}

export class RealHubFacade implements HubFacade {
  /**
   * 推送渠道缓存（D06 第 1 条 / D07 第 6 条）：直接同步读引擎存储的 settings 行
   * （updateSettings 落的是整份设置），**不走会读宿主模型目录的 settings() 视图**，
   * 也不依赖有没有 SSE 订阅者——目录坏了「不推送」的设置照样生效。读不到时保持
   * 上次读到的值；从未读到过按「不推送」（none）处理，绝不默认推送。
   */
  private pushChannelCache: string = 'none'

  constructor(private readonly hub: Hub, store?: PushChannelStore) {
    this.readStoredPushChannel(store)
    // 常驻订阅一次（不挂在 SSE 订阅者上）：主人改设置后立刻刷新缓存。
    try {
      this.hub.subscribe(event => {
        if (event.scope === 'settings') this.readStoredPushChannel(store)
      })
    } catch { /* 订阅失败只影响刷新时机，不影响初值 */ }
  }

  private readStoredPushChannel(store?: PushChannelStore): void {
    try {
      const value = store?.table('settings').get('settings')?.pushChannel
      if (typeof value === 'string' && value !== '') this.pushChannelCache = value
    } catch { /* 读失败保持旧值，绝不阻塞投递 */ }
  }

  async overview() { return this.hub.api.overview() }
  async bot(botId: string) { return this.hub.api.bot(botId) }
  async thread(threadId: string, opts?: { before?: string | number; limit?: number }) {
    return this.hub.api.thread(threadId, opts)
  }
  async inbox() { return this.hub.api.inbox() }
  async activity(opts?: { before?: string | number; limit?: number }) { return this.hub.api.activity(opts) }
  async settings() { return this.hub.api.settings() }
  async recentSessions() { return this.hub.api.recentSessions() }
  async command(name: string, input: Record<string, unknown>): Promise<CommandResult> {
    return dispatchCommand(this.hub.api, name, input)
  }
  subscribe(fn: ChangeListener): () => void {
    return this.hub.subscribe(event => {
      try { fn({ scope: event.scope, botId: event.botId ?? undefined } satisfies ChangedEvent) } catch (error) {
        console.error('[agent-hub] 订阅者回调出错:', error)
      }
    })
  }
  /** 当前推送渠道（同步读缓存；存储直读 + settings 事件刷新，见 pushChannelCache）。 */
  pushChannel(): string { return this.pushChannelCache }
}

// ---------- 可延迟赋值的门面 ----------

const NOT_READY = '中心引擎尚未就绪，请稍后重试'

export class LazyHubFacade implements HubFacade {
  private impl: HubFacade | null = null
  /** 引擎启动失败的原因（D07 第 12 条）：界面要显示失败原因，而不是永远「正在启动」。 */
  private failure: string | null = null
  private readonly extraListeners = new Set<ChangeListener>()
  /** 已挂到当前引擎上的退订函数（listener → off）。换引擎时先全部退掉再重挂。 */
  private readonly engineOffs = new Map<ChangeListener, () => void>()

  /**
   * 接通实现（D05 第 12 条）：把已有订阅逐个挂到新引擎上——引擎就绪前建立的 SSE
   * 连接在就绪后也要能收到 changed 事件，不能只收 emitInApp。
   */
  setImpl(impl: HubFacade): void {
    this.impl = impl
    for (const [listener, off] of [...this.engineOffs]) {
      try { off() } catch { /* 忽略旧引擎退订失败 */ }
      this.engineOffs.delete(listener)
    }
    for (const listener of [...this.extraListeners]) {
      try {
        const off = impl.subscribe(listener)
        if (typeof off === 'function') this.engineOffs.set(listener, off)
      } catch (error) { console.error('[agent-hub] 重挂引擎订阅失败:', error) }
    }
  }

  /** 应用内提示（notify 之后调用）：直接向 SSE 订阅者广播一条 changed 事件。 */
  emitInApp(scope = 'overview'): void {
    for (const fn of [...this.extraListeners]) {
      try { fn({ scope }) } catch (error) { console.error('[agent-hub] 应用内提示回调出错:', error) }
    }
  }

  status(): { ok: boolean; mode: string; error?: string } {
    if (this.failure !== null) return { ok: false, mode: 'failed', error: this.failure }
    if (this.impl === null) return { ok: false, mode: 'starting' }
    if (this.impl instanceof DisabledHub) return { ok: false, mode: 'disabled' }
    return { ok: true, mode: 'engine' }
  }

  /** 引擎启动失败（D07 第 12 条）：记下原因，之后所有视图访问都报「启动失败：原因」。 */
  markFailed(reason: string): void {
    if (this.failure === null) this.failure = reason
  }

  private facade(): HubFacade {
    if (this.failure !== null) throw new Error(`中心引擎启动失败：${this.failure}`)
    if (this.impl === null) throw new Error(NOT_READY)
    return this.impl
  }

  async overview() { return this.facade().overview() }
  async bot(botId: string) { return this.facade().bot(botId) }
  async thread(threadId: string, opts?: { before?: string; limit?: number }) { return this.facade().thread(threadId, opts) }
  async inbox() { return this.facade().inbox() }
  async activity(opts?: { before?: string; limit?: number }) { return this.facade().activity(opts) }
  async settings() { return this.facade().settings() }
  async recentSessions() { return this.facade().recentSessions() }
  async command(name: string, input: Record<string, unknown>) { return this.facade().command(name, input) }
  subscribe(fn: ChangeListener): () => void {
    // 记在本地（emitInApp 与 setImpl 重挂都用它）；引擎已就绪时同时挂到引擎上。
    this.extraListeners.add(fn)
    if (this.impl !== null) {
      try {
        const off = this.impl.subscribe(fn)
        if (typeof off === 'function') this.engineOffs.set(fn, off)
      } catch (error) { console.error('[agent-hub] 引擎订阅失败:', error) }
    }
    return () => {
      this.extraListeners.delete(fn)
      const off = this.engineOffs.get(fn)
      this.engineOffs.delete(fn)
      try { off?.() } catch { /* 忽略 */ }
    }
  }
}

// ---------- 停用门面：rootDir/.hub/DISABLED 存在时 ----------

const emptyOverview = {
  bots: [], inbox: { total: 0, approvals: 0, questions: 0, proposals: 0, alerts: 0 },
  team: { unread: 0, lastMessageText: null }, quota: { light: 'green', lightLabel: '未知', usedText: '已停用', resetText: null },
  health: { ok: false, heartbeatText: '已停用', downtimeText: null, openAlerts: 0 },
  nowText: '已停用', quietNow: false, pushesLeftToday: 0,
}

export class DisabledHub implements HubFacade {
  constructor(private readonly reason: string) {}
  private denied<T>(): T { throw new Error(this.reason) }
  async overview() { return structuredClone(emptyOverview) as never }
  async bot(_botId: string): Promise<BotView> { return this.denied() }
  async thread(_threadId: string, _opts?: { before?: string; limit?: number }): Promise<ThreadView> { return this.denied() }
  async inbox() { return { items: [] } }
  async activity() { return { rows: [], hasMore: false } }
  async settings(): Promise<SettingsView> { return this.denied() }
  async recentSessions() { return [] }
  async command(): Promise<CommandResult> { return { ok: false, error: this.reason } }
  subscribe(): () => void { return () => undefined }
}

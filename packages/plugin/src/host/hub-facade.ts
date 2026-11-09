/**
 * HubFacade：界面接口要用的门面。宿主路由只调它，不关心背后是样例还是真引擎。
 * D01 提供 FixtureHub（样例数据模式）；D02 会提供接真实引擎的实现，路由与界面都不改。
 */
import { createHash } from 'node:crypto'
import type {
  ActivityView, BotView, CommandResult, InboxView, OfficeView, OverviewView, ProjectContext, ProjectView, ProjectViewRow,
  RecentSessionView, ResourceView, SettingsView, ThreadMessageView, ThreadView, WakeLedgerRow, WakeLedgerView,
} from '../shared/views.js'
import {
  fixtureActivity, fixtureBots, fixtureInbox, fixtureOverview, fixtureRecentSessions, fixtureSettings, fixtureThreads,
} from '../shared/fixtures.js'
import { fixtureOffice } from '../shared/fixture-office.js'
import { fixtureResource } from '../shared/fixture-resource.js'
import { fixtureProject } from '../shared/fixture-project.js'
import { fixtureLedgerDetail, fixtureLedgerRows } from '../shared/fixture-ledger.js'

/** 变化事件：告诉界面哪个范围的数据变了（scope ∈ overview | thread | inbox | activity | bot | settings | ledger）。 */
export interface ChangedEvent { scope: string; botId?: string }

export type ChangeListener = (event: ChangedEvent) => void

export interface HubFacade {
  overview(): Promise<OverviewView>
  bot(botId: string): Promise<BotView>
  thread(threadId: string, opts?: { before?: string; limit?: number }): Promise<ThreadView>
  inbox(): Promise<InboxView>
  activity(opts?: { before?: string; limit?: number }): Promise<ActivityView>
  settings(): Promise<SettingsView>
  /** 办公室纯投影（F03）：座位就是一位在岗队友，另有灯、桌上产出与门口信箱。 */
  office(): Promise<OfficeView>
  /** 资料授权矩阵（V2-PH2-04）：资料列表（未归档在前）、授权展开行与计数。 */
  resource(): Promise<ResourceView>
  /** 项目容器（V2-PH4-02）：项目分区、成员/验收项/任务展开、问题与计数。 */
  project(): Promise<ProjectView>
  recentSessions(): Promise<RecentSessionView[]>
  /** 某机器人的账本摘要（按封存时间倒序），用于右栏「为什么醒 / 为什么没醒」。 */
  wakeLedger(botId: string, opts?: { limit?: number; before?: number }): Promise<WakeLedgerRow[]>
  /** 一次唤醒的完整账本；没有账本时返回 null，界面显示「没有账本记录」。 */
  wakeLedgerDetail(wakeId: string): Promise<WakeLedgerView | null>
  command(name: string, input: Record<string, unknown>): Promise<CommandResult>
  /** 订阅变化；返回取消订阅的函数。 */
  subscribe(fn: ChangeListener): () => void
}

/** 深拷贝一份样例，避免界面拿到会被后续操作改动的对象。 */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/**
 * 样例模式的上下文变更摘要：与 core describeContextChange 同口径的简版，
 * 只用于浏览器走查时留痕那一行的人话，不参与真实判定。
 */
function describeContextChange(before: ProjectContext, after: ProjectContext): string {
  const parts: string[] = []
  if (before.background !== after.background) parts.push('背景')
  if (before.conventions !== after.conventions) parts.push('约定')
  if (before.decisions.map(d => d.text).join('\n') !== after.decisions.map(d => d.text).join('\n')) {
    const delta = after.decisions.length - before.decisions.length
    parts.push(delta === 0 ? '决策内容' : `决策 ${delta > 0 ? '+' : ''}${delta}`)
  }
  if (before.glossary.map(g => `${g.term}：${g.meaning}`).join('\n') !== after.glossary.map(g => `${g.term}：${g.meaning}`).join('\n')) {
    const delta = after.glossary.length - before.glossary.length
    parts.push(delta === 0 ? '术语内容' : `术语 ${delta > 0 ? '+' : ''}${delta}`)
  }
  return parts.length === 0 ? '内容未变' : `修改：${parts.join('、')}`
}

/** 样例模式的正文哈希：只用于显示前 8 位，真实哈希由 core 的 context.md 计算。 */
function fixtureContextHash(context: ProjectContext): string {
  return createHash('sha256').update(JSON.stringify(context)).digest('hex')
}

/** 一个项目的四段是否全空（与 core isProjectContextEmpty 同口径）。 */
function contextIsEmpty(context: ProjectContext): boolean {
  return context.background.trim() === '' && context.conventions.trim() === ''
    && context.decisions.length === 0 && context.glossary.length === 0
}

/**
 * FixtureHub：返回样例数据的门面实现。
 * command('sendMessage') 会真的把主人消息追加进样例线程，并在 2 秒后追加一条机器人回复，
 * 并发出 changed 事件——用于在沙箱里看实时推送（SSE）效果。
 * 其余命令一律返回 { ok: true }（D01 不接真引擎）。
 */
export class FixtureHub implements HubFacade {
  private threads: ThreadView[] = clone(fixtureThreads)
  /** 样例项目可变副本：共享上下文的编辑/采纳/驳回要在沙箱里真的改到视图上。 */
  private projectView: ProjectView = clone(fixtureProject)
  /** P40：样例机器人的可变副本，档案里保存的预置 skill 要能重新打开时看到。 */
  private botViews: Record<string, BotView> = clone(fixtureBots)
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
    const view = this.botViews[botId]
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

  async office(): Promise<OfficeView> { return clone(fixtureOffice) }

  /** 样例资料授权矩阵：沙箱里也能看普通/受限资料、授权 chips 与归档区。 */
  async resource(): Promise<ResourceView> { return clone(fixtureResource) }

  /** 样例项目容器：沙箱里也能看四分区、待验收任务与失效队友问题；P39 上下文可编辑。 */
  async project(): Promise<ProjectView> { return clone(this.projectView) }

  async recentSessions(): Promise<RecentSessionView[]> { return clone(fixtureRecentSessions) }

  /** 样例账本：与核心列表同样的 limit / before 语义，沙箱里也能验证翻页。 */
  async wakeLedger(botId: string, opts?: { limit?: number; before?: number }): Promise<WakeLedgerRow[]> {
    if (!fixtureBots[botId]) throw new Error(`没有这个机器人：${botId}`)
    const timeOf = (row: WakeLedgerRow): number => row.sealedAt ?? row.openedAt
    let rows = fixtureLedgerRows(botId)
    if (opts?.before !== undefined) rows = rows.filter(row => timeOf(row) < opts.before!)
    if (opts?.limit !== undefined) rows = rows.slice(0, Math.max(1, Math.min(opts.limit, 100)))
    return clone(rows)
  }

  async wakeLedgerDetail(wakeId: string): Promise<WakeLedgerView | null> {
    return clone(fixtureLedgerDetail(wakeId))
  }

  /**
   * 样例模式追加一条上下文留痕：同时改项目里的 contextRevisions 与视图行。
   * 真实引擎还会把四段渲染成 context.md 写进项目目录；样例模式不碰文件系统，
   * 只让浏览器走查能看到「改了什么、谁改的、什么时候、摘要与哈希」。
   */
  private appendContextRevision(
    row: ProjectViewRow,
    editor: { id: string; kind: 'owner' | 'bot' },
    source: 'owner_edit' | 'bot_proposal',
    context: ProjectContext,
    summary: string,
  ): void {
    const at = Date.now()
    const hash = fixtureContextHash(context)
    const revision = {
      id: `pcr_demo_${this.seq++}`, at, editorId: editor.id, editorKind: editor.kind,
      summary, hash, source,
    } as const
    row.project.context = context
    row.project.contextRevisions = [...row.project.contextRevisions, revision].slice(-50)
    row.context = context
    row.contextEmpty = contextIsEmpty(context)
    const editorName = editor.kind === 'owner'
      ? '主人'
      : (row.members.find(member => member.botId === editor.id)?.name ?? '已删除的队友')
    row.contextRevisions = [{
      revision,
      editorName,
      editorKindLabel: editor.kind === 'owner' ? '主人' : '队友',
      sourceLabel: source === 'owner_edit' ? '主人编辑' : '采纳队友建议',
      timeText: '刚刚',
      hashShort: hash.slice(0, 8),
    }, ...row.contextRevisions]
  }

  /** 样例模式的四段合并：带 id 的决策保留原时间与来源，新决策记主人，未知 id 直接拒绝。 */
  private mergeContextInput(before: ProjectContext, input: Record<string, unknown>): ProjectContext {
    const now = Date.now()
    const existing = new Map(before.decisions.map(decision => [decision.id, decision]))
    const rawDecisions = Array.isArray(input.decisions) ? input.decisions as Array<Record<string, unknown>> : []
    const decisions = rawDecisions.map((item, index) => {
      const text = String(item.text ?? '').trim()
      const id = typeof item.id === 'string' && item.id !== '' ? item.id : null
      if (id !== null) {
        const old = existing.get(id)
        if (!old) throw new Error('决策不属于该项目，不能修改')
        return { ...old, text }
      }
      return { id: `dc_demo_${now}_${index}`, text, by: 'owner', at: now }
    })
    const rawGlossary = Array.isArray(input.glossary) ? input.glossary as Array<Record<string, unknown>> : []
    return {
      background: typeof input.background === 'string' ? input.background : before.background,
      conventions: typeof input.conventions === 'string' ? input.conventions : before.conventions,
      decisions,
      glossary: rawGlossary.map(entry => ({
        term: String(entry.term ?? '').trim(),
        meaning: String(entry.meaning ?? '').trim(),
      })),
    }
  }

  /** P39：样例模式的上下文编辑与建议处理（真实引擎由 core 落文件、记审计）。 */
  private commandContext(name: string, input: Record<string, unknown>): CommandResult | null {
    try {
      if (name === 'saveProjectContext') {
        const projectId = String(input.projectId ?? '')
        const row = this.projectView.projects.find(item => item.project.id === projectId)
        if (!row) return { ok: false, error: `项目不存在：${projectId}` }
        if (row.project.status === 'archived') return { ok: false, error: '项目已归档，只能恢复后再编辑共享上下文' }
        const before = row.project.context
        const context = this.mergeContextInput(before, input)
        // 内容没变就不留痕（与 core 同口径）。
        if (fixtureContextHash(context) === fixtureContextHash(before)) return { ok: true }
        this.appendContextRevision(row, { id: 'owner', kind: 'owner' }, 'owner_edit', context,
          describeContextChange(before, context))
        this.emit({ scope: 'project' })
        return { ok: true }
      }
      if (name === 'approveProjectContextProposal' || name === 'rejectProjectContextProposal') {
        const id = String(input.id ?? '')
        for (const row of this.projectView.projects) {
          const index = row.contextProposals.findIndex(item => item.proposal.id === id)
          if (index < 0) continue
          const item = row.contextProposals[index]!
          if (name === 'approveProjectContextProposal') {
            const before = row.project.context
            this.appendContextRevision(row, { id: item.proposal.botId, kind: 'bot' }, 'bot_proposal',
              item.proposal.context, describeContextChange(before, item.proposal.context))
            item.proposal.status = 'approved'
          } else {
            item.proposal.status = 'rejected'
          }
          item.proposal.decidedAt = Date.now()
          // 已处理的不再返回给界面（core 的视图只列 pending）。
          row.contextProposals = row.contextProposals.filter((_, i) => i !== index)
          this.emit({ scope: 'project' })
          return { ok: true }
        }
        return { ok: false, error: '建议不存在或已处理' }
      }
      return null
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * P40：样例模式真正保存预置 skill 勾选，供浏览器走查「选择 → 保存 → 重开详情」。
   * 其余档案字段仍按 D01 的样例口径不落库（本来就不接真引擎），保存提示不代表真改了库。
   */
  private commandUpdateBot(input: Record<string, unknown>): CommandResult {
    const botId = String(input.botId ?? '')
    const view = this.botViews[botId]
    if (!view) return { ok: false, error: `没有这个机器人：${botId}` }
    const patch = (input.patch ?? {}) as Record<string, unknown>
    if (patch.presetSkillIds !== undefined) {
      if (!Array.isArray(patch.presetSkillIds)) return { ok: false, error: '预置 skill：要传 id 列表' }
      const known = new Set(fixtureSettings.presetSkillOptions.map(option => option.id))
      const ids = [...new Set(patch.presetSkillIds.map(String))]
      const unknown = ids.find(id => !known.has(id))
      if (unknown !== undefined) return { ok: false, error: `预置 skill：没有「${unknown}」这一项，请从清单里重新选择` }
      view.profile.presetSkillIds = ids
      this.emit({ scope: 'bot', botId })
    }
    return { ok: true }
  }

  async command(name: string, input: Record<string, unknown>): Promise<CommandResult> {
    // P39 上下文三条命令在样例模式里真的改视图，其余未实现命令仍返回成功。
    const contextResult = this.commandContext(name, input)
    if (contextResult !== null) return contextResult
    // P40：档案里保存的预置 skill 勾选在样例模式也持久化。
    if (name === 'updateBot') return this.commandUpdateBot(input)
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

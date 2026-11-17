/**
 * HubFacade：界面接口要用的门面。宿主路由只调它，不关心背后是样例还是真引擎。
 * D01 提供 FixtureHub（样例数据模式）；D02 会提供接真实引擎的实现，路由与界面都不改。
 */
import { createHash } from 'node:crypto'
import type {
  ActivityView, ActiveJobsView, BotView, CommandResult, InboxView, OfficeView, OverviewView, ProjectContext, ProjectView, ProjectViewRow,
  MemoryPageView, ResourceView, SettingsView, SkillDetailView, SkillLibraryView, ThreadMessageView, ThreadView, WakeLedgerRow, WakeLedgerView,
  WeeklyUsageView,
} from '../shared/views.js'
import { createSkillSample, type SkillSample } from '../shared/fixture-skill.js'
import { createMemorySample, sampleMemoryThread, type MemorySample } from '../shared/fixture-memory.js'
import { fixtureSkillActivityRows } from '../shared/fixture-activity-skill.js'
import { restoreSkillInput, rollbackSkillInput } from './skill-input.js'
import { chooseLearnSessionInput, correctMemoryInput, memoryIdInput } from './memory-input.js'
import {
  fixtureActivity, fixtureBots, fixtureInbox, fixtureOverview, fixtureSettings, fixtureThreads,
} from '../shared/fixtures.js'
import { fixtureOffice } from '../shared/fixture-office.js'
import { fixtureWeeklyUsage } from '../shared/fixture-budget.js'
import { fixtureResource } from '../shared/fixture-resource.js'
import { fixtureProject, fixtureTopicThreads } from '../shared/fixture-project.js'
import { fixtureLedgerDetail, fixtureLedgerRows } from '../shared/fixture-ledger.js'
import { OfflineTeam, type OfflineTeamEnv } from './team-offline.js'
import { sampleActiveJobsChief, sampleBudgetChiefLine, sampleBudgetReceiptThread, sampleBudgetThread, sampleBudgetTweetThread, sampleQuotaWindow } from '../shared/fixture-budget.js'

/** 变化事件：告诉界面哪个范围的数据变了（scope ∈ overview | thread | inbox | activity | bot | settings | ledger）。 */
/** 样例模式里「读证据截图」返回的极小图片（1 x 1 像素的 PNG）。 */
const SAMPLE_PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

export interface ChangedEvent { scope: string; botId?: string }

export type ChangeListener = (event: ChangedEvent) => void

export interface HubFacade {
  overview(): Promise<OverviewView>
  bot(botId: string): Promise<BotView>
  thread(threadId: string, opts?: { before?: string; limit?: number }): Promise<ThreadView>
  inbox(): Promise<InboxView>
  activity(opts?: { before?: string; limit?: number }): Promise<ActivityView>
  settings(): Promise<SettingsView>
  /** P76k：设置页「最近 7 天的用量」表（只读；行与表头由 core 的 weeklyUsageView 生成）。 */
  weeklyUsage(): Promise<WeeklyUsageView>
  /** 办公室纯投影（F03）：座位就是一位在岗队友，另有灯、桌上产出与门口信箱。 */
  office(): Promise<OfficeView>
  /** 资料授权矩阵（V2-PH2-04）：资料列表（未归档在前）、授权展开行与计数。 */
  resource(): Promise<ResourceView>
  /** 项目容器（V2-PH4-02）：项目分区、成员/验收项/任务展开、问题与计数。 */
  project(): Promise<ProjectView>
  /** 某机器人的账本摘要（按封存时间倒序），用于右栏「为什么醒 / 为什么没醒」。 */
  wakeLedger(botId: string, opts?: { limit?: number; before?: number }): Promise<WakeLedgerRow[]>
  /** 一次唤醒的完整账本；没有账本时返回 null，界面显示「没有账本记录」。 */
  wakeLedgerDetail(wakeId: string): Promise<WakeLedgerView | null>
  /** P75j：某位员工的技能库一栏（三组技能、上次整理、刻度）；视图由 core 生成，门面原样转交。 */
  skillLibrary(botId: string): Promise<SkillLibraryView>
  /** P75j：一条技能的详情（逐句出处、历史版本、同类任务对比、收起说明）。 */
  skillDetail(skillId: string): Promise<SkillDetailView>
  /**
   * P76j：某位员工的「在办的事」（三行一件、排序、头部合计）。视图由 core 生成，门面原样转交；
   * 旧宿主没有这条路由时界面退回现有的工作会话列表（不报错）。
   */
  activeJobs(botId: string): Promise<ActiveJobsView>
  /** P75k：「关于你的记忆」一页（偏好、规矩、决定和先例、项目背景，加 24 小时内删除的）；视图由 core 生成。 */
  memoryPage(): Promise<MemoryPageView>
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
  private threads: ThreadView[] = clone([
    ...fixtureThreads, ...fixtureTopicThreads, sampleBudgetThread, sampleBudgetReceiptThread, sampleBudgetTweetThread,
  ])
  /** 样例项目可变副本：共享上下文的编辑/采纳/驳回要在沙箱里真的改到视图上。 */
  private projectView: ProjectView = (() => {
    const view = clone(fixtureProject)
    // P76j：把总管面板与成本样例的三个主题挂到左栏第一个项目下（预览 ?job=budget 点得开）。
    const now = Date.now()
    view.projects = view.projects.map((row, index) => index !== 0 ? row : ({
      ...row,
      topics: [
        ...[sampleBudgetThread, sampleBudgetReceiptThread, sampleBudgetTweetThread].map(thread => ({
          id: thread.threadId, title: thread.title, lastMessageAt: now, lastMessageText: '刚刚', unread: 0,
          lastMessagePreview: '', lastMessageFrom: '总管',
        })),
        ...row.topics,
      ],
    }))
    return view
  })()
  /** P40：样例机器人的可变副本，档案里保存的预置 skill 要能重新打开时看到。 */
  private botViews: Record<string, BotView> = clone(fixtureBots)
  /** P72：样例总览与收件箱的可变副本——点「定了」后约定条目要真的从待你处理里消失、默契度要累加。 */
  private overviewView: OverviewView = (() => {
    const view = clone(fixtureOverview)
    // P76j：样例总览带额度窗口视图（总管右栏「本窗口额度」与顶栏额度文字都能看到），总管一行读新写法。
    view.quota = { ...view.quota, window: clone(sampleQuotaWindow) }
    view.bots = view.bots.map(bot => bot.role === 'chief' ? { ...bot, chiefJobLine: sampleBudgetChiefLine } : bot)
    return view
  })()
  private inboxView: InboxView = clone(fixtureInbox)
  /** P73e：样例组队记录的可变副本（三问、三张组队卡）；命令改记录后重新生成视图。 */
  private team = new OfflineTeam()
  private listeners = new Set<ChangeListener>()
  private seq = 0
  /**
   * P75j：样例技能世界（惰性建立：不看技能库的测试不付这笔开销）。
   * 离线模式只给「探路」一份有内容的技能库（设计稿 C、H 的数据，名字换成探路），其余员工是空的，
   * 这样既能看到完整的样子，也能看到「还没有自己积累的技能」的空状态。技能详情按技能编号取，只在有内容的那份里找。
   * 回退、放回两条命令走 core 的界面接口，在内存环境里真的改记录。
   */
  private skillWorlds = new Map<string, SkillSample>()
  /**
   * P75k：样例记忆世界（惰性建立）。记忆页、总管私聊里的「已记住」「已更正」「已删除」三行、左栏与总管右侧栏的条数，
   * 都由它里面的 core 记录生成；撤销、更正、删除等五个命令走 core 的界面接口真的改内存记录（刷新即恢复）。
   * 样例的总管私聊线程是 bot-zongguan，世界里的线程消息在读线程时拼到它最前面（更早的几天），不改静态样例本身。
   */
  private memoryWorldCache: MemorySample | null = null
  /** 样例总管员工的编号（与 fixtures.ts 的总管一致）。 */
  private static readonly CHIEF_FIXTURE_ID = 'bot-zongguan'

  /** 样例组队命令需要的现场：线程、待你处理、总览（都是本实例自己的副本）。 */
  private teamEnv(): OfflineTeamEnv {
    return { threads: this.threads, inbox: this.inboxView, overview: this.overviewView, emit: event => this.emit(event), nextSeq: () => this.seq++ }
  }
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

  /** 找主题所在的项目行和主题列表里的那一行（P63）；不是主题时返回 null。 */
  private findTopic(threadId: string): { row: ProjectViewRow; topic: ProjectViewRow['topics'][number] } | null {
    for (const row of this.projectView.projects) {
      const topic = row.topics.find(item => item.id === threadId)
      if (topic) return { row, topic }
    }
    return null
  }

  /** 主题有新楼层时更新列表里的预览：样例模式也要能看到排序和未读的变化。 */
  private touchTopic(threadId: string, text: string, from: string, unreadDelta: number): void {
    const found = this.findTopic(threadId)
    if (found === null) return
    found.topic.lastMessageAt = Date.now()
    found.topic.lastMessageText = '刚刚'
    found.topic.lastMessagePreview = text.slice(0, 60)
    found.topic.lastMessageFrom = from
    found.topic.unread += unreadDelta
    found.row.topics.sort((a, b) => b.lastMessageAt - a.lastMessageAt)
    this.emit({ scope: 'project' })
  }

  /** 样例模式开主题：真的进项目视图和线程表，返回 topicId，和真引擎同一个形状。 */
  private commandCreateTopic(input: Record<string, unknown>): CommandResult {
    const projectId = String(input.projectId ?? '')
    const text = String(input.text ?? '').trim()
    if (text === '') return { ok: false, error: '第一句话不能为空' }
    const row = this.projectView.projects.find(item => item.project.id === projectId)
    if (!row) return { ok: false, error: `项目不存在：${projectId}` }
    if (row.project.status !== 'active') return { ok: false, error: `项目「${row.project.name}」当前是「${row.statusLabel}」，恢复进行中后才能在里面讨论` }
    const topicId = `ptp_sample_${this.seq++}`
    const title = [...text.split(/\r?\n/)[0]!.trim()].slice(0, 120).join('')
    const firstId = `own-${Date.now()}-${this.seq++}`
    this.threads.push({
      threadId: topicId, title, hasMore: false, oldestId: firstId,
      messages: [{ id: firstId, thread: topicId, from: 'owner', fromName: '主人', fromColor: null, kind: 'chat', text, createdAt: Date.now(), timeText: '刚刚', card: null }],
    })
    row.topics.unshift({ id: topicId, title, lastMessageAt: Date.now(), lastMessageText: '刚刚', unread: 0, lastMessagePreview: text.slice(0, 60), lastMessageFrom: '主人' })
    this.emit({ scope: 'project' })
    this.scheduleSampleReply(topicId)
    return { ok: true, data: { topicId } }
  }

  /** 2 秒后追加一条样例回复（看实时推送效果用）；主题里由负责人回复。 */
  private scheduleSampleReply(threadId: string): void {
    const timer = setTimeout(() => {
      this.pendingTimers.delete(timer)
      const t = this.findThread(threadId)
      if (!t) return
      const found = this.findTopic(threadId)
      const bot = fixtureOverview.bots.find(b => b.id === (found?.row.ownerBotId ?? threadId))
      const fromName = t.threadId === 'team' ? '总管' : (bot?.name ?? '员工')
      const text = '（样例回复）收到。这是 D01 样例数据模式的自动回应，接上真实引擎后就是它的真话了。'
      t.messages.push({
        id: `bot-${Date.now()}-${this.seq++}`, thread: t.threadId, from: bot?.id ?? 'hub',
        fromName, fromColor: bot?.color ?? 'var(--dsw-alias-accent)', kind: 'reply', text,
        createdAt: Date.now(), timeText: '刚刚', card: null,
      })
      this.emit({ scope: 'thread', botId: threadId })
      this.emit({ scope: 'overview' })
      this.touchTopic(threadId, text, fromName, 1)
    }, 2000)
    this.pendingTimers.add(timer)
  }

  /** 取（必要时建立）样例记忆世界。 */
  private memoryWorld(): MemorySample {
    if (this.memoryWorldCache === null) this.memoryWorldCache = createMemorySample()
    return this.memoryWorldCache
  }

  /** 样例世界里总管私聊的消息（带 core 生成的「已记住」等行），换成样例总管的线程与名字后拼进 bot-zongguan 的线程。 */
  private memoryMessages(): ThreadMessageView[] {
    const world = this.memoryWorld()
    return sampleMemoryThread(world).messages.map(message => ({
      ...message, thread: FixtureHub.CHIEF_FIXTURE_ID,
      from: message.from === world.chiefId ? FixtureHub.CHIEF_FIXTURE_ID : message.from,
    }))
  }

  /** 总览带记忆条数（左栏与总管右侧栏的入口用）：随记忆世界的当前状态变化。 */
  async overview(): Promise<OverviewView> {
    return { ...clone(this.overviewView), memoryCount: this.memoryWorld().api.memoryPage().total }
  }

  /**
   * P76j：样例模式的「在办的事」。总管用 fixture-budget 里由 core 视图函数生成的样例；
   * 其他员工给空视图（样例数据里没有他们的事），界面显示「现在没有在办的事」。
   */
  async activeJobs(botId: string): Promise<ActiveJobsView> {
    const bot = this.overviewView.bots.find(row => row.id === botId)
    if (bot?.role !== 'chief') return { headText: '现在没有在办的事', rows: [], footerText: '查看全部记录' }
    return clone(sampleActiveJobsChief)
  }

  async bot(botId: string): Promise<BotView> {
    const view = this.botViews[botId]
    if (!view) throw new Error(`没有这个机器人：${botId}`)
    return clone(view)
  }

  async thread(threadId: string, opts?: { before?: string; limit?: number }): Promise<ThreadView> {
    const t = this.findThread(threadId)
    if (!t) throw new Error(`没有这个线程：${threadId}`)
    const limit = Math.max(1, Math.min(opts?.limit ?? 50, 100))
    // P75k：总管私聊最前面拼上样例记忆世界里的几条对话（「已记住」「已更正」「已删除」三行由 core 生成）。
    let msgs = [...(threadId === FixtureHub.CHIEF_FIXTURE_ID ? this.memoryMessages() : []), ...t.messages]
    if (opts?.before) {
      const i = msgs.findIndex((m) => m.id === opts.before)
      if (i >= 0) msgs = msgs.slice(0, i)
    }
    const page = msgs.slice(-limit)
    const oldest = page[0]
    return clone({
      threadId: t.threadId, title: t.title, messages: page,
      hasMore: msgs.length > page.length, oldestId: oldest ? oldest.id : null,
      // P72：主题的约定面板随线程一起给出。
      ...(t.agreement !== undefined ? { agreement: t.agreement } : {}),
    })
  }

  async inbox(): Promise<InboxView> { return clone(this.inboxView) }

  async activity(opts?: { before?: string; limit?: number }): Promise<ActivityView> {
    const limit = Math.max(1, Math.min(opts?.limit ?? 30, 100))
    // P75k：基础样例后面拼上几行「技能库」记录（活动流页「类型」筛选选「技能库」时看到它们）。
    let rows = [...fixtureActivity.rows, ...fixtureSkillActivityRows(Date.now())].sort((a, b) => b.at - a.at)
    if (opts?.before) {
      const i = rows.findIndex((r) => r.id === opts.before)
      if (i >= 0) rows = rows.slice(i + 1)
    }
    const page = rows.slice(0, limit)
    return clone({ rows: page, hasMore: rows.length > page.length })
  }

  async settings(): Promise<SettingsView> { return clone(fixtureSettings) }
  /** P76k：用量表的样例由 core 的 weeklyUsageView 生成（`shared/fixture-budget.ts`）。 */
  async weeklyUsage(): Promise<WeeklyUsageView> { return clone(fixtureWeeklyUsage()) }

  async office(): Promise<OfficeView> { return clone(fixtureOffice) }

  /** 样例资料授权矩阵：沙箱里也能看普通/受限资料、授权 chips 与归档区。 */
  async resource(): Promise<ResourceView> { return clone(fixtureResource) }

  /** 样例项目容器：沙箱里也能看四分区、待验收任务与失效队友问题；P39 上下文可编辑。 */
  async project(): Promise<ProjectView> { return clone(this.projectView) }


  /** 离线模式里有技能内容的那位员工。 */
  private static readonly SKILL_SAMPLE_BOT = 'bot-tanlu'

  /** 取（必要时建立）某位员工的样例技能世界；员工不存在时抛出中文错误。 */
  private skillWorld(botId: string): SkillSample {
    const card = fixtureOverview.bots.find(bot => bot.id === botId)
    if (!card) throw new Error(`没有这个机器人：${botId}`)
    const existing = this.skillWorlds.get(botId)
    if (existing) return existing
    const created = createSkillSample(card.name, { empty: botId !== FixtureHub.SKILL_SAMPLE_BOT })
    this.skillWorlds.set(botId, created)
    return created
  }

  async skillLibrary(botId: string): Promise<SkillLibraryView> {
    const world = this.skillWorld(botId)
    return clone(world.api.skillLibrary(world.botId))
  }

  async skillDetail(skillId: string): Promise<SkillDetailView> {
    // 技能详情只在有内容的那份里找（技能编号在各份里重复，空的那几份没有技能）。
    return clone(this.skillWorld(FixtureHub.SKILL_SAMPLE_BOT).api.skillDetail(skillId))
  }

  /** P75k：记忆页（样例世界里由 core 生成）。 */
  async memoryPage(): Promise<MemoryPageView> { return clone(this.memoryWorld().api.memoryPage()) }

  /**
   * 样例模式的记忆五命令：交给 core 的界面接口改内存里的记录，成功后发 memory 事件（记忆页重取）、总管线程事件（「已记住」行改字）
   * 与总览事件（条数）。参数检查与真引擎同一套（缺参数、类型不对都是中文错误）。
   */
  private async commandMemory(name: 'undoMemory' | 'correctMemory' | 'deleteMemory' | 'undoDeleteMemory' | 'undoCorrectMemory', input: Record<string, unknown>): Promise<CommandResult> {
    try {
      const api = this.memoryWorld().api
      const result = name === 'correctMemory' ? await api.correctMemory(correctMemoryInput(input))
        : name === 'undoMemory' ? await api.undoMemory(memoryIdInput(input))
          : name === 'deleteMemory' ? await api.deleteMemory(memoryIdInput(input))
            : name === 'undoDeleteMemory' ? await api.undoDeleteMemory(memoryIdInput(input))
              : await api.undoCorrectMemory(memoryIdInput(input))
      if (result.ok) {
        this.emit({ scope: 'memory' })
        this.emit({ scope: 'thread', botId: FixtureHub.CHIEF_FIXTURE_ID })
        this.emit({ scope: 'overview' })
      }
      return result as CommandResult
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** 样例模式的回退、放回：交给 core 的界面接口改内存里的记录，成功后发一条该员工的变化事件让界面重取。 */
  private async commandSkill(name: 'rollbackSkill' | 'restoreSkill', input: Record<string, unknown>): Promise<CommandResult> {
    try {
      const world = this.skillWorld(FixtureHub.SKILL_SAMPLE_BOT)
      // 参数检查与真引擎同一套（缺参数、类型不对都是中文错误）。
      const result = name === 'rollbackSkill'
        ? await world.api.rollbackSkill(rollbackSkillInput(input))
        : await world.api.restoreSkill(restoreSkillInput(input))
      if (result.ok) this.emit({ scope: 'bot', botId: FixtureHub.SKILL_SAMPLE_BOT })
      return result as CommandResult
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

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
      : (row.members.find(member => member.botId === editor.id)?.name ?? '已删除的员工')
    row.contextRevisions = [{
      revision,
      editorName,
      editorKindLabel: editor.kind === 'owner' ? '主人' : '员工',
      sourceLabel: source === 'owner_edit' ? '主人编辑' : '采纳员工建议',
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

  /**
   * P72：样例模式的「定了」。真实引擎由 core 校验、落主人的「定了」、固定版本、了结待你处理条目；
   * 这里只把样例视图改成同样的结果，让离线走查能看到：约定卡转只读并盖章、线程里多一条「定了」和一句旁白、
   * 待你处理里的约定条目消失、总管的默契度累加。
   * 只改这个实例自己的副本（threads、overviewView、inboxView），不碰模块级样例常量。
   */
  private commandConfirmAgreement(input: Record<string, unknown>): CommandResult {
    const agreementId = String(input.agreementId ?? '')
    const version = Number(input.version)
    if (agreementId === '') return { ok: false, error: 'agreementId：不能为空' }
    if (!Number.isInteger(version) || version < 1) return { ok: false, error: 'version：必须是大于等于 1 的整数' }
    const choices = (typeof input.choices === 'object' && input.choices !== null ? input.choices : {}) as Record<string, string>
    // 同一张卡可能同时出现在总管私聊和主题两条线程里，逐条找出来一起改。
    const cards: Array<NonNullable<ThreadMessageView['agreement']>> = []
    for (const thread of this.threads) {
      for (const message of thread.messages) {
        if (message.agreement && message.agreement.agreementId === agreementId && message.agreement.versionNo === version) cards.push(message.agreement)
      }
    }
    const first = cards[0]
    if (first === undefined) return { ok: false, error: 'agreementId：约定不存在' }
    if (first.state !== 'pending' || !first.canConfirm) return { ok: false, error: '这一版已经不是待确认的状态，请看最新的一版' }

    // 采纳统计：选择等于建议的项数 / 待定项数；累计默契度在总管现有基数上累加。
    const total = first.pending.length
    const adopted = first.pending.filter(item => (choices[item.key] ?? item.suggested) === item.suggested).length
    const chief = this.overviewView.bots.find(bot => bot.role === 'chief')
    const before = chief?.rapport ?? { adopted: 0, total: 0, text: '' }
    const rapport = { adopted: before.adopted + adopted, total: before.total + total }
    if (chief) chief.rapport = { ...rapport, text: `默契度 ${rapport.adopted} / ${rapport.total}` }

    const now = new Date()
    const lockedText = `${now.getMonth() + 1}月${now.getDate()}日 ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
    const lockOne = (card: NonNullable<ThreadMessageView['agreement']>): void => {
      card.state = 'locked'; card.stateLabel = '已固定'; card.agreementState = 'locked'; card.canConfirm = false
      card.lockedAt = now.getTime(); card.lockedText = lockedText
      card.pending = card.pending.map(item => ({ ...item, chosen: choices[item.key] ?? item.suggested }))
      card.adoption = { adopted, total }; card.rapport = rapport
    }
    for (const card of cards) lockOne(card)

    // 线程里的后续：私聊多一条主人的「定了」，每条相关线程多一句中心旁白；主题第一层面板同步变成已固定。
    for (const thread of this.threads) {
      // 约定卡只在总管私聊里（P72g B4），主题线程只有第一层面板：有卡或有这份约定的面板都要处理。
      const hasCard = thread.messages.some(m => m.agreement?.agreementId === agreementId && m.agreement.versionNo === version)
      if (!hasCard && thread.agreement?.current.agreementId !== agreementId) continue
      const isTopic = thread.threadId.startsWith('ptp_')
      const at = Date.now()
      if (!isTopic) {
        thread.messages.push({
          id: `own-${at}-${this.seq++}`, thread: thread.threadId, from: 'owner', fromName: '我', fromColor: null,
          kind: 'chat', text: '定了', createdAt: at, timeText: '刚刚', card: null,
        })
      }
      thread.messages.push({
        id: `hub-${at}-${this.seq++}`, thread: thread.threadId, from: 'hub', fromName: '中心', fromColor: null,
        kind: 'system', text: `约定第 ${version} 版已固定，挂在主题「${first.topicTitle ?? first.title}」上。`, createdAt: at, timeText: '刚刚', card: null,
      })
      if (thread.agreement && thread.agreement.current.agreementId === agreementId) {
        lockOne(thread.agreement.current)
        for (const row of thread.agreement.revisions) {
          if (row.no === version) { row.locked = true; row.stateLabel = '已固定'; row.timeText = lockedText }
        }
      }
      this.emit({ scope: 'thread', botId: thread.threadId })
    }

    // 待你处理里这份约定的条目了结：从列表消失，总览的计数同步减掉。
    const gone = this.inboxView.items.filter(item => item.agreementId === agreementId)
    if (gone.length > 0) {
      this.inboxView.items = this.inboxView.items.filter(item => item.agreementId !== agreementId)
      this.overviewView.inbox.total = Math.max(0, this.overviewView.inbox.total - gone.length)
      this.overviewView.inbox.questions = Math.max(0, this.overviewView.inbox.questions - gone.length)
      this.emit({ scope: 'inbox' })
    }
    this.emit({ scope: 'overview' })
    this.emit({ scope: 'project' })
    return { ok: true, data: { agreementId, version } }
  }

  async command(name: string, input: Record<string, unknown>): Promise<CommandResult> {
    // P72：约定卡的「定了」，以及待你处理里约定条目的「按建议，定了」（等同于全部采纳建议）。
    if (name === 'confirmAgreement') return this.commandConfirmAgreement(input)
    // P75f：这两个入口已停用（与真实引擎同一句话）；样例模式也不再模拟它们。
    if (name === 'editRoutine') return { ok: false, error: '这个入口已停用：套路已并入技能库，请在技能库里查看。' }
    if (name === 'teach') return { ok: false, error: '这个入口已停用：要员工学某段会话的做法，请对总管说。' }
    // P75j：技能详情里的「回退到这一版」「放回」。
    if (name === 'rollbackSkill' || name === 'restoreSkill') return this.commandSkill(name, input)
    // P75k：「已记住」行的撤销与记忆页的更正、删除、撤销删除、撤销更正。
    if (name === 'undoMemory' || name === 'correctMemory' || name === 'deleteMemory' || name === 'undoDeleteMemory' || name === 'undoCorrectMemory') {
      return this.commandMemory(name, input)
    }
    // P75k：学习选会话：样例模式没有学习记录，只做参数检查（与真引擎同一套中文错误），然后安静成功。
    if (name === 'chooseLearnSession') {
      try { chooseLearnSessionInput(input) } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
      return { ok: true }
    }
    // P73e：三问回答、组队卡编辑与确认（样例记录改完后重新调用 core 的视图函数，见 team-offline.ts）。
    const teamResult = this.team.handle(name, input, this.teamEnv())
    if (teamResult !== null) return teamResult
    if (name === 'answerInbox') {
      const item = this.inboxView.items.find(entry => entry.id === String(input.id ?? ''))
      if (item?.agreementId) return this.commandConfirmAgreement({ agreementId: item.agreementId, version: item.agreementVersion ?? 1 })
      // 待你处理里组队条目的唯一按钮：等同卡片上点确认。
      if (item?.teamProposalId) {
        const confirmed = this.team.confirmFromInbox(item.teamProposalId, this.teamEnv())
        if (confirmed !== null) return confirmed
      }
    }
    // P39 上下文三条命令在样例模式里真的改视图，其余未实现命令仍返回成功。
    const contextResult = this.commandContext(name, input)
    if (contextResult !== null) return contextResult
    // P40：档案里保存的预置 skill 勾选在样例模式也持久化。
    if (name === 'updateBot') return this.commandUpdateBot(input)
    if (name === 'createProjectTopic') return this.commandCreateTopic(input)
    // 主题的未读在项目视图里：看过了要清零，左栏的点才会灭。
    if (name === 'markThreadRead') {
      const found = this.findTopic(String(input.threadId ?? ''))
      if (found !== null) { found.topic.unread = 0; this.emit({ scope: 'project' }) }
      return { ok: true }
    }
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
      this.touchTopic(threadId, text, '主人', 0)
      // 2) 2 秒后追加一条机器人的样例回复（看实时推送效果用）。
      this.scheduleSampleReply(threadId)
      return { ok: true }
    }
    // P74g：读证据截图、打开预览两个只读命令在样例模式里返回固定的样例结果（不读任何文件、不打开任何东西）。
    if (name === 'readJobEvidence') return { ok: true, data: { mime: 'image/png', dataUrl: SAMPLE_PNG_DATA_URL } }
    if (name === 'openJobPreview') {
      const sample: { ok: false; path: string; error: string } = { ok: false, path: '/样例/交付/index.html', error: '样例环境不打开文件' }
      return sample
    }
    // P74i：一件事的四个命令（验收、选办法、回合上限、停住了的答复）在样例模式里改样例状态：
    // 对应的「待你处理」条目了结、总览计数减掉、条目所在线程落一句固定话；没有对应条目时安静成功。
    if (name === 'acceptJob' || name === 'chooseJobOption' || name === 'answerJobCap' || name === 'answerJobStall') {
      return this.commandJobAnswer(name, input)
    }
    // 其余命令：D01 一律成功（不接真引擎）。
    return { ok: true }
  }

  /** 一件事的条目在样例收件箱里的形状（与 core 建条目时写死的选项一致，按命令挑出对应那一条）。 */
  private jobInboxItemOf(name: string): InboxView['items'][number] | null {
    return this.inboxView.items.find(item => {
      const options = item.options
      if (name === 'acceptJob') return options.length === 1 && options[0] === '验收通过'
      // P74r5 之后按钮文字：回合上限是「再给 N 个回合」「暂停」，没有进展是「再提醒一次」「暂停」。
      if (name === 'answerJobCap') return options.length === 2 && options[1] === '暂停' && options[0]!.startsWith('再给')
      if (name === 'answerJobStall') return options.length === 2 && options[0] === '再提醒一次' && options[1] === '暂停'
      return options.length >= 2 && options.every(option => /^[A-Z]　/.test(option))
    }) ?? null
  }

  /** 样例模式里答复一件事的条目：条目消失、计数减掉、线程里落一句固定话。 */
  private commandJobAnswer(name: string, input: Record<string, unknown>): CommandResult {
    try {
      const item = this.jobInboxItemOf(name)
      if (item !== null) {
        const reply = name === 'acceptJob' ? '已验收。'
          : name === 'chooseJobOption' ? '已按所选办法处理。'
            : `已回复「${String(input.answer ?? '')}」。`
        const threadId = item.topicId ?? item.botId
        const thread = threadId === null ? undefined : this.findThread(threadId)
        if (thread !== undefined) {
          thread.messages.push({
            id: `own-${Date.now()}-${this.seq++}`, thread: thread.threadId, from: 'owner', fromName: '我', fromColor: null,
            kind: 'chat', text: reply, createdAt: Date.now(), timeText: '刚刚', card: null,
          })
          this.emit({ scope: 'thread', botId: thread.threadId })
        }
        this.inboxView.items = this.inboxView.items.filter(entry => entry.id !== item.id)
        this.overviewView.inbox.total = Math.max(0, this.overviewView.inbox.total - 1)
        this.overviewView.inbox.questions = Math.max(0, this.overviewView.inbox.questions - 1)
        this.emit({ scope: 'inbox' })
        this.emit({ scope: 'overview' })
      }
      return { ok: true }
    } catch {
      // 样例模式里任何意外都不能带崩界面：回一个成功，主人最多看到没有变化。
      return { ok: true }
    }
  }
}

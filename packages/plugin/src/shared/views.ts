/**
 * 界面视图类型：把 docs/build-spec.md 第 15.1 节逐字段抄成 TypeScript 类型。
 * 为什么单独一份：D01 界面半边照这些类型渲染样例数据；D02 接真实引擎后，
 * 这里将改为从 @agent-hub/core 导入同名类型，界面一行不改。
 * 字段名与第 15.1 节完全一致，不得改动；新增字段可以，删改要先改规格。
 */

// ---------- 领域枚举（与 core src/model/enums.ts 的取值保持一致） ----------

export type Role = 'chief' | 'researcher' | 'executor' | 'sentinel'
export type Lifecycle = 'draft' | 'probation' | 'active' | 'paused' | 'quarantined' | 'retired'
export type Activity = 'watching' | 'queued' | 'thinking' | 'waiting_owner' | 'waiting_peer' | 'blocked' | 'resting' | 'reflecting' | 'catching_up'
export type ThreadKind = 'chat' | 'reply' | 'report' | 'question' | 'approval' | 'proposal' | 'alert' | 'digest' | 'handoff' | 'peer' | 'system'
export type InboxType = 'proposal' | 'question' | 'approval' | 'alert'
export type InboxStatus = 'open' | 'answered' | 'expired' | 'withdrawn' | 'closed'
export type InboxPriority = 'P0' | 'P1' | 'P2'
export type WakeKind = 'percept' | 'pile' | 'agenda_due' | 'drive' | 'owner_message' | 'peer_message' | 'inbox_reply' | 'approval_decided' | 'next_think' | 'light_check' | 'reflection' | 'catch_up' | 'trial' | 'teach' | 'retry'
export type Variant = 'regular' | 'light_check' | 'reflection' | 'catch_up' | 'trial' | 'teach'
export type WakeStatus = 'delivering' | 'running' | 'committed' | 'no_commit' | 'error' | 'canceled' | 'timeout'
export type Outcome = 'no_change' | 'progress' | 'done' | 'blocked' | 'needs_owner'
export type WatchKind = 'file' | 'log' | 'http' | 'rss' | 'script' | 'session'
export type WatchStatus = 'active' | 'proposed' | 'paused' | 'expired'
export type WatchCreatedBy = 'owner' | 'bot' | 'hub'
export type AgendaKind = 'task' | 'follow_up' | 'conditional' | 'commitment' | 'review'
export type AgendaSource = 'owner' | 'bot' | 'peer' | 'hub'
export type AgendaStatus = 'open' | 'done' | 'dropped'
export type GoalStatus = 'active' | 'done_pending_check' | 'done' | 'abandoned' | 'blocked' | 'proposed'
export type AppraisalDecision = 'woke' | 'queued' | 'pile' | 'record_only' | 'suppressed'
export type SuppressionReason = 'paused' | 'waiting_owner_same_subject' | 'cooldown' | 'pace_min' | 'daily_cap' | 'bot_budget' | 'quota' | 'concurrency' | 'dispatch_gap' | 'startup_quiet' | 'dedup' | 'retry_backoff'
export type Autonomy = 'L0' | 'L1' | 'L2' | 'L3'
export type PaceProfile = 'active' | 'normal' | 'quiet'
/** 宿主模型选择；null 表示跟随宿主默认模型（与 core ModelChoice 一致）。 */
export type ModelChoice = { provider: string; model: string } | null

/**
 * Settings：D02 起直接从 @agent-hub/core 导入完整类型（type-only import，
 * 编译期擦除，不会进客户端 bundle），界面与路由的形状不变。
 */
// eslint-disable-next-line import/no-duplicates -- 类型集中再导出
import type { Settings } from '@agent-hub/core'
export type { Settings }

// ---------- 第 15.1 节视图结构（字段名逐字照抄） ----------

export type Light = 'green' | 'yellow' | 'orange' | 'red'

export interface BotCard {
  id: string; name: string; role: Role; roleLabel: string; color: string; initials: string   // initials：名字前 1–2 个字
  lifecycle: Lifecycle; lifecycleLabel: string; activity: Activity; activityLabel: string; activityText: string
  nextThinkText: string            // 例「有变化时，最晚周四 09:00」「明天 09:00（它自己定的：等日报出来）」
  lastOutcome: Outcome | null; lastOutcomeLabel: string | null; lastActiveText: string | null
  unread: number                   // 线程未读
  todayThinks: number; todayBudget: number; todayTokens: number
  waitingOwner: boolean            // 有在等主人的提问或审批
}

export interface OverviewView {
  bots: BotCard[]
  inbox: { total: number; approvals: number; questions: number; proposals: number; alerts: number }
  team: { unread: number; lastMessageText: string | null }
  quota: { light: Light; lightLabel: string; usedText: string; resetText: string | null }
  health: { ok: boolean; heartbeatText: string; downtimeText: string | null; openAlerts: number }
  nowText: string; quietNow: boolean; pushesLeftToday: number
}

export interface ThreadMessageView {
  id: string; thread: string; from: 'owner' | 'hub' | string; fromName: string; fromColor: string | null
  kind: ThreadKind; text: string; createdAt: number; timeText: string
  card: null | {                   // 内嵌在线程里的可操作卡片（提问 / 审批 / 提议）
    inboxId: string; approvalId: string | null   // approvalId 仅审批卡有；decideApproval 用它，不能误传 inboxId
    type: 'question' | 'approval' | 'proposal' | 'alert'; status: InboxStatus
    title: string; body: string; options: string[]; defaultOption: string | null; answer: string | null; expiresText: string | null
  }
}

export interface ThreadView { threadId: string; title: string; messages: ThreadMessageView[]; hasMore: boolean; oldestId: string | null }

export interface WakeRow {
  id: string; variant: Variant; variantLabel: string; reasonKind: WakeKind; reasonText: string
  score: number; threshold: number; status: WakeStatus; outcome: Outcome | null; outcomeLabel: string | null
  summary: string | null; steps: number; tokens: number; durationText: string | null; startedAt: number; timeText: string
}

export interface AppraisalRow {
  id: string; at: number; timeText: string
  decision: AppraisalDecision; decisionLabel: string
  suppressedBy: AppraisalLog['suppressedBy']; text: string; score: number; threshold: number
}

export interface BotView {
  card: BotCard
  profile: {
    persona: string; autonomy: Autonomy; autonomyLabel: string
    pace: PaceProfile; paceLabel: string
    model: ModelChoice; modelText: string
    homeDir: string; sessionId: string | null; createdAt: number; createdText: string; probationText: string | null; workDataAllowed: boolean
  }
  aspirations: Array<{ id: string; text: string; status: string }>
  goals: Array<{ id: string; title: string; doneWhen: string; period: string; periodText: string; status: GoalStatus; statusLabel: string; lastProgressText: string; createdBy: 'owner' | 'bot' }>
  agenda: Array<{ id: string; kind: AgendaKind; kindLabel: string; title: string; dueText: string | null; priority: number; toOwner: boolean; source: AgendaSource; status: AgendaStatus }>
  watches: Array<{ id: string; kind: WatchKind; kindLabel: string; target: string; filter: string | null; intervalText: string | null; expectationText: string | null; status: WatchStatus; createdBy: WatchCreatedBy; why: string; lastCheckedText: string | null }>
  routines: Array<{ id: string; name: string; whenToUse: string; steps: string[]; runs: number; updatedText: string }>
  rules: Array<{ id: string; text: string; redLine: boolean; scope: 'global' | 'bot' }>
  memoryExcerpt: string
  wakes: WakeRow[]                 // 最近 50
  appraisals: AppraisalRow[]       // 最近 100：为什么醒 / 为什么没醒
  stats: { thinks7d: number; intervalCv: number | null; selfPacedRatio: number | null; selfInitiated7d: number; proposalAcceptRate: number | null; tokens7d: number }
}

export interface InboxItemView {
  id: string; botId: string | null; botName: string | null; botColor: string | null
  type: InboxType; typeLabel: string; priority: InboxPriority
  approvalId: string | null        // 仅审批卡有；decideApproval 用它，不能误传收件箱 id
  title: string; body: string; options: string[]; defaultOption: string | null
  createdAt: number; createdText: string; expiresText: string | null
}

export interface InboxView { items: InboxItemView[] }

export interface ActivityRow {
  id: string; at: number; timeText: string
  botId: string | null; botName: string | null; botColor: string | null
  kind: 'wake' | 'commit' | 'approval' | 'alert' | 'handoff' | 'peer' | 'lifecycle' | 'system'
  text: string
}

export interface ActivityView { rows: ActivityRow[]; hasMore: boolean }

export interface SettingsView {
  settings: Settings
  pushChannelOptions: string[]
  modelOptions: Array<{ value: ModelChoice; label: string }>
}

export interface RecentSessionView { sessionId: string; title: string; updatedText: string }

export type CommandResult<T = unknown> = { ok: true; data?: T } | { ok: false; error: string }

// ---------- 15.1 里被引用的 core 领域类型的局部声明（D02 改为从 core 导入） ----------

/** AppraisalLog 的最小形状：15.1 只用到 suppressedBy 字段。 */
export interface AppraisalLog {
  suppressedBy: SuppressionReason | null
}

/** ThreadMessage 的 kind（15.1 里以 ThreadMessage['kind'] 引用）。 */
export interface ThreadMessage {
  kind: ThreadKind
}

/** InboxItem 的 type / status / priority（15.1 里以 InboxItem[…] 引用）。 */
export interface InboxItem {
  type: InboxType
  status: InboxStatus
  priority: InboxPriority
}

/** Goal 的 status（15.1 里以 Goal['status'] 引用）。 */
export interface Goal {
  status: GoalStatus
}

/** AgendaItem 的 kind / source / status（15.1 里以 AgendaItem[…] 引用）。 */
export interface AgendaItem {
  kind: AgendaKind
  source: AgendaSource
  status: AgendaStatus
}

/** Watch 的 kind / status / createdBy（15.1 里以 Watch[…] 引用）。 */
export interface Watch {
  kind: WatchKind
  status: WatchStatus
  createdBy: WatchCreatedBy
}

/** WakeTicket 的 status（15.1 里以 WakeTicket['status'] 引用）。 */
export interface WakeTicket {
  status: WakeStatus
}

/**
 * 界面视图类型：把 docs/build-spec.md 第 15.1 节逐字段抄成 TypeScript 类型。
 * 为什么单独一份：D01 界面半边照这些类型渲染样例数据；D02 接真实引擎后，
 * 这里将改为从 @agent-hub/core 导入同名类型，界面一行不改。
 * 字段名与第 15.1 节完全一致，不得改动；新增字段可以，删改要先改规格。
 */

// ---------- 领域枚举（与 core src/model/enums.ts 的取值保持一致） ----------

export type Role = 'chief' | 'researcher' | 'executor' | 'sentinel' | 'advisor'
/** P55 性格选择题；每项写进身份文件的话在 core 的 persona-choices.ts。 */
export type Temperament = 'steady' | 'rigorous' | 'cheerful' | 'inventive' | 'calm' | 'gentle'
/** P55 说话风格选择题。 */
export type SpeechStyle = 'conclusion_first' | 'brief' | 'detailed' | 'gentle' | 'blunt' | 'playful'
/** P55 DSH 里的一项技能：只有名字和用途，正文留在 DSH。 */
export interface DshSkillOption { name: string; description: string }
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
export type SuppressionReason = 'paused' | 'waiting_owner_same_subject' | 'waiting_owner' | 'cooldown' | 'pace_min' | 'daily_cap' | 'bot_budget' | 'quota' | 'concurrency' | 'dispatch_gap' | 'startup_quiet' | 'dedup' | 'retry_backoff'
export type Autonomy = 'L0' | 'L1' | 'L2' | 'L3'
export type PaceProfile = 'active' | 'normal' | 'quiet'
/** MBTI 16 型取值，与 core 的 MbtiType 一致；null 表示未设置。 */
export type MbtiType = 'INTJ' | 'INTP' | 'ENTJ' | 'ENTP' | 'INFJ' | 'INFP' | 'ENFJ' | 'ENFP'
  | 'ISTJ' | 'ISFJ' | 'ESTJ' | 'ESFJ' | 'ISTP' | 'ISFP' | 'ESTP' | 'ESFP'
/** 宿主模型选择；null 表示跟随宿主默认模型（与 core ModelChoice 一致）。 */
export type ModelChoice = { provider: string; model: string } | null

/**
 * Settings：D02 起直接从 @agent-hub/core 导入完整类型（type-only import，
 * 编译期擦除，不会进客户端 bundle），界面与路由的形状不变。
 */
// eslint-disable-next-line import/no-duplicates -- 类型集中再导出
import type { Settings, WakeLedgerActionView, WakeLedgerEntry, WakeLedgerEvidenceView, WakeLedgerRow, WakeLedgerView } from '@agent-hub/core'
export type { Settings }
export type { CostView, CostTotals, CostBotRow, DailyCostView } from '@agent-hub/core'
/** 倒带的索引、断点与房间均以 core 为准，客户端只选择时刻。 */
export type { OfficeReplayView } from '@agent-hub/core'
/** 账本视图类型直接复用 core 的命名，界面不自己再抄一份字段（第一期只读）。 */
export type { WakeLedgerActionView, WakeLedgerEntry, WakeLedgerEvidenceView, WakeLedgerRow, WakeLedgerView }

/**
 * 办公室（F03）：形状、灯词表与座位结构全部以 core 的投影为准，界面不自己再抄一份。
 * 这样 core 改灯或加字段时，插件的类型检查会立刻报出来，而不是静默显示旧口径。
 */
// eslint-disable-next-line import/no-duplicates -- 类型集中再导出
import type {
  DoorwayView, OfficeDeskView, OfficeDoorView, OfficeHealthView,
  OfficeLight, OfficeOccupantView, OfficeView, SeatView,
} from '@agent-hub/core'
export type {
  DoorwayView, OfficeDeskView, OfficeDoorView, OfficeHealthView,
  OfficeLight, OfficeOccupantView, OfficeView, SeatView,
}

/**
 * 资料授权矩阵（V2-PH2-04）：视图形状以 core 的 api/resource-views.ts 组装结果为准，
 * 插件不自己抄字段，core 改口径时类型检查会立刻报出来。type-only import 在编译期擦除，
 * 不进客户端 bundle。授权判定（canRead/effectiveGrants）仍只在 core，前端只渲染。
 */
// eslint-disable-next-line import/no-duplicates -- 类型集中再导出
import type { Grant, Resource, ResourceGrantViewRow, ResourceView, ResourceViewRow } from '@agent-hub/core'
export type { Grant, Resource, ResourceGrantViewRow, ResourceView, ResourceViewRow }

/**
 * 项目容器（V2-PH4-02）：视图形状以 core 的 api/project-views.ts 组装结果为准
 * （Project/ProjectTask 模型与 ProjectView 行类型），插件不自己抄字段，core 改口径时
 * 类型检查会立刻报出来。type-only import 在编译期擦除，不进客户端 bundle。
 * 任务能不能流转、驳回理由合不合法只在 core 的状态机里判定，前端只渲染与前置校验。
 */
// eslint-disable-next-line import/no-duplicates -- 类型集中再导出
import type {
  CriterionStatus, Project, ProjectBackgroundView, ProjectContext, ProjectContextProposal, ProjectContextProposalView,
  ProjectContextRevision, ProjectContextRevisionView, ProjectCriterionView, ProjectIssueView,
  ProjectLayersView, ProjectMemberView, ProjectOriginalLayerView, ProjectPathView, ProjectStatus, ProjectTask,
  ProjectTaskAcceptanceView, ProjectTaskArtifactView, ProjectTaskView, ProjectTaskWakeView,
  ProjectTeamLayerView, ProjectTopic, ProjectTopicView, ProjectView, ProjectViewRow, TaskStatus,
} from '@agent-hub/core'
export type {
  CriterionStatus, Project, ProjectBackgroundView, ProjectContext, ProjectContextProposal, ProjectContextProposalView,
  ProjectContextRevision, ProjectContextRevisionView, ProjectCriterionView, ProjectIssueView,
  ProjectLayersView, ProjectMemberView, ProjectOriginalLayerView, ProjectPathView, ProjectStatus, ProjectTask,
  ProjectTaskAcceptanceView, ProjectTaskArtifactView, ProjectTaskView, ProjectTaskWakeView,
  ProjectTeamLayerView, ProjectTopic, ProjectTopicView, ProjectView, ProjectViewRow, TaskStatus,
}
/** P40：预置 skill 的只读候选（名称、用途、加载条件），正文不下发到界面。 */
import type { PresetSkillOption } from '@agent-hub/core'
export type { PresetSkillOption }

// ---------- 第 15.1 节视图结构（字段名逐字照抄） ----------

export type Light = 'green' | 'yellow' | 'orange' | 'red'

export interface BotCard {
  id: string; name: string; role: Role; roleLabel: string; color: string; initials: string   // initials：名字前 1–2 个字
  lifecycle: Lifecycle; lifecycleLabel: string; activity: Activity; activityLabel: string; activityText: string
  nextThinkText: string            // 例「有变化时，最晚周四 09:00」「明天 09:00（它自己定的：等日报出来）」
  lastOutcome: Outcome | null; lastOutcomeLabel: string | null; lastActiveAt?: number | null; lastActiveText: string | null
  unread: number                   // 线程未读
  todayThinks: number; todayBudget: number; todayTokens: number
  waitingOwner: boolean            // 有在等主人的提问或审批
  /** P48：已归档的队友只在「已归档」折叠区显示；旧夹具缺省视为未归档。 */
  archived?: boolean
}

export interface OverviewView {
  bots: BotCard[]
  /**
   * 这份总览只是占位，bots 为空不代表队友都没了（P58）。
   * 目前只有中心停用时的 DisabledHub 会带上它：真名册读不到，界面不能据此判断谁不存在。
   */
  rosterUnavailable?: true
  costs?: import('@agent-hub/core').CostView
  inbox: { total: number; approvals: number; questions: number; proposals: number; alerts: number }
  team: { unread: number; lastMessageText: string | null }
  quota: { light: Light; lightLabel: string; usedText: string; resetText: string | null }
  health: { ok: boolean; heartbeatText: string; downtimeText: string | null; openAlerts: number; sandboxWarning: string | null }
  nowText: string; quietNow: boolean; pushesLeftToday: number
}

export interface ThreadMessageView {
  id: string; thread: string; from: 'owner' | 'hub' | string; fromName: string; fromColor: string | null
  kind: ThreadKind; text: string; createdAt: number; timeText: string
  card: null | {                   // 内嵌在线程里的可操作卡片（提问 / 审批 / 提议）
    inboxId: string; approvalId: string | null   // approvalId 仅审批卡有；decideApproval 用它，不能误传 inboxId
    goalId?: string | null
    type: 'question' | 'approval' | 'proposal' | 'alert'; status: InboxStatus
    title: string; body: string; options: string[]; defaultOption: string | null; answer: string | null; expiresText: string | null
  }
}

export interface ThreadView { threadId: string; title: string; messages: ThreadMessageView[]; hasMore: boolean; oldestId: string | null }

export interface WakeRow {
  id: string; variant: Variant; variantLabel: string; reasonKind: WakeKind; reasonText: string
  score: number; threshold: number; status: WakeStatus; outcome: Outcome | null; outcomeLabel: string | null
  summary: string | null; steps: number; tokens: number; durationText: string | null; startedAt: number; timeText: string
  /** 账本行 id；没有账本（主人直聊、旧唤醒单等）时为空。 */
  ledgerId: string | null; hasLedger: boolean
}

export interface AppraisalRow {
  id: string; at: number; timeText: string
  decision: AppraisalDecision; decisionLabel: string
  suppressedBy: AppraisalLog['suppressedBy']; text: string; score: number; threshold: number
}

export interface BotView {
  artifacts?: import('@agent-hub/core').ArtifactListView
  card: BotCard
  profile: {
    persona: string; mbti: MbtiType | null; mbtiLabel: string
    behavior?: import('@agent-hub/core').PersonalityBehavior | null
    autonomy: Autonomy; autonomyLabel: string
    pace: PaceProfile; paceLabel: string
    model: ModelChoice; modelText: string
    homeDir: string; sessionId: string | null; createdAt: number; createdText: string; probationText: string | null; workDataAllowed: boolean
    /** P40：主人勾选的预置 skill id；空数组即未启用。 */
    presetSkillIds: string[]
    /** P55：从 DSH 技能目录里选的技能名。 */
    dshSkillNames: string[]
    temperament: Temperament | null
    speechStyle: SpeechStyle | null
    /** 员工说明：主人对这位队友的其他要求。 */
    brief: string
    /** 听吩咐：只在被点名或派活时行动。 */
    onDemand: boolean
  }
  aspirations: Array<{ id: string; text: string; status: string }>
  goals: Array<{ id: string; title: string; doneWhen: string; period: string; periodText: string; status: GoalStatus; statusLabel: string; lastProgressText: string; createdBy: 'owner' | 'bot'; checkText?: string }>
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
  /**
   * P65：这件事来自哪个项目主题（主题 id 也是线程 id）和主题名；不来自主题或主题已删除时为空。
   * 可选：样例数据和旧宿主没有这两项，按「不来自主题」处理。
   */
  topicId?: string | null; topicTitle?: string | null
  type: InboxType; typeLabel: string; priority: InboxPriority
  approvalId: string | null        // 仅审批卡有；decideApproval 用它，不能误传收件箱 id
  goalId?: string | null
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
  /** P40：预置 skill 候选清单；只读，随插件版本走。 */
  presetSkillOptions: PresetSkillOption[]
  /** P55：DSH 里可选的技能；读不到目录时是空数组。 */
  dshSkillOptions: DshSkillOption[]
}

export interface RecentSessionView { sessionId: string; title: string; updatedText: string }

export type CommandResult<T = unknown> = { ok: true; data?: T } | { ok: false; error: string }
/** 产物类型由 core 统一定义；只追加可选字段兼容旧界面夹具。 */
export type { ArtifactListView, ArtifactVersionRow, ArtifactVersion, ArtifactReview } from '@agent-hub/core'

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

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
/** P73f：主人看到的员工状态只有三种（与 core model/enums.ts 的 STAFF_STATUSES 一致）；lifecycle 仅为兼容保留。 */
export type StaffStatus = 'on_duty' | 'suspended' | 'archived'
export type Activity = 'watching' | 'queued' | 'thinking' | 'waiting_owner' | 'waiting_peer' | 'blocked' | 'resting' | 'reflecting' | 'catching_up'
export type ThreadKind = 'chat' | 'reply' | 'report' | 'question' | 'approval' | 'proposal' | 'alert' | 'digest' | 'handoff' | 'peer' | 'system' | 'agreement' | 'team_question' | 'team' | 'work' | 'job_card'
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
export type SuppressionReason = 'paused' | 'waiting_owner_same_subject' | 'waiting_owner' | 'cooldown' | 'pace_min' | 'daily_cap' | 'bot_budget' | 'quota' | 'concurrency' | 'dispatch_gap' | 'startup_quiet' | 'dedup' | 'retry_backoff' | 'on_demand' | 'job_cap' | 'job_inactive' | 'skill_cap' | 'skill_daily_cap' | 'skill_expired' | 'skill_stale'
export type Autonomy = 'L0' | 'L1' | 'L2' | 'L3'
export type PaceProfile = 'active' | 'normal' | 'quiet'
/** MBTI 16 型取值，与 core 的 MbtiType 一致；null 表示未设置。 */
export type MbtiType = 'INTJ' | 'INTP' | 'ENTJ' | 'ENTP' | 'INFJ' | 'INFP' | 'ENFJ' | 'ENFP'
  | 'ISTJ' | 'ISFJ' | 'ESTJ' | 'ESFJ' | 'ISTP' | 'ISFP' | 'ESTP' | 'ESFP'
/** 宿主模型选择；null 表示跟随宿主默认模型（与 core ModelChoice 一致）。 */
export type ModelChoice = { provider: string; model: string } | null

/**
 * P76k：额度窗口视图与最近 7 天用量表的类型一律以 core 为准（quota-views.ts、usage-views.ts）。
 * type-only import 在编译期擦除，不进客户端 bundle；core 改字段时类型检查会立刻报出来。
 */
import type { QuotaWindowView as CoreQuotaWindowView, WeeklyUsageView } from '@agent-hub/core'
export type { WeeklyUsageView }
/**
 * P86：界面这一侧的额度窗口视图 = core 的视图，但「本窗口员工已用 token」的两项（文字、原始数字）改为可选。
 * 为什么可选：旧宿主（升级前的 core）给出的视图里没有这两项，界面读到缺失时顶栏退回只写回合数的旧写法，不能报错。
 * core 自己的类型里这两项是必填的，core 的视图直接赋给这个类型也成立（必填可以赋给可选）。
 */
export type QuotaWindowView = Omit<CoreQuotaWindowView, 'staffUsedTokensText' | 'staffUsedTokens'>
  & Partial<Pick<CoreQuotaWindowView, 'staffUsedTokensText' | 'staffUsedTokens'>>

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
/**
 * P72e：约定的视图类型一律以 core 为准（agreement-views.ts 组装的结果），插件不自己抄字段。
 * type-only import 在编译期擦除，不进客户端 bundle。
 */
import type { AgreementCardView, AgreementPanelView, AgreementRevisionRow } from '@agent-hub/core'
export type { AgreementCardView, AgreementPanelView, AgreementRevisionRow }
/**
 * P73e：三问卡与组队卡的视图类型一律以 core 为准（api/team-views.ts 组装的结果），插件不自己抄字段。
 * type-only import 在编译期擦除，不进客户端 bundle。
 */
import type { TeamCandidateView, TeamCardView, TeamQuestionView } from '@agent-hub/core'
export type { TeamCandidateView, TeamCardView, TeamQuestionView }
/**
 * P74h：「一件事」的视图类型一律以 core 为准（api/job-views.ts、job-card-views.ts、agreement-views.ts 组装的结果），
 * 插件不自己抄字段；样例数据（shared/fixture-job.ts）也调用 core 的视图函数生成，不手写视图字段。
 */
// eslint-disable-next-line import/no-duplicates -- 类型集中再导出
import type {
  ActiveJobRow, ActiveJobsView, DeliveryCardView, EscalationCardView, EvidenceItemView, JobCardView, JobProgressView, JobSplitView, ProjectJobRow,
  ReceiptCardView, TopicFloorsView,
} from '@agent-hub/core'
export type {
  ActiveJobRow, ActiveJobsView, DeliveryCardView, EscalationCardView, EvidenceItemView, JobCardView, JobProgressView, JobSplitView, ProjectJobRow,
  ReceiptCardView, TopicFloorsView,
}
/** P40：预置 skill 的只读候选（名称、用途、加载条件），正文不下发到界面。 */
import type { PresetSkillOption } from '@agent-hub/core'
export type { PresetSkillOption }
/**
 * P75j：技能库的四个视图类型。core 的包入口没有按名字导出这些类型，只在界面接口 UiApi 的签名里使用，
 * 所以这里从 UiApi 的返回值取出来，与 core 逐字同形（core 改了字段，类型检查会立刻报出来）。
 */
import type { UiApi } from '@agent-hub/core'
export type SkillLibraryView = ReturnType<UiApi['skillLibrary']>
export type SkillDetailView = ReturnType<UiApi['skillDetail']>
export type SkillTicksView = SkillLibraryView['ticks']
export type SkillCompareView = NonNullable<SkillDetailView['compare']>
/**
 * P75k：记忆与复盘的视图类型，一律以 core 为准（界面不自己抄字段）：
 * - 「已记住」一行（MemoryNoteView）、记忆页（MemoryPageView、MemoryEntryView）；
 * - 主题折叠组里的复盘卡（RetroCardView）与技能核对卡（SkillCheckCardView），二者都在 JobCardView 联合里。
 * MemoryPageView 取自界面接口 UiApi 的返回值，与 core 逐字同形。
 */
import type { MemoryNoteView } from '@agent-hub/core'
export type { MemoryNoteView }
export type MemoryPageView = ReturnType<UiApi['memoryPage']>
export type MemoryEntryView = MemoryPageView['groups'][number]['entries'][number]
export type MemoryTabKey = MemoryPageView['tabs'][number]['key']
export type RetroCardView = Extract<JobCardView, { kind: 'retro' }>
export type SkillCheckCardView = Extract<JobCardView, { kind: 'skill_check' }>

// ---------- 第 15.1 节视图结构（字段名逐字照抄） ----------

export type Light = 'green' | 'yellow' | 'orange' | 'red'

export interface BotCard {
  id: string; name: string; role: Role; roleLabel: string; color: string; initials: string   // initials：名字前 1–2 个字
  /** P73r4：员工所用模板的显示标签（如「评审」）；没有模板或模板没有标签时为 null，界面退回 roleLabel。 */
  templateLabel?: string | null
  lifecycle: Lifecycle; lifecycleLabel: string
  /** P73f：员工状态（在岗、停用、归档）及停用原因；界面一切状态文字以它为准，不再显示 lifecycleLabel。 */
  staffStatus: StaffStatus; staffStatusLabel: string; staffStatusReason: string | null
  activity: Activity; activityLabel: string; activityText: string
  nextThinkText: string           // 例「有变化时，最晚周四 09:00」「明天 09:00（它自己定的：等日报出来）」
  lastOutcome: Outcome | null; lastOutcomeLabel: string | null; lastActiveAt?: number | null; lastActiveText: string | null
  unread: number                   // 线程未读
  todayThinks: number; todayBudget: number; todayTokens: number
  waitingOwner: boolean            // 有在等主人的提问或审批
  /** P48：已归档的队友只在「已归档」折叠区显示；旧夹具缺省视为未归档。 */
  archived?: boolean
  /** P72：总管的累计默契度（采纳的建议数 / 建议总数）；只有总管且已有确认记录时才给，text 是现成的一行文字。 */
  rapport?: { adopted: number; total: number; text: string } | null
  /** P74a/P74i：总管名下进行中的事的一句话（core 的 chiefJobLine，如「活动报名页　核对中」「3 件在办」）；没有为 null。 */
  chiefJobLine?: string | null
}

export interface OverviewView {
  bots: BotCard[]
  /**
   * 这份总览只是占位，bots 为空不代表队友都没了（P58）。
   * 目前只有中心停用时的 DisabledHub 会带上它：真名册读不到，界面不能据此判断谁不存在。
   */
  rosterUnavailable?: true
  /** P75d/P75k：记忆页的条数（与记忆页 total 相同），给左栏员工列表底部与总管右侧栏的入口用；旧宿主与旧样例没有这个字段。 */
  memoryCount?: number
  costs?: import('@agent-hub/core').CostView
  inbox: { total: number; approvals: number; questions: number; proposals: number; alerts: number }
  team: { unread: number; lastMessageText: string | null }
  /**
   * P76j：额度窗口视图（员工份额、两种红灯、恢复时间）；旧宿主与旧样例不带，界面退回原来的四档文字。
   * P76k：办公室从这份视图画午休牌与窗口弧；倒带回看的历史房间不传（null 或缺省都不画）。
   */
  quota: {
    light: Light; lightLabel: string; usedText: string; resetText: string | null
    window?: QuotaWindowView | null
  }
  health: { ok: boolean; heartbeatText: string; downtimeText: string | null; openAlerts: number; sandboxWarning: string | null }
  nowText: string; quietNow: boolean; pushesLeftToday: number
}

export interface ThreadMessageView {
  id: string; thread: string; from: 'owner' | 'hub' | string; fromName: string; fromColor: string | null
  kind: ThreadKind; text: string; createdAt: number; timeText: string
  /** P74h-m1：core 的线程视图还给每条消息带 createdText（完整时刻文字）；样例快照逐字携带它，这里补上这个可选字段。 */
  createdText?: string | null
  card: null | {                   // 内嵌在线程里的可操作卡片（提问 / 审批 / 提议）
    inboxId: string; approvalId: string | null   // approvalId 仅审批卡有；decideApproval 用它，不能误传 inboxId
    goalId?: string | null
    /** P75i/P75k：学习选会话的提问卡带学习记录编号（core 的 learnRunId）；其他卡片没有。界面据此把正文按行显示、选项整行可点、不显示默认项和到期说明。 */
    learnRunId?: string
    type: 'question' | 'approval' | 'proposal' | 'alert'; status: InboxStatus
    title: string; body: string; options: string[]; defaultOption: string | null; answer: string | null; expiresText: string | null
    /** P74i-m1（第二次）：core 的线程卡片视图另带 expiresAt（到期的时刻）；界面只用 expiresText，这里补上可选字段对齐形状。 */
    expiresAt?: number | null
    /** P69：审批卡的结构化内容；旧记录和样例数据没有。 */
    approval?: { actionText: string; ownerReason: string | null; riskNote: string | null; argsPreview: string
      /** P74r20：命令全文（core 的 ApprovalCardParts.argsFull，可省略）；展开「查看原始命令」时优先显示。 */
      argsFull?: string
      /** P74g/P74i：三行说明（费用、能否撤回、批准之后）与「由{员工}执行」一行；其他类别为 null。 */
      notes?: { cost: string; undo: string; after: string } | null
      onBehalfOf?: string | null
      /** P74r4b：这张审批是某件事发布这一步的审批（core 的 ApprovalCardParts.launch）；样例数据没有。 */
      launch?: boolean
      /** P74r4b-m1：中心作废的审批（界面写「已作废」）；样例数据没有。 */
      voided?: boolean }
  }
  /** P72：kind 为 agreement 时的约定卡内容；找不到对应约定或版本时为 null（界面退回显示 text）。 */
  agreement?: AgreementCardView | null
  /** P73e：kind 为 team_question 时的三问内容（第几问、选项、是否已答）；找不到记录时为 null，界面退回显示 text。 */
  teamQuestion?: TeamQuestionView | null
  /** P73e：kind 为 team 时的组队卡内容；找不到记录时为 null，界面退回显示 text。 */
  teamCard?: TeamCardView | null
  /** P74h：kind 为 job_card 时的卡片内容（交回卡、核对卡、交付卡、三轮不过卡、回执）；找不到记录时为 null，界面退回显示 text。 */
  jobCard?: JobCardView | null
  /** P75c/P75k：挂在这条消息下面的「已记住」「已删除」「已更正」行（core 的 memoryNotes）；没有时不带。 */
  memoryNotes?: MemoryNoteView[]
}

export interface ThreadView {
  threadId: string; title: string; messages: ThreadMessageView[]; hasMore: boolean; oldestId: string | null
  /** P72：主题线程且该主题有约定时给出；第一层画约定面板，没有约定的主题不带或为 null。 */
  agreement?: AgreementPanelView | null
  /** P74h：主题线程且该主题有未撤下的约定时给出进度行（约定面板底部画）；否则不带或为 null。 */
  progress?: JobProgressView | null
  /** P74h：主题线程的楼层与工作往来折叠分组；非主题线程不带。有它时楼层按它画，总数行用它的 countText。 */
  floors?: TopicFloorsView
  /**
   * P76k：总管私聊的离开期间摘要（P76i 的核心视图）。有未收起的摘要时才有这个字段；
   * 它不是消息，画在消息列表最上方，点了「知道了，收起」调用 dismissAwaySummary 后消失。
   */
  awaySummary?: { lines: string[]; dismissText: string } | null
}

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
  /** P74i-m1（第二次）：core 的收件箱视图另带 expiresAt（到期的时刻）；界面只用 expiresText，这里补上可选字段对齐形状。 */
  expiresAt?: number | null
  /** P69：审批项的结构化内容（一句话、原因、风险提示、原始命令）；旧记录和样例数据没有。 */
  approval?: { actionText: string; ownerReason: string | null; riskNote: string | null; argsPreview: string
    /** P74r20：命令全文（core 的 ApprovalCardParts.argsFull，可省略）；展开「查看原始命令」时优先显示。 */
    argsFull?: string
    /** P74g/P74i：三行说明（费用、能否撤回、批准之后；core 保证每项有文字）与「由{员工}执行」一行；其他类别为 null。 */
    notes?: { cost: string; undo: string; after: string } | null
    onBehalfOf?: string | null
    /** P74r4b：这张审批是某件事发布这一步的审批（core 的 ApprovalCardParts.launch）；样例数据没有。 */
    launch?: boolean
    /** P74r4b-m1：中心作废的审批（界面写「已作废」）；样例数据没有。 */
    voided?: boolean }
  /** P74r4b：一件事的四类条目（accept 验收、escalate 三轮不过的办法、cap 回合用到上限、stall 停住了）带这一项；其余条目没有。 */
  jobEntry?: { kind: 'accept' | 'escalate' | 'cap' | 'stall'; jobId: string } | null
  /** P76g：开着的条目满 1 小时才有（「已等 {时长}」）；不满 1 小时或旧宿主没有这个字段。 */
  waitedText?: string
  /**
   * P74r4a/P74i-m1（第二次）：说明条目（escalate）带这次说明的完整卡片视图，与总管私聊里那张卡同一份数据；
   * 界面用与对话里同一个组件画（办法的做法、代价、「选了会……」、按钮行），点办法时用卡里的 jobId、stage、revision。
   * 其余条目没有这个字段；找不到对应记录时为 null（只显示正文，不给可提交的按钮）。
   */
  escalationCard?: EscalationCardView | null
  /** P72：约定确认条目带的约定 id 与版本号；普通条目没有。界面据此隐藏自由文本输入。 */
  agreementId?: string | null
  agreementVersion?: number | null
  /** P74r14：约定确认条目带这份约定的标题；普通条目没有。 */
  agreementTitle?: string | null
  /** P74r8：这一版约定有两栏（有一件事正在按上一版做）；约定确认条目才带。 */
  agreementJobSplit?: boolean
  /** P74r8：这一版写明这件事不再做（确认后停止）；约定确认条目才带。 */
  agreementStop?: boolean
  /** P73e：组队确认条目带的组队卡 id；普通条目没有。界面据此只显示一个按钮、隐藏自由文本、写「不会自动入职」。 */
  teamProposalId?: string | null
  /** P75r7：学习选会话的提问条目（core 的 InboxItemView.learnRunId，同形）带学习记录编号；其他条目没有。界面据此把条目画成学习卡。 */
  learnRunId?: string
  /**
   * P74r16b：「员工被中心停用」的告警条目才带，并且只在这位员工此刻仍被中心停用时给出（核心 InboxItemView.reinstate，同形）。
   * 界面据此在「知道了」旁多画一个「恢复在岗」按钮；点按钮时调用回答收件箱的命令，answer 传这里的 answer（固定为 reinstate）。
   * 没有这个字段（样例数据、员工已在岗、手动停用、别的告警）时条目与原来完全一样。
   */
  reinstate?: { botId: string; botName: string; answer: 'reinstate' }
}

export interface InboxView { items: InboxItemView[] }

export interface ActivityRow {
  id: string; at: number; timeText: string
  botId: string | null; botName: string | null; botColor: string | null
  /** P75i：核心新增 'skill'（技能库记录）与 lines（同一组的细项）；界面现在不画，由 P75k 画（见 client/logic/feeds.ts 的白名单）。 */
  kind: 'wake' | 'commit' | 'approval' | 'alert' | 'handoff' | 'peer' | 'lifecycle' | 'system' | 'skill'
  text: string
  lines?: string[]
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

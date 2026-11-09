/** 界面契约逐项保留规格 15.1 字段，时间额外提供原始毫秒，界面无需读取内部表或自行拼装文案。 */
import type { Activity, AgendaItem, AppraisalLog, Autonomy, Bot, Goal, Grant, GrantLevel, GrantSubjectKind, InboxItem, Lifecycle, MbtiType, ModelChoice, Outcome, PaceProfile, Project, ProjectContext, ProjectContextProposal, ProjectContextRevision, ProjectTask, Resource, Role, Settings, ThreadMessage, Variant, WakeKind, WakeTicket, Watch } from '../model/index.js';
import type { LedgerActionKind, LedgerActionOutcome, LedgerActionSource, LedgerCompleteness, LedgerEvidenceKind,
  LedgerSource, LedgerTrust, WakeLedgerEntry } from '../model/wake-ledger.js';
/** 办公室视图在 UiApi 里直接使用，因此在本地导入；下方再统一向界面再导出。 */
import type { OfficeView } from '../office/project.js';
import type { OfficeReplayView } from '../office/replay.js';
export type { OfficeReplayView } from '../office/replay.js';
import type { ResultCheck } from '../model/result-check.js';
import type { ArtifactVersion, ArtifactReview } from '../model/artifact.js';
import type { ArtifactListView } from '../artifacts/views.js';
import type { PresetSkillOption } from '../config/preset-skills.js';
export type { PresetSkillOption } from '../config/preset-skills.js';
export type { ArtifactListView, ArtifactVersionRow } from '../artifacts/views.js';

/** 资料视图里的一条授权展开行：带上资料名与授权对象（队友）中文名，界面不再自行查表。 */
export interface ResourceGrantViewRow {
  grant: Grant;
  resourceName: string | null;
  subjectKind: GrantSubjectKind;
  subjectKindLabel: string;
  subjectId: string;
  subjectName: string | null;
  level: GrantLevel;
  levelLabel: string;
}
/** 资料视图里的一行资料：中文类型/敏感性标签、归档标记与该资料的全部授权。 */
export interface ResourceViewRow {
  resource: Resource;
  kindLabel: string;
  sensitivityLabel: string;
  archived: boolean;
  grants: ResourceGrantViewRow[];
}
/** 中心资料全貌：资料列表（未归档在前）、授权列表与计数；旧存档缺两表时全部为空。 */
export interface ResourceView {
  asOf: number;
  resources: ResourceViewRow[];
  grants: ResourceGrantViewRow[];
  counts: { total: number; active: number; archived: number; grants: number };
}

/** 项目视图里的成员队友行：队友档案缺失或已退役时 name 为 null、invalid 为 true。 */
export interface ProjectMemberView {
  botId: string;
  name: string | null;
  invalid: boolean;
}
/** 验收项视图：原始记录加中文状态标签。 */
export interface ProjectCriterionView {
  id: string;
  text: string;
  verify: string;
  status: Project['acceptanceCriteria'][number]['status'];
  statusLabel: string;
}
/**
 * 任务关联唤醒的链接视图：账本在时可下钻到机器人右栏的这次唤醒；
 * 账本查不到（超过保留期或旧档没记录）时保留唤醒 id 并给 null，界面据此显示不可点。
 */
export interface ProjectTaskWakeView {
  wakeId: string;
  /** 账本所属机器人；查不到账本时为 null。 */
  botId: string | null;
  /** 队友名字；队友已删除时为 null（账本仍保留，但右栏打不开）。 */
  botName: string | null;
  ledgerId: string | null;
  variantLabel: string | null;
  statusLabel: string | null;
  triggerLabel: string | null;
  /** 给主人看的唤醒理由；查不到账本时为空。 */
  summary: string | null;
  openedAt: number | null;
  openedText: string | null;
}
/** 任务关联产物的一行：固定到具体版本，附最近一次验收结论与该版本是不是这份产物的最新版。 */
export interface ProjectTaskArtifactView {
  versionId: string;
  artifactId: string;
  number: number;
  title: string;
  bytes: number;
  createdAt: number;
  createdText: string | null;
  sha256: string;
  /** 最近一次验收结论；从没验收过为 null。 */
  reviewVerdict: import('../model/artifact.js').ArtifactVerdict | null;
  reviewLabel: string | null;
  /** 是否这份产物的最新版本：挂产物头 id 时视图自动跟随最新版。 */
  isLatest: boolean;
}
/** 验收前提醒（不阻断验收）：只是把主人在点「验收通过」前该看一眼的事实摆出来。 */
export interface ProjectTaskAcceptanceView {
  hints: string[];
}
/** 任务视图行：状态标签、指派队友名字与失效标记、关联产物、验收提醒、关联唤醒链接。 */
export interface ProjectTaskView {
  task: ProjectTask;
  statusLabel: string;
  assigneeBotId: string | null;
  assigneeBotName: string | null;
  assigneeInvalid: boolean;
  artifactCount: number;
  artifacts: ProjectTaskArtifactView[];
  acceptance: ProjectTaskAcceptanceView;
  wakes: ProjectTaskWakeView[];
}
/** 项目问题直接复用纯汇总层的问题结构，避免两处定义漂移。 */
export type ProjectIssueView = import('../project/project-summary.js').ProjectIssue;
/**
 * 项目的「原始版本」层（P34，DC15 两层口径）：DSH 既有的原生工作区那一半。
 * 插件不复制、不改写它：原生会话与设置保持原样，这里只给只读投影。
 */
export interface ProjectOriginalLayerView {
  /** 恒为 true：界面据此只陈列、不给任何写入口。 */
  readOnly: true;
  /** 工作区目录：与队友项目版本共用同一个目录，不另造项目实体。 */
  workspaceDir: string;
}
/** 项目的「队友项目版本」层：插件管的这一半——愿景、约定、成员、共享目录与验收项。 */
export interface ProjectTeamLayerView {
  /** 恒为 false：这一层可由主人编辑（项目未归档时）。 */
  readOnly: false;
  vision: string;
  conventions: string;
  memberCount: number;
  sharedDir: string;
  criterionCount: number;
}
/** 一个项目的两层只读投影：原始版本与队友项目版本。 */
export interface ProjectLayersView {
  original: ProjectOriginalLayerView;
  team: ProjectTeamLayerView;
}
/**
 * 一条共享上下文的修改留痕（P39）：原始记录 + 中文标签 + 编辑者名字 + 短哈希。
 * 编辑者查不到（队友已删除）时 editorName 固定为「已删除的队友」，内部 id 只留给悬停排障。
 */
export interface ProjectContextRevisionView {
  revision: ProjectContextRevision;
  editorName: string;
  editorKindLabel: string;
  sourceLabel: string;
  timeText: string | null;
  hashShort: string;
}
/** 一条待审上下文建议：完整四段用于展开查看，summary 是人话的「会改哪几段」。 */
export interface ProjectContextProposalView {
  proposal: ProjectContextProposal;
  botName: string | null;
  botInvalid: boolean;
  createdText: string | null;
  summary: string;
}
/** 单个项目的视图行：项目原文、负责人/成员/验收项/任务展开、两层、汇总与问题。 */
export interface ProjectViewRow {
  project: Project;
  statusLabel: string;
  ownerBotId: string | null;
  ownerName: string | null;
  ownerInvalid: boolean;
  members: ProjectMemberView[];
  criteria: ProjectCriterionView[];
  tasks: ProjectTaskView[];
  taskCounts: import('../project/project-summary.js').TaskStatusCounts;
  progress: number;
  issues: ProjectIssueView[];
  /** P34：同一工作区的两层只读投影。 */
  layers: ProjectLayersView;
  /** P39：四段正文（非成员界面上不渲染；空上下文的行由界面整块隐藏）。 */
  context: ProjectContext;
  /** 四段全空即未配置：项目页不显示空卡片。 */
  contextEmpty: boolean;
  /** 正文文件的绝对路径；只给主人看，队友通过唤醒包摘要获知。 */
  contextFilePath: string;
  /** 修改留痕，最新在前。 */
  contextRevisions: ProjectContextRevisionView[];
  /** 待主人确认的队友建议，最新在前；已处理的不再返回。 */
  contextProposals: ProjectContextProposalView[];
}
/** 项目容器全貌：非归档项目在前、归档沉底；旧存档缺两表时全部为空。 */
export interface ProjectView {
  asOf: number;
  projects: ProjectViewRow[];
  counts: {
    active: number;
    paused: number;
    done: number;
    archived: number;
    total: number;
    tasksTotal: number;
    tasksPendingCheck: number;
  };
}

/** 办公室投影的类型定义在纯函数层，界面契约只做再导出，避免两处字段漂移。 */
export type {
  DoorwayView, OfficeDeskView, OfficeDoorView, OfficeHealthView,
  OfficeOccupantView, OfficeView, SeatView,
} from '../office/project.js';

export type Light = 'green' | 'yellow' | 'orange' | 'red';
export type CommandResult<T = unknown> = { ok: true; data?: T } | { ok: false; error: string };
export interface BotCard {
  id: string; name: string; role: Role; roleLabel: string; color: string; initials: string;
  lifecycle: Lifecycle; lifecycleLabel: string; activity: Activity; activityLabel: string; activityText: string;
  nextThinkAt: number | null; nextThinkText: string; lightCheckAt: number | null;
  lastOutcome: Outcome | null; lastOutcomeLabel: string | null; lastActiveAt: number | null; lastActiveText: string | null;
  unread: number; todayThinks: number; todayBudget: number; todayTokens: number; waitingOwner: boolean;
  /** P48：已归档的队友不在左栏名单显示，只在「已归档」折叠区出现。 */
  archived: boolean;
}
export interface OverviewView {
  bots: BotCard[];
  /** 成本口径包含主人发起；可选字段兼容旧宿主与离线夹具。 */
  costs?: import('./cost-views.js').CostView;
  inbox: { total: number; approvals: number; questions: number; proposals: number; alerts: number };
  team: { unread: number; lastMessageText: string | null };
  quota: { light: Light; lightLabel: string; usedText: string; resetAt: number | null; resetText: string | null };
  health: { ok: boolean; heartbeatAt: number | null; heartbeatText: string; downtimeAt: number | null; downtimeText: string | null; openAlerts: number;
    /** 沙箱不可用时的固定说明；null 表示最近一次宿主命令正常或尚未执行。 */
    sandboxWarning: string | null };
  nowAt: number; nowText: string; quietNow: boolean; pushesLeftToday: number;
}
export interface ThreadMessageView {
  id: string; thread: string; from: string; fromName: string; fromColor: string | null;
  kind: ThreadMessage['kind']; text: string; createdAt: number; timeText: string; createdText: string;
  card: null | { inboxId: string; approvalId: string | null; goalId?: string | null; type: InboxItem['type']; status: InboxItem['status']; title: string; body: string;
    options: string[]; defaultOption: string | null; answer: string | null; expiresAt: number | null; expiresText: string | null };
}
export interface ThreadView { threadId: string; title: string; messages: ThreadMessageView[]; hasMore: boolean; oldestId: string | null }
export interface WakeRow {
  id: string; variant: Variant; variantLabel: string; reasonKind: WakeKind; reasonText: string; score: number; threshold: number;
  status: WakeTicket['status']; outcome: Outcome | null; outcomeLabel: string | null; summary: string | null;
  steps: number; tokens: number; durationMs: number | null; durationText: string | null; startedAt: number; timeText: string; startedText: string;
  /** 账本行 id；没有账本（例如主人直聊）时为空。 */
  ledgerId: string | null; hasLedger: boolean;
}
/** 账本列表摘要：只给列表需要的标签与计数，详情通过 wakeLedgerDetail 读取。 */
export interface WakeLedgerRow {
  id: string; wakeId: string; botId: string; botName: string; botColor: string;
  variant: Variant; variantLabel: string; status: WakeTicket['status']; statusLabel: string;
  source: LedgerSource; sourceLabel: string; completeness: LedgerCompleteness; completenessLabel: string;
  triggerKind: WakeKind; triggerKindLabel: string; triggerText: string; triggerScore: number; triggerThreshold: number;
  outcome: Outcome | null; outcomeLabel: string | null; summary: string | null;
  openedAt: number; openedText: string; sealedAt: number | null; sealedText: string | null;
  steps: number; tokens: number; actionCount: number; evidenceCount: number;
  truncated: boolean; hasMissing: boolean; missingLabels: string[];
}
export interface WakeLedgerEvidenceView {
  kind: LedgerEvidenceKind; kindLabel: string; refId: string; summary: string;
  trust: LedgerTrust; trustLabel: string; occurredAt: number | null; occurredText: string | null;
}
export interface WakeLedgerActionView {
  kind: LedgerActionKind; kindLabel: string; name: string; target: string | null;
  outcome: LedgerActionOutcome; outcomeLabel: string; source: LedgerActionSource; sourceLabel: string;
  refId: string | null; detail: string; durationMs: number | null;
}
/** 账本详情：完整条目加已翻译的标签，界面不再自己拼装文案。 */
export interface WakeLedgerView {
  /** 原始交账仍存在时提供完整汇报；账本快照本身仍保留原有压缩与封存口径。 */
  fullReport?: string | null;
  entry: WakeLedgerEntry;
  row: WakeLedgerRow;
  evidence: WakeLedgerEvidenceView[];
  actions: WakeLedgerActionView[];
  verificationLabel: string | null;
  /** 独立于已封存账本的中心实查与主人验收；旧档缺省时不可声称已校验。 */
  resultCheck?: ResultCheck | null;
  /** 机器人声明的世界变化；界面必须标注「机器人自述」。 */
  worldChanges: Array<{ what: string; whoCanSee: string; visibilityLabel: string; where: string }>;
  /** 缺失字段的中文标签；保留完整度说明。 */
  missingLabels: string[];
}
export interface AppraisalRow {
  id: string; at: number; timeText: string; decision: AppraisalLog['decision']; decisionLabel: string;
  suppressedBy: AppraisalLog['suppressedBy']; text: string; score: number; threshold: number;
}
export interface BotView {
  artifacts?: ArtifactListView;
  card: BotCard;
  profile: { persona: string; mbti: MbtiType | null; mbtiLabel: string; autonomy: Autonomy; autonomyLabel: string;
    behavior?: import('../personality/behavior.js').PersonalityBehavior | null;
    pace: PaceProfile; paceLabel: string; model: ModelChoice;
    modelText: string; homeDir: string; sessionId: string | null; createdAt: number; createdText: string;
    probationAt: number | null; probationText: string | null; workDataAllowed: boolean;
    /** P40：主人勾选的预置 skill id；界面用设置视图里的清单翻译成人话。 */
    presetSkillIds: string[] };
  aspirations: Array<{ id: string; text: string; status: string }>;
  goals: Array<{ id: string; title: string; doneWhen: string; period: string; periodAt: number | null; periodText: string;
    status: Goal['status']; statusLabel: string; lastProgressAt: number; lastProgressText: string; createdBy: 'owner' | 'bot'; checkText?: string }>;
  agenda: Array<{ id: string; kind: AgendaItem['kind']; kindLabel: string; title: string; dueAt: number | null; dueText: string | null;
    priority: number; toOwner: boolean; source: AgendaItem['source']; status: AgendaItem['status'] }>;
  watches: Array<{ id: string; kind: Watch['kind']; kindLabel: string; target: string; filter: string | null; intervalMs: number | null;
    intervalText: string | null; expectationText: string | null; status: Watch['status']; createdBy: Watch['createdBy']; why: string;
    lastCheckedAt: number | null; lastCheckedText: string | null }>;
  routines: Array<{ id: string; name: string; whenToUse: string; steps: string[]; runs: number; updatedAt: number; updatedText: string }>;
  rules: Array<{ id: string; text: string; redLine: boolean; scope: 'global' | 'bot' }>;
  memoryExcerpt: string; wakes: WakeRow[]; appraisals: AppraisalRow[];
  stats: { thinks7d: number; intervalCv: number | null; selfPacedRatio: number | null; selfInitiated7d: number; proposalAcceptRate: number | null; tokens7d: number };
}
export interface InboxItemView {
  id: string; botId: string | null; botName: string | null; botColor: string | null; type: InboxItem['type']; typeLabel: string;
  /** 仅审批卡为实际批准票 id；调用 decideApproval 使用它，不能误传收件箱 id。 */
  approvalId: string | null;
  goalId?: string | null;
  priority: InboxItem['priority']; title: string; body: string; options: string[]; defaultOption: string | null;
  createdAt: number; createdText: string; expiresAt: number | null; expiresText: string | null;
}
export interface InboxView { items: InboxItemView[] }
export interface ActivityRow {
  id: string; at: number; timeText: string; botId: string | null; botName: string | null; botColor: string | null;
  kind: 'wake' | 'commit' | 'approval' | 'alert' | 'handoff' | 'peer' | 'lifecycle' | 'system'; text: string;
}
export interface ActivityView { rows: ActivityRow[]; hasMore: boolean }
export interface SettingsView { settings: Settings; pushChannelOptions: string[]; modelOptions: Array<{ value: ModelChoice; label: string }>;
  /** P40：内置预置 skill 的只读候选清单（名称、用途、加载条件），供向导与档案页勾选。 */
  presetSkillOptions: PresetSkillOption[] }
/**
 * P38 设置页「测试连接」结果：unconfigured 未配置；invalid 配置形状不合法（errors 逐项中文）；
 * unsupported 协议暂无适配；ok 连通；failed 适配返回的失败原因（连不上、鉴权失败等）。
 */
export interface KnowledgeConnectionState {
  state: 'unconfigured' | 'invalid' | 'unsupported' | 'ok' | 'failed';
  host: string | null;
  protocol: string | null;
  reason: string | null;
  errors: string[];
}
export interface RecentSessionView { sessionId: string; title: string; updatedAt: number; updatedText: string }
/** 分页使用记录 id 作为稳定游标，也兼容旧界面的毫秒游标；同一毫秒不会因 id 游标丢消息。 */
export interface PageInput { before?: string | number; limit?: number }
/** 命令接收 unknown 是刻意的：宿主的 JSON 必须在边界校验，不能靠 TypeScript 类型假定安全。 */
export interface UiApi {
  readArtifactVersion(input: unknown): Promise<CommandResult<ArtifactVersion>>;
  reviewArtifact(input: unknown): Promise<CommandResult<ArtifactReview>>;
  overview(): OverviewView;
  bot(botId: string): Promise<BotView>;
  thread(threadId: string, page?: PageInput): ThreadView;
  inbox(): InboxView;
  activity(page?: PageInput): ActivityView;
  settings(): Promise<SettingsView>;
  recentSessions(): Promise<RecentSessionView[]>;
  /** 按机器人列出账本摘要，按封存时间倒序；before 为上一页最后一条的时间游标。 */
  wakeLedgerList(botId: string, limit?: number, before?: number): WakeLedgerRow[];
  /** 按 wakeId 读取一次唤醒的完整账本；没有账本时返回 null。 */
  wakeLedgerDetail(wakeId: string): WakeLedgerView | null;
  /** 团队编制已取消：不再提供 org 视图与六条编制命令。 */
  /** 中心资料只读视图：资料列表、授权展开与归档标记。 */
  resourceView(): ResourceView;
  /** 项目容器只读视图：项目、成员队友、验收项、任务展开、问题与计数。 */
  projectView(): ProjectView;
  /** 办公室纯投影：队友座位、灯、桌上的产出与门口信箱。 */
  officeView(): OfficeView;
  officeReplay(raw: unknown): Promise<CommandResult<OfficeReplayView>>;
  saveResource(input: unknown): Promise<CommandResult<Resource>>;
  archiveResource(id: string): Promise<CommandResult<Resource>>;
  setGrant(input: unknown): Promise<CommandResult<Grant>>;
  revokeGrant(input: unknown): Promise<CommandResult<{ revoked: boolean }>>;
  saveProject(input: unknown): Promise<CommandResult<Project>>;
  pauseProject(id: string): Promise<CommandResult<Project>>;
  resumeProject(id: string): Promise<CommandResult<Project>>;
  completeProject(id: string): Promise<CommandResult<Project>>;
  archiveProject(id: string): Promise<CommandResult<Project>>;
  /** 取消归档：已归档项目回到进行中，任务原样保留。 */
  restoreProject(id: string): Promise<CommandResult<Project>>;
  /** 主人保存项目共享上下文：合并四段、落 context.md、追加留痕；内容未变不留痕。 */
  saveProjectContext(input: unknown): Promise<CommandResult<Project>>;
  /** 主人采纳队友的上下文建议：按建议内容写入并留痕（编辑者记为队友）。 */
  approveProjectContextProposal(id: string): Promise<CommandResult<Project>>;
  /** 主人驳回队友的上下文建议：只改建议状态，不碰项目正文。 */
  rejectProjectContextProposal(id: string): Promise<CommandResult<ProjectContextProposal>>;
  saveTask(input: unknown): Promise<CommandResult<ProjectTask>>;
  /** 主人把一份产物关联到任务（产物头 id 或版本 id）；重复挂同一份产物按幂等处理。 */
  attachTaskArtifact(input: unknown): Promise<CommandResult<ProjectTask>>;
  /** 主人点名派活：任务 todo→doing，建任务议程并排队一条主人发起的唤醒。 */
  assignTask(input: unknown): Promise<CommandResult<ProjectTask>>;
  /** 主人点名派活/催办/改派：必须带项目与任务、队友 id，可带留言；复用议程与 owner_message 候选。 */
  dispatchTask(input: unknown): Promise<CommandResult<ProjectTask>>;
  taskBlock(id: string): Promise<CommandResult<ProjectTask>>;
  taskResume(id: string): Promise<CommandResult<ProjectTask>>;
  reportDone(id: string): Promise<CommandResult<ProjectTask>>;
  acceptTask(id: string): Promise<CommandResult<ProjectTask>>;
  rejectTask(input: unknown): Promise<CommandResult<ProjectTask>>;
  createBot(input: unknown): Promise<CommandResult<Bot>>;
  updateBot(botId: string, patch: unknown): Promise<CommandResult<Bot>>;
  /** 按用户动作切换生命周期；入口校验 botId 和 action。 */
  lifecycleAction(input: unknown): Promise<CommandResult<Bot>>;
  /** P48：归档前置校验；返回受影响的项目成员身份与未结任务数。 */
  archiveBotCheck(botId: string): Promise<CommandResult<import('./bots.js').ArchiveBotCheck>>;
  /** P48：归档已退役的队友；只写可恢复标记，不动历史。 */
  archiveBot(botId: string): Promise<CommandResult<Bot>>;
  /** P48：恢复已归档的队友，回到退役名单。 */
  restoreArchivedBot(botId: string): Promise<CommandResult<Bot>>;
  /** P48：删除已归档队友的配置与档案；历史记录保留。 */
  deleteArchivedBot(botId: string): Promise<CommandResult>;
  /** 主人打断只取消在途工作，不计未交账或机器人错误。 */
  interruptBot(input: unknown): Promise<CommandResult<WakeTicket>>;
  setLifecycle(botId: string, lifecycle: Lifecycle): Promise<CommandResult<Bot>>;
  sendMessage(threadId: string, text: string): Promise<CommandResult>;
  answerInbox(id: string, answer: string): Promise<CommandResult>;
  decideApproval(id: string, approve: boolean, note?: string): Promise<CommandResult>;
  upsertAspiration(input: unknown): Promise<CommandResult>;
  upsertGoal(input: unknown): Promise<CommandResult>;
  closeGoal(id: string, outcome: 'done' | 'active' | 'abandoned' | 'not_done' | 'incorrect' | 'mismatch' | boolean): Promise<CommandResult>;
  upsertWatch(input: unknown): Promise<CommandResult>;
  decideWatchProposal(id: string, approve: boolean): Promise<CommandResult>;
  upsertRule(input: unknown): Promise<CommandResult>;
  editRoutine(id: string, patch: unknown): Promise<CommandResult>;
  teach(botId: string, sessionId: string, note: string): Promise<CommandResult>;
  pokeBot(botId: string, text?: string): Promise<CommandResult>;
  updateSettings(patch: unknown): Promise<CommandResult>;
  /** P38：按设置页的连接草稿做一次只读自检（不落任何设置，不产生审批）。 */
  testKnowledgeConnection(input: unknown): Promise<CommandResult<KnowledgeConnectionState>>;
  markThreadRead(threadId: string): Promise<CommandResult>;
}

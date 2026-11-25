/** 界面契约逐项保留规格 15.1 字段，时间额外提供原始毫秒，界面无需读取内部表或自行拼装文案。 */
import type { Activity, AgendaItem, AppraisalLog, Autonomy, Bot, Goal, Grant, GrantLevel, GrantSubjectKind, InboxItem, Lifecycle, MbtiType, ModelChoice, Outcome, PaceProfile, Project, ProjectContext, ProjectContextProposal, ProjectContextRevision, ProjectTask, Resource, Role, Settings, Sketch, ThreadMessage, Variant, WakeKind, WakeTicket, Watch } from '../model/index.js';
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
import type { DshSkillOption } from './skills.js';
export type { DshSkillOption } from './skills.js';
import type { SpeechStyle, StaffStatus, Temperament } from '../model/enums.js';
import type { TeamCardView, TeamQuestionView } from './team-views.js';
export type { TeamCardView, TeamCandidateView, TeamQuestionView } from './team-views.js';
export type { ArtifactListView, ArtifactVersionRow } from '../artifacts/views.js';
// P74a：「一件事」的三个视图；类型由 zod 结构推出，插件的一致性测试用同一份 schema 校验。
import type { z } from 'zod';
import type { DeliveryCardViewSchema, EscalationCardViewSchema, ReceiptCardViewSchema, EvidenceItemViewSchema, JobCardViewSchema, JobProgressViewSchema, JobSplitViewSchema, ProjectJobRowSchema, ReviewCardViewSchema, SubmissionCardViewSchema, TopicFloorsViewSchema } from './job-view-schemas.js';
export type JobProgressView = z.infer<typeof JobProgressViewSchema>;
// P74e：约定卡上执行中改约定的两栏。
export type JobSplitView = z.infer<typeof JobSplitViewSchema>;
export type TopicFloorsView = z.infer<typeof TopicFloorsViewSchema>;
import type { MemoryNoteView } from './memory-views.js';
export type { MemoryNoteView } from './memory-views.js';
export type ProjectJobRow = z.infer<typeof ProjectJobRowSchema>;
// P74d：交回卡、核对卡（工作往来里的卡片）。
export type EvidenceItemView = z.infer<typeof EvidenceItemViewSchema>;
export type SubmissionCardView = z.infer<typeof SubmissionCardViewSchema>;
export type ReviewCardView = z.infer<typeof ReviewCardViewSchema>;
export type JobCardView = z.infer<typeof JobCardViewSchema>;
// P74f：交付卡、回执。
export type DeliveryCardView = z.infer<typeof DeliveryCardViewSchema>;
export type ReceiptCardView = z.infer<typeof ReceiptCardViewSchema>;
// P74f-2：三轮不过卡。
export type EscalationCardView = z.infer<typeof EscalationCardViewSchema>;
// P75g：复盘卡（retro: 前缀的 job_card，结构与纯函数在 skill-views.ts）。
export type RetroCardView = import('./skill-views.js').RetroCardView;
// P75h：技能核对卡（skillcheck: 前缀的 job_card，结构与纯函数在 skill-check-card.ts）。
export type SkillCheckCardView = import('./skill-check-card.js').SkillCheckCardView;

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
  /** P60：执行风格；队友档案查不到时为 null。 */
  role: Role | null;
  roleLabel: string | null;
  /** P60：是不是这个项目的负责人。 */
  isOwner: boolean;
}
/** P60 项目背景：正文加「谁、什么时候更新的」；还没更新过时后三项为 null。 */
export interface ProjectBackgroundView {
  text: string;
  /** 'owner' 表示主人，否则是队友 id。 */
  updatedBy: string | null;
  updatedByName: string | null;
  updatedAt: number | null;
  updatedText: string | null;
}
/** P60 项目文件路径：工作区目录和共享目录现在是同一个，两个都给，界面不用猜。 */
export interface ProjectPathView {
  workspaceDir: string;
  sharedDir: string;
}
/** P63 项目页的一条主题：点开后用线程查询读楼层，线程 id 就是主题 id。 */
export interface ProjectTopicView {
  id: string;
  title: string;
  lastMessageAt: number;
  lastMessageText: string | null;
  /** 主人还没看过的队友发言和中心提示条数。 */
  unread: number;
  lastMessagePreview: string | null;
  /** 最后一条消息是谁说的；没有消息时为 null。 */
  lastMessageFrom: string | null;
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
  /** P60：事务清单直接取用的三项；task 里的原始字段先保留，界面重做前老代码还在读。 */
  title: string;
  assigneeName: string | null;
  topicId: string | null;
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
  /** P60：项目背景，随项目推进由负责人更新。 */
  background: ProjectBackgroundView;
  /** P60：项目文件路径。 */
  path: ProjectPathView;
  /** P63：这个项目下的主题，最近有消息的在前。 */
  topics: ProjectTopicView[];
  /** P74a：这个项目里的「一件事」，受阻和待你验收在前；项目页把它排在旧事务前面。 */
  jobRows?: ProjectJobRow[];
}
/** 项目容器全貌：非归档项目在前、归档沉底；旧存档缺两表时全部为空。 */
export interface ProjectView {
  /** 这份视图只是占位，projects 为空不代表主题都没了；目前只有中心停用时的 DisabledHub 会带上它。 */
  rosterUnavailable?: true;
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

/**
 * 办公室投影的类型定义在纯函数层，界面契约只做再导出，避免两处字段漂移。
 * 其中 OfficeOccupantView.templateLabel（P75r7 B13）是模板的显示标签：办公室列表用它，
 * 角色本身仍是 roleLabel 的「建议」，两者不要混为一谈。
 */
export type {
  DoorwayView, OfficeDeskView, OfficeDoorView, OfficeHealthView,
  OfficeOccupantView, OfficeView, SeatView,
} from '../office/project.js';

export type Light = 'green' | 'yellow' | 'orange' | 'red';
export type CommandResult<T = unknown> = { ok: true; data?: T } | { ok: false; error: string };
export interface BotCard {
  id: string; name: string; role: Role; roleLabel: string; color: string; initials: string;
  /** P73r4：员工所用模板的显示标签（如「评审」）；没有模板或模板没有标签时为 null，界面退回 roleLabel。 */
  templateLabel?: string | null;
  lifecycle: Lifecycle; lifecycleLabel: string;
  /** P73a：员工状态（在岗、停用、归档）及停用原因；界面以它为准，lifecycle 仅为兼容保留。 */
  staffStatus: StaffStatus; staffStatusLabel: string; staffStatusReason: string | null;
  activity: Activity; activityLabel: string; activityText: string;
  nextThinkAt: number | null; nextThinkText: string; lightCheckAt: number | null;
  lastOutcome: Outcome | null; lastOutcomeLabel: string | null; lastActiveAt: number | null; lastActiveText: string | null;
  unread: number; todayThinks: number; todayBudget: number; todayTokens: number; waitingOwner: boolean;
  /** P48：已归档的队友不在左栏名单显示，只在「已归档」折叠区出现。 */
  archived: boolean;
  /** P72c：总管的默契度（主人没改动就采纳的建议数 / 建议总数，累计）；只有总管且累计 total 大于 0 时给出。 */
  rapport?: { adopted: number; total: number; text: string } | null;
  /** P74a：总管名下进行中的事的一句话（一件写「标题　状态」，多件写「n 件在办」）；只有总管带，没有在办的事为 null。 */
  chiefJobLine?: string | null;
}
export interface OverviewView {
  bots: BotCard[];
  /** P75d：记忆页的条数（与记忆页 total 相同），给左栏与总管右侧栏用；可省略（旧样例不带）。 */
  memoryCount?: number;
  /** 成本口径包含主人发起；可选字段兼容旧宿主与离线夹具。 */
  costs?: import('./cost-views.js').CostView;
  inbox: { total: number; approvals: number; questions: number; proposals: number; alerts: number };
  team: { unread: number; lastMessageText: string | null };
  quota: { light: Light; lightLabel: string; usedText: string; resetAt: number | null; resetText: string | null;
    /** P76d：本窗口额度的视图（员工份额、两种红灯、恢复时间、你自己要用）；旧样例不带，所以可省略。 */
    window?: import('./quota-views.js').QuotaWindowView };
  health: { ok: boolean; heartbeatAt: number | null; heartbeatText: string; downtimeAt: number | null; downtimeText: string | null; openAlerts: number;
    /** 沙箱不可用时的固定说明；null 表示最近一次宿主命令正常或尚未执行。 */
    sandboxWarning: string | null };
  nowAt: number; nowText: string; quietNow: boolean; pushesLeftToday: number;
}
/**
 * P69：审批卡的结构化内容，给界面分段显示用。旧审批记录没有 ownerReason、riskNote，界面按「没有」处理；
 * actionText 一定有（旧记录由现有写法还原）；argsPreview 是原始命令或参数，已截到最多 300 字，界面默认收起。
 */
export interface ApprovalCardParts {
  actionText: string; ownerReason: string | null; riskNote: string | null; argsPreview: string;
  /** P74g：费用、能否撤回、批准之后三行；缺的项写「未说明」。所有审批（都是 C、D 类）都给出；其他类别为 null。 */
  notes: { cost: string; undo: string; after: string } | null;
  /** P74g：属于一件事的审批写「由{员工名字}执行」（显示名同时改为总管）；其余为 null。 */
  onBehalfOf: string | null;
  /**
   * P74r4b：这张审批是某件事发布这一步的审批时为真（属于一件事、这件事有发布这一步、审批是验收之后提交的；
   * 这件事已完成后提交的第二张发布审批同样为真）；其余为假。界面据此把按钮写成「批准发布」「暂不发布」，
   * 答复仍用现有的批准、拒绝两个动作（core 不看按钮文字）。
   */
  launch: boolean;
  /** P74r4b-m1：这张审批是中心作废的（状态为已过期并带作废标记）时为真，界面把状态写成「已作废」；主人拒绝、到期没人处理、已使用的为假。 */
  voided: boolean;
  /**
   * P74r20 补做：这条审批对应的命令全文（可省略）。界面展开「查看原始命令」时优先显示它；没有（旧数据、全文已不存在）时显示 argsPreview。
   * 最多 4000 个字符，超过时末尾另起一行写明总字数。只放在给主人看的审批卡视图里。
   */
  argsFull?: string;
}
export interface ThreadMessageView {
  id: string; thread: string; from: string; fromName: string; fromColor: string | null;
  kind: ThreadMessage['kind']; text: string; createdAt: number; timeText: string; createdText: string;
  card: null | { inboxId: string; approvalId: string | null; goalId?: string | null; type: InboxItem['type']; status: InboxItem['status']; title: string; body: string;
    options: string[]; defaultOption: string | null; answer: string | null; expiresAt: number | null; expiresText: string | null;
    /** P69：审批卡的分段内容；不是审批卡时没有。 */
    approval?: ApprovalCardParts;
    /** P75i：教它技能的选会话提问卡带学习记录编号（点选项时调用 chooseLearnSession 用）；其他卡片没有。 */
    learnRunId?: string };
  /** P72c：kind 为 agreement 时的约定卡内容；找不到对应约定或版本时为 null（界面退回显示 text）。其他 kind 不带这个字段。 */
  agreement?: AgreementCardView | null;
  /** P73c：kind 为 team_question 时的三问视图；找不到对应记录时为 null。其他 kind 不带这个字段。 */
  teamQuestion?: TeamQuestionView | null;
  /** P73c：kind 为 team 时的组队卡视图；找不到对应记录时为 null。其他 kind 不带这个字段。 */
  teamCard?: TeamCardView | null;
  /** P74d：kind 为 job_card 时的卡片视图（交回卡、核对卡）；找不到对应记录时为 null。其他 kind 不带这个字段。 */
  jobCard?: JobCardView | null;
  /** P75c：挂在这条消息下面的「已记住」（规矩或偏好）；没有时不带这个字段。撤销后 state 变为 undone。 */
  memoryNotes?: MemoryNoteView[];
}
/**
 * P72c：约定卡视图。一张卡对应约定的一个版本；changed、added 来自该版本的改动标记（第 1 版全为 false），
 * 界面据此画「本版改动」。canConfirm 为真时才显示「定了」按钮。
 */
export interface AgreementCardView {
  agreementId: string; title: string; projectId: string; topicId: string; topicTitle: string | null;
  /** W1：「归属：项目「X」」或「归属：新建项目「X」」（中心生成）。可省略：旧的手写样例不带，界面按没有处理。 */
  projectLine?: string;
  versionNo: number; latestNo: number;
  state: 'pending' | 'superseded' | 'locked' | 'replaced'; stateLabel: string;
  agreementState: 'pending' | 'locked' | 'withdrawn';
  /** 约定待确认、本版是最新版且待确认、卡片已落楼。 */
  canConfirm: boolean;
  /** 被哪一版取代（版本状态为 superseded 或 replaced 时）。 */
  supersededBy: number | null;
  createdText: string; lockedAt: number | null; lockedText: string | null;
  sourceLabel: string;
  /**
   * P74r2b：起因是执行中提问的版本多一行起因（中心生成：「起因：某某在做这件事时问「…」，约定里没有写。」）；其余版本为 null。
   * 界面怎样显示这一行在 P74h 做。
   */
  originLine: string | null;
  /**
   * P74f-2：这一版写明「不再做」（带 stopsJob）时多一行：确认后这件事停止，已经做出来的东西保留在项目文件夹里（中心生成）；其余版本为 null。
   * 可省略：旧的手写样例不带这一项，界面按没有处理。
   */
  stopLine?: string | null;
  changeNote: string;
  /** P72h：本版有意删去的条目原文（界面写「删去：某某」）；待定项写问题原文。 */
  removed: string[];
  /** P72h：本版有删除、但没有记下原文的条目数（旧数据）。大于 0 时改动区没有覆盖全部差异，界面不能写「其余与上一版相同」。 */
  removedUnlisted: number;
  summary: { text: string; changed: boolean };
  sketch: { value: Sketch; changed: boolean };
  /** index 是显示用的序号，从 1 起，与草图里的圆圈数字（mark）一致；不是数组下标。 */
  pending: Array<{ key: string; index: number; question: string; options: string[]; suggested: string;
    chosen: string | null; reason: string; changed: boolean; added: boolean }>;
  /** memoryId（P75d）：出处是记忆时才有，界面点出处跳到记忆页那一条；可省略（旧样例不带）。 */
  decided: Array<{ text: string; basisLabel: string; changed: boolean; memoryId?: string }>;
  scopeIn: Array<{ text: string; changed: boolean }>;
  scopeOut: Array<{ text: string; changed: boolean }>;
  doneWhen: Array<{ text: string; changed: boolean }>;
  /**
   * P74r9：对外发布这一行（中心生成，界面原样显示）：约定写了对外发布时是「验收之后对外发布：{发布方式}。发布前单独请你批准。」；
   * 上一版有、这一版去掉了写「这一版去掉了对外发布这一步。」；其余为 null（不显示）。launchChanged 为真表示这一版新增、改动或去掉了这一项（「本版改动」标记）。
   * 类型上可省略（旧的手写样例不带这两项，界面按没有处理）；中心生成的视图一定带。
   */
  launchLine?: string | null;
  launchChanged?: boolean;
  /**
   * P81：发布那一行之后的一行（中心生成，界面原样显示）：约定写了发布位置（localDir）时是「发布到本机文件夹：{显示路径}」（显示路径以 ~ 开头）；
   * 没有这一项时为 null（整行不画）。随发布那一行一起标「本版改动」（launchChanged）。可省略的原因同 launchLine。
   */
  localDirLine?: string | null;
  /**
   * P81r1：这一版改了发布位置、上一版也有发布位置时的一行「原来的位置：{上一版的显示路径}」；
   * 没有改、或上一版没有发布位置时不带这个键（界面不画）。
   */
  localDirPrevLine?: string | null;
  /** 只在第一次被确认的那一版有。 */
  adoption: { adopted: number; total: number } | null;
  /** 这位总管的累计默契度；只在 adoption 不为 null 时给。 */
  rapport: { adopted: number; total: number } | null;
  /**
   * P74e（B2）：这一版是某件正在做的事「等你确认」的那一版时给出两栏、交付时间不变的一行和退路；其余版本为 null。
   * 可省略：旧的手写样例不带这一项，界面按没有处理。
   */
  jobSplit?: JobSplitView | null;
  /**
   * P76e：「预计消耗」一段（中心按规则算，不调用模型；逐字固定的句子）。待确认的版本取 draft，已固定的取固定时算的那一项；
   * 没有预计（旧数据、被取代的旧版本）为 null。可省略：旧的手写样例不带这一项，界面按没有处理；界面怎样画在 P76j。
   */
  estimate?: { title: '预计消耗'; headline: string; lines: string[]; basisLine: string; footer: string } | null;
}
/** P72c：修订记录的一行（每个版本一行，从新到旧）。 */
export interface AgreementRevisionRow { no: number; timeText: string; stateLabel: string; text: string; sourceLabel: string; locked: boolean }
/** P72c：主题第一层的约定面板：当前版本（已固定取固定版，待确认取最新版）加修订记录。 */
export interface AgreementPanelView { current: AgreementCardView; revisions: AgreementRevisionRow[]; revisionCount: number }
export interface ThreadView { threadId: string; title: string; messages: ThreadMessageView[]; hasMore: boolean; oldestId: string | null;
  /** P72c：主题线程且该主题有约定时给出；否则不带或为 null。 */
  agreement?: AgreementPanelView | null;
  /** P74a：主题线程且该主题有未撤下的约定时给出进度行；否则不带或为 null。 */
  progress?: JobProgressView | null;
  /** P74a：主题线程给出楼层与往来折叠分组；非主题线程不带。旧的 messages 字段不变。 */
  floors?: TopicFloorsView;
  /**
   * P76i：总管私聊顶部的「离开期间摘要」（视图字段，不是消息）。只在这条私聊是总管的、有未收起的摘要时出现，其余线程不带这个字段。
   * lines 每项一行；dismissText 是收起按钮的文字，点它调用 dismissAwaySummary。
   */
  awaySummary?: { lines: string[]; dismissText: '收起' } | null }
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
  /** P62/P63 办公室动线要用：这一回合属于哪个项目、在做哪件事（主题名或事务名）；不属于项目时为 null。 */
  projectName: string | null; itemTitle: string | null;
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
    presetSkillIds: string[]; dshSkillNames: string[];
    temperament: Temperament | null; speechStyle: SpeechStyle | null; brief: string; onDemand: boolean };
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
  /** P65：这件事来自哪个项目主题（主题 id 就是线程 id）和主题名；不来自主题或主题已删除时为空。 */
  topicId: string | null; topicTitle: string | null;
  /** 仅审批卡为实际批准票 id；调用 decideApproval 使用它，不能误传收件箱 id。 */
  approvalId: string | null;
  goalId?: string | null;
  /** P69：审批卡的分段内容（一句话、原因、风险提示、原始参数）；不是审批卡时没有。 */
  approval?: ApprovalCardParts;
  priority: InboxItem['priority']; title: string; body: string; options: string[]; defaultOption: string | null;
  createdAt: number; createdText: string; expiresAt: number | null; expiresText: string | null;
  /** P76g：开着满 1 小时才有，写「已等 {时长}」；不满 1 小时没有这个字段。界面显示，不推送。 */
  waitedText?: string;
  /** P72c：约定确认条目（subjectKey 以 agreement: 开头）带约定 id 与版本号；普通事项不带。 */
  agreementId?: string | null; agreementVersion?: number | null;
  /** P74r14：约定确认条目带这份约定的标题（界面把修改意见发给总管时前面要写「关于约定「{标题}」第 n 版」）；普通条目没有。 */
  agreementTitle?: string | null;
  /**
   * P74r8：约定确认条目才带。agreementJobSplit：这一版约定有两栏（照常在做、暂停），即有一件事正在按上一版做；
   * agreementStop：这一版写明这件事不再做（确认后停止）。与约定卡视图的 jobSplit（非空）、stopLine（非空）同一个来源。
   * 界面据此选条目下面的说明，不再从打开过的对话里推断。其余条目不带。
   */
  agreementJobSplit?: boolean; agreementStop?: boolean;
  /** P73c：组队卡确认条目（subjectKey 以 team: 开头）带组队卡 id；options 就是卡片当前的确认按钮文字。普通事项不带。 */
  teamProposalId?: string | null;
  /** P75r7：教它技能的选会话提问条目（subjectKey 以 learn: 开头）带学习记录编号（subjectKey 的第二段）；其余条目不带这个键。 */
  learnRunId?: string;
  /**
   * P74r4a：这次说明（总管向主人说明卡在哪、给出办法）的条目（subjectKey 以 job:<id>:escalate: 开头）带这张卡的完整视图，
   * 与总管私聊里那张卡同一份数据；界面用同一个组件画办法（含每个办法的 changeLine），点办法时用卡里的 jobId、stage、revision。
   * 其余条目不带这个字段；找不到对应记录时为 null。
   */
  escalationCard?: EscalationCardView | null;
  /**
   * P74r4b：这是一件事的哪一类条目、属于哪件事（事项键 job:<jobId>: 开头的四类之一：accept 验收、escalate 三轮不过的办法、
   * cap 回合用到上限、stall 停住了）。按事项键判断，与 core 回答这些条目时分流用的是同一套判断；界面据此显示对应操作，不按按钮文字猜。
   * 其余条目（约定确认、组队卡、审批、普通提问等）不带这个字段。
   */
  jobEntry?: { kind: 'accept' | 'escalate' | 'cap' | 'stall'; jobId: string } | null;
  /**
   * P74r16b：「员工被中心停用」的告警条目才带，并且只在这位员工此刻仍是被中心停用的状态时给出（已经在岗、或手动停用的员工没有）。
   * 界面据此显示「恢复在岗」按钮；点按钮时调用回答收件箱的命令，answer 传 answer 字段的值（固定为 reinstate）。
   * 员工已经在岗时再传这个值会被拒绝（文字「{名字}已经在岗，不需要恢复。」）。原有的「知道了」不变。
   */
  reinstate?: { botId: string; botName: string; answer: 'reinstate' };
}
export interface InboxView { items: InboxItemView[] }
export interface ActivityRow {
  id: string; at: number; timeText: string; botId: string | null; botName: string | null; botColor: string | null;
  kind: 'wake' | 'commit' | 'approval' | 'alert' | 'handoff' | 'peer' | 'lifecycle' | 'system' | 'skill'; text: string;
  /** P75i：同一组的细项（每周整理一行带合并、收起、未改动几项）；只有 kind 为 skill 的整理记录有，其余行没有这个字段。 */
  lines?: string[];
}
export interface ActivityView { rows: ActivityRow[]; hasMore: boolean }
export interface SettingsView { settings: Settings; pushChannelOptions: string[]; modelOptions: Array<{ value: ModelChoice; label: string }>;
  /** 内置预置 skill 的只读候选清单（名称和用途），供向导与档案页勾选。 */
  presetSkillOptions: PresetSkillOption[];
  /** P55：DSH 里可选的技能；读不到目录时是空数组。 */
  dshSkillOptions: DshSkillOption[] }
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
  /** P63：在项目里开一个主题，text 就是第一句话；消息发给负责人或被 @ 的队友。之后发消息用 sendMessage(topicId, text)，读楼层用 thread(topicId)。 */
  createProjectTopic(input: unknown): Promise<CommandResult<{ topicId: string }>>;
  /** W1：打开项目的「项目对话」（没有就建一条，总管不是成员时加进去）。之后发消息用 sendMessage(topicId, text)，主人的话交给总管。 */
  openProjectConversation(input: unknown): Promise<CommandResult<{ topicId: string }>>;
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
  /** P79：note 是答复提议时附的一句话（可选，去掉首尾空白后不超过 200 字）。 */
  answerInbox(id: string, answer: string, note?: string): Promise<CommandResult>;
  /** P72c：卡片上点「定了」，固定约定的最新版；choices 是主人改选的项（key 到选项），没给的项取建议。 */
  confirmAgreement(input: unknown): Promise<CommandResult<{ agreementId: string; version: number }>>;
  /**
   * P74g：读取一张证据截图（只读）。入参 { jobId, submissionId, evidenceId }；成功返回 { mime, dataUrl }，
   * 任何一项不合格（证据不是截图、不属于这次交回、文件已被换掉、超过 5 MB、跑出主题文件夹……）返回一句中文错误。
   */
  readJobEvidence(input: unknown): Promise<CommandResult<import('../job/evidence-read.js').EvidenceImage>>;
  /**
   * P74g：打开预览之前的校验（只读，core 不打开任何东西）。入参 { jobId }；成功返回要打开的目标
   * { kind: 'file', path } 或 { kind: 'url', url }，不合格返回一句中文错误。真正打开由宿主做，宿主只打开这里返回的目标。
   */
  jobPreviewTarget(input: unknown): Promise<CommandResult<import('../job/preview.js').PreviewTarget>>;
  /** P74f：交付卡上点「验收通过」；stage 必须是卡片的阶段（不是最新一张卡时被拒）。 */
  acceptJob(input: unknown): Promise<CommandResult<{ jobId: string; stage: number }>>;
  /** P74f-2：三轮不过卡上选一个办法；option 从 0 起（0 对应 A）；stage 必须是卡片的阶段。 */
  chooseJobOption(input: unknown): Promise<CommandResult<{ jobId: string; stage: number; option: number }>>;
  /** P74f-2：答复「回合用到上限」条目；answer 是「再给 N 个回合」或「暂停」。 */
  answerJobCap(input: unknown): Promise<CommandResult<{ jobId: string }>>;
  /** P74f-2：答复「没有进展」条目；answer 是「再提醒一次」或「暂停」。 */
  answerJobStall(input: unknown): Promise<CommandResult<{ jobId: string }>>;
  /** P73c：回答三问中的一问。点选给 choice（第二问选「有」另给 folderPath），打字给 text，二者恰好给一个。 */
  answerTeamQuestion(input: unknown): Promise<CommandResult<{ setupId: string; step: number }>>;
  /** P73c：组队卡内就地修改（改名、换一位、不要这位、改性格、改模型、恢复建议值）；rev 必须是卡片当前修订号。 */
  editTeamCandidate(input: unknown): Promise<CommandResult<import('../model/team-proposal.js').TeamProposal>>;
  /** P73c：确认组队卡，保留的员工入职；rev 必须是卡片当前修订号。 */
  confirmTeamProposal(input: unknown): Promise<CommandResult<import('../model/team-proposal.js').TeamProposal>>;
  decideApproval(id: string, approve: boolean, note?: string): Promise<CommandResult>;
  upsertAspiration(input: unknown): Promise<CommandResult>;
  upsertGoal(input: unknown): Promise<CommandResult>;
  closeGoal(id: string, outcome: 'done' | 'active' | 'abandoned' | 'not_done' | 'incorrect' | 'mismatch' | boolean): Promise<CommandResult>;
  upsertWatch(input: unknown): Promise<CommandResult>;
  decideWatchProposal(id: string, approve: boolean): Promise<CommandResult>;
  upsertRule(input: unknown): Promise<CommandResult>;
  /** P75c：撤销一条「已记住」（点消息下面的「撤销」）。只对生效中、主人原话记下的记忆有效；不叫醒任何人。参数 { memoryId }。 */
  undoMemory(input: unknown): Promise<CommandResult>;
  /** P75c：记忆页更正一条记忆的文字，旧说法进历史。参数 { memoryId, text }。 */
  correctMemory(input: unknown): Promise<CommandResult>;
  /** P75c：记忆页删除一条记忆（24 小时内可撤销删除）。参数 { memoryId }。 */
  deleteMemory(input: unknown): Promise<CommandResult>;
  /** P75c：撤销删除（删除后 24 小时内）。参数 { memoryId }。 */
  undoDeleteMemory(input: unknown): Promise<CommandResult>;
  /** P75d：撤销最近一次更正（24 小时内），文字恢复为更正之前的说法。参数 { memoryId }。 */
  undoCorrectMemory(input: unknown): Promise<CommandResult>;
  /** P75d：记忆页视图（只读，宿主路由由 P75k 接）。 */
  memoryPage(): import('./memory-page-views.js').MemoryPageView;
  /** P75e：员工卡片上的技能库一栏（只读，宿主路由由 P75j 接）。 */
  skillLibrary(botId: string): import('./skill-views.js').SkillLibraryView;
  /** P75e：技能详情（只读，宿主路由由 P75j 接）。 */
  skillDetail(skillId: string): import('./skill-views.js').SkillDetailView;
  /** P75e：技能详情里点「回退到这一版」。参数 { skillId, versionNo }；活动流记录由 P75i 接。 */
  rollbackSkill(input: unknown): Promise<CommandResult<{ skillId: string; versionNo: number }>>;
  /** P75e：把一条收起的技能放回。参数 { skillId }；活动流记录由 P75i 接。 */
  restoreSkill(input: unknown): Promise<CommandResult<{ skillId: string }>>;
  /**
   * P75i：教它技能的选会话：总管私聊里提问卡上点某一段会话。参数 { runId, option }（runId 取卡片视图里的学习记录编号，
   * option 是被点的那个选项的文字）。与在「待你处理」里点同一个选项结果相同；不叫醒总管。宿主路由由 P75k 接。
   */
  chooseLearnSession(input: unknown): Promise<CommandResult<{ runId: string }>>;
  pokeBot(botId: string, text?: string): Promise<CommandResult>;
  updateSettings(patch: unknown): Promise<CommandResult>;
  /** P38：按设置页的连接草稿做一次只读自检（不落任何设置，不产生审批）。 */
  testKnowledgeConnection(input: unknown): Promise<CommandResult<KnowledgeConnectionState>>;
  markThreadRead(threadId: string): Promise<CommandResult>;
  /** P76i：右侧栏「在办的事」（只读，宿主路由由 P76j 接）。总管看他名下的事与待确认的约定，其他员工看他执行或核对的事。 */
  activeJobs(botId: string): import('./active-jobs-views.js').ActiveJobsView;
  /** P76i：设置页「最近 7 天的用量」表（只读，宿主路由由 P76k 接）。 */
  weeklyUsage(): import('./usage-views.js').WeeklyUsageView;
  /**
   * P76i：界面在页面可见时上报「你正在看」（打开时一次、之后每 5 分钟一次；宿主路由由 P76k 接）。没有参数。
   * 第一次只记时间；离开 8 小时以上再打开时生成离开期间摘要（总管私聊视图的 awaySummary）。返回这次有没有生成摘要。
   */
  ownerSeen(): Promise<CommandResult<{ generated: boolean }>>;
  /** P76i：收起离开期间摘要（宿主路由由 P76k 接）。没有参数；没有摘要时什么都不做。返回这次有没有真的收起。 */
  dismissAwaySummary(): Promise<CommandResult<{ dismissed: boolean }>>;
}

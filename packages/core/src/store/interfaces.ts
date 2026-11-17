/** 存储契约：业务只操作同步内存表，落盘由宿主显式调用，便于仿真和故障恢复。 */
import type {
  ArtifactHead, ArtifactVersion, ArtifactReview, ArtifactBatch, OfficeFrame,
  Bot, BotProfile, Aspiration, Goal, AgendaItem, Watch, Percept, DriveState, QueueEntry,
  WakeTicket, WakeLedgerEntry, ResultCheck, V2Config, Resource, Grant,
  Project, ProjectTask, ProjectTopic, ProjectContextProposal, Agreement, TeamSetup, TeamProposal, BotOrigin, Commit, InboxItem,
  Approval, OutboxAction, Routine, Mail, Handoff, Claim, Rule, QuotaState, Alert, Downtime,
  Settings, ThreadMessage, AppraisalLog, LedgerEntry, AuditEntry,
  Job, JobSubmission, JobReview, JobEvent, ApprovalNote,
  Skill, SkillVersion, SkillSource, SkillUpdate, SkillRun, JobOutcome, AgreementTag, Memory, Migration,
  JobUsage, JobEstimate, JobNotice, QuotaPlan, PushQueueRow, OwnerPresence, JobOwnerTurns,
} from '../model/index.js';

/** 固定表名映射使调用者获得准确记录类型，避免混用各类 id 和字段。 */
export interface TableTypes {
  officeFrames: OfficeFrame;
  artifactHeads: ArtifactHead;
  artifactVersions: ArtifactVersion;
  artifactReviews: ArtifactReview;
  artifactBatches: ArtifactBatch;
  bots: Bot;
  botProfiles: BotProfile;
  aspirations: Aspiration;
  goals: Goal;
  agenda: AgendaItem;
  watches: Watch;
  percepts: Percept;
  drives: DriveState;
  queue: QueueEntry;
  wakes: WakeTicket;
  wakeLedger: WakeLedgerEntry;
  resultChecks: ResultCheck;
  v2Config: V2Config;
  // v2 第二期：中心资料层两表；资料只归档不删除，授权不做物理清理。
  // 主人已取消编制（部门/席位两表不再加载，旧文件启动时被忽略，见 docs/questions.md）。
  resources: Resource;
  grants: Grant;
  // v2 第四期：项目容器两表；项目软归档不删任务，不做自动清理（见 v2 计划 4.6）。
  projects: Project;
  projectTasks: ProjectTask;
  // P63：项目主题；楼层在线程日志里，这张表只存「讨论走到哪了」，旧存档没有这张表时按空表读取。
  projectTopics: ProjectTopic;
  // P39：队友提交的上下文修改建议；只增不删，采纳/驳回后保留决策记录。
  projectContextProposals: ProjectContextProposal;
  // P72a：约定（开工前对齐）；一份约定一条记录，版本内嵌；旧存档没有这张表时按空表读取。
  agreements: Agreement;
  // P73c：组队三问进度、组队卡、员工来历；旧存档没有这三张表时按空表读取，旧版本直接忽略它们。
  teamSetups: TeamSetup;
  teamProposals: TeamProposal;
  botOrigins: BotOrigin;
  // P74a：一件事、一次交回、一次核对、审批单的三行补充；旧存档没有这四张表时按空表读取，旧版本直接忽略它们。
  jobs: Job;
  jobSubmissions: JobSubmission;
  jobReviews: JobReview;
  approvalNotes: ApprovalNote;
  // P75b：第四块（技能库与记忆）的九张表；永久保留（不进保留期表），旧存档没有这些表时按空表读取，旧版本直接忽略它们。
  skills: Skill;
  skillVersions: SkillVersion;
  skillSources: SkillSource;
  skillUpdates: SkillUpdate;
  skillRuns: SkillRun;
  jobOutcomes: JobOutcome;
  agreementTags: AgreementTag;
  memories: Memory;
  migrations: Migration;
  // P76b：第五块（进度、预算、通知）的六张表（用量、预计、停滞记号、额度窗口、通知队列、主人上次打开）；
  // 不进保留期表（用量和预计要在 30 天之后仍然正确；通知队列由它自己的读写函数清理 30 天前已结束的行），
  // 旧存档没有这些表时按空表读取，旧版本直接忽略它们。
  jobUsage: JobUsage;
  jobEstimates: JobEstimate;
  jobNotices: JobNotice;
  quotaWindows: QuotaPlan;
  pushQueue: PushQueueRow;
  ownerPresence: OwnerPresence;
  // P87：一件事上「你发起的回合」（单列一栏，只用于消耗文字）；新表，旧存档没有按空表读取，旧版本直接忽略。
  jobOwnerTurns: JobOwnerTurns;
  commits: Commit;
  inbox: InboxItem;
  approvals: Approval;
  outbox: OutboxAction;
  routines: Routine;
  mail: Mail;
  handoffs: Handoff;
  claims: Claim;
  rules: Rule;
  quota: QuotaState;
  alerts: Alert;
  downtime: Downtime;
  settings: Settings;
}

/** 日志采用追加语义；各名称仍保留完整领域类型。 */
export interface LogTypes {
  thread: ThreadMessage;
  appraisals: AppraisalLog;
  ledger: LedgerEntry;
  audit: AuditEntry;
  // P74a：一件事里发生过的每个动作（只追加）；旧存档没有这条日志时按空读取。
  jobEvents: JobEvent;
}

export const TABLE_NAMES = [
  'officeFrames',
  'artifactHeads', 'artifactVersions', 'artifactReviews', 'artifactBatches',
  'bots', 'botProfiles', 'aspirations', 'goals', 'agenda', 'watches', 'percepts', 'drives',
  'queue', 'wakes', 'wakeLedger', 'resultChecks', 'v2Config', 'resources', 'grants',
  'projects', 'projectTasks', 'projectTopics',
  'projectContextProposals', 'agreements', 'teamSetups', 'teamProposals', 'botOrigins',
  'jobs', 'jobSubmissions', 'jobReviews', 'approvalNotes',
  'skills', 'skillVersions', 'skillSources', 'skillUpdates', 'skillRuns', 'jobOutcomes', 'agreementTags', 'memories', 'migrations',
  'jobUsage', 'jobEstimates', 'jobNotices', 'quotaWindows', 'pushQueue', 'ownerPresence', 'jobOwnerTurns',
  'commits', 'inbox', 'approvals', 'outbox', 'routines',
  'mail', 'handoffs', 'claims', 'rules', 'quota', 'alerts', 'downtime', 'settings',
] as const satisfies readonly (keyof TableTypes)[];
export const LOG_NAMES = ['thread', 'appraisals', 'ledger', 'audit', 'jobEvents'] as const;
export type TableName = keyof TableTypes;
export type LogName = keyof LogTypes;

/** 返回快照而非可变引用；修改必须经过 put/patch 才能可靠追踪脏表。 */
export interface Table<T extends { id: string }> {
  /** 按 id 取记录副本，缺失用 null 表示，避免暴露可变内部引用。 */
  get(id: string): T | null;
  /** 返回全部或符合条件的记录副本，谓词也只能接触副本。 */
  list(pred?: (record: T) => boolean): T[];
  /** 只复制索引需要的字段，不为排序时间轴复制每帧的整间房。 */
  listFields<K extends keyof T>(keys: readonly K[]): Pick<T, K>[];
  /** 不透明变更序号；只读索引可据此复用，新增、修改、删除都会失效。 */
  revision(): number;
  /** 校验 JSON 可序列化后新增或覆盖整条记录，并标记待落盘。 */
  put(record: T): void;
  /** 合并并校验变更字段，保持 id 不变，返回更新后的副本。 */
  patch(id: string, partial: Partial<T>): T;
  /** 删除已存在记录并标脏，删除不存在的 id 不触发多余写入。 */
  remove(id: string): void;
  /** 统计全部或符合条件的记录，不让统计操作修改原记录。 */
  count(pred?: (record: T) => boolean): number;
}

/** recent 从新到旧且同时间后追加者在前；since/all 从旧到新且同时间按追加顺序。 */
export interface Log<T extends { id: string; at?: number; createdAt?: number }> {
  /** 验证日志时间和 JSON 内容，复制后追加，禁止非法记录拖累整批落盘。 */
  append(record: T): void;
  /** 先筛选后返回最近 N 条，同一时间戳也按追加序号倒排。 */
  recent(n: number, pred?: (record: T) => boolean): T[];
  /** 返回指定毫秒及之后的记录，包含边界并按时间及追加顺序升序。 */
  since(ms: number, pred?: (record: T) => boolean): T[];
  /** 返回当前内存保留的全部日志副本，顺序与 since 相同。 */
  all(): T[];
}

/** 业务统一使用同步集合和显式异步持久化，测试无需真实文件或定时器。 */
export interface Store {
  /** 按固定表名获取类型对应的同步读写入口，拒绝未知集合。 */
  table<K extends TableName>(name: K): Table<TableTypes[K]>;
  /** 按固定日志名获取只追加入口，避免把日志误当可覆盖表。 */
  log<K extends LogName>(name: K): Log<LogTypes[K]>;
  /** 启动时恢复文件；坏数据备份后隔离，不覆盖尚未落盘的内存更改。 */
  load(): Promise<void>;
  /** 将脏表和待写日志落盘，各集合独立失败，最后汇总尚未成功的错误。 */
  flush(): Promise<void>;
  /** 根据显式时间清理过期记录与备份，便于使用假时钟验证边界。 */
  prune(nowMs: number): Promise<void>;
  /** 告知是否还有待落盘或待回滚内容，避免宿主误判存储已同步。 */
  isDirty(): boolean;
}

/** 存储契约：业务只操作同步内存表，落盘由宿主显式调用，便于仿真和故障恢复。 */
import type {
  Bot, Aspiration, Goal, AgendaItem, Watch, Percept, DriveState, QueueEntry,
  WakeTicket, Commit, InboxItem, Approval, OutboxAction, Routine, Mail, Handoff,
  Claim, Rule, QuotaState, Alert, Downtime, Settings, ThreadMessage, AppraisalLog,
  LedgerEntry, AuditEntry,
} from '../model/index.js';

/** 固定表名映射使调用者获得准确记录类型，避免混用各类 id 和字段。 */
export interface TableTypes {
  bots: Bot;
  aspirations: Aspiration;
  goals: Goal;
  agenda: AgendaItem;
  watches: Watch;
  percepts: Percept;
  drives: DriveState;
  queue: QueueEntry;
  wakes: WakeTicket;
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
}

export const TABLE_NAMES = [
  'bots', 'aspirations', 'goals', 'agenda', 'watches', 'percepts', 'drives',
  'queue', 'wakes', 'commits', 'inbox', 'approvals', 'outbox', 'routines',
  'mail', 'handoffs', 'claims', 'rules', 'quota', 'alerts', 'downtime', 'settings',
] as const satisfies readonly (keyof TableTypes)[];
export const LOG_NAMES = ['thread', 'appraisals', 'ledger', 'audit'] as const;
export type TableName = keyof TableTypes;
export type LogName = keyof LogTypes;

/** 返回快照而非可变引用；修改必须经过 put/patch 才能可靠追踪脏表。 */
export interface Table<T extends { id: string }> {
  /** 按 id 取记录副本，缺失用 null 表示，避免暴露可变内部引用。 */
  get(id: string): T | null;
  /** 返回全部或符合条件的记录副本，谓词也只能接触副本。 */
  list(pred?: (record: T) => boolean): T[];
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

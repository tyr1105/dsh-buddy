/** 内存存储：同步读写、隔离引用并追踪脏数据，文件存储复用同一套行为。 */
import { DEFAULTS, V2_DEFAULTS } from '../config/defaults.js';
import type { Settings } from '../model/index.js';
import { clone, recordTime, requireRecord, serializableRecord, type StoredRecord } from './records.js';
import { LOG_NAMES, TABLE_NAMES, type Log, type LogName, type LogTypes,
  type Store, type Table, type TableName, type TableTypes } from './interfaces.js';

export type RetentionOptions = Partial<Pick<Settings, 'retentionMsByCollection' | 'logMemoryRetentionMs' | 'badBackupRetentionMs'>>;

/** 保存业务快照及待落盘状态；文件实现继承它，保证仿真和实际运行的查询语义一致。 */
export class MemoryStore implements Store {
  protected readonly tables = new Map<TableName, Map<string, StoredRecord>>();
  protected readonly logs = new Map<LogName, StoredRecord[]>();
  protected readonly pendingLogs = new Map<LogName, StoredRecord[]>();
  protected readonly dirtyTables = new Set<TableName>();
  protected readonly revisions = new Map<TableName, number>();
  protected readonly retention;
  protected readonly logMemoryRetentionMs: number;
  protected readonly badBackupRetentionMs: number;
  private readonly logSequences = new WeakMap<StoredRecord, number>();
  private nextLogSequence = 0;
  private readonly sortedLogs = new Map<LogName, { source: StoredRecord[]; length: number; rows: StoredRecord[] }>();

  /** 合并保留期并初始化固定集合，避免业务拼写错误时偷偷生成另一张表。 */
  constructor(options: RetentionOptions = {}) {
    // 账本保留期不属于 Settings（见 v2 设计 3.7）：在这里合并 V2_DEFAULTS，
    // 现有调用方继续传 settings.retentionMsByCollection，行为不受影响。
    this.retention = {
      ...DEFAULTS.RETENTION_MS_BY_COLLECTION,
      wakeLedger: V2_DEFAULTS.LEDGER_RETENTION_MS,
      resultChecks: V2_DEFAULTS.LEDGER_RETENTION_MS,
      ...options.retentionMsByCollection,
    };
    this.logMemoryRetentionMs = options.logMemoryRetentionMs ?? DEFAULTS.LOG_MEMORY_RETENTION_MS;
    this.badBackupRetentionMs = options.badBackupRetentionMs ?? DEFAULTS.BAD_BACKUP_RETENTION_MS;
    for (const name of TABLE_NAMES) this.tables.set(name, new Map());
    for (const name of LOG_NAMES) {
      this.logs.set(name, []);
      this.pendingLogs.set(name, []);
    }
  }

  /** 表名在类型和运行时双重限定，防止字符串穿越持久化目录。 */
  table<K extends TableName>(name: K): Table<TableTypes[K]> {
    const records = this.tables.get(name);
    if (!records) throw new Error(`未知表名：${name}`);
    const list = (pred?: (record: TableTypes[K]) => boolean): TableTypes[K][] => {
      const copies = [...records.values()].map((record) => clone(record) as unknown as TableTypes[K]);
      return pred ? copies.filter(pred) : copies;
    };
    return {
      // 只返回副本，后续修改必须重新经过存储入口。
      get: (id) => records.has(id) ? clone(records.get(id)) as unknown as TableTypes[K] : null,
      list,
      revision: () => this.revisions.get(name) ?? 0,
      // 字段投影只复制选定键；键值仍深复制，不能借嵌套引用绕过脏表追踪。
      listFields: keys => [...records.values()].map(record => Object.fromEntries(
        keys.filter(key => Object.hasOwn(record, key)).map(key => [key, clone(record[String(key)])]),
      ) as Pick<TableTypes[K], typeof keys[number]>),
      // 写入前完成序列化检查，坏记录不会污染整个脏表。
      put: (record) => {
        this.assertWritable();
        const checked = serializableRecord(record);
        records.set(checked.id, checked);
        this.markDirty(name);
      },
      // 先构造并校验完整新记录，失败时原记录和脏标记均保持不变。
      patch: (id, partial) => {
        this.assertWritable();
        const old = records.get(id);
        if (!old) throw new Error(`表 ${name} 中不存在记录：${id}`);
        if (partial.id !== undefined && partial.id !== id) throw new Error('patch 不允许修改记录 id');
        const next = serializableRecord({ ...old, ...partial, id });
        if (next.id !== id) throw new Error('patch 不允许通过 JSON 序列化修改记录 id');
        records.set(id, next);
        this.markDirty(name);
        return clone(next) as unknown as TableTypes[K];
      },
      // 只有实际删除才标脏，避免无效请求触发磁盘写入。
      remove: (id) => {
        this.assertWritable();
        if (records.delete(id)) this.markDirty(name);
      },
      // 带条件时沿用副本查询，条件函数不能修改原始记录。
      count: (pred) => {
        if (!pred) return records.size;
        let count = 0;
        // 只拍一层记录索引快照；即使谓词另行写表，也不会让这次遍历无限增长。
        for (const record of [...records.values()]) if (pred(clone(record) as unknown as TableTypes[K])) count += 1;
        return count;
      },
    };
  }

  /** 追加时复制数据；按时间及追加序号排序，确保同毫秒的 recent 也先返回最新追加项。 */
  log<K extends LogName>(name: K): Log<LogTypes[K]> {
    if (!this.logs.has(name)) throw new Error(`未知日志名：${name}`);
    // 日志只有追加或整批清理；版本不变就重用排序索引，索引从不暴露给调用方。
    const ordered = (): StoredRecord[] => {
      const source = this.logs.get(name)!;
      const cached = this.sortedLogs.get(name);
      if (cached?.source === source && cached.length === source.length) return cached.rows;
      const rows = [...source].sort((a, b) => {
        const timeOrder = recordTime(a)! - recordTime(b)!;
        return timeOrder || this.logSequences.get(a)! - this.logSequences.get(b)!;
      });
      this.sortedLogs.set(name, { source, length: source.length, rows });
      return rows;
    };
    return {
      // 时间和 JSON 内容都在入口验证，避免一条坏日志阻断后续刷盘。
      append: (record) => {
        this.assertWritable();
        const checked = requireRecord(record);
        if (recordTime(checked) === null) throw new Error(`日志 ${name} 的时间字段 at 或 createdAt 必须在 Date 可表示的毫秒范围内`);
        const stored = serializableRecord(checked);
        // 自定义 toJSON 可能改变字段，最终真正存入的时间也必须通过同样校验。
        if (recordTime(stored) === null) throw new Error(`日志 ${name} 序列化后的时间字段 at 或 createdAt 必须在 Date 可表示的毫秒范围内`);
        this.rememberLog(name, stored);
        this.pendingLogs.get(name)!.push(stored);
      },
      // 先过滤再限量，让筛选后的最近 N 条不会被不匹配的记录挤掉。
      recent: (n, pred) => {
        if (!Number.isInteger(n) || n < 0) throw new Error('recent 的条数必须是非负整数');
        const selected: LogTypes[K][] = [];
        const rows = ordered();
        // 只为实际经过的记录创建副本；命中数量足够后立即停止，不复制旧日志正文。
        for (let i = rows.length - 1; i >= 0 && selected.length < n; i -= 1) {
          const copy = clone(rows[i]!) as unknown as LogTypes[K];
          if (!pred || pred(copy)) selected.push(copy);
        }
        return selected;
      },
      // 起点包含边界，保持与按天日志恢复的截止时间一致。
      since: (ms, pred) => {
        if (!Number.isFinite(ms)) throw new Error('since 的时间必须是有限毫秒数');
        const rows = ordered();
        // 在已排序索引上二分找到时间窗，谓词仍只接触深副本，不能改写存储。
        let low = 0;
        let high = rows.length;
        while (low < high) {
          const middle = Math.floor((low + high) / 2);
          if (recordTime(rows[middle]!)! < ms) low = middle + 1;
          else high = middle;
        }
        const selected: LogTypes[K][] = [];
        for (let i = low; i < rows.length; i += 1) {
          const copy = clone(rows[i]!) as unknown as LogTypes[K];
          if (!pred || pred(copy)) selected.push(copy);
        }
        return selected;
      },
      // 全量查询保持时间与追加顺序，调用方拿到的仍是独立副本。
      all: () => ordered().map(record => clone(record) as unknown as LogTypes[K]),
    };
  }

  /** 纯内存没有外部恢复源，保留现有内容即可。 */
  async load(): Promise<void> {}

  /** 确认当前内存写入并清空待写状态，模拟文件存储成功落盘后的行为。 */
  async flush(): Promise<void> {
    this.dirtyTables.clear();
    for (const name of LOG_NAMES) this.pendingLogs.set(name, []);
  }

  /** 同时检查表和日志的待写状态，供宿主决定是否需要落盘。 */
  isDirty(): boolean {
    return this.dirtyTables.size > 0 || [...this.pendingLogs.values()].some((records) => records.length > 0);
  }

  /** 每次改表增加版本，文件写入期间的新修改不会被旧快照误清除。 */
  protected markDirty(name: TableName): void {
    this.dirtyTables.add(name);
    this.revisions.set(name, (this.revisions.get(name) ?? 0) + 1);
  }

  /** 新增和恢复日志共用追加序号；序号仅在内存维护，不改变持久化领域记录。 */
  protected rememberLog(name: LogName, record: StoredRecord): void {
    this.logSequences.set(record, this.nextLogSequence++);
    this.logs.get(name)!.push(record);
  }

  /** 文件实现可在启动恢复期间拒绝写入；纯内存实现始终可写。 */
  protected assertWritable(): void {}

  /** 关闭记录才过期；没有可靠时间的旧记录保留，避免误删未完成的工作。 */
  async prune(nowMs: number): Promise<void> {
    if (!Number.isFinite(nowMs)) throw new Error('prune 的 nowMs 必须是有限毫秒数');
    const closed: Partial<Record<TableName, readonly string[]>> = {
      inbox: ['answered', 'expired', 'withdrawn', 'closed'],
      approvals: ['rejected', 'expired', 'used'],
      outbox: ['done', 'failed', 'rejected'],
    };
    const retainedTables = ['officeFrames', 'artifactVersions', 'artifactReviews', 'artifactBatches',
      'percepts', 'wakes', 'wakeLedger', 'resultChecks', 'commits', 'inbox', 'approvals', 'outbox'] as const;
    for (const name of retainedTables) {
      for (const record of this.tables.get(name)!.values()) {
        if (closed[name] && !closed[name]!.includes(String(record.status))) continue;
        const time = this.retentionTime(name, record);
        if (time !== null && time < nowMs - this.retention[name]) {
          this.tables.get(name)!.delete(record.id);
          this.markDirty(name);
        }
      }
    }
    // 内存统一只留最近 14 天；尚未落盘的行按磁盘保留期保留，不能因内存压缩而丢日志。
    for (const name of LOG_NAMES) {
      const memoryCutoff = nowMs - Math.min(this.logMemoryRetentionMs, this.retention[name]);
      this.logs.set(name, this.logs.get(name)!.filter((record) => recordTime(record)! >= memoryCutoff));
      this.pendingLogs.set(name, this.pendingLogs.get(name)!.filter((record) => recordTime(record)! >= nowMs - this.retention[name]));
    }
  }

  /** 优先从完成时间起保留；规格没有关闭时间的记录才退回创建时间。 */
  private retentionTime(name: TableName, record: StoredRecord): number | null {
    // 账本只按封存时间清理；未封存（sealedAt 为空）的行 retentionTime 返回 null，永不清理。
    const keys = name === 'officeFrames' ? ['at']
      : name === 'wakeLedger' ? ['sealedAt']
      : name === 'wakes' ? ['endedAt', 'startedAt']
      : name === 'inbox' ? ['answeredAt', 'createdAt']
      : name === 'approvals' ? ['usedAt', 'decidedAt', 'createdAt']
      : name === 'outbox' ? ['doneAt', 'createdAt'] : ['createdAt'];
    for (const key of keys) {
      if (typeof record[key] === 'number' && Number.isFinite(record[key])) return record[key] as number;
    }
    return null;
  }
}

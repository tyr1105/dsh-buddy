/** 文件存储：原子替换脏表、按天追加日志，并隔离坏数据，避免一个文件阻断整个中心启动。 */
import { isAbsolute, join } from 'node:path';
import type { Clock, FsIO, Logger } from '../io/interfaces.js';
import { ConsoleLogger } from '../io/console-logger.js';
import { localDateKey, parseLocalDateTime } from '../util/time.js';
import { LOG_NAMES, TABLE_NAMES, type LogName, type TableName } from './interfaces.js';
import { MemoryStore, type RetentionOptions } from './memory-store.js';
import { isRecord, recordTime, type StoredRecord } from './records.js';

/**
 * 旧存档兼容（主人已取消编制：部门/席位两层不再存在）。
 *
 * 为什么在恢复时改而不是在业务层兜底：磁盘上的旧记录仍带 ownerPositionId、
 * memberPositionIds、assigneePositionId、ownerDepartmentId，以及按席位/部门授予的资料授权。
 * 如果原样读进内存，界面会拿到不存在的字段，保存时也会把旧引用当成有效数据继续写。
 * 这里按表把旧字段清掉、补上新的可空字段，并让下一次刷盘把文件重写成新形状。
 *
 * 返回值约定：null 表示这条记录已失去新语义，整条丢弃（只用于按席位/部门授予的旧授权）；
 * changed 表示字段有增删，需要标记脏表重写。无法从旧席位可靠换算出队友 id，
 * 所以项目负责人与成员统一置空，由主人在项目页重新指定（保守默认，见 docs/questions.md）。
 */
function migrateLegacyRow(name: TableName, record: StoredRecord): { row: StoredRecord; changed: boolean } | null {
  const row: StoredRecord = { ...record };
  let changed = false;
  /** 删掉一个旧字段；只有确实存在时才算改动，避免无谓刷盘。 */
  const drop = (key: string): void => {
    if (Object.prototype.hasOwnProperty.call(row, key)) {
      delete row[key];
      changed = true;
    }
  };
  /** 补齐新字段；缺省才补，已经存在的值一律保留。 */
  const fill = (key: string, value: unknown): void => {
    if (!Object.prototype.hasOwnProperty.call(row, key)) {
      row[key] = value;
      changed = true;
    }
  };

  if (name === 'projects') {
    drop('ownerPositionId');
    drop('memberPositionIds');
    fill('ownerBotId', null);
    fill('memberBotIds', []);
    // P34 两层的愿景与约定：旧项目没有这两个字段，按空值兼容并标脏，下次落盘写成新形状。
    fill('vision', '');
    fill('conventions', '');
    // P39 共享上下文：旧项目按空上下文与空留痕兼容（零迁移，界面不显示空卡片）。
    fill('context', { background: '', conventions: '', decisions: [], glossary: [] });
    fill('contextRevisions', []);
  } else if (name === 'projectTasks') {
    drop('assigneePositionId');
    fill('assigneeBotId', null);
  } else if (name === 'bots') {
    // P40 预置 skill：旧档案没有这个字段，按空数组兼容并标脏，不替主人勾选任何一项。
    fill('presetSkillIds', []);
    // P55 配置精简：旧档案没有这些字段，补默认值并标脏，不替主人选任何东西。
    fill('dshSkillNames', []);
    fill('temperament', null);
    fill('speechStyle', null);
    fill('brief', '');
    fill('onDemand', false);
  } else if (name === 'resources') {
    drop('ownerDepartmentId');
  } else if (name === 'grants') {
    // 授权对象只剩队友本人；旧席位/部门授权没有可映射的收件人，整条忽略。
    if (row.subjectKind !== 'bot') return null;
  }
  return { row, changed };
}

/** 把内存状态安全同步到文件；坏数据留证据，单个集合失败不阻断其余集合落盘。 */
export class FileStore extends MemoryStore {
  private ioTail: Promise<void> = Promise.resolve();
  private readonly stateDir: string;
  private readonly logsDir: string;
  private readonly logRollbacks = new Map<string, { before: string | null; backedUp: boolean }>();
  private loading = false;

  /** 注入文件、时间和日志能力，所有副作用可在测试中被确定性替换。 */
  constructor(
    private readonly fs: FsIO,
    private readonly clock: Clock,
    rootDir: string,
    private readonly tz: string,
    private readonly logger: Logger = new ConsoleLogger(),
    options: RetentionOptions = {},
  ) {
    super(options);
    if (!isAbsolute(rootDir)) throw new Error('FileStore 的 rootDir 必须是绝对路径；请由宿主展开用户目录');
    // 构造时检查时区，避免首条日志到来时才发现不可用配置。
    localDateKey(clock.now(), tz);
    this.stateDir = join(rootDir, '.hub', 'state');
    this.logsDir = join(rootDir, '.hub', 'logs');
  }

  /** 所有文件操作串行；前一次失败不会让后续重试永远卡在 rejected promise。 */
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.ioTail.then(operation);
    this.ioTail = result.then(() => undefined, () => undefined);
    return result;
  }

  /** 串行恢复全部表及近期日志；恢复期间阻止业务写入，避免覆盖新产生的状态。 */
  override load(): Promise<void> {
    return this.serial(async () => {
      if (this.isDirty()) throw new Error('存储存在未落盘更改，不能 load 覆盖；请先 flush');
      this.loading = true;
      try {
        for (const name of TABLE_NAMES) await this.loadTable(name);
        for (const name of LOG_NAMES) await this.loadLog(name);
      } finally {
        this.loading = false;
      }
    });
  }

  /** 防止异步 load 清空刚写入的业务数据，宿主必须等待启动恢复完成。 */
  protected override assertWritable(): void {
    if (this.loading) throw new Error('存储正在 load，请等待加载完成后再写入');
  }

  /** 单条坏记录跳过；整个 JSON 结构损坏先保存证据，再以空表继续。 */
  private async loadTable(name: TableName): Promise<void> {
    const path = join(this.stateDir, `${name}.json`);
    const text = await this.fs.readText(path);
    const records = this.tables.get(name)!;
    // 恢复也会替换内容；只读索引必须失效，但正常读取不应标记为待写。
    this.revisions.set(name, (this.revisions.get(name) ?? 0) + 1);
    records.clear();
    if (text === null) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) throw new Error('表文件顶层必须是数组');
    } catch (error) {
      await this.backup(path);
      this.logger.warn(`表 ${name} 的 JSON 损坏，已备份并按空表继续`, { error: String(error) });
      // 下次 flush 用空表替换坏文件，备份始终保留。
      this.markDirty(name);
      return;
    }
    const rows = parsed as unknown[];
    let dropped = 0;
    const skippedIndexes = rows.flatMap((record, index) => isRecord(record) ? [] : [index]);
    if (skippedIndexes.length > 0) {
      // 先保留原始证据，再让下次刷盘将文件替换成干净的有效记录集合。
      await this.backup(path);
      this.logger.warn(`表 ${name} 跳过 ${skippedIndexes.length} 条坏记录，下标（从 0 开始）：${skippedIndexes.join('、')}`, {
        skippedCount: skippedIndexes.length, skippedIndexes,
      });
      this.markDirty(name);
    }
    for (const record of rows) {
      if (!isRecord(record)) continue;
      // 先做编制取消后的旧字段迁移：丢弃的旧授权不进入内存，字段改动让下次刷盘重写。
      const migrated = migrateLegacyRow(name, record);
      if (migrated === null) {
        dropped += 1;
        this.markDirty(name);
        continue;
      }
      // 只补缺失的兼容字段，保留旧关注项的其余原始数据，不因领域字段的历史差异丢记录。
      const expectation = migrated.row.expectation;
      if (name === 'watches' && expectation !== null && typeof expectation === 'object' && !Array.isArray(expectation)) {
        const fields: Record<string, unknown> = {};
        if (!Object.prototype.hasOwnProperty.call(expectation, 'weekdays')) fields.weekdays = null;
        if (!Object.prototype.hasOwnProperty.call(expectation, 'effectiveAt') && typeof record.createdAt === 'number'
          && Number.isSafeInteger(record.createdAt)) fields.effectiveAt = record.createdAt;
        if (Object.keys(fields).length) {
          records.set(record.id, { ...migrated.row, expectation: { ...expectation, ...fields } });
          this.markDirty(name);
          continue;
        }
      }
      records.set(record.id, migrated.row);
      if (migrated.changed) this.markDirty(name);
    }
    if (dropped > 0) {
      // 只提示数量，不打印授权内容；旧文件本身不动，等下次刷盘自然替换成新形状。
      this.logger.warn(`表 ${name} 忽略 ${dropped} 条已随编制取消的旧记录`);
    }
  }

  /** 日志按行恢复；损坏原文备份后原子写回有效行，后续启动无需重复备份同一坏行。 */
  private async loadLog(name: LogName): Promise<void> {
    this.logs.set(name, []);
    const dir = join(this.logsDir, name);
    const cutoff = this.clock.now() - Math.min(this.logMemoryRetentionMs, this.retention[name]);
    const firstDay = localDateKey(cutoff, this.tz);
    for (const filename of (await this.fs.list(dir)).sort()) {
      const day = this.logDay(filename);
      if (day === null || day < firstDay) continue;
      const path = join(dir, filename);
      const text = await this.fs.readText(path);
      if (text === null) continue;
      let damaged = false;
      const validLines: string[] = [];
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const record: unknown = JSON.parse(line);
          if (!isRecord(record) || recordTime(record) === null) throw new Error('缺少 id 或日志时间');
          // 截止日内较老的有效行仍须保留在磁盘，只限制恢复到内存的部分。
          validLines.push(line);
          if (recordTime(record)! >= cutoff) this.rememberLog(name, record);
        } catch {
          damaged = true;
          this.logger.warn(`日志 ${name}/${filename} 跳过损坏行`);
        }
      }
      if (damaged) {
        await this.backup(path);
        await this.fs.writeTextAtomic(path, validLines.length > 0 ? validLines.join('\n') + '\n' : '');
      }
    }
  }

  /** 请求排队后读取最新脏集合；重复请求不会重复追加已经确认成功的日志行。 */
  override flush(): Promise<void> {
    return this.serial(async () => {
      const errors: Error[] = [];
      for (const name of [...this.dirtyTables]) {
        try {
          const revision = this.revisions.get(name);
          const text = JSON.stringify([...this.tables.get(name)!.values()]);
          await this.fs.writeTextAtomic(join(this.stateDir, `${name}.json`), text);
          // I/O 等待期间可能发生业务修改，只清除本次快照对应的脏标记。
          if (revision === this.revisions.get(name)) this.dirtyTables.delete(name);
        } catch (error) {
          errors.push(this.flushFailure(`表 ${name}`, error));
        }
      }
      for (const name of LOG_NAMES) {
        try {
          await this.flushLog(name);
        } catch (error) {
          errors.push(this.flushFailure(`日志 ${name}`, error));
        }
      }
      // 所有独立集合都获得一次写入机会后，统一向宿主报告尚未落盘的失败。
      if (errors.length > 0) throw new AggregateError(errors, `存储刷盘失败：${errors.map(error => error.message).join('；')}`);
    });
  }

  /** 给单集合失败记录中文定位信息，既保留重试状态，也便于宿主汇总告警。 */
  private flushFailure(collection: string, error: unknown): Error {
    const failure = new Error(`${collection}：${String(error)}`, { cause: error });
    try {
      this.logger.error(`${collection} 刷盘失败，已保留待写状态`, { error: String(error) });
    } catch {
      // 日志器本身出错也不能截断后续集合写入；原失败仍由最终 AggregateError 反馈。
    }
    return failure;
  }

  /** 每个日文件独立确认，后续日期失败重试时不再追加已成功的日期。 */
  private async flushLog(name: LogName): Promise<void> {
    // 回滚仅阻塞所属日志；其他表和日志仍可正常刷盘。
    const directory = join(this.logsDir, name) + '/';
    for (const path of this.logRollbacks.keys()) {
      if (path.startsWith(directory)) await this.rollbackLog(path);
    }
    const batches = new Map<string, StoredRecord[]>();
    for (const record of this.pendingLogs.get(name)!) {
      const day = localDateKey(recordTime(record)!, this.tz);
      const batch = batches.get(day) ?? [];
      batch.push(record);
      batches.set(day, batch);
    }
    for (const [day, batch] of batches) {
      const path = join(this.logsDir, name, `${day}.jsonl`);
      const before = await this.fs.readText(path);
      // 旧文件可能在进程中断时留下无换行尾部，先隔开，避免污染新记录。
      const separator = before && !before.endsWith('\n') ? '\n' : '';
      const text = separator + batch.map((record) => JSON.stringify(record)).join('\n') + '\n';
      try {
        await this.fs.appendText(path, text);
      } catch (error) {
        // append 可能已经写入半行甚至整批才报错；保留失败证据并还原，才能安全重试。
        this.logRollbacks.set(path, { before, backedUp: false });
        try {
          await this.rollbackLog(path);
        } catch (rollbackError) {
          this.logger.error('日志追加失败且暂时无法回滚，下次刷盘将先恢复', { path, error: String(rollbackError) });
        }
        throw error;
      }
      const written = new Set(batch);
      this.pendingLogs.set(name, this.pendingLogs.get(name)!.filter((record) => !written.has(record)));
    }
  }

  /** 日志文件由本 Store 独占写入；回滚成功前保留状态和待写行，不宣称已刷盘。 */
  private async rollbackLog(path: string): Promise<void> {
    const rollback = this.logRollbacks.get(path)!;
    const current = await this.fs.readText(path);
    if (current !== rollback.before) {
      if (current !== null && !rollback.backedUp) {
        await this.backup(path);
        rollback.backedUp = true;
      }
      if (rollback.before === null) await this.fs.remove(path);
      else await this.fs.writeTextAtomic(path, rollback.before);
    }
    this.logRollbacks.delete(path);
  }

  /** 尚未恢复的失败追加也算脏数据，不能向宿主宣称已经安全落盘。 */
  override isDirty(): boolean {
    return this.logRollbacks.size > 0 || super.isDirty();
  }

  /** 清理与 flush 共用队列，避免删除旧日文件后被正在进行的写入重新建回。 */
  override prune(nowMs: number): Promise<void> {
    return this.serial(async () => {
      for (const path of this.logRollbacks.keys()) await this.rollbackLog(path);
      await super.prune(nowMs);
      await this.pruneBackups(this.stateDir, nowMs, (name) => TABLE_NAMES.some(table => name === `${table}.json`));
      for (const name of LOG_NAMES) {
        const cutoffDay = localDateKey(nowMs - this.retention[name], this.tz);
        const dir = join(this.logsDir, name);
        for (const filename of await this.fs.list(dir)) {
          const day = this.logDay(filename);
          // 边界日还可能含有效记录，保留整天；未知文件不自动删除。
          if (day !== null && day < cutoffDay) await this.fs.remove(join(dir, filename));
        }
        await this.pruneBackups(dir, nowMs, (filename) => this.logDay(filename) !== null);
      }
    });
  }

  /** 仅按本 Store 备份名里的生成时间清理；保留边界及未知命名，避免误删其他文件。 */
  private async pruneBackups(dir: string, nowMs: number, accepts: (name: string) => boolean): Promise<void> {
    for (const filename of await this.fs.list(dir)) {
      const match = /^(.*)\.bad-(-?\d+)(?:-\d+)?$/.exec(filename);
      if (!match || !accepts(match[1]!)) continue;
      const backedUpAt = Number(match[2]);
      if (Number.isSafeInteger(backedUpAt) && backedUpAt < nowMs - this.badBackupRetentionMs) {
        await this.fs.remove(join(dir, filename));
      }
    }
  }

  /** 严格识别真实日期文件，不能让异常文件名参与保留期清理。 */
  private logDay(filename: string): string | null {
    if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(filename)) return null;
    const day = filename.slice(0, -6);
    try {
      parseLocalDateTime(`${day} 12:00`, this.tz);
      return day;
    } catch { return null; }
  }

  /** 同一毫秒重复恢复也不覆盖原证据，必要时增加递增后缀。 */
  private async backup(path: string): Promise<void> {
    const base = `${path}.bad-${this.clock.now()}`;
    let target = base;
    let suffix = 0;
    while (await this.fs.stat(target)) target = `${base}-${++suffix}`;
    await this.fs.copy(path, target);
  }
}

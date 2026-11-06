/** M01 存储回归：坏数据必须留证据并清洗，非法写入及时拒绝，故障不能拖累其他集合。 */
import { describe, expect, it } from 'vitest';
import { FileStore, MemoryStore, type Store, type TableTypes } from '../src/store/index.js';
import { FakeClock, MemoryFs, MemoryLogger } from '../src/io/testing/index.js';
import type { AuditEntry, Rule, ThreadMessage } from '../src/model/index.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-05T04:00:00Z');
const ROOT = '/store-maintenance';
const TZ = 'Asia/Shanghai';
const STATE = `${ROOT}/.hub/state`;
const AUDIT = `${ROOT}/.hub/logs/audit/2026-11-05.jsonl`;
const THREAD = `${ROOT}/.hub/logs/thread/2026-11-05.jsonl`;

/** 使用标准 JSON 记录，让每次故障只由被测边界引起。 */
function rule(): Rule {
  return { id: 'r1', text: '保留证据', scope: 'global', source: 'owner', status: 'active', redLine: false, createdAt: NOW };
}

/** 日志时间由测试显式给出，不依赖现实时间。 */
function audit(id: string, at = NOW): AuditEntry {
  return { id, at, actor: 'hub', action: 'test', detail: id };
}

/** 线程日志用于验证一个日志坏掉后后面的日志仍能成功落盘。 */
function message(): ThreadMessage {
  return { id: 'm1', thread: 'team', from: 'hub', kind: 'chat', text: '正常内容', refId: null, createdAt: NOW, readAt: null };
}

/** 每个用例使用独立内存文件系统，备份名称由假时钟确定。 */
function fileSetup(fs = new MemoryFs(new FakeClock(NOW))) {
  const clock = new FakeClock(NOW);
  const logger = new MemoryLogger();
  const store = new FileStore(fs, clock, ROOT, TZ, logger);
  return { fs, clock, logger, store };
}

describe('M01 坏记录备份与清洗', () => {
  it('表仅部分记录损坏也先完整备份，告警包含条数和下标，刷盘后只剩有效记录', async () => {
    const { store, fs, logger } = fileSetup();
    const path = `${STATE}/rules.json`;
    const original = JSON.stringify([null, rule(), { id: '' }, 3]);
    await fs.writeTextAtomic(path, original);
    await store.load();
    expect(store.table('rules').list()).toEqual([rule()]);
    expect(store.isDirty()).toBe(true);
    expect(await fs.readText(`${path}.bad-${NOW}`)).toBe(original);
    expect(logger.lines).toContainEqual({
      level: 'warn', message: '表 rules 跳过 3 条坏记录，下标（从 0 开始）：0、2、3',
      data: { skippedCount: 3, skippedIndexes: [0, 2, 3] },
    });
    await store.flush();
    expect(JSON.parse((await fs.readText(path))!)).toEqual([rule()]);
    expect(await fs.readText(`${path}.bad-${NOW}`)).toBe(original);
    expect(store.isDirty()).toBe(false);
  });

  it('完整有效的表不产生备份也不额外标脏', async () => {
    const { store, fs, logger } = fileSetup();
    await fs.writeTextAtomic(`${STATE}/rules.json`, JSON.stringify([rule()]));
    await store.load();
    expect(await fs.list(STATE)).toEqual(['rules.json']);
    expect(store.isDirty()).toBe(false);
    expect(logger.lines).toEqual([]);
  });

  it('日志保留有效原行，删除坏行后再次 load 不会重复备份', async () => {
    const { store, fs, clock } = fileSetup();
    const valid = JSON.stringify(audit('valid'));
    const original = `${valid}\nbroken\n{}\n${JSON.stringify(audit('bad-time', 1e100))}\n`;
    await fs.writeTextAtomic(AUDIT, original);
    await store.load();
    expect(await fs.readText(`${AUDIT}.bad-${NOW}`)).toBe(original);
    expect(await fs.readText(AUDIT)).toBe(`${valid}\n`);
    expect(store.log('audit').all()).toEqual([audit('valid')]);
    clock.advance(1000);
    await new FileStore(fs, clock, ROOT, TZ).load();
    expect((await fs.list(`${ROOT}/.hub/logs/audit`)).filter(name => name.includes('.bad-')))
      .toEqual([`2026-11-05.jsonl.bad-${NOW}`]);
  });

  it('清洗截止日文件仍保留该日较老的有效行，只从内存排除', async () => {
    const { store, fs } = fileSetup();
    const path = `${ROOT}/.hub/logs/audit/2026-10-22.jsonl`;
    const before = JSON.stringify(audit('before', NOW - 14 * DAY - 1));
    const edge = JSON.stringify(audit('edge', NOW - 14 * DAY));
    await fs.writeTextAtomic(path, `${before}\nbroken\n${edge}\n`);
    await store.load();
    expect(await fs.readText(path)).toBe(`${before}\n${edge}\n`);
    expect(store.log('audit').all()).toEqual([audit('edge', NOW - 14 * DAY)]);
  });

  it('有效日志不会备份或改写，恢复后的同戳日志以追加序号倒排', async () => {
    const { store, fs } = fileSetup();
    const original = `${JSON.stringify(audit('first'))}\n${JSON.stringify(audit('second'))}`;
    await fs.writeTextAtomic(AUDIT, original);
    await store.load();
    expect(await fs.readText(AUDIT)).toBe(original);
    expect(await fs.list(`${ROOT}/.hub/logs/audit`)).toEqual(['2026-11-05.jsonl']);
    expect(store.log('audit').recent(2).map(row => row.id)).toEqual(['second', 'first']);
    store.log('audit').append(audit('third'));
    expect(store.log('audit').recent(3).map(row => row.id)).toEqual(['third', 'second', 'first']);
    expect(store.log('audit').all().map(row => row.id)).toEqual(['first', 'second', 'third']);
  });
});

describe('M01 备份保留期', () => {
  it.each([`${STATE}/rules.json`, AUDIT])('备份按生成时刻保留 30 天且边界不删：%s', async (path) => {
    const { store, fs } = fileSetup();
    const old = `${path}.bad-${NOW - 30 * DAY - 1}`;
    const edge = `${path}.bad-${NOW - 30 * DAY}-1`;
    const fresh = `${path}.bad-${NOW}`;
    const unknown = `${path}.bad-unknown`;
    for (const name of [old, edge, fresh, unknown]) await fs.writeTextAtomic(name, 'evidence');
    await store.prune(NOW);
    expect(await fs.readText(old)).toBeNull();
    for (const name of [edge, fresh, unknown]) expect(await fs.readText(name)).toBe('evidence');
  });

  it('保留期可覆盖，未知表和异常日志日期的同名备份不误删', async () => {
    const { fs, clock } = fileSetup();
    const store = new FileStore(fs, clock, ROOT, TZ, new MemoryLogger(), { badBackupRetentionMs: DAY });
    const expired = `${STATE}/rules.json.bad-${NOW - DAY - 1}`;
    const unknown = `${STATE}/unowned.json.bad-0`;
    const invalidDay = `${ROOT}/.hub/logs/audit/2020-99-99.jsonl.bad-0`;
    for (const path of [expired, unknown, invalidDay]) await fs.writeTextAtomic(path, 'evidence');
    await store.prune(NOW);
    expect(await fs.readText(expired)).toBeNull();
    expect(await fs.readText(unknown)).toBe('evidence');
    expect(await fs.readText(invalidDay)).toBe('evidence');
  });
});

describe.each(['memory', 'file'] as const)('M01 %s 写入口验证', (kind) => {
  /** 两种实现同测，确保测试替身不会掩盖真实存储入口错误。 */
  function makeStore(): Store {
    return kind === 'memory' ? new MemoryStore() : fileSetup().store;
  }

  it.each(['circular', 'bigint', 'function', 'symbol', 'nonfinite'] as const)('put/patch 直接拒绝 %s，原数据不受影响', async (failure) => {
    const store = makeStore();
    store.table('rules').put(rule());
    await store.flush();
    const values: Record<string, unknown> = { bigint: 1n, function: () => null, symbol: Symbol('bad'), nonfinite: Infinity };
    const circular: { self?: unknown } = {};
    circular.self = circular;
    const bad = failure === 'circular' ? circular : values[failure];
    const record = { ...rule(), extra: bad };
    expect(() => store.table('rules').put(record)).toThrow('JSON 序列化');
    expect(() => store.table('rules').patch('r1', { extra: bad } as Partial<Rule>)).toThrow('JSON 序列化');
    expect(store.table('rules').get('r1')).toEqual(rule());
    expect(store.isDirty()).toBe(false);
  });

  it('合法嵌套 JSON 可写入并隔离引用，可选 undefined 按 JSON 规则省略', async () => {
    const store = makeStore();
    const extra = { values: [1, null, '文本'], optional: undefined };
    store.table('rules').put({ ...rule(), extra } as Rule);
    extra.values.push('外部修改');
    store.table('rules').patch('r1', { text: '新文本' });
    await store.flush();
    expect(store.table('rules').get('r1')).toEqual({ ...rule(), text: '新文本', extra: { values: [1, null, '文本'] } });
  });

  it('patch 的 JSON 转换不能改动记录身份，失败时保留原表和干净状态', async () => {
    const store = makeStore();
    store.table('rules').put(rule());
    await store.flush();
    const patch = { toJSON: () => ({ ...rule(), id: 'changed' }) } as Partial<Rule>;
    expect(() => store.table('rules').patch('r1', patch)).toThrow('不允许通过 JSON 序列化修改记录 id');
    expect(store.table('rules').list()).toEqual([rule()]);
    expect(store.isDirty()).toBe(false);
  });

  it('append 拒绝超出 Date 范围的时间和不可序列化内容，正负边界时间有效', () => {
    const store = makeStore();
    for (const at of [8_640_000_000_000_001, -8_640_000_000_000_001, Infinity, NaN]) {
      expect(() => store.log('audit').append(audit('bad', at))).toThrow('时间');
    }
    expect(() => store.log('audit').append({ ...audit('bad-content'), extra: 1n } as AuditEntry)).toThrow('JSON 序列化');
    expect(store.isDirty()).toBe(false);
    store.log('audit').append(audit('lower', -8_640_000_000_000_000));
    store.log('audit').append(audit('upper', 8_640_000_000_000_000));
    expect(store.log('audit').all().map(row => row.id)).toEqual(['lower', 'upper']);
  });

  it.each(['outside-range', 'missing-time'] as const)('自定义 JSON 转换造成 %s 也不能绕过入口校验', (mode) => {
    const store = makeStore();
    const entry = { ...audit('converted'), toJSON: () => mode === 'outside-range' ? audit('converted', 1e100) : { id: 'converted' } };
    expect(() => store.log('audit').append(entry)).toThrow('序列化后的时间');
    expect(store.log('audit').all()).toEqual([]);
    expect(store.isDirty()).toBe(false);
  });
});

describe('M01 刷盘失败隔离', () => {
  it('错误日志器抛异常时也不能阻断后续正常表', async () => {
    class FailedBotsFs extends MemoryFs {
      /** 只拒绝首张表，让后续 rules 写入能独立验证故障隔离。 */
      override async writeTextAtomic(path: string, text: string): Promise<void> {
        if (path === `${STATE}/bots.json`) throw new Error('bots 写入失败');
        await super.writeTextAtomic(path, text);
      }
    }
    class FailedLogger extends MemoryLogger {
      /** 故意让日志基础设施失败，检查它不会取代真正的刷盘错误。 */
      override error(): void {
        throw new Error('日志器不可用');
      }
    }
    const fs = new FailedBotsFs();
    const store = new FileStore(fs, new FakeClock(NOW), ROOT, TZ, new FailedLogger());
    store.table('bots').put({ id: 'legacy' } as TableTypes['bots']);
    store.table('rules').put(rule());
    await expect(store.flush()).rejects.toThrow('bots 写入失败');
    expect(await fs.readText(`${STATE}/rules.json`)).toBe(JSON.stringify([rule()]));
  });

  it('表和日志同时失败后，其余集合仍落盘，只重试各自失败的数据并汇总错误', async () => {
    class SelectiveFs extends MemoryFs {
      failures = new Set([`${STATE}/bots.json`, THREAD]);
      writes: string[] = [];

      /** 指定路径故障，其余路径保持正常，用于观察后续集合是否被跳过。 */
      override async writeTextAtomic(path: string, text: string): Promise<void> {
        this.writes.push(path);
        if (this.failures.has(path)) throw new Error(`写表错误 ${path}`);
        await super.writeTextAtomic(path, text);
      }

      /** 日志独立失败，验证不会中断后面的 audit 写入。 */
      override async appendText(path: string, text: string): Promise<void> {
        this.writes.push(path);
        if (this.failures.has(path)) throw new Error(`日志错误 ${path}`);
        await super.appendText(path, text);
      }
    }
    const fs = new SelectiveFs();
    const { store, logger } = fileSetup(fs);
    store.table('bots').put({ id: 'legacy' } as TableTypes['bots']);
    store.table('rules').put(rule());
    store.log('thread').append(message());
    store.log('audit').append(audit('healthy'));
    await expect(store.flush()).rejects.toThrow(/表 bots.*日志 thread/);
    expect(await fs.readText(`${STATE}/rules.json`)).toBe(JSON.stringify([rule()]));
    expect(await fs.readText(AUDIT)).toBe(`${JSON.stringify(audit('healthy'))}\n`);
    expect(logger.lines.filter(row => row.level === 'error')).toHaveLength(2);
    expect(store.isDirty()).toBe(true);
    fs.failures.clear();
    fs.writes = [];
    await store.flush();
    expect(fs.writes).toEqual([`${STATE}/bots.json`, THREAD]);
    expect(store.isDirty()).toBe(false);
  });

  it('上次日志追加与回滚都失败，下一次回滚仍失败也只阻塞所属日志', async () => {
    class RollbackFailureFs extends MemoryFs {
      fail = true;

      /** 写入半行后故障，模拟实际文件可能已经改变的追加失败。 */
      override async appendText(path: string, text: string): Promise<void> {
        if (this.fail && path === THREAD) {
          await super.appendText(path, text.slice(0, 5));
          throw new Error('线程追加失败');
        }
        await super.appendText(path, text);
      }

      /** 持续回滚失败保留脏状态，直到测试主动修复文件系统。 */
      override async remove(path: string): Promise<void> {
        if (this.fail && path === THREAD) throw new Error('线程回滚失败');
        await super.remove(path);
      }
    }
    const fs = new RollbackFailureFs();
    const { store } = fileSetup(fs);
    store.log('thread').append(message());
    await expect(store.flush()).rejects.toThrow('线程追加失败');
    store.table('rules').put(rule());
    store.log('audit').append(audit('next'));
    await expect(store.flush()).rejects.toThrow('线程回滚失败');
    expect(await fs.readText(`${STATE}/rules.json`)).toBe(JSON.stringify([rule()]));
    expect(await fs.readText(AUDIT)).toBe(`${JSON.stringify(audit('next'))}\n`);
    expect(store.isDirty()).toBe(true);
    fs.fail = false;
    await store.flush();
    expect(await fs.readText(THREAD)).toBe(`${JSON.stringify(message())}\n`);
    expect(store.isDirty()).toBe(false);
  });
});

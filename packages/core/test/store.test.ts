/** 两种存储共用行为验收，并用内存文件系统检查落盘、恢复、并发和清理边界。 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import { FileStore, MemoryStore, type Store, type Table, type TableName, type TableTypes } from '../src/store/index.js';
import { FakeClock, MemoryFs, MemoryLogger } from '../src/io/testing/index.js';
import type { AuditEntry, Bot, Rule } from '../src/model/index.js';

const DAY = 24 * 60 * 60 * 1_000;
const NOW = Date.parse('2026-11-05T04:00:00Z');
const ROOT = '/hub-fixture';
const TZ = 'Asia/Shanghai';
const rule = (id = 'ru_test', text = '先核验证据'): Rule => ({
  id, text, scope: 'global', redLine: false, source: 'owner', status: 'active', createdAt: NOW,
});
const audit = (id: string, at = NOW): AuditEntry => ({ id, at, actor: 'hub', action: 'test', detail: id });

function setup(kind: 'memory' | 'file', fs = new MemoryFs(new FakeClock(NOW))) {
  const clock = new FakeClock(NOW);
  const logger = new MemoryLogger();
  const store: Store = kind === 'file' ? new FileStore(fs, clock, ROOT, TZ, logger) : new MemoryStore();
  return { store, fs, clock, logger };
}

/** 含旧版字段的记录专门用于存储层最小恢复检查，不冒充领域 schema 合法样本。 */
function putLegacy<K extends TableName>(store: Store, name: K, value: { id: string; [key: string]: unknown }) {
  store.table(name).put(value as unknown as TableTypes[K]);
}

describe.each(['memory', 'file'] as const)('%s 共同行为', (kind) => {
  it('空表、空日志和干净状态', async () => {
    const { store } = setup(kind);
    await store.load();
    expect(store.table('rules').get('missing')).toBeNull();
    expect(store.table('rules').count()).toBe(0);
    expect(store.log('audit').all()).toEqual([]);
    expect(store.isDirty()).toBe(false);
    expectTypeOf(store.table('bots')).toEqualTypeOf<Table<Bot>>();
  });
  it('put、覆盖、过滤与 count', () => {
    const { store } = setup(kind);
    const table = store.table('rules');
    table.put(rule('r1')); table.put(rule('r2', '第二条')); table.put(rule('r1', '更新'));
    expect(table.count()).toBe(2);
    expect(table.count((item) => item.text === '更新')).toBe(1);
    expect(table.list((item) => item.id === 'r2')).toEqual([rule('r2', '第二条')]);
    expect(store.isDirty()).toBe(true);
  });
  it('patch 保留其他字段且不存在或改 id 时拒绝', () => {
    const { store } = setup(kind);
    store.table('rules').put(rule());
    expect(store.table('rules').patch('ru_test', { text: '修改' })).toEqual(rule('ru_test', '修改'));
    expect(() => store.table('rules').patch('missing', { text: '修改' })).toThrow('不存在');
    expect(() => store.table('rules').patch('ru_test', { id: 'other' })).toThrow('id');
  });
  it('返回副本，修改调用方对象不会绕过脏表追踪', async () => {
    const { store } = setup(kind);
    const input = rule(); store.table('rules').put(input); input.text = '偷偷修改';
    await store.flush();
    store.table('rules').get(input.id)!.text = '修改返回对象';
    store.table('rules').list()[0]!.text = '修改列表';
    expect(store.table('rules').get(input.id)?.text).toBe('先核验证据');
    expect(store.isDirty()).toBe(false);
  });
  it('remove 删除记录，不存在时保持干净', async () => {
    const { store } = setup(kind);
    store.table('rules').put(rule()); await store.flush();
    store.table('rules').remove('missing'); expect(store.isDirty()).toBe(false);
    store.table('rules').remove('ru_test'); expect(store.table('rules').count()).toBe(0);
    expect(store.isDirty()).toBe(true); await store.flush(); expect(store.isDirty()).toBe(false);
  });
  it('recent 从新到旧，since 包含边界，先过滤后限量', () => {
    const { store } = setup(kind);
    const log = store.log('audit');
    log.append(audit('a3', NOW + 2)); log.append(audit('a1', NOW)); log.append(audit('a2', NOW + 1));
    expect(log.all().map((x) => x.id)).toEqual(['a1', 'a2', 'a3']);
    expect(log.recent(2).map((x) => x.id)).toEqual(['a3', 'a2']);
    expect(log.recent(1, (x) => x.id !== 'a3').map((x) => x.id)).toEqual(['a2']);
    expect(log.since(NOW + 1).map((x) => x.id)).toEqual(['a2', 'a3']);
    expect(log.since(NOW, (x) => x.id === 'a1')).toEqual([audit('a1')]);
    expect(log.recent(0)).toEqual([]);
    expect(() => log.recent(-1)).toThrow('条数');
    expect(() => log.since(NaN)).toThrow('时间');
  });
  it('日志追加与读取隔离对象引用', async () => {
    const { store } = setup(kind);
    const entry = audit('a1'); store.log('audit').append(entry); entry.detail = '变更';
    store.log('audit').all()[0]!.detail = '再次变更';
    expect(store.log('audit').all()[0]!.detail).toBe('a1');
    expect(store.isDirty()).toBe(true); await store.flush(); expect(store.isDirty()).toBe(false);
  });
  it('相同日志时间的 recent 按追加倒序，all/since 按追加正序', () => {
    const { store } = setup(kind);
    store.log('audit').append(audit('a1')); store.log('audit').append(audit('a2'));
    expect(store.log('audit').recent(2).map((x) => x.id)).toEqual(['a2', 'a1']);
    expect(store.log('audit').all().map((x) => x.id)).toEqual(['a1', 'a2']);
    expect(store.log('audit').since(NOW).map((x) => x.id)).toEqual(['a1', 'a2']);
  });
  it('非法记录与未知表日志名被拒绝', () => {
    const { store } = setup(kind);
    expect(() => store.table('rules').put({ ...rule(), id: '' })).toThrow('id');
    expect(() => store.log('audit').append(audit('a1', NaN))).toThrow('时间');
    expect(() => store.table('../escape' as TableName)).toThrow('未知表');
    expect(() => store.log('unknown' as 'audit')).toThrow('未知日志');
  });
  it.each(['percepts', 'wakes', 'commits'] as const)('%s 保留期精确到毫秒', async (name) => {
    const { store } = setup(kind);
    const retention = (name === 'percepts' ? 14 : 30) * DAY;
    const field = name === 'wakes' ? 'startedAt' : 'createdAt';
    putLegacy(store, name, { id: 'old', [field]: NOW - retention - 1 });
    putLegacy(store, name, { id: 'edge', [field]: NOW - retention });
    await store.prune(NOW);
    expect(store.table(name).get('old')).toBeNull(); expect(store.table(name).get('edge')).not.toBeNull();
  });
  it.each([
    ['inbox', 'answered', 'open', 'answeredAt'],
    ['approvals', 'used', 'approved', 'usedAt'],
    ['outbox', 'done', 'ready', 'doneAt'],
  ] as const)('%s 仅清理已关闭且超过 30 天的记录', async (name, closed, open, endField) => {
    const { store } = setup(kind);
    const old = NOW - 31 * DAY;
    putLegacy(store, name, { id: 'closed-old', status: closed, createdAt: old, [endField]: old });
    putLegacy(store, name, { id: 'open-old', status: open, createdAt: old });
    putLegacy(store, name, { id: 'closed-now', status: closed, createdAt: old, [endField]: NOW });
    await store.prune(NOW);
    expect(store.table(name).get('closed-old')).toBeNull();
    expect(store.table(name).get('open-old')).not.toBeNull();
    expect(store.table(name).get('closed-now')).not.toBeNull();
  });
  it('内存日志保留最近 14 天，边界不删除', async () => {
    const { store } = setup(kind);
    store.log('audit').append(audit('old', NOW - 14 * DAY - 1));
    store.log('audit').append(audit('edge', NOW - 14 * DAY));
    await store.prune(NOW);
    expect(store.log('audit').all().map((x) => x.id)).toEqual(['edge']);
    await expect(store.prune(NaN)).rejects.toThrow('nowMs');
  });
});

describe('FileStore 持久化与恢复', () => {
  it('只写脏表，并从固定路径恢复 JSON 数组', async () => {
    const { store, fs, clock } = setup('file');
    store.table('rules').put(rule()); await store.flush();
    const path = `${ROOT}/.hub/state/rules.json`;
    expect(JSON.parse((await fs.readText(path))!)).toEqual([rule()]);
    expect(Object.keys(fs.snapshot())).toEqual([path]);
    const restored = new FileStore(fs, clock, ROOT, TZ);
    await restored.load(); expect(restored.table('rules').get('ru_test')).toEqual(rule());
  });
  it('坏 JSON 原样备份后以空表继续，正常表仍能加载', async () => {
    const { store, fs, logger } = setup('file');
    const path = `${ROOT}/.hub/state/bots.json`;
    await fs.writeTextAtomic(path, '[broken');
    await fs.writeTextAtomic(`${ROOT}/.hub/state/rules.json`, JSON.stringify([rule()]));
    await store.load();
    expect(store.table('bots').list()).toEqual([]); expect(store.table('rules').count()).toBe(1);
    expect(await fs.readText(`${path}.bad-${NOW}`)).toBe('[broken');
    expect(logger.lines.some((line) => line.level === 'warn')).toBe(true);
    await store.flush(); expect(await fs.readText(path)).toBe('[]');
  });
  it('顶层不是数组同样备份；备份重名保留旧证据', async () => {
    const { store, fs } = setup('file');
    const path = `${ROOT}/.hub/state/bots.json`;
    await fs.writeTextAtomic(path, '{}'); await fs.writeTextAtomic(`${path}.bad-${NOW}`, 'earlier');
    await store.load();
    expect(await fs.readText(`${path}.bad-${NOW}`)).toBe('earlier');
    expect(await fs.readText(`${path}.bad-${NOW}-1`)).toBe('{}');
  });
  it('跳过无 id 与非对象，保留具有 id 的旧版本记录', async () => {
    const { store, fs } = setup('file');
    await fs.writeTextAtomic(`${ROOT}/.hub/state/bots.json`, JSON.stringify([null, 1, [], {}, { id: '' }, { id: 'legacy' }]));
    await store.load(); expect(store.table('bots').list()).toEqual([{ id: 'legacy' }]);
  });
  it('不能 load 覆盖未落盘更改', async () => {
    const { store } = setup('file'); store.table('rules').put(rule());
    await expect(store.load()).rejects.toThrow('未落盘');
    expect(store.table('rules').count()).toBe(1);
  });
  it('UTC 16:00 前后按上海日期分日志且重刷不重复', async () => {
    const { store, fs } = setup('file');
    store.log('audit').append(audit('before', Date.parse('2026-11-04T15:59:59Z')));
    store.log('audit').append(audit('after', Date.parse('2026-11-04T16:00:00Z')));
    await store.flush(); const before = fs.snapshot(); await store.flush();
    expect(fs.snapshot()).toEqual(before);
    expect(JSON.parse((await fs.readText(`${ROOT}/.hub/logs/audit/2026-11-04.jsonl`))!)).toMatchObject({ id: 'before' });
    expect(JSON.parse((await fs.readText(`${ROOT}/.hub/logs/audit/2026-11-05.jsonl`))!)).toMatchObject({ id: 'after' });
  });
  it('按 createdAt 分线程日志，使用传入时区', async () => {
    const fs = new MemoryFs(); const store = new FileStore(fs, new FakeClock(NOW), ROOT, 'UTC');
    store.log('thread').append({ id: 'm1', thread: 'team', from: 'hub', kind: 'chat', text: '你好', refId: null, readAt: null, createdAt: Date.parse('2026-11-04T16:00:00Z') });
    await store.flush(); expect(await fs.readText(`${ROOT}/.hub/logs/thread/2026-11-04.jsonl`)).toContain('你好');
  });
  it('加载只保留最近 14 天，坏行跳过并备份有效行仍可查询', async () => {
    const { store, fs, clock } = setup('file');
    store.log('audit').append(audit('old', NOW - 15 * DAY));
    store.log('audit').append(audit('new')); await store.flush();
    const path = `${ROOT}/.hub/logs/audit/2026-11-05.jsonl`;
    await fs.appendText(path, 'broken\n{}\n');
    const restored = new FileStore(fs, clock, ROOT, TZ, new MemoryLogger()); await restored.load();
    expect(restored.log('audit').since(NOW)).toEqual([audit('new')]);
    expect(restored.log('audit').all()).toHaveLength(1);
    expect(await fs.readText(`${path}.bad-${NOW}`)).toContain('broken');
  });
  it('load 正向读回最近 3 天、13 天及精确 14 天边界，all 与 since 都可查询', async () => {
    const { store, fs, clock } = setup('file');
    const entries = [audit('edge', NOW - 14 * DAY), audit('day13', NOW - 13 * DAY), audit('day3', NOW - 3 * DAY)];
    for (const entry of entries) store.log('audit').append(entry);
    store.log('audit').append(audit('before-edge', NOW - 14 * DAY - 1));
    await store.flush();
    const restored = new FileStore(fs, clock, ROOT, TZ);
    await restored.load();
    expect(restored.log('audit').all()).toEqual(entries);
    expect(restored.log('audit').since(NOW - 14 * DAY)).toEqual(entries);
  });
  it.each([['appraisals', 14], ['ledger', 30], ['thread', 180], ['audit', 90]] as const)('%s 仅删除完全过期的日文件', async (name, days) => {
    const { store, fs } = setup('file');
    const cutoff = NOW - days * DAY;
    const date = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    const dir = `${ROOT}/.hub/logs/${name}`;
    const oldPath = `${dir}/${date(cutoff - DAY)}.jsonl`;
    const edgePath = `${dir}/${date(cutoff)}.jsonl`;
    await fs.writeTextAtomic(oldPath, 'old'); await fs.writeTextAtomic(edgePath, 'edge');
    await fs.writeTextAtomic(`${oldPath}.bad-0`, 'evidence');
    await fs.writeTextAtomic(`${dir}/2020-99-99.jsonl`, 'unknown');
    await store.prune(NOW);
    expect(await fs.readText(oldPath)).toBeNull(); expect(await fs.readText(edgePath)).toBe('edge');
    expect(await fs.readText(`${oldPath}.bad-0`)).toBeNull();
    expect(await fs.readText(`${dir}/2020-99-99.jsonl`)).toBe('unknown');
  });
  it('尚未落盘的较老日志不会因内存 14 天清理而丢失', async () => {
    const { store, fs } = setup('file');
    store.log('audit').append(audit('old', NOW - 20 * DAY));
    await store.prune(NOW); expect(store.log('audit').all()).toEqual([]);
    await store.flush(); expect(Object.values(fs.snapshot()).join('')).toContain('old');
  });
  it('绝对路径和有效时区是构造前提', () => {
    const fs = new MemoryFs(); const clock = new FakeClock();
    expect(() => new FileStore(fs, clock, '~/hub', TZ)).toThrow('绝对路径');
    expect(() => new FileStore(fs, clock, ROOT, 'Not/AZone')).toThrow();
  });
  it.each([JSON.stringify(audit('previous')), '{"id":"unfinished"'])('无换行尾部也不能污染后续新日志：%s', async (tail) => {
    const { store, fs, clock } = setup('file');
    const path = `${ROOT}/.hub/logs/audit/2026-11-05.jsonl`;
    await fs.writeTextAtomic(path, tail); await store.load();
    store.log('audit').append(audit('new')); await store.flush();
    const restored = new FileStore(fs, clock, ROOT, TZ, new MemoryLogger()); await restored.load();
    expect(restored.log('audit').all().some((entry) => entry.id === 'new')).toBe(true);
    if (tail.includes('unfinished')) {
      expect(await fs.readText(path)).not.toContain(tail);
      expect(await fs.readText(`${path}.bad-${NOW}`)).toBe(tail);
    } else {
      expect(await fs.readText(path)).toContain(`${tail}\n`);
    }
  });
});

/** 用手动闸门暂停 I/O，不用真实等待或定时器证明刷盘串行和中途修改不丢失。 */
class BlockingFs extends MemoryFs {
  private releaseWrite!: () => void;
  private signalStarted!: () => void;
  readonly started = new Promise<void>((resolve) => { this.signalStarted = resolve; });
  private readonly blocked = new Promise<void>((resolve) => { this.releaseWrite = resolve; });
  writes = 0; concurrent = 0; maxConcurrent = 0;
  release(): void { this.releaseWrite(); }
  override async writeTextAtomic(path: string, text: string): Promise<void> {
    this.writes++; this.concurrent++; this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrent);
    if (this.writes === 1) { this.signalStarted(); await this.blocked; }
    await super.writeTextAtomic(path, text); this.concurrent--;
  }
}

describe('FileStore I/O 故障与并发', () => {
  it('启动 load 期间拒绝业务写入，完成后恢复写入', async () => {
    let release!: () => void; let started!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const reading = new Promise<void>((resolve) => { started = resolve; });
    class BlockingReadFs extends MemoryFs {
      override async readText(path: string) { started(); await blocked; return super.readText(path); }
    }
    const { store } = setup('file', new BlockingReadFs());
    const table = store.table('rules'); const loading = store.load(); await reading;
    expect(() => table.put(rule())).toThrow('加载完成');
    expect(() => store.log('audit').append(audit('new'))).toThrow('加载完成');
    release(); await loading; table.put(rule()); expect(table.count()).toBe(1);
  });
  it('刷盘中途改表并多次 flush，只串行写两次且最后数据正确', async () => {
    const fs = new BlockingFs(); const { store } = setup('file', fs);
    store.table('rules').put(rule()); const first = store.flush(); await fs.started;
    store.table('rules').patch('ru_test', { text: '中途更新' });
    const second = store.flush(); const third = store.flush(); fs.release();
    await Promise.all([first, second, third]);
    expect(fs.maxConcurrent).toBe(1); expect(fs.writes).toBe(2); expect(store.isDirty()).toBe(false);
    expect(await fs.readText(`${ROOT}/.hub/state/rules.json`)).toContain('中途更新');
  });
  it('刷盘中途改表但没有新 flush，脏标记保留到下一次刷盘', async () => {
    const fs = new BlockingFs(); const { store } = setup('file', fs);
    store.table('rules').put(rule()); const first = store.flush(); await fs.started;
    store.table('rules').patch('ru_test', { text: '稍后落盘' }); fs.release(); await first;
    expect(store.isDirty()).toBe(true); await store.flush(); expect(store.isDirty()).toBe(false);
  });
  it('写表失败保留脏数据，后续重试可继续', async () => {
    class FailOnceFs extends MemoryFs {
      fail = true;
      override async writeTextAtomic(path: string, text: string) {
        if (this.fail) { this.fail = false; throw new Error('模拟磁盘错误'); }
        await super.writeTextAtomic(path, text);
      }
    }
    const { store } = setup('file', new FailOnceFs()); store.table('rules').put(rule());
    await expect(store.flush()).rejects.toThrow('模拟磁盘错误'); expect(store.isDirty()).toBe(true);
    await store.flush(); expect(store.isDirty()).toBe(false);
  });
  it('后一天追加失败时重试不重复前一天已成功的日志', async () => {
    class FailSecondDayFs extends MemoryFs {
      calls = 0;
      override async appendText(path: string, text: string) {
        if (++this.calls === 2) throw new Error('追加失败');
        await super.appendText(path, text);
      }
    }
    const fs = new FailSecondDayFs(); const { store } = setup('file', fs);
    store.log('audit').append(audit('first', NOW - DAY)); store.log('audit').append(audit('second', NOW));
    await expect(store.flush()).rejects.toThrow('追加失败'); await store.flush();
    const first = (await fs.readText(`${ROOT}/.hub/logs/audit/2026-11-04.jsonl`))!;
    expect(first.trim().split('\n')).toHaveLength(1); expect(store.isDirty()).toBe(false);
  });
  it.each(['partial', 'complete'] as const)('追加 %s 内容后报错，恢复后重试既不丢失也不重复', async (mode) => {
    class PartialFailureFs extends MemoryFs {
      fail = true;
      override async appendText(path: string, text: string) {
        if (this.fail) {
          this.fail = false;
          await super.appendText(path, mode === 'partial' ? text.slice(0, 9) : text);
          throw new Error('写入后失败');
        }
        await super.appendText(path, text);
      }
    }
    const fs = new PartialFailureFs(); const { store } = setup('file', fs);
    const path = `${ROOT}/.hub/logs/audit/2026-11-05.jsonl`;
    await fs.writeTextAtomic(path, JSON.stringify(audit('previous')) + '\n');
    store.log('audit').append(audit('new'));
    await expect(store.flush()).rejects.toThrow('写入后失败');
    expect(store.isDirty()).toBe(true); expect(await fs.readText(`${path}.bad-${NOW}`)).not.toBeNull();
    await store.flush();
    const rows = (await fs.readText(path))!.trim().split('\n').map((line) => JSON.parse(line));
    expect(rows.map((entry) => entry.id)).toEqual(['previous', 'new']);
    expect(store.isDirty()).toBe(false);
  });
  it('追加和回滚都失败时，下一次 flush 先恢复再写入', async () => {
    class RollbackFailureFs extends MemoryFs {
      appendFails = true; rollbackFails = true;
      override async appendText(path: string, text: string) {
        if (this.appendFails) { this.appendFails = false; await super.appendText(path, text.slice(0, 8)); throw new Error('追加错误'); }
        await super.appendText(path, text);
      }
      override async remove(path: string) {
        if (this.rollbackFails) { this.rollbackFails = false; throw new Error('回滚错误'); }
        await super.remove(path);
      }
    }
    const fs = new RollbackFailureFs(); const { store } = setup('file', fs);
    store.log('audit').append(audit('new')); await expect(store.flush()).rejects.toThrow('追加错误');
    expect(store.isDirty()).toBe(true); await store.flush();
    const path = `${ROOT}/.hub/logs/audit/2026-11-05.jsonl`;
    expect(JSON.parse((await fs.readText(path))!)).toEqual(audit('new'));
    expect(store.isDirty()).toBe(false);
  });
});

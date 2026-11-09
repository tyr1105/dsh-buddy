/** 七天仿真要求大量只读查询保持轻量；同时验证惰性查询没有把内部记录泄露给谓词或结果调用方。 */
import { describe, expect, it } from 'vitest';
import { MemoryStore, FileStore } from '../src/store/index.js';
import { FakeClock, MemoryFs, MemoryLogger } from '../src/io/testing/index.js';
import type { Rule, AuditEntry } from '../src/model/index.js';

const now = Date.parse('2026-11-05T10:00:00+08:00');
const audit = (id: string, at: number): AuditEntry => ({ id, at, actor: 'hub', action: '测试', detail: id });

/** 两种存储共用查询实现，恢复与清理也要让排序缓存及时失效。 */
function setup(file: boolean) {
  const clock = new FakeClock(now);
  const fs = new MemoryFs(clock);
  const store = file ? new FileStore(fs, clock, '/hub', 'Asia/Shanghai', new MemoryLogger()) : new MemoryStore();
  return { store, fs };
}

describe.each([false, true])('C04 存储查询副本与排序缓存（文件=%s）', file => {
  it('表谓词可改自己的深副本，list/count/get 均不污染原始记录', async () => {
    const { store } = setup(file);
    const row = { id: 'r', scope: 'global', text: '原文', redLine: false, source: 'owner', status: 'active', createdAt: now,
      nested: { values: [{ text: '原始嵌套' }], nil: null } } as Rule & { nested: { values: Array<{ text: string }>; nil: null } };
    store.table('rules').put(row);
    await store.flush();
    const list = store.table('rules').list(item => {
      const value = item as typeof row;
      value.nested.values[0]!.text = '谓词修改';
      value.text = '副本文案';
      return true;
    });
    expect(list[0]?.text).toBe('副本文案');
    expect(store.table('rules').count(item => { item.text = '计数修改'; return true; })).toBe(1);
    expect(store.table('rules').get('r')).toEqual(row);
    (list[0] as typeof row).nested.values.push({ text: '事后追加' });
    expect(store.table('rules').get('r')).toEqual(row);
    expect(store.isDirty()).toBe(false);
  });

  it('JSON 原型同名键保持普通自有字段，不污染对象原型', () => {
    const { store } = setup(file);
    const row = JSON.parse('{"id":"r","__proto__":{"polluted":true},"constructor":{"x":1},"array":[{"y":2}]}') as Rule;
    store.table('rules').put(row);
    const result = store.table('rules').get('r')!;
    expect(Object.hasOwn(result, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(result).toEqual(row);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it('计数谓词主动另写表时，本次遍历仍使用开始时的记录集合', () => {
    const { store } = setup(file);
    const row: Rule = { id: 'r1', scope: 'global', text: '原文', redLine: false, source: 'owner', status: 'active', createdAt: now };
    store.table('rules').put(row);
    let visited = 0;
    const count = store.table('rules').count(() => {
      visited += 1;
      store.table('rules').put({ ...row, id: 'r2' });
      return true;
    });
    expect(count).toBe(1);
    expect(visited).toBe(1);
    expect(store.table('rules').count()).toBe(2);
  });

  it('recent 找到足够匹配后立即停止谓词，且修改副本不改变后续查询', () => {
    const { store } = setup(file);
    for (let index = 0; index < 100; index += 1) store.log('audit').append(audit(`a${index}`, now + index));
    const seen: string[] = [];
    const rows = store.log('audit').recent(2, row => {
      seen.push(row.id);
      row.detail = '谓词可以修改副本';
      return Number(row.id.slice(1)) % 2 === 0;
    });
    expect(seen).toEqual(['a99', 'a98', 'a97', 'a96']);
    expect(rows.map(row => row.id)).toEqual(['a98', 'a96']);
    expect(store.log('audit').recent(1)[0]?.detail).toBe('a99');
    const zeroCalls: string[] = [];
    expect(store.log('audit').recent(0, row => { zeroCalls.push(row.id); return true; })).toEqual([]);
    expect(zeroCalls).toEqual([]);
  });

  it('since 先定位时间窗，包含边界；乱序追加、同戳顺序和缓存读取保持正确', () => {
    const { store } = setup(file);
    for (const [id, offset] of [['c', 2], ['a', 0], ['b', 1]] as const) store.log('audit').append(audit(id, now + offset));
    expect(store.log('audit').all().map(row => row.id)).toEqual(['a', 'b', 'c']);
    const seen: string[] = [];
    expect(store.log('audit').since(now + 1, row => { seen.push(row.id); row.detail = '副本'; return true; }).map(row => row.id)).toEqual(['b', 'c']);
    expect(seen).toEqual(['b', 'c']);
    store.log('audit').append(audit('d', now + 1));
    expect(store.log('audit').recent(4).map(row => row.id)).toEqual(['c', 'd', 'b', 'a']);
    expect(store.log('audit').all().map(row => row.detail)).toEqual(['a', 'b', 'd', 'c']);
  });

  it('prune 和重新 load 会作废排序索引，不能读出已经清理的缓存行', async () => {
    const { store } = setup(file);
    store.log('audit').append(audit('旧', now - 20 * 86400000));
    store.log('audit').append(audit('新', now));
    expect(store.log('audit').all()).toHaveLength(2);
    await store.flush();
    await store.prune(now);
    expect(store.log('audit').all().map(row => row.id)).toEqual(['新']);
    await store.load();
    expect(store.log('audit').recent(2).map(row => row.id)).toEqual(['新']);
  });
});

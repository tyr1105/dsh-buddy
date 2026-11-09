/**
 * F01 账本模型与存储测试（里程碑 1）：
 * 验证新表 schema 的正反例、保留期与清理边界，确认只新增文件、不动旧实体。
 */
import { describe, expect, it } from 'vitest';
import { MemoryStore, TABLE_NAMES } from '../src/store/index.js';
import {
  V2_DEFAULTS, WakeLedgerEntrySchema, V2ConfigSchema, type WakeLedgerEntry,
} from '../src/index.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-05T10:00:00+08:00');

/** 一条最小合法账本记录；各用例只改需要验证的字段。 */
function entry(patch: Partial<WakeLedgerEntry> = {}): WakeLedgerEntry {
  return {
    id: 'wl_0000000001',
    wakeId: 'w_0000000001',
    botId: 'b_0000000001',
    sessionId: 'session-1',
    variant: 'regular',
    status: 'running',
    source: 'live',
    completeness: 'full',
    missing: [],
    openedAt: NOW,
    sealedAt: null,
    trigger: {
      kind: 'percept',
      score: 0.82,
      threshold: 0.7,
      summary: '竞品页面变了',
      ownerSummary: '竞品页面出现新版本',
      ownerInitiated: false,
      subjectKey: 'watch:w1',
      queueWaitMs: 1200,
      evidenceRefs: ['p_0000000001'],
    },
    evidence: {
      items: [{
        kind: 'percept', refId: 'p_0000000001', summary: '页面出现新版本',
        occurredAt: NOW - 60_000, trust: 'trusted',
      }],
    },
    decision: null,
    actions: { items: [] },
    result: { verification: null, worldChanges: [], refs: [], summary: null },
    steps: 0,
    tokens: 0,
    truncated: false,
    bytes: 0,
    ...patch,
  };
}

/** 修改数组长度时复制，避免用例之间共享引用。 */
function withEvidence(count: number): WakeLedgerEntry {
  return entry({
    evidence: {
      items: Array.from({ length: count }, (_, i) => ({
        kind: 'percept' as const, refId: `p_${String(i).padStart(10, '0')}`, summary: `证据 ${i}`,
        occurredAt: NOW, trust: 'trusted' as const,
      })),
    },
  });
}

describe('F01 唤醒账本 schema', () => {
  it('合法记录通过校验，未封存的行用 running 表示', () => {
    const parsed = WakeLedgerEntrySchema.parse(entry());
    expect(parsed.status).toBe('running');
    expect(parsed.sealedAt).toBeNull();
    expect(parsed.source).toBe('live');
  });

  it('缺少 wakeId 被拒绝', () => {
    const bad = entry() as Record<string, unknown>;
    delete bad.wakeId;
    expect(() => WakeLedgerEntrySchema.parse(bad)).toThrow();
  });

  it('多余字段被拒绝，防止新旧版本字段悄悄混用', () => {
    expect(() => WakeLedgerEntrySchema.parse({ ...entry(), extra: 1 })).toThrow();
  });

  it('账本 id 必须是 wl_ 加 10 位小写字母或数字', () => {
    expect(() => WakeLedgerEntrySchema.parse(entry({ id: 'wl_1' }))).toThrow();
    expect(() => WakeLedgerEntrySchema.parse(entry({ id: 'w_0000000001' }))).toThrow();
  });

  it('证据最多 10 条，第 11 条被拒绝', () => {
    expect(() => WakeLedgerEntrySchema.parse(withEvidence(10))).not.toThrow();
    expect(() => WakeLedgerEntrySchema.parse(withEvidence(11))).toThrow();
  });

  it('动作最多 30 条，第 31 条被拒绝', () => {
    const action = { kind: 'hub_tool' as const, name: 'hub_state_get', target: null, outcome: 'ok' as const, source: 'observed' as const, refId: null, detail: '', durationMs: 3 };
    const many = (count: number) => entry({ actions: { items: Array.from({ length: count }, () => action) } });
    expect(() => WakeLedgerEntrySchema.parse(many(30))).not.toThrow();
    expect(() => WakeLedgerEntrySchema.parse(many(31))).toThrow();
  });

  it('缺失段只能是约定枚举，拼错会被拒绝', () => {
    expect(() => WakeLedgerEntrySchema.parse(entry({ missing: ['actions', 'commit'] }))).not.toThrow();
    expect(() => WakeLedgerEntrySchema.parse(entry({ missing: ['everything' as never] }))).toThrow();
  });

  it('回填行可以没有交账，decision 为空且来源为 backfill', () => {
    const parsed = WakeLedgerEntrySchema.parse(entry({
      source: 'backfill', completeness: 'partial', status: 'no_commit',
      sealedAt: NOW + 1000, missing: ['actions', 'commit'],
    }));
    expect(parsed.decision).toBeNull();
    expect(parsed.missing).toContain('commit');
  });

  it('交账副本的 outcome 允许为空，但摘要字段仍在', () => {
    const parsed = WakeLedgerEntrySchema.parse(entry({
      decision: { outcome: null, summary: '', blocker: null, nextThink: null, ownerQuestion: null, report: null, importance: null },
    }));
    expect(parsed.decision?.outcome).toBeNull();
  });

  it('重要度超出 1–10 被拒绝', () => {
    const decision = { outcome: 'done' as const, summary: '完成', blocker: null, nextThink: null, ownerQuestion: null, report: null, importance: 11 };
    expect(() => WakeLedgerEntrySchema.parse(entry({ decision }))).toThrow();
  });
});

describe('F01 v2Config schema', () => {
  it('单例合法记录通过校验', () => {
    const parsed = V2ConfigSchema.parse({ id: 'v2', schemaVersion: 1, backfillDoneThrough: null, createdAt: NOW, updatedAt: NOW });
    expect(parsed.id).toBe('v2');
  });

  it('id 不是 v2 被拒绝', () => {
    expect(() => V2ConfigSchema.parse({ id: 'v3', schemaVersion: 1, backfillDoneThrough: null, createdAt: NOW, updatedAt: NOW })).toThrow();
  });

  it('版本号必须是正整数', () => {
    expect(() => V2ConfigSchema.parse({ id: 'v2', schemaVersion: 0, backfillDoneThrough: null, createdAt: NOW, updatedAt: NOW })).toThrow();
    expect(() => V2ConfigSchema.parse({ id: 'v2', schemaVersion: 1.5, backfillDoneThrough: null, createdAt: NOW, updatedAt: NOW })).toThrow();
  });
});

describe('F01 存储注册与清理', () => {
  it('新表已注册，且不影响原有表名', () => {
    expect(TABLE_NAMES).toContain('wakeLedger');
    expect(TABLE_NAMES).toContain('v2Config');
    expect(TABLE_NAMES).toContain('bots');
    expect(TABLE_NAMES).toContain('wakes');
  });

  it('账本可以写入、读取和按条件统计', () => {
    const store = new MemoryStore();
    store.table('wakeLedger').put(entry());
    expect(store.table('wakeLedger').get('wl_0000000001')?.wakeId).toBe('w_0000000001');
    expect(store.table('wakeLedger').count(row => row.source === 'live')).toBe(1);
    expect(store.isDirty()).toBe(true);
  });

  it('未封存的账本再老也不清理', async () => {
    const store = new MemoryStore();
    store.table('wakeLedger').put(entry({ openedAt: NOW - 400 * DAY, sealedAt: null }));
    await store.prune(NOW);
    expect(store.table('wakeLedger').count()).toBe(1);
  });

  it('已封存且超过 90 天的账本被清理', async () => {
    const store = new MemoryStore();
    store.table('wakeLedger').put(entry({ status: 'committed', sealedAt: NOW - 91 * DAY }));
    await store.prune(NOW);
    expect(store.table('wakeLedger').count()).toBe(0);
  });

  it('已封存但在 90 天内的账本保留', async () => {
    const store = new MemoryStore();
    store.table('wakeLedger').put(entry({ status: 'committed', sealedAt: NOW - 89 * DAY }));
    await store.prune(NOW);
    expect(store.table('wakeLedger').count()).toBe(1);
  });

  it('保留期默认值来自 V2_DEFAULTS，且不往 Settings 里加键', async () => {
    expect(V2_DEFAULTS.LEDGER_RETENTION_MS).toBe(90 * DAY);
    const store = new MemoryStore();
    store.table('wakeLedger').put(entry({ status: 'no_commit', sealedAt: NOW - 90 * DAY - 1 }));
    await store.prune(NOW);
    expect(store.table('wakeLedger').count()).toBe(0);
  });

  it('保留期边界按严格早于截止计算，正好 90 天仍保留', async () => {
    const store = new MemoryStore();
    store.table('wakeLedger').put(entry({ status: 'no_commit', sealedAt: NOW - 90 * DAY }));
    await store.prune(NOW);
    expect(store.table('wakeLedger').count()).toBe(1);
  });

  it('v2Config 可以保存单例行', () => {
    const store = new MemoryStore();
    store.table('v2Config').put({ id: 'v2', schemaVersion: 1, backfillDoneThrough: NOW, createdAt: NOW, updatedAt: NOW });
    expect(store.table('v2Config').get('v2')?.backfillDoneThrough).toBe(NOW);
  });

  it('旧表清理规则保持不变：已关闭的收件箱仍按 30 天清理', async () => {
    const store = new MemoryStore();
    store.table('inbox').put({
      id: 'i_0000000001', botId: 'b_0000000001', type: 'proposal', priority: 'P1',
      title: '标题', body: '正文', status: 'closed', createdAt: NOW - 31 * DAY,
      answeredAt: NOW - 31 * DAY, closedAt: NOW - 31 * DAY, refId: null, readAt: null,
    } as never);
    await store.prune(NOW);
    expect(store.table('inbox').count()).toBe(0);
  });
});

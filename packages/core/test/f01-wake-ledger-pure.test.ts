/** F01 纯函数验收：开账、封存、证据快照、截断、回填匹配都不依赖宿主与真实时间。 */
import { describe, expect, it } from 'vitest';
import type { Commit, WakeTicket } from '../src/model/index.js';
import type { WakeLedgerEntry } from '../src/model/wake-ledger.js';
import { V2_DEFAULTS } from '../src/config/defaults.js';
import { clipLedgerText, snapshotEvidence } from '../src/ledger/evidence.js';
import { buildOpenLedger, decisionFromCommit, sealLedger, sealMissingWake, triggerFromWake } from '../src/ledger/entry.js';
import { capLedgerEntry } from '../src/ledger/caps.js';
import { buildBackfillEntry, matchWokeAppraisal } from '../src/ledger/backfill.js';
import type { EvidenceCandidate } from '../src/ledger/evidence.js';

const at = 1_793_808_000_000;
const botId = 'b_0000000001';
const wakeId = 'w_0000000001';

/** 构造合法的唤醒单；用例只覆盖需要差异的字段。 */
function ticket(patch: Partial<WakeTicket> = {}): WakeTicket {
  return {
    id: wakeId, botId, sessionId: 'session-one', variant: 'regular',
    reason: { kind: 'percept', score: 0.8, threshold: 0.6, summary: '资料发生变化', ownerSummary: '资料有更新', evidence: ['p_0000000001'] },
    ownerInitiated: false, packetBytes: 1200, status: 'running', startedAt: at, lastEventAt: at,
    endedAt: null, steps: 2, tokens: 300, steeredAt: null, commitId: null, error: null, ...patch,
  };
}

/** 构造合法交账；证据与引用由用例按需覆盖。 */
function commitFixture(patch: Partial<Commit> = {}): Commit {
  return {
    id: 'c_0000000001', wakeId, botId, outcome: 'progress', summary: '核实了一条公开事实',
    worldChanges: [{ what: '记录了一条事实', whoCanSee: 'owner', where: '/hub/notes.md' }],
    evidence: ['p_0000000002'], verification: { level: 'program', notCovered: '尚未人工检查' },
    blocker: null, nextThink: { mode: 'auto', reason: '等待新的证据' }, ownerQuestion: null,
    reply: null, report: null, importance: 5, proposals: [], createdAt: at, ...patch,
  };
}

const candidate = (refId: string, patch: Partial<EvidenceCandidate> = {}): EvidenceCandidate => ({
  kind: 'percept', refId, summary: '文件增加一段文字', occurredAt: at, trust: 'untrusted', ...patch,
});

/** 构造一条开账后的账本行，供封存与截断用例使用。 */
function openEntry(patch: Partial<WakeLedgerEntry> = {}): WakeLedgerEntry {
  return {
    id: 'wl_0000000001', wakeId, botId, sessionId: 'session-one', variant: 'regular', status: 'running',
    source: 'live', completeness: 'full', missing: [], openedAt: at, sealedAt: null,
    trigger: {
      kind: 'percept', score: 0.8, threshold: 0.6, summary: '资料发生变化', ownerSummary: '资料有更新',
      ownerInitiated: false, subjectKey: null, queueWaitMs: 1200, evidenceRefs: ['p_0000000001'],
    },
    evidence: { items: [{ kind: 'percept', refId: 'p_0000000001', summary: '文件增加一段文字', occurredAt: at, trust: 'untrusted' }] },
    decision: null,
    actions: { items: [{ kind: 'hub_tool', name: 'hub_state_get', target: null, outcome: 'ok', source: 'observed', refId: null, detail: '成功', durationMs: 3 }] },
    result: { verification: null, worldChanges: [], refs: [], summary: null },
    steps: 2, tokens: 300, truncated: false, bytes: 0, ...patch,
  };
}

describe('F01 证据快照', () => {
  it('短文本原样保留，换行改成单行分隔', () => {
    expect(clipLedgerText('一段事实', 160)).toBe('一段事实');
    expect(clipLedgerText('第一行\n第二行', 160)).toBe('第一行 / 第二行');
  });

  it('超过上限按完整字符截断并补省略号，长度为 0 时返回空串', () => {
    expect(clipLedgerText('一二三四五', 3)).toBe('一二…');
    expect(clipLedgerText('一二三四五', 0)).toBe('');
  });

  it('按请求顺序生成快照，同一 id 只保留第一次命中并保留可信度', () => {
    const snapshot = snapshotEvidence(['p_2', 'p_1', 'p_2'], [candidate('p_1'), candidate('p_2', { trust: 'trusted' })], 10, 160);
    expect(snapshot.items.map(item => item.refId)).toEqual(['p_2', 'p_1']);
    expect(snapshot.items[0]).toMatchObject({ kind: 'percept', trust: 'trusted', occurredAt: at });
    expect(snapshot.missingIds).toEqual([]);
  });

  it('找不到的 id 记为 unknown 并进入 missing，绝不编造摘要', () => {
    const snapshot = snapshotEvidence(['p_gone'], [], 10, 160);
    expect(snapshot.items).toEqual([{ kind: 'unknown', refId: 'p_gone', summary: '已清理，无法回溯', occurredAt: null, trust: 'unknown' }]);
    expect(snapshot.missingIds).toEqual(['p_gone']);
  });

  it('超过条数上限后只记录缺失 id，不再生成证据项', () => {
    const snapshot = snapshotEvidence(['p_1', 'p_2', 'p_gone'], [candidate('p_1'), candidate('p_2')], 1, 160);
    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.items[0]!.refId).toBe('p_1');
    expect(snapshot.missingIds).toEqual(['p_gone']);
  });
});

describe('F01 触发与决定段', () => {
  it('触发段复制分数、门槛和理由，证据 id 最多 20 个', () => {
    const many = Array.from({ length: 25 }, (_, index) => `p_${index}`);
    const trigger = triggerFromWake(ticket({ reason: { kind: 'percept', score: 0.9, threshold: 0.5, summary: '理由', evidence: many } }));
    expect(trigger).toMatchObject({ kind: 'percept', score: 0.9, threshold: 0.5, queueWaitMs: null });
    expect(trigger.ownerSummary).toBeNull();
    expect(trigger.evidenceRefs).toHaveLength(20);
  });

  it('决定段只复制交账事实，不重新生成结论', () => {
    const decision = decisionFromCommit(commitFixture({
      ownerQuestion: { text: '是否继续？', options: ['继续'], defaultOption: '继续', whyNeeded: '需要确认' },
      report: '有进展', importance: 7,
    }));
    expect(decision).toMatchObject({ outcome: 'progress', summary: '核实了一条公开事实', ownerQuestion: '是否继续？', report: '有进展', importance: 7 });
  });
});

describe('F01 开账', () => {
  it('投递成功后开账：运行态、live、无决定、动作先空', () => {
    const entry = buildOpenLedger({ id: 'wl_0000000001', wake: ticket(), queueWaitMs: 1200,
      evidence: snapshotEvidence(['p_0000000001'], [candidate('p_0000000001')], 10, 160), now: at });
    expect(entry).toMatchObject({
      wakeId, botId, source: 'live', status: 'running', completeness: 'full', missing: [], openedAt: at, sealedAt: null,
      decision: null, actions: { items: [] },
    });
    expect(entry.trigger.queueWaitMs).toBe(1200);
    expect(entry.evidence.items).toHaveLength(1);
  });

  it('证据全部解析不到时开账即标 partial 并记 evidence 缺失', () => {
    const entry = buildOpenLedger({ id: 'wl_0000000001', wake: ticket(), queueWaitMs: null,
      evidence: snapshotEvidence(['p_gone'], [], 10, 160), now: at });
    expect(entry.completeness).toBe('partial');
    expect(entry.missing).toEqual(['evidence']);
  });

  it('仍在投递中的唤醒单也统一记为 running，不新增 open 状态', () => {
    const entry = buildOpenLedger({ id: 'wl_0000000001', wake: ticket({ status: 'delivering' }), queueWaitMs: null,
      evidence: { items: [], missingIds: [] }, now: at });
    expect(entry.status).toBe('running');
  });
});

describe('F01 封存', () => {
  it('有真实交账时填决定与结果，证据和动作齐全即 full', () => {
    const sealed = sealLedger({ entry: openEntry(), wake: ticket({ status: 'committed', commitId: 'c_0000000001' }),
      commit: commitFixture(), now: at + 500 });
    expect(sealed).toMatchObject({ status: 'committed', sealedAt: at + 500, completeness: 'full', missing: [] });
    expect(sealed.decision).toMatchObject({ outcome: 'progress', summary: '核实了一条公开事实' });
    expect(sealed.result.verification).toEqual({ level: 'program', notCovered: '尚未人工检查' });
    expect(sealed.result.worldChanges).toHaveLength(1);
  });

  it('没有交账时封存为 partial，缺 commit 与 result，决定为空', () => {
    const sealed = sealLedger({ entry: openEntry(), wake: ticket({ status: 'no_commit' }), commit: null, now: at + 500 });
    expect(sealed).toMatchObject({ status: 'no_commit', completeness: 'partial', decision: null });
    expect(sealed.missing).toContain('commit');
    expect(sealed.missing).toContain('result');
    expect(sealed.result.summary).toBeNull();
  });

  it('合成交账不算真实交账，决定段保持为空', () => {
    const sealed = sealLedger({ entry: openEntry(), wake: ticket({ status: 'no_commit', syntheticCommit: true }),
      commit: commitFixture({ summary: '未交账' }), now: at + 500 });
    expect(sealed.decision).toBeNull();
    expect(sealed.missing).toEqual(expect.arrayContaining(['commit', 'result']));
  });

  it('已封存的行再次封存原样返回，保证封存后不可改', () => {
    const first = sealLedger({ entry: openEntry(), wake: ticket({ status: 'committed' }), commit: commitFixture(), now: at + 1 });
    const second = sealLedger({ entry: first, wake: ticket({ status: 'error' }), commit: null, now: at + 999 });
    expect(second).toBe(first);
  });

  it('结果引用合并动作引用与交账证据，重复只留一次', () => {
    const entry = openEntry({ actions: { items: [
      { kind: 'outbox', name: 'write_file', target: null, outcome: 'ok', source: 'observed', refId: 'o_0000000001', detail: '成功', durationMs: null },
      { kind: 'hub_tool', name: 'hub_inbox_ask', target: null, outcome: 'ok', source: 'observed', refId: 'o_0000000001', detail: '成功', durationMs: null },
    ] } });
    const sealed = sealLedger({ entry, wake: ticket({ status: 'committed' }), commit: commitFixture({ evidence: ['p_0000000002', 'o_0000000001'] }), now: at + 1 });
    expect(sealed.result.refs).toEqual(['o_0000000001', 'p_0000000002']);
  });

  it('唤醒单已丢失时只能按 error 收口，并明确缺交账与结果', () => {
    const sealed = sealMissingWake(openEntry(), at + 700);
    expect(sealed).toMatchObject({ status: 'error', sealedAt: at + 700, completeness: 'partial', decision: null });
    expect(sealed.missing).toEqual(['commit', 'result']);
  });
});

describe('F01 截断', () => {
  it('单条摘要超过上限时裁剪并标记 truncated', () => {
    const entry = openEntry({ actions: { items: [
      { kind: 'hub_tool', name: 'hub_state_get', target: null, outcome: 'ok', source: 'observed', refId: null, detail: '长'.repeat(400), durationMs: 1 },
    ] } });
    const capped = capLedgerEntry(entry);
    expect(capped.truncated).toBe(true);
    expect(capped.entry.actions.items[0]!.detail.length).toBeLessThanOrEqual(V2_DEFAULTS.LEDGER_DETAIL_MAX_CHARS);
    expect(capped.entry.actions.items[0]!.detail.endsWith('…')).toBe(true);
  });

  it('动作超过 30 条时保留前 30 条并标记截断', () => {
    const items = Array.from({ length: 31 }, (_, index) => ({
      kind: 'hub_tool' as const, name: `hub_${index}`, target: null, outcome: 'ok' as const,
      source: 'observed' as const, refId: null, detail: '成功', durationMs: null,
    }));
    const capped = capLedgerEntry(openEntry({ actions: { items } }));
    expect(capped.entry.actions.items).toHaveLength(V2_DEFAULTS.LEDGER_ACTION_MAX);
    expect(capped.entry.actions.items[0]!.name).toBe('hub_0');
    expect(capped.truncated).toBe(true);
  });

  it('字节上限触发尾部丢弃后仍是合法记录，bytes 与真实序列化大小一致', () => {
    const heavy = openEntry({
      trigger: { ...openEntry().trigger, summary: '触发'.repeat(200), ownerSummary: '解释'.repeat(200) },
      evidence: { items: Array.from({ length: 10 }, (_, index) => ({
        kind: 'percept' as const, refId: `p_${index}`, summary: '证据'.repeat(100), occurredAt: at, trust: 'untrusted' as const,
      })) },
      actions: { items: Array.from({ length: 30 }, (_, index) => ({
        kind: 'hub_tool' as const, name: `hub_${index}`, target: null, outcome: 'ok' as const,
        source: 'observed' as const, refId: null, detail: '动作'.repeat(100), durationMs: index,
      })) },
    });
    const capped = capLedgerEntry(heavy, 4_096);
    expect(capped.bytes).toBeLessThanOrEqual(4_096);
    expect(Buffer.byteLength(JSON.stringify(capped.entry), 'utf8')).toBe(capped.bytes);
    expect(capped.truncated).toBe(true);
  });
});

describe('F01 回填', () => {
  const ended = (patch: Partial<WakeTicket> = {}) => ticket({ status: 'committed', endedAt: at + 60_000, startedAt: at, ...patch });

  it('找不到同一机器人五分钟内的 woke 评估时返回空', () => {
    const appraisal = { id: 'ev_0000000001', botId, at: at + 60_000, perceptIds: [], score: 0.9, threshold: 0.5,
      decision: 'woke' as const, suppressedBy: null, text: '已唤醒' };
    expect(matchWokeAppraisal([appraisal], ended())).not.toBeNull();
    expect(matchWokeAppraisal([{ ...appraisal, botId: 'b_0000000002' }], ended())).toBeNull();
    expect(matchWokeAppraisal([{ ...appraisal, decision: 'suppressed' as const, suppressedBy: 'quota' as const }], ended())).toBeNull();
    expect(matchWokeAppraisal([{ ...appraisal, at: at + 6 * 60_000 }], ended())).toBeNull();
  });

  it('同一窗口内取距离最近的一条 woke 评估', () => {
    const near = { id: 'ev_1', botId, at: at + 10_000, perceptIds: [], score: 0.7, threshold: 0.5, decision: 'woke' as const, suppressedBy: null, text: '近' };
    const far = { id: 'ev_2', botId, at: at + 120_000, perceptIds: [], score: 0.9, threshold: 0.5, decision: 'woke' as const, suppressedBy: null, text: '远' };
    expect(matchWokeAppraisal([far, near], ended())?.id).toBe('ev_1');
  });

  it('投递中或没有结束时间的唤醒单不回填', () => {
    const base = { id: 'wl_0000000001', wake: ended(), commit: null, appraisals: [], candidates: [] };
    expect(buildBackfillEntry({ ...base, wake: ended({ status: 'delivering' }) })).toBeNull();
    expect(buildBackfillEntry({ ...base, wake: ended({ endedAt: null }) })).toBeNull();
  });

  it('回填永远是 partial，没有动作流水，使用真实开始与结束时间', () => {
    const entry = buildBackfillEntry({ id: 'wl_0000000001', wake: ended(), commit: null,
      appraisals: [], candidates: [candidate('p_0000000001')] });
    expect(entry).toMatchObject({ source: 'backfill', completeness: 'partial', openedAt: at, sealedAt: at + 60_000, decision: null,
      actions: { items: [] } });
    expect(entry!.missing).toEqual(expect.arrayContaining(['actions', 'commit', 'result']));
  });

  it('有交账时复制决定与验证结果，但完整度仍为 partial', () => {
    const entry = buildBackfillEntry({ id: 'wl_0000000001', wake: ended({ commitId: 'c_0000000001' }), commit: commitFixture(),
      appraisals: [], candidates: [candidate('p_0000000001')] });
    expect(entry).toMatchObject({ source: 'backfill', completeness: 'partial' });
    expect(entry!.decision).toMatchObject({ outcome: 'progress' });
    expect(entry!.result.verification).toEqual({ level: 'program', notCovered: '尚未人工检查' });
    expect(entry!.missing).toEqual(['actions']);
  });

  it('能用当时的评估日志补齐分数、门槛和理由', () => {
    const appraisal = { id: 'ev_1', botId, at: at + 30_000, perceptIds: [], score: 0.93, threshold: 0.55,
      decision: 'woke' as const, suppressedBy: null, text: '关注项出现变化，已唤醒' };
    const entry = buildBackfillEntry({ id: 'wl_0000000001', wake: ended(), commit: null, appraisals: [appraisal],
      candidates: [candidate('p_0000000001')] });
    expect(entry!.trigger).toMatchObject({ score: 0.93, threshold: 0.55, summary: '关注项出现变化，已唤醒' });
  });

  it('证据解析不到时回填记 evidence 缺失', () => {
    const entry = buildBackfillEntry({ id: 'wl_0000000001', wake: ended({ reason: { ...ticket().reason, evidence: ['p_gone'] } }),
      commit: null, appraisals: [], candidates: [] });
    expect(entry!.missing).toEqual(expect.arrayContaining(['evidence', 'actions']));
  });
});

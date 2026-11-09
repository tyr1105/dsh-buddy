/** M02 评估解释回归：真实感知落表后核对分档、去向与中文文本，防止测试绕过主链。 */
import { describe, expect, it } from 'vitest';
import { computeSalience } from '../src/appraisal/salience.js';
import { buildCandidate } from '../src/appraisal/think.js';
import { evaluatePile } from '../src/appraisal/pile.js';
import { explainSuppression, type SuppressedBy } from '../src/appraisal/log.js';
import { recordPercept, type PerceptInput } from '../src/perception/percept.js';
import { enqueue } from '../src/scheduler/queue.js';
import { selectNext } from '../src/scheduler/select.js';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { resolveSettings } from '../src/config/defaults.js';
import { botFixture, goalFixture, watchFixture, modelFixtures } from './model-fixtures.js';
import type { QueueEntry } from '../src/model/index.js';
function setup() { const ctx = createTestContext(); ctx.store.table('bots').put(botFixture); return ctx; }
function input(ctx: ReturnType<typeof setup>, patch: Partial<PerceptInput> = {}): PerceptInput {
  return { botId: botFixture.id, watchId: null, source: 'system', kind: 'changed', summary: '资料出现变化',
    location: null, fingerprintMaterial: 'one', magnitude: 0, anomaly: false, untrusted: true, occurredAt: ctx.clock.now(), ...patch };
}

describe('M02 [4][24][28] 显著性和主链', () => {
  it.each([
    { relevance: 0.8, novelty: 1, magnitude: 1, importance: 0.75, urgency: 1, anomaly: false },
    { relevance: 0.6, novelty: 0.5, magnitude: 0.6, importance: 0.4, urgency: 1, anomaly: true },
    { relevance: 0.5, novelty: 0.5, magnitude: 1, importance: 0.5, urgency: 0.5, anomaly: true },
  ])('浮点组合数学上等于0.90时稳定 urgent %#', parts => {
    expect(computeSalience(parts)).toEqual({ salience: 0.9, tier: 'urgent' });
  });
  it('真实关注项第二次感知等于0.90，落表和候选仍是 urgent', () => {
    const ctx = setup(); ctx.store.table('watches').put({ ...watchFixture, relevance: 0.6 });
    ctx.store.table('goals').put({ ...goalFixture, importance: 0.4, status: 'active' });
    recordPercept(ctx, input(ctx, { watchId: watchFixture.id, fingerprintMaterial: 'first' }));
    const p = recordPercept(ctx, input(ctx, { watchId: watchFixture.id, magnitude: 0.6, anomaly: true }))!;
    expect(p).toMatchObject({ salience: 0.9, tier: 'urgent' });
    expect(ctx.store.table('percepts').get(p.id)?.tier).toBe('urgent');
    expect(buildCandidate(ctx, { botId: botFixture.id, kind: 'percept', score: p.salience, summary: p.summary, evidence: [p.id] }).urgent).toBe(true);
  });
  it.each([
    ['urgent', 'queued', 1, true, '等待候选评估'], ['candidate', 'queued', 1, false, '等待候选评估'],
    ['pile', 'pile', 0, false, '进入待处理堆'], ['record', 'record_only', 0, false, '只记录'],
  ] as const)('真实 recordPercept %s 落表与日志 decision=%s', (tier, decision, magnitude, anomaly, text) => {
    const ctx = setup();
    ctx.store.table('watches').put({ ...watchFixture, relevance: 0 });
    const p = recordPercept(ctx, input(ctx, { magnitude, anomaly,
      ...(tier === 'record' ? { watchId: watchFixture.id, occurredAt: ctx.clock.now() - 2 * 3_600_000 } : {}) }))!;
    expect(p.tier).toBe(tier); expect(ctx.store.table('percepts').get(p.id)?.tier).toBe(tier);
    const log = ctx.store.log('appraisals').recent(1)[0]!;
    expect(log.decision).toBe(decision); expect(log.text).toContain(`显著性 ${p.salience.toFixed(2)}`); expect(log.text).toContain(text);
  });
  it('真实 pile 感知累计触发 pile 候选，而非手工塞 tier', () => {
    const ctx = setup(); const percepts = ['a', 'b', 'c'].map(key => recordPercept(ctx, input(ctx, { fingerprintMaterial: key }))!);
    expect(percepts.every(p => p.tier === 'pile')).toBe(true);
    const c = evaluatePile(ctx, botFixture.id, ctx.clock.now())!;
    expect(c.reason.kind).toBe('pile'); expect(c.reason.evidence.sort()).toEqual(percepts.map(p => p.id).sort());
  });
});

describe('M02 [32] 每种拦截与决策都有可读解释', () => {
  const keywords: Record<SuppressedBy, string> = {
    paused: '尚未在岗', waiting_owner_same_subject: '在等你回复同一件事', waiting_owner: '有提问或审批在等你回复', cooldown: '冷却期', pace_min: '距上次思考太近',
    daily_cap: '今天已想了 6 次', bot_budget: '回合或 token 预算', quota: '额度或鉴权保护', concurrency: '等待空位',
    dispatch_gap: '距上次放行太近', startup_quiet: '启动对账', dedup: '同一指纹已经记录', retry_backoff: '等待重排时间',
  };
  it.each(Object.entries(keywords))('%s 解释含原因与实际恢复时间', (key, expected) => {
    const ctx = setup(); const entry = modelFixtures.QueueEntry.valid as QueueEntry;
    const text = explainSuppression(entry, key as SuppressedBy, ctx.clock.now() + 3_600_000, ctx.clock.now(), 'Asia/Shanghai', 6);
    expect(text).toContain(expected); expect(text).toContain('等到今天 11:00');
  });
  it('去重、门槛拒绝、排队、实际日限文本都保持各自事实', () => {
    const ctx = setup(); recordPercept(ctx, input(ctx)); recordPercept(ctx, input(ctx));
    expect(ctx.store.log('appraisals').recent(1)[0]).toMatchObject({ decision: 'record_only', suppressedBy: 'dedup', text: expect.stringContaining('不重复产生感知') });
    const low = buildCandidate(ctx, { botId: botFixture.id, kind: 'percept', score: 0.1, summary: '资料变化' });
    expect(enqueue(ctx, low)).toBeNull();
    expect(ctx.store.log('appraisals').recent(1)[0]).toMatchObject({ decision: 'suppressed', text: expect.stringContaining('思考分 0.10 低于门槛 0.60') });
    enqueue(ctx, { ...low, reason: { ...low.reason, score: 0.8 } });
    expect(ctx.store.log('appraisals').recent(1)[0]).toMatchObject({ decision: 'queued', text: expect.stringContaining('思考分 0.80，门槛 0.60，排队') });
    ctx.settings = resolveSettings({ botWindowTurnBudget: 10 }); ctx.runtime.startedAt -= 3_600_000;
    for (let i = 0; i < 6; i++) ctx.store.log('ledger').append({ id: `le_${i}`, who: botFixture.id, wakeId: null, tokens: 1, kind: 'turn', at: ctx.clock.now() });
    expect(selectNext(ctx, ctx.clock.now())).toBeNull();
    expect(ctx.store.log('appraisals').recent(1)[0]).toMatchObject({ decision: 'suppressed', suppressedBy: 'daily_cap',
      text: expect.stringContaining('今天已想了 6 次，到上限，等到明天 00:00') });
  });
});

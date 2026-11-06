/** 显著性与思考分的行为测试：覆盖独立权重、边界、证据事项键和待处理堆聚合。 */
import { describe, it, expect } from 'vitest';
import { computeSalience, tierFor } from '../src/appraisal/salience.js';
import { agendaUrgency, buildCandidate, fatigueFor, thinkScore } from '../src/appraisal/think.js';
import { evaluatePile } from '../src/appraisal/pile.js';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { resolveSettings } from '../src/config/defaults.js';
import { AgendaItemSchema, PerceptSchema, InboxItemSchema, WakeTicketSchema } from '../src/model/index.js';
import { botFixture, modelFixtures, id } from './model-fixtures.js';

const zero = { relevance: 0, novelty: 0, magnitude: 0, importance: 0, urgency: 0, anomaly: false };
function setup() { const ctx = createTestContext(); ctx.store.table('bots').put(botFixture); return ctx; }

describe('显著性公式', () => {
  it.each([['relevance', 0.25], ['novelty', 0.20], ['magnitude', 0.20], ['importance', 0.20], ['urgency', 0.15]] as const)('%s 独立权重', (key, weight) => {
    expect(computeSalience({ ...zero, [key]: 1 }).salience).toBeCloseTo(weight);
  });
  it('异常额外加 0.3，未异常不加分，合计封顶 1', () => {
    expect(computeSalience(zero).salience).toBe(0);
    expect(computeSalience({ ...zero, anomaly: true }).salience).toBeCloseTo(0.3);
    expect(computeSalience({ relevance: 1, novelty: 1, magnitude: 1, importance: 1, urgency: 1, anomaly: true })).toEqual({ salience: 1, tier: 'urgent' });
  });
  it.each([[0.39, 'record'], [0.40, 'pile'], [0.69, 'pile'], [0.70, 'candidate'], [0.89, 'candidate'], [0.90, 'urgent']] as const)('分档边界 %s', (score, tier) => {
    expect(tierFor(score)).toBe(tier);
    expect(computeSalience({ relevance: score, novelty: score, magnitude: score, importance: score, urgency: score, anomaly: false }).salience).toBeCloseTo(score);
  });
  it('权重和分档使用配置覆盖', () => {
    const settings = resolveSettings({ c02: { salienceWeights: { relevance: 0.8 } }, salienceUrgent: 0.8 });
    expect(computeSalience({ ...zero, relevance: 1 }, settings)).toEqual({ salience: 0.8, tier: 'urgent' });
  });
  it('非法维度指明字段', () => { expect(() => computeSalience({ ...zero, urgency: NaN })).toThrow('urgency'); });
});

describe('候选与门槛', () => {
  it('思考分取各组最大值，空组为零', () => { expect(thinkScore([0.4, 0.9], 0.7, [0.8])).toBe(0.9); expect(thinkScore()).toBe(0); });
  it('拒绝越界思考分', () => { expect(() => thinkScore(1.1)).toThrow('思考分'); });
  it.each([[true, 0, 0.95], [false, 0, 0.85], [false, 3600000, 0.70], [true, 3600001, 0]])('议程紧迫度 %s/%s', (toOwner, offset, score) => {
    const item = AgendaItemSchema.parse(modelFixtures.AgendaItem.valid);
    expect(agendaUrgency({ ...item, toOwner, dueAt: 10000 + Number(offset) }, 10000)).toBe(score);
  });
  it('关闭或没有时间的议程不催', () => {
    const item = AgendaItemSchema.parse(modelFixtures.AgendaItem.valid);
    expect(agendaUrgency(item, 10000)).toBe(0);
    expect(agendaUrgency({ ...item, status: 'done', dueAt: 0 }, 10000)).toBe(0);
  });
  it.each([
    [{ kind: 'percept', watchId: 'watch-a' }, 'watch:watch-a'],
    [{ kind: 'percept', source: 'http', perceptKind: 'changed' }, 'src:http:changed'],
    [{ kind: 'agenda_due', agendaId: 'a-one' }, 'agenda:a-one'],
    [{ kind: 'drive', driveName: 'stagnation', goalId: 'g-one' }, 'drive:stagnation:g-one'],
    [{ kind: 'drive', driveName: 'waiting' }, 'drive:waiting'],
    [{ kind: 'owner_message', messageId: 'm-one' }, 'owner:m-one'],
  ] as const)('按来源构造事项键 %#', (input, expected) => {
    const ctx = setup();
    expect(buildCandidate(ctx, { botId: botFixture.id, score: 0.8, summary: '有理由', ...input }).subjectKey).toBe(expected);
  });
  it('提问回复沿用收件箱事项，主人自动提到最高优先级', () => {
    const ctx = setup(); const inbox = InboxItemSchema.parse(modelFixtures.InboxItem.valid);
    ctx.store.table('inbox').put({ ...inbox, subjectKey: 'watch:one' });
    expect(buildCandidate(ctx, { botId: botFixture.id, kind: 'inbox_reply', score: 0.95, summary: '已答复', inboxId: inbox.id }).subjectKey).toBe('watch:one');
    expect(buildCandidate(ctx, { botId: botFixture.id, kind: 'owner_message', score: 1, summary: '主人消息' })).toMatchObject({ ownerInitiated: true, priority: 100, urgent: true });
  });
  it('由感知证据恢复 watch 事项键，证据去重', () => {
    const ctx = setup(); const percept = PerceptSchema.parse(modelFixtures.Percept.valid); ctx.store.table('percepts').put(percept);
    const c = buildCandidate(ctx, { botId: botFixture.id, kind: 'percept', score: 0.8, summary: '变化', evidence: [percept.id, percept.id] });
    expect(c.subjectKey).toBe(`watch:${percept.watchId}`); expect(c.reason.evidence).toEqual([percept.id]);
  });
  it('疲劳按自主回合预算，主人发起不计，零预算为满疲劳', () => {
    const ctx = setup(); const now = ctx.clock.now();
    const wake = { ...WakeTicketSchema.parse(modelFixtures.WakeTicket.valid), ownerInitiated: true }; ctx.store.table('wakes').put(wake);
    for (let i = 0; i < 3; i++) ctx.store.log('ledger').append({ id: `le_${i}`, who: botFixture.id, wakeId: null, tokens: 10, kind: 'turn', at: now });
    ctx.store.log('ledger').append({ id: 'le_owner', who: botFixture.id, wakeId: wake.id, tokens: 10, kind: 'turn', at: now });
    expect(fatigueFor(ctx, botFixture.id, now)).toBe(0.5);
    expect(buildCandidate(ctx, { botId: botFixture.id, kind: 'percept', score: 0.8, summary: '变化' }).reason.threshold).toBeCloseTo(0.75);
    ctx.settings.botDailyTurnBudget = 0; expect(fatigueFor(ctx, botFixture.id, now)).toBe(1);
  });
  it('候选输入无效及机器人不存在时明确拒绝', () => {
    const ctx = setup();
    expect(() => buildCandidate(ctx, { botId: botFixture.id, kind: 'percept', score: 5, summary: '变化' })).toThrow('score');
    expect(() => buildCandidate(ctx, { botId: 'missing', kind: 'percept', score: 0.8, summary: '变化' })).toThrow('机器人不存在');
  });
});

describe('待处理堆', () => {
  it.each([[0.99, false], [1.0, true], [1.01, true]] as const)('合计 %s 的边界', (sum, expected) => {
    const ctx = setup(); const p = PerceptSchema.parse(modelFixtures.Percept.valid);
    for (let i = 0; i < 2; i++) ctx.store.table('percepts').put({ ...p, id: `p_${i}`, createdAt: ctx.clock.now(), tier: 'pile', salience: sum / 2 });
    const result = evaluatePile(ctx, botFixture.id, ctx.clock.now());
    expect(Boolean(result)).toBe(expected); if (result) expect(result.reason).toMatchObject({ kind: 'pile', score: 0.7, evidence: ['p_0', 'p_1'] });
  });
  it.each([[3, 0.75], [4, 0.8], [10, 0.85]])('%s 条堆分数 %s', (count, score) => {
    const ctx = setup(); const p = PerceptSchema.parse(modelFixtures.Percept.valid);
    for (let i = 0; i < count; i++) ctx.store.table('percepts').put({ ...p, id: `p_${i}`, createdAt: ctx.clock.now(), tier: 'pile', salience: 0.5 });
    expect(evaluatePile(ctx, botFixture.id, ctx.clock.now())?.reason.score).toBeCloseTo(score);
  });
  it('忽略已消费、其他机器人、其他分档与未来感知', () => {
    const ctx = setup(); const p = PerceptSchema.parse(modelFixtures.Percept.valid);
    const variations = [{ consumedByWake: id('w') }, { botId: 'another' }, { tier: 'record' as const }, { createdAt: ctx.clock.now() + 1 }];
    variations.forEach((v, i) => ctx.store.table('percepts').put({ ...p, id: `p_${i}`, tier: 'pile', salience: 0.6, ...v }));
    expect(evaluatePile(ctx, botFixture.id, ctx.clock.now())).toBeNull();
  });
});

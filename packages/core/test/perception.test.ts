/** 验证感知标准化、特例分数、指纹窗口、期望和会话入口；用假时钟明确每个时间边界。 */
import { describe, expect, it } from 'vitest';
import { recordPercept, type PerceptInput } from '../src/perception/percept.js';
import { recordOwnerMessage, recordPeerMessage, recordHandoff, recordInboxReply, recordApprovalDecision, recordDowntime } from '../src/perception/sources.js';
import { checkExpectations } from '../src/perception/expectations.js';
import { onExternalSessionEvent } from '../src/perception/sessions.js';
import { PerceptSchema } from '../src/model/perception.js';
import { botFixture, goalFixture, watchFixture } from './model-fixtures.js';
import { perceptionContext, hour, minute } from './perception-fixtures.js';

function input(ctx: ReturnType<typeof perceptionContext>, patch: Partial<PerceptInput> = {}): PerceptInput {
  return { botId: botFixture.id, watchId: null, source: 'file', kind: 'changed', summary: '文件有新内容', location: '/hub/file',
    fingerprintMaterial: '第一次', magnitude: 0.5, anomaly: false, untrusted: true, occurredAt: ctx.clock.now(), ...patch };
}

describe('感知评分和去重', () => {
  it.each([
    ['主人', recordOwnerMessage, 1], ['同伴', recordPeerMessage, 0.7], ['交接', recordHandoff, 0.7],
    ['收件箱回复', recordInboxReply, 0.95], ['审批结果', recordApprovalDecision, 0.95], ['停机', recordDowntime, 0.5],
  ] as const)('%s使用特例分数', (_name, create, score) => {
    const ctx = perceptionContext();
    const percept = create(ctx, { botId: botFixture.id, id: 'event-1', summary: '有新进展', at: ctx.clock.now() });
    expect(percept?.salience).toBeCloseTo(score); expect(PerceptSchema.safeParse(percept).success).toBe(true);
  });
  it('同伴原分更低时不人为抬高到 0.70', () => {
    const ctx = perceptionContext();
    const p = recordPercept(ctx, input(ctx, { source: 'peer', kind: 'peer_message', magnitude: 0, occurredAt: ctx.clock.now() - 2 * hour }));
    expect(p?.salience).toBeCloseTo(0.415);
  });
  it('同机器人同指纹在 24 小时内只记去重日志', () => {
    const ctx = perceptionContext(); recordPercept(ctx, input(ctx)); ctx.clock.advance(24 * hour - 1);
    expect(recordPercept(ctx, input(ctx))).toBeNull(); expect(ctx.store.table('percepts').count()).toBe(1);
    expect(ctx.store.log('appraisals').recent(1)[0]).toMatchObject({ decision: 'record_only', suppressedBy: 'dedup' });
  });
  it('满 24 小时允许相同指纹重新产生感知', () => {
    const ctx = perceptionContext(); recordPercept(ctx, input(ctx)); ctx.clock.advance(24 * hour);
    expect(recordPercept(ctx, input(ctx))).not.toBeNull();
  });
  it('不同机器人不共享去重范围', () => {
    const ctx = perceptionContext(); recordPercept(ctx, input(ctx));
    ctx.store.table('bots').put({ ...botFixture, id: 'b_0000000002' });
    expect(recordPercept(ctx, input(ctx, { botId: 'b_0000000002' }))).not.toBeNull();
  });
  it('同一关注项 1 小时内降低新奇度，满 1 小时恢复', () => {
    const ctx = perceptionContext({}); recordPercept(ctx, input(ctx, { watchId: watchFixture.id }));
    ctx.clock.advance(hour - 1);
    expect(recordPercept(ctx, input(ctx, { watchId: watchFixture.id, fingerprintMaterial: '第二次' }))?.novelty).toBe(0.5);
    ctx.clock.advance(hour);
    expect(recordPercept(ctx, input(ctx, { watchId: watchFixture.id, fingerprintMaterial: '第三次' }))?.novelty).toBe(1);
  });
  it.each([['重要', 0.8], ['无关', 0.4], ['/重要/', 0.8], ['/[/', 0.4]])('filter=%s 的相关度是 %s', (filter, expected) => {
    const ctx = perceptionContext({ filter });
    expect(recordPercept(ctx, input(ctx, { watchId: watchFixture.id, summary: '重要消息' }))?.relevance).toBe(expected);
  });
  it('目标重要度取当前目标最大值', () => {
    const ctx = perceptionContext({});
    ctx.store.table('goals').put(goalFixture);
    ctx.store.table('goals').put({ ...goalFixture, id: 'g_0000000002', importance: 0.9 });
    expect(recordPercept(ctx, input(ctx, { watchId: watchFixture.id }))?.importance).toBe(0.9);
  });
  it('明确引用目标时使用被引用目标的重要度', () => {
    const ctx = perceptionContext({ why: `关注 ${goalFixture.id}` });
    ctx.store.table('goals').put({ ...goalFixture, importance: 0.4 });
    ctx.store.table('goals').put({ ...goalFixture, id: 'g_0000000002', importance: 0.9 });
    expect(recordPercept(ctx, input(ctx, { watchId: watchFixture.id }))?.importance).toBe(0.4);
  });
  it.each([[10 * minute, 1], [10 * minute + 1, 0.5], [hour, 0.5], [hour + 1, 0.2]])('事件年龄 %s 的紧迫度为 %s', (age, urgency) => {
    const ctx = perceptionContext(); expect(recordPercept(ctx, input(ctx, { occurredAt: ctx.clock.now() - age }))?.urgency).toBe(urgency);
  });
  it('期望落空无论年龄紧迫度都为 1', () => {
    const ctx = perceptionContext(); expect(recordPercept(ctx, input(ctx, { kind: 'expectation_missed', occurredAt: ctx.clock.now() - 2 * hour }))?.urgency).toBe(1);
  });
  it('摘要截断 500 字且日志落表后通知视图', () => {
    const ctx = perceptionContext(); const p = recordPercept(ctx, input(ctx, { summary: '中'.repeat(600) }));
    expect(p?.summary).toHaveLength(500); expect(ctx.store.log('appraisals').all()).toHaveLength(1); expect(ctx.events).toHaveLength(1);
  });
  it('高显著性感知复位无变化退避', () => {
    const ctx = perceptionContext(); ctx.store.table('bots').patch(botFixture.id, { noChangeStreak: 5 });
    recordOwnerMessage(ctx, { botId: botFixture.id, id: 'm-1', summary: '继续处理', at: ctx.clock.now() });
    expect(ctx.store.table('bots').get(botFixture.id)?.noChangeStreak).toBe(0);
  });
  it('低显著性感知保留退避', () => {
    const ctx = perceptionContext(); ctx.store.table('bots').patch(botFixture.id, { noChangeStreak: 5 }); recordPercept(ctx, input(ctx));
    expect(ctx.store.table('bots').get(botFixture.id)?.noChangeStreak).toBe(5);
  });
  it('非法输入给中文错误并拒绝落表', () => {
    const ctx = perceptionContext(); expect(() => recordPercept(ctx, input(ctx, { magnitude: -1 }))).toThrow(/magnitude/);
    expect(ctx.store.table('percepts').count()).toBe(0);
  });
  it('关注项不能跨机器人引用', () => {
    const ctx = perceptionContext({ botId: 'b_0000000002' }); expect(() => recordPercept(ctx, input(ctx, { watchId: watchFixture.id }))).toThrow(/不属于/);
  });
});

describe('期望与会话事件', () => {
  const expectation = { text: '应当有新日志', everyMs: hour, byLocalTime: null, weekdays: null, lastSatisfiedAt: null, lastMissedAt: null };
  it('everyMs 恰好到期不报，超过后落空，同日只报一次', () => {
    const ctx = perceptionContext({ expectation }); ctx.clock.advance(hour);
    expect(checkExpectations(ctx, ctx.clock.now())).toEqual([]); ctx.clock.advance(1);
    expect(checkExpectations(ctx, ctx.clock.now())).toHaveLength(1); expect(checkExpectations(ctx, ctx.clock.now())).toEqual([]);
    expect(ctx.store.table('percepts').list()[0]).toMatchObject({ anomaly: true, urgency: 1, kind: 'expectation_missed' });
  });
  it('有 lastSatisfiedAt 时从满足时刻算起', () => {
    const ctx = perceptionContext({ expectation }); ctx.clock.advance(2 * hour);
    ctx.store.table('watches').patch(watchFixture.id, { expectation: { ...expectation, lastSatisfiedAt: ctx.clock.now() } });
    expect(checkExpectations(ctx, ctx.clock.now())).toEqual([]);
  });
  it('byLocalTime 当天未满足则报、次日可再次报', () => {
    const ctx = perceptionContext({ expectation: { ...expectation, everyMs: null, byLocalTime: '09:00' } });
    // 本例验证已生效期望的日内去重，创建时间必须早于 09:00 的首次期限。
    ctx.store.table('watches').patch(watchFixture.id, { createdAt: ctx.clock.now() - 2 * hour });
    expect(checkExpectations(ctx, ctx.clock.now())).toHaveLength(1); expect(checkExpectations(ctx, ctx.clock.now())).toEqual([]);
    ctx.clock.advance(24 * hour); expect(checkExpectations(ctx, ctx.clock.now())).toHaveLength(1);
  });
  it('byLocalTime 尚未到点或当天满足过则不报', () => {
    const ctx = perceptionContext({ expectation: { ...expectation, everyMs: null, byLocalTime: '11:00' } });
    // 保留“当天已满足”的独立分支，不让新生效保护提前跳过该断言。
    ctx.store.table('watches').patch(watchFixture.id, { createdAt: ctx.clock.now() - 2 * hour });
    expect(checkExpectations(ctx, ctx.clock.now())).toEqual([]);
    ctx.store.table('watches').patch(watchFixture.id, { expectation: { ...expectation, everyMs: null, byLocalTime: '09:00', weekdays: null, lastSatisfiedAt: ctx.clock.now() - hour } });
    expect(checkExpectations(ctx, ctx.clock.now())).toEqual([]);
  });
  it('暂停关注项不检查期望', () => {
    const ctx = perceptionContext({ status: 'paused', expectation }); ctx.clock.advance(2 * hour); expect(checkExpectations(ctx, ctx.clock.now())).toEqual([]);
  });
  it.each([['finished', false, 'session_finished'], ['error', true, 'session_error']] as const)('会话 %s 生成匹配感知', (type, anomaly, kind) => {
    const ctx = perceptionContext({ kind: 'session', target: '研究' });
    expect(onExternalSessionEvent(ctx, { type, sessionId: 's1', title: '研究公开资料', at: ctx.clock.now(), summary: '结束' })[0]).toMatchObject({ anomaly, kind });
  });
  it('会话标题不匹配或暂停时不产生感知', () => {
    const ctx = perceptionContext({ kind: 'session', target: '研究' });
    const e = { type: 'finished' as const, sessionId: 's1', title: '其他任务', at: ctx.clock.now(), summary: '结束' };
    expect(onExternalSessionEvent(ctx, e)).toEqual([]);
    ctx.store.table('watches').patch(watchFixture.id, { target: 'any', status: 'paused' }); expect(onExternalSessionEvent(ctx, e)).toEqual([]);
  });
  it('any 关注项接收所有标题，同一事件仍去重', () => {
    const ctx = perceptionContext({ kind: 'session', target: 'any' });
    const e = { type: 'finished' as const, sessionId: 's1', title: '其他任务', at: ctx.clock.now(), summary: '结束' };
    expect(onExternalSessionEvent(ctx, e)).toHaveLength(1); expect(onExternalSessionEvent(ctx, e)).toEqual([]);
  });
});

// 配置窗口与实时账本的回归：缓存内驱状态不能替代本次感知发生时的预算事实。
describe('实时门槛和独立新奇度窗口', () => {
  it('没有 DriveState 但今天已用 3/6 回合时日志门槛为 0.75', () => {
    const ctx = perceptionContext();
    for (let i = 1; i <= 3; i++) ctx.store.log('ledger').append({ id: `le_000000000${i}`, who: botFixture.id,
      wakeId: null, tokens: 1000, kind: 'turn', at: ctx.clock.now() });
    expect(ctx.store.table('drives').get(botFixture.id)).toBeNull();
    recordPercept(ctx, input(ctx));
    expect(ctx.store.log('appraisals').recent(1)[0]?.threshold).toBeCloseTo(0.75);
  });
  it('去重窗口小于新奇度窗口时仍按同关注项 1 小时判断新奇度', () => {
    const ctx = perceptionContext({}); ctx.settings.dedupWindowMs = 10 * minute;
    recordPercept(ctx, input(ctx, { watchId: watchFixture.id })); ctx.clock.advance(30 * minute);
    const percept = recordPercept(ctx, input(ctx, { watchId: watchFixture.id }));
    expect(percept).not.toBeNull(); expect(percept?.novelty).toBe(0.5);
    ctx.clock.advance(hour);
    expect(recordPercept(ctx, input(ctx, { watchId: watchFixture.id }))?.novelty).toBe(1);
  });
});

/** 九道闸的正反边界与快照集成：测试只推进假时钟，不投递任何真实会话。 */
import { describe, it, expect } from 'vitest';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { buildCandidate } from '../src/appraisal/think.js';
import { enqueue } from '../src/scheduler/queue.js';
import { buildSnapshot, evaluateGates } from '../src/scheduler/gates.js';
import { selectNext } from '../src/scheduler/select.js';
import { botFixture, modelFixtures } from './model-fixtures.js';
import { InboxItemSchema, PerceptSchema, WakeTicketSchema } from '../src/model/index.js';
import type { Bot, QueueEntry, QuotaState } from '../src/model/index.js';
import type { GateSnapshot } from '../src/scheduler/gates.js';

const minute = 60_000;
function setup() {
  const ctx = createTestContext(); ctx.store.table('bots').put(botFixture);
  const now = ctx.clock.now(); ctx.runtime.startedAt = now - 10 * minute;
  const entry = enqueue(ctx, buildCandidate(ctx, { botId: botFixture.id, kind: 'percept', score: 0.8, summary: '资料变化', subjectKey: 'watch:one' }))!;
  const snapshot = buildSnapshot(ctx, botFixture.id, now);
  return { ctx, now, entry, snapshot };
}
function bot(snapshot: GateSnapshot, patch: Partial<Bot>): GateSnapshot { return { ...snapshot, bot: { ...snapshot.bot!, ...patch } }; }
function quota(snapshot: GateSnapshot, light: QuotaState['light'], extra: Partial<QuotaState> = {}): GateSnapshot { return { ...snapshot, quota: { ...snapshot.quota, light, ...extra } }; }

describe('九道闸逐条正反边界', () => {
  it.each(['draft', 'paused', 'retired', 'quarantined'] as const)('1 生命周期 %s 丢弃，即使主人发起', lifecycle => {
    const { ctx, now, entry, snapshot } = setup();
    expect(evaluateGates({ ...entry, ownerInitiated: true }, bot(snapshot, { lifecycle }), now, ctx.settings)).toMatchObject({ pass: false, by: 'paused', drop: true });
  });
  it.each(['active', 'probation'] as const)('1 %s 放行', lifecycle => {
    const { ctx, now, entry, snapshot } = setup(); expect(evaluateGates(entry, bot(snapshot, { lifecycle }), now, ctx.settings)).toEqual({ pass: true });
  });
  it('2 正在思考拦截，结束后放行', () => {
    const { ctx, now, entry, snapshot } = setup();
    expect(evaluateGates(entry, { ...snapshot, running: true }, now, ctx.settings)).toMatchObject({ by: 'concurrency', drop: false });
    expect(evaluateGates(entry, snapshot, now, ctx.settings)).toEqual({ pass: true });
  });
  it('3 等待同事项丢弃；别的事项被全局等待拦住但不丢弃', () => {
    const { ctx, now, entry, snapshot } = setup();
    const s = { ...snapshot, openQuestionSubjects: new Set([entry.subjectKey]), openOwnerAskCount: 1 };
    expect(evaluateGates(entry, s, now, ctx.settings)).toMatchObject({ by: 'waiting_owner_same_subject', drop: true });
    expect(evaluateGates({ ...entry, subjectKey: 'other' }, s, now, ctx.settings)).toMatchObject({ by: 'waiting_owner', drop: false, until: null });
  });
  it('3 等待主人时报告最早到期时间，候选保留，紧急与只读复盘放行', () => {
    const { ctx, now, entry, snapshot } = setup();
    const s = { ...snapshot, openOwnerAskCount: 1, openOwnerAskUntil: now + 2 * minute };
    // 恢复由「答复后重建快照」决定，快照里的 until 只用于告诉主人何时会再判断。
    expect(evaluateGates(entry, s, now, ctx.settings)).toMatchObject({ by: 'waiting_owner', until: now + 2 * minute, drop: false });
    expect(evaluateGates({ ...entry, urgent: true }, s, now, ctx.settings)).toEqual({ pass: true });
    expect(evaluateGates({ ...entry, variant: 'reflection' }, s, now, ctx.settings)).toEqual({ pass: true });
  });
  it.each(['owner_message', 'inbox_reply', 'approval_decided'] as const)('3 等待主人时 %s 仍可进入', kind => {
    const { ctx, now, entry, snapshot } = setup();
    expect(evaluateGates({ ...entry, reason: { ...entry.reason, kind } }, { ...snapshot, openOwnerAskCount: 1 }, now, ctx.settings)).toEqual({ pass: true });
  });
  it('4 冷却结束的精确边界', () => {
    const { ctx, now, entry, snapshot } = setup(); const s = { ...snapshot, subjectWakeAt: new Map([[entry.subjectKey, now - ctx.settings.subjectCooldownMs + 1]]) };
    expect(evaluateGates(entry, s, now, ctx.settings)).toMatchObject({ by: 'cooldown', until: now + 1 });
    expect(evaluateGates(entry, s, now + 1, ctx.settings)).toEqual({ pass: true });
  });
  it.each(['owner_message', 'approval_decided'] as const)('4 %s 豁免冷却', kind => {
    const { ctx, now, entry, snapshot } = setup();
    expect(evaluateGates({ ...entry, reason: { ...entry.reason, kind } }, { ...snapshot, subjectWakeAt: new Map([[entry.subjectKey, now]]) }, now, ctx.settings)).toEqual({ pass: true });
  });
  it('4 urgent 豁免冷却', () => {
    const { ctx, now, entry, snapshot } = setup(); expect(evaluateGates({ ...entry, urgent: true }, { ...snapshot, subjectWakeAt: new Map([[entry.subjectKey, now]]) }, now, ctx.settings)).toEqual({ pass: true });
  });
  it('5 最短间隔前一毫秒拦截，到点放行', () => {
    const { ctx, now, entry, snapshot } = setup(); const s = bot(snapshot, { lastThinkAt: now - 60 * minute + 1 });
    expect(evaluateGates(entry, s, now, ctx.settings)).toMatchObject({ by: 'pace_min', until: now + 1 });
    expect(evaluateGates(entry, s, now + 1, ctx.settings)).toEqual({ pass: true });
  });
  it.each(['urgent', 'owner', 'approval'] as const)('5 %s 豁免最短间隔', exemption => {
    const { ctx, now, entry, snapshot } = setup(); const e = { ...entry, urgent: exemption === 'urgent', ownerInitiated: exemption === 'owner', reason: { ...entry.reason, kind: exemption === 'approval' ? 'approval_decided' as const : 'percept' as const } };
    expect(evaluateGates(e, bot(snapshot, { lastThinkAt: now }), now, ctx.settings)).toEqual({ pass: true });
  });
  it('6 每日等级上限在边界拦截，主人回合豁免', () => {
    const { ctx, now, entry, snapshot } = setup(); const s = { ...bot(snapshot, { autonomy: 'L0' }), todayTurns: 2 };
    expect(evaluateGates(entry, s, now, ctx.settings)).toMatchObject({ by: 'daily_cap' });
    expect(evaluateGates(entry, { ...s, todayTurns: 1 }, now, ctx.settings)).toEqual({ pass: true });
    expect(evaluateGates({ ...entry, ownerInitiated: true }, s, now, ctx.settings)).toEqual({ pass: true });
  });
  it.each([{ todayTurns: 6 }, { todayTokens: 250000 }, { windowTurns: 3 }])('6 机器人预算 %# 拦截且低于边界放行', usage => {
    const { ctx, now, entry, snapshot } = setup(); const s = { ...bot(snapshot, { autonomy: 'L3' }), ...usage };
    expect(evaluateGates(entry, s, now, ctx.settings)).toMatchObject({ by: 'bot_budget' });
    expect(evaluateGates(entry, { ...s, todayTurns: 5, todayTokens: 249999, windowTurns: 2 }, now, ctx.settings)).toEqual({ pass: true });
  });
  it('6 urgent 不豁免预算，试岗预算减半', () => {
    const { ctx, now, entry, snapshot } = setup();
    expect(evaluateGates({ ...entry, urgent: true }, { ...bot(snapshot, { lifecycle: 'probation' }), todayTurns: 3 }, now, ctx.settings)).toMatchObject({ by: 'bot_budget' });
  });
  it('C05 行为探针：同一快照下改每日回合预算，拦截改放行；token 预算同口径（配置改了行为必须变）', () => {
    const { ctx, now, entry, snapshot } = setup();
    // 默认每队友每日 6 回合：正好到边界被 bot_budget 拦。
    const atCap = { ...bot(snapshot, { autonomy: 'L3' }), todayTurns: 6, todayTokens: 0, windowTurns: 0 };
    expect(evaluateGates(entry, atCap, now, ctx.settings)).toMatchObject({ by: 'bot_budget' });
    // 主人在设置里把每日回合预算调到 8：同一场景立即放行（闸门每次读当前 Settings，无需重启）。
    const looserTurns = { ...ctx.settings, botDailyTurnBudget: 8 };
    expect(evaluateGates(entry, atCap, now, looserTurns)).toEqual({ pass: true });
    // 反过来收紧到 5：原本放得过的用量也被拦，证明不是改了个没人读的数字。
    const tighterTurns = { ...ctx.settings, botDailyTurnBudget: 5 };
    expect(evaluateGates(entry, { ...atCap, todayTurns: 5 }, now, tighterTurns)).toMatchObject({ by: 'bot_budget' });
    // 每日 token 预算：到 25 万默认边界被拦，调到 40 万放行，且回合余量不变（证明是 token 单独生效）。
    const tokenCap = { ...bot(snapshot, { autonomy: 'L3' }), todayTurns: 0, todayTokens: ctx.settings.botDailyTokenBudget, windowTurns: 0 };
    expect(evaluateGates(entry, tokenCap, now, ctx.settings)).toMatchObject({ by: 'bot_budget' });
    const looserTokens = { ...ctx.settings, botDailyTokenBudget: 400_000 };
    expect(evaluateGates(entry, tokenCap, now, looserTokens)).toEqual({ pass: true });
  });
  it('7 yellow 非紧急节奏加倍，到点恢复；urgent 越过', () => {
    const { ctx, now, entry, snapshot } = setup(); const s = quota(bot(snapshot, { lastThinkAt: now - 60 * minute }), 'yellow');
    expect(evaluateGates(entry, s, now, ctx.settings)).toMatchObject({ by: 'pace_min', until: now + 60 * minute });
    expect(evaluateGates(entry, s, now + 60 * minute, ctx.settings)).toEqual({ pass: true });
    expect(evaluateGates({ ...entry, urgent: true }, s, now, ctx.settings)).toEqual({ pass: true });
  });
  it('7 orange 仅紧急与主人可过，red 主人也等', () => {
    const { ctx, now, entry, snapshot } = setup(); const s = quota(snapshot, 'orange');
    expect(evaluateGates(entry, s, now, ctx.settings)).toMatchObject({ by: 'quota' });
    expect(evaluateGates({ ...entry, urgent: true }, s, now, ctx.settings)).toEqual({ pass: true });
    expect(evaluateGates({ ...entry, ownerInitiated: true }, s, now, ctx.settings)).toEqual({ pass: true });
    expect(evaluateGates({ ...entry, ownerInitiated: true }, quota(snapshot, 'red'), now, ctx.settings)).toMatchObject({ by: 'quota' });
  });
  it('7 探针仍受预算与鉴权限制', () => {
    const { ctx, now, entry, snapshot } = setup(); const s = quota(snapshot, 'red', { probeAllowed: true });
    expect(evaluateGates(entry, s, now, ctx.settings)).toEqual({ pass: true });
    expect(evaluateGates(entry, { ...s, authBlocked: true }, now, ctx.settings)).toMatchObject({ by: 'quota' });
    expect(evaluateGates(entry, { ...s, todayTurns: 6 }, now, ctx.settings)).toMatchObject({ by: 'daily_cap' });
  });
  it('8 启动静默三分钟，主人豁免', () => {
    const { ctx, now, entry, snapshot } = setup(); const s = { ...snapshot, startedAt: now };
    expect(evaluateGates(entry, s, now, ctx.settings)).toMatchObject({ by: 'startup_quiet' });
    expect(evaluateGates(entry, s, now + 3 * minute, ctx.settings)).toEqual({ pass: true });
    expect(evaluateGates({ ...entry, ownerInitiated: true }, s, now, ctx.settings)).toEqual({ pass: true });
  });
  it('8 两次放行间隔九十秒，主人豁免', () => {
    const { ctx, now, entry, snapshot } = setup(); const s = { ...snapshot, lastDispatchAt: now };
    expect(evaluateGates(entry, s, now + 89999, ctx.settings)).toMatchObject({ by: 'dispatch_gap' });
    expect(evaluateGates(entry, s, now + 90000, ctx.settings)).toEqual({ pass: true });
    expect(evaluateGates({ ...entry, ownerInitiated: true }, s, now, ctx.settings)).toEqual({ pass: true });
  });
  it('8 并发两名，主人活跃降到一名，十分钟后恢复', () => {
    const { ctx, now, entry, snapshot } = setup();
    expect(evaluateGates(entry, { ...snapshot, runningCount: 2 }, now, ctx.settings)).toMatchObject({ by: 'concurrency' });
    expect(evaluateGates(entry, { ...snapshot, runningCount: 1 }, now, ctx.settings)).toEqual({ pass: true });
    const s = { ...snapshot, runningCount: 1, ownerActiveAt: now };
    expect(evaluateGates({ ...entry, ownerInitiated: true }, s, now, ctx.settings)).toMatchObject({ by: 'concurrency' });
    expect(evaluateGates(entry, s, now + 10 * minute, ctx.settings)).toEqual({ pass: true });
  });
  it('9 重排与 notBefore 都必须到点，主人也遵守', () => {
    const { ctx, now, entry, snapshot } = setup(); const s = { ...snapshot, retryAt: now + 1 };
    expect(evaluateGates(entry, s, now, ctx.settings)).toMatchObject({ by: 'retry_backoff' });
    expect(evaluateGates(entry, s, now + 1, ctx.settings)).toEqual({ pass: true });
    expect(evaluateGates({ ...entry, ownerInitiated: true, notBefore: now + 1 }, snapshot, now, ctx.settings)).toMatchObject({ by: 'retry_backoff' });
  });
  it('多个闸门同时存在时只报告最早的闸', () => {
    const { ctx, now, entry, snapshot } = setup(); const s = { ...bot(snapshot, { lifecycle: 'paused' }), running: true, authBlocked: true };
    expect(evaluateGates(entry, s, now, ctx.settings)).toMatchObject({ by: 'paused' });
    expect(evaluateGates(entry, bot(s, { lifecycle: 'active' }), now, ctx.settings)).toMatchObject({ by: 'concurrency' });
  });
});

describe('快照与实际选择', () => {
  it('合并感知的每个事项都恢复冷却，包含显式主体', () => {
    const { ctx, now } = setup(); const percept = PerceptSchema.parse(modelFixtures.Percept.valid);
    ctx.store.table('percepts').put({ ...percept, watchId: 'two' });
    ctx.store.table('wakes').put({ ...WakeTicketSchema.parse(modelFixtures.WakeTicket.valid), subjectKey: 'watch:one', status: 'committed', startedAt: now - 1,
      reason: { kind: 'percept', score: 0.8, threshold: 0.6, summary: '变化', evidence: [percept.id] } });
    expect([...buildSnapshot(ctx, botFixture.id, now).subjectWakeAt.keys()]).toEqual(['watch:one', 'watch:two']);
  });
  it('已有会话投递失败也不产生冷却，delivering 占并发位', () => {
    const { ctx, now } = setup(); const wake = WakeTicketSchema.parse(modelFixtures.WakeTicket.valid);
    ctx.store.table('wakes').put({ ...wake, sessionId: 'existing-session', dispatchedAt: null, status: 'error', startedAt: now - 1 });
    expect(buildSnapshot(ctx, botFixture.id, now).subjectWakeAt.size).toBe(0);
    ctx.store.table('wakes').patch(wake.id, { status: 'delivering' });
    expect(buildSnapshot(ctx, botFixture.id, now)).toMatchObject({ running: true, runningCount: 1 });
  });
  it('只收集 open question 的主体，并把提问与审批算作等待主人', () => {
    const { ctx, now } = setup(); const inbox = InboxItemSchema.parse(modelFixtures.InboxItem.valid);
    ctx.store.table('inbox').put({ ...inbox, type: 'question', status: 'open', subjectKey: 'one', expiresAt: now + 2 * minute });
    ctx.store.table('inbox').put({ ...inbox, id: 'i_two', type: 'approval', status: 'open', subjectKey: 'two', expiresAt: now + minute });
    ctx.store.table('inbox').put({ ...inbox, id: 'i_three', type: 'proposal', status: 'open', subjectKey: 'three', expiresAt: now + 30_000 });
    ctx.store.table('inbox').put({ ...inbox, id: 'i_four', type: 'alert', status: 'open', subjectKey: 'four', expiresAt: null });
    const s = buildSnapshot(ctx, botFixture.id, now);
    expect([...s.openQuestionSubjects]).toEqual(['one']);
    expect(s).toMatchObject({ openOwnerAskCount: 2, openOwnerAskUntil: now + minute });
  });
  it('等待主人只统计未过期事项，任一无期限时恢复时刻为空', () => {
    const { ctx, now } = setup(); const inbox = InboxItemSchema.parse(modelFixtures.InboxItem.valid);
    ctx.store.table('inbox').put({ ...inbox, type: 'question', status: 'open', subjectKey: 'old', expiresAt: now - 1 });
    ctx.store.table('inbox').put({ ...inbox, id: 'i_open', type: 'approval', status: 'open', subjectKey: 'open', expiresAt: null });
    expect(buildSnapshot(ctx, botFixture.id, now)).toMatchObject({ openOwnerAskCount: 1, openOwnerAskUntil: null });
    ctx.store.table('inbox').patch('i_open', { expiresAt: now + 5 * minute });
    expect(buildSnapshot(ctx, botFixture.id, now)).toMatchObject({ openOwnerAskCount: 1, openOwnerAskUntil: now + 5 * minute });
  });
  it('提问或审批未答复时别的候选不被选中，答复后恢复且候选未丢', () => {
    const { ctx, now, entry } = setup(); const inbox = InboxItemSchema.parse(modelFixtures.InboxItem.valid);
    ctx.store.table('inbox').put({ ...inbox, id: 'i_wait', botId: botFixture.id, type: 'question', status: 'open', subjectKey: 'ask', expiresAt: now + minute });
    expect(selectNext(ctx, now)).toBeNull();
    expect(ctx.store.table('queue').get(entry.id)).not.toBeNull();
    ctx.store.table('inbox').patch('i_wait', { status: 'answered', answer: '好' });
    expect(selectNext(ctx, now)?.id).toBe(entry.id);
  });
  it('被拦者不堵住后续机器人，选择通过者不删除队列', () => {
    const { ctx, now, entry } = setup();
    ctx.store.table('bots').patch(botFixture.id, { retryAt: now + minute });
    ctx.store.table('bots').put({ ...botFixture, id: 'b_second' });
    const second = enqueue(ctx, buildCandidate(ctx, { botId: 'b_second', kind: 'light_check', score: 0.65, summary: '复查' }))!;
    expect(selectNext(ctx, now)?.id).toBe(second.id);
    expect(ctx.store.table('queue').get(entry.id)).not.toBeNull(); expect(ctx.store.table('queue').get(second.id)).not.toBeNull();
  });
  it('同机器人同闸门十分钟限频，边界重新记日志', () => {
    const { ctx, now } = setup(); ctx.store.table('bots').patch(botFixture.id, { retryAt: now + 20 * minute });
    for (const offset of [0, 1, 599999, 600000]) selectNext(ctx, now + offset);
    expect(ctx.store.log('appraisals').all().filter(l => l.decision === 'suppressed')).toHaveLength(2);
  });
  it('不同闸门分别记日志，paused 丢弃队列', () => {
    const { ctx, now, entry } = setup(); ctx.store.table('bots').patch(botFixture.id, { retryAt: now + minute }); selectNext(ctx, now);
    ctx.store.table('bots').patch(botFixture.id, { lifecycle: 'paused' }); selectNext(ctx, now);
    expect(ctx.store.log('appraisals').all().filter(l => l.decision === 'suppressed').map(l => l.suppressedBy)).toEqual(['retry_backoff', 'paused']);
    expect(ctx.store.table('queue').get(entry.id)).toBeNull();
  });
  it('事件入口自动滚动过期 orange，红灯仍等待探针', () => {
    const { ctx, now, snapshot } = setup(); ctx.store.table('quota').put({ ...snapshot.quota, windowStartAt: now - ctx.settings.quotaWindowMs, light: 'orange', botTurns: 7 });
    expect(selectNext(ctx, now)).not.toBeNull();
    ctx.store.table('quota').patch('quota', { light: 'red', redUntil: now + minute }); expect(selectNext(ctx, now)).toBeNull();
  });
});

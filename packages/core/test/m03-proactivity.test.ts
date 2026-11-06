/** M03 主动性回归：有意等待不能变成掉线，旧事实重启不复活，相关感知只在真实放行后消费。 */
import { describe, expect, it } from 'vitest';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { createCandidateCollector } from '../src/engine/candidates.js';
import { createDispatcher } from '../src/engine/dispatch.js';
import { createHub } from '../src/engine/hub.js';
import { checkDeadman } from '../src/health/deadman.js';
import { buildCandidate } from '../src/appraisal/think.js';
import { logAppraisal } from '../src/appraisal/log.js';
import { enqueue } from '../src/scheduler/queue.js';
import { selectNext } from '../src/scheduler/select.js';
import { buildSnapshot, evaluateGates } from '../src/scheduler/gates.js';
import { consumeRelatedPercepts } from '../src/scheduler/percept-consumption.js';
import { getQuotaState } from '../src/quota/window.js';
import { createBotHome } from '../src/memory/files.js';
import { FileStore } from '../src/store/file-store.js';
import { nextLocalTime } from '../src/util/time.js';
import { InboxItemSchema, PerceptSchema, WakeTicketSchema, type Percept } from '../src/model/index.js';
import { botFixture, modelFixtures } from './model-fixtures.js';

const minute = 60_000;
const hour = 60 * minute;

/** 只准备事实和队列输入；闸门、死人开关与投递全部调用生产实现。 */
function fixture() {
  const ctx = createTestContext();
  const now = ctx.clock.now();
  ctx.runtime.startedAt = now - 10 * minute;
  ctx.store.table('bots').put({ ...botFixture, autonomy: 'L3', expectedBy: now - 1 });
  const entry = enqueue(ctx, buildCandidate(ctx, { botId: botFixture.id, kind: 'percept', score: 0.8,
    summary: '需要核对真实资料', subjectKey: 'watch:资料' }))!;
  return { ctx, now, entry };
}

/** 每笔用量有独立身份，便于分别触发日预算、窗口预算和疲劳门槛。 */
function addUsage(ctx: ReturnType<typeof fixture>['ctx'], count: number, at = ctx.clock.now()) {
  for (let n = 0; n < count; n++) ctx.store.log('ledger').append({ id: `le_${String(n + 1).padStart(10, '0')}`,
    who: botFixture.id, wakeId: null, tokens: 0, kind: 'turn', at });
}

/** 生成明确的外部事实，待处理与无关数据在同一表中同时验证。 */
function percept(ctx: ReturnType<typeof fixture>['ctx'], index: number, patch: Partial<Percept> = {}): Percept {
  const row = { ...PerceptSchema.parse(modelFixtures.Percept.valid), id: `p_${String(index).padStart(10, '0')}`,
    createdAt: ctx.clock.now(), ...patch };
  ctx.store.table('percepts').put(row);
  return row;
}

describe('M03 死人开关只报告真实漏醒', () => {
  it.each(['bot_budget', 'window_budget', 'daily_cap', 'quota', 'cooldown', 'pace_min', 'startup_quiet',
    'dispatch_gap', 'concurrency', 'retry_backoff'] as const)('%s 有意拦截顺延期限，不造告警或重试', reason => {
    const { ctx, now, entry } = fixture();
    if (reason === 'bot_budget') addUsage(ctx, 6);
    if (reason === 'window_budget') { getQuotaState(ctx, now); addUsage(ctx, 3); }
    if (reason === 'daily_cap') { ctx.store.table('bots').patch(botFixture.id, { autonomy: 'L0' }); addUsage(ctx, 2); }
    if (reason === 'quota') ctx.store.table('quota').put({ ...getQuotaState(ctx, now), light: 'red', redUntil: now + hour });
    if (reason === 'cooldown') ctx.store.table('wakes').put({ ...WakeTicketSchema.parse(modelFixtures.WakeTicket.valid),
      status: 'committed', endedAt: now - minute, startedAt: now - minute, dispatchedAt: now - minute, subjectKey: entry.subjectKey });
    if (reason === 'pace_min') ctx.store.table('bots').patch(botFixture.id, { lastThinkAt: now - minute });
    if (reason === 'startup_quiet') ctx.runtime.startedAt = now;
    if (reason === 'dispatch_gap') ctx.runtime.lastDispatchAt = now;
    if (reason === 'concurrency') for (let n = 2; n <= 3; n++) ctx.store.table('wakes').put({
      ...WakeTicketSchema.parse(modelFixtures.WakeTicket.valid), id: `w_${String(n).padStart(10, '0')}`,
      botId: `other-${n}`, status: 'running', startedAt: now, lastEventAt: now });
    if (reason === 'retry_backoff') ctx.store.table('bots').patch(botFixture.id, { retryAt: now + hour });
    const gate = evaluateGates(entry, buildSnapshot(ctx, botFixture.id, now), now, ctx.settings);
    expect(gate).toMatchObject({ pass: false, by: reason === 'window_budget' ? 'bot_budget' : reason });
    expect(checkDeadman(ctx, now)).toEqual([]);
    expect(ctx.store.table('alerts').list()).toEqual([]);
    const until = !gate.pass ? gate.until ?? now + ctx.settings.tickMs : now;
    expect(ctx.store.table('bots').get(botFixture.id)?.expectedBy).toBe(until + ctx.settings.deadmanGraceMs);
  });

  it.each([true, false])('有未来截止的最后拦截记录受尊重；未来=%s', future => {
    const { ctx, now } = fixture();
    ctx.store.table('queue').list().forEach(q => ctx.store.table('queue').remove(q.id));
    const until = now + (future ? hour : -1);
    logAppraisal(ctx, { botId: botFixture.id, at: now, perceptIds: [], score: 0.8, threshold: 0.6,
      decision: 'suppressed', suppressedBy: 'concurrency', until, text: '主人正在会话里处理，稍后继续' });
    expect(checkDeadman(ctx, now)).toHaveLength(future ? 0 : 1);
    if (future) expect(ctx.store.table('bots').get(botFixture.id)?.expectedBy).toBe(until + ctx.settings.deadmanGraceMs);
  });

  it('无队列且预约低于疲劳门槛，延至次日而不是用 retry 绕过门槛', () => {
    const { ctx, now } = fixture();
    ctx.store.table('queue').list().forEach(q => ctx.store.table('queue').remove(q.id));
    ctx.store.table('bots').patch(botFixture.id, { nextThinkAt: now - hour });
    addUsage(ctx, 5);
    expect(checkDeadman(ctx, now)).toEqual([]);
    expect(ctx.store.table('alerts').list()).toEqual([]);
    expect(ctx.store.table('bots').get(botFixture.id)?.expectedBy)
      .toBe(nextLocalTime('00:00', now, ctx.settings.timezone) + ctx.settings.deadmanGraceMs);
  });

  it.each(['health', 'pump'] as const)('%s 在旧期限尚未到期时就记住合法延后，闸门解除的下一 tick 不误报', phase => {
    const { ctx, now } = fixture();
    ctx.store.table('bots').patch(botFixture.id, { expectedBy: now + minute });
    ctx.runtime.lastDispatchAt = now;
    if (phase === 'health') expect(checkDeadman(ctx, now)).toEqual([]);
    else expect(selectNext(ctx, now)).toBeNull();
    expect(ctx.store.table('bots').get(botFixture.id)?.expectedBy).toBe(now + ctx.settings.dispatchGapMs + ctx.settings.deadmanGraceMs);
    ctx.clock.advance(2 * minute);
    expect(checkDeadman(ctx, ctx.clock.now())).toEqual([]);
    expect(ctx.store.table('alerts').list()).toEqual([]);
    expect(selectNext(ctx, ctx.clock.now())).not.toBeNull();
  });

  it.each([true, false])('确实超时且没有合法拦截时仍告警；保留可放行候选=%s', queued => {
    const { ctx, now } = fixture();
    if (!queued) ctx.store.table('queue').list().forEach(q => ctx.store.table('queue').remove(q.id));
    expect(checkDeadman(ctx, now)).toEqual([expect.objectContaining({ reason: expect.objectContaining({ kind: 'retry' }) })]);
    expect(ctx.store.table('alerts').list()).toEqual([expect.objectContaining({ code: 'deadman', level: 'P1', status: 'open' })]);
  });
});

describe('M03 同事项感知收尾与重启', () => {
  it('放行按同 watch 与同 subject 消费积压；不跨机器人、不碰未来、不碰无关事项', async () => {
    const { ctx, now, entry } = fixture();
    const first = percept(ctx, 1, { tier: 'urgent', salience: 1, createdAt: now - minute });
    const sameWatch = percept(ctx, 2, { tier: 'record', createdAt: now });
    const unrelated = percept(ctx, 3, { watchId: 'wt_other' });
    const otherBot = percept(ctx, 4, { botId: 'b_other' });
    const future = percept(ctx, 5, { createdAt: now + 1 });
    const item = InboxItemSchema.parse(modelFixtures.InboxItem.valid);
    ctx.store.table('inbox').put({ ...item, subjectKey: 'same-question', status: 'answered', answer: '继续', answeredAt: now });
    const sameSubject = percept(ctx, 6, { watchId: null, source: 'inbox', kind: 'question_context', location: item.id });
    ctx.store.table('queue').patch(entry.id, { subjectKey: 'same-question', reason: { ...entry.reason, evidence: [first.id] } });
    await createBotHome(ctx, ctx.store.table('bots').get(botFixture.id)!);
    await createDispatcher(ctx).pump();
    const wake = ctx.store.table('wakes').list()[0]!;
    expect(wake.status).toBe('running');
    for (const p of [first, sameWatch, sameSubject]) expect(ctx.store.table('percepts').get(p.id)?.consumedByWake).toBe(wake.id);
    for (const p of [unrelated, otherBot, future]) expect(ctx.store.table('percepts').get(p.id)?.consumedByWake).toBeNull();
    expect(ctx.store.table('bots').get(botFixture.id)?.expectedBy).toBeNull();
  });

  it('第 3 闸持久丢弃 urgent，重建收集器也不复活；主人回复仍能消费原事项', () => {
    const { ctx, now, entry } = fixture();
    const p = percept(ctx, 1, { tier: 'urgent', salience: 1 });
    ctx.store.table('queue').patch(entry.id, { subjectKey: `watch:${p.watchId}`, reason: { ...entry.reason, evidence: [p.id] } });
    ctx.store.table('inbox').put({ ...InboxItemSchema.parse(modelFixtures.InboxItem.valid), subjectKey: `watch:${p.watchId}` });
    expect(selectNext(ctx, now)).toBeNull();
    expect(ctx.store.table('percepts').get(p.id)).toMatchObject({ discardedAt: now, evaluatedAt: now, consumedByWake: null });
    createCandidateCollector(ctx).collect(now);
    expect(ctx.store.table('queue').count()).toBe(0);
    expect(ctx.store.table('bots').get(botFixture.id)?.expectedBy).toBeNull();
    ctx.clock.advance(hour);
    expect(checkDeadman(ctx, ctx.clock.now())).toEqual([]);
    consumeRelatedPercepts(ctx, { ...entry, subjectKey: `watch:${p.watchId}` }, 'w_owner_reply', ctx.clock.now());
    expect(ctx.store.table('percepts').get(p.id)?.consumedByWake).toBe('w_owner_reply');
  });

  it('低于门槛感知落盘后换 FileStore 重启，次日门槛降低也不会把旧事实重新排队', async () => {
    const base = createTestContext();
    const store = new FileStore(base.fs, base.clock, '/hub', base.settings.timezone, base.logger, base.settings);
    const ctx = { ...base, store };
    const now = ctx.clock.now();
    ctx.store.table('bots').put({ ...botFixture, pace: 'quiet' });
    addUsage(ctx, 1);
    const old = percept(ctx, 1, { watchId: null, salience: 0.735, tier: 'candidate' });
    createCandidateCollector(ctx).collect(now);
    expect(ctx.store.table('queue').count()).toBe(0);
    expect(ctx.store.table('percepts').get(old.id)?.evaluatedAt).toBe(now);
    await store.flush();
    ctx.clock.advance(24 * hour);
    const restored = new FileStore(base.fs, base.clock, '/hub', base.settings.timezone, base.logger, base.settings);
    await restored.load();
    const restarted = { ...base, store: restored };
    createCandidateCollector(restarted).collect(ctx.clock.now());
    expect(restored.table('queue').count()).toBe(0);
    // 新事实仍有资格按今天的门槛入队，不能把修复变成关闭所有后续感知。
    const fresh = percept(restarted, 2, { watchId: null, salience: 0.735, tier: 'candidate' });
    createCandidateCollector(restarted).collect(ctx.clock.now());
    expect(restored.table('queue').list()[0]?.reason.evidence).toEqual([fresh.id]);
  });

  it('候选缓存随在队机器人数量有界，千条不同事项出队后归零', () => {
    const { ctx, now } = fixture();
    const collector = createCandidateCollector(ctx);
    for (let n = 0; n < 1000; n++) {
      collector.offer(buildCandidate(ctx, { botId: botFixture.id, kind: 'owner_message', score: 1,
        summary: `主人第 ${n} 件真实事项`, messageId: `owner-${n}` }));
      expect(collector.cachedDecisionCount).toBeLessThanOrEqual(1);
      ctx.store.table('queue').list().forEach(q => ctx.store.table('queue').remove(q.id));
    }
    collector.collect(now);
    expect(collector.cachedDecisionCount).toBe(0);
  });

  it.each(['waiting_owner_same_subject', null] as const)('升级旧记录按既有 %s 决定恢复游标，新事实仍正常入队', suppressedBy => {
    const { ctx, now } = fixture();
    ctx.store.table('queue').list().forEach(q => ctx.store.table('queue').remove(q.id));
    const old = percept(ctx, 1, { salience: 1, tier: 'urgent', createdAt: now - 2 * minute });
    logAppraisal(ctx, { botId: botFixture.id, at: now - minute, perceptIds: [old.id], score: 0.7, threshold: 0.8,
      decision: 'suppressed', suppressedBy, text: suppressedBy ? '在等主人，不再叫醒' : '低于当时疲劳门槛，暂不排队' });
    const fresh = percept(ctx, 2, { watchId: 'wt_fresh', salience: 1, tier: 'urgent' });
    const collector = createCandidateCollector(ctx);
    collector.collect(now);
    expect(ctx.store.table('queue').list()[0]?.reason.evidence).toEqual([fresh.id]);
    expect(ctx.store.table('percepts').get(old.id)?.evaluatedAt).toBe(now - minute);
    if (suppressedBy) expect(ctx.store.table('percepts').get(old.id)?.discardedAt).toBe(now - minute);
  });

  it('完整 Hub 升级旧 T7 记录，首次健康检查前清掉旧 urgent 截止，连续重启都不唤醒', async () => {
    const ctx = createTestContext();
    const now = ctx.clock.now();
    ctx.store.table('bots').put({ ...botFixture, expectedBy: now - minute, activity: 'watching' });
    await createBotHome(ctx, botFixture);
    const old = percept(ctx, 1, { salience: 1, tier: 'urgent', createdAt: now - hour });
    logAppraisal(ctx, { botId: botFixture.id, at: now - hour, perceptIds: [old.id], score: 1, threshold: 0.6,
      decision: 'suppressed', suppressedBy: 'waiting_owner_same_subject', text: '旧版本已决定等主人同一件事，不再叫醒' });
    for (let restart = 0; restart < 2; restart++) {
      const hub = createHub(ctx);
      await hub.start();
      expect(ctx.store.table('percepts').get(old.id)?.discardedAt).toBe(now - hour);
      expect(ctx.store.table('bots').get(botFixture.id)?.expectedBy).toBeNull();
      for (let tick = 0; tick < 5; tick++) { ctx.clock.advance(minute); await hub.tick(); }
      expect(ctx.store.table('wakes').count()).toBe(0);
      expect(ctx.store.table('alerts').list(a => a.code === 'deadman')).toEqual([]);
      await hub.stop();
    }
  });

  it('升级时当前持久队列优先于更早的拒绝日志，真实待办不会被迁移误删', () => {
    const { ctx, now, entry } = fixture();
    const p = percept(ctx, 1, { salience: 1, tier: 'urgent', createdAt: now - hour });
    ctx.store.table('queue').patch(entry.id, { reason: { ...entry.reason, evidence: [p.id] } });
    logAppraisal(ctx, { botId: botFixture.id, at: now - minute, perceptIds: [p.id], score: 1, threshold: 0.6,
      decision: 'suppressed', suppressedBy: 'waiting_owner_same_subject', text: '更早的主人等待已解除' });
    createCandidateCollector(ctx).restore(now);
    expect(ctx.store.table('percepts').get(p.id)?.evaluatedAt).toBe(entry.enqueuedAt);
    expect(ctx.store.table('percepts').get(p.id)?.discardedAt).toBeUndefined();
    expect(selectNext(ctx, now)?.id).toBe(entry.id);
  });
});

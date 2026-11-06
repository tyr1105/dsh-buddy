/** M02 调度回归：预约身份、合并信任、闸门顺序与健康恢复都用可观察状态证明。 */
import { describe, expect, it } from 'vitest';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { buildCandidate } from '../src/appraisal/think.js';
import { collectTimeCandidates } from '../src/agenda/clock.js';
import { checkDeadman, findStuckWakes, checkQuarantine, catchUpCandidates } from '../src/health/index.js';
import { enqueue, removeEntry } from '../src/scheduler/queue.js';
import { selectNext } from '../src/scheduler/select.js';
import { buildSnapshot, evaluateGates, type GateSnapshot } from '../src/scheduler/gates.js';
import { onDispatchOrTurnError, retryDelayMs } from '../src/scheduler/retry.js';
import { setLifecycle } from '../src/api/bots.js';
import { createBotHome } from '../src/memory/files.js';
import { botFixture, modelFixtures } from './model-fixtures.js';
import type { AgendaItem, Percept, WakeTicket, InboxItem } from '../src/model/index.js';
const minute = 60_000; const hour = 60 * minute;
function setup() {
  const ctx = createTestContext(); ctx.store.table('bots').put(botFixture); ctx.runtime.startedAt -= hour;
  return ctx;
}
function candidate(ctx: ReturnType<typeof setup>, key = '资料') {
  return buildCandidate(ctx, { botId: botFixture.id, kind: 'percept', score: 0.8, summary: '资料变化', subjectKey: key });
}
const wake = (patch: Partial<WakeTicket>): WakeTicket => ({ ...(modelFixtures.WakeTicket.valid as WakeTicket), ...patch });

describe('M02 [1][8][9][10][11][21] 时间与队列', () => {
  it('两次 next_think 相隔一小时依 pace_min 放行且不产生死人开关', () => {
    const ctx = setup(); const now = ctx.clock.now();
    ctx.store.table('bots').patch(botFixture.id, { nextThinkAt: now, expectedBy: now + 30 * minute, lastThinkAt: now - hour });
    const first = collectTimeCandidates(ctx, now).find(c => c.reason.kind === 'next_think')!;
    enqueue(ctx, first); expect(selectNext(ctx, now)?.subjectKey).toBe(first.subjectKey);
    ctx.store.table('wakes').put(wake({ reason: first.reason, subjectKey: first.subjectKey, startedAt: now, endedAt: now, status: 'committed' }));
    removeEntry(ctx, ctx.store.table('queue').list()[0]!.id);
    ctx.store.table('bots').patch(botFixture.id, { lastThinkAt: now, nextThinkAt: now + hour, expectedBy: now + 90 * minute });
    ctx.clock.advance(hour);
    const second = collectTimeCandidates(ctx, ctx.clock.now()).find(c => c.reason.kind === 'next_think')!;
    expect(second.subjectKey).not.toBe(first.subjectKey); enqueue(ctx, second);
    expect(selectNext(ctx, ctx.clock.now())?.subjectKey).toBe(second.subjectKey);
    expect(checkDeadman(ctx, ctx.clock.now())).toEqual([]); expect(ctx.store.table('alerts').count()).toBe(0);
  });
  it.each(['running', 'delivering', 'committed'] as const)('在途 %s 不重复产出时间候选', status => {
    const ctx = setup(); ctx.store.table('bots').patch(botFixture.id, { nextThinkAt: 1, lightCheckAt: 1 });
    ctx.store.table('wakes').put(wake({ status, endedAt: null }));
    expect(collectTimeCandidates(ctx, ctx.clock.now())).toEqual([]);
  });
  it('到期承诺只提高优先级，不成为 urgent；未关闭时受冷却和有效节奏约束', () => {
    const ctx = setup(); const now = ctx.clock.now(); const agenda = modelFixtures.AgendaItem.valid as AgendaItem;
    ctx.store.table('agenda').put({ ...agenda, toOwner: true, status: 'open', dueAt: now });
    const due = collectTimeCandidates(ctx, now).find(c => c.reason.kind === 'agenda_due')!;
    expect(due).toMatchObject({ priority: 80, urgent: false, reason: { score: 0.95 } });
    const entry = enqueue(ctx, due)!;
    ctx.store.table('bots').patch(botFixture.id, { lastThinkAt: now, noChangeStreak: 1 });
    expect(evaluateGates(entry, buildSnapshot(ctx, botFixture.id, now), now, ctx.settings)).toMatchObject({ by: 'pace_min', until: now + 2 * hour });
    ctx.store.table('wakes').put(wake({ subjectKey: due.subjectKey, reason: due.reason, startedAt: now, endedAt: now, status: 'committed' }));
    expect(selectNext(ctx, now)).toBeNull();
    expect(ctx.store.log('appraisals').recent(1)[0]).toMatchObject({ suppressedBy: 'cooldown' });
    expect(buildCandidate(ctx, { botId: botFixture.id, kind: 'drive', score: 0.95, summary: '承诺内驱' }).urgent).toBe(false);
  });
  it('高分异常不降级主人回复，旧合并记录含回复证据也不能被 T7 丢弃', () => {
    const ctx = setup(); const now = ctx.clock.now();
    const p = { ...(modelFixtures.Percept.valid as Percept), source: 'inbox' as const, kind: 'inbox_reply' };
    ctx.store.table('percepts').put(p);
    ctx.store.table('inbox').put({ ...(modelFixtures.InboxItem.valid as InboxItem), type: 'question', status: 'open', subjectKey: 'watch:other' });
    const reply = enqueue(ctx, buildCandidate(ctx, { botId: botFixture.id, kind: 'inbox_reply', score: 0.95, summary: '主人回复', evidence: [p.id], subjectKey: 'question:answered' }))!;
    const merged = enqueue(ctx, buildCandidate(ctx, { botId: botFixture.id, kind: 'percept', score: 1, summary: '异常', subjectKey: 'watch:other', anomaly: true }))!;
    expect(merged).toMatchObject({ id: reply.id, priority: 90, reason: { kind: 'inbox_reply' }, subjectKey: reply.subjectKey });
    expect(merged.reason.evidence).toContain(p.id);
    expect(evaluateGates({ ...merged, subjectKey: 'watch:other', reason: { ...merged.reason, kind: 'percept' } }, buildSnapshot(ctx, botFixture.id, now), now, ctx.settings)).toEqual({ pass: true });
    expect(selectNext(ctx, now)?.id).toBe(reply.id);
  });
  it('同条队列十分钟只记一次 queued，不同机器人各记且边界恢复', () => {
    const ctx = setup(); const input = candidate(ctx);
    for (let i = 0; i < 10; i++) { enqueue(ctx, input); ctx.clock.advance(minute); }
    expect(ctx.store.log('appraisals').all().filter(a => a.decision === 'queued')).toHaveLength(1);
    enqueue(ctx, input); expect(ctx.store.log('appraisals').all().filter(a => a.decision === 'queued')).toHaveLength(2);
    ctx.store.table('bots').put({ ...botFixture, id: 'b_second' }); enqueue(ctx, { ...input, botId: 'b_second' });
    expect(ctx.store.log('appraisals').all().filter(a => a.decision === 'queued')).toHaveLength(3);
  });
});

describe('M02 [3][20][27][29][31] 补课与规则证据', () => {
  it('启动补扫异常证据进入补课，priority 恒30且低于门槛仍入队', () => {
    const ctx = setup(); const now = ctx.clock.now(); const p = modelFixtures.Percept.valid as Percept;
    ctx.store.table('percepts').put({ ...p, createdAt: now, anomaly: true, consumedByWake: null });
    const c = catchUpCandidates(ctx, { id: 'd_1234567890', kind: 'host_down', from: now - hour, to: now - minute, handled: false }, now)[0]!;
    expect(c.reason.evidence).toEqual(['d_1234567890', p.id]); expect(c.priority).toBe(30);
    expect(c.reason.score).toBeLessThan(c.reason.threshold); expect(enqueue(ctx, c)?.reason.kind).toBe('catch_up');
    const retry = buildCandidate(ctx, { botId: botFixture.id, kind: 'retry', score: 0.1, summary: '恢复检查' });
    for (const q of ctx.store.table('queue').list()) removeEntry(ctx, q.id);
    expect(enqueue(ctx, retry)).not.toBeNull();
  });
  it('出错三次逐档重排，抖动同时覆盖负20%和正10%/20%', () => {
    const ctx = setup(); const now = ctx.clock.now();
    for (let n = 1; n <= 3; n++) {
      const base = ctx.settings.retryBackoffMs[n - 1]!;
      const result = onDispatchOrTurnError(ctx, botFixture.id, '网络超时', now);
      expect(result.action).toBe('retry'); expect(result.retryAt! - now).toBeGreaterThanOrEqual(base * 0.8);
      expect(result.retryAt! - now).toBeLessThanOrEqual(base * 1.2);
      expect(ctx.store.table('bots').get(botFixture.id)).toMatchObject({ retryAt: result.retryAt, consecutiveErrors: n });
      expect(retryDelayMs(n, { next: () => 0 })).toBe(base * 0.8);
      expect(retryDelayMs(n, { next: () => 0.75 })).toBe(Math.round(base * 1.1));
      expect(retryDelayMs(n, { next: () => 1 - Number.EPSILON })).toBe(Math.round(base * 1.2));
    }
    expect(onDispatchOrTurnError(ctx, botFixture.id, '网络超时', now).action).toBe('quarantined');
  });
  it('低优先级先入队仍选高优先级，同闸拦截按机器人分别限频', () => {
    const ctx = setup(); const now = ctx.clock.now(); enqueue(ctx, candidate(ctx));
    ctx.store.table('bots').put({ ...botFixture, id: 'b_second' });
    const high = enqueue(ctx, buildCandidate(ctx, { botId: 'b_second', kind: 'owner_message', score: 1, summary: '主人消息' }))!;
    expect(selectNext(ctx, now)?.id).toBe(high.id);
    for (const b of ctx.store.table('bots').list()) ctx.store.table('bots').patch(b.id, { retryAt: now + hour });
    expect(selectNext(ctx, now)).toBeNull(); expect(selectNext(ctx, now)).toBeNull();
    expect(ctx.store.log('appraisals').all().filter(a => a.suppressedBy === 'retry_backoff').map(a => a.botId).sort()).toEqual([botFixture.id, 'b_second'].sort());
  });
  it.each(['4/5', '5/6', '6/7', '7/8', '8/9'])('相邻闸门 %s 同时命中只报前一道', pair => {
    const ctx = setup(); const now = ctx.clock.now(); const entry = enqueue(ctx, candidate(ctx))!;
    const s = buildSnapshot(ctx, botFixture.id, now);
    const cases: Record<string, [Partial<GateSnapshot>, string]> = {
      '4/5': [{ subjectWakeAt: new Map([[entry.subjectKey, now]]), bot: { ...s.bot!, lastThinkAt: now } }, 'cooldown'],
      '5/6': [{ bot: { ...s.bot!, lastThinkAt: now }, todayTurns: 6 }, 'pace_min'],
      '6/7': [{ todayTurns: 6, quota: { ...s.quota, light: 'red' } }, 'daily_cap'],
      '7/8': [{ quota: { ...s.quota, light: 'orange' }, startedAt: now }, 'quota'],
      '8/9': [{ startedAt: now, retryAt: now + hour }, 'startup_quiet'],
    };
    const [patch, by] = cases[pair]!;
    expect(evaluateGates(entry, { ...s, ...patch }, now, ctx.settings)).toMatchObject({ by });
    expect(evaluateGates(entry, { ...s, todayTurns: 6 }, now, ctx.settings)).toMatchObject({ until: Date.parse('2026-11-06T00:00:00+08:00') });
    expect(evaluateGates(entry, { ...s, quota: { ...s.quota, light: 'orange' } }, now, ctx.settings)).toMatchObject({ until: now + 5 * hour });
  });
});

describe('M02 [17][18] 孤儿投递与解除隔离', () => {
  it('delivering 两分钟内占位，超时被卡住检测与死人开关识别', () => {
    const ctx = setup(); const now = ctx.clock.now(); ctx.store.table('wakes').put(wake({ status: 'delivering', startedAt: now, endedAt: null }));
    expect(findStuckWakes(ctx, now + 2 * minute)).toEqual([]); expect(checkDeadman(ctx, now + 2 * minute)).toEqual([]);
    expect(findStuckWakes(ctx, now + 2 * minute + 1)).toHaveLength(1); expect(checkDeadman(ctx, now + 2 * minute + 1)).toHaveLength(1);
  });
  it('主人解除隔离清零且记录边界，旧错误和旧超量不污染下一次', async () => {
    const ctx = setup(); const now = ctx.clock.now(); await createBotHome(ctx, botFixture);
    for (let n = 1; n <= 3; n++) ctx.store.table('wakes').put(wake({ id: `w_old${n}`, status: 'error', startedAt: now - hour, endedAt: now - n, dispatchedAt: now - hour }));
    ctx.store.log('ledger').append({ id: 'le_old', who: botFixture.id, wakeId: null, tokens: 800000, kind: 'other', at: now - 1 });
    ctx.store.table('bots').patch(botFixture.id, { lifecycle: 'quarantined', consecutiveErrors: 3 });
    expect(await setLifecycle(ctx, botFixture.id, 'active')).toMatchObject({ releasedAt: now, consecutiveErrors: 0 });
    expect(checkQuarantine(ctx, botFixture.id, now)).toBeNull();
    for (let n = 1; n <= 3; n++) {
      ctx.store.table('wakes').put(wake({ id: `w_new${n}`, status: 'error', startedAt: now + n, endedAt: now + n, dispatchedAt: now + n }));
      onDispatchOrTurnError(ctx, botFixture.id, '连接重置', now + n);
      const reason = checkQuarantine(ctx, botFixture.id, now + n);
      if (n < 3) expect(reason).toBeNull(); else expect(reason).toContain('连续 3');
    }
  });
});

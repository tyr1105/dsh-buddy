/** 队列合并、优先级、节奏和错误处理：以最终记录验证行为，覆盖主人例外与隔离。 */
import { describe, it, expect } from 'vitest';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { resolveSettings } from '../src/config/defaults.js';
import { buildCandidate } from '../src/appraisal/think.js';
import { enqueue, listQueue, removeEntry } from '../src/scheduler/queue.js';
import { priorityFor } from '../src/scheduler/priority.js';
import { effectivePaceMinMs, afterOutcome } from '../src/scheduler/pacing.js';
import { onDispatchOrTurnError, retryDelayMs } from '../src/scheduler/retry.js';
import { selectNext } from '../src/scheduler/select.js';
import { InboxItemSchema } from '../src/model/index.js';
import type { Variant } from '../src/model/index.js';
import { botFixture, modelFixtures } from './model-fixtures.js';

function setup() { const ctx = createTestContext(); ctx.store.table('bots').put(botFixture); ctx.runtime.startedAt -= 600000; return ctx; }
function candidate(ctx: ReturnType<typeof setup>, score = 0.8, variant: Variant = 'regular') {
  return buildCandidate(ctx, { botId: botFixture.id, kind: 'percept', score, summary: `分数 ${score}`, evidence: ['p_one'], variant });
}
describe('队列', () => {
  it('排队和被丢弃都不掩盖正在等待主人的活动状态', () => {
    const ctx = setup(); ctx.store.table('bots').patch(botFixture.id, { activity: 'waiting_owner' });
    const row = enqueue(ctx, candidate(ctx))!;
    expect(ctx.store.table('bots').get(botFixture.id)?.activity).toBe('waiting_owner');
    removeEntry(ctx, row.id); expect(ctx.store.table('bots').get(botFixture.id)?.activity).toBe('waiting_owner');
  });
  it('同机器人一条，最高分取理由与事项，证据取并集，时间保留初次', () => {
    const ctx = setup(); const first = enqueue(ctx, candidate(ctx))!; ctx.clock.advance(100);
    const next = { ...candidate(ctx, 0.9), subjectKey: 'watch:new', urgent: true, ownerInitiated: true, priority: 100 };
    next.reason.evidence = ['p_one', 'p_two']; const merged = enqueue(ctx, next)!;
    expect(listQueue(ctx)).toHaveLength(1); expect(merged).toMatchObject({ id: first.id, enqueuedAt: first.enqueuedAt, subjectKey: 'watch:new', urgent: true, ownerInitiated: true, priority: 100 });
    expect(merged.reason).toMatchObject({ score: 0.9, evidence: ['p_one', 'p_two'] });
  });
  it('较低分补充证据不覆盖主理由或降低优先级', () => {
    const ctx = setup(); enqueue(ctx, { ...candidate(ctx, 0.9), priority: 90 });
    const next = candidate(ctx, 0.8); next.reason.evidence = ['p_two'];
    expect(enqueue(ctx, next)).toMatchObject({ priority: 90, reason: { score: 0.9, evidence: ['p_one', 'p_two'] } });
  });
  it.each([['light_check', 'catch_up', 'catch_up'], ['catch_up', 'regular', 'regular'], ['regular', 'light_check', 'regular'], ['teach', 'reflection', 'teach'], ['trial', 'regular', 'trial'], ['regular', 'reflection', 'reflection']] as const)('变体 %s 合并 %s 保留 %s', (old, next, expected) => {
    const ctx = setup(); enqueue(ctx, candidate(ctx, 0.8, old)); expect(enqueue(ctx, candidate(ctx, 0.9, next))?.variant).toBe(expected);
  });
  it('同分主人消息取更高优先级理由，不被旧问题丢弃', () => {
    const ctx = setup(); enqueue(ctx, { ...candidate(ctx, 1), subjectKey: 'watch:one' });
    ctx.store.table('inbox').put({ ...InboxItemSchema.parse(modelFixtures.InboxItem.valid), type: 'question', status: 'open', subjectKey: 'watch:one' });
    const merged = enqueue(ctx, buildCandidate(ctx, { botId: botFixture.id, kind: 'owner_message', score: 1, summary: '主人继续', messageId: 'm_one' }))!;
    expect(merged.reason.kind).toBe('owner_message'); expect(merged.subjectKey).toBe('owner:m_one'); expect(selectNext(ctx, ctx.clock.now())?.id).toBe(merged.id);
  });
  it('普通低于门槛不排队，light_check 和 owner 豁免', () => {
    const ctx = setup(); const low = candidate(ctx, 0.5);
    expect(enqueue(ctx, low)).toBeNull(); expect(ctx.store.log('appraisals').all()[0]).toMatchObject({ decision: 'suppressed', suppressedBy: null });
    expect(enqueue(ctx, { ...low, reason: { ...low.reason, kind: 'light_check' }, variant: 'light_check' })).not.toBeNull();
    expect(enqueue(ctx, { ...low, ownerInitiated: true })).not.toBeNull();
  });
  it('同分先入先出，高优先级优先，remove 仅移指定条目', () => {
    const ctx = setup(); const first = enqueue(ctx, candidate(ctx))!;
    for (const [i, priority] of [[2, first.priority], [3, 100]]) {
      const botId = `bot-${i}`; ctx.store.table('bots').put({ ...botFixture, id: botId }); ctx.clock.advance(1);
      enqueue(ctx, { ...candidate(ctx), botId, priority: priority! });
    }
    expect(listQueue(ctx).map(row => row.botId)).toEqual(['bot-3', botFixture.id, 'bot-2']);
    removeEntry(ctx, first.id); expect(listQueue(ctx)).toHaveLength(2);
  });
  it('非法候选在改表之前拒绝并指出字段', () => {
    const ctx = setup(); expect(() => enqueue(ctx, { ...candidate(ctx), subjectKey: '' })).toThrow('subjectKey'); expect(listQueue(ctx)).toEqual([]);
  });
});

describe('优先级', () => {
  it.each([
    [{ kind: 'percept', score: 0.8, ownerInitiated: true }, 100], [{ kind: 'approval_decided', score: 0.95 }, 90],
    [{ kind: 'inbox_reply', score: 0.95 }, 90], [{ kind: 'agenda_due', score: 0.95, toOwner: true }, 80],
    [{ kind: 'percept', score: 0.8, anomaly: true }, 70], [{ kind: 'percept', score: 0.8 }, 48],
    [{ kind: 'drive', score: 0.8 }, 50], [{ kind: 'next_think', score: 0.75 }, 40], [{ kind: 'catch_up', score: 0.5 }, 30], [{ kind: 'light_check', score: 0.65 }, 20],
  ] as const)('优先级表 %#', (input, expected) => expect(priorityFor(input)).toBe(expected));
  it('未到期承诺不拿到到期优先级', () => expect(priorityFor({ kind: 'agenda_due', score: 0.7, toOwner: true })).toBe(42));
});

describe('节奏与重排', () => {
  it('无变化指数退避封顶24h，yellow额外加倍', () => {
    const s = resolveSettings();
    expect(effectivePaceMinMs({ ...botFixture, noChangeStreak: 1 }, s, 'green')).toBe(7200000);
    expect(effectivePaceMinMs({ ...botFixture, noChangeStreak: 100 }, s, 'green')).toBe(86400000);
    expect(effectivePaceMinMs(botFixture, s, 'yellow')).toBe(7200000);
  });
  it.each(['progress', 'done'] as const)('%s 复位退避', outcome => expect(afterOutcome({ ...botFixture, noChangeStreak: 4 }, outcome, false)).toEqual({ noChangeStreak: 0 }));
  it('高感知复位，无变化递增，blocked 保留', () => {
    const b = { ...botFixture, noChangeStreak: 3 };
    expect(afterOutcome(b, 'no_change', true)).toEqual({ noChangeStreak: 0 });
    expect(afterOutcome(b, 'no_change', false)).toEqual({ noChangeStreak: 4 }); expect(afterOutcome(b, 'blocked', false)).toEqual({ noChangeStreak: 3 });
  });
  it.each([[1, 120000], [2, 600000], [3, 1800000], [4, 7200000], [5, 7200000]])('第%s次重排范围', (attempt, base) => {
    expect(retryDelayMs(attempt, { next: () => 0.5 })).toBe(base);
    expect(retryDelayMs(attempt, { next: () => 0 })).toBe(base * 0.8);
    expect(retryDelayMs(attempt, { next: () => 0.999999 })).toBeLessThanOrEqual(base * 1.2);
  });
  it('无效重排次数或随机源拒绝', () => {
    expect(() => retryDelayMs(0, { next: () => 0.5 })).toThrow('次数'); expect(() => retryDelayMs(1, { next: () => 1 })).toThrow('随机源');
  });
  it('前三次只重排，第四次隔离并移出队列、P1告警', () => {
    const ctx = setup(); enqueue(ctx, candidate(ctx));
    for (let attempt = 1; attempt <= 3; attempt++) {
      expect(onDispatchOrTurnError(ctx, botFixture.id, 'network failure', ctx.clock.now()).action).toBe('retry');
      expect(ctx.store.table('bots').get(botFixture.id)?.lifecycle).toBe('active');
    }
    expect(onDispatchOrTurnError(ctx, botFixture.id, 'network failure', ctx.clock.now()).action).toBe('quarantined');
    expect(ctx.store.table('bots').get(botFixture.id)).toMatchObject({ consecutiveErrors: 4, lifecycle: 'quarantined', retryAt: null });
    expect(listQueue(ctx)).toEqual([]); expect(ctx.store.table('alerts').list()[0]).toMatchObject({ level: 'P1', status: 'open' });
  });
  it('quota 与 auth 不增加单个机器人错误次数且全局拦截', () => {
    const ctx = setup(); enqueue(ctx, candidate(ctx));
    expect(onDispatchOrTurnError(ctx, botFixture.id, '429 quota', ctx.clock.now()).action).toBe('quota');
    expect(ctx.store.table('quota').get('quota')?.light).toBe('red');
    expect(onDispatchOrTurnError(ctx, botFixture.id, '401 unauthorized', ctx.clock.now()).action).toBe('auth');
    expect(ctx.store.table('bots').get(botFixture.id)?.consecutiveErrors).toBe(0);
    ctx.store.table('quota').patch('quota', { light: 'green', redUntil: null }); expect(selectNext(ctx, ctx.clock.now())).toBeNull();
  });
});

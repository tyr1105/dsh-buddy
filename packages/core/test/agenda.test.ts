/** 意图时钟验收：四种预约模式、时间夹紧、门槛豁免和关注项到期都由可控时间驱动。 */
import { describe, expect, it } from 'vitest';
import { applyNextThink, refreshLightCheck } from '../src/agenda/next-think.js';
import { collectTimeCandidates } from '../src/agenda/clock.js';
import { expireWatches } from '../src/agenda/watch-expiry.js';
import { agendaUrgency } from '../src/appraisal/think.js';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { resolveSettings } from '../src/config/defaults.js';
import { AgendaItemSchema } from '../src/model/index.js';
import type { AgendaItem, NextThink } from '../src/model/index.js';
import { botFixture, modelFixtures, watchFixture } from './model-fixtures.js';

const HOUR = 3_600_000;
const DAY = HOUR * 24;
const now = Date.parse('2026-11-05T10:00:00+08:00');
const settings = resolveSettings();
const info = { settings, hasActiveGoal: true };
const agenda = (patch: Partial<AgendaItem> = {}): AgendaItem => ({ ...AgendaItemSchema.parse(modelFixtures.AgendaItem.valid), dueAt: now, ...patch });
const apply = (next: NextThink) => applyNextThink(botFixture, next, now, info);

describe('议程紧迫度与时间候选', () => {
  it.each([
    [{ toOwner: true }, 0.95], [{}, 0.85], [{ dueAt: now + HOUR }, 0.7],
    [{ dueAt: now + HOUR + 1 }, 0], [{ dueAt: null }, 0], [{ status: 'done' as const }, 0],
  ])('议程 %o 的紧迫度为 %s', (patch, score) => expect(agendaUrgency(agenda(patch), now)).toBe(score));
  it('时间候选保留三档分数、议程证据及主人承诺优先级', () => {
    const ctx = createTestContext(); ctx.store.table('bots').put(botFixture);
    ctx.store.table('agenda').put(agenda({ id: 'a_0000000001', toOwner: true }));
    ctx.store.table('agenda').put(agenda({ id: 'a_0000000002' }));
    ctx.store.table('agenda').put(agenda({ id: 'a_0000000003', dueAt: now + HOUR }));
    const candidates = collectTimeCandidates(ctx, now);
    expect(candidates.map(item => item.reason.score)).toEqual([0.95, 0.85, 0.7]);
    expect(candidates[0]).toMatchObject({ priority: 80, subjectKey: 'agenda:a_0000000001', reason: { evidence: ['a_0000000001'] } });
  });
  it('next_think 到期按 0.75 生成候选', () => {
    const ctx = createTestContext(); ctx.store.table('bots').put({ ...botFixture, nextThinkAt: now, nextThinkReason: '等资料生成' });
    expect(collectTimeCandidates(ctx, now)[0]).toMatchObject({ priority: 40, reason: { kind: 'next_think', score: 0.75 } });
  });
  it('尚未到期的 next_think 不生成候选', () => {
    const ctx = createTestContext(); ctx.store.table('bots').put({ ...botFixture, nextThinkAt: now + 1 });
    expect(collectTimeCandidates(ctx, now)).toEqual([]);
  });
  it('轻复查到期以独立变体生成候选', () => {
    const ctx = createTestContext(); ctx.store.table('bots').put({ ...botFixture, lightCheckAt: now });
    expect(collectTimeCandidates(ctx, now)[0]).toMatchObject({ variant: 'light_check', priority: 20, reason: { kind: 'light_check', score: 0.65 } });
  });
  it('高疲劳拦普通候选但不拦轻复查', () => {
    const ctx = createTestContext(); ctx.store.table('bots').put({ ...botFixture, nextThinkAt: now, lightCheckAt: now });
    for (let i = 0; i < 6; i += 1) ctx.store.log('ledger').append({ id: `le_${String(i).padStart(10, '0')}`, who: botFixture.id, wakeId: null, kind: 'turn', tokens: 1, at: now });
    expect(collectTimeCandidates(ctx, now).map(item => item.variant)).toEqual(['light_check']);
  });
  it('未到最长复查窗口不会因重复扫描滑动或提前生成候选', () => {
    const ctx = createTestContext(); ctx.store.table('bots').put({ ...botFixture, lightCheckAt: now + 48 * HOUR });
    expect(collectTimeCandidates(ctx, now + DAY)).toEqual([]);
    expect(ctx.store.table('bots').get(botFixture.id)?.lightCheckAt).toBe(now + 48 * HOUR);
  });
  it('暂停机器人的到期事项不生成候选', () => {
    const ctx = createTestContext(); ctx.store.table('bots').put({ ...botFixture, lifecycle: 'paused', nextThinkAt: now });
    ctx.store.table('agenda').put(agenda());
    expect(collectTimeCandidates(ctx, now)).toEqual([]);
  });
});

describe('下次思考意图', () => {
  it('at 接受北京时间文本并保留机器人来源', () => {
    expect(apply({ mode: 'at', at: '2026-11-05 12:00', reason: '等更新' })).toMatchObject({
      nextThinkAt: now + 2 * HOUR, nextThinkBy: 'bot', nextThinkMode: 'at', nextThinkReason: '等更新', lightCheckAt: now + 48 * HOUR,
    });
  });
  it('at 接受明确时区的 ISO 时间', () => expect(apply({ mode: 'at', at: '2026-11-05T04:00:00Z', reason: '等更新' }).nextThinkAt).toBe(now + 2 * HOUR));
  it('after 换算分钟并保留模式', () => expect(apply({ mode: 'after', afterMinutes: 90, reason: '等更新' })).toMatchObject({ nextThinkAt: now + 1.5 * HOUR, nextThinkMode: 'after' }));
  it('过早时刻夹到有效最小间隔', () => expect(apply({ mode: 'at', at: '2026-11-05 09:00', reason: '继续' }).nextThinkAt).toBe(now + HOUR));
  it('过长 after 夹到有目标的最大间隔', () => expect(apply({ mode: 'after', afterMinutes: 60 * 100, reason: '等更新' }).nextThinkAt).toBe(now + 48 * HOUR));
  it('无目标时最大间隔为七天', () => expect(applyNextThink(botFixture, { mode: 'after', afterMinutes: 60 * 24 * 10, reason: '等更新' }, now,
    { settings, hasActiveGoal: false }).nextThinkAt).toBe(now + 7 * DAY));
  it('有效最小间隔包含无变化退避', () => expect(applyNextThink({ ...botFixture, noChangeStreak: 2 },
    { mode: 'after', afterMinutes: 1, reason: '继续' }, now, info).nextThinkAt).toBe(now + 4 * HOUR));
  it('yellow 时最小间隔翻倍', () => expect(applyNextThink(botFixture, { mode: 'after', afterMinutes: 1, reason: '继续' }, now,
    { ...info, quotaLight: 'yellow' }).nextThinkAt).toBe(now + 2 * HOUR));
  it('on_event 清除旧预约，仅保留轻复查', () => expect(applyNextThink({ ...botFixture, nextThinkAt: now + HOUR },
    { mode: 'on_event', onEvent: '资料发生变化', reason: '先等新证据' }, now, info)).toMatchObject({ nextThinkAt: null,
    lightCheckAt: now + 48 * HOUR, nextThinkBy: 'bot', nextThinkMode: 'on_event' }));
  it('auto 由中心管理且清除旧预约', () => expect(apply({ mode: 'auto', reason: '无事等待' })).toMatchObject({
    nextThinkAt: null, nextThinkBy: 'hub', nextThinkMode: 'auto', lightCheckAt: now + 48 * HOUR,
  }));
  it('解析失败回退 auto 并返回 warning', () => expect(apply({ mode: 'at', at: '明天下午', reason: '等更新' })).toMatchObject({
    nextThinkAt: null, nextThinkBy: 'hub', nextThinkMode: 'auto', warning: expect.stringContaining('无法解析'),
  }));
  it('缺失 at 字段明确拒绝', () => expect(() => apply({ mode: 'at', reason: '继续' })).toThrow('at 时间'));
  it('缺失 afterMinutes 字段明确拒绝', () => expect(() => apply({ mode: 'after', reason: '继续' })).toThrow('afterMinutes'));
  it('缺失 onEvent 字段明确拒绝', () => expect(() => apply({ mode: 'on_event', reason: '继续' })).toThrow('onEvent'));
  it('空理由拒绝', () => expect(() => apply({ mode: 'auto', reason: '' })).toThrow());
  it('全空白理由也拒绝', () => expect(() => apply({ mode: 'auto', reason: '  \t  ' })).toThrow('理由不能只包含空白'));
  it('负 afterMinutes 拒绝', () => expect(() => apply({ mode: 'after', afterMinutes: -1, reason: '继续' })).toThrow());
  it('纯函数不会修改机器人原对象', () => {
    const bot = structuredClone(botFixture); applyNextThink(bot, { mode: 'auto', reason: '等待' }, now, info);
    expect(bot).toEqual(botFixture);
  });
  it('轻复查锚定最后一次思考而不是本次扫描时间', () => expect(refreshLightCheck({ ...botFixture, lastThinkAt: now - HOUR }, now, settings, true).lightCheckAt).toBe(now + 47 * HOUR));
  it('新思考刷新轻复查时间', () => expect(refreshLightCheck({ ...botFixture, lastThinkAt: now }, now, settings, true).lightCheckAt).toBe(now + 48 * HOUR));
  it('尚未思考过的机器人以创建时间作为复查基线', () => expect(refreshLightCheck({ ...botFixture, createdAt: now - DAY }, now, settings, false).lightCheckAt).toBe(now + 6 * DAY));
});

describe('自建关注项到期', () => {
  it('机器人自建到期即失效并发变更事件', () => {
    const ctx = createTestContext(); ctx.store.table('watches').put({ ...watchFixture, createdBy: 'bot', expiresAt: now });
    expect(expireWatches(ctx, now)).toHaveLength(1);
    expect(ctx.store.table('watches').get(watchFixture.id)?.status).toBe('expired');
    expect(ctx.events).toEqual([{ scope: 'bot', botId: botFixture.id }]);
  });
  it('重复检查已过期关注项不重复变更', () => {
    const ctx = createTestContext(); ctx.store.table('watches').put({ ...watchFixture, createdBy: 'bot', expiresAt: now });
    expireWatches(ctx, now); expect(expireWatches(ctx, now)).toEqual([]); expect(ctx.events).toHaveLength(1);
  });
  it('无显式到期时按自建30天默认处理', () => {
    const ctx = createTestContext(); ctx.store.table('watches').put({ ...watchFixture, createdBy: 'bot', createdAt: now - 30 * DAY });
    expect(expireWatches(ctx, now)[0]?.expiresAt).toBe(now);
  });
  it('尚未到期不会失效', () => {
    const ctx = createTestContext(); ctx.store.table('watches').put({ ...watchFixture, createdBy: 'bot', expiresAt: now + 1 });
    expect(expireWatches(ctx, now)).toEqual([]);
  });
  it.each(['owner', 'hub'] as const)('%s 创建的关注项不会自动撤销', createdBy => {
    const ctx = createTestContext(); ctx.store.table('watches').put({ ...watchFixture, createdBy, expiresAt: now });
    expect(expireWatches(ctx, now)).toEqual([]);
  });
});

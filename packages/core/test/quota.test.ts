/** 额度规则用内存账本与假时钟验收：覆盖分类、灯色、计量、滚窗、校准与单次恢复探针。 */
import { describe, expect, it } from 'vitest';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { resolveSettings } from '../src/config/defaults.js';
import type { QuotaState, WakeTicket } from '../src/model/index.js';
import { classifyError, getQuotaState, computeLight, rollWindow, recordUsage, botUsageToday, botTurnsInWindow,
  onQuotaError, maybeAllowProbe, consumeProbe, onProbeResult } from '../src/quota/index.js';
import { botFixture, id, modelFixtures } from './model-fixtures.js';

const HOUR = 3_600_000;
const MINUTE = 60_000;
const setup = () => {
  const ctx = createTestContext();
  ctx.store.table('bots').put({ ...botFixture });
  return ctx;
};
function state(patch: Partial<QuotaState> = {}): QuotaState {
  return { id: 'quota', windowStartAt: 0, botTurns: 0, botTokens: 0, turnLimit: 10, tokenLimit: null,
    light: 'green', redUntil: null, probeAllowed: false, lastError: null, lastErrorAt: null, ...patch };
}

describe('错误分类', () => {
  it.each(['429 Too Many Requests', 'RATE LIMIT', 'quota exceeded', '额度不足', '余额不足', 'usage limit', '超出用量'])('额度：%s', text => {
    expect(classifyError(text)).toBe('quota');
  });
  it.each(['401', '403', 'Unauthorized', 'invalid api key', '鉴权失败', '认证失败'])('鉴权：%s', text => {
    expect(classifyError(text)).toBe('auth');
  });
  it.each(['ECONNRESET', 'ETIMEDOUT', 'network error', 'fetch failed', 'timed out', '网络错误'])('网络：%s', text => {
    expect(classifyError(text)).toBe('network');
  });
  it('未命中关键词保持 other，混合错误额度优先', () => {
    expect(classifyError('运行结果不正确')).toBe('other');
    expect(classifyError('403 quota')).toBe('quota');
  });
});

describe('额度灯与滚窗', () => {
  it.each([[0, 'green'], [4, 'green'], [5, 'yellow'], [7, 'yellow'], [8, 'orange'], [9, 'orange'], [10, 'red']] as const)(
    '%i / 10 回合为 %s', (turns, light) => expect(computeLight(state({ botTurns: turns }))).toBe(light));
  it('取 token 与回合比率的较大者', () => {
    expect(computeLight(state({ botTurns: 1, botTokens: 800, tokenLimit: 1000 }))).toBe('orange');
    expect(computeLight(state({ botTurns: 8, botTokens: 1, tokenLimit: 1000 }))).toBe('orange');
  });
  it('零容量和红灯恢复期间保持 red', () => {
    expect(computeLight(state({ tokenLimit: 0 }))).toBe('red');
    expect(computeLight(state({ redUntil: 100 }))).toBe('red');
    expect(computeLight(state({ light: 'red' }))).toBe('red');
  });
  it('灯色阈值服从设置覆盖', () => {
    const settings = resolveSettings({ quotaYellowRatio: 0.2, quotaOrangeRatio: 0.4 });
    expect(computeLight(state({ botTurns: 4 }), settings)).toBe('orange');
  });
  it('未开始回合时不会仅因 tick 提前建立窗口', () => {
    const ctx = setup();
    expect(rollWindow(ctx, ctx.clock.now()).botTurns).toBe(0);
    expect(ctx.store.table('quota').get('quota')).toBeNull();
  });
  it('窗口边界前保留，边界整点清零且保留校准限额', () => {
    const ctx = setup(); const now = ctx.clock.now();
    ctx.store.table('quota').put(state({ windowStartAt: now, botTurns: 2, botTokens: 10, turnLimit: 7, tokenLimit: 100 }));
    expect(rollWindow(ctx, now + 5 * HOUR - 1).botTurns).toBe(2);
    expect(rollWindow(ctx, now + 5 * HOUR)).toMatchObject({ botTurns: 0, botTokens: 0, turnLimit: 7, tokenLimit: 100, light: 'green' });
  });
  it('红灯不会被普通滚窗解除', () => {
    const ctx = setup(); const now = ctx.clock.now();
    ctx.store.table('quota').put(state({ windowStartAt: now, light: 'red', redUntil: now + 5 * HOUR + 5 * MINUTE }));
    expect(rollWindow(ctx, now + 6 * HOUR).light).toBe('red');
  });
});

describe('计量与机器人预算统计', () => {
  it('宿主 token 乘 1.2，第一次回合以 startedAt 建立窗口', () => {
    const ctx = setup(); const now = ctx.clock.now();
    ctx.store.table('wakes').put({ ...(modelFixtures.WakeTicket.valid as WakeTicket), startedAt: now - MINUTE });
    const entry = recordUsage(ctx, { botId: botFixture.id, wakeId: id('w'), tokens: 100, steps: 30, packetBytes: 300 });
    expect(entry.tokens).toBe(120);
    expect(getQuotaState(ctx, now)).toMatchObject({ windowStartAt: now - MINUTE, botTurns: 1, botTokens: 120 });
    expect(ctx.store.log('ledger').all()).toHaveLength(1);
  });
  it('缺少 token 时使用包字节和步数估算并向上取整', () => {
    const ctx = setup();
    expect(recordUsage(ctx, { botId: botFixture.id, wakeId: 'estimated', tokens: null, steps: 2, packetBytes: 4 }).tokens).toBe(4802);
  });
  it('并发回合倒序完成，首次窗口仍锚定较早开始但尚在运行的回合', () => {
    const ctx = setup(); const now = ctx.clock.now(); const base = modelFixtures.WakeTicket.valid as WakeTicket;
    ctx.store.table('wakes').put({ ...base, id: 'w_0000000001', startedAt: now - 2 * MINUTE, status: 'running' });
    ctx.store.table('wakes').put({ ...base, id: 'w_0000000002', startedAt: now - MINUTE, status: 'committed', endedAt: now });
    recordUsage(ctx, { botId: botFixture.id, wakeId: 'w_0000000002', tokens: 100, steps: 1, packetBytes: 0 });
    expect(getQuotaState(ctx, now).windowStartAt).toBe(now - 2 * MINUTE);
  });
  it('未投递或未来唤醒单不能成为起窗依据', () => {
    const ctx = setup(); const now = ctx.clock.now(); const base = modelFixtures.WakeTicket.valid as WakeTicket;
    ctx.store.table('wakes').put({ ...base, id: 'w_0000000001', startedAt: now - HOUR, status: 'error', dispatchedAt: null });
    ctx.store.table('wakes').put({ ...base, id: 'w_0000000002', startedAt: now - HOUR, status: 'delivering' });
    ctx.store.table('wakes').put({ ...base, id: 'w_0000000003', startedAt: now + MINUTE, status: 'running', dispatchedAt: now + MINUTE });
    recordUsage(ctx, { botId: botFixture.id, wakeId: 'fallback', tokens: 100, steps: 1, packetBytes: 0 });
    expect(getQuotaState(ctx, now).windowStartAt).toBe(now);
  });
  it('宿主报告零 token 仍用真实零值，不误走估算', () => {
    const ctx = setup();
    expect(recordUsage(ctx, { botId: botFixture.id, wakeId: 'zero', tokens: 0, steps: 20, packetBytes: 600 }).tokens).toBe(0);
  });
  it('同唤醒单幂等记账，不重复扣除额度', () => {
    const ctx = setup(); const input = { botId: botFixture.id, wakeId: 'once', tokens: 100, steps: 1, packetBytes: 10 };
    const first = recordUsage(ctx, input); const second = recordUsage(ctx, input);
    expect(second).toEqual(first);
    expect(getQuotaState(ctx, ctx.clock.now()).botTurns).toBe(1);
    expect(() => recordUsage(ctx, { ...input, botId: 'wrong-bot' })).toThrow('不一致');
  });
  it('非法输入和错配机器人不会落账', () => {
    const ctx = setup(); ctx.store.table('wakes').put(modelFixtures.WakeTicket.valid as WakeTicket);
    expect(() => recordUsage(ctx, { botId: botFixture.id, wakeId: id('w'), tokens: -1, steps: 1, packetBytes: 0 })).toThrow();
    expect(() => recordUsage(ctx, { botId: 'another', wakeId: id('w'), tokens: 1, steps: 1, packetBytes: 0 })).toThrow('不一致');
    expect(ctx.store.log('ledger').all()).toHaveLength(0);
  });
  it('主人发起不计个人预算但仍计入全局额度', () => {
    const ctx = setup(); const now = ctx.clock.now();
    ctx.store.table('wakes').put({ ...(modelFixtures.WakeTicket.valid as WakeTicket), ownerInitiated: true, startedAt: now });
    recordUsage(ctx, { botId: botFixture.id, wakeId: id('w'), tokens: 100, steps: 1, packetBytes: 10 });
    expect(botUsageToday(ctx, botFixture.id, now)).toEqual({ turns: 0, tokens: 0 });
    expect(botTurnsInWindow(ctx, botFixture.id, now)).toBe(0);
    expect(getQuotaState(ctx, now)).toMatchObject({ botTurns: 1, botTokens: 120 });
  });
  it('今日用量按北京时间午夜隔开，不纳入未来账项', () => {
    const ctx = setup();
    ctx.clock.set(Date.parse('2026-11-05T23:59:59+08:00'));
    recordUsage(ctx, { botId: botFixture.id, wakeId: 'old', tokens: 100, steps: 1, packetBytes: 10 });
    ctx.clock.advance(1000);
    recordUsage(ctx, { botId: botFixture.id, wakeId: 'new', tokens: 200, steps: 1, packetBytes: 10 });
    expect(botUsageToday(ctx, botFixture.id, ctx.clock.now())).toEqual({ turns: 1, tokens: 240 });
    expect(botUsageToday(ctx, botFixture.id, ctx.clock.now() - 1000)).toEqual({ turns: 1, tokens: 120 });
  });
  it('窗口回合只统计本窗口且过期未滚动时返回零', () => {
    const ctx = setup(); const now = ctx.clock.now();
    recordUsage(ctx, { botId: botFixture.id, wakeId: 'first', tokens: 10, steps: 1, packetBytes: 0 });
    expect(botTurnsInWindow(ctx, botFixture.id, now)).toBe(1);
    expect(botTurnsInWindow(ctx, botFixture.id, now + 5 * HOUR)).toBe(0);
  });
  it('用量触顶自动 red、全体 resting 并立即开放额度告警', () => {
    const ctx = setup(); const now = ctx.clock.now();
    ctx.store.table('quota').put(state({ windowStartAt: now, botTurns: 7, turnLimit: 8 }));
    recordUsage(ctx, { botId: botFixture.id, wakeId: 'eighth', tokens: 1, steps: 1, packetBytes: 0 });
    expect(getQuotaState(ctx, now)).toMatchObject({ light: 'red', redUntil: now + 5 * HOUR + 5 * MINUTE });
    expect(ctx.store.table('bots').get(botFixture.id)?.activity).toBe('resting');
    expect(ctx.store.table('alerts').list()).toMatchObject([{ code: 'quota', level: 'P0', status: 'open' }]);
  });
});

describe('额度校准与探针', () => {
  it('按报错点校准回合与 token 上限', () => {
    const ctx = setup(); const now = ctx.clock.now();
    ctx.store.table('quota').put(state({ windowStartAt: now - HOUR, botTurns: 7, botTokens: 1001 }));
    expect(onQuotaError(ctx, now)).toMatchObject({ turnLimit: 6, tokenLimit: 900, light: 'red', redUntil: now + 4 * HOUR + 5 * MINUTE });
  });
  it('校准回合有最低二次，零 token 样本保留未知上限', () => {
    const ctx = setup();
    expect(onQuotaError(ctx, ctx.clock.now())).toMatchObject({ turnLimit: 2, tokenLimit: null });
  });
  it('额度错误用显式 now 写告警，和校准时刻一致', () => {
    const ctx = setup(); const now = ctx.clock.now() + HOUR;
    const quota = onQuotaError(ctx, now);
    expect(ctx.store.table('alerts').list()[0]).toMatchObject({ firstAt: now, lastAt: now });
    expect(quota.lastErrorAt).toBe(now);
  });
  it('窗口加宽限前不放探针，到点只授予一次', () => {
    const ctx = setup(); const state = onQuotaError(ctx, ctx.clock.now());
    expect(maybeAllowProbe(ctx, state.redUntil! - 1)).toBe(false);
    expect(maybeAllowProbe(ctx, state.redUntil!)).toBe(true);
    expect(maybeAllowProbe(ctx, state.redUntil!)).toBe(false);
    expect(getQuotaState(ctx, state.redUntil!)).toMatchObject({ probeAllowed: true, botTurns: 0, botTokens: 0, light: 'red' });
  });
  it('探针消费原子且在途期间不能再次授予', () => {
    const ctx = setup(); const state = onQuotaError(ctx, ctx.clock.now());
    maybeAllowProbe(ctx, state.redUntil!);
    expect(consumeProbe(ctx)).toBe(true);
    expect(consumeProbe(ctx)).toBe(false);
    expect(maybeAllowProbe(ctx, state.redUntil! + 10 * HOUR)).toBe(false);
  });
  it('探针成功绿灯并关闭告警、恢复额度休息展示', () => {
    const ctx = setup(); const quota = onQuotaError(ctx, ctx.clock.now());
    ctx.clock.set(quota.redUntil!); maybeAllowProbe(ctx, ctx.clock.now()); consumeProbe(ctx);
    expect(onProbeResult(ctx, true).light).toBe('green');
    expect(ctx.store.table('alerts').list()[0]?.status).toBe('closed');
    expect(ctx.store.table('bots').get(botFixture.id)?.activity).toBe('watching');
  });
  it('探针失败再等完整窗口及宽限', () => {
    const ctx = setup(); onQuotaError(ctx, ctx.clock.now()); ctx.clock.advance(6 * HOUR);
    maybeAllowProbe(ctx, ctx.clock.now()); consumeProbe(ctx);
    const result = onProbeResult(ctx, false);
    expect(result.redUntil).toBe(ctx.clock.now() + 5 * HOUR + 5 * MINUTE);
    expect(result.light).toBe('red');
    expect(maybeAllowProbe(ctx, result.redUntil! - 1)).toBe(false);
  });
  it('未授权、未消费及重复探针结果拒绝，不能绕过红灯等待', () => {
    const ctx = setup(); const state = onQuotaError(ctx, ctx.clock.now());
    expect(() => onProbeResult(ctx, true)).toThrow('没有已消费');
    expect(getQuotaState(ctx, ctx.clock.now())).toEqual(state);
    ctx.clock.set(state.redUntil!); maybeAllowProbe(ctx, ctx.clock.now());
    expect(() => onProbeResult(ctx, true)).toThrow('没有已消费');
    expect(getQuotaState(ctx, ctx.clock.now()).probeAllowed).toBe(true);
    consumeProbe(ctx); onProbeResult(ctx, true);
    expect(() => onProbeResult(ctx, true)).toThrow('没有已消费');
    expect(getQuotaState(ctx, ctx.clock.now()).light).toBe('green');
  });
  it('绿灯不授予探针，也不消费不存在的许可', () => {
    const ctx = setup();
    expect(maybeAllowProbe(ctx, ctx.clock.now())).toBe(false);
    expect(consumeProbe(ctx)).toBe(false);
  });
});

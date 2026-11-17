/**
 * P76d 测试五：额度文字的唯一出口（api/quota-views.ts）。
 *
 * 四种状态（正常、员工份额用完、真实额度用完、你自己要用）的恢复时间、灯名称、灯说明逐字对照；「约几回合」样本足与不足；
 * 三段条相加为 1；留出比例的写法；进度行、员工文字、总览读的是同一个视图。时间只用注入的假时钟或固定时刻。
 */
import { describe, expect, it } from 'vitest';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { createUiApi } from '../src/api/index.js';
import { QuotaWindowViewSchema, buildQuotaWindowView, quotaWindowView, tokensPerTurnOf, type QuotaViewInput } from '../src/api/quota-views.js';
import { jobDelayNote } from '../src/job/delay.js';
import { resolveSettings, BUDGET_DEFAULTS } from '../src/config/defaults.js';
import type { HubContext } from '../src/engine/context.js';
import type { QuotaState } from '../src/model/index.js';
import { QUOTA_LIGHT_LABELS } from '../src/model/enums.js';
import type { QuotaPlan } from '../src/model/quota-plan.js';
import { defaultQuotaPlan } from '../src/quota/plan.js';
import { quotaProtectionText, recordUsage } from '../src/quota/index.js';
import { botFixture } from './model-fixtures.js';
import { addWake } from './p76c-fixtures.js';
import { MINUTE, assigned, jobFix } from './p74c-fixtures.js';

const HOUR = 60 * MINUTE;
const at = (text: string) => Date.parse(`${text}+08:00`);
/** 固定时刻：14:30；窗口起点 13:30，所以本窗口 18:30 结束。 */
const NOW = at('2026-11-13T14:30:00');
const WINDOW_START = NOW - HOUR;
const WINDOW_END = WINDOW_START + 5 * HOUR;

const settings = resolveSettings();
function quotaOf(patch: Partial<QuotaState> = {}): QuotaState {
  return { id: 'quota', windowStartAt: WINDOW_START, botTurns: 0, botTokens: 0, turnLimit: 40, tokenLimit: null, light: 'green', redUntil: null,
    probeAllowed: false, lastError: null, lastErrorAt: null, ...patch };
}
function planOf(patch: Partial<QuotaPlan> = {}): QuotaPlan {
  return { ...defaultQuotaPlan(NOW, WINDOW_START), capacityTokens: 10_000_000, ...patch };
}
/** 每个员工回合按 10 万 token 算（容量 1000 万、份额 0.7 -> 员工份额 700 万 = 70 回合）。 */
function view(input: Partial<QuotaViewInput> & { plan?: QuotaPlan; quota?: QuotaState }) {
  return buildQuotaWindowView({ plan: planOf(), quota: quotaOf(), hasWindow: true, settings, now: NOW, tokensPerTurn: 100_000, ...input });
}
const INTERNAL = /hub_|b_[0-9a-z]{10}|job_|agr_|jev_|token|quota|exhausted|staff_full/i;
const textsOf = (v: ReturnType<typeof view>) => [v.resetText, v.staffUsedTurnsText, v.staffLeftTurnsText, v.reserveText, v.holdText ?? '', v.lightLabel, v.lightHint, v.waitText ?? ''];

describe('1 四种状态：恢复时间、灯名称、灯说明逐字', () => {
  it('正常（绿）：本窗口 18:30 重置；员工已用 0、还可用约 70 回合；给你留出三成；额度充足；员工按正常节奏开工', () => {
    expect(view({})).toEqual({
      state: 'normal', light: 'green', resetAt: WINDOW_END, resetText: '18:30 重置',
      staffUsedTurnsText: '员工已用约 0 回合', staffLeftTurnsText: '员工还可用约 70 回合', reserveText: '给你留出三成', holdText: null,
      // P86：新增的两项（本窗口员工已用 token 的文字与原始数字）；这一例没有用量，写 0。
      staffUsedTokensText: '0 token', staffUsedTokens: 0,
      barParts: { staffUsed: 0, staffLeft: 0.7, reserved: expect.closeTo(0.3, 10) },
      lightLabel: '额度充足', lightHint: '员工按正常节奏开工。', waitText: null,
    });
  });
  it('正常（黄、橙）：灯名称与说明逐字；仍是 normal，不挡人', () => {
    const yellow = view({ plan: planOf({ staffTokens: 3_500_000 }), quota: quotaOf({ light: 'yellow' }) });
    expect(yellow).toMatchObject({ state: 'normal', light: 'yellow', lightLabel: '额度过半', lightHint: '员工份额用过一半，员工自己发起的工作放慢节奏。',
      staffUsedTurnsText: '员工已用约 35 回合', staffLeftTurnsText: '员工还可用约 35 回合', waitText: null });
    const orange = view({ plan: planOf({ staffTokens: 5_600_000 }), quota: quotaOf({ light: 'orange' }) });
    expect(orange).toMatchObject({ state: 'normal', light: 'orange', lightLabel: '额度紧张', lightHint: '员工份额用到八成，只有你交代的事和你发起的对话继续。',
      staffUsedTurnsText: '员工已用约 56 回合', staffLeftTurnsText: '员工还可用约 14 回合', waitText: null });
  });
  it('员工份额用完（红 staff_full）：18:30 重置；已到上限；员工份额已用完；员工在 18:30 前不开新回合；你发起的对话不受影响', () => {
    const v = view({ plan: planOf({ staffTokens: 7_000_000 }), quota: quotaOf({ light: 'red', redUntil: WINDOW_END }) });
    expect(v).toMatchObject({ state: 'staff_full', light: 'red', resetAt: WINDOW_END, resetText: '18:30 重置', staffUsedTurnsText: '员工已用约 70 回合',
      staffLeftTurnsText: '已到上限', lightLabel: '员工份额已用完', lightHint: '员工在 18:30 前不开新回合；你发起的对话不受影响。',
      waitText: '额度恢复，约 18:30 继续', holdText: null });
  });
  it('真实额度用完（红 exhausted）且恢复时间来自报错正文：约 18:25 恢复；额度已用完；约 18:25 恢复，到时先试一个回合。', () => {
    const exhausted = { at: NOW, resetAt: at('2026-11-13T18:20:00'), resetFromText: true };
    const v = view({ plan: planOf({ exhausted, staffTokens: 1_000_000 }), quota: quotaOf({ light: 'red', redUntil: at('2026-11-13T18:25:00') }) });
    expect(v).toMatchObject({ state: 'exhausted', light: 'red', resetAt: at('2026-11-13T18:25:00'), resetText: '约 18:25 恢复', staffLeftTurnsText: '已到上限',
      lightLabel: '额度已用完', lightHint: '约 18:25 恢复，到时先试一个回合。', waitText: '额度恢复，约 18:25 继续' });
  });
  it('真实额度用完而恢复时间是估计的：约 18:25 恢复（估计）；说明里同样带「（估计）」', () => {
    const exhausted = { at: NOW, resetAt: at('2026-11-13T18:20:00'), resetFromText: false };
    const v = view({ plan: planOf({ exhausted }), quota: quotaOf({ light: 'red', redUntil: at('2026-11-13T18:25:00') }) });
    expect(v).toMatchObject({ resetText: '约 18:25 恢复（估计）', lightHint: '约 18:25 恢复（估计），到时先试一个回合。' });
  });
  it('你自己要用：你要自己用到 16:30，员工不开新回合；灯名称按灯，说明前加「你要自己用到 16:30。」；进度行写到 16:30 继续', () => {
    const v = view({ plan: planOf({ ownerHoldUntil: at('2026-11-13T16:30:00') }) });
    expect(v).toMatchObject({ state: 'owner_hold', light: 'green', holdText: '你要自己用到 16:30，员工不开新回合', lightLabel: '额度充足',
      lightHint: '你要自己用到 16:30。员工按正常节奏开工。', waitText: '额度恢复，约 16:30 继续', resetText: '18:30 重置' });
    const orange = view({ plan: planOf({ ownerHoldUntil: at('2026-11-13T16:30:00'), staffTokens: 5_600_000 }), quota: quotaOf({ light: 'orange' }) });
    expect(orange).toMatchObject({ lightLabel: '额度紧张', lightHint: '你要自己用到 16:30。员工份额用到八成，只有你交代的事和你发起的对话继续。' });
  });
  it('到点之后（now 等于截止时刻）不再是你自己要用', () => {
    const v = view({ plan: planOf({ ownerHoldUntil: NOW }) });
    expect(v).toMatchObject({ state: 'normal', holdText: null, waitText: null });
  });
  it('状态叠加：真实额度用完优先于员工份额用完，再优先于你自己要用；等待说明取较晚的恢复时刻', () => {
    const exhausted = { at: NOW, resetAt: at('2026-11-13T17:00:00'), resetFromText: true };
    const both = view({ plan: planOf({ exhausted, ownerHoldUntil: at('2026-11-13T20:00:00') }), quota: quotaOf({ light: 'red', redUntil: at('2026-11-13T17:05:00') }) });
    expect(both.state).toBe('exhausted');
    expect(both.holdText).toBe('你要自己用到 20:00，员工不开新回合');
    expect(both.waitText).toBe('额度恢复，约 20:00 继续');
    const fullAndHold = view({ plan: planOf({ staffTokens: 7_000_000, ownerHoldUntil: at('2026-11-13T16:00:00') }), quota: quotaOf({ light: 'red', redUntil: WINDOW_END }) });
    expect(fullAndHold.state).toBe('staff_full');
    expect(fullAndHold.waitText).toBe('额度恢复，约 18:30 继续');
  });
  it('跨日的时刻写「{M}月{D}日 HH:mm」', () => {
    const v = view({ plan: planOf({ exhausted: { at: NOW, resetAt: at('2026-11-14T02:20:00'), resetFromText: true } }),
      quota: quotaOf({ light: 'red', redUntil: at('2026-11-14T02:25:00') }) });
    expect(v.resetText).toBe('约 11月14日 02:25 恢复');
    expect(v.waitText).toBe('额度恢复，约 11月14日 02:25 继续');
  });
  it('还没有额度窗口（没有任何回合）：不写恢复时刻', () => {
    expect(view({ hasWindow: false })).toMatchObject({ resetAt: null, resetText: '', state: 'normal', waitText: null });
  });
  it('所有状态的文字都不含内部编号、英文标识或 token 字样，并通过视图结构校验', () => {
    const exhausted = { at: NOW, resetAt: at('2026-11-13T18:20:00'), resetFromText: true };
    const all = [view({}), view({ plan: planOf({ staffTokens: 7_000_000 }), quota: quotaOf({ light: 'red', redUntil: WINDOW_END }) }),
      view({ plan: planOf({ exhausted }), quota: quotaOf({ light: 'red', redUntil: at('2026-11-13T18:25:00') }) }),
      view({ plan: planOf({ ownerHoldUntil: at('2026-11-13T16:30:00') }) })];
    for (const item of all) {
      expect(() => QuotaWindowViewSchema.parse(item)).not.toThrow();
      for (const text of textsOf(item)) expect(text, text).not.toMatch(INTERNAL);
    }
  });
});

describe('2 三段条与留出比例', () => {
  it('三段相加为 1：员工份额各种已用比例、份额各种取值', () => {
    for (const share of [0.9, 0.7, 0.6, 0.5, 0.35]) for (const staffTokens of [0, 1, 1_234_567, 3_000_000, 6_999_999, 9_999_999]) {
      const v = view({ settings: { ...settings, botQuotaShare: share }, plan: planOf({ staffTokens }) });
      expect(v.barParts.staffUsed + v.barParts.staffLeft + v.barParts.reserved).toBeCloseTo(1, 10);
      expect(v.barParts.reserved).toBeCloseTo(1 - share, 10);
      expect(Math.min(v.barParts.staffUsed, v.barParts.staffLeft, v.barParts.reserved)).toBeGreaterThanOrEqual(0);
    }
  });
  it('员工份额用满：已用段等于员工份额，剩余段为 0；超出也不超过员工份额；容量 0 视为用满', () => {
    expect(view({ plan: planOf({ staffTokens: 9_000_000 }) }).barParts).toEqual({ staffUsed: 0.7, staffLeft: 0, reserved: expect.closeTo(0.3, 10) });
    expect(view({ plan: planOf({ capacityTokens: 0 }) }).barParts).toEqual({ staffUsed: 0.7, staffLeft: 0, reserved: expect.closeTo(0.3, 10) });
  });
  it.each([[0.9, '给你留出一成'], [0.7, '给你留出三成'], [0.5, '给你留出五成'], [0.6, '给你留出 40%'], [0.8, '给你留出 20%'], [0.35, '给你留出 65%']] as const)(
    '份额 %s：%s', (share, text) => {
      expect(view({ settings: { ...settings, botQuotaShare: share } }).reserveText).toBe(text);
    });
});

describe('3 「约几回合」：最近员工回合实测 token 的中位数，样本不足用默认值', () => {
  /** 记 n 笔员工发起回合的实测 token（经真实的记账入口，账本里是宿主实测）。 */
  function record(ctx: HubContext, tokens: number[], patch: Parameters<typeof addWake>[1] = {}) {
    for (const value of tokens) {
      const wake = addWake(ctx, patch, botFixture.id);
      recordUsage(ctx, { botId: botFixture.id, wakeId: wake.id, tokens: value, steps: 1, packetBytes: 0 });
    }
  }
  const fresh = () => { const ctx = createTestContext(); ctx.store.table('bots').put({ ...botFixture }); return ctx; };

  it('样本不足 5 个：用默认值（20 万）；达到 5 个：用中位数', () => {
    const ctx = fresh();
    record(ctx, [50_000, 60_000, 70_000, 80_000]);
    expect(tokensPerTurnOf(ctx)).toBe(BUDGET_DEFAULTS.TOKENS_PER_TURN_FALLBACK);
    record(ctx, [90_000]);
    expect(tokensPerTurnOf(ctx)).toBe(70_000);
  });
  it('偶数个样本取中间两个的平均；只取最近 20 个；你发起的回合和主题回合不进样本', () => {
    const ctx = fresh();
    record(ctx, [1_000_000, 1_000_000, 1_000_000]); // 较早的：只要超过 20 个就被挤出
    record(ctx, Array.from({ length: 20 }, (_, index) => (index < 10 ? 100_000 : 200_000)));
    expect(tokensPerTurnOf(ctx)).toBe(150_000);
    record(ctx, [9_000_000, 9_000_000, 9_000_000], { ownerInitiated: true });
    record(ctx, [9_000_000, 9_000_000, 9_000_000], { topicId: 'ptp_0000000001' });
    expect(tokensPerTurnOf(ctx)).toBe(150_000);
  });
  it('记账值（乘 1.2）不进样本：用的是账本里的实测 token', () => {
    const ctx = fresh();
    record(ctx, [100_000, 100_000, 100_000, 100_000, 100_000]);
    expect(tokensPerTurnOf(ctx)).toBe(100_000);
  });
  it('视图里的「约几回合」用同一个中位数：员工用了 300 万，中位数 10 万 -> 约 30 回合；样本不足时按 20 万 -> 约 15 回合', () => {
    const enough = fresh();
    record(enough, [100_000, 100_000, 100_000, 100_000, 100_000]);
    enough.store.table('quotaWindows').patch('quota', { staffTokens: 3_000_000 });
    expect(quotaWindowView(enough, enough.clock.now()).staffUsedTurnsText).toBe('员工已用约 30 回合');
    const few = fresh();
    record(few, [100_000]);
    few.store.table('quotaWindows').patch('quota', { staffTokens: 3_000_000 });
    expect(quotaWindowView(few, few.clock.now()).staffUsedTurnsText).toBe('员工已用约 15 回合');
  });
  it('P86：员工已用 token 的文字按 P80 的单位换算、原始数字取整给悬停用；与回合数同源', () => {
    // 员工已用 176 万：文字 1.76M token，原始数字 1760000，回合数仍按每回合 10 万算 -> 约 18 回合。
    const v = view({ plan: planOf({ staffTokens: 1_760_000 }), quota: quotaOf({ light: 'yellow' }) });
    expect(v.staffUsedTokensText).toBe('1.76M token');
    expect(v.staffUsedTokens).toBe(1_760_000);
    expect(v.staffUsedTurnsText).toBe('员工已用约 18 回合');
    // 不足 1000 原样写数字；千位进 K；小数取整；零写 0 token。
    expect(view({ plan: planOf({ staffTokens: 999 }) }).staffUsedTokensText).toBe('999 token');
    expect(view({ plan: planOf({ staffTokens: 380_400 }) }).staffUsedTokensText).toBe('380K token');
    expect(view({ plan: planOf({ staffTokens: 1_500.4 }) })).toMatchObject({ staffUsedTokensText: '1.5K token', staffUsedTokens: 1_500 });
    expect(view({ plan: planOf({ staffTokens: 0 }) })).toMatchObject({ staffUsedTokensText: '0 token', staffUsedTokens: 0 });
  });
  it('P86 反例：非法的用量（负数、非有限数）按 0 写，不出现 NaN 或负号', () => {
    for (const bad of [-5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const v = view({ plan: planOf({ staffTokens: bad }) });
      expect(v.staffUsedTokensText).toBe('0 token');
      expect(v.staffUsedTokens).toBe(0);
    }
  });
  it('把「已用约几回合」和「还可用约几回合」的换算分开核对：份额 700 万、已用 300 万、每回合 20 万 -> 已用 15、还可用 20', () => {
    const v = view({ plan: planOf({ staffTokens: 3_000_000 }), tokensPerTurn: 200_000, quota: quotaOf({ light: 'yellow' }) });
    expect(v.staffUsedTurnsText).toBe('员工已用约 15 回合');
    expect(v.staffLeftTurnsText).toBe('员工还可用约 20 回合');
  });
});

describe('4 几处文字读的是同一个视图', () => {
  it('在办的事被额度挡住时，进度行的延迟说明返回视图的 waitText（员工份额用完、你自己要用各一例）；不挡时不写额度', async () => {
    const fix = await jobFix();
    const { job } = await assigned(fix);
    const now = fix.ctx.clock.now();
    // 先把「放行间隔」「启动静默」之类无关的拦截排除掉，只留额度：推进到启动静默之后（每次不超过 10 分钟）。
    fix.ctx.runtime.startedAt = now - 10 * MINUTE;
    expect(jobDelayNote(fix.ctx, job, now) ?? '').not.toContain('额度');
    // 员工份额用完（红 staff_full）。
    fix.ctx.store.table('quota').put({ id: 'quota', windowStartAt: now - HOUR, botTurns: 0, botTokens: 0, turnLimit: 40, tokenLimit: null,
      light: 'red', redUntil: now - HOUR + 5 * HOUR, probeAllowed: false, lastError: null, lastErrorAt: null });
    fix.ctx.store.table('quotaWindows').put({ ...defaultQuotaPlan(now, now - HOUR), capacityTokens: 1_000_000, staffTokens: 700_000 });
    const expectedFull = quotaWindowView(fix.ctx, now).waitText;
    expect(expectedFull).toMatch(/^额度恢复，约 \d\d:\d\d 继续$/);
    expect(jobDelayNote(fix.ctx, job, now)).toBe(expectedFull);
    // 你自己要用：灯是绿的，但在这段时间员工不开新回合。
    fix.ctx.store.table('quota').put({ ...fix.ctx.store.table('quota').get('quota')!, light: 'green', redUntil: null });
    fix.ctx.store.table('quotaWindows').put({ ...defaultQuotaPlan(now, now - HOUR), ownerHoldUntil: now + 2 * HOUR });
    const hm = new Date(now + 2 * HOUR + 8 * HOUR).toISOString().slice(11, 16);
    expect(jobDelayNote(fix.ctx, job, now)).toBe(`额度恢复，约 ${hm} 继续`);
  });

  it('员工因额度休息的文字、总览的额度字段、视图是同一套：员工文字是「在等额度恢复，约 HH:mm 继续」，总览带 window 且原字段保留', () => {
    const ctx = createTestContext();
    ctx.store.table('bots').put({ ...botFixture, lifecycle: 'active', activity: 'watching', activityText: '继续关注变化' });
    const api = createUiApi(ctx, async () => undefined);
    const empty = api.overview().quota;
    expect(empty).toMatchObject({ light: 'green', resetAt: null });
    expect(empty.window).toMatchObject({ state: 'normal', resetAt: null, resetText: '' });
    const now = ctx.clock.now();
    ctx.store.table('quota').put({ id: 'quota', windowStartAt: now, botTurns: 3, botTokens: 360, turnLimit: 40, tokenLimit: null,
      light: 'red', redUntil: now + 5 * HOUR + 5 * MINUTE, probeAllowed: false, lastError: '额度不足', lastErrorAt: now });
    ctx.store.table('quotaWindows').put({ ...defaultQuotaPlan(now), exhausted: { at: now, resetAt: now + 5 * HOUR, resetFromText: false } });
    const overview = api.overview();
    expect(overview.quota).toMatchObject({ light: 'red', lightLabel: QUOTA_LIGHT_LABELS.red, usedText: expect.stringContaining('3 / 40 回合') });
    expect(overview.quota.window).toEqual(quotaWindowView(ctx, now));
    expect(overview.quota.window!.state).toBe('exhausted');
    const text = quotaProtectionText(ctx.store.table('quota').get('quota')!, now, ctx.settings.timezone);
    expect(text).toMatch(/^在等额度恢复，约 \d\d:\d\d 继续$/);
  });
});

/**
 * P76d 测试一：额度记账、员工份额的灯、窗口滚动、容量回升。
 *
 * 夹具与真实情况一致：总管是自动创建的那一位（听吩咐、安静节奏），执行员工听吩咐，另有一位不听吩咐的调研员。
 * 每条用例写明：窗口估计容量、员工份额比例（默认 0.7）、已用的员工 token 与你一侧的 token。时间只用注入的假时钟，
 * 跨窗口的用例直接把假时钟设到目标时刻（不逐步推进）。
 * 断言的是机制本身：灯不是「碰巧」亮的，每一条灯色用例都直接给出员工份额的已用量。
 */
import { describe, expect, it } from 'vitest';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import type { HubContext } from '../src/engine/context.js';
import type { Bot, QuotaState, WakeTicket } from '../src/model/index.js';
import type { QuotaPlan } from '../src/model/quota-plan.js';
import { BUDGET_DEFAULTS, resolveSettings } from '../src/config/defaults.js';
import { beginQuotaWindow, getQuotaState, recordUsage, rollWindow } from '../src/quota/index.js';
import { calibrateCapacity, computeStaffLight, defaultQuotaPlan, getQuotaPlan, isOwnerSide, raiseCapacityToUsage,
  recoverCapacity, windowHadError } from '../src/quota/plan.js';
import { retroSubjectKey } from '../src/skill/keys.js';
import { pushHistory } from '../src/outreach/push.js';
import { botFixture } from './model-fixtures.js';
import { addWake } from './p76c-fixtures.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const JOB_ID = 'job_0000000001';

/** 三位员工：自动创建的总管、执行员工（都听吩咐）、不听吩咐的调研员。 */
function world() {
  const ctx = createTestContext();
  ctx.runtime.startedAt = ctx.clock.now() - 10 * MINUTE;
  const base: Bot = { ...botFixture, createdAt: ctx.clock.now(), updatedAt: ctx.clock.now(), lifecycle: 'active', activity: 'watching', activityText: '继续关注变化' };
  const chief: Bot = { ...base, id: 'b_0000000010', name: '总管', role: 'chief', onDemand: true, pace: 'quiet', homeDir: '/hub/bots/b_0000000010' };
  const executor: Bot = { ...base, id: 'b_0000000011', name: '执行员', role: 'executor', onDemand: true, homeDir: '/hub/bots/b_0000000011' };
  const researcher: Bot = { ...base, id: 'b_0000000012', name: '调研员', role: 'researcher', onDemand: false, homeDir: '/hub/bots/b_0000000012' };
  for (const bot of [chief, executor, researcher]) ctx.store.table('bots').put(bot);
  return { ctx, chief, executor, researcher };
}

/** 写入额度单例和额度记录（窗口起点都是 now）；patch 覆盖其中的字段。 */
function seed(ctx: HubContext, plan: Partial<QuotaPlan> = {}, quota: Partial<QuotaState> = {}): { now: number } {
  const now = ctx.clock.now();
  ctx.store.table('quota').put({ id: 'quota', windowStartAt: now, botTurns: 0, botTokens: 0, turnLimit: 40, tokenLimit: null,
    light: 'green', redUntil: null, probeAllowed: false, lastError: null, lastErrorAt: null, ...quota });
  ctx.store.table('quotaWindows').put({ ...defaultQuotaPlan(now), ...plan });
  return { now };
}

/** 给一张已写好的唤醒单记一笔实测 token。 */
function usage(ctx: HubContext, wake: WakeTicket, tokens: number | null, extra: { steps?: number; packetBytes?: number } = {}) {
  return recordUsage(ctx, { botId: wake.botId, wakeId: wake.id, tokens, steps: extra.steps ?? 1, packetBytes: extra.packetBytes ?? 0 });
}

const capacityAudit = (ctx: HubContext) => ctx.store.log('audit').all().filter(row => row.action === 'quota_capacity_change')
  .map(row => JSON.parse(row.detail) as { from: number; to: number; basis: string });

describe('1 记账：两类累加、只用实测 token', () => {
  it.each([
    ['你发起的回合（ownerInitiated）', { ownerInitiated: true }, 'owner'],
    ['主题回合（topicId）', { topicId: 'ptp_0000000001' }, 'owner'],
    ['你发起的教学回合', { ownerInitiated: true, variant: 'teach' as const }, 'owner'],
    ['执行链回合（jobId）', { jobId: JOB_ID }, 'staff'],
    ['总管派活（chiefDispatch）', { chiefDispatch: true }, 'staff'],
    ['复盘类回合（事项键 retro:）', { variant: 'reflection' as const, subjectKey: retroSubjectKey('sr_0000000001', 'b_0000000012') }, 'staff'],
    ['员工自己发起的回合', {}, 'staff'],
  ] as const)('%s 记在「%s」一侧', (_name, patch, side) => {
    const { ctx, researcher } = world();
    const wake = addWake(ctx, patch as Partial<WakeTicket>, researcher.id);
    expect(isOwnerSide(wake)).toBe(side === 'owner');
    usage(ctx, wake, 4_000);
    const plan = getQuotaPlan(ctx, ctx.clock.now());
    expect(plan).toMatchObject(side === 'owner'
      ? { ownerTokens: 4_000, ownerTurns: 1, staffTokens: 0, staffTurns: 0 }
      : { staffTokens: 4_000, staffTurns: 1, ownerTokens: 0, ownerTurns: 0 });
  });

  it('只用实测 token（tokenBase），不用乘了 1.2 的记账值：实测 100000、账本记账 120000，员工一侧加 100000', () => {
    const { ctx, researcher } = world();
    const wake = addWake(ctx, {}, researcher.id);
    const entry = usage(ctx, wake, 100_000);
    expect(entry).toMatchObject({ tokenBase: 100_000, tokens: 120_000 });
    expect(getQuotaPlan(ctx, ctx.clock.now()).staffTokens).toBe(100_000);
    // 旧的额度单例仍按记账值写（旧版本读得懂）。
    expect(getQuotaState(ctx, ctx.clock.now()).botTokens).toBe(120_000);
  });

  it('宿主没报 token 时按估算值向上取整记入（估算有小数）', () => {
    const { ctx, researcher } = world();
    const wake = addWake(ctx, {}, researcher.id);
    const entry = usage(ctx, wake, null, { steps: 3, packetBytes: 7 });
    const base = 7 / ctx.settings.estimatedBytesPerToken + 3 * ctx.settings.estimatedTokensPerStep;
    expect(entry.tokenBase).toBe(base);
    expect(getQuotaPlan(ctx, ctx.clock.now()).staffTokens).toBe(Math.ceil(base));
  });

  it('同一唤醒单重复记账不重复累加；多笔累加', () => {
    const { ctx, researcher } = world();
    const first = addWake(ctx, {}, researcher.id);
    const second = addWake(ctx, { ownerInitiated: true }, researcher.id);
    usage(ctx, first, 1_000); usage(ctx, first, 1_000);
    usage(ctx, second, 2_500);
    expect(getQuotaPlan(ctx, ctx.clock.now())).toMatchObject({ staffTokens: 1_000, staffTurns: 1, ownerTokens: 2_500, ownerTurns: 1 });
  });

  it('窗口滚动：两张表同一时刻清零，borrowJobIds 清空，窗口起点同步；滚动之前（差 1 毫秒）都不动', () => {
    const { ctx } = world();
    const { now } = seed(ctx, { staffTokens: 900, ownerTokens: 400, staffTurns: 3, ownerTurns: 2, borrowJobIds: [JOB_ID] },
      { botTurns: 5, botTokens: 1_300 });
    rollWindow(ctx, now + 5 * HOUR - 1);
    expect(getQuotaPlan(ctx, now)).toMatchObject({ staffTokens: 900, ownerTokens: 400, borrowJobIds: [JOB_ID] });
    expect(getQuotaState(ctx, now).botTurns).toBe(5);
    ctx.clock.set(now + 5 * HOUR);
    rollWindow(ctx, now + 5 * HOUR);
    expect(getQuotaPlan(ctx, now)).toMatchObject({ staffTokens: 0, ownerTokens: 0, staffTurns: 0, ownerTurns: 0, borrowJobIds: [] });
    expect(getQuotaState(ctx, now)).toMatchObject({ botTurns: 0, botTokens: 0, light: 'green' });
    // 新窗口的第一笔回合开始时，两处的窗口起点一起变成这个回合的开始时刻。
    beginQuotaWindow(ctx, now + 5 * HOUR + MINUTE);
    expect(getQuotaState(ctx, now).windowStartAt).toBe(now + 5 * HOUR + MINUTE);
    expect(getQuotaPlan(ctx, now).windowStartAt).toBe(now + 5 * HOUR + MINUTE);
  });

  it('滚动不清 exhausted（真实额度用完要等探针）：隔了两个窗口灯仍是红，exhausted 还在', () => {
    const { ctx } = world();
    const { now } = seed(ctx, { exhausted: { at: now0(ctx), resetAt: now0(ctx) + HOUR, resetFromText: true }, staffTokens: 10 },
      { light: 'red', redUntil: now0(ctx) + HOUR + 5 * MINUTE, lastError: '额度不足', lastErrorAt: now0(ctx) });
    ctx.clock.set(now + 11 * HOUR);
    expect(rollWindow(ctx, now + 11 * HOUR)).toMatchObject({ light: 'red' });
    expect(getQuotaPlan(ctx, now).exhausted).toEqual({ at: now, resetAt: now + HOUR, resetFromText: true });
    expect(getQuotaPlan(ctx, now).staffTokens).toBe(10);
  });
});

/** seed 之前先取当前假时钟的时刻（写 exhausted 用）。 */
function now0(ctx: HubContext): number { return ctx.clock.now(); }

describe('2 灯：按员工份额已用比例；红灯分两种', () => {
  const settings = resolveSettings();
  const plan = (patch: Partial<QuotaPlan>): QuotaPlan => ({ ...defaultQuotaPlan(0), capacityTokens: 10_000_000, ...patch });
  const idle = { probeAllowed: false } as const;

  it.each([
    // 容量 1000 万、份额 0.7、员工份额 700 万
    [0, 'green', null], [3_499_999, 'green', null], [3_500_000, 'yellow', null], [5_599_999, 'yellow', null],
    [5_600_000, 'orange', null], [6_999_999, 'orange', null], [7_000_000, 'red', 'staff_full'], [9_000_000, 'red', 'staff_full'],
  ] as const)('容量 1000 万、份额 0.7：员工已用 %i token 为 %s %s', (staffTokens, light, redKind) => {
    expect(computeStaffLight(plan({ staffTokens }), idle, settings)).toEqual({ light, redKind });
  });

  it('你发起的用了 900 万、员工 0：绿灯（你发起的回合不改变员工份额比例）', () => {
    expect(computeStaffLight(plan({ ownerTokens: 9_000_000, staffTokens: 0 }), idle, settings)).toEqual({ light: 'green', redKind: null });
  });

  it('真实额度用完（exhausted 不为空）、探针已放行、探针在途：都是红灯 exhausted，哪怕员工份额一点没用', () => {
    const exhausted = { at: 1, resetAt: 2, resetFromText: false };
    expect(computeStaffLight(plan({ exhausted }), idle, settings)).toEqual({ light: 'red', redKind: 'exhausted' });
    expect(computeStaffLight(plan({}), { probeAllowed: true }, settings)).toEqual({ light: 'red', redKind: 'exhausted' });
    expect(computeStaffLight(plan({}), { probeAllowed: false, probeInFlight: true }, settings)).toEqual({ light: 'red', redKind: 'exhausted' });
  });

  it('员工份额为 0（容量 0）视为已满：红灯 staff_full，不会因为 0 除以 0 绕过', () => {
    expect(computeStaffLight(plan({ capacityTokens: 0, staffTokens: 0 }), idle, settings)).toEqual({ light: 'red', redKind: 'staff_full' });
  });

  it('份额比例服从设置：份额 0.5 时容量 1000 万的员工份额是 500 万', () => {
    const half = resolveSettings({ botQuotaShare: 0.5 });
    expect(computeStaffLight(plan({ staffTokens: 4_000_000 }), idle, half)).toEqual({ light: 'orange', redKind: null });
    expect(computeStaffLight(plan({ staffTokens: 5_000_000 }), idle, half)).toEqual({ light: 'red', redKind: 'staff_full' });
  });

  it('记账之后写回额度单例：员工用满份额转红，恢复时刻是本窗口结束（不加等待），员工休息，不建告警条目、不推送', () => {
    const { ctx, researcher } = world();
    // 容量 100 万、份额 0.7、员工份额 70 万；已用 60 万（橙灯）。
    const { now } = seed(ctx, { capacityTokens: 1_000_000, staffTokens: 600_000 }, { light: 'orange' });
    usage(ctx, addWake(ctx, {}, researcher.id), 99_999);
    expect(getQuotaState(ctx, now)).toMatchObject({ light: 'orange', redUntil: null });
    const wake = addWake(ctx, {}, researcher.id);
    usage(ctx, wake, 1);
    expect(getQuotaPlan(ctx, now).staffTokens).toBe(700_000);
    expect(getQuotaState(ctx, now)).toMatchObject({ light: 'red', redUntil: now + 5 * HOUR });
    expect(getQuotaPlan(ctx, now).exhausted).toBeNull();
    expect(ctx.store.table('bots').get(researcher.id)).toMatchObject({ activity: 'resting' });
    expect(ctx.store.table('bots').get(researcher.id)!.activityText).toMatch(/^在等额度恢复，约 \d\d:\d\d 继续$/);
    expect(ctx.store.table('alerts').list()).toEqual([]);
    expect(ctx.store.table('inbox').list()).toEqual([]);
    expect(pushHistory(ctx)).toEqual([]);
  });

  it('你发起的回合再多也不让灯变红：员工份额 0，你一侧 900 万 token，灯仍是绿', () => {
    const { ctx, researcher } = world();
    const { now } = seed(ctx, { capacityTokens: 10_000_000 });
    usage(ctx, addWake(ctx, { ownerInitiated: true }, researcher.id), 9_000_000);
    expect(getQuotaState(ctx, now)).toMatchObject({ light: 'green' });
    expect(getQuotaPlan(ctx, now)).toMatchObject({ ownerTokens: 9_000_000, staffTokens: 0, capacityTokens: 10_000_000 });
  });

  it('员工份额用完的红灯到本窗口结束自动恢复，不需要探针；员工恢复原来的状态', () => {
    const { ctx, researcher } = world();
    const { now } = seed(ctx, { capacityTokens: 1_000_000, staffTokens: 699_999 }, { light: 'orange' });
    usage(ctx, addWake(ctx, {}, researcher.id), 1);
    expect(getQuotaState(ctx, now).light).toBe('red');
    expect(ctx.store.table('bots').get(researcher.id)!.activity).toBe('resting');
    ctx.clock.set(now + 5 * HOUR);
    expect(rollWindow(ctx, now + 5 * HOUR)).toMatchObject({ light: 'green', redUntil: null, probeAllowed: false });
    expect(ctx.store.table('bots').get(researcher.id)).toMatchObject({ activity: 'watching', activityText: '继续关注变化' });
  });
});

describe('3 容量回升（派活说明第二节）', () => {
  const settings = resolveSettings();

  it('规则二：容量被校准到 500 万之后，连续两个窗口员工用到八成以上且没有报错：依次变成 625 万、约 781 万；每次回升记一条审计，来源保持 calibrated', () => {
    const { ctx } = world();
    // 容量 500 万、份额 0.7、员工份额 350 万；八成线 280 万。
    const { now } = seed(ctx, { capacityTokens: 5_000_000, capacitySource: 'calibrated', staffTokens: 2_800_000 });
    ctx.clock.set(now + 5 * HOUR);
    rollWindow(ctx, now + 5 * HOUR);
    expect(getQuotaPlan(ctx, now)).toMatchObject({ capacityTokens: 6_250_000, capacitySource: 'calibrated', staffTokens: 0 });
    // 第二个窗口：新窗口从一个回合开始，员工又用到八成（新员工份额 437.5 万，八成线 350 万）。
    const second = now + 5 * HOUR + MINUTE;
    beginQuotaWindow(ctx, second);
    ctx.store.table('quotaWindows').put({ ...getQuotaPlan(ctx, second), staffTokens: 3_500_000 });
    ctx.clock.set(second + 5 * HOUR);
    rollWindow(ctx, second + 5 * HOUR);
    expect(getQuotaPlan(ctx, now)).toMatchObject({ capacityTokens: 7_812_500, capacitySource: 'calibrated' });
    expect(capacityAudit(ctx)).toEqual([
      { from: 5_000_000, to: 6_250_000, basis: expect.stringContaining('窗口滚动') },
      { from: 6_250_000, to: 7_812_500, basis: expect.stringContaining('窗口滚动') },
    ]);
  });

  it('员工只用到五成的窗口：容量不变，不记审计', () => {
    const { ctx } = world();
    const { now } = seed(ctx, { capacityTokens: 5_000_000, capacitySource: 'calibrated', staffTokens: 1_750_000 });
    ctx.clock.set(now + 5 * HOUR);
    rollWindow(ctx, now + 5 * HOUR);
    expect(getQuotaPlan(ctx, now).capacityTokens).toBe(5_000_000);
    expect(capacityAudit(ctx)).toEqual([]);
  });

  it('有报错的窗口不回升（往小处调的规则照旧）：窗口里有一条报错记录，员工用到九成，滚动后容量不变', () => {
    const { ctx } = world();
    const { now } = seed(ctx, { capacityTokens: 5_000_000, capacitySource: 'calibrated', staffTokens: 3_150_000,
      errors: [{ at: now0(ctx) + MINUTE, text: '已达到 5 小时的使用上限', resetAt: null, pluginTokens: 3_150_000 }] });
    ctx.clock.set(now + 5 * HOUR);
    rollWindow(ctx, now + 5 * HOUR);
    expect(getQuotaPlan(ctx, now).capacityTokens).toBe(5_000_000);
    expect(capacityAudit(ctx)).toEqual([]);
    // 对照：同样的用量、没有报错记录，会回升。
    const other = world().ctx;
    const seeded = seed(other, { capacityTokens: 5_000_000, capacitySource: 'calibrated', staffTokens: 3_150_000 });
    other.clock.set(seeded.now + 5 * HOUR);
    rollWindow(other, seeded.now + 5 * HOUR);
    expect(getQuotaPlan(other, seeded.now).capacityTokens).toBe(6_250_000);
  });

  it('回升不超过 1000 万：900 万回升到 1000 万；已经是 1000 万的不再变', () => {
    const near = world().ctx;
    const a = seed(near, { capacityTokens: 9_000_000, capacitySource: 'calibrated', staffTokens: 6_300_000 });
    near.clock.set(a.now + 5 * HOUR); rollWindow(near, a.now + 5 * HOUR);
    expect(getQuotaPlan(near, a.now).capacityTokens).toBe(BUDGET_DEFAULTS.INITIAL_WINDOW_TOKENS);
    const full = world().ctx;
    const b = seed(full, { capacityTokens: 10_000_000, capacitySource: 'calibrated', staffTokens: 7_000_000 });
    full.clock.set(b.now + 5 * HOUR); rollWindow(full, b.now + 5 * HOUR);
    expect(getQuotaPlan(full, b.now).capacityTokens).toBe(10_000_000);
    expect(capacityAudit(full)).toEqual([]);
  });

  it('规则一：本窗口用量 1200 万而没有报错：记账之后容量变成 1200 万，记一条审计', () => {
    const { ctx, researcher } = world();
    const { now } = seed(ctx, {});
    usage(ctx, addWake(ctx, { ownerInitiated: true }, researcher.id), 12_000_000);
    expect(getQuotaPlan(ctx, now)).toMatchObject({ capacityTokens: 12_000_000, ownerTokens: 12_000_000 });
    expect(capacityAudit(ctx)).toEqual([{ from: 10_000_000, to: 12_000_000, basis: expect.stringContaining('记账') }]);
  });

  it('规则一：用量没超过容量时不动；超过时按员工加主人两侧合计，来源保持 calibrated', () => {
    const { ctx, researcher } = world();
    const { now } = seed(ctx, { capacityTokens: 3_000_000, capacitySource: 'calibrated', ownerTokens: 1_000_000 });
    usage(ctx, addWake(ctx, {}, researcher.id), 1_900_000);
    expect(getQuotaPlan(ctx, now).capacityTokens).toBe(3_000_000);
    usage(ctx, addWake(ctx, {}, researcher.id), 200_000);
    expect(getQuotaPlan(ctx, now)).toMatchObject({ capacityTokens: 3_100_000, capacitySource: 'calibrated' });
  });

  it('规则一：这个窗口已经有真实额度报错时不回升（报错那一刻校准出的容量才是依据）', () => {
    const { ctx, researcher } = world();
    const { now } = seed(ctx, { capacityTokens: 3_000_000, capacitySource: 'calibrated', staffTokens: 2_900_000,
      errors: [{ at: now0(ctx), text: '额度用完', resetAt: null, pluginTokens: 2_900_000 }] });
    usage(ctx, addWake(ctx, {}, researcher.id), 500_000);
    expect(getQuotaPlan(ctx, now).capacityTokens).toBe(3_000_000);
    expect(capacityAudit(ctx)).toEqual([]);
  });

  it('纯函数：raiseCapacityToUsage、recoverCapacity、windowHadError、calibrateCapacity 的边界', () => {
    expect(raiseCapacityToUsage({ capacityTokens: 100, staffTokens: 60, ownerTokens: 41 })).toBe(101);
    expect(raiseCapacityToUsage({ capacityTokens: 100, staffTokens: 60, ownerTokens: 40 })).toBeNull();
    const high = { capacityTokens: 4_000_000, staffTokens: 2_240_000 }; // 员工份额 280 万，八成线 224 万，正好到线
    expect(recoverCapacity(high, settings, false)).toBe(5_000_000);
    expect(recoverCapacity({ ...high, staffTokens: 2_239_999 }, settings, false)).toBeNull();
    expect(recoverCapacity(high, settings, true)).toBeNull();
    expect(recoverCapacity({ capacityTokens: 0, staffTokens: 0 }, settings, false)).toBeNull();
    expect(windowHadError({ errors: [], exhausted: null }, 0)).toBe(false);
    expect(windowHadError({ errors: [{ at: 5, text: 'x', resetAt: null, pluginTokens: 0 }], exhausted: null }, 5)).toBe(true);
    expect(windowHadError({ errors: [{ at: 4, text: 'x', resetAt: null, pluginTokens: 0 }], exhausted: null }, 5)).toBe(false);
    expect(windowHadError({ errors: [], exhausted: { at: 1, resetAt: 2, resetFromText: false } }, 5)).toBe(true);
    // 校准只往小处：已校准到 500 万，一次大的 pluginTokens 不会把它调大。
    expect(calibrateCapacity({ capacitySource: 'calibrated', capacityTokens: 5_000_000, errors: [] }, 9_000_000)).toBe(5_000_000);
  });
});

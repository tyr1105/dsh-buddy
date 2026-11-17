/**
 * P76c 用量路径的测试：疲劳、内驱、用量停用线、两个视图、给员工看的一行，都改用同一个口径——
 * 「员工自己发起的回合数」（quota/usage.ts 的 isSelfWork、selfWorkUsageToday）和同一条上限 botDailyTurnBudget（默认 2）。
 *
 * 覆盖（对应任务卡第 6 节第 2、3 条，派活说明第二节第 1、2 条）：
 * 1 isSelfWork 补上的两种排除：主人在宿主会话里直聊的回合（ownerDirect）、唤醒原因是主人消息的回合；
 * 2 selfWorkUsageToday 的「从什么时刻起」参数；
 * 3 用量停用线：一件事里 10 个回合、实测 100 万 token 不停用；自己发起 6 个回合（上限 2）停用，原因文字逐字；
 * 4 停用线只数主人上次恢复在岗之后的回合：恢复后不因恢复之前的回合再停用，恢复之后又做满三倍才再次停用；
 * 5 连续不交账停用线与 isSelfWork 同一个定义：主人直聊、主人消息叫醒的回合各连续 3 个不停用（反例：普通回合 3 个停用）；
 * 6 疲劳、内驱：一件事里的 10 个回合疲劳为 0；
 * 7 员工卡视图与给员工看的一行。
 * 全部直接写唤醒单，时间只用注入的假时钟（假时钟默认 2026-11-05 10:00，没有推进）。
 */
import { describe, expect, it } from 'vitest';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import type { HubContext } from '../src/engine/context.js';
import type { WakeTicket } from '../src/model/index.js';
import { checkQuarantine, quarantine } from '../src/health/quarantine.js';
import { fatigueFor } from '../src/appraisal/think.js';
import { evaluateDrives } from '../src/drives/evaluate.js';
import { botCard } from '../src/api/summary-views.js';
import { runTool } from '../src/tools/index.js';
import { isSelfWork, selfWorkUsageToday } from '../src/quota/usage.js';
import { apiFixture, okData } from './c04-api-fixtures.js';
import { botFixture, goalFixture, modelFixtures } from './model-fixtures.js';
import { addLedger, addSelfTurns, addWake } from './p76c-fixtures.js';

const JOB_ID = 'job_0000000001';
const MINUTE = 60_000;

function setup(): HubContext {
  const ctx = createTestContext();
  ctx.store.table('bots').put({ ...botFixture, createdAt: ctx.clock.now(), updatedAt: ctx.clock.now() });
  return ctx;
}
const wakeShape = (patch: Partial<WakeTicket>): WakeTicket => ({ ...(modelFixtures.WakeTicket.valid as WakeTicket), ownerInitiated: false, ...patch });
const ownerMessageReason = { kind: 'owner_message' as const, score: 1, threshold: 0.5, summary: '主人说了一句', evidence: [] };

describe('1 isSelfWork：主人直聊与主人消息叫醒的回合不是员工自己发起的', () => {
  it('ownerDirect 为真（主人在宿主会话里直聊）：假；ownerDirect 为假或缺省：真', () => {
    expect(isSelfWork(wakeShape({ ownerDirect: true }))).toBe(false);
    expect(isSelfWork(wakeShape({ ownerDirect: false }))).toBe(true);
    expect(isSelfWork(wakeShape({}))).toBe(true);
  });

  it('唤醒原因是主人消息（即使 ownerInitiated 没写上）：假；别的原因：真', () => {
    expect(isSelfWork(wakeShape({ reason: ownerMessageReason }))).toBe(false);
    expect(isSelfWork(wakeShape({ reason: { ...ownerMessageReason, kind: 'percept' } }))).toBe(true);
  });

  it('当天回合数：直聊的 1 个、主人消息叫醒的 1 个不算，普通的 1 个算', () => {
    const ctx = setup();
    addWake(ctx, { ownerDirect: true });
    addWake(ctx, { reason: ownerMessageReason });
    addWake(ctx);
    expect(selfWorkUsageToday(ctx, botFixture.id, ctx.clock.now()).turns).toBe(1);
  });
});

describe('2 selfWorkUsageToday 的「从什么时刻起」', () => {
  it('只数开始时刻晚于它的回合；恰好等于它的不算', () => {
    const ctx = setup(); const now = ctx.clock.now();
    addWake(ctx, { startedAt: now - 30 * MINUTE, dispatchedAt: now - 30 * MINUTE });
    addWake(ctx, { startedAt: now - 20 * MINUTE, dispatchedAt: now - 20 * MINUTE });
    addWake(ctx, { startedAt: now - 10 * MINUTE, dispatchedAt: now - 10 * MINUTE });
    expect(selfWorkUsageToday(ctx, botFixture.id, now).turns).toBe(3);
    expect(selfWorkUsageToday(ctx, botFixture.id, now, now - 20 * MINUTE).turns).toBe(1);
    expect(selfWorkUsageToday(ctx, botFixture.id, now, now - 21 * MINUTE).turns).toBe(2);
  });
});

describe('3 用量停用线：只按员工自己发起的回合数，原因文字逐字', () => {
  it('执行者当天 10 个一件事里的回合、实测 100 万 token：不停用（原来按 token 会停用）', () => {
    const ctx = setup();
    for (let i = 0; i < 10; i += 1) addLedger(ctx, addWake(ctx, { jobId: JOB_ID }), 100_000);
    expect(checkQuarantine(ctx, botFixture.id, ctx.clock.now())).toBeNull();
  });

  it('不听吩咐的员工当天 6 个自己发起的回合（上限 2）：停用，原因逐字；5 个不停用；告警的句子里不写「员工」', () => {
    const ctx = setup();
    expect(ctx.settings.botDailyTurnBudget).toBe(2);
    // P76r1 同步：传入刚结束的唤醒单；原因文字按倍数生成（「3 倍」）。
    const five = addSelfTurns(ctx, 5);
    expect(checkQuarantine(ctx, botFixture.id, ctx.clock.now(), five.at(-1))).toBeNull();
    const sixth = addWake(ctx);
    const reason = checkQuarantine(ctx, botFixture.id, ctx.clock.now(), sixth);
    expect(reason).toBe('自己发起的回合达到每天上限的 3 倍');
    quarantine(ctx, botFixture.id, reason!);
    expect(ctx.store.table('alerts').list().map(row => row.text)).toContain(`中心停用了${botFixture.name}：自己发起的回合达到每天上限的 3 倍。`);
  });

  it('总管为你派出的、你发起的、技能类的回合再多也不停用', () => {
    const ctx = setup();
    for (let i = 0; i < 4; i += 1) addWake(ctx, { chiefDispatch: true });
    for (let i = 0; i < 4; i += 1) addWake(ctx, { ownerInitiated: true });
    for (let i = 0; i < 4; i += 1) addWake(ctx, { variant: 'reflection', subjectKey: `retro:sr_0000000001:${botFixture.id}`,
      reason: { kind: 'reflection', score: 0.5, threshold: 0.5, summary: '复盘', evidence: [] } });
    expect(checkQuarantine(ctx, botFixture.id, ctx.clock.now())).toBeNull();
  });
});

describe('4 停用线只数主人上次恢复在岗之后的回合', () => {
  it('达到三倍被停用、主人恢复在岗之后，不因恢复之前的回合再次停用；恢复之后又做满三倍才再次停用', async () => {
    const { ctx, api, bot } = await apiFixture();
    // 夹具里的员工是调研员（不听吩咐）。先做满 6 个自己发起的回合并被停用。
    // P76r1 同步：每次都把刚结束的唤醒单传进去；原因文字按倍数生成（「3 倍」）。
    const six = addSelfTurns(ctx, 6, {}, bot.id);
    const reason = checkQuarantine(ctx, bot.id, ctx.clock.now(), six.at(-1));
    expect(reason).toBe('自己发起的回合达到每天上限的 3 倍');
    quarantine(ctx, bot.id, reason!);
    ctx.clock.advance(5 * MINUTE);
    okData(await api.setLifecycle(bot.id, 'active'));
    const releasedAt = ctx.store.table('bots').get(bot.id)!.releasedAt!;
    expect(releasedAt).toBe(ctx.clock.now());
    // 恢复之前的 6 个回合还在、当天也还没过完：不再因它们停用。
    expect(selfWorkUsageToday(ctx, bot.id, ctx.clock.now()).turns).toBe(6);
    expect(checkQuarantine(ctx, bot.id, ctx.clock.now(), six.at(-1))).toBeNull();
    // 恢复之后又做了 5 个：不停用；第 6 个：再次停用。
    ctx.clock.advance(MINUTE);
    let last: WakeTicket = six.at(-1)!;
    for (let i = 0; i < 5; i += 1) last = addWake(ctx, { startedAt: ctx.clock.now() - 1_000, dispatchedAt: ctx.clock.now() - 1_000 }, bot.id);
    expect(checkQuarantine(ctx, bot.id, ctx.clock.now(), last)).toBeNull();
    last = addWake(ctx, { startedAt: ctx.clock.now() - 1_000, dispatchedAt: ctx.clock.now() - 1_000 }, bot.id);
    expect(checkQuarantine(ctx, bot.id, ctx.clock.now(), last)).toBe('自己发起的回合达到每天上限的 3 倍');
  });
});

describe('5 连续不交账停用线与 isSelfWork 是同一个定义', () => {
  /** 连续 n 个已结束、没有交账的回合（结束时刻依次后移 1 分钟），形状由 patch 决定。 */
  function noCommitRounds(ctx: HubContext, n: number, patch: Partial<WakeTicket>): void {
    const now = ctx.clock.now();
    for (let i = 0; i < n; i += 1) {
      const at = now - (n - i) * MINUTE;
      addWake(ctx, { status: 'no_commit', startedAt: at - 10_000, dispatchedAt: at - 10_000, endedAt: at, ...patch });
    }
  }

  it('对照：普通的自己发起的回合连续 3 个不交账：停用，原因「连续 3 个回合没有交账」', () => {
    const ctx = setup();
    expect(ctx.settings.noCommitReflectionCount + 1).toBe(3);
    noCommitRounds(ctx, 3, {});
    expect(checkQuarantine(ctx, botFixture.id, ctx.clock.now())).toBe('连续 3 个回合没有交账');
  });

  it('主人在宿主会话里直聊的回合（ownerDirect）连续 3 个不交账：不停用', () => {
    const ctx = setup();
    noCommitRounds(ctx, 3, { ownerDirect: true });
    expect(checkQuarantine(ctx, botFixture.id, ctx.clock.now())).toBeNull();
  });

  it('唤醒原因是主人消息的回合（ownerInitiated 没写上）连续 3 个不交账：不停用', () => {
    const ctx = setup();
    noCommitRounds(ctx, 3, { reason: ownerMessageReason });
    expect(checkQuarantine(ctx, botFixture.id, ctx.clock.now())).toBeNull();
  });

  it('总管为主人派出的、教学变体的回合各连续 3 个不交账：不停用（统一之后比原来多排除的两种）', () => {
    const dispatched = setup();
    noCommitRounds(dispatched, 3, { chiefDispatch: true });
    expect(checkQuarantine(dispatched, botFixture.id, dispatched.clock.now())).toBeNull();
    const teach = setup();
    noCommitRounds(teach, 3, { variant: 'teach' });
    expect(checkQuarantine(teach, botFixture.id, teach.clock.now())).toBeNull();
  });
});

describe('6 疲劳、内驱：一件事里的回合不影响', () => {
  it('当天 10 个一件事里的回合：疲劳为 0；加 1 个自己发起的：疲劳 0.5；加到 2 个：疲劳 1', () => {
    const ctx = setup(); const now = ctx.clock.now();
    for (let i = 0; i < 10; i += 1) addWake(ctx, { jobId: JOB_ID });
    expect(fatigueFor(ctx, botFixture.id, now)).toBe(0);
    addWake(ctx);
    expect(fatigueFor(ctx, botFixture.id, now)).toBe(0.5);
    addWake(ctx);
    expect(fatigueFor(ctx, botFixture.id, now)).toBe(1);
  });

  it('内驱：一件事里的 10 个回合，内驱状态里的疲劳为 0；自己发起的回合到上限，疲劳为 1', () => {
    const ctx = setup(); const now = ctx.clock.now();
    ctx.store.table('goals').put({ ...goalFixture, patienceMs: 3_600_000, lastProgressAt: now - 3_600_001 });
    for (let i = 0; i < 10; i += 1) addWake(ctx, { jobId: JOB_ID });
    evaluateDrives(ctx, now);
    expect(ctx.store.table('drives').get(botFixture.id)).toMatchObject({ fatigue: 0 });
    addSelfTurns(ctx, 2);
    evaluateDrives(ctx, now);
    expect(ctx.store.table('drives').get(botFixture.id)).toMatchObject({ fatigue: 1 });
  });

  it('每天上限为 0：疲劳固定为 1', () => {
    const ctx = setup();
    ctx.settings.botDailyTurnBudget = 0;
    expect(fatigueFor(ctx, botFixture.id, ctx.clock.now())).toBe(1);
  });
});

describe('7 视图与给员工看的一行', () => {
  it('员工卡：todayThinks 是自己发起的回合数，todayBudget 是每天上限；一件事里的回合不计，试岗不减半', () => {
    const ctx = setup();
    addSelfTurns(ctx, 1);
    for (let i = 0; i < 10; i += 1) addWake(ctx, { jobId: JOB_ID });
    const card = botCard(ctx, ctx.store.table('bots').get(botFixture.id)!);
    expect(card).toMatchObject({ todayThinks: 1, todayBudget: 2 });
    ctx.store.table('bots').patch(botFixture.id, { lifecycle: 'probation' });
    expect(botCard(ctx, ctx.store.table('bots').get(botFixture.id)!)).toMatchObject({ todayThinks: 1, todayBudget: 2 });
  });

  it('给员工看的预算一行逐字：今天自己开工 n / 上限 回合（交给你的事不计入）', async () => {
    const ctx = setup();
    const wake = addWake(ctx, { sessionId: 'session-p76c', status: 'running', endedAt: null });
    ctx.store.table('bots').patch(botFixture.id, { sessionId: 'session-p76c' });
    for (let i = 0; i < 10; i += 1) addWake(ctx, { jobId: JOB_ID });
    const result = await runTool(ctx, { botId: botFixture.id, sessionId: 'session-p76c', wakeId: wake.id }, 'hub_state_get', {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toContain('今天自己开工 1 / 2 回合（交给你的事不计入）');
      expect(result.text).not.toContain('今日余量');
      expect(result.text).not.toContain('token');
    }
  });
});

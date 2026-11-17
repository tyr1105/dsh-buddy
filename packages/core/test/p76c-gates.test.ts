/**
 * P76c 闸门第 6 步的测试：员工自己发起的工作只剩一条上限（每位每天 botDailyTurnBudget 个回合，默认 2）。
 *
 * 夹具与真实情况一致：总管是自动创建的那一位（听吩咐、安静节奏）；执行员工听吩咐；
 * 另造一位不听吩咐的调研员，用来测「员工自己发起的工作」。
 * 每条调度用例都写明：额度灯为绿（用例里断言）、botDailyTurnBudget 的值（默认 2）、当天员工自己发起的回合数；
 * 断言拦截原因码和恢复时刻本身。时间只用注入的假时钟，没有推进。
 *
 * 数「回合」读的是唤醒单（quota/usage.ts 的 selfWorkUsageToday），不是账本，所以夹具写唤醒单。
 */
import { describe, expect, it } from 'vitest';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import type { HubContext } from '../src/engine/context.js';
import type { Bot, QueueEntry } from '../src/model/index.js';
import { buildCandidate } from '../src/appraisal/think.js';
import { enqueue } from '../src/scheduler/queue.js';
import { buildSnapshot, evaluateGates } from '../src/scheduler/gates.js';
import { selfWorkUsageToday } from '../src/quota/usage.js';
import { nextLocalTime } from '../src/util/time.js';
import { botFixture } from './model-fixtures.js';
import { addSelfTurns, addWake } from './p76c-fixtures.js';

const MINUTE = 60_000;
const JOB_ID = 'job_0000000001';

/** 三位员工：自动创建的总管（听吩咐、安静节奏）、执行员工（听吩咐）、不听吩咐的调研员（员工自己发起的工作只发生在他身上）。 */
function world() {
  const ctx = createTestContext();
  ctx.runtime.startedAt = ctx.clock.now() - 10 * MINUTE; // 越过启动静默
  const base: Bot = { ...botFixture, createdAt: ctx.clock.now(), updatedAt: ctx.clock.now() };
  const chief: Bot = { ...base, id: 'b_0000000010', name: '总管', role: 'chief', onDemand: true, pace: 'quiet', homeDir: '/hub/bots/b_0000000010' };
  const executor: Bot = { ...base, id: 'b_0000000011', name: '执行员', role: 'executor', onDemand: true, homeDir: '/hub/bots/b_0000000011' };
  const researcher: Bot = { ...base, id: 'b_0000000012', name: '调研员', role: 'researcher', onDemand: false, homeDir: '/hub/bots/b_0000000012' };
  for (const bot of [chief, executor, researcher]) ctx.store.table('bots').put(bot);
  return { ctx, chief, executor, researcher };
}

/** 给这位员工排一个候选（先排好再写回合，免得疲劳把分数门槛抬高后候选进不了队列）。 */
function queue(ctx: HubContext, botId: string, patch: Parameters<typeof buildCandidate>[1] extends infer T ? Partial<T> : never = {}): QueueEntry {
  return enqueue(ctx, buildCandidate(ctx, { botId, kind: 'percept', score: 0.95, summary: '资料有变化', subjectKey: `watch:p76c-${botId}`, ...patch } as never))!;
}

/** 用真实快照和真实闸门判断，同时断言额度灯是绿的、每天上限是 2（用例写明的前提）。 */
function verdict(ctx: HubContext, entry: QueueEntry) {
  const now = ctx.clock.now();
  const snapshot = buildSnapshot(ctx, entry.botId, now, entry.jobId, entry.subjectKey);
  expect(snapshot.quota.light, '前提：额度灯为绿').toBe('green');
  expect(ctx.settings.botDailyTurnBudget, '前提：每天上限为默认值 2').toBe(2);
  return evaluateGates(entry, snapshot, now, ctx.settings);
}

describe('1 第 6 步：员工自己发起的回合数到每天上限', () => {
  it('当天已有 2 个自己发起的回合：第 3 个候选被 daily_cap 拦住，恢复时刻是次日 00:00，候选保留', () => {
    const { ctx, researcher } = world();
    const entry = queue(ctx, researcher.id);
    expect(verdict(ctx, entry), '对照：还没有回合时放行').toEqual({ pass: true });
    addSelfTurns(ctx, 2, {}, researcher.id);
    expect(selfWorkUsageToday(ctx, researcher.id, ctx.clock.now()).turns).toBe(2);
    expect(verdict(ctx, entry)).toEqual({ pass: false, by: 'daily_cap', until: nextLocalTime('00:00', ctx.clock.now(), ctx.settings.timezone), drop: false });
    expect(nextLocalTime('00:00', ctx.clock.now(), ctx.settings.timezone)).toBe(Date.parse('2026-11-06T00:00:00+08:00'));
  });

  it('当天已有 1 个自己发起的回合：放行', () => {
    const { ctx, researcher } = world();
    const entry = queue(ctx, researcher.id);
    addSelfTurns(ctx, 1, {}, researcher.id);
    expect(verdict(ctx, entry)).toEqual({ pass: true });
  });

  it('同一位员工当天有 10 个执行链回合（带 jobId）、0 个自己发起的：自己发起的候选放行', () => {
    const { ctx, researcher } = world();
    const entry = queue(ctx, researcher.id);
    for (let i = 0; i < 10; i += 1) addWake(ctx, { jobId: JOB_ID, tokens: 120_000 }, researcher.id);
    expect(selfWorkUsageToday(ctx, researcher.id, ctx.clock.now()).turns).toBe(0);
    expect(verdict(ctx, entry)).toEqual({ pass: true });
  });

  it('当天的 token 与回合账本再多（1000 万 token、100 个账本回合）也不拦：每日 token 与每窗口回合两条线已取消', () => {
    const { ctx, researcher } = world();
    const entry = queue(ctx, researcher.id);
    for (let i = 0; i < 100; i += 1) {
      ctx.store.log('ledger').append({ id: `le_${String(700_000 + i).padStart(10, '0')}`, who: researcher.id, wakeId: null, tokens: 100_000,
        kind: 'turn', at: ctx.clock.now() - (i + 1) * 1_000, ownerInitiated: false });
    }
    const result = verdict(ctx, entry);
    expect(result).toEqual({ pass: true });
    expect(result.pass || result.by).not.toBe('bot_budget');
  });

  it('带 chiefDispatch 的候选在已有 2 个自己发起的回合时放行；同一位员工同种来源但不带它的候选被 daily_cap 拦住', () => {
    const { ctx, executor } = world();
    // 执行员工听吩咐，同伴消息是他接收的来源之一；2 个自己发起的回合是升级前或改成听吩咐之前留下的。
    const dispatched = queue(ctx, executor.id, { kind: 'peer_message', subjectKey: 'peer:p76c-dispatch', chiefDispatch: true });
    // 同一位员工的两个同伴候选会在队列里合并成一条（合并时保留派活标记），所以不带标记的对照由同一条候选去掉标记得到。
    const plain = { ...dispatched, chiefDispatch: false };
    expect(dispatched.chiefDispatch).toBe(true);
    addSelfTurns(ctx, 2, {}, executor.id);
    expect(verdict(ctx, dispatched)).toEqual({ pass: true });
    expect(verdict(ctx, plain)).toMatchObject({ pass: false, by: 'daily_cap', drop: false });
  });

  it('你发起的候选（主人消息）在已有 2 个自己发起的回合时放行', () => {
    const { ctx, researcher } = world();
    const entry = queue(ctx, researcher.id, { kind: 'owner_message', score: 1, subjectKey: 'owner:p76c' });
    expect(entry.ownerInitiated).toBe(true);
    addSelfTurns(ctx, 2, {}, researcher.id);
    expect(verdict(ctx, entry)).toEqual({ pass: true });
  });

  it('别的员工自己发起的回合不算：执行员工用满 2 个，调研员的候选照样放行（各算各的）', () => {
    const { ctx, researcher, executor } = world();
    const mine = queue(ctx, researcher.id);
    addSelfTurns(ctx, 2, {}, executor.id);
    expect(selfWorkUsageToday(ctx, researcher.id, ctx.clock.now()).turns).toBe(0);
    expect(verdict(ctx, mine)).toEqual({ pass: true });
  });

  it('总管、你发起的、一件事里的回合都不占自己发起的名额：混合 8 个回合仍放行', () => {
    const { ctx, researcher } = world();
    const entry = queue(ctx, researcher.id);
    addWake(ctx, { ownerInitiated: true }, researcher.id);
    addWake(ctx, { ownerDirect: true }, researcher.id);
    addWake(ctx, { reason: { kind: 'owner_message', score: 1, threshold: 0.5, summary: '主人说', evidence: [] } }, researcher.id);
    addWake(ctx, { chiefDispatch: true }, researcher.id);
    addWake(ctx, { jobId: JOB_ID }, researcher.id);
    addWake(ctx, { topicId: 'ptp_0000000001' }, researcher.id);
    addWake(ctx, { variant: 'teach' }, researcher.id);
    addWake(ctx, { variant: 'reflection', subjectKey: 'retro:sr_0000000001:b_0000000012',
      reason: { kind: 'reflection', score: 0.5, threshold: 0.5, summary: '复盘', evidence: [] } }, researcher.id);
    expect(selfWorkUsageToday(ctx, researcher.id, ctx.clock.now()).turns).toBe(0);
    expect(verdict(ctx, entry)).toEqual({ pass: true });
  });
});

describe('2 快照', () => {
  it('快照只有 selfTurnsToday，原来的 todayTurns、todayTokens、windowTurns 三项不再存在', () => {
    const { ctx, researcher } = world();
    addSelfTurns(ctx, 2, {}, researcher.id);
    const snapshot = buildSnapshot(ctx, researcher.id, ctx.clock.now());
    expect(snapshot.selfTurnsToday).toBe(2);
    expect(Object.keys(snapshot)).not.toContain('todayTurns');
    expect(Object.keys(snapshot)).not.toContain('todayTokens');
    expect(Object.keys(snapshot)).not.toContain('windowTurns');
  });
});

/**
 * P74r13 第 3、4 节的测试：一件事里的回合加一条很宽的 token 兜底线；超过 60 分钟或到兜底线之后被结束，不再自动重试，
 * 这件事转为受阻并叫醒总管；回合被结束的原因写事实。
 *
 * 覆盖：
 * 1 用量 149 万：没有提醒；到 150 万：收到一次收口提醒（文字用现有的那句），之后继续上涨也只提醒一次；
 * 2 提醒之后 3 分钟未结束：被取消，这件事转受阻（说明逐字）、总管被叫醒、没有自动重试（员工没有出错退避、没有再被叫醒）；
 * 3 总时长超过 60 分钟（一直有事件）：同样转受阻（说明逐字）、没有自动重试；
 * 4 10 分钟没有任何事件：照旧自动重试（出错退避、这件事不受阻）；
 * 5 不带 jobId 的回合：不受兜底线影响，原因文字不变；
 * 6 回合记录上的原因文字（第 4 节）：10 分钟无事件写「没有响应」，总时长超过上限写「超过 n 分钟」（一件事里 60，其余 30）。
 * 全部走真实的 Hub（事件经 onTurnEvent 进来），时间用注入的假时钟，每次推进不超过 10 分钟。
 */
import { describe, expect, it } from 'vitest';
import { JOB_DEFAULTS } from '../src/config/defaults.js';
import { CLOSING_MESSAGE } from '../src/turn/limits.js';
import { ownerSays } from './p74b-fixtures.js';
import { MINUTE, bot, countEvents, entriesOf, jobFix, runningOf, theJob, tick, wakesOf, type JobFix } from './p74c-fixtures.js';
import { started } from './p74d-fixtures.js';

/** 这位员工的会话收到的收口提醒和取消次数。 */
function guardCalls(fix: JobFix, botId: string) {
  const sessionId = bot(fix, botId).sessionId!;
  const calls = fix.ctx.host.calls;
  return {
    steers: calls.filter(call => call.method === 'steer' && call.args[0] === sessionId && call.args[1] === CLOSING_MESSAGE).length,
    cancels: calls.filter(call => call.method === 'cancel' && call.args[0] === sessionId).length,
  };
}

/** 给这个回合一个真实的步骤事件（宿主回报步数和 token），事件时间取当前假时钟，再跑一次调度。 */
async function stepAndTick(fix: JobFix, botId: string, tokens: number): Promise<void> {
  await fix.hub.onTurnEvent({ type: 'step', sessionId: bot(fix, botId).sessionId!, at: fix.ctx.clock.now(), steps: 5, tokens });
  await fix.hub.tick();
}

/** 推进 ms 毫秒，每次不超过 10 分钟，每次推进之后给回合一个事件，防止被「10 分钟无事件」抢先结束。 */
async function advanceWithEvents(fix: JobFix, botId: string, ms: number, tokens: number): Promise<void> {
  let left = ms;
  while (left > 0) {
    const step = Math.min(10 * MINUTE, left);
    fix.ctx.clock.advance(step);
    left -= step;
    await stepAndTick(fix, botId, tokens);
  }
}

describe('1 token 兜底线', () => {
  it('默认值是 150 万；用量 149 万没有提醒，到 150 万收到一次提醒，之后继续上涨也只提醒一次', async () => {
    expect(JOB_DEFAULTS.CHAIN_TURN_TOKEN_GUARD).toBe(1_500_000);
    const { fix } = await started();
    expect(runningOf(fix, fix.engineer.id)!.jobId).toBeTruthy();
    fix.ctx.clock.advance(MINUTE);
    await stepAndTick(fix, fix.engineer.id, 1_490_000);
    expect(guardCalls(fix, fix.engineer.id)).toEqual({ steers: 0, cancels: 0 });
    expect(runningOf(fix, fix.engineer.id)!.steeredAt).toBeNull();
    fix.ctx.clock.advance(MINUTE);
    await stepAndTick(fix, fix.engineer.id, 1_500_000);
    expect(guardCalls(fix, fix.engineer.id)).toEqual({ steers: 1, cancels: 0 });
    expect(runningOf(fix, fix.engineer.id)!.steeredAt).not.toBeNull();
    fix.ctx.clock.advance(MINUTE);
    await stepAndTick(fix, fix.engineer.id, 1_800_000);
    expect(guardCalls(fix, fix.engineer.id)).toEqual({ steers: 1, cancels: 0 });
  });

  it('提醒之后 3 分钟仍未结束：被取消，这件事转受阻（说明逐字），总管被叫醒，没有自动重试', async () => {
    const { fix, job } = await started();
    const wake = runningOf(fix, fix.engineer.id)!;
    fix.ctx.clock.advance(MINUTE);
    await stepAndTick(fix, fix.engineer.id, 1_500_000);
    expect(guardCalls(fix, fix.engineer.id)).toEqual({ steers: 1, cancels: 0 });
    // 提醒后 2 分钟：还不到 3 分钟，不取消。
    fix.ctx.clock.advance(2 * MINUTE);
    await stepAndTick(fix, fix.engineer.id, 1_520_000);
    expect(guardCalls(fix, fix.engineer.id).cancels).toBe(0);
    expect(theJob(fix).state).not.toBe('blocked');
    // 再过 1 分钟（共 3 分钟）：取消。
    const chiefBefore = entriesOf(fix, fix.chief.id, job.id).length + wakesOf(fix, fix.chief.id, job.id).length;
    fix.ctx.clock.advance(MINUTE);
    await stepAndTick(fix, fix.engineer.id, 1_540_000);
    expect(guardCalls(fix, fix.engineer.id).cancels).toBe(1);
    expect(fix.ctx.store.table('wakes').get(wake.id)).toMatchObject({ status: 'timeout', error: '回合用量超过上限，中心已结束本回合' });
    expect(theJob(fix)).toMatchObject({ state: 'blocked', blocked: { kind: 'executor', text: '林舟的一个回合用量超过上限，中心已结束它。' } });
    expect(countEvents(fix, job.id, 'executor_blocked')).toBe(1);
    // 总管被叫醒：他在这件事上有了新的候选或回合。
    expect(entriesOf(fix, fix.chief.id, job.id).length + wakesOf(fix, fix.chief.id, job.id).length).toBeGreaterThan(chiefBefore);
    // 没有自动重试：这位员工没有记出错退避，之后也没有再被叫醒。
    expect(bot(fix, fix.engineer.id).retryAt).toBeNull();
    const wakes = wakesOf(fix, fix.engineer.id, job.id).length;
    for (let i = 0; i < 4; i += 1) await tick(fix, 10 * MINUTE);
    expect(wakesOf(fix, fix.engineer.id, job.id)).toHaveLength(wakes);
    expect(entriesOf(fix, fix.engineer.id, job.id)).toHaveLength(0);
  });
});

describe('3 总时长超过 60 分钟', () => {
  it('一直有事件、超过 60 分钟：被结束，这件事转受阻（说明逐字），没有自动重试', async () => {
    const { fix, job } = await started();
    const wake = runningOf(fix, fix.engineer.id)!;
    await advanceWithEvents(fix, fix.engineer.id, 59 * MINUTE, 100_000);
    expect(runningOf(fix, fix.engineer.id)?.id).toBe(wake.id);
    expect(theJob(fix).state).not.toBe('blocked');
    await advanceWithEvents(fix, fix.engineer.id, 2 * MINUTE, 100_000);
    expect(runningOf(fix, fix.engineer.id)).toBeUndefined();
    expect(guardCalls(fix, fix.engineer.id).cancels).toBe(1);
    expect(fix.ctx.store.table('wakes').get(wake.id)).toMatchObject({ status: 'timeout', error: '回合超过 60 分钟，中心已结束本回合' });
    expect(theJob(fix)).toMatchObject({ state: 'blocked', blocked: { kind: 'executor', text: '林舟的一个回合超过 60 分钟，中心已结束它。' } });
    expect(bot(fix, fix.engineer.id).retryAt).toBeNull();
    const wakes = wakesOf(fix, fix.engineer.id, job.id).length;
    for (let i = 0; i < 4; i += 1) await tick(fix, 10 * MINUTE);
    expect(wakesOf(fix, fix.engineer.id, job.id)).toHaveLength(wakes);
  });
});

describe('4 10 分钟没有任何事件：照旧自动重试', () => {
  it('被判卡住，原因写「没有响应」，员工记出错退避并排了重试，这件事没有转受阻', async () => {
    const { fix } = await started();
    const wake = runningOf(fix, fix.engineer.id)!;
    await tick(fix, 10 * MINUTE);
    expect(fix.ctx.store.table('wakes').get(wake.id)).toMatchObject({ status: 'timeout', error: '回合没有响应，中心已停止等待并安排重试' });
    expect(bot(fix, fix.engineer.id).retryAt).not.toBeNull();
    expect(theJob(fix).state).not.toBe('blocked');
    expect(countEvents(fix, theJob(fix).id, 'executor_blocked')).toBe(0);
  });
});

describe('5 不带 jobId 的回合不受兜底线影响', () => {
  it('主人发起的回合：按自己的线提醒、取消，原因文字不变，不转任何一件事受阻', async () => {
    const fix = await jobFix();
    await ownerSays(fix, fix.engineer.id, '请看一下这件事');
    for (let i = 0; i < 8 && !runningOf(fix, fix.engineer.id); i += 1) await tick(fix, 5 * MINUTE);
    const wake = runningOf(fix, fix.engineer.id)!;
    expect(wake.jobId ?? null).toBeNull();
    // 用量远超兜底线，但这类回合按自己的线（主人发起：8 万 token）提醒一次。
    fix.ctx.clock.advance(MINUTE);
    await stepAndTick(fix, fix.engineer.id, 2_000_000);
    expect(guardCalls(fix, fix.engineer.id)).toEqual({ steers: 1, cancels: 0 });
    fix.ctx.clock.advance(3 * MINUTE);
    await stepAndTick(fix, fix.engineer.id, 2_000_000);
    expect(guardCalls(fix, fix.engineer.id).cancels).toBe(1);
    expect(fix.ctx.store.table('wakes').get(wake.id)).toMatchObject({ status: 'timeout', error: '收口后仍未结束，回合超时' });
    expect(fix.ctx.store.table('jobs').list()).toHaveLength(0);
  });
});

describe('6 回合被结束的原因写事实', () => {
  it('不带 jobId 的回合总时长超过 30 分钟：写「超过 30 分钟，中心已结束本回合并安排重试」', async () => {
    const fix = await jobFix();
    await ownerSays(fix, fix.engineer.id, '请看一下这件事');
    for (let i = 0; i < 8 && !runningOf(fix, fix.engineer.id); i += 1) await tick(fix, 5 * MINUTE);
    const wake = runningOf(fix, fix.engineer.id)!;
    expect(wake.jobId ?? null).toBeNull();
    // 只想看「总时长」这一道保护：把这类回合的收口线（步数、token、时长）调到够不着，
    // 否则到 20 分钟线先被提醒收口，3 分钟后以「收口后仍未结束」取消，走不到总时长保护。
    const limits = fix.ctx.settings.turnLimitsByVariant as Record<string, { steps: number; tokens: number; durationMs: number }>;
    limits.owner = { steps: 1_000_000, tokens: 1_000_000_000, durationMs: 1_000 * MINUTE };
    limits.regular = { steps: 1_000_000, tokens: 1_000_000_000, durationMs: 1_000 * MINUTE };
    await advanceWithEvents(fix, fix.engineer.id, 29 * MINUTE, 1_000);
    expect(runningOf(fix, fix.engineer.id)?.id).toBe(wake.id);
    await advanceWithEvents(fix, fix.engineer.id, 2 * MINUTE, 1_000);
    expect(fix.ctx.store.table('wakes').get(wake.id)).toMatchObject({ status: 'timeout', error: '回合超过 30 分钟，中心已结束本回合并安排重试' });
    expect(bot(fix, fix.engineer.id).retryAt).not.toBeNull();
  });
});

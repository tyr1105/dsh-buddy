/**
 * P74r11 第 1 节的测试：一件事里的回合（唤醒单带 jobId）不发收口提醒，总时长保护改为 60 分钟。
 *
 * 覆盖：
 * 1 带 jobId 的执行者回合：步数、token、时长都超过常规线，每次推进不超过 10 分钟并给回合一个事件：没有收口提醒，没有取消；
 * 2 同一个回合 10 分钟没有任何事件：照旧被判卡住；
 * 3 持续有事件：59 分钟没有被判卡住，超过 60 分钟被判卡住；
 * 4 不带 jobId 的回合（主人发起的真实回合）：到线提醒，3 分钟后取消；
 * 5 唤醒包「本次上限」那一行：带 jobId 的是新句，其余回合是原句。
 * 全部走真实的 Hub（事件经 onTurnEvent 进来），时间用注入的假时钟，每次推进不超过 10 分钟。
 */
import { describe, expect, it } from 'vitest';
import { CLOSING_MESSAGE } from '../src/turn/limits.js';
import { JOB_DEFAULTS } from '../src/config/defaults.js';
import { ownerSays } from './p74b-fixtures.js';
import { MINUTE, bot, jobFix, runningOf, tick, type JobFix } from './p74c-fixtures.js';
import { lastPacket } from './p63-topic-fixtures.js';
import { started } from './p74d-fixtures.js';

/** 这位员工最近一次收到的唤醒包正文。 */
function lastPacketOf(fix: JobFix, botId: string): string {
  return lastPacket(fix, bot(fix, botId));
}

/** 这位员工的会话收到的收口提醒和取消次数。 */
function guardCalls(fix: JobFix, botId: string) {
  const sessionId = bot(fix, botId).sessionId!;
  const calls = fix.ctx.host.calls;
  return {
    steers: calls.filter(call => call.method === 'steer' && call.args[0] === sessionId).length,
    cancels: calls.filter(call => call.method === 'cancel' && call.args[0] === sessionId).length,
  };
}

/** 给这个回合一个真实的步骤事件（宿主回报步数和 token），事件时间取当前假时钟。 */
async function stepEvent(fix: JobFix, botId: string, steps: number, tokens: number): Promise<void> {
  await fix.hub.onTurnEvent({ type: 'step', sessionId: bot(fix, botId).sessionId!, at: fix.ctx.clock.now(), steps, tokens });
}

/** 推进到回合开始之后 target 毫秒：每次不超过 10 分钟，每次推进之间给回合一个事件，再跑一次调度。 */
async function advanceWithEvents(fix: JobFix, botId: string, startedAt: number, target: number, steps = 50, tokens = 70_000): Promise<void> {
  while (fix.ctx.clock.now() - startedAt < target) {
    const step = Math.min(10 * MINUTE, startedAt + target - fix.ctx.clock.now());
    fix.ctx.clock.advance(step);
    await stepEvent(fix, botId, steps, tokens);
    await fix.hub.tick();
  }
}

describe('1 一件事里的回合不发收口提醒', () => {
  it('步数、token、时长都超过常规档的线：没有收口提醒，回合没有被取消', async () => {
    const { fix } = await started();
    const wake = runningOf(fix, fix.engineer.id)!;
    expect(wake.jobId).toBeTruthy();
    // 先一次推进 5 分钟并报告 50 步、7 万 token（常规档是 30 步、6 万 token），再推进到 25 分钟（常规档是 20 分钟）。
    await advanceWithEvents(fix, fix.engineer.id, wake.startedAt, 25 * MINUTE);
    expect(guardCalls(fix, fix.engineer.id)).toEqual({ steers: 0, cancels: 0 });
    const now = runningOf(fix, fix.engineer.id)!;
    expect(now).toMatchObject({ id: wake.id, status: 'running', steeredAt: null });
    expect(now.steps).toBeGreaterThan(30);
    expect(now.tokens).toBeGreaterThan(60_000);
  });

  it('同一个回合 10 分钟没有任何事件：照旧被判卡住', async () => {
    const { fix } = await started();
    const wake = runningOf(fix, fix.engineer.id)!;
    await tick(fix, 10 * MINUTE);
    expect(runningOf(fix, fix.engineer.id)).toBeUndefined();
    expect(fix.ctx.store.table('wakes').get(wake.id)).toMatchObject({ status: 'timeout' });
    expect(guardCalls(fix, fix.engineer.id).cancels).toBe(1);
  });

  it('持续有事件：59 分钟时没有被判卡住，超过 60 分钟被判卡住', async () => {
    expect(JOB_DEFAULTS.CHAIN_TURN_HARD_MS).toBe(60 * MINUTE);
    const { fix } = await started();
    const wake = runningOf(fix, fix.engineer.id)!;
    await advanceWithEvents(fix, fix.engineer.id, wake.startedAt, 59 * MINUTE);
    expect(runningOf(fix, fix.engineer.id)?.id).toBe(wake.id);
    expect(guardCalls(fix, fix.engineer.id).cancels).toBe(0);
    // 再过 2 分钟（共 61 分钟）：总时长保护生效。
    await advanceWithEvents(fix, fix.engineer.id, wake.startedAt, 61 * MINUTE);
    expect(runningOf(fix, fix.engineer.id)).toBeUndefined();
    expect(fix.ctx.store.table('wakes').get(wake.id)).toMatchObject({ status: 'timeout' });
    expect(guardCalls(fix, fix.engineer.id).cancels).toBe(1);
  });
});

describe('4 不带 jobId 的回合与以前相同', () => {
  it('主人发起的回合：步数到线提醒收口，3 分钟后仍未结束就取消', async () => {
    const fix = await jobFix();
    await ownerSays(fix, fix.engineer.id, '请看一下这件事');
    for (let i = 0; i < 8 && !runningOf(fix, fix.engineer.id); i += 1) await tick(fix, 5 * MINUTE);
    const wake = runningOf(fix, fix.engineer.id)!;
    expect(wake.jobId ?? null).toBeNull();
    // 主人发起的线是 40 步、30 分钟、8 万 token：报告 50 步，下一次检查就提醒。
    fix.ctx.clock.advance(MINUTE);
    await stepEvent(fix, fix.engineer.id, 50, 1_000);
    await fix.hub.tick();
    const sessionId = bot(fix, fix.engineer.id).sessionId!;
    expect(fix.ctx.host.calls).toContainEqual({ method: 'steer', args: [sessionId, CLOSING_MESSAGE] });
    expect(guardCalls(fix, fix.engineer.id).cancels).toBe(0);
    // 提醒之后 3 分钟（期间给一个事件，避免无事件超时抢先）仍未结束：取消并记超时。
    fix.ctx.clock.advance(3 * MINUTE);
    await stepEvent(fix, fix.engineer.id, 51, 1_000);
    await fix.hub.tick();
    expect(guardCalls(fix, fix.engineer.id).cancels).toBe(1);
    expect(fix.ctx.store.table('wakes').get(wake.id)).toMatchObject({ status: 'timeout' });
  });
});

describe('5 唤醒包「本次上限」那一行', () => {
  it('带 jobId 的回合是新句，其余回合是原句', async () => {
    const { fix } = await started();
    expect(lastPacketOf(fix, fix.engineer.id)).toContain('本回合不限步数，做完这一步就交账；超过 60 分钟中心会结束本回合。');
    expect(lastPacketOf(fix, fix.engineer.id)).not.toContain('到线会被要求收口');
    // 主人发起的回合（不带 jobId）仍是原句。
    const plain = await jobFix();
    await ownerSays(plain, plain.engineer.id, '请看一下这件事');
    for (let i = 0; i < 8 && !runningOf(plain, plain.engineer.id); i += 1) await tick(plain, 5 * MINUTE);
    const packet = lastPacketOf(plain, plain.engineer.id);
    expect(packet).toContain('最多 40 步、30 分钟、约 300000 token；到线会被要求收口。');
    expect(packet).not.toContain('本回合不限步数');
  });
});

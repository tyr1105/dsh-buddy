/**
 * P74r11 第 2 节的测试：一件事里的用量（唤醒单带 jobId 的回合）不计入「用量超标停用」的判断。
 *
 * 覆盖：
 * 1 执行者当天在一件事里用了 100 万 token、20 个回合：没有被停用，没有告警；
 * 2 同一位员工自己发起的回合用到 75 万 token（或 18 个回合）：照旧被停用；
 * 3 一件事里的用量加自己发起的用量合计超过线、自己发起的部分没有超过：不停用；
 * 4 真实链路：执行者在一件事里的回合用了 120 万 token，回合结束后仍在岗；
 * 另：第 1 组里也断言 botUsageToday 的口径不变（对照：这些用量确实被账本数进去了）。
 * P76c：停用线只按「员工自己发起的回合数」，不再按 token；第 2 组按此改写，原意与改动见 docs/progress/P76c.md。
 * 前三组直接构造唤醒单和账本行（与 health.test.ts 同一做法），第四组走真实 Hub。
 */
import { describe, expect, it } from 'vitest';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { checkQuarantine } from '../src/health/index.js';
import { botUsageToday } from '../src/quota/usage.js';
import type { HubContext } from '../src/engine/context.js';
import type { WakeTicket } from '../src/model/index.js';
import { botFixture, modelFixtures } from './model-fixtures.js';
import { commitAndEnd, MINUTE, bot, runningOf } from './p74c-fixtures.js';
import { started } from './p74d-fixtures.js';

const JOB_ID = 'job_0000000001';

/** 一个已结束的回合：jobId 为 null 表示员工自己发起的回合；同时在账本里记一行用量。 */
function addTurn(ctx: HubContext, n: number, tokens: number, jobId: string | null): void {
  const id = `w_${String(n).padStart(10, '0')}`;
  const base = modelFixtures.WakeTicket.valid as WakeTicket;
  // P76c：用量口径改数唤醒单（员工自己发起的回合），所以唤醒单要落在今天、写明已投递（原来只靠账本行，开始时刻用夹具里的固定值）。
  ctx.store.table('wakes').put({ ...base, id, botId: botFixture.id, ownerInitiated: false, jobId, status: 'committed',
    startedAt: ctx.clock.now() - 60_000, dispatchedAt: ctx.clock.now() - 60_000, endedAt: ctx.clock.now() });
  ctx.store.log('ledger').append({ id: `le_${String(n).padStart(10, '0')}`, who: botFixture.id, wakeId: id, tokens, kind: 'turn', at: ctx.clock.now() });
}

function setup(): HubContext {
  const ctx = createTestContext();
  ctx.store.table('bots').put({ ...botFixture });
  return ctx;
}

describe('1 一件事里的用量不触发停用', () => {
  it('一件事里用了 100 万 token、20 个回合：没有被停用，没有告警', () => {
    const ctx = setup();
    for (let n = 1; n <= 20; n += 1) addTurn(ctx, n, 50_000, JOB_ID);
    expect(checkQuarantine(ctx, botFixture.id, ctx.clock.now())).toBeNull();
    expect(ctx.store.table('bots').get(botFixture.id)!.lifecycle).not.toBe('quarantined');
    expect(ctx.store.table('alerts').list()).toHaveLength(0);
    // 作对照：不排除一件事里的用量时，这些用量确实超过了停用线（证明上面不是靠用量太小通过）。
    expect(botUsageToday(ctx, botFixture.id, ctx.clock.now())).toEqual({ turns: 20, tokens: 1_000_000 });
  });
});

describe('2 自己发起的用量：只按回合数停用（P76c）', () => {
  // P76c：原用例「自己发起的回合用到 75 万 token：被停用」证明按 token 的停用线。这条线已取消，所以改为证明相反的事实：
  // 自己发起的回合 token 再多，回合数没到线就不停用。
  it('自己发起的回合用到 75 万 token、只有 1 个回合：不停用（P76c 取消按 token 的线）', () => {
    const ctx = setup();
    addTurn(ctx, 1, 750_000, null);
    expect(checkQuarantine(ctx, botFixture.id, ctx.clock.now())).toBeNull();
  });

  // P76c：原用例证明回合线的边界在「每日回合预算 6 的三倍 = 18」；现在每天上限默认 2，线是 6 个，边界断言同样是「线以下不停用、到线停用」。
  it('自己发起的回合达到 6 个（每天上限 2 的三倍）：被停用；5 个不停用', () => {
    const ctx = setup();
    expect(ctx.settings.botDailyTurnBudget).toBe(2);
    for (let n = 1; n <= 5; n += 1) addTurn(ctx, n, 0, null);
    // P76r1 同步：传入刚结束的唤醒单（用量这一支只在自己发起的回合结束时检查）；原因文字按倍数生成（「3 倍」）。
    const wakeOf = (n: number) => ctx.store.table('wakes').get(`w_${String(n).padStart(10, '0')}`)!;
    expect(checkQuarantine(ctx, botFixture.id, ctx.clock.now(), wakeOf(5))).toBeNull();
    addTurn(ctx, 6, 0, null);
    expect(checkQuarantine(ctx, botFixture.id, ctx.clock.now(), wakeOf(6))).toBe('自己发起的回合达到每天上限的 3 倍');
  });
});

describe('3 两部分合计超过线、自己发起的部分没有超过', () => {
  // P76c：原用例是「一件事里 10 个回合 + 自己发起 10 个回合、线是 18」，靠显式设 6 让 10 个低于线。
  // 现在线是 6：自己发起的取 5 个（低于线），一件事里仍是 10 个（单独或合计都高于线），证明的仍是「只数自己发起的那部分」。
  it('一件事里 100 万 token 和 10 个回合、自己发起 35 万 token 和 5 个回合：不停用', () => {
    const ctx = setup();
    for (let n = 1; n <= 10; n += 1) addTurn(ctx, n, 100_000, JOB_ID);
    for (let n = 11; n <= 15; n += 1) addTurn(ctx, n, 70_000, null);
    expect(checkQuarantine(ctx, botFixture.id, ctx.clock.now())).toBeNull();
  });
});

describe('4 真实链路', () => {
  it('执行者在一件事里的回合用了 120 万 token，回合结束后仍在岗，没有停用告警', async () => {
    const { fix } = await started();
    const wake = runningOf(fix, fix.engineer.id)!;
    expect(wake.jobId).toBeTruthy();
    fix.ctx.clock.advance(5 * MINUTE);
    await fix.hub.onTurnEvent({ type: 'step', sessionId: bot(fix, fix.engineer.id).sessionId!, at: fix.ctx.clock.now(), steps: 60, tokens: 1_200_000 });
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '做了一大半' });
    const entry = fix.ctx.store.log('ledger').all().find(row => row.wakeId === wake.id);
    expect(entry, '这个回合应该已经记了用量').toBeDefined();
    expect(entry!.tokens).toBeGreaterThan(750_000);
    expect(bot(fix, fix.engineer.id).lifecycle).toBe('active');
    expect(fix.ctx.store.table('alerts').list().filter(row => row.code === 'quarantine')).toHaveLength(0);
  });
});

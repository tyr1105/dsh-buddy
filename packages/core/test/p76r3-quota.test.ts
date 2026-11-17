/**
 * P76r3 的测试（四）：记账时灯由红转不红，恢复因额度休息的员工（审查 R8）。
 *
 * 用真实的 Hub 上下文（不启动宿主的调度），额度灯按员工份额算：容量 100 万、员工份额七成（70 万）。
 * 先记一笔员工回合，把员工份额用完（红），员工休息；再记一笔你一侧的回合，插件看到的合计超过估计容量，
 * 容量回升到这个合计，比例落回橙灯——这时员工要恢复在岗。时间用注入的假时钟，每次推进不超过 10 分钟。
 */
import { describe, expect, it } from 'vitest';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import type { HubContext } from '../src/engine/context.js';
import type { Bot } from '../src/model/index.js';
import { getQuotaPlan, defaultQuotaPlan } from '../src/quota/plan.js';
import { recordUsage } from '../src/quota/usage.js';
import { botFixture } from './model-fixtures.js';
import { addWake } from './p76c-fixtures.js';

const MINUTE = 60_000;

/** 一位在岗、正在关注变化的员工。 */
function world(): { ctx: HubContext; worker: Bot } {
  const ctx = createTestContext();
  ctx.runtime.startedAt = ctx.clock.now() - 10 * MINUTE;
  const worker: Bot = { ...botFixture, id: 'b_0000000011', name: '执行员', role: 'executor', createdAt: ctx.clock.now(), updatedAt: ctx.clock.now(),
    lifecycle: 'active', activity: 'watching', activityText: '继续关注变化', homeDir: '/hub/bots/b_0000000011' };
  ctx.store.table('bots').put(worker);
  const now = ctx.clock.now();
  ctx.store.table('quota').put({ id: 'quota', windowStartAt: now, botTurns: 0, botTokens: 0, turnLimit: 40, tokenLimit: null,
    light: 'green', redUntil: null, probeAllowed: false, lastError: null, lastErrorAt: null });
  ctx.store.table('quotaWindows').put({ ...defaultQuotaPlan(now), capacityTokens: 1_000_000 });
  return { ctx, worker };
}

/** 记一笔实测 token 的回合。 */
function usage(ctx: HubContext, wakeId: string, botId: string, tokens: number) {
  return recordUsage(ctx, { botId, wakeId, tokens, steps: 1, packetBytes: 0 });
}

describe('R8：容量回升使灯由红转不红时，恢复因额度休息的员工', () => {
  it('员工份额用完（红）时员工休息；记账使容量回升、灯转橙：员工恢复在岗，额度保护的文字清掉', () => {
    const { ctx, worker } = world();
    // 员工一侧：实测 70 万 = 员工份额（100 万 × 0.7）用完，红灯。
    const staffWake = addWake(ctx, { jobId: 'job_0000000001' }, worker.id);
    usage(ctx, staffWake.id, worker.id, 700_000);
    expect(getQuotaPlan(ctx, ctx.clock.now()).staffTokens).toBe(700_000);
    expect(ctx.store.table('quota').get('quota')).toMatchObject({ light: 'red' });
    expect(ctx.store.table('bots').get(worker.id)).toMatchObject({ activity: 'resting' });
    expect(ctx.store.table('bots').get(worker.id)!.activityText).toContain('额度');
    // 你一侧：50 万。合计 120 万超过估计容量 100 万：容量回升到 120 万，员工份额变成 84 万，比例 83%（橙灯）。
    const ownerWake = addWake(ctx, { ownerInitiated: true }, worker.id);
    usage(ctx, ownerWake.id, worker.id, 500_000);
    expect(getQuotaPlan(ctx, ctx.clock.now())).toMatchObject({ capacityTokens: 1_200_000, staffTokens: 700_000, ownerTokens: 500_000 });
    expect(ctx.store.table('quota').get('quota')).toMatchObject({ light: 'orange' });
    // 员工恢复在岗，额度保护的文字与标记清掉。
    expect(ctx.store.table('bots').get(worker.id)).toMatchObject({ activity: 'watching', activityText: '继续关注变化', quotaRest: null });
  });

  it('反例：还是红灯时（比例仍到红线）员工继续休息', () => {
    const { ctx, worker } = world();
    const staffWake = addWake(ctx, { jobId: 'job_0000000001' }, worker.id);
    usage(ctx, staffWake.id, worker.id, 700_000);
    expect(ctx.store.table('bots').get(worker.id)).toMatchObject({ activity: 'resting' });
    // 再记一笔员工回合：容量跟着回升，但比例仍在红线上（100%），灯仍是红。
    const more = addWake(ctx, { jobId: 'job_0000000001' }, worker.id);
    usage(ctx, more.id, worker.id, 100_000);
    expect(ctx.store.table('quota').get('quota')).toMatchObject({ light: 'red' });
    expect(ctx.store.table('bots').get(worker.id)).toMatchObject({ activity: 'resting' });
  });
});

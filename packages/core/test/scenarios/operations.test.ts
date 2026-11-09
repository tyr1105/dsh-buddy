/** 场景 8–12 验证运行安全边界：并发、预算、错误隔离、重启补课与一次审批票。 */
import { describe, expect, it } from 'vitest';
import { advance, createSimWorld } from '../../src/sim/runner.js';
import { botIds, bots, complete, hour, minute, progressBrain, queue, startAt } from './fixtures.js';

describe('场景 8–12：调度和运行边界', () => {
  it('8：三机器人同时紧急，最多两个运行；主人在线时只放一个', async () => {
    for (const ownerPresent of [false, true]) {
      const world = await createSimWorld({ bots: bots(3), startAt });
      for (const botId of botIds) world.host.registerBrain(botId, async () => ({ hang: true }));
      await advance(world, 3 * minute);
      if (ownerPresent) await world.hub.onOwnerActivity(world.clock.now());
      for (const botId of botIds) queue(world, botId, `urgent:${botId}`);
      await world.hub.tick();
      await world.host.settle();
      await advance(world, 4 * minute);
      const limit = ownerPresent ? 1 : 2;
      expect(world.store.table('wakes').count(w => w.endedAt === null)).toBe(limit);
      expect(world.host.maxRunning).toBe(limit);
      expect(world.store.table('queue').count()).toBe(3 - limit);
      expect(world.store.log('appraisals').all().some(a => a.suppressedBy === 'concurrency')).toBe(true);
    }
  });

  it('9a：当天六个自主回合后，第七个被个人预算拦住', async () => {
    const world = await createSimWorld({ bots: bots(), startAt });
    world.host.registerBrain(botIds[0], progressBrain);
    await advance(world, 3 * minute);
    for (let index = 0; index < 7; index++) {
      queue(world, botIds[0], `fact:${index}`);
      await world.hub.tick();
      await world.host.settle();
      if (index < 6) await advance(world, 2 * hour);
    }
    expect(world.store.table('wakes').count()).toBe(6);
    expect(world.store.log('ledger').all().filter(l => l.kind === 'turn')).toHaveLength(6);
    expect(world.store.log('appraisals').all().some(a => a.suppressedBy === 'bot_budget')).toBe(true);
    expect(world.store.table('queue').count()).toBe(1);
  });

  it('9b：额度报错全体休息，窗口后只放一轮探针并恢复', async () => {
    const world = await createSimWorld({ bots: bots(2), startAt });
    world.host.registerBrain(botIds[0], progressBrain);
    await advance(world, 3 * minute);
    queue(world, botIds[0], 'first-success');
    await world.hub.tick();
    await world.host.settle();
    world.host.registerBrain(botIds[0], async () => ({ error: 'rate limit exceeded', tokens: 3000 }));
    await advance(world, 2 * minute);
    queue(world, botIds[0], 'quota-error');
    await world.hub.tick();
    await world.host.settle();
    const red = world.store.table('quota').get('quota')!;
    expect(red.light).toBe('red');
    expect(world.store.table('bots').list().every(b => b.activity === 'resting')).toBe(true);
    world.host.registerBrain(botIds[0], progressBrain);
    queue(world, botIds[0], 'quota-probe');
    const before = world.store.table('wakes').count();
    await advance(world, red.redUntil! - world.clock.now() - minute);
    expect(world.store.table('wakes').count()).toBe(before);
    await advance(world, minute);
    expect(world.store.table('wakes').count()).toBe(before + 1);
    expect(world.store.table('quota').get('quota')?.light).toBe('green');
    expect(world.store.table('bots').list().every(b => b.activity === 'watching')).toBe(true);
  });

  it('10：四次连续投递失败按退避重排，最后隔离且告警', async () => {
    const world = await createSimWorld({ bots: bots(), startAt, seed: 47 });
    world.host.failNextDeliveries(botIds[0], 4, '模拟宿主投递失败');
    queue(world, botIds[0], 'delivery-failure');
    await advance(world, hour);
    const wakes = world.store.table('wakes').list();
    expect(wakes).toHaveLength(4);
    expect(wakes.every(w => w.status === 'error' && w.dispatchedAt === null)).toBe(true);
    expect(world.store.table('bots').get(botIds[0])).toMatchObject({ lifecycle: 'quarantined', consecutiveErrors: 4 });
    expect(world.store.table('alerts').list(a => a.status === 'open' && a.botId === botIds[0]).length).toBeGreaterThan(0);
    const intervals = wakes.slice(1).map((wake, index) => wake.startedAt - wakes[index]!.startedAt);
    for (const [index, delay] of [2 * minute, 10 * minute, 30 * minute].entries()) {
      expect(intervals[index]).toBeGreaterThanOrEqual(delay * 0.8);
      expect(intervals[index]).toBeLessThanOrEqual(delay * 1.2 + minute);
    }
  });

  it('11：心跳停两小时重启后，每人一次补课并间隔至少九十秒', async () => {
    const world = await createSimWorld({ bots: bots(3), startAt });
    for (const botId of botIds) world.host.registerBrain(botId, progressBrain);
    await world.hub.tick();
    await world.hub.stop();
    world.clock.advance(2 * hour);
    await world.hub.start();
    expect(world.store.table('wakes').count()).toBe(0);
    await advance(world, 8 * minute);
    const wakes = world.store.table('wakes').list();
    expect(wakes).toHaveLength(3);
    expect(wakes.every(w => w.variant === 'catch_up' && w.reason.kind === 'catch_up')).toBe(true);
    expect(new Set(wakes.map(w => w.botId)).size).toBe(3);
    expect(wakes[0]!.startedAt).toBeGreaterThanOrEqual(startAt + 2 * hour + 3 * minute);
    expect(wakes[1]!.startedAt - wakes[0]!.startedAt).toBeGreaterThanOrEqual(90_000);
    expect(wakes[2]!.startedAt - wakes[1]!.startedAt).toBeGreaterThanOrEqual(90_000);
    expect(world.host.turns.every(t => t.packet.includes('停了') && t.packet.includes('2 小时'))).toBe(true);
    expect(world.store.table('downtime').list()).toEqual([expect.objectContaining({ kind: 'host_down', handled: true })]);
  });

  it('12：C 类工具被拒并建审批，批准后同参数只放行一次', async () => {
    const world = await createSimWorld({ bots: bots(), startAt });
    await advance(world, 3 * minute);
    const results: boolean[] = [];
    const command = { command: 'curl -X POST https://public.invalid/inbox -d hello' };
    let rounds = 0;
    world.host.registerBrain(botIds[0], async input => {
      rounds++;
      const result = await input.call('exec_command', command);
      results.push(result.ok);
      if (rounds > 1) results.push((await input.call('exec_command', command)).ok);
      return complete(input, rounds === 1 ? { outcome: 'needs_owner', ownerQuestion: {
        text: '允许提交这份公开资料吗？', whyNeeded: '别人会看到提交结果', options: ['允许', '暂缓'], defaultOption: '暂缓' } }
        : { outcome: 'progress', summary: '已执行一次批准的动作' });
    });
    await world.hub.api.sendMessage(botIds[0], '提交公开资料');
    await world.host.settle();
    const approval = world.store.table('approvals').list()[0]!;
    expect(approval).toMatchObject({ actionClass: 'C', status: 'pending' });
    expect(results).toEqual([false]);
    expect(await world.hub.api.decideApproval(approval.id, true, '仅批准本次')).toMatchObject({ ok: true });
    await world.host.settle();
    await advance(world, 2 * minute);
    expect(results).toEqual([false, true, false]);
    expect(world.store.table('approvals').get(approval.id)?.usedAt).not.toBeNull();
    expect(world.store.table('wakes').list().at(-1)?.reason.kind).toBe('approval_decided');
    expect(world.store.table('approvals').count(a => a.status === 'pending')).toBe(1);
  });
});

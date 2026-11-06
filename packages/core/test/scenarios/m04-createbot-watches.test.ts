/** M04 从新建入口验证起步关注：真实文件事件经去抖、评估、调度和宿主交账完成一次自主唤醒。 */
import { expect, it, vi } from 'vitest';
import { advance, createSimWorld } from '../../src/sim/runner.js';
import { okData } from '../c04-api-fixtures.js';
import { minute, startAt } from './fixtures.js';

it('M04 新建时带 file 关注，文件变化经去抖产生感知并真实唤醒', async () => {
  const world = await createSimWorld({ bots: [], startAt });
  const target = '/sim-public/report.txt';
  await world.fs.writeTextAtomic(target, '初始');
  const listen = vi.spyOn(world.fs, 'watch');

  try {
    // 关注项和高重要度目标都随创建提交，不靠直接落表补齐新机器人的能力。
    const bot = okData(await world.hub.api.createBot({
      name: '起步观察员', role: 'sentinel', persona: '持续核对公开报告的变化',
      aspirations: ['及时识别公开报告里的重要变化'],
      goals: [{ title: '核对报告更新', doneWhen: '新版本被核实', period: 'one_off', importance: 1 }],
      watches: [{ kind: 'file', target, why: '公开报告变化时重新核对结论' }],
    }));
    await world.host.settle();
    const watches = world.store.table('watches').list(row => row.botId === bot.id);
    expect(watches).toEqual([expect.objectContaining({ kind: 'file', target, status: 'active', createdBy: 'owner' })]);
    const watch = watches[0]!;
    expect(listen).toHaveBeenCalledTimes(1);
    expect(listen).toHaveBeenCalledWith('/sim-public', { recursive: false }, expect.any(Function));
    expect(world.store.table('bots').get(bot.id)?.lifecycle).toBe('probation');

    // 初始基线不应冒充变化；先让创建自动触发的试跑结束，并跨过启动静默。
    await advance(world, 3 * minute);
    expect(world.store.table('percepts').list(row => row.watchId === watch.id)).toEqual([]);
    expect(world.store.table('wakes').list()).toEqual([expect.objectContaining({
      botId: bot.id, variant: 'trial', status: 'committed', ownerInitiated: true,
    })]);
    expect(world.host.turns).toHaveLength(1);

    // 一次显著的体积变化足以达到紧急分档；去抖截止前仍然不能产生感知或新回合。
    const changedAt = world.clock.now();
    await world.fs.writeTextAtomic(target, '公开报告的新版本包含了需要核实的新增事实。'.repeat(20));
    await advance(world, world.settings.fileDebounceMs - 1);
    expect(world.store.table('percepts').list(row => row.watchId === watch.id)).toEqual([]);
    expect(world.host.turns).toHaveLength(1);

    await advance(world, 1);
    const percepts = world.store.table('percepts').list(row => row.watchId === watch.id);
    expect(percepts).toHaveLength(1);
    const percept = percepts[0]!;
    expect(percept).toMatchObject({ botId: bot.id, source: 'file', kind: 'changed', location: target,
      createdAt: changedAt + world.settings.fileDebounceMs, tier: 'urgent' });
    expect(percept.summary).toContain(target);
    const wakes = world.store.table('wakes').list(row => row.reason.kind === 'percept');
    expect(wakes).toHaveLength(1);
    const wake = wakes[0]!;
    expect(wake).toMatchObject({ botId: bot.id, variant: 'regular', ownerInitiated: false,
      subjectKey: `watch:${watch.id}`, status: 'committed', error: null,
      dispatchedAt: world.clock.now(), endedAt: world.clock.now() });
    expect(wake.reason.evidence).toContain(percept.id);
    expect(percept.consumedByWake).toBe(wake.id);
    expect(world.host.turns).toHaveLength(2);
    expect(world.host.turns[1]).toMatchObject({ botId: bot.id, status: 'ended', source: { wakeId: wake.id } });
    expect(world.host.turns[1]!.packet).toContain(target);
    expect(world.store.table('commits').list(row => row.wakeId === wake.id)).toHaveLength(1);
    expect(world.store.log('appraisals').all().some(row => row.decision === 'woke' && row.perceptIds.includes(percept.id))).toBe(true);

    // 相同文件不再变化时，已消费事件不会被后续 tick 重复唤醒。
    await advance(world, 5 * minute);
    expect(world.store.table('percepts').list(row => row.watchId === watch.id)).toHaveLength(1);
    expect(world.host.turns).toHaveLength(2);
    expect(listen).toHaveBeenCalledTimes(1);
  } finally {
    await world.hub.stop();
    listen.mockRestore();
  }
});

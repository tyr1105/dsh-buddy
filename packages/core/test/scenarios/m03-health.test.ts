/** M03 可证伪的 Hub 健康接线：真实大脑停住、交账不结束、睡眠与停止都经公共入口。 */
import { expect, it, vi } from 'vitest';
import { createSimWorld, advance } from '../../src/sim/runner.js';
import { bots, botIds, addWatch, minute, hour, complete, progressBrain } from './fixtures.js';

it('M03 [21] 中途睡眠两小时记录 Downtime，所有在岗机器人各补课一次', async () => {
  const world = await createSimWorld({ bots: bots(2).map(bot => ({ ...bot, brain: progressBrain })) });
  await world.hub.tick();
  world.clock.advance(2 * hour);
  await world.hub.tick(); await world.host.settle();
  await advance(world, 2 * minute);
  expect(world.store.table('downtime').list()).toEqual([expect.objectContaining({ kind: 'sleep', handled: true,
    from: world.startAt, to: world.startAt + 2 * hour })]);
  for (const id of botIds.slice(0, 2)) expect(world.store.table('wakes').list(w => w.botId === id && w.reason.kind === 'catch_up')).toHaveLength(1);
});

it('M03 [21] 未交账且十分钟无事件的回合确实取消、计错重排并释放并发', async () => {
  const world = await createSimWorld({ bots: [{ ...bots()[0]!, brain: async () => ({ hang: true }) }] });
  await world.hub.api.sendMessage(botIds[0], '开始处理'); await world.host.settle();
  const wake = world.store.table('wakes').list()[0]!;
  await advance(world, 9 * minute);
  expect(world.host.calls.filter(c => c.method === 'cancel')).toHaveLength(0);
  await advance(world, minute);
  expect(world.host.calls.filter(c => c.method === 'cancel')).toEqual([expect.objectContaining({ args: [wake.sessionId] })]);
  expect(world.store.table('wakes').get(wake.id)).toMatchObject({ status: 'timeout', endedAt: world.clock.now() });
  expect(world.store.table('bots').get(botIds[0])).toMatchObject({ consecutiveErrors: 1, retryAt: expect.any(Number) });
  expect(world.store.table('wakes').count(w => w.endedAt === null)).toBe(0);
});

it('M03 [21] 超过步数先 steer 一次，三分钟仍没结束才 cancel；拆掉 tick 上限接线必失败', async () => {
  const world = await createSimWorld({ bots: [{ ...bots()[0]!, brain: async () => ({ hang: true }) }] });
  await world.hub.api.sendMessage(botIds[0], '完成本轮'); await world.host.settle();
  const wake = world.store.table('wakes').list()[0]!;
  await world.hub.onTurnEvent({ type: 'step', sessionId: wake.sessionId!, at: world.clock.now(), steps: 40, tokens: 0 });
  await world.hub.tick(); await world.host.settle();
  expect(world.host.calls.filter(c => c.method === 'steer')).toEqual([expect.objectContaining({ args: [wake.sessionId,
    '【中心通知】已到本轮上限，请立即调用 hub_commit 收口，未完成的部分写进议程。'] })]);
  await advance(world, 2 * minute);
  expect(world.host.calls.filter(c => c.method === 'steer')).toHaveLength(1);
  expect(world.host.calls.filter(c => c.method === 'cancel')).toHaveLength(0);
  await advance(world, minute);
  expect(world.host.calls.filter(c => c.method === 'cancel')).toHaveLength(1);
  expect(world.store.table('wakes').get(wake.id)?.status).toBe('timeout');
});

it('M03 [21] 宿主漏拦审批框产生 P1，五分钟超时才取消', async () => {
  const world = await createSimWorld({ bots: [{ ...bots()[0]!, brain: async () => ({ awaitingApproval: { tool: 'send_email', summary: '审批被宿主挂起' } }) }] });
  await world.hub.api.sendMessage(botIds[0], '检查权限'); await world.host.settle();
  const wake = world.store.table('wakes').list()[0]!;
  const waiting = world.store.table('alerts').list(a => a.level === 'P1' && a.status === 'open' && a.code === 'host_approval_wait');
  expect(waiting).toHaveLength(1);
  expect(waiting[0]!.text).toBe('执行工具动作正在等待宿主权限确认。中心将在 5 分钟后取消回合。\n宿主原文（供核对）：{"tool":"send_email","summary":"审批被宿主挂起"}');
  await advance(world, 4 * minute); expect(world.host.calls.filter(c => c.method === 'cancel')).toHaveLength(0);
  await advance(world, minute); expect(world.host.calls.filter(c => c.method === 'cancel')).toHaveLength(1);
  expect(world.store.table('wakes').get(wake.id)?.status).toBe('timeout');
});

it('M03 [4] 已交账但无 ended 的回合十分钟直接 committed 收尾，不计错不取消不重试', async () => {
  const world = await createSimWorld({ bots: [{ ...bots()[0]!, brain: async input => {
    await complete(input, { outcome: 'progress' }); return { hang: true };
  } }] });
  await world.hub.api.sendMessage(botIds[0], '完成后交账'); await world.host.settle();
  const wake = world.store.table('wakes').list()[0]!;
  expect(wake).toMatchObject({ status: 'committed', endedAt: null, commitId: expect.any(String) });
  await advance(world, 9 * minute);
  expect(world.store.table('wakes').get(wake.id)?.endedAt).toBeNull();
  await advance(world, minute);
  expect(world.store.table('wakes').get(wake.id)).toMatchObject({ status: 'committed', endedAt: world.clock.now(), error: null });
  expect(world.store.table('bots').get(botIds[0])).toMatchObject({ consecutiveErrors: 0, retryAt: null });
  expect(world.host.calls.filter(c => c.method === 'cancel')).toHaveLength(0);
  expect(world.store.table('wakes').count()).toBe(1);
  expect(world.store.table('queue').count(q => q.reason.kind === 'retry')).toBe(0);
  expect(world.store.log('ledger').all()).toHaveLength(1);
});

it('M03 [24] 有真实在途回合时 stop 不 cancel，之后 ended 仍正常收尾', async () => {
  const world = await createSimWorld({ bots: [{ ...bots()[0]!, brain: async () => ({ hang: true }) }] });
  await world.hub.api.sendMessage(botIds[0], '先开始'); await world.host.settle();
  const wake = world.store.table('wakes').list()[0]!;
  expect(wake.status).toBe('running');
  await world.hub.stop();
  expect(world.host.calls.filter(c => c.method === 'cancel')).toHaveLength(0);
  expect(world.store.table('wakes').get(wake.id)).toMatchObject({ status: 'running', endedAt: null });
  const committed = await world.hub.tools().find(t => t.name === 'hub_commit')!.handler(wake.sessionId!, {
    outcome: 'progress', summary: '停止中心后仍完成了在途任务', worldChanges: [], evidence: [],
    verification: { level: 'none', notCovered: '仅测试收尾' }, blocker: null, nextThink: { mode: 'auto', reason: '等新事实' },
    ownerQuestion: null, reply: '完成', report: null, importance: 5, proposals: [],
  });
  expect(committed.ok).toBe(true);
  await world.hub.onTurnEvent({ type: 'ended', sessionId: wake.sessionId!, at: world.clock.now(), finalText: '结束', tokens: 10 });
  expect(world.store.table('wakes').get(wake.id)).toMatchObject({ status: 'committed', endedAt: world.clock.now() });
});

it('M03 [24] stop 调用所有实际 watch disposer，重启后每个关注仅注册一次', async () => {
  const world = await createSimWorld({ bots: bots() });
  const watch = world.fs.watch.bind(world.fs);
  const disposers: ReturnType<typeof vi.fn>[] = [];
  vi.spyOn(world.fs, 'watch').mockImplementation((path, options, callback) => {
    const dispose = vi.fn(watch(path, options, callback)); disposers.push(dispose); return dispose;
  });
  for (const name of ['first', 'second']) {
    await world.fs.writeTextAtomic(`/${name}.txt`, '初始');
    addWatch(world, { kind: 'file', target: `/${name}.txt` });
  }
  await world.hub.tick(); expect(disposers).toHaveLength(2);
  await world.hub.stop();
  for (const dispose of disposers) expect(dispose).toHaveBeenCalledTimes(1);
  await world.fs.writeTextAtomic('/first.txt', '停止期间变化');
  await world.hub.start(); await world.hub.tick();
  expect(disposers).toHaveLength(4);
  for (const dispose of disposers.slice(2)) expect(dispose).not.toHaveBeenCalled();
  await advance(world, 2 * minute);
  expect(world.store.table('percepts').list(p => p.source === 'file' && p.summary.includes('first'))).toHaveLength(1);
});

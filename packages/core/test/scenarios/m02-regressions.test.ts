/** M02 新场景在完整 Hub 中推进24小时，验证一次真实交账后没有陈旧轻复查与孤儿并发占位。 */
import { expect, it } from 'vitest';
import { createSimWorld, advance } from '../../src/sim/runner.js';
import { botIds, bots, day, minute, startAt, complete } from './fixtures.js';
import { modelFixtures } from '../model-fixtures.js';
import type { WakeTicket } from '../../src/model/index.js';

it('M02 [11] T1：轻复查中经过多个 tick，真实交账后冻结24小时仅一次', async () => {
  const world = await createSimWorld({ bots: bots(), startAt });
  world.store.table('bots').patch(botIds[0], { lightCheckAt: startAt });
  let held: Parameters<typeof complete>[0] | undefined;
  world.host.registerBrain(botIds[0], async input => { held = input; return { hang: true }; });
  await advance(world, 6 * minute);
  expect(world.store.table('wakes').count()).toBe(1);
  expect(world.store.table('queue').count()).toBe(0);
  expect(held).toBeDefined(); await complete(held!);
  const wake = world.store.table('wakes').list()[0]!;
  await world.hub.onTurnEvent({ type: 'ended', sessionId: wake.sessionId!, at: world.clock.now(), finalText: '完成轻复查', tokens: 1000 });
  await advance(world, day - 6 * minute);
  expect(world.store.table('commits').count()).toBe(1);
  expect(world.store.log('appraisals').all().filter(a => a.decision === 'woke')).toEqual([
    expect.objectContaining({ text: expect.stringContaining('思考分 0.65，门槛 0.60，已唤醒') }),
  ]);
  expect(world.store.table('wakes').list()).toEqual([expect.objectContaining({ variant: 'light_check', status: 'committed' })]);
  expect(world.store.table('queue').count()).toBe(0);
  expect(world.store.table('percepts').count()).toBe(0);
});

it('M02 [17] 重启遗留 delivering 超时释放并发并按投递失败重排，不记真实用量', async () => {
  const world = await createSimWorld({ bots: bots(), startAt });
  const orphan = { ...(modelFixtures.WakeTicket.valid as WakeTicket), botId: botIds[0], status: 'delivering' as const,
    startedAt: startAt, lastEventAt: startAt, endedAt: null, dispatchedAt: null };
  world.store.table('wakes').put(orphan);
  await advance(world, 2 * minute); expect(world.store.table('wakes').get(orphan.id)?.status).toBe('delivering');
  await advance(world, minute);
  expect(world.store.table('wakes').get(orphan.id)).toMatchObject({ status: 'error', dispatchedAt: null, endedAt: startAt + 3 * minute });
  expect(world.store.table('bots').get(botIds[0])).toMatchObject({ consecutiveErrors: 1, retryAt: expect.any(Number) });
  expect(world.store.log('ledger').all()).toHaveLength(0);
});

/** 场景输入集中在此：只准备世界事实，唤醒、工具执行与交账必须经过完整 Hub。 */
import { expect } from 'vitest';
import type { Bot, QueueEntry, Watch } from '../../src/model/index.js';
import type { Brain, BrainInput } from '../../src/sim/sim-host.js';
import type { SimWorld } from '../../src/sim/runner.js';
import { commitArgs } from '../c03-turn-fixtures.js';
import { watchFixture, goalFixture } from '../model-fixtures.js';

export const minute = 60_000;
export const hour = 60 * minute;
export const day = 24 * hour;
export const startAt = Date.parse('2026-11-05T10:00:00+08:00');
export const botIds = ['b_0000000001', 'b_0000000002', 'b_0000000003'] as const;

/** 每个测试独立生成在岗档案，避免试岗半额预算干扰非试岗场景。 */
export function bots(count = 1): Array<Partial<Bot> & { id: string }> {
  return botIds.slice(0, count).map((id, index) => ({ id, name: ['守望', '求知', '践行'][index],
    role: (['sentinel', 'researcher', 'executor'] as const)[index], autonomy: 'L2', lifecycle: 'active' }));
}

/** 注入关注配置是世界输入；后续感知统一交给 tick 或宿主事件生成。 */
export function addWatch(world: SimWorld, patch: Partial<Watch> = {}): Watch {
  const row = { ...watchFixture, id: `wt_${(world.store.table('watches').count() + 1).toString(36).padStart(10, '0')}`,
    botId: botIds[0], kind: 'session' as const, target: 'any', relevance: 1,
    createdAt: world.clock.now(), updatedAt: world.clock.now(), ...patch };
  world.store.table('watches').put(row);
  return row;
}

/** 有目标的机器人才应把相关资料视为重要；耐心默认拉长，单独测试内驱时再覆盖。 */
export function addGoal(world: SimWorld, botId = botIds[0] as string, patch = {}) {
  const aspirationId = `asp_${botId.slice(2)}`;
  world.store.table('aspirations').put({ id: aspirationId, botId, text: '持续核对公开事实', status: 'active',
    createdBy: 'owner', approved: true, createdAt: world.clock.now() });
  const row = { ...goalFixture, id: `g_${(world.store.table('goals').count() + 1).toString(36).padStart(10, '0')}`,
    botId, aspirationId, importance: 1, patienceMs: 30 * day, lastProgressAt: world.clock.now(),
    createdAt: world.clock.now(), updatedAt: world.clock.now(), ...patch };
  world.store.table('goals').put(row);
  return row;
}

/** 真正从宿主事件入口送入异常，断言必须追到它产生的感知、候选与唤醒单。 */
export async function external(world: SimWorld, sequence: number, type: 'error' | 'finished' = 'error') {
  await world.hub.onExternalSessionEvent({ type, sessionId: `work-${sequence}`, title: '资料核对',
    at: world.clock.now(), summary: `第 ${sequence} 次公开事实变化` });
  await world.host.settle();
}

/** 只给调度边界场景注入候选输入，不直接写唤醒、交账或计量结果。 */
export function queue(world: SimWorld, botId: string, key: string, patch: Partial<QueueEntry> = {}) {
  const now = world.clock.now();
  world.store.table('queue').put({ id: `q_${(world.store.table('wakes').count() + world.store.table('queue').count() + 1).toString(36).padStart(10, '0')}`,
    botId, variant: 'regular', reason: { kind: 'percept', score: 1, threshold: 0.6,
      summary: `测试世界的重要变化 ${key}`, evidence: [key] }, urgent: true, ownerInitiated: false,
    priority: 70, subjectKey: key, notBefore: now, enqueuedAt: now, ...patch });
}

/** 真实调用工具并检查回包，避免大脑被拒绝却让测试误以为完成了交账。 */
export async function complete(input: BrainInput, patch: Parameters<typeof commitArgs>[0] = {}) {
  const result = input.variant === 'reflection'
    ? await input.call('hub_reflect_commit', { summary: '复盘完成，等待新事实', lessons: [], watchChanges: [], routineUpdates: [] })
    : await input.call('hub_commit', commitArgs({ reply: input.packet.includes('主人对你说') ? '收到，已处理本次要求' : null, ...patch }));
  expect(result).toMatchObject({ ok: true });
  return { finalText: '本轮结束' };
}
export const progressBrain: Brain = input => complete(input, { outcome: 'progress', summary: '已核对本次变化' });

/** 理由须能审计且没有固定闹钟来源，不能只检查有一个 truthy 对象。 */
export function assertReasons(world: SimWorld) {
  for (const wake of world.store.table('wakes').list()) {
    expect(wake.reason.kind).toBeTruthy();
    expect(wake.reason.score).toBeGreaterThanOrEqual(0);
    expect(wake.reason.score).toBeLessThanOrEqual(1);
    expect(wake.reason.threshold).toBeGreaterThanOrEqual(0);
    expect(wake.reason.summary.trim().length).toBeGreaterThan(0);
    expect(wake.reason.summary).not.toMatch(/固定钟点|定时任务|cron/i);
    expect(Array.isArray(wake.reason.evidence)).toBe(true);
    if (!['next_think', 'light_check'].includes(wake.reason.kind)) {
      expect(wake.reason.evidence.length).toBeGreaterThan(0);
    }
  }
}

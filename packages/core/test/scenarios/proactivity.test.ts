/** 主动性场景 1–7：以真实时钟推进、宿主事件和机器人工具验证 T1–T7。 */
import { describe, expect, it } from 'vitest';
import { createSimWorld, advance, metrics } from '../../src/sim/runner.js';
import { quietBrain } from '../../src/sim/brains.js';
import { coefficientOfVariation } from '../../src/util/stats.js';
import { recordPercept } from '../../src/perception/percept.js';
import { createTestContext } from '../../src/io/testing/create-test-context.js';
import { addGoal, addWatch, assertReasons, botIds, bots, complete, day, external, hour, minute, queue, startAt } from './fixtures.js';

describe('场景 1–7：主动性验收 T1–T7', () => {
  it('1 / T1：冻结世界 24 小时最多一次轻复查', async () => {
    const world = await createSimWorld({ bots: bots(), startAt });
    world.host.registerBrain(botIds[0], quietBrain);
    await advance(world, day);
    const wakes = world.store.table('wakes').list();
    expect(wakes.length).toBeLessThanOrEqual(1);
    expect(wakes.every(w => w.variant === 'light_check')).toBe(true);
    expect(world.store.table('percepts').count()).toBe(0);
  });

  it('2 / T2：三天随机事件的每次唤醒都保留完整理由', async () => {
    const world = await createSimWorld({ bots: bots(), startAt, seed: 104 });
    addWatch(world);
    addGoal(world);
    world.host.registerBrain(botIds[0], input => complete(input, { outcome: 'progress' }));
    await advance(world, 3 * day, { beforeTick: async (w, index) => {
      if (index % 60 === 0 && w.rng.next() > 0.25) await external(w, index);
    } });
    expect(world.store.table('wakes').count()).toBeGreaterThan(5);
    expect(world.store.table('percepts').count()).toBeGreaterThan(20);
    assertReasons(world);
  });

  it('3 / T3：前两天密集、后五天稀疏，七天间隔变异大于 0.5 且多数由机器人决定', async () => {
    // 周一开始使密集期后的预约有机会真实到点；周末复盘是合法的新意图，不冒充按约唤醒。
    const t3Start = Date.parse('2026-11-09T10:00:00+08:00');
    const world = await createSimWorld({ bots: bots(), startAt: t3Start });
    addWatch(world);
    world.host.registerBrain(botIds[0], input => complete(input, { outcome: 'progress',
      nextThink: { mode: 'after', afterMinutes: 36 * 60, reason: '等下一批公开资料积累后再核对' } }));
    await advance(world, 7 * day, { beforeTick: async (w, index) => {
      if (index < 2 * 24 * 60 && index % 60 === 0) await external(w, index);
      if (index === (6 * 24 + 12) * 60) await external(w, index);
    } });
    const times = world.store.table('wakes').list(w => w.dispatchedAt !== null).map(w => w.startedAt).sort((a, b) => a - b);
    const intervals = times.slice(1).map((at, i) => at - times[i]!);
    expect(times.length).toBeGreaterThan(6);
    expect(coefficientOfVariation(intervals)).toBeGreaterThan(0.5);
    const commits = world.store.table('commits').list();
    expect(commits.filter(c => ['at', 'after', 'on_event'].includes(c.nextThink.mode)).length / commits.length).toBeGreaterThanOrEqual(0.5);
    expect(commits.every(c => c.nextThink.reason.trim().length > 0)).toBe(true);
    // 只验收没有被更早交账替换的预约，逐条核对实际投递时刻，拆掉意图时钟必失败。
    const appointments = commits.flatMap((commit, index) => {
      if (commit.nextThink.mode !== 'after') return [];
      const dueAt = commit.createdAt + commit.nextThink.afterMinutes! * minute;
      const supersededAt = commits[index + 1]?.createdAt ?? Infinity;
      return dueAt <= world.clock.now() && supersededAt >= dueAt ? [dueAt] : [];
    });
    expect(appointments.length).toBeGreaterThanOrEqual(2);
    const bookedWakes = world.store.table('wakes').list(w => w.reason.kind === 'next_think' && w.dispatchedAt !== null);
    expect(bookedWakes.length).toBeGreaterThanOrEqual(2);
    for (const dueAt of appointments) {
      const wake = bookedWakes.find(w => w.subjectKey === `next_think:${botIds[0]}:${dueAt}`);
      expect(wake, `预约 ${dueAt} 必须由 next_think 实际兑现`).toBeDefined();
      expect(wake!.startedAt - dueAt).toBeGreaterThanOrEqual(0);
      expect(wake!.startedAt - dueAt).toBeLessThanOrEqual(2 * world.settings.tickMs);
    }
    const current = world.store.table('bots').get(botIds[0])!;
    const latest = commits.at(-1)!;
    expect(current.nextThinkMode).toBe(latest.nextThink.mode);
    if (['at', 'after'].includes(latest.nextThink.mode)) expect(current.nextThinkAt).toBeGreaterThan(world.clock.now());
    else expect(current.nextThinkAt).toBeNull();
    expect(current.nextThinkBy).toBe('bot');
    expect(current.nextThinkAt).toBeGreaterThan(world.clock.now());
  }, 15_000);

  it('4 / T4：机器人通过工具发起议程与提议，统计可追溯', async () => {
    const world = await createSimWorld({ bots: bots(), startAt });
    world.host.registerBrain(botIds[0], async input => {
      expect(await input.call('hub_agenda_upsert', { kind: 'task', title: '自主核对一个公开来源',
        abandonWhen: '来源撤回', priority: 3 })).toMatchObject({ ok: true });
      return complete(input, { outcome: 'progress', proposals: [{ title: '增加一个独立核验来源', detail: '降低单来源误差', value: 0.8, confidence: 0.8 }] });
    });
    expect(await world.hub.api.sendMessage(botIds[0], '请开始观察')).toMatchObject({ ok: true });
    await world.host.settle();
    expect(world.store.table('agenda').list()).toEqual([expect.objectContaining({ source: 'bot', title: '自主核对一个公开来源' })]);
    expect(world.store.table('inbox').list(i => i.type === 'proposal')).toHaveLength(1);
    const view = await world.hub.api.bot(botIds[0]);
    expect(view.stats.selfInitiated7d).toBe(2);
    expect(metrics(world)).toBeTruthy();
  });

  it('5 / T5：大脑调慢已有关注并提出新关注，前后审计都有记录', async () => {
    const world = await createSimWorld({ bots: [{ ...bots()[0]!, autonomy: 'L1' }], startAt });
    const watch = addWatch(world, { kind: 'http', target: 'https://public.invalid/feed', intervalMs: 15 * minute });
    world.net.set(watch.target, { status: 200, text: '初始资料', contentType: 'text/plain' });
    world.host.registerBrain(botIds[0], async input => {
      expect(await input.call('hub_watch_update', { id: watch.id, intervalMinutes: 60 })).toMatchObject({ ok: true });
      expect(await input.call('hub_watch_propose', { kind: 'http', target: 'https://public.invalid/second',
        intervalMinutes: 120, why: '增加一个独立公开来源' })).toMatchObject({ ok: true });
      return complete(input);
    });
    await world.hub.api.sendMessage(botIds[0], '整理注意力');
    await world.host.settle();
    expect(world.store.table('watches').get(watch.id)?.intervalMs).toBe(hour);
    expect(world.store.table('watches').list(w => w.createdBy === 'bot')).toEqual([expect.objectContaining({ status: 'proposed' })]);
    const audit = world.store.log('audit').all();
    expect(audit.some(a => a.actor === botIds[0] && a.action === 'hub_watch_update' && a.detail.includes('900000') && a.detail.includes('3600000'))).toBe(true);
    expect(audit.some(a => a.actor === botIds[0] && a.action === 'hub_watch_propose')).toBe(true);
  });

  it('6 / T6：外界不变而目标超过耐心期，停滞内驱自行唤醒', async () => {
    const world = await createSimWorld({ bots: bots(), startAt });
    addGoal(world, botIds[0], { patienceMs: hour, lastProgressAt: startAt - 3 * hour });
    world.host.registerBrain(botIds[0], input => complete(input, { outcome: 'progress', summary: '换一个方法核对目标' }));
    await advance(world, 5 * minute);
    expect(world.store.table('percepts').count()).toBe(0);
    expect(world.store.table('wakes').list()).toEqual([expect.objectContaining({ reason: expect.objectContaining({ kind: 'drive', summary: expect.stringContaining('停滞') }) })]);
    expect(world.store.table('commits').list()[0]?.outcome).toBe('progress');
  });

  it('7a / T7：夜间 P1 提问不单推、进次日日报，P0 仍推送', async () => {
    const night = Date.parse('2026-11-05T23:05:00+08:00');
    const world = await createSimWorld({ bots: bots(2), startAt: night });
    world.host.registerBrain(botIds[0], input => complete(input, { outcome: 'needs_owner',
      ownerQuestion: { text: '选择哪份资料？', whyNeeded: '存在两份不同版本', options: ['第一份', '第二份'], defaultOption: '第一份' } }));
    await world.hub.api.sendMessage(botIds[0], '检查资料');
    await world.host.settle();
    expect(world.store.table('inbox').list(i => i.type === 'question')).toHaveLength(1);
    expect(world.host.notifications).toHaveLength(0);
    world.host.registerBrain(botIds[1], async () => ({ error: '401 unauthorized: credential expired' }));
    await world.hub.api.sendMessage(botIds[1], '核对连接');
    await world.host.settle();
    await world.hub.tick();
    expect(world.host.notifications.some(n => n.level === 'P0')).toBe(true);
    expect(world.host.notifications.every(n => n.level === 'P0')).toBe(true);
    await advance(world, 10 * hour);
    expect(world.store.log('thread').all().some(m => m.kind === 'digest' && m.text.includes('选择哪份资料') && m.text.includes('免打扰已推迟'))).toBe(true);
  });

  it('7b / T7：等主人时丢弃同一事项，主人作答后立即唤醒', async () => {
    const world = await createSimWorld({ bots: bots(), startAt });
    const watch = addWatch(world);
    let rounds = 0;
    world.host.registerBrain(botIds[0], input => complete(input, ++rounds === 1 ? { outcome: 'needs_owner',
      ownerQuestion: { text: '此事项继续吗？', whyNeeded: '需要明确方向', options: ['继续', '暂停'], defaultOption: '暂停' } } : { outcome: 'progress', reply: '收到，继续核对' }));
    await advance(world, 3 * minute);
    await external(world, 1);
    const question = world.store.table('inbox').list(i => i.type === 'question')[0]!;
    expect(question.subjectKey).toBe(`question:${question.id}`);
    // 同问题的新事实确实存在感知表；只放一个空候选无法发现丢弃后遗留 urgent 的死循环。
    const source = createTestContext({ store: world.store, clock: world.clock, rng: world.rng, settings: world.settings });
    const repeated = recordPercept(source, { botId: botIds[0], watchId: null, source: 'inbox', kind: 'question_context',
      summary: '同一问题还有一份待选材料', location: question.id, fingerprintMaterial: '重复问题材料', magnitude: 1,
      anomaly: true, untrusted: true, occurredAt: world.clock.now() })!;
    queue(world, botIds[0], question.subjectKey, { reason: { kind: 'percept', score: repeated.salience, threshold: 0.6,
      summary: repeated.summary, evidence: [repeated.id] } });
    await world.hub.tick();
    expect(world.store.table('wakes').count()).toBe(1);
    expect(world.store.log('appraisals').all().some(a => a.suppressedBy === 'waiting_owner_same_subject')).toBe(true);
    expect(world.store.table('percepts').get(repeated.id)?.discardedAt).toBe(world.clock.now());
    const beforeAnswer = world.store.table('wakes').count();
    expect(await world.hub.api.answerInbox(question.id, '继续')).toMatchObject({ ok: true });
    await world.host.settle();
    expect(world.store.table('wakes').count()).toBe(2);
    expect(world.store.table('wakes').list().at(-1)?.reason.kind).toBe('inbox_reply');
    await advance(world, day);
    expect(world.store.table('wakes').count() - beforeAnswer).toBeLessThanOrEqual(1);
    expect(world.store.table('alerts').list(a => a.code === 'deadman')).toEqual([]);
    expect(world.store.table('wakes').list(w => w.reason.kind === 'retry')).toEqual([]);
    await advance(world, 2 * minute);
    await external(world, 2);
    expect(world.store.table('wakes').count()).toBe(3);
    expect(world.store.table('wakes').list().at(-1)?.subjectKey).toBe(`watch:${watch.id}`);
  });
});

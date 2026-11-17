/** 场景 13–17 贯穿同伴交接、主人教学与聊天、未交账守卫和全新中心启动。 */
import { describe, expect, it } from 'vitest';
import { advance, createSimWorld } from '../../src/sim/runner.js';
import { noCommitBrain, replyBrain } from '../../src/sim/brains.js';
import { createHandoff } from '../../src/peer/handoffs.js';
import { botIds, bots, complete, hour, minute, progressBrain, startAt, worldContext } from './fixtures.js';

describe('场景 13–17：协作与主人入口', () => {
  it('13a：交接生成接收方议程与唤醒，完成后发起方收到结果', async () => {
    const world = await createSimWorld({ bots: bots(2), startAt });
    let offered = false;
    world.host.registerBrain(botIds[0], async input => {
      if (!offered) {
        offered = true;
        // P74b：hub_handoff 已移出工具清单，旧式交接的接收、完成、过期处理仍在，所以场景直接调用交接函数造出一条（断言不变）。
        expect(await createHandoff(worldContext(world), botIds[0], { to: botIds[1], task: '复核资料来源', why: '需要独立核验' })).toMatchObject({ status: 'offered' });
      }
      return complete(input, { outcome: 'progress' });
    });
    world.host.registerBrain(botIds[1], async input => {
      const agenda = world.store.table('agenda').list(a => a.botId === botIds[1] && a.source === 'peer')[0]!;
      expect(agenda).toBeDefined();
      expect(await input.call('hub_agenda_upsert', { id: agenda.id, kind: 'task', title: agenda.title,
        abandonWhen: '资料撤回', priority: 3 })).toMatchObject({ ok: true });
      expect(world.store.table('handoffs').list()[0]?.status).toBe('accepted');
      expect(await input.call('hub_agenda_close', { id: agenda.id, status: 'done', note: '两个来源一致' })).toMatchObject({ ok: true });
      return complete(input, { outcome: 'progress' });
    });
    await world.hub.api.sendMessage(botIds[0], '组织一次复核');
    await world.host.settle();
    await advance(world, 5 * minute);
    expect(world.store.table('handoffs').list()).toEqual([expect.objectContaining({ status: 'done' })]);
    expect(world.store.table('agenda').list()).toEqual([expect.objectContaining({ status: 'done', source: 'peer' })]);
    expect(world.store.table('wakes').list(w => w.botId === botIds[1])).toHaveLength(1);
    expect(world.store.table('percepts').list(p => p.botId === botIds[0] && p.summary.includes('完成了交接'))).toHaveLength(1);
    expect(world.store.log('thread').all().some(m => m.kind === 'handoff' && m.text.includes('完成了交接'))).toBe(true);
  });

  it('13b：同伴两小时未接单，发起方被等人内驱叫醒', async () => {
    const world = await createSimWorld({ bots: bots(2), startAt });
    let offered = false;
    world.host.registerBrain(botIds[0], async input => {
      if (!offered) {
        offered = true;
        expect(await createHandoff(worldContext(world), botIds[0], { to: botIds[1], task: '核对未接收资料', why: '请同伴核验' })).toMatchObject({ status: 'offered' });
      }
      return complete(input, { outcome: 'progress' });
    });
    world.host.registerBrain(botIds[1], progressBrain);
    await world.hub.api.sendMessage(botIds[0], '交给同伴核验');
    await world.host.settle();
    await advance(world, 2 * hour + 5 * minute);
    expect(world.store.table('handoffs').list()[0]?.status).toBe('offered');
    expect(world.store.table('wakes').list(w => w.botId === botIds[0] && w.reason.kind === 'drive')).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ summary: expect.stringMatching(/交接|等/) }) }),
    ]);
    expect(world.store.log('audit').all().some(a => a.action === 'handoff_waiting')).toBe(true);
  });

  // P75f：教学变体与 hub_routine_save 已下线，场景 14「教学变体把选定会话变成套路」删除。

  it('15：主人连续发消息都即时放行，回复进入对应线程', async () => {
    const world = await createSimWorld({ bots: bots(), startAt });
    world.host.registerBrain(botIds[0], replyBrain);
    for (const message of ['看看当前进展', '补充解释一下']) {
      expect(await world.hub.api.sendMessage(botIds[0], message)).toMatchObject({ ok: true });
      await world.host.settle();
    }
    const wakes = world.store.table('wakes').list();
    expect(wakes).toHaveLength(2);
    expect(wakes.every(w => w.startedAt === startAt && w.ownerInitiated)).toBe(true);
    const messages = world.store.log('thread').all().filter(m => m.thread === botIds[0]);
    expect(messages.filter(m => m.from === 'owner')).toHaveLength(2);
    expect(messages.filter(m => m.kind === 'reply' && m.from === botIds[0])).toHaveLength(2);
  });

  // P75f：连续未交账不再强制复盘（旧触发下线）；三轮都是常规回合。
  // P75r3 第 5 节曾把最后一句改成 quarantined；P75r4 第 1 节改回：这三轮是主人消息叫醒的回合，不在停用线的范围内
  // （停用线只管员工自己发起的回合），所以仍断言在岗（active），也没有停用原因。
  it('16：主人消息叫醒的连续三轮未交账，三轮仍都是常规回合、不强制复盘，也不因此停用', async () => {
    const world = await createSimWorld({ bots: bots(), startAt });
    world.host.registerBrain(botIds[0], noCommitBrain);
    for (const text of ['核对第一份', '核对第二份', '再看一轮']) {
      await world.hub.api.sendMessage(botIds[0], text);
      await world.host.settle();
    }
    const wakes = world.store.table('wakes').list();
    expect(wakes).toHaveLength(3);
    expect(wakes.map(w => w.status)).toEqual(['no_commit', 'no_commit', 'no_commit']);
    expect(wakes.map(w => w.variant)).toEqual(['regular', 'regular', 'regular']);
    expect(world.store.table('commits').list().every(c => c.summary === '未交账')).toBe(true);
    expect(world.store.table('bots').get(botIds[0])).toMatchObject({ lifecycle: 'active', quarantineReason: null });
    expect(wakes.every(w => w.ownerInitiated)).toBe(true);
  });

  it('17：冷启动建立全体守则和完整家目录，创建后不自动试跑', async () => {
    const world = await createSimWorld({ bots: [], startAt });
    const root = world.settings.rootDir;
    for (const directory of ['', '/bots', '/shared/handoffs', '/.hub']) {
      expect(await world.fs.stat(`${root}${directory}`)).toMatchObject({ isDir: true });
    }
    expect(await world.fs.readText(`${root}/AGENTS.md`)).toBeTruthy();
    const created = await world.hub.api.createBot({ name: '新伙伴', role: 'executor', persona: '先核对再行动',
      aspirations: ['把交付物准备清楚'], autonomy: 'L2' });
    expect(created).toMatchObject({ ok: true });
    await world.host.settle();
    const bot = world.store.table('bots').list()[0]!;
    // P73a（5.1 第 1 类）：原预期 lifecycle probation、probationEndsAt 为开始时间加七天；新预期 active、null。
    expect(bot.lifecycle).toBe('active');
    expect(bot.probationEndsAt).toBeNull();
    expect(bot.activity).toBe('watching');
    for (const directory of ['mind', 'memory/journal', 'playbooks', '.agents/skills', 'work']) {
      expect(await world.fs.stat(`${bot.homeDir}/${directory}`)).toMatchObject({ isDir: true });
    }
    expect(await world.fs.readText(`${bot.homeDir}/AGENTS.md`)).toContain('新伙伴');
    expect(await world.fs.readText(`${bot.homeDir}/memory/MEMORY.md`)).toBeTruthy();
    // P72h H3：新建员工不再自动试跑，创建后没有任何回合。
    expect(world.store.table('wakes').list()).toEqual([]);
    expect(await world.fs.stat(`${root}/.git`)).toBeNull();
  });
});

/** 场景 13–17 贯穿同伴交接、主人教学与聊天、未交账守卫和全新中心启动。 */
import { describe, expect, it } from 'vitest';
import { advance, createSimWorld } from '../../src/sim/runner.js';
import { noCommitBrain, replyBrain } from '../../src/sim/brains.js';
import { botIds, bots, complete, hour, minute, progressBrain, startAt } from './fixtures.js';

describe('场景 13–17：协作与主人入口', () => {
  it('13a：交接生成接收方议程与唤醒，完成后发起方收到结果', async () => {
    const world = await createSimWorld({ bots: bots(2), startAt });
    let offered = false;
    world.host.registerBrain(botIds[0], async input => {
      if (!offered) {
        offered = true;
        expect(await input.call('hub_handoff', { to: botIds[1], task: '复核资料来源', why: '需要独立核验' })).toMatchObject({ ok: true });
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
        expect(await input.call('hub_handoff', { to: botIds[1], task: '核对未接收资料', why: '请同伴核验' })).toMatchObject({ ok: true });
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

  it('14：教学变体把选定会话变成套路，后续唤醒包可见索引', async () => {
    const world = await createSimWorld({ bots: bots(), startAt });
    world.host.digests.set('owner-demo', '主人先打开公开资料，比较两份日期，最后写明来源链接。');
    world.host.registerBrain(botIds[0], async input => {
      if (input.variant === 'teach') {
        expect(input.packet).toContain('主人先打开公开资料');
        expect(await input.call('hub_routine_save', { name: '公开资料复核', whenToUse: '资料有新版本',
          steps: ['打开公开资料', '比较两份日期', '写明来源链接'], learnedFrom: 'owner-demo' })).toMatchObject({ ok: true });
      }
      return complete(input, { outcome: 'progress' });
    });
    expect(await world.hub.api.teach(botIds[0], 'owner-demo', '学会这个核验步骤')).toMatchObject({ ok: true });
    await world.host.settle();
    expect(world.store.table('wakes').list()[0]?.variant).toBe('teach');
    const routine = world.store.table('routines').list()[0]!;
    const home = world.store.table('bots').get(botIds[0])!.homeDir;
    expect(await world.fs.readText(`${home}/playbooks/${routine.slug}.md`)).toContain('比较两份日期');
    await world.hub.api.sendMessage(botIds[0], '按学过的方法复核');
    await world.host.settle();
    expect(world.host.turns.at(-1)?.packet).toContain('公开资料复核');
  });

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

  it('16：两次结束未交账，第三轮强制复盘，再不交账即隔离', async () => {
    const world = await createSimWorld({ bots: bots(), startAt });
    world.host.registerBrain(botIds[0], noCommitBrain);
    for (const text of ['核对第一份', '核对第二份', '复盘本轮']) {
      await world.hub.api.sendMessage(botIds[0], text);
      await world.host.settle();
    }
    const wakes = world.store.table('wakes').list();
    expect(wakes).toHaveLength(3);
    expect(wakes.map(w => w.status)).toEqual(['no_commit', 'no_commit', 'no_commit']);
    expect(wakes.map(w => w.variant)).toEqual(['regular', 'regular', 'reflection']);
    expect(world.store.table('commits').list().every(c => c.summary === '未交账')).toBe(true);
    expect(world.store.table('bots').get(botIds[0])?.lifecycle).toBe('quarantined');
  });

  it('17：冷启动建立全体守则和完整家目录，试跑无需等启动静默', async () => {
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
    expect(bot.lifecycle).toBe('probation');
    expect(bot.probationEndsAt).toBe(startAt + 7 * 24 * hour);
    expect(bot.activity).toBe('watching');
    for (const directory of ['mind', 'memory/journal', 'playbooks', '.agents/skills', 'work']) {
      expect(await world.fs.stat(`${bot.homeDir}/${directory}`)).toMatchObject({ isDir: true });
    }
    expect(await world.fs.readText(`${bot.homeDir}/AGENTS.md`)).toContain('新伙伴');
    expect(await world.fs.readText(`${bot.homeDir}/memory/MEMORY.md`)).toBeTruthy();
    expect(world.store.table('wakes').list()).toEqual([expect.objectContaining({ variant: 'trial', ownerInitiated: true,
      startedAt: startAt, status: 'committed' })]);
    expect(await world.fs.stat(`${root}/.git`)).toBeNull();
  });
});

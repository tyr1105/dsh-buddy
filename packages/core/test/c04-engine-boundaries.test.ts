/** 完整接线后发现的回归：离线证据、空队列恢复、存储失败和时间缓存必须保留真实语义。 */
import { expect, it, vi } from 'vitest';
import { createSimWorld, advance } from '../src/sim/runner.js';
import { createHub } from '../src/engine/hub.js';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { localParts, startOfLocalDay, parseLocalDateTime } from '../src/util/time.js';
import { commitArgs } from './c03-turn-fixtures.js';
import { quietBrain } from '../src/sim/brains.js';
const botId = 'b_0000000001';
const minute = 60_000;
const hour = 60 * minute;

it('离线文件变化在 start 时已形成感知，补课回合同时带停机与文件证据', async () => {
  const world = await createSimWorld({ bots: [{ id: botId }] });
  const path = `${world.settings.rootDir}/shared/source.txt`;
  await world.fs.writeTextAtomic(path, '初始');
  expect(await world.hub.api.upsertWatch({ botId, kind: 'file', target: path, why: '核对离线变化' })).toMatchObject({ ok: true });
  await world.hub.tick();
  await world.hub.stop();
  world.clock.advance(2 * hour);
  await world.fs.writeTextAtomic(path, '停机期间增加了大量新事实');
  const hub = createHub(world);
  world.host.attach(hub);
  world.hub = hub;
  await hub.start();
  const percept = world.store.table('percepts').list(p => p.source === 'file')[0]!;
  expect(percept).toBeDefined();
  const queued = world.store.table('queue').list()[0]!;
  expect(queued.variant).toBe('catch_up');
  expect(queued.reason.evidence).toContain(percept.id);
  await advance(world, 3 * minute);
  const wake = world.store.table('wakes').list()[0]!;
  expect(wake.variant).toBe('catch_up');
  expect(wake.reason.evidence).toContain(percept.id);
  expect(world.host.turns[0]!.packet).toContain('停机补课');
  expect(world.host.turns[0]!.packet).toContain(path);
});

it('额度红灯空队列到期只保留许可，下一件真实工作作为唯一恢复探针', async () => {
  const world = await createSimWorld({ bots: [{ id: botId, brain: async () => ({ error: '429 quota exhausted' }) }] });
  await world.hub.api.sendMessage(botId, '核对连接');
  await world.host.settle();
  const red = world.store.table('quota').get('quota')!;
  expect(red.light).toBe('red');
  // P76r1（4b）同步：原来这里断言队列为空（主人的第一句话被额度报错打断后什么都不排）；现在队列里保留着它的候选，
  // 带「主人发起」、理由写「额度用完，恢复后继续上一轮的事」、最早放行时刻是恢复时刻（不按出错退避）。
  const kept = world.store.table('queue').list();
  expect(kept).toHaveLength(1);
  expect(kept[0]).toMatchObject({ ownerInitiated: true, notBefore: red.redUntil });
  expect(kept[0]!.reason).toMatchObject({ kind: 'retry', summary: '额度用完，恢复后继续上一轮的事' });
  world.host.registerBrain(botId, quietBrain);
  await advance(world, red.redUntil! - world.clock.now());
  // 原来断言「只有 1 个回合、红灯只保留许可」；现在恢复时刻一到，保留的这一句作为唯一的探针回合放行（原意不变：恢复时只放一个探针、没有按出错退避的重试）。
  const afterProbe = world.store.table('wakes').list();
  expect(afterProbe).toHaveLength(2);
  expect(afterProbe[1]!.reason).toMatchObject({ kind: 'retry', summary: '额度用完，恢复后继续上一轮的事' });
  expect(afterProbe[1]!.ownerInitiated).toBe(true);
  expect(world.store.table('queue').count()).toBe(0);
  await world.host.settle();
  // 主人收到了这一句的回复（探针回合的回复落在对话线程里）。
  expect(world.store.log('thread').all().some(message => message.from === botId && message.thread === botId)).toBe(true);
  expect(world.store.table('quota').get('quota')!.light).toBe('green');
  // 之后再发一句，照常处理。
  await world.hub.api.sendMessage(botId, '核对新收到的一份资料');
  await world.host.settle();
  const wakes = world.store.table('wakes').list();
  expect(wakes).toHaveLength(3);
  expect(wakes[2]!.reason).toMatchObject({ kind: 'owner_message', summary: '主人发来消息' });
  expect(world.host.turns.at(-1)?.packet).toContain('核对新收到的一份资料');
  expect(wakes[2]!.reason.evidence.length).toBeGreaterThan(0);
  expect(wakes.filter(w => w.reason.kind === 'retry')).toHaveLength(1);
  expect(world.store.table('quota').get('quota')!.light).toBe('green');
});

it('界面命令保存失败明确返回错误，仍保留脏数据并可在后续入口重试', async () => {
  const ctx = createTestContext();
  const hub = createHub(ctx);
  await hub.start();
  const flush = vi.spyOn(ctx.store, 'flush').mockRejectedValueOnce(new Error('受控写盘失败'));
  const result = await hub.api.createBot({ name: '检查员', role: 'sentinel', persona: '核对事实', aspirations: ['保持资料准确'] });
  expect(result).toMatchObject({ ok: false });
  expect('error' in result && result.error).toContain('保存失败');
  // P73c：启动时中心自动建了一位总管，所以保存失败后内存里是 2 位（总管加刚创建的检查员）。
  expect(ctx.store.table('bots').count()).toBe(2);
  expect(ctx.store.isDirty()).toBe(true);
  await hub.onOwnerActivity(ctx.clock.now());
  expect(flush).toHaveBeenCalledTimes(2);
  expect(ctx.store.isDirty()).toBe(false);
});

it('机器人工具保存失败也返回失败结果，已交账事实保留而不能重复提交', async () => {
  const world = await createSimWorld({ bots: [{ id: botId, brain: async () => ({ hang: true }) }] });
  await world.hub.api.sendMessage(botId, '等待测试');
  await world.host.settle();
  vi.spyOn(world.store, 'flush').mockRejectedValueOnce(new Error('受控写盘失败'));
  const sessionId = world.store.table('bots').get(botId)!.sessionId!;
  const tool = world.hub.tools().find(t => t.name === 'hub_commit')!;
  const result = await tool.handler(sessionId, commitArgs({ reply: '已保存本轮核对结论' }));
  expect(result).toMatchObject({ ok: false });
  expect('error' in result && result.error).toContain('保存失败');
  expect(world.store.isDirty()).toBe(true);
  expect(world.store.table('commits').count()).toBe(1);
  expect(await tool.handler(sessionId, commitArgs({ reply: '重复交账' }))).toMatchObject({ ok: false, error: '本轮已交账' });
  await world.hub.onOwnerActivity(world.clock.now());
  expect(world.store.isDirty()).toBe(false);
});

it('纯时间缓存不共享可变结果，也不串联时区或夏令时分支', () => {
  const at = Date.parse('2026-11-01T06:30:00Z');
  const first = localParts(at, 'America/New_York');
  first.hour = 99;
  expect(localParts(at, 'America/New_York').hour).toBe(1);
  expect(localParts(at, 'Asia/Shanghai').hour).toBe(14);
  expect(parseLocalDateTime('2026-11-01 01:30', 'America/New_York')).toBe(Date.parse('2026-11-01T05:30:00Z'));
  expect(startOfLocalDay(at, 'America/New_York')).toBe(Date.parse('2026-11-01T04:00:00Z'));
  expect(startOfLocalDay(at, 'Asia/Shanghai')).toBe(Date.parse('2026-10-31T16:00:00Z'));
});

it('探针运行期间重建 Hub，结束事件仍按持久投递身份解除红灯', async () => {
  const world = await createSimWorld({ bots: [{ id: botId, brain: async () => ({ error: '429 quota exhausted' }) }] });
  await world.hub.api.sendMessage(botId, '核对连接');
  await world.host.settle();
  const red = world.store.table('quota').get('quota')!;
  world.host.registerBrain(botId, async () => ({ hang: true }));
  await advance(world, red.redUntil! - world.clock.now());
  // P76r1（4b）同步：原来此刻只有「许可」（probeAllowed），要再发一句话才有探针；现在主人第一句话被保留的候选在恢复时刻就是探针，
  // 所以此刻探针已在途（probeInFlight 为真），不再需要第二句话。之后重建 Hub、结束事件解除红灯的原意不变。
  await world.host.settle();
  expect(world.store.table('quota').get('quota')).toMatchObject({ light: 'red', redUntil: red.redUntil, probeAllowed: false, probeInFlight: true });
  await world.hub.stop();
  const hub = createHub(world);
  world.host.attach(hub);
  world.hub = hub;
  await hub.start();
  const sessionId = world.store.table('bots').get(botId)!.sessionId!;
  await hub.onTurnEvent({ type: 'ended', sessionId, at: world.clock.now(), finalText: '恢复连接成功', tokens: 0 });
  expect(world.store.table('quota').get('quota')!.light).toBe('green');
});

/** 仿真替身本身也要验收：证明微任务、工具守卫、事件顺序、用量和沉降真实可控，而不是只检查业务快照。 */
import { describe, expect, it } from 'vitest';
import type { Hub } from '../src/engine/hub.js';
import type { MessageSource, TurnEvent } from '../src/model/index.js';
import { FakeClock } from '../src/io/testing/fake-clock.js';
import { SimHost, type Brain } from '../src/sim/sim-host.js';
import { advance, createSimWorld, metrics } from '../src/sim/runner.js';
import { agendaMakerBrain, errorBrain, noCommitBrain, quietBrain, scriptedBrain, simCommit, watchTunerBrain } from '../src/sim/brains.js';

const botId = 'b_0000000001';
const source: MessageSource = { kind: 'agent-hub', wakeId: 'w_0000000001', botId, variant: 'regular' };
const sessionInput = { botId, title: '仿真队员', cwd: '/hub/bots/b_0000000001', rolePresetId: 'agent-hub-sentinel',
  permissionPresetId: 'agent-hub-unattended', model: null, firstMessage: '可控唤醒包', source };

/** 独立记录宿主输入输出，避免只用被测的真实 Hub 反证自己的事件顺序。 */
function hostFixture(brain: Brain, allow = true) {
  const clock = new FakeClock(1000);
  const events: TurnEvent[] = [];
  const handlers: unknown[] = [];
  const guards: unknown[] = [];
  const host = new SimHost(clock);
  const hub = {
    onTurnEvent: async (event: TurnEvent) => { events.push(event); },
    guardToolCall: (sessionId: string, tool: string, args: unknown) => {
      guards.push({ sessionId, tool, args });
      return allow ? { allow: true as const } : { allow: false as const, message: '主人尚未批准' };
    },
    tools: () => [{ name: 'hub_commit', handler: async (sessionId: string, args: unknown) => {
      handlers.push({ sessionId, args });
      return { ok: true as const, text: '已交账' };
    } }],
  } as unknown as Hub;
  host.attach(hub);
  host.registerBrain(botId, brain);
  return { clock, events, handlers, guards, host };
}

describe('C04 SimHost 的宿主契约', () => {
  it('先返回新会话，再以 started、step、ended 顺序执行大脑和累计声明用量', async () => {
    const f = hostFixture(async ({ call }) => {
      await call('hub_commit', simCommit(), 12);
      await call('read_file', { path: '/hub/work.txt' }, 7);
      return { finalText: '完成', tokens: 25 };
    });
    const created = await f.host.createSession(sessionInput);
    expect(f.events).toHaveLength(0);
    await f.host.settle();
    expect(f.events.map(event => event.type)).toEqual(['started', 'step', 'step', 'ended']);
    expect(f.events[1]).toMatchObject({ steps: 1, tokens: 12 });
    expect(f.events[2]).toMatchObject({ steps: 2, tokens: 19 });
    expect(f.events[3]).toMatchObject({ tokens: 25, finalText: '完成' });
    expect(f.handlers).toHaveLength(1);
    expect(f.guards).toHaveLength(2);
    expect(f.host.toolCalls).toHaveLength(2);
    expect((await f.host.sessionInfo(created.sessionId)).running).toBe(false);
  });

  it('守卫拒绝后不调用工具 handler，但仍记录失败步骤和用量', async () => {
    const f = hostFixture(async ({ call }) => {
      expect(await call('hub_commit', simCommit(), 3)).toEqual({ ok: false, error: '主人尚未批准' });
      return {};
    }, false);
    await f.host.createSession(sessionInput);
    await f.host.settle();
    expect(f.handlers).toHaveLength(0);
    expect(f.events[1]).toMatchObject({ type: 'step', steps: 1, tokens: 3 });
    expect(f.host.toolCalls[0]?.result.ok).toBe(false);
  });

  it('未知中心工具返回错误，不伪装成外部工具成功', async () => {
    const f = hostFixture(async ({ call }) => {
      expect(await call('hub_unknown', {})).toEqual({ ok: false, error: '不存在中心工具 hub_unknown' });
      return {};
    });
    await f.host.createSession(sessionInput);
    await f.host.settle();
    expect(f.host.toolCalls[0]?.result.ok).toBe(false);
  });

  it('大脑声明错误和抛异常均发 error，不再发 ended', async () => {
    for (const brain of [errorBrain('限流'), async () => { throw new Error('剧本失败'); }]) {
      const f = hostFixture(brain);
      await f.host.createSession(sessionInput);
      await f.host.settle();
      expect(f.events.map(event => event.type)).toEqual(['started', 'error']);
      expect(f.host.turns[0]?.status).toBe('error');
    }
  });

  it('卡住与审批等待能够沉降但保持 running，cancel 才释放', async () => {
    for (const result of [{ hang: true }, { awaitingApproval: { tool: 'exec', summary: '等待宿主' } }]) {
      const f = hostFixture(async () => result);
      const { sessionId } = await f.host.createSession(sessionInput);
      await f.host.settle();
      expect((await f.host.sessionInfo(sessionId)).running).toBe(true);
      expect(f.events.some(event => event.type === 'ended')).toBe(false);
      await f.host.cancel(sessionId);
      expect((await f.host.sessionInfo(sessionId)).running).toBe(false);
      expect(f.host.turns[0]?.status).toBe('cancelled');
      expect(f.host.calls.some(call => call.method === 'cancel')).toBe(true);
    }
  });

  it('未交账大脑只产生 started/ended，让真实引擎负责未交账判断', async () => {
    const f = hostFixture(noCommitBrain);
    await f.host.createSession(sessionInput);
    await f.host.settle();
    expect(f.events.map(event => event.type)).toEqual(['started', 'ended']);
    expect(f.host.toolCalls).toEqual([]);
  });

  it('投递失败有明确次数，失败不会创建运行回合', async () => {
    const f = hostFixture(noCommitBrain);
    f.host.failNextDeliveries(botId, 2, '离线');
    await expect(f.host.createSession(sessionInput)).rejects.toThrow('离线');
    await expect(f.host.createSession(sessionInput)).rejects.toThrow('离线');
    expect(f.host.turns).toHaveLength(0);
    await f.host.createSession(sessionInput);
    await f.host.settle();
    expect(f.host.turns).toHaveLength(1);
    expect(() => f.host.failNextDeliveries(botId, -1)).toThrow('非负整数');
  });

  it('不存在会话和仍在运行的会话都不能接收重复投递', async () => {
    const f = hostFixture(async () => ({ hang: true }));
    await expect(f.host.deliver('不存在', '消息', source)).rejects.toThrow('不存在');
    const { sessionId } = await f.host.createSession(sessionInput);
    await f.host.settle();
    await expect(f.host.deliver(sessionId, '重复', source)).rejects.toThrow('仍在运行');
  });

  it('通知和会话摘要保留可独立核对的时间，参数后改不污染记录', async () => {
    const f = hostFixture(noCommitBrain);
    const { sessionId } = await f.host.createSession(sessionInput);
    await f.host.settle();
    f.host.digests.set(sessionId, '一二三四五');
    expect(await f.host.readSessionDigest(sessionId, 3)).toBe('一二三');
    const input = { title: '通知', body: '正文', level: 'P1' as const, botId };
    f.clock.advance(50);
    await f.host.notify(input);
    input.body = '之后改动';
    await f.host.steer(sessionId, '收口');
    expect(f.host.notifications[0]).toMatchObject({ body: '正文', at: 1050 });
    expect(await f.host.listRecentSessions(1)).toEqual([{ sessionId, title: '仿真队员', updatedAt: 1000 }]);
    expect(f.host.calls.find(call => call.method === 'steer')?.args).toEqual([sessionId, '收口']);
  });

  it('未连接 Hub、缺大脑、非法用量和非法 BrainResult 均明确失败', async () => {
    const bare = new SimHost(new FakeClock(0));
    await expect(bare.createSession(sessionInput)).rejects.toThrow('尚未连接');
    for (const brain of [async ({ call }: Parameters<Brain>[0]) => { await call('hub_commit', {}, -1); return {}; },
      async () => ({ tokens: -1 })]) {
      const f = hostFixture(brain);
      await f.host.createSession(sessionInput);
      await f.host.settle();
      expect(f.events.at(-1)?.type).toBe('error');
    }
  });
});

describe('C04 预制大脑与世界推进', () => {
  it('剧本依次变化并重复尾步，quietBrain 使用 auto', async () => {
    const f = hostFixture(scriptedBrain([{ summary: '第一步' }, { summary: '第二步' }]));
    const { sessionId } = await f.host.createSession(sessionInput);
    await f.host.settle();
    await f.host.deliver(sessionId, '第二次', source);
    await f.host.settle();
    await f.host.deliver(sessionId, '第三次', source);
    await f.host.settle();
    expect(f.host.toolCalls.map(call => (call.args as { summary: string }).summary)).toEqual(['第一步', '第二步', '第二步']);
    const q = hostFixture(quietBrain);
    await q.host.createSession(sessionInput);
    await q.host.settle();
    expect(q.host.toolCalls[0]?.args).toMatchObject({ outcome: 'no_change', nextThink: { mode: 'auto' } });
  });

  it('默认安静世界无任务时不乱醒，advance 精确走完不足一分钟的余量', async () => {
    const world = await createSimWorld({ bots: [{ id: botId }], startAt: 1000 });
    const seen: number[] = [];
    await advance(world, 125000, { beforeTick: current => { seen.push(current.clock.now()); } });
    expect(seen).toEqual([61000, 121000, 126000]);
    expect(world.clock.now()).toBe(126000);
    expect(metrics(world).bots[0]).toMatchObject({ turns: 0, intervalCv: null, selfPacedRatio: null, selfInitiated: 0 });
    await expect(advance(world, -1)).rejects.toThrow();
    await expect(advance(world, 1, { tickEveryMs: 0 })).rejects.toThrow();
    expect(await world.fs.stat(`/sim-hub/bots/${botId}/work`)).toMatchObject({ isDir: true });
  });

  it('相同种子得到相同 id 序列，重复机器人或非法档案拒绝', async () => {
    const a = await createSimWorld({ bots: [{ id: botId }], seed: 19 });
    const b = await createSimWorld({ bots: [{ id: botId }], seed: 19 });
    expect(a.store.log('audit').all()).toEqual(b.store.log('audit').all());
    await expect(createSimWorld({ bots: [{ id: botId }, { id: botId }] })).rejects.toThrow('重复');
    await expect(createSimWorld({ bots: [{ id: '非法身份' }] })).rejects.toThrow();
  });

  it('预制自主和注意调整大脑按真实工具链留下记录', async () => {
    const world = await createSimWorld({ bots: [{ id: botId, brain: agendaMakerBrain() }] });
    const message = await world.hub.api.sendMessage(botId, '请检查并自行提出下一步');
    expect(message.ok).toBe(true);
    await world.host.settle();
    expect(metrics(world).bots[0]?.selfInitiated).toBe(2);
    expect(world.host.toolCalls.every(call => call.result.ok)).toBe(true);
    world.host.registerBrain(botId, watchTunerBrain({ watchId: 'wt_0000000001', intervalMinutes: 60 }));
    await world.hub.api.sendMessage(botId, '请调整关注');
    await world.host.settle();
    expect(world.host.turns.at(-1)?.status).toBe('error');
  });

  it('指标把日报通知与真正单推分开，失败投递不冒充思考回合', async () => {
    const world = await createSimWorld({ bots: [{ id: botId }] });
    await advance(world, 60000);
    expect(metrics(world)).toMatchObject({ digests: 1, pushes: { daytime: 0 }, notifications: { daytime: 1 } });
    world.host.failNextDeliveries(botId, 1);
    await world.hub.api.sendMessage(botId, '这条消息会遇到一次投递故障');
    await world.host.settle();
    expect(world.store.table('wakes').count()).toBe(1);
    expect(metrics(world).bots[0]?.turns).toBe(0);
  });
});

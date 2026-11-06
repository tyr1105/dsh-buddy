/** M03 中心故障隔离回归：从真实公共入口验证设置优先级、过期释放、告警恢复及会话互斥。 */
import { expect, it, vi } from 'vitest';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import type { HubContext } from '../src/engine/context.js';
import { createHub } from '../src/engine/hub.js';
import { createBotHome } from '../src/memory/files.js';
import { resolveSettings } from '../src/config/defaults.js';
import { enqueue } from '../src/scheduler/queue.js';
import { buildCandidate } from '../src/appraisal/think.js';
import { recordOwnerMessage } from '../src/perception/sources.js';
import { onQuotaError } from '../src/quota/window.js';
import { botFixture } from './model-fixtures.js';
const minute = 60_000;

/** 手工完成点只控制宿主响应，不依赖真实时间，能验证永不返回与迟到两种状态。 */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function setup(count = 1) {
  const ctx = createTestContext();
  const bots = [];
  for (let i = 0; i < count; i++) {
    const bot = { ...botFixture, id: `b_${String(i + 1).padStart(10, '0')}`, lifecycle: 'active' as const,
      sessionId: `session-${i + 1}`, sessionStartedAt: ctx.clock.now(), nextThinkAt: null, lightCheckAt: null, expectedBy: null };
    ctx.store.table('bots').put(bot); await createBotHome(ctx, bot);
    ctx.host.sessions.set(bot.sessionId, { exists: true, running: false, contextRatio: 0 });
    bots.push(bot);
  }
  const hub = createHub(ctx); await hub.start();
  return { ctx, bots, hub };
}
function owner(ctx: HubContext, botId: string, id = botId) {
  const percept = recordOwnerMessage(ctx, { botId, id, summary: '核对本次要求', at: ctx.clock.now() })!;
  enqueue(ctx, buildCandidate(ctx, { botId, kind: 'owner_message', score: 1,
    summary: '主人要求核对', evidence: [percept.id], messageId: id }));
  return percept;
}

it('M03 [5][14] 默认 < 持久设置 < 宿主显式设置，根目录变化可审计且心跳使用新 pid', async () => {
  const ctx = createTestContext();
  ctx.store.table('settings').put(resolveSettings({ rootDir: '/old', heartbeatPid: 111, maxBots: 4, digestAt: '09:15',
    c02: { deliveryTimeoutMs: 90_000, suppressionLogMs: 800_000 } }));
  const hub = createHub({ ...ctx, settings: { rootDir: '/new', heartbeatPid: 222, maxBots: 5,
    c02: { ...ctx.settings.c02, deliveryTimeoutMs: 100_000 } } });
  await hub.start(); await hub.tick();
  expect((await hub.api.settings()).settings).toMatchObject({ rootDir: '/new', heartbeatPid: 222, maxBots: 5, digestAt: '09:15' });
  expect(JSON.parse((await ctx.fs.readText('/new/.hub/heartbeat.json'))!).pid).toBe(222);
  expect(await ctx.fs.readText('/old/.hub/heartbeat.json')).toBeNull();
  expect(ctx.store.log('audit').all().find(a => a.action === 'settings_root_override')?.detail).toContain('/old');
  const second = createHub({ ...ctx, settings: { rootDir: '/old' } });
  await second.start();
  expect((await second.api.settings()).settings).toMatchObject({ maxBots: 4, heartbeatPid: 111, digestAt: '09:15' });
});

it('M03 [12] 心跳连续两次失败才开 P2，成功关卡且重新失败从一次起，不占单推预算', async () => {
  const { ctx, hub } = await setup();
  const write = ctx.fs.writeTextAtomic.bind(ctx.fs);
  let failed = true;
  vi.spyOn(ctx.fs, 'writeTextAtomic').mockImplementation(async (path, text) => {
    if (failed && path.endsWith('heartbeat.json')) throw new Error('受控心跳失败');
    return write(path, text);
  });
  const alerts = () => ctx.store.table('alerts').list(a => a.code === 'hub:心跳' && a.status === 'open');
  await hub.tick(); expect(alerts()).toHaveLength(0);
  ctx.clock.advance(minute); await hub.tick(); expect(alerts()).toHaveLength(1);
  const alert = alerts()[0]!;
  expect(ctx.store.table('inbox').list(i => i.refId === alert.id && i.status === 'open')).toHaveLength(1);
  expect(ctx.host.calls.filter(c => c.method === 'notify' && (c.args[0] as { title: string }).title.includes('告警'))).toHaveLength(0);
  expect(hub.api.overview().pushesLeftToday).toBe(ctx.settings.dailyPushCap);
  failed = false; ctx.clock.advance(minute); await hub.tick();
  expect(alerts()).toHaveLength(0);
  expect(ctx.store.table('inbox').list(i => i.refId === alert.id && i.status === 'open')).toHaveLength(0);
  failed = true; ctx.clock.advance(minute); await hub.tick(); expect(alerts()).toHaveLength(0);
});

it('M03 [9] 永不返回的 deliver 被释放，另一机器人仍能放行，旧单按错误结束', async () => {
  const { ctx, hub, bots } = await setup(2);
  const called = deferred();
  vi.spyOn(ctx.host, 'deliver').mockImplementationOnce(() => { called.resolve(); return new Promise(() => undefined); });
  const sending = hub.api.sendMessage(bots[0]!.id, '本次消息');
  await called.promise;
  owner(ctx, bots[1]!.id);
  ctx.clock.advance(5 * minute + 1);
  await hub.tick(); await sending;
  expect(ctx.store.table('wakes').list(w => w.botId === bots[0]!.id)).toEqual([expect.objectContaining({ status: 'error' })]);
  expect(ctx.store.table('bots').get(bots[0]!.id)?.consecutiveErrors).toBe(1);
  expect(ctx.store.table('wakes').list(w => w.botId === bots[1]!.id && w.status === 'running')).toHaveLength(1);
  expect(ctx.store.table('alerts').list(a => a.code === 'hub:入口超时' && a.level === 'P1')).toHaveLength(1);
  expect(await ctx.fs.readText('/hub/.hub/heartbeat.json')).toContain(String(ctx.clock.now()));
});

it('M03 [9] 挂起的通知副作用不永久占串行/落盘通道，后续 tick 与命令仍可完成', async () => {
  const { ctx, hub, bots } = await setup(2);
  const called = deferred();
  vi.spyOn(ctx.host, 'notify').mockImplementationOnce(() => { called.resolve(); return new Promise(() => undefined); });
  expect(hub.guardToolCall(bots[0]!.sessionId, 'send_email', { text: '审批' }).allow).toBe(false);
  await called.promise;
  const first = hub.tick();
  await Promise.resolve();
  ctx.clock.advance(5 * minute + 1);
  await hub.tick(); await first;
  const result = await hub.api.sendMessage(bots[1]!.id, '恢复后的消息');
  expect(result.ok).toBe(true);
  expect(ctx.store.table('wakes').list(w => w.botId === bots[1]!.id && w.status === 'running')).toHaveLength(1);
  expect(ctx.store.table('alerts').list(a => a.code === 'hub:入口超时')).toHaveLength(1);
});

it.each(['心跳', '落盘'] as const)('M03 [9] %s 真正悬挂时五分钟边界不提前释放，超时继续且迟到旧 tick 不重复投递', async phase => {
  const { ctx, hub, bots } = await setup(2);
  const called = deferred(); const release = deferred();
  if (phase === '心跳') {
    const write = ctx.fs.writeTextAtomic.bind(ctx.fs);
    vi.spyOn(ctx.fs, 'writeTextAtomic').mockImplementationOnce(async (path, text) => {
      called.resolve(); await release.promise; await write(path, text);
    });
  } else vi.spyOn(ctx.store, 'flush').mockImplementationOnce(() => { called.resolve(); return release.promise; });
  const first = hub.tick(); await called.promise;
  ctx.clock.advance(5 * minute); await hub.tick();
  expect(ctx.store.table('alerts').list(a => a.code === 'hub:入口超时')).toHaveLength(0);
  owner(ctx, bots[1]!.id);
  ctx.clock.advance(1); await hub.tick(); await first;
  expect(ctx.store.table('wakes').count()).toBe(1);
  expect(ctx.store.table('alerts').list(a => a.code === 'hub:入口超时')).toHaveLength(1);
  release.resolve(); await Promise.resolve(); await hub.onOwnerActivity(ctx.clock.now());
  expect(ctx.store.table('wakes').count()).toBe(1);
});

it('M03 [13] 主人直聊中的会话保留候选，不建回合不消费，另一机器人可继续，结束后再投递', async () => {
  const { ctx, hub, bots } = await setup(2);
  ctx.host.sessions.get(bots[0]!.sessionId)!.running = true;
  const p = owner(ctx, bots[0]!.id); owner(ctx, bots[1]!.id);
  await hub.tick();
  expect(ctx.host.calls.filter(c => c.method === 'deliver').map(c => c.args[0])).toEqual([bots[1]!.sessionId]);
  expect(ctx.store.table('wakes').list(w => w.botId === bots[0]!.id)).toHaveLength(0);
  expect(ctx.store.table('percepts').get(p.id)?.consumedByWake).toBeNull();
  expect(ctx.store.table('queue').count(q => q.botId === bots[0]!.id)).toBe(1);
  expect(ctx.store.log('appraisals').all().find(a => a.botId === bots[0]!.id && a.suppressedBy === 'concurrency')?.text).toContain('主人会话正在运行');
  ctx.host.sessions.get(bots[0]!.sessionId)!.running = false;
  ctx.clock.advance(minute); await hub.tick();
  expect(ctx.store.table('wakes').list(w => w.botId === bots[0]!.id && w.status === 'running')).toHaveLength(1);
  expect(ctx.store.table('percepts').get(p.id)?.consumedByWake).not.toBeNull();
});

it('M03 [25] 同一次 pump 连续放行主人消息，均显示 thinking 与准确处理原因', async () => {
  const { ctx, hub, bots } = await setup(2);
  for (const bot of bots) owner(ctx, bot.id);
  await hub.tick();
  expect(ctx.host.calls.filter(c => c.method === 'deliver')).toHaveLength(2);
  for (const bot of bots) expect(ctx.store.table('bots').get(bot.id)).toMatchObject({ activity: 'thinking', activityText: '正在处理：主人要求核对' });
  expect(ctx.store.table('queue').count()).toBe(0);
});

it('M03 [25] 红灯主人消息只收到一次系统说明，反复 tick 不刷屏', async () => {
  const { ctx, hub, bots } = await setup();
  onQuotaError(ctx, ctx.clock.now());
  await hub.api.sendMessage(bots[0]!.id, '红灯期间消息');
  for (let i = 0; i < 3; i++) { ctx.clock.advance(minute); await hub.tick(); }
  const messages = ctx.store.log('thread').all().filter(m => m.thread === bots[0]!.id && m.kind === 'system' && m.text.includes('当前额度不足，消息已保留'));
  expect(messages).toHaveLength(1);
  expect(ctx.store.table('queue').count()).toBe(1);
  expect(ctx.host.calls.filter(c => c.method === 'deliver')).toHaveLength(0);
});

it('M03 [9] 创建会话超过五分钟才返回仍取消孤儿身份，不复活错误单', async () => {
  const { ctx, hub, bots } = await setup();
  ctx.store.table('bots').patch(bots[0]!.id, { sessionId: null, sessionStartedAt: null });
  const called = deferred(); const late = deferred<{ sessionId: string }>();
  vi.spyOn(ctx.host, 'createSession').mockImplementationOnce(() => { called.resolve(); return late.promise; });
  const sending = hub.api.sendMessage(bots[0]!.id, '慢速创建'); await called.promise;
  ctx.clock.advance(6 * minute); await hub.tick(); await sending;
  const wake = ctx.store.table('wakes').list()[0]!;
  expect(wake.status).toBe('error');
  late.resolve({ sessionId: 'late-orphan' });
  await Promise.resolve(); await Promise.resolve();
  expect(ctx.host.calls).toContainEqual({ method: 'cancel', args: ['late-orphan'] });
  expect(ctx.store.table('bots').get(bots[0]!.id)?.sessionId).toBeNull();
  expect(ctx.store.table('wakes').get(wake.id)?.status).toBe('error');
});

it('M03 [9] 过期 start 的迟到 load 不得在 stop 后复活中心', async () => {
  const ctx = createTestContext(); const called = deferred(); const late = deferred();
  vi.spyOn(ctx.store, 'load').mockImplementationOnce(() => { called.resolve(); return late.promise; });
  const hub = createHub(ctx);
  const starting = hub.start().then(() => 'started', () => 'expired'); await called.promise;
  ctx.clock.advance(6 * minute); await hub.tick();
  expect(await starting).toBe('expired');
  await hub.stop();
  late.resolve(); await Promise.resolve(); await Promise.resolve();
  await hub.tick();
  expect(ctx.store.log('audit').all().filter(a => a.action === 'hub_started')).toHaveLength(0);
  expect(await ctx.fs.readText('/hub/.hub/heartbeat.json')).toBeNull();
  await hub.start(); await hub.tick();
  expect(await ctx.fs.readText('/hub/.hub/heartbeat.json')).not.toBeNull();
});

it('M03 [9] notify 持续不返回时后续 tick 仍到达调度，原调用结束后通知自动恢复', async () => {
  const { ctx, hub, bots } = await setup(2);
  const called = deferred(); const release = deferred();
  const notify = vi.spyOn(ctx.host, 'notify').mockImplementation(() => { called.resolve(); return release.promise; });
  owner(ctx, bots[0]!.id);
  const first = hub.tick(); await called.promise;
  ctx.clock.advance(6 * minute); await hub.tick(); await first;
  expect(ctx.store.table('wakes').list(w => w.botId === bots[0]!.id && w.status === 'running')).toHaveLength(1);
  expect(notify).toHaveBeenCalledTimes(1);
  // 再次 tick 必须完成，不以再次挂住换取上一轮释放；另一机器人仍能收到主人要求。
  owner(ctx, bots[1]!.id);
  ctx.clock.advance(minute); await hub.tick();
  expect(ctx.store.table('wakes').list(w => w.botId === bots[1]!.id && w.status === 'running')).toHaveLength(1);
  expect(notify).toHaveBeenCalledTimes(1);
  release.resolve(); await Promise.resolve(); await Promise.resolve();
  ctx.clock.advance(minute); await hub.tick();
  expect(notify.mock.calls.length).toBeGreaterThan(1);
});

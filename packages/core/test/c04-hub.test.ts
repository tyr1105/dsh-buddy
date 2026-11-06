/** Hub 接线回归：从公共入口核对投递、串行事件、钩子、轮换与持久化，不替换业务规则。 */
import { describe, expect, it, vi } from 'vitest';
import type { HubContext } from '../src/engine/context.js';
import { createHub } from '../src/engine/hub.js';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { resolveSettings } from '../src/config/defaults.js';
import { createBotHome } from '../src/memory/files.js';
import { buildCandidate } from '../src/appraisal/think.js';
import { enqueue } from '../src/scheduler/queue.js';
import { recordOwnerMessage } from '../src/perception/sources.js';
import { botFixture, watchFixture } from './model-fixtures.js';
import { commitArgs } from './c03-turn-fixtures.js';
import type { Bot } from '../src/model/index.js';
const minute = 60_000;

/** 建立合法家目录，之后只由 Hub 推进候选与回合。 */
async function fixture(patch: Partial<Bot> = {}) {
  const ctx = createTestContext();
  const now = ctx.clock.now();
  const bot = { ...botFixture, lifecycle: 'active' as const, sessionId: null, sessionStartedAt: null,
    createdAt: now, updatedAt: now, lastThinkAt: null, lightCheckAt: null, ...patch };
  ctx.store.table('bots').put(bot);
  await createBotHome(ctx, bot);
  const hub = createHub(ctx);
  await hub.start();
  return { ctx, hub, bot };
}
/** 主人候选绕开启动静默，用来独立验证实际宿主投递链路。 */
function ownerCandidate(ctx: HubContext, botId: string, id = 'owner-1') {
  const p = recordOwnerMessage(ctx, { botId, id, summary: '请核对当前变化', at: ctx.clock.now() })!;
  enqueue(ctx, buildCandidate(ctx, { botId, kind: 'owner_message', score: 1, summary: p.summary, evidence: [p.id], messageId: id }));
  return p;
}

describe('C04 Hub 启停与独立阶段', () => {
  it('启动载入存储设置、生成根目录并幂等；停止不取消宿主会话', async () => {
    const ctx = createTestContext();
    const settings = resolveSettings({ rootDir: '/persisted-hub', maxBots: 4 });
    ctx.store.table('settings').put(settings);
    const load = vi.spyOn(ctx.store, 'load');
    const flush = vi.spyOn(ctx.store, 'flush');
    const hub = createHub({ ...ctx, settings: { rootDir: '/hub' } });
    await hub.start();
    await hub.start();
    expect(load).toHaveBeenCalledTimes(1);
    expect(await ctx.fs.readText('/hub/AGENTS.md')).toContain('规矩');
    expect(await ctx.fs.readText('/persisted-hub/AGENTS.md')).toBeNull();
    expect((await hub.api.settings()).settings.maxBots).toBe(4);
    await hub.stop();
    expect(flush).toHaveBeenCalled();
    expect(ctx.host.calls.some(c => c.method === 'cancel')).toBe(false);
  });

  it('停止取消所有文件监听；停止后 tick 不生成新的心跳', async () => {
    const { ctx, hub, bot } = await fixture();
    await ctx.fs.writeTextAtomic('/watched.txt', '初始');
    ctx.store.table('watches').put({ ...watchFixture, botId: bot.id, kind: 'file', target: '/watched.txt' });
    const watch = vi.spyOn(ctx.fs, 'watch');
    await hub.tick();
    expect(watch).toHaveBeenCalledTimes(1);
    await hub.stop();
    const heartbeat = await ctx.fs.readText('/hub/.hub/heartbeat.json');
    ctx.clock.advance(minute);
    await ctx.fs.writeTextAtomic('/watched.txt', '新内容');
    await hub.tick();
    expect(await ctx.fs.readText('/hub/.hub/heartbeat.json')).toBe(heartbeat);
  });

  it('重叠 tick 立即返回；单步异常写日志与告警且后续仍放行', async () => {
    const { ctx, hub, bot } = await fixture();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const write = ctx.fs.writeTextAtomic.bind(ctx.fs);
    vi.spyOn(ctx.fs, 'writeTextAtomic').mockImplementation(async (path, text) => {
      if (path.endsWith('heartbeat.json')) { await gate; throw new Error('心跳磁盘故障'); }
      return write(path, text);
    });
    ownerCandidate(ctx, bot.id);
    const first = hub.tick();
    await Promise.resolve();
    await hub.tick();
    expect(ctx.store.table('wakes').count()).toBe(0);
    release();
    await first;
    expect(ctx.store.table('wakes').count(w => w.status === 'running')).toBe(1);
    expect(ctx.store.table('alerts').list(a => a.code === 'hub:心跳' && a.status === 'open')).toHaveLength(0);
    expect(ctx.store.table('alerts').list(a => a.code === 'hub:心跳')).toEqual([expect.objectContaining({ count: 1, status: 'closed' })]);
    expect(ctx.logger.lines.some(e => e.level === 'error')).toBe(true);
  });

  it('每日只 prune 一次；跨日后重新清理', async () => {
    const { ctx, hub } = await fixture();
    const prune = vi.spyOn(ctx.store, 'prune');
    await hub.tick();
    ctx.clock.advance(minute);
    await hub.tick();
    expect(prune).toHaveBeenCalledTimes(1);
    ctx.clock.advance(24 * 60 * minute);
    await hub.tick();
    expect(prune).toHaveBeenCalledTimes(2);
  });

  it('到期转正保留创建自主等级但 L3 自动转正上限 L2', async () => {
    const { ctx, hub, bot } = await fixture({ lifecycle: 'probation', autonomy: 'L3', probationEndsAt: 1 });
    await hub.tick();
    expect(ctx.store.table('bots').get(bot.id)).toMatchObject({ lifecycle: 'active', autonomy: 'L2', probationEndsAt: null });
    expect(ctx.store.log('audit').all().some(a => a.action === 'lifecycle')).toBe(true);
  });
});

describe('C04 实际投递与会话轮换', () => {
  it.each(['chief', 'researcher', 'executor', 'sentinel'] as const)('角色 %s 的新会话参数与证据消费完整', async role => {
    const { ctx, hub, bot } = await fixture({ role });
    const percept = ownerCandidate(ctx, bot.id);
    await hub.tick();
    const call = ctx.host.calls.find(c => c.method === 'createSession')!;
    expect(call.args[0]).toMatchObject({ botId: bot.id, title: `${bot.name} · Agent 中心`, cwd: bot.homeDir,
      rolePresetId: `agent-hub-${role}`, permissionPresetId: 'agent-hub-unattended', model: bot.model });
    const wake = ctx.store.table('wakes').list()[0]!;
    expect(wake.status).toBe('running');
    expect(wake.packetBytes).toBeGreaterThan(0);
    expect(wake.sessionId).toBe(ctx.store.table('bots').get(bot.id)!.sessionId);
    expect(ctx.store.table('percepts').get(percept.id)!.consumedByWake).toBe(wake.id);
    expect(ctx.store.table('queue').count()).toBe(0);
  });

  it.each(['reuse', 'missing', 'age', 'context'] as const)('会话 %s 路径按实时宿主信息决定', async mode => {
    const { ctx, hub, bot } = await fixture({ sessionId: 'existing', sessionStartedAt: Date.parse('2026-11-05T10:00:00+08:00') });
    ctx.host.sessions.set('existing', { exists: mode !== 'missing', running: false, contextRatio: mode === 'context' ? 0.5 : 0.1 });
    if (mode === 'age') ctx.store.table('bots').patch(bot.id, { sessionStartedAt: ctx.clock.now() - ctx.settings.sessionMaxAgeMs });
    ownerCandidate(ctx, bot.id);
    await hub.tick();
    expect(ctx.host.calls.filter(c => c.method === 'createSession')).toHaveLength(mode === 'reuse' ? 0 : 1);
    expect(ctx.host.calls.filter(c => c.method === 'deliver')).toHaveLength(mode === 'reuse' ? 1 : 0);
    if (mode !== 'reuse') expect(String((ctx.host.calls.find(c => c.method === 'createSession')!.args[0] as { firstMessage: string }).firstMessage)).toContain('新工作会话');
  });

  it('投递失败保留候选和未消费感知，不写回合用量', async () => {
    const { ctx, hub, bot } = await fixture();
    vi.spyOn(ctx.host, 'createSession').mockRejectedValue(new Error('受控网络故障'));
    const p = ownerCandidate(ctx, bot.id);
    await hub.tick();
    expect(ctx.store.table('wakes').list()[0]).toMatchObject({ status: 'error', dispatchedAt: null });
    expect(ctx.store.table('queue').count()).toBe(1);
    expect(ctx.store.table('percepts').get(p.id)!.consumedByWake).toBeNull();
    expect(ctx.store.log('ledger').all()).toHaveLength(0);
    expect(ctx.store.table('bots').get(bot.id)!.retryAt).toBeGreaterThan(ctx.clock.now());
  });
});

describe('C04 事件、工具与同步钩子', () => {
  it('普通会话不能用 hub 工具，参数错误也返回中文结果', async () => {
    const { ctx, hub, bot } = await fixture();
    const tool = hub.tools().find(t => t.name === 'hub_commit')!;
    expect(await tool.handler('outsider', {})).toEqual({ ok: false, error: '只有 Agent 中心的机器人能用这个工具' });
    ownerCandidate(ctx, bot.id);
    await hub.tick();
    const sessionId = ctx.store.table('bots').get(bot.id)!.sessionId!;
    const bad = await tool.handler(sessionId, {});
    expect(bad.ok).toBe(false);
    expect('error' in bad && bad.error).toMatch(/交账|outcome/);
    expect(hub.botIdForSession('outsider')).toBeNull();
  });

  it('交账后仍占并发直到 ended，事件重复不会重复记账', async () => {
    const { ctx, hub, bot } = await fixture();
    ownerCandidate(ctx, bot.id);
    await hub.tick();
    const sessionId = ctx.store.table('bots').get(bot.id)!.sessionId!;
    await hub.onTurnEvent({ type: 'started', sessionId, at: ctx.clock.now() });
    const result = await hub.tools().find(t => t.name === 'hub_commit')!.handler(sessionId, commitArgs({ reply: '已核对' }));
    expect(result.ok).toBe(true);
    ownerCandidate(ctx, bot.id, 'owner-2');
    await hub.tick();
    expect(ctx.host.calls.filter(c => c.method === 'createSession' || c.method === 'deliver')).toHaveLength(1);
    const ended = { type: 'ended' as const, sessionId, at: ctx.clock.now(), finalText: '', tokens: 50 };
    ctx.host.sessions.get(sessionId)!.running = false;
    await hub.onTurnEvent(ended);
    expect(ctx.host.calls.filter(c => c.method === 'deliver')).toHaveLength(1);
    expect(ctx.store.log('ledger').all()).toHaveLength(1);
  });

  it('同步 guard 即时拒绝并保存审批；普通会话无约束', async () => {
    const { ctx, hub, bot } = await fixture();
    ownerCandidate(ctx, bot.id);
    await hub.tick();
    const sessionId = ctx.store.table('bots').get(bot.id)!.sessionId!;
    const result = hub.guardToolCall(sessionId, 'send_email', { to: 'example', text: '测试' });
    expect(result).not.toBeInstanceOf(Promise);
    expect(result.allow).toBe(false);
    expect(ctx.store.table('approvals').count()).toBe(1);
    expect(hub.guardToolCall('outsider', 'send_email', {})).toEqual({ allow: true });
    expect(hub.onHostApprovalRequest('outsider', 'any', '')).toBe('pass');
    expect(hub.onHostApprovalRequest(sessionId, 'other', '需要批准')).toBe('deny');
    await hub.onOwnerActivity(ctx.clock.now());
    expect(ctx.store.table('approvals').count()).toBe(1);
    expect(ctx.store.table('alerts').list(a => a.code === 'host_approval_blocked' && a.status === 'open')).toHaveLength(1);
    expect(ctx.store.table('inbox').list(i => i.type === 'alert' && i.status === 'open')).toHaveLength(1);
    expect(ctx.store.isDirty()).toBe(false);
  });

  it('订阅者异常不影响其余订阅者，取消订阅后不再通知', async () => {
    const { ctx, hub, bot } = await fixture();
    hub.subscribe(() => { throw new Error('界面故障'); });
    const events: string[] = [];
    const off = hub.subscribe(e => { events.push(`${e.scope}:${e.botId}`); });
    ownerCandidate(ctx, bot.id);
    await hub.tick();
    expect(events.some(e => e === `activity:${bot.id}`)).toBe(true);
    expect(events.filter(e => e === `activity:${bot.id}`)).toHaveLength(1);
    off();
    const count = events.length;
    await hub.onOwnerActivity(ctx.clock.now());
    expect(events).toHaveLength(count);
    expect(ctx.logger.lines.some(e => e.message === '界面订阅者失败')).toBe(true);
  });
});

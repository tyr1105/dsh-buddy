/** M07 推送契约回归：沿真实命令、工具和感知入口核对范围与归属，避免右栏依赖内部表名刷新。 */
import { describe, expect, it } from 'vitest';
import { HUB_EVENT_SCOPES, createHub } from '../src/index.js';
import { processCommit } from '../src/commit/process.js';
import { recordPercept } from '../src/perception/percept.js';
import { saveWatchState } from '../src/perception/watch-state.js';
import { recordWatchError } from '../src/perception/poll.js';
import { runTool } from '../src/tools/index.js';
import { createInboxItem } from '../src/outreach/inbox.js';
import { postThread } from '../src/outreach/thread.js';
import { requestApproval } from '../src/gate/approvals.js';
import { upsertRule } from '../src/memory/rules.js';
import { restForQuota, getQuotaState } from '../src/quota/window.js';
import { toolFixture } from './c03-tool-fixtures.js';
import { turnContext, commitArgs } from './c03-turn-fixtures.js';
import { apiFixture } from './c04-api-fixtures.js';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { botFixture } from './model-fixtures.js';

type Change = { scope: string; botId: string | null };
/** 单机器人操作不能借无身份的全局刷新蒙混过关，也不能错误刷新另一位队友。 */
function expectBotChanges(events: Change[], botId: string, scopes: string[] = [HUB_EVENT_SCOPES.bot]): void {
  for (const scope of scopes) expect(events).toContainEqual({ scope, botId });
  expect(events.every(event => new Set<string>(Object.values(HUB_EVENT_SCOPES)).has(event.scope))).toBe(true);
  expect(events.every(event => event.botId === botId)).toBe(true);
}

describe('M07 公开推送词表与机器人归属', () => {
  it('从包入口导出且包含九个面向视图的范围', () => {
    expect(HUB_EVENT_SCOPES).toEqual({ overview: 'overview', bot: 'bot', thread: 'thread', inbox: 'inbox', activity: 'activity', settings: 'settings', ledger: 'ledger', project: 'project', office: 'office' });
  });

  it('交账同时刷新机器人详情和活动，失败交账不发虚假变化', async () => {
    const { ctx, bot, toolCtx } = await turnContext();
    ctx.events.length = 0;
    expect((await processCommit(ctx, toolCtx, commitArgs())).ok).toBe(true);
    expectBotChanges(ctx.events, bot.id, [HUB_EVENT_SCOPES.bot, HUB_EVENT_SCOPES.activity]);
    ctx.events.length = 0;
    expect((await processCommit(ctx, toolCtx, commitArgs())).ok).toBe(false);
    expect(ctx.events).toEqual([]);
  });

  it('感知和去重评估刷新对应机器人，错误身份不产生推送', () => {
    const { ctx, bot, now } = toolFixture();
    const percept = { botId: bot.id, watchId: null, source: 'system' as const, kind: 'changed', summary: '公开资料变化',
      location: null, fingerprintMaterial: '新增事实', magnitude: 0.8, anomaly: false, untrusted: true, occurredAt: now };
    ctx.events.length = 0;
    expect(recordPercept(ctx, percept)).not.toBeNull();
    expectBotChanges(ctx.events, bot.id);
    ctx.events.length = 0;
    expect(recordPercept(ctx, percept)).toBeNull();
    expectBotChanges(ctx.events, bot.id);
    ctx.events.length = 0;
    expect(() => recordPercept(ctx, { ...percept, botId: '不存在' })).toThrow('机器人不存在');
    expect(ctx.events).toEqual([]);
  });

  it('议程新建、关闭都刷新机器人，重复关闭不发事件', async () => {
    const { ctx, tc, bot } = toolFixture();
    ctx.events.length = 0;
    expect((await runTool(ctx, tc, 'hub_agenda_upsert', { kind: 'task', title: '核实新的公开资料', abandonWhen: '资料已撤回', priority: 2 })).ok).toBe(true);
    expectBotChanges(ctx.events, bot.id);
    const agenda = ctx.store.table('agenda').list(row => row.title === '核实新的公开资料')[0]!;
    ctx.events.length = 0;
    const close = { id: agenda.id, status: 'done', note: '已完成核对' };
    expect((await runTool(ctx, tc, 'hub_agenda_close', close)).ok).toBe(true);
    expectBotChanges(ctx.events, bot.id);
    ctx.events.length = 0;
    expect((await runTool(ctx, tc, 'hub_agenda_close', close)).ok).toBe(false);
    expect(ctx.events).toEqual([]);
  });

  it('主人新增关注和机器人调慢关注都发 bot，非法调快不发事件', async () => {
    const { ctx, api, bot } = await apiFixture();
    ctx.events.length = 0;
    const result = await api.upsertWatch({ botId: bot.id, kind: 'http', target: 'https://example.test/source', why: '核对资料' });
    expect(result.ok).toBe(true);
    expectBotChanges(ctx.events, bot.id);
    const { ctx: toolCtx, tc, bot: toolBot } = toolFixture();
    const watch = toolCtx.store.table('watches').list()[0]!;
    toolCtx.events.length = 0;
    expect((await runTool(toolCtx, tc, 'hub_watch_update', { id: watch.id, intervalMinutes: 30 })).ok).toBe(true);
    expectBotChanges(toolCtx.events, toolBot.id);
    toolCtx.events.length = 0;
    expect((await runTool(toolCtx, tc, 'hub_watch_update', { id: watch.id, intervalMinutes: 5 })).ok).toBe(false);
    expect(toolCtx.events).toEqual([]);
  });

  it('机器人直接新增关注同样刷新详情', async () => {
    const { ctx, tc, bot } = toolFixture();
    ctx.events.length = 0;
    expect((await runTool(ctx, tc, 'hub_watch_propose', { kind: 'http', target: 'https://example.test/new', why: '核对新来源' })).ok).toBe(true);
    expectBotChanges(ctx.events, bot.id);
  });

  it('没有新增感知的关注检查成功或失败也刷新最近检查时间', () => {
    const { ctx, bot, now } = toolFixture();
    const watch = ctx.store.table('watches').list()[0]!;
    ctx.events.length = 0;
    saveWatchState(ctx, watch, { text: '原内容' }, now);
    expectBotChanges(ctx.events, bot.id);
    ctx.events.length = 0;
    recordWatchError(ctx, watch, new Error('暂时不可用'), now);
    expectBotChanges(ctx.events, bot.id);
  });

  it('生命周期动作刷新对应机器人和活动，非法动作不发事件', async () => {
    const { ctx, api, bot } = await apiFixture();
    ctx.events.length = 0;
    expect((await api.lifecycleAction({ botId: bot.id, action: 'pause' })).ok).toBe(true);
    expectBotChanges(ctx.events, bot.id, [HUB_EVENT_SCOPES.bot, HUB_EVENT_SCOPES.activity]);
    ctx.events.length = 0;
    expect((await api.lifecycleAction({ botId: bot.id, action: 'pause' })).ok).toBe(false);
    expect(ctx.events).toEqual([]);
    expect((await api.lifecycleAction({ botId: bot.id, action: 'resume' })).ok).toBe(true);
    expectBotChanges(ctx.events, bot.id, [HUB_EVENT_SCOPES.bot, HUB_EVENT_SCOPES.activity]);
  });

  it.each(['question', 'proposal', 'alert'] as const)('%s 作答同步刷新收件箱、线程卡片和机器人', async type => {
    const { ctx, api, bot } = await apiFixture();
    const item = createInboxItem(ctx, { botId: bot.id, type, title: '确认事项', body: '请确认处理方式', subjectKey: type,
      ...(type === 'question' ? { options: ['继续', '等一等'], defaultOption: '等一等' } : {}) });
    ctx.events.length = 0;
    const answer = type === 'question' ? '继续' : type === 'proposal' ? '不做' : '知道了';
    expect((await api.answerInbox(item.id, answer)).ok).toBe(true);
    expectBotChanges(ctx.events, bot.id, [HUB_EVENT_SCOPES.bot, HUB_EVENT_SCOPES.thread, HUB_EVENT_SCOPES.inbox]);
    ctx.events.length = 0;
    expect((await api.answerInbox(item.id, answer)).ok).toBe(false);
    expect(ctx.events).toEqual([]);
  });

  it('审批决定刷新四个相关范围并保持机器人归属', async () => {
    const { ctx, api, bot } = await apiFixture();
    const approval = await requestApproval(ctx, bot.id, 'send_email', { text: '待确认消息' }, 'C', '需要确认后发送');
    ctx.events.length = 0;
    expect((await api.decideApproval(approval.id, false)).ok).toBe(true);
    expectBotChanges(ctx.events, bot.id, [HUB_EVENT_SCOPES.bot, HUB_EVENT_SCOPES.thread, HUB_EVENT_SCOPES.inbox, HUB_EVENT_SCOPES.activity]);
  });

  it('全局规矩逐机器人通知，绝不发送 bot:null', async () => {
    const { ctx, bot, peer } = toolFixture();
    ctx.events.length = 0;
    await upsertRule(ctx, { scope: 'global', text: '先核实可见事实' });
    expect(ctx.events).toEqual([{ scope: HUB_EVENT_SCOPES.bot, botId: bot.id }, { scope: HUB_EVENT_SCOPES.bot, botId: peer.id }]);
  });

  it('全队额度保护仍逐个通知机器人的状态变化，全局范围允许 null', () => {
    const { ctx, bot, peer, now } = toolFixture();
    ctx.events.length = 0;
    restForQuota(ctx, { ...getQuotaState(ctx, now), light: 'red', redUntil: now + 60_000 }, now);
    expect(ctx.events.filter(event => event.scope === HUB_EVENT_SCOPES.bot)).toEqual([
      { scope: HUB_EVENT_SCOPES.bot, botId: bot.id }, { scope: HUB_EVENT_SCOPES.bot, botId: peer.id },
    ]);
    expect(ctx.events).toContainEqual({ scope: HUB_EVENT_SCOPES.overview, botId: null });
  });

  it('只有团队线程用 thread:null，单机器人线程明确传 id', () => {
    const { ctx, bot } = toolFixture();
    ctx.events.length = 0;
    postThread(ctx, { thread: 'team', from: 'owner', kind: 'chat', text: '团队消息' });
    postThread(ctx, { thread: bot.id, from: 'owner', kind: 'chat', text: '单独消息' });
    expect(ctx.events).toEqual([{ scope: HUB_EVENT_SCOPES.thread, botId: null }, { scope: HUB_EVENT_SCOPES.thread, botId: bot.id }]);
  });

  it('真实 Hub 订阅推送遵循词表、带身份且同入口同范围去重', async () => {
    const ctx = createTestContext();
    ctx.store.table('bots').put({ ...botFixture, createdAt: ctx.clock.now(), updatedAt: ctx.clock.now() });
    const hub = createHub(ctx);
    await hub.start();
    const events: Change[] = [];
    const unsubscribe = hub.subscribe(event => events.push(event));
    expect((await hub.api.updateBot(botFixture.id, { persona: '先看证据，再给建议' })).ok).toBe(true);
    expect(events.some(event => event.scope === HUB_EVENT_SCOPES.bot && event.botId === botFixture.id)).toBe(true);
    expect(events.every(event => new Set<string>(Object.values(HUB_EVENT_SCOPES)).has(event.scope))).toBe(true);
    expect(new Set(events.map(event => `${event.scope}:${event.botId}`)).size).toBe(events.length);
    unsubscribe();
    const count = events.length;
    await hub.api.updateBot(botFixture.id, { persona: '逐项核对证据' });
    expect(events).toHaveLength(count);
    await hub.stop();
  });
});

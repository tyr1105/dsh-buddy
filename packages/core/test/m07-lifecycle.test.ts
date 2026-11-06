/** M07 生命周期动作回归：界面只表达意图，中心保留试岗资格、授权边界和隔离恢复规则。 */
import { describe, expect, it } from 'vitest';
import { apiFixture, okData } from './c04-api-fixtures.js';
import { BotSchema } from '../src/model/bot.js';
import { quarantine } from '../src/health/quarantine.js';
import { syncAlertItems } from '../src/outreach/alerts.js';
import { guardToolCall } from '../src/gate/guard.js';
import type { Lifecycle } from '../src/model/index.js';
import type { LifecycleAction } from '../src/api/bots.js';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { createUiApi } from '../src/api/index.js';
import { FileStore } from '../src/store/file-store.js';
import { initRoot } from '../src/memory/files.js';

const DAY = 86_400_000;

describe('M07 暂停与恢复动作', () => {
  it.each(['probation', 'active'] as const)('暂停 %s 保存原资格、清队列并经 schema 保留存档字段', async lifecycle => {
    const { ctx, api, bot } = await apiFixture();
    if (lifecycle === 'active') ctx.store.table('bots').patch(bot.id, { lifecycle, probationEndsAt: null });
    const paused = okData(await api.lifecycleAction({ botId: bot.id, action: 'pause' }));
    expect(paused).toMatchObject({ lifecycle: 'paused', pausedFrom: lifecycle, activity: 'resting', activityText: '已暂停（你暂停的）' });
    expect(ctx.store.table('queue').list(row => row.botId === bot.id)).toHaveLength(0);
    expect(BotSchema.parse(JSON.parse(JSON.stringify(paused))).pausedFrom).toBe(lifecycle);
    expect(ctx.store.log('audit').all().some(row => row.action === 'ui_lifecycleAction')).toBe(true);
    expect(api.thread(bot.id).messages.at(-1)?.text).toContain('已暂停');
  });

  it.each([0, 4])('试岗第 %i 天恢复保持 probation，绝不把恢复当提前转正', async days => {
    const { ctx, api, bot } = await apiFixture();
    ctx.clock.advance(days * DAY);
    okData(await api.lifecycleAction({ botId: bot.id, action: 'pause' }));
    const resumed = okData(await api.lifecycleAction({ botId: bot.id, action: 'resume' }));
    expect(resumed).toMatchObject({ lifecycle: 'probation', pausedFrom: null, probationEndsAt: bot.probationEndsAt, activity: 'watching' });
    expect(await ctx.fs.readText(`${bot.homeDir}/AGENTS.md`)).toContain('L1');
  });

  it.each(['L0', 'L1', 'L2', 'L3'] as const)('暂停跨过试岗截止时恢复 active，原授权 %s 按 M03 封顶 L2', async autonomy => {
    const { ctx, api, bot } = await apiFixture();
    okData(await api.updateBot(bot.id, { autonomy }));
    okData(await api.lifecycleAction({ botId: bot.id, action: 'pause' }));
    ctx.clock.advance(ctx.settings.probationMs);
    const resumed = okData(await api.lifecycleAction({ botId: bot.id, action: 'resume' }));
    expect(resumed).toMatchObject({ lifecycle: 'active', autonomy: autonomy === 'L3' ? 'L2' : autonomy, probationEndsAt: null, pausedFrom: null });
  });

  it('正式 L3 暂停恢复保留显式授权；旧 setLifecycle 暂停同样保存资格', async () => {
    const { ctx, api, bot } = await apiFixture();
    ctx.clock.advance(3 * DAY);
    okData(await api.lifecycleAction({ botId: bot.id, action: 'promote' }));
    okData(await api.updateBot(bot.id, { autonomy: 'L3' }));
    expect(okData(await api.setLifecycle(bot.id, 'paused')).pausedFrom).toBe('active');
    expect(okData(await api.lifecycleAction({ botId: bot.id, action: 'resume' }))).toMatchObject({ lifecycle: 'active', autonomy: 'L3', pausedFrom: null });
  });

  it.each([0, 4, 8])('缺 pausedFrom 的旧暂停存档在第 %i 天按原截止恢复', async days => {
    const { ctx, api, bot } = await apiFixture();
    ctx.store.table('bots').put(BotSchema.parse({ ...bot, lifecycle: 'paused' }));
    ctx.clock.advance(days * DAY);
    const resumed = okData(await api.lifecycleAction({ botId: bot.id, action: 'resume' }));
    expect(resumed.lifecycle).toBe(days < 7 ? 'probation' : 'active');
    expect(resumed.probationEndsAt).toBe(days < 7 ? bot.probationEndsAt : null);
  });

  it('缺 pausedFrom 且无试岗截止的旧正式机器人恢复 active', async () => {
    const { ctx, api, bot } = await apiFixture();
    ctx.store.table('bots').put(BotSchema.parse({ ...bot, lifecycle: 'paused', probationEndsAt: null, autonomy: 'L3' }));
    expect(okData(await api.lifecycleAction({ botId: bot.id, action: 'resume' }))).toMatchObject({ lifecycle: 'active', autonomy: 'L3' });
  });

  it.each([
    { initial: 'probation', days: 4, expected: 'probation' },
    { initial: 'probation', days: 8, expected: 'active' },
    { initial: 'active', days: 4, expected: 'active' },
  ] as const)('FileStore 重建后仍记得 $initial 的暂停资格，第 $days 天恢复 $expected', async ({ initial, days, expected }) => {
    const base = createTestContext();
    const store = new FileStore(base.fs, base.clock, base.settings.rootDir, base.settings.timezone, base.logger);
    const ctx = createTestContext({ store, fs: base.fs, clock: base.clock });
    await initRoot(ctx);
    const api = createUiApi(ctx, () => store.flush());
    const bot = okData(await api.createBot({ name: '重建同事', role: 'researcher', persona: '核实资料', aspirations: ['保留公开证据'] }));
    if (initial === 'active') store.table('bots').patch(bot.id, { lifecycle: initial, probationEndsAt: null });
    okData(await api.lifecycleAction({ botId: bot.id, action: 'pause' }));
    const onDisk = JSON.parse((await base.fs.readText('/hub/.hub/state/bots.json'))!);
    expect(onDisk[0]).toMatchObject({ lifecycle: 'paused', pausedFrom: initial });

    // 全新存储实例只从注入文件系统恢复，不能依靠原上下文里的内存对象。
    base.clock.advance(days * DAY);
    const restored = new FileStore(base.fs, base.clock, base.settings.rootDir, base.settings.timezone, base.logger);
    await restored.load();
    expect(restored.table('bots').get(bot.id)).toMatchObject({ lifecycle: 'paused', pausedFrom: initial });
    const resumedApi = createUiApi(createTestContext({ store: restored, fs: base.fs, clock: base.clock }), () => restored.flush());
    expect(okData(await resumedApi.lifecycleAction({ botId: bot.id, action: 'resume' }))).toMatchObject({ lifecycle: expected, pausedFrom: null });
    expect(JSON.parse((await base.fs.readText('/hub/.hub/state/bots.json'))!)[0]).toMatchObject({ lifecycle: expected, pausedFrom: null });
  });

  it('暂停期间主人消息在恢复后重新入队，保留原始消息证据', async () => {
    const { ctx, api, bot } = await apiFixture();
    okData(await api.lifecycleAction({ botId: bot.id, action: 'pause' }));
    expect((await api.sendMessage(bot.id, '恢复后请核实公开资料')).ok).toBe(true);
    const percept = ctx.store.table('percepts').list(row => row.botId === bot.id && row.source === 'owner')[0]!;
    okData(await api.lifecycleAction({ botId: bot.id, action: 'resume' }));
    expect(ctx.store.table('queue').list(row => row.botId === bot.id)).toEqual([expect.objectContaining({
      reason: expect.objectContaining({ kind: 'owner_message', evidence: [percept.id] }), ownerInitiated: true,
    })]);
  });
});

describe('M07 明确的转正与解除隔离动作', () => {
  it.each(['action', 'legacy'] as const)('旧草稿等待十天后才试岗，%s 入口仍须实际试岗满三天', async entry => {
    const { ctx, api, bot } = await apiFixture();
    // 模拟 M07 前的草稿档案：没有试岗开始字段，创建时间远早于实际开始工作。
    const { probationStartedAt: _oldStart, ...legacy } = bot;
    ctx.store.table('bots').put(BotSchema.parse({ ...legacy, lifecycle: 'draft', probationEndsAt: null }));
    ctx.clock.advance(10 * DAY);
    const startedAt = ctx.clock.now();
    expect(okData(await api.setLifecycle(bot.id, 'probation'))).toMatchObject({
      lifecycle: 'probation', createdAt: bot.createdAt, probationStartedAt: startedAt,
      probationEndsAt: startedAt + ctx.settings.probationMs,
    });
    const promote = () => entry === 'action'
      ? api.lifecycleAction({ botId: bot.id, action: 'promote' }) : api.setLifecycle(bot.id, 'active');
    expect(await promote()).toMatchObject({ ok: false, error: expect.stringContaining(entry === 'action' ? '还差 3 天' : '必须满三天') });
    ctx.clock.advance(3 * DAY - 1);
    expect((await promote()).ok).toBe(false);
    ctx.clock.advance(1);
    expect(okData(await promote())).toMatchObject({ lifecycle: 'active', probationStartedAt: startedAt, probationEndsAt: null });
  });

  it.each(['action', 'legacy'] as const)('旧试岗档案没有开始字段时，%s 入口仍兼容创建时间资格', async entry => {
    const { ctx, api, bot } = await apiFixture();
    expect(bot.probationStartedAt).toBe(bot.createdAt);
    const { probationStartedAt: _oldStart, ...legacy } = bot;
    ctx.store.table('bots').put(BotSchema.parse(legacy));
    const promote = () => entry === 'action'
      ? api.lifecycleAction({ botId: bot.id, action: 'promote' }) : api.setLifecycle(bot.id, 'active');
    expect((await promote()).ok).toBe(false);
    ctx.clock.advance(3 * DAY);
    expect(okData(await promote()).lifecycle).toBe('active');
  });

  it('未满三天错误说明还差几天，边界满三天才可转正并封顶 L2', async () => {
    const { ctx, api, bot } = await apiFixture();
    okData(await api.updateBot(bot.id, { autonomy: 'L3' }));
    expect(await api.lifecycleAction({ botId: bot.id, action: 'promote' })).toEqual({ ok: false, error: '提前转正：试岗时间还差 3 天' });
    ctx.clock.advance(3 * DAY - 1);
    expect(await api.lifecycleAction({ botId: bot.id, action: 'promote' })).toEqual({ ok: false, error: '提前转正：试岗时间还差 1 天' });
    expect(ctx.store.table('bots').get(bot.id)?.probationEndsAt).toBe(bot.probationEndsAt);
    ctx.clock.advance(1);
    expect(okData(await api.lifecycleAction({ botId: bot.id, action: 'promote' }))).toMatchObject({ lifecycle: 'active', probationEndsAt: null, autonomy: 'L2' });
  });

  it('转正门槛遵循设置覆盖，剩余天数仍准确', async () => {
    const { ctx, api, bot } = await apiFixture();
    ctx.settings.probationEarlyPromotionMs = 2 * DAY;
    ctx.clock.advance(DAY);
    expect(await api.lifecycleAction({ botId: bot.id, action: 'promote' })).toEqual({ ok: false, error: '提前转正：试岗时间还差 1 天' });
    ctx.clock.advance(DAY);
    expect(okData(await api.lifecycleAction({ botId: bot.id, action: 'promote' })).lifecycle).toBe('active');
  });

  it.each([3, 8])('第 %i 天仍有越界记录时拒绝显式转正并说明原因', async days => {
    const { ctx, api, bot } = await apiFixture();
    ctx.store.table('bots').patch(bot.id, { violations: 1 });
    ctx.clock.advance(days * DAY);
    expect(await api.lifecycleAction({ botId: bot.id, action: 'promote' })).toEqual({ ok: false, error: '提前转正：有越界记录，不能转正' });
    expect(ctx.store.table('bots').get(bot.id)).toMatchObject({ lifecycle: 'probation', violations: 1, probationEndsAt: bot.probationEndsAt });
  });

  it.each([0, 8])('第 %i 天解除隔离清故障和告警，恢复对应资格', async days => {
    const { ctx, api, bot } = await apiFixture();
    okData(await api.updateBot(bot.id, { autonomy: 'L3' }));
    ctx.store.table('bots').patch(bot.id, { sessionId: 'isolated-session', consecutiveErrors: 3, consecutiveNoCommit: 3, violations: 3 });
    quarantine(ctx, bot.id, '连续故障');
    await syncAlertItems(ctx);
    ctx.clock.advance(days * DAY);
    const restored = okData(await api.lifecycleAction({ botId: bot.id, action: 'release_quarantine' }));
    expect(restored).toMatchObject({ lifecycle: days === 0 ? 'probation' : 'active', consecutiveErrors: 0, consecutiveNoCommit: 0,
      violations: 0, quarantineReason: null, retryAt: null, releasedAt: ctx.clock.now() });
    expect(restored.probationEndsAt).toBe(days === 0 ? bot.probationEndsAt : null);
    expect(restored.autonomy).toBe(days === 0 ? 'L3' : 'L2');
    expect(ctx.store.table('alerts').list(row => row.code === 'quarantine' && row.status === 'open')).toHaveLength(0);
    expect(ctx.store.table('inbox').list(row => row.type === 'alert' && row.status === 'open')).toHaveLength(0);
    if (days === 0) {
      ctx.settings.l3Grants = ['write_file'];
      const verdict = await guardToolCall(ctx, 'isolated-session', 'write_file', { path: '/public-note.txt', content: '公开说明' });
      expect(verdict.allow).toBe(false);
      expect(ctx.store.table('approvals').count()).toBe(1);
    }
  });
});

describe('M07 每个动作的状态边界和输入校验', () => {
  const rejected: Array<[LifecycleAction, Lifecycle]> = [
    ...(['draft', 'paused', 'quarantined', 'retired'] as const).map(state => ['pause', state] as [LifecycleAction, Lifecycle]),
    ...(['draft', 'probation', 'active', 'quarantined', 'retired'] as const).map(state => ['resume', state] as [LifecycleAction, Lifecycle]),
    ...(['draft', 'paused', 'active', 'quarantined', 'retired'] as const).map(state => ['promote', state] as [LifecycleAction, Lifecycle]),
    ...(['draft', 'probation', 'active', 'paused', 'retired'] as const).map(state => ['release_quarantine', state] as [LifecycleAction, Lifecycle]),
    ['retire', 'retired'],
  ];
  it.each(rejected)('%s 不允许从 %s 偷换生命周期', async (action, lifecycle) => {
    const { ctx, api, bot } = await apiFixture();
    ctx.store.table('bots').patch(bot.id, { lifecycle });
    const before = ctx.store.table('bots').get(bot.id);
    const result = await api.lifecycleAction({ botId: bot.id, action });
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/[\u3400-\u9fff]/) });
    expect(ctx.store.table('bots').get(bot.id)).toEqual(before);
    expect(api.thread(bot.id).messages).toHaveLength(0);
  });

  it.each(['draft', 'probation', 'active', 'paused', 'quarantined'] as const)('%s 可以退役，档案保留且不能再恢复', async lifecycle => {
    const { ctx, api, bot } = await apiFixture();
    ctx.store.table('bots').patch(bot.id, { lifecycle });
    expect(okData(await api.lifecycleAction({ botId: bot.id, action: 'retire' }))).toMatchObject({ lifecycle: 'retired', activity: 'resting', activityText: '已退役' });
    expect(ctx.store.table('queue').list(row => row.botId === bot.id)).toHaveLength(0);
    expect((await api.lifecycleAction({ botId: bot.id, action: 'resume' })).ok).toBe(false);
    expect(ctx.store.table('bots').get(bot.id)?.lifecycle).toBe('retired');
  });

  it.each([null, {}, { botId: 'missing', action: 'pause' }, { botId: 1, action: 'pause' }, { action: 'unknown' }, { action: 'pause', extra: true }])('非法输入 %j 返回中文且不改档案', async raw => {
    const { ctx, api, bot } = await apiFixture();
    const args = raw && typeof raw === 'object' ? { botId: bot.id, ...raw } : raw;
    const before = ctx.store.table('bots').get(bot.id);
    expect(await api.lifecycleAction(args)).toMatchObject({ ok: false, error: expect.stringMatching(/[\u3400-\u9fff]/) });
    expect(ctx.store.table('bots').get(bot.id)).toEqual(before);
  });
});

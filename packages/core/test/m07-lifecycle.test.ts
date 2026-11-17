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
    // P73a（5.1 第 2 类）：没有试岗；旧试岗档案暂停时 pausedFrom 也记为 active（原预期记原资格 probation）。
    if (lifecycle === 'probation') ctx.store.table('bots').patch(bot.id, { lifecycle, probationEndsAt: ctx.clock.now() + 7 * DAY });
    const paused = okData(await api.lifecycleAction({ botId: bot.id, action: 'pause' }));
    // P73a（5.1 第 3 类）：原预期 activityText「已暂停（你暂停的）」；新预期「已停用（你停用的）」。
    expect(paused).toMatchObject({ lifecycle: 'paused', pausedFrom: 'active', activity: 'resting', activityText: '已停用（你停用的）' });
    expect(ctx.store.table('queue').list(row => row.botId === bot.id)).toHaveLength(0);
    expect(BotSchema.parse(JSON.parse(JSON.stringify(paused))).pausedFrom).toBe('active');
    expect(ctx.store.log('audit').all().some(row => row.action === 'ui_lifecycleAction')).toBe(true);
    expect(api.thread(bot.id).messages.at(-1)?.text).toContain('已停用');
  });

  it.each([0, 4])('第 %i 天暂停后恢复回到在岗，pausedFrom 清空', async days => {
    const { ctx, api, bot } = await apiFixture();
    ctx.clock.advance(days * DAY);
    okData(await api.lifecycleAction({ botId: bot.id, action: 'pause' }));
    const resumed = okData(await api.lifecycleAction({ botId: bot.id, action: 'resume' }));
    // P73a（5.1 第 2 类）：原预期恢复到 probation 并保留试岗截止；新预期恢复到 active，截止为空。
    expect(resumed).toMatchObject({ lifecycle: 'active', pausedFrom: null, probationEndsAt: null, activity: 'watching' });
    expect(await ctx.fs.readText(`${bot.homeDir}/AGENTS.md`)).toContain('L1');
  });

  it.each(['L0', 'L1', 'L2', 'L3'] as const)('暂停后恢复在岗，档案里的授权 %s 不被改动（没有试岗就没有封顶）', async autonomy => {
    const { ctx, api, bot } = await apiFixture();
    // P73a（5.1 第 5 类）：执行类经 updateBot 传入的授权被忽略，授权只可能来自旧数据，这里直接改档案模拟。
    ctx.store.table('bots').patch(bot.id, { autonomy });
    okData(await api.lifecycleAction({ botId: bot.id, action: 'pause' }));
    ctx.clock.advance(ctx.settings.probationMs);
    const resumed = okData(await api.lifecycleAction({ botId: bot.id, action: 'resume' }));
    // 原预期 L3 封顶 L2；新预期恢复不再区分试岗，授权原样保留。
    expect(resumed).toMatchObject({ lifecycle: 'active', autonomy, probationEndsAt: null, pausedFrom: null });
  });

  it('正式 L3 暂停恢复保留显式授权；旧 setLifecycle 暂停同样保存资格', async () => {
    const { ctx, api, bot } = await apiFixture();
    // P73a（5.1 第 2 类）：原先先 promote 再 updateBot 设 L3；新预期没有试岗，promote 已不可用，授权直接改档案模拟旧数据。
    ctx.store.table('bots').patch(bot.id, { autonomy: 'L3' });
    expect(okData(await api.setLifecycle(bot.id, 'paused')).pausedFrom).toBe('active');
    expect(okData(await api.lifecycleAction({ botId: bot.id, action: 'resume' }))).toMatchObject({ lifecycle: 'active', autonomy: 'L3', pausedFrom: null });
  });

  it.each([0, 4, 8])('缺 pausedFrom 的旧暂停存档在第 %i 天恢复一律回到在岗', async days => {
    const { ctx, api, bot } = await apiFixture();
    ctx.store.table('bots').put(BotSchema.parse({ ...bot, lifecycle: 'paused', probationEndsAt: ctx.clock.now() + 7 * DAY }));
    ctx.clock.advance(days * DAY);
    const resumed = okData(await api.lifecycleAction({ botId: bot.id, action: 'resume' }));
    // P73a（5.1 第 2 类）：原预期第 0、4 天恢复 probation、第 8 天 active；新预期一律 active，试岗截止为空。
    expect(resumed.lifecycle).toBe('active');
    expect(resumed.probationEndsAt).toBeNull();
  });

  it('缺 pausedFrom 且无试岗截止的旧正式机器人恢复 active', async () => {
    const { ctx, api, bot } = await apiFixture();
    ctx.store.table('bots').put(BotSchema.parse({ ...bot, lifecycle: 'paused', probationEndsAt: null, autonomy: 'L3' }));
    expect(okData(await api.lifecycleAction({ botId: bot.id, action: 'resume' }))).toMatchObject({ lifecycle: 'active', autonomy: 'L3' });
  });

  it.each([
    // P73a（5.1 第 2 类）：原预期 probation 暂停后第 4 天恢复 probation；新预期一律恢复 active，暂停资格统一记为 active。
    { initial: 'probation', days: 4, expected: 'active' },
    { initial: 'probation', days: 8, expected: 'active' },
    { initial: 'active', days: 4, expected: 'active' },
  ] as const)('FileStore 重建后仍记得 $initial 的暂停资格，第 $days 天恢复 $expected', async ({ initial, days, expected }) => {
    const base = createTestContext();
    const store = new FileStore(base.fs, base.clock, base.settings.rootDir, base.settings.timezone, base.logger);
    const ctx = createTestContext({ store, fs: base.fs, clock: base.clock });
    await initRoot(ctx);
    const api = createUiApi(ctx, () => store.flush());
    const bot = okData(await api.createBot({ name: '重建同事', role: 'researcher', persona: '核实资料', aspirations: ['保留公开证据'] }));
    if (initial === 'probation') store.table('bots').patch(bot.id, { lifecycle: initial, probationEndsAt: base.clock.now() + 7 * DAY });
    okData(await api.lifecycleAction({ botId: bot.id, action: 'pause' }));
    const onDisk = JSON.parse((await base.fs.readText('/hub/.hub/state/bots.json'))!);
    expect(onDisk[0]).toMatchObject({ lifecycle: 'paused', pausedFrom: 'active' });

    // 全新存储实例只从注入文件系统恢复，不能依靠原上下文里的内存对象。
    base.clock.advance(days * DAY);
    const restored = new FileStore(base.fs, base.clock, base.settings.rootDir, base.settings.timezone, base.logger);
    await restored.load();
    expect(restored.table('bots').get(bot.id)).toMatchObject({ lifecycle: 'paused', pausedFrom: 'active' });
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
  // P73a（5.1 第 2 类）：以下 6 条原先验证「提前转正的三天门槛、越界拦截」；没有试岗之后，promote 一律报
  // 「已没有试岗这一步」，旧试岗档案经 setLifecycle 立即转在岗（仍封顶 L3 为 L2）。预期随之改写。
  it.each(['action', 'legacy'] as const)('旧草稿档案上岗后直接在岗，%s 入口不再有试岗门槛', async entry => {
    const { ctx, api, bot } = await apiFixture();
    // 模拟 M07 前的草稿档案：没有试岗开始字段。
    const { probationStartedAt: _oldStart, ...legacy } = bot;
    ctx.store.table('bots').put(BotSchema.parse({ ...legacy, lifecycle: 'draft', probationEndsAt: null }));
    ctx.clock.advance(10 * DAY);
    expect(okData(await api.setLifecycle(bot.id, 'probation'))).toMatchObject({
      lifecycle: 'active', createdAt: bot.createdAt, probationEndsAt: null,
    });
    const promote = () => entry === 'action'
      ? api.lifecycleAction({ botId: bot.id, action: 'promote' }) : api.setLifecycle(bot.id, 'active');
    expect(await promote()).toMatchObject({ ok: false, error: expect.stringContaining(entry === 'action' ? '已没有试岗这一步' : '不允许从 active') });
  });

  it.each(['action', 'legacy'] as const)('旧试岗档案没有开始字段时，%s 入口：promote 报没有试岗，setLifecycle 立即转在岗', async entry => {
    const { ctx, api, bot } = await apiFixture();
    const { probationStartedAt: _oldStart, ...legacy } = bot;
    ctx.store.table('bots').put(BotSchema.parse({ ...legacy, lifecycle: 'probation', probationEndsAt: ctx.clock.now() + 7 * DAY }));
    if (entry === 'action') expect(await api.lifecycleAction({ botId: bot.id, action: 'promote' })).toMatchObject({ ok: false, error: '提前转正：已没有试岗这一步' });
    else expect(okData(await api.setLifecycle(bot.id, 'active')).lifecycle).toBe('active');
  });

  it('promote 一律报没有试岗；旧试岗档案经 setLifecycle 转在岗时 L3 封顶 L2', async () => {
    const { ctx, api, bot } = await apiFixture();
    expect(await api.lifecycleAction({ botId: bot.id, action: 'promote' })).toEqual({ ok: false, error: '提前转正：已没有试岗这一步' });
    ctx.store.table('bots').patch(bot.id, { lifecycle: 'probation', autonomy: 'L3', probationEndsAt: ctx.clock.now() + 7 * DAY });
    expect(await api.lifecycleAction({ botId: bot.id, action: 'promote' })).toEqual({ ok: false, error: '提前转正：已没有试岗这一步' });
    expect(okData(await api.setLifecycle(bot.id, 'active'))).toMatchObject({ lifecycle: 'active', probationEndsAt: null, autonomy: 'L2' });
  });

  it('转正门槛的设置不再起作用：promote 仍报没有试岗', async () => {
    const { ctx, api, bot } = await apiFixture();
    ctx.settings.probationEarlyPromotionMs = 2 * DAY;
    ctx.clock.advance(3 * DAY);
    expect(await api.lifecycleAction({ botId: bot.id, action: 'promote' })).toEqual({ ok: false, error: '提前转正：已没有试岗这一步' });
  });

  it.each([3, 8])('第 %i 天有越界记录时 promote 仍报没有试岗，档案不变', async days => {
    const { ctx, api, bot } = await apiFixture();
    ctx.store.table('bots').patch(bot.id, { violations: 1 });
    ctx.clock.advance(days * DAY);
    expect(await api.lifecycleAction({ botId: bot.id, action: 'promote' })).toEqual({ ok: false, error: '提前转正：已没有试岗这一步' });
    expect(ctx.store.table('bots').get(bot.id)).toMatchObject({ lifecycle: 'active', violations: 1, probationEndsAt: null });
  });

  it.each([0, 8])('第 %i 天解除隔离清故障和告警，恢复到在岗', async days => {
    const { ctx, api, bot } = await apiFixture();
    okData(await api.updateBot(bot.id, { autonomy: 'L3' }));
    ctx.store.table('bots').patch(bot.id, { sessionId: 'isolated-session', consecutiveErrors: 3, consecutiveNoCommit: 3, violations: 3 });
    quarantine(ctx, bot.id, '连续故障');
    await syncAlertItems(ctx);
    ctx.clock.advance(days * DAY);
    const restored = okData(await api.lifecycleAction({ botId: bot.id, action: 'release_quarantine' }));
    // P73a（5.1 第 2 类）：原预期第 0 天恢复 probation（保留试岗截止、授权 L3）、第 8 天 active（封顶 L2）；
    // 新预期两种情况都恢复 active、截止为空；执行类授权固定 L1（传入的 L3 被忽略）。
    expect(restored).toMatchObject({ lifecycle: 'active', consecutiveErrors: 0, consecutiveNoCommit: 0,
      violations: 0, quarantineReason: null, retryAt: null, releasedAt: ctx.clock.now() });
    expect(restored.probationEndsAt).toBeNull();
    expect(restored.autonomy).toBe('L1');
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
    expect(okData(await api.lifecycleAction({ botId: bot.id, action: 'retire' }))).toMatchObject({ lifecycle: 'retired', activity: 'resting', activityText: '已归档' });
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

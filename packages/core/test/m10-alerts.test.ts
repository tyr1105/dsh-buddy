/** M10 告警新轮回归：真实 Hub 回合、主人确认和恢复均必须留下可再次处理的卡片，旧档合并不能关掉唯一入口。 */
import { describe, expect, it } from 'vitest';
import { createHub } from '../src/engine/hub.js';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { createBotHome } from '../src/memory/files.js';
import { raiseAlert, closeAlert } from '../src/health/alerts.js';
import { quarantine } from '../src/health/quarantine.js';
import { syncAlertItems } from '../src/outreach/alerts.js';
import { createInboxItem, closeAlertItem } from '../src/outreach/inbox.js';
import { pushHistory } from '../src/outreach/push.js';
import { onQuotaError } from '../src/quota/window.js';
import { buildSnapshot } from '../src/scheduler/snapshot.js';
import { createSimWorld } from '../src/sim/runner.js';
import { errorBrain, quietBrain } from '../src/sim/brains.js';
import { FileStore } from '../src/store/file-store.js';
import { botFixture } from './model-fixtures.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const quota = { code: 'quota', botId: null, text: '额度保护', level: 'P0' as const, immediate: true };

/** 真实 Hub 配内存宿主，假宿主的结束事件由测试显式送入公共入口。 */
async function setup(count = 1) {
  const ctx = createTestContext();
  ctx.settings = { ...ctx.settings, ownerActiveConcurrentThinks: count, maxConcurrentThinks: count };
  const bots = [];
  for (let i = 0; i < count; i += 1) {
    const id = `b_${String(i + 1).padStart(10, '0')}`;
    const bot = { ...botFixture, id, homeDir: `/hub/bots/${id}`, lifecycle: 'active' as const,
      sessionId: null, sessionStartedAt: null, nextThinkAt: null, lightCheckAt: null, expectedBy: null };
    ctx.store.table('bots').put(bot);
    await createBotHome(ctx, bot);
    bots.push(bot);
  }
  const hub = createHub(ctx);
  await hub.start();
  return { ctx, hub, bots };
}

/** 可见性、推送与唯一开放身份一起断言，避免只看底层 open 就误判给主人告警成功。 */
function expectNewRound(ctx: Awaited<ReturnType<typeof setup>>['ctx'], code: string, firstId: string, at: number) {
  const alerts = ctx.store.table('alerts').list(row => row.code === code && row.status === 'open');
  expect(alerts).toHaveLength(1);
  const next = alerts[0]!;
  expect(next.id).not.toBe(firstId);
  expect(next).toMatchObject({ firstAt: at, lastAt: at, count: 1 });
  const cards = ctx.store.table('inbox').list(row => row.type === 'alert' && row.refId === next.id);
  expect(cards).toHaveLength(1);
  expect(cards[0]).toMatchObject({ status: 'open', pushed: true });
  expect(ctx.store.log('thread').all().filter(row => row.kind === 'alert')).toHaveLength(2);
  expect(pushHistory(ctx).filter(row => row.result === 'sent')).toHaveLength(2);
  return cards[0]!;
}

describe('M10 恢复或确认后的新一轮告警', () => {
  it('真实 401 → 知道了 → 三分钟后再次 401，出现新卡和一次 P0 推送，二次确认解除 authBlocked', async () => {
    const world = await createSimWorld({ bots: [{ id: botFixture.id, name: '巡检员', brain: errorBrain('401 Unauthorized: invalid api key') }] });
    await world.hub.api.sendMessage(botFixture.id, '请检查日志');
    await world.host.settle();
    const first = world.store.table('alerts').list(row => row.code === 'auth')[0]!;
    const firstCard = world.hub.api.inbox().items.find(row => row.type === 'alert')!;
    expect(world.host.notifications.filter(row => row.level === 'P0')).toHaveLength(1);
    expect(await world.hub.api.answerInbox(firstCard.id, '知道了')).toMatchObject({ ok: true });
    const snapshot = createTestContext({ store: world.store, clock: world.clock, settings: world.settings });
    expect(buildSnapshot(snapshot, botFixture.id, world.clock.now()).authBlocked).toBe(false);
    world.clock.advance(3 * MINUTE);
    await world.hub.api.sendMessage(botFixture.id, '修好后重新检查');
    await world.host.settle();
    const current = world.store.table('alerts').list(row => row.code === 'auth' && row.status === 'open')[0]!;
    expect(current.id).not.toBe(first.id);
    expect(current).toMatchObject({ count: 1, firstAt: world.clock.now(), lastAt: world.clock.now() });
    const secondCard = world.hub.api.inbox().items.find(row => row.type === 'alert')!;
    expect(secondCard.id).not.toBe(firstCard.id);
    expect(world.store.table('inbox').get(secondCard.id)?.refId).toBe(current.id);
    expect(world.host.notifications.filter(row => row.level === 'P0')).toHaveLength(2);
    expect(world.store.log('thread').all().filter(row => row.kind === 'alert')).toHaveLength(2);
    expect(buildSnapshot(snapshot, botFixture.id, world.clock.now()).authBlocked).toBe(true);
    expect(await world.hub.api.answerInbox(secondCard.id, '知道了')).toMatchObject({ ok: true });
    expect(buildSnapshot(snapshot, botFixture.id, world.clock.now()).authBlocked).toBe(false);
    world.host.registerBrain(botFixture.id, quietBrain);
    await world.hub.api.sendMessage(botFixture.id, '再次确认现在能工作');
    await world.host.settle();
    expect(world.host.turns.at(-1)?.status).toBe('ended');
    expect(world.store.table('commits').count()).toBe(1);
  });

  it.each([2, -2])('鉴权确认后另一在途回合时间戳差 %i 毫秒仍是新轮，可再次确认', async offset => {
    const { ctx, hub, bots } = await setup(2);
    const base = ctx.clock.now();
    for (const bot of bots) expect(await hub.api.sendMessage(bot.id, '核对日志')).toMatchObject({ ok: true });
    const sessions = bots.map(bot => ctx.store.table('bots').get(bot.id)!.sessionId!);
    const firstAt = base + (offset < 0 ? 2 : 0);
    ctx.host.sessions.get(sessions[0]!)!.running = false;
    await hub.onTurnEvent({ type: 'error', sessionId: sessions[0]!, at: firstAt, errorText: '401 Unauthorized' });
    const first = ctx.store.table('alerts').list(row => row.code === 'auth')[0]!;
    expect(await hub.api.answerInbox(hub.api.inbox().items[0]!.id, '知道了')).toMatchObject({ ok: true });
    ctx.clock.advance(3 * MINUTE);
    ctx.host.sessions.get(sessions[1]!)!.running = false;
    await hub.onTurnEvent({ type: 'error', sessionId: sessions[1]!, at: firstAt + offset, errorText: '401 Unauthorized' });
    const card = expectNewRound(ctx, 'auth', first.id, firstAt + offset);
    expect(buildSnapshot(ctx, bots[0]!.id, ctx.clock.now()).authBlocked).toBe(true);
    expect(await hub.api.answerInbox(card.id, '知道了')).toMatchObject({ ok: true });
    expect(buildSnapshot(ctx, bots[0]!.id, ctx.clock.now()).authBlocked).toBe(false);
  });

  it.each([2, -2])('额度卡确认后时间戳差 %i 毫秒的故障建新卡并再次 P0 推送', async offset => {
    const { ctx, hub } = await setup();
    const firstAt = ctx.clock.now();
    onQuotaError(ctx, firstAt);
    await hub.tick();
    const first = ctx.store.table('alerts').list(row => row.code === 'quota')[0]!;
    expect(await hub.api.answerInbox(hub.api.inbox().items[0]!.id, '知道了')).toMatchObject({ ok: true });
    ctx.clock.advance(3 * MINUTE);
    onQuotaError(ctx, firstAt + offset);
    await hub.tick();
    expectNewRound(ctx, 'quota', first.id, firstAt + offset);
  });

  it.each([2, -2])('解除隔离后时间戳差 %i 毫秒再次隔离，保留新的开放卡与 P1 推送', async offset => {
    const { ctx, hub, bots } = await setup();
    const firstAt = ctx.clock.now();
    quarantine(ctx, bots[0]!.id, '连续错误', firstAt);
    await hub.tick();
    const first = ctx.store.table('alerts').list(row => row.code === 'quarantine')[0]!;
    expect(await hub.api.lifecycleAction({ botId: bots[0]!.id, action: 'release_quarantine' })).toMatchObject({ ok: true });
    expect(ctx.store.table('alerts').get(first.id)).toMatchObject({ count: 0, status: 'closed' });
    ctx.clock.advance(3 * MINUTE);
    quarantine(ctx, bots[0]!.id, '再次连续错误', firstAt + offset);
    await hub.tick();
    const card = expectNewRound(ctx, 'quarantine', first.id, firstAt + offset);
    expect(card.priority).toBe('P1');
    expect(ctx.store.table('bots').get(bots[0]!.id)?.lifecycle).toBe('quarantined');
  });

  it('普通告警恢复后首次只观测，第二次才为新轮建卡，同轮重复不再推送', async () => {
    const { ctx } = await setup();
    const input = { ...quota, code: 'network', level: 'P1' as const, immediate: false };
    const first = raiseAlert(ctx, input);
    raiseAlert(ctx, input);
    await syncAlertItems(ctx);
    closeAlert(ctx, input.code, input.botId);
    await syncAlertItems(ctx);
    const next = raiseAlert(ctx, input);
    await syncAlertItems(ctx);
    expect(next.id).not.toBe(first.id);
    expect(next).toMatchObject({ count: 1, status: 'closed' });
    expect(ctx.store.table('inbox').list(row => row.status === 'open')).toHaveLength(0);
    raiseAlert(ctx, input);
    await syncAlertItems(ctx);
    raiseAlert(ctx, input);
    await syncAlertItems(ctx);
    expect(ctx.store.table('inbox').list(row => row.status === 'open')).toHaveLength(1);
    expect(pushHistory(ctx).filter(row => row.result === 'sent')).toHaveLength(2);
  });

  it('持续故障跨一小时换记录仍属于同一轮，不能绕过 24 小时推送去重', async () => {
    const { ctx } = await setup();
    const first = raiseAlert(ctx, quota);
    await syncAlertItems(ctx);
    ctx.clock.advance(HOUR);
    const next = raiseAlert(ctx, quota);
    await syncAlertItems(ctx);
    expect(next.id).not.toBe(first.id);
    expect(next.episodeId).toBe(first.id);
    expect(next.count).toBe(2);
    expect(ctx.store.table('inbox').list(row => row.status === 'open')).toHaveLength(1);
    expect(pushHistory(ctx).map(row => row.result)).toEqual(['sent', 'duplicate']);
  });

  it('跨窗口普通告警确认后，不捡回更早 count=1 的历史观测', async () => {
    const { ctx } = await setup();
    const input = { ...quota, immediate: false };
    const first = raiseAlert(ctx, input);
    ctx.clock.advance(HOUR);
    const opened = raiseAlert(ctx, input);
    await syncAlertItems(ctx);
    closeAlertItem(ctx, ctx.store.table('inbox').list()[0]!.id);
    const next = raiseAlert(ctx, input);
    expect(next.id).not.toBe(first.id);
    expect(next.id).not.toBe(opened.id);
    expect(next).toMatchObject({ count: 1, status: 'closed', firstAt: ctx.clock.now() });
    expect(next.episodeId).toBe(next.id);
    await syncAlertItems(ctx);
    expect(ctx.store.table('inbox').list(row => row.status === 'open')).toHaveLength(0);
    expect(pushHistory(ctx).filter(row => row.result === 'sent')).toHaveLength(1);
  });
});

describe('M10 旧档闭卡重开与开放卡合并', () => {
  it('倒序旧档合并后主人确认，不把后插入的重复记录当成尚未达门槛观测', async () => {
    const { ctx } = await setup();
    const first = raiseAlert(ctx, { ...quota, at: ctx.clock.now() + 2 });
    const duplicate = { ...first, id: 'al_0000000002', firstAt: ctx.clock.now(), lastAt: ctx.clock.now() };
    ctx.store.table('alerts').put(duplicate);
    await syncAlertItems(ctx);
    closeAlertItem(ctx, ctx.store.table('inbox').list(row => row.status === 'open')[0]!.id);
    const next = raiseAlert(ctx, { ...quota, immediate: false });
    expect(next.id).not.toBe(first.id);
    expect(next.id).not.toBe(duplicate.id);
    expect(next).toMatchObject({ count: 1, status: 'closed', episodeId: next.id });
    await syncAlertItems(ctx);
    expect(ctx.store.table('inbox').list(row => row.status === 'open')).toHaveLength(0);
  });

  it.each([1, 0, -1])('旧告警 lastAt 比闭卡时间差 %i 毫秒，仅新发生事实补卡且重复同步不重复推送', async delta => {
    const { ctx } = await setup();
    const first = raiseAlert(ctx, quota);
    await syncAlertItems(ctx);
    const card = ctx.store.table('inbox').list()[0]!;
    closeAlertItem(ctx, card.id);
    ctx.store.table('alerts').patch(first.id, { status: 'open', count: 1, lastAt: ctx.clock.now() + delta });
    await syncAlertItems(ctx);
    await syncAlertItems(ctx);
    expect(ctx.store.table('inbox').list(row => row.status === 'open')).toHaveLength(delta > 0 ? 1 : 0);
    expect(ctx.store.table('inbox').get(card.id)?.status).toBe('closed');
    expect(pushHistory(ctx).filter(row => row.result === 'sent')).toHaveLength(delta > 0 ? 2 : 1);
    expect(ctx.store.log('thread').all().filter(row => row.kind === 'alert')).toHaveLength(delta > 0 ? 2 : 1);
  });

  it.each(['latest_closed', 'older_closed', 'all_closed'] as const)('FileStore 旧档 %s：保留唯一开放卡，全部关闭则补新卡', async mode => {
    const { ctx: source } = await setup();
    const now = source.clock.now();
    const first = raiseAlert(source, quota);
    const latest = { ...first, id: 'al_0000000002', firstAt: now + 2, lastAt: now + 2, count: 2 };
    source.store.table('alerts').put(latest);
    const cards = [first, latest].map(alert => createInboxItem(source, { botId: null, type: 'alert', title: '中心告警：quota',
      body: alert.text, priority: 'P0', refId: alert.id, subjectKey: `old:${alert.id}` }));
    for (const [index, card] of cards.entries()) source.store.table('inbox').patch(card.id, { pushed: true,
      ...(mode === 'all_closed' || (mode === 'latest_closed' ? index === 1 : index === 0)
        ? { status: 'closed', answer: '知道了', answeredAt: now + 10 } : {}) });
    const saved = new FileStore(source.fs, source.clock, '/hub', source.settings.timezone, source.logger);
    for (const row of source.store.table('alerts').list()) saved.table('alerts').put(row);
    for (const row of source.store.table('inbox').list()) saved.table('inbox').put(row);
    await saved.flush();
    const store = new FileStore(source.fs, source.clock, '/hub', source.settings.timezone, source.logger);
    await store.load();
    const ctx = createTestContext({ store, fs: source.fs, clock: source.clock });
    await syncAlertItems(ctx);
    await syncAlertItems(ctx);
    const open = store.table('inbox').list(row => row.status === 'open');
    expect(store.table('alerts').list(row => row.status === 'open')).toHaveLength(1);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ refId: latest.id, title: '中心告警：额度', pushed: true });
    if (mode === 'all_closed') expect(cards.map(row => row.id)).not.toContain(open[0]!.id);
    else expect(open[0]!.id).toBe(cards[mode === 'latest_closed' ? 0 : 1]!.id);
    expect(ctx.host.calls.filter(row => row.method === 'notify')).toHaveLength(mode === 'all_closed' ? 1 : 0);
  });
});

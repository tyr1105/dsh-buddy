/** M11 额度保护的端到端回归：只让真实额度故障开新轮，正常收尾与网络探针失败只刷新保护状态。 */
import { describe, expect, it } from 'vitest';
import { advance, createSimWorld, type SimWorld } from '../src/sim/runner.js';
import { commitBrain, quietBrain, scriptedBrain } from '../src/sim/brains.js';
import type { Brain } from '../src/sim/types.js';

const BOT = 'b_0000000001';
const OTHER = 'b_0000000002';
const MINUTE = 60_000;
const at = (text: string) => Date.parse(`2026-11-${text}+08:00`);

/** 同时核对记录、卡片、线程与通知，防止只修复可见推送而留下重复业务记录。 */
function quotaFacts(world: SimWorld) {
  const alerts = world.store.table('alerts').list(row => row.code === 'quota');
  const cards = world.store.table('inbox').list(row => row.type === 'alert' && alerts.some(alert => alert.id === row.refId));
  return {
    alerts: alerts.map(({ id, episodeId, status, count, firstAt, lastAt }) => ({ id, episodeId, status, count, firstAt, lastAt })),
    cards: cards.map(({ id, refId, status }) => ({ id, refId, status })),
    threads: world.store.log('thread').all().filter(row => row.kind === 'alert' && cards.some(card => card.id === row.refId)),
    pushes: world.host.notifications.filter(row => row.level === 'P0' && row.title === '中心告警：额度'),
  };
}

/** 主人通过真实收件箱入口确认，不能直接改告警状态来掩盖闭卡行为。 */
async function acknowledge(world: SimWorld): Promise<void> {
  const card = world.store.table('inbox').list(row => row.type === 'alert' && row.title === '中心告警：额度' && row.status === 'open')[0]!;
  expect(card).toBeDefined();
  expect(await world.hub.api.answerInbox(card.id, '知道了')).toMatchObject({ ok: true });
  await world.hub.tick();
}

describe('M11 红灯持续期间不重报额度故障', () => {
  it('用量转红并确认后，免打扰内三次主人直聊正常结束不新增告警、卡片、线程或 P0', async () => {
    const world = await createSimWorld({ bots: [{ id: BOT, name: '巡检员', brain: quietBrain }],
      startAt: at('05T21:30:00'), settings: { initialWindowTurnLimit: 2 } });
    for (const text of ['看看今天的日志', '再核对一次']) {
      expect(await world.hub.api.sendMessage(BOT, text)).toMatchObject({ ok: true });
      await world.host.settle();
      await advance(world, MINUTE);
    }
    expect(world.store.table('quota').get('quota')?.light).toBe('red');
    expect(quotaFacts(world).alerts).toHaveLength(1);
    expect(quotaFacts(world).alerts[0]?.count).toBe(1);
    expect(quotaFacts(world).pushes).toHaveLength(1);
    world.clock.advance(5 * MINUTE);
    await acknowledge(world);
    const closed = quotaFacts(world);
    expect(closed.alerts[0]).toMatchObject({ status: 'closed', count: 0 });
    const sessionId = world.store.table('bots').get(BOT)!.sessionId!;
    for (const time of ['05T23:10:00', '05T23:40:00', '06T00:20:00']) {
      world.clock.set(at(time));
      await world.hub.tick();
      await world.hub.onTurnEvent({ type: 'owner_direct', sessionId, at: world.clock.now(), text: '再确认一个问题' });
      world.clock.advance(2 * MINUTE);
      await world.hub.onTurnEvent({ type: 'ended', sessionId, at: world.clock.now(), finalText: '已经回答', tokens: 120 });
      await world.hub.tick();
      expect(quotaFacts(world)).toEqual(closed);
      expect(world.store.table('bots').get(BOT)).toMatchObject({ activity: 'resting', activityText: '额度保护，11月6日 02:35 后继续' });
    }
    expect(world.host.turns.filter(row => row.status === 'error')).toHaveLength(0);
    await world.hub.stop();
  });

  it('甲报 429 并确认后，乙已交账的在途回合正常结束只恢复休息状态', async () => {
    const hang: Brain = async () => ({ hang: true });
    const commitThenHang: Brain = async input => { await commitBrain(input); return { hang: true }; };
    const world = await createSimWorld({ startAt: at('05T22:55:00'),
      bots: [{ id: BOT, name: '甲', brain: hang }, { id: OTHER, name: '乙', brain: commitThenHang }],
      settings: { maxConcurrentThinks: 2, ownerActiveConcurrentThinks: 2 } });
    await world.hub.api.sendMessage(BOT, '检查甲的日志');
    await world.hub.api.sendMessage(OTHER, '检查乙的日志');
    await world.host.settle();
    const firstSession = world.store.table('bots').get(BOT)!.sessionId!;
    const secondSession = world.store.table('bots').get(OTHER)!.sessionId!;
    expect(world.store.table('wakes').list(row => row.endedAt === null)).toHaveLength(2);
    world.clock.advance(2 * MINUTE);
    world.host.sessions.get(firstSession)!.running = false;
    await world.hub.onTurnEvent({ type: 'error', sessionId: firstSession, at: world.clock.now(), errorText: '429 Too Many Requests: rate limit exceeded' });
    world.clock.advance(2 * MINUTE);
    await acknowledge(world);
    const closed = quotaFacts(world);
    world.clock.advance(3 * MINUTE);
    world.host.sessions.get(secondSession)!.running = false;
    await world.hub.onTurnEvent({ type: 'ended', sessionId: secondSession, at: world.clock.now(), finalText: '检查完毕', tokens: 300 });
    await world.hub.tick();
    expect(world.store.table('wakes').list(row => row.botId === OTHER)[0]?.status).toBe('committed');
    expect(world.store.table('bots').get(OTHER)?.activity).toBe('resting');
    expect(quotaFacts(world)).toEqual(closed);
    await world.hub.stop();
  });

  it.each([true, false])('网络错误试运行只延长期限并刷新开放卡，主人已确认=%s 时不新开额度故障', async acknowledged => {
    const world = await createSimWorld({ startAt: at('05T20:00:00'), bots: [{ id: BOT, name: '巡检员',
      brain: scriptedBrain([{ result: { error: '429 Too Many Requests: rate limit' } }, { result: { error: 'read ECONNRESET' } }]) }] });
    await world.hub.api.sendMessage(BOT, '看看日志');
    await world.host.settle();
    await world.hub.tick();
    const firstDeadline = world.store.table('quota').get('quota')!.redUntil!;
    world.clock.advance(3 * MINUTE);
    if (acknowledged) await acknowledge(world);
    const before = quotaFacts(world);
    await world.hub.api.sendMessage(BOT, '恢复后再看一次');
    await advance(world, firstDeadline + 3 * MINUTE - world.clock.now());
    expect(world.store.table('wakes').list().map(row => row.error)).toEqual(['429 Too Many Requests: rate limit', 'read ECONNRESET']);
    expect(world.store.table('quota').get('quota')).toMatchObject({ light: 'red', probeInFlight: false,
      redUntil: firstDeadline + world.settings.quotaWindowMs + world.settings.quotaResetGraceMs });
    expect(quotaFacts(world)).toEqual(before);
    expect(world.store.table('bots').get(BOT)?.activityText).toBe('额度保护，11月6日 06:10 后继续');
    const openCards = world.store.table('inbox').list(row => row.type === 'alert' && row.status === 'open');
    expect(openCards).toHaveLength(acknowledged ? 0 : 1);
    if (!acknowledged) {
      expect(openCards[0]?.body).toBe('额度保护，11月6日 06:10 后继续');
      expect(world.store.table('alerts').list(row => row.code === 'quota')[0]?.text).toBe(openCards[0]?.body);
    }
    await world.hub.stop();
  });

  it('确认后试运行真实再次报 429，仍新建一轮告警、卡片、线程和免打扰 P0', async () => {
    const world = await createSimWorld({ startAt: at('05T20:00:00'), bots: [{ id: BOT, name: '巡检员',
      brain: scriptedBrain([{ result: { error: '429 rate limit' } }, { result: { error: '429 quota exceeded' } }]) }] });
    await world.hub.api.sendMessage(BOT, '看看日志');
    await world.host.settle();
    const deadline = world.store.table('quota').get('quota')!.redUntil!;
    await acknowledge(world);
    const first = quotaFacts(world);
    await world.hub.api.sendMessage(BOT, '恢复后再看一次');
    await advance(world, deadline + MINUTE - world.clock.now());
    const after = quotaFacts(world);
    expect(after.alerts).toHaveLength(2);
    expect(after.alerts[0]).toEqual(first.alerts[0]);
    expect(after.alerts[1]).toMatchObject({ status: 'open', count: 1, firstAt: deadline, lastAt: deadline });
    expect(after.alerts[1]?.episodeId).not.toBe(after.alerts[0]?.episodeId);
    expect(after.cards.map(card => card.status)).toEqual(['closed', 'open']);
    expect(after.threads).toHaveLength(2);
    expect(after.pushes).toHaveLength(2);
    expect(after.pushes[1]?.at).toBe(deadline);
    expect(after.pushes[1]?.body).toBe('额度保护，11月6日 06:10 后继续');
    await world.hub.stop();
  });
});

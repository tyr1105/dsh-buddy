/**
 * M11 额度保护的端到端回归：真实额度故障期间，正常收尾与网络探针失败只刷新保护状态。
 *
 * P76d 修改（整份文件）：额度用完不再建「中心告警：额度」条目、不推送（设计稿场景 E：员工在等，你不用做任何事）。
 * 原来的用例靠「告警记录、条目、线程、P0 推送」四样事实证明「红灯持续期间不重报额度故障」，现在这四样事实本来就应当一直为空，
 * 所以每条用例都改为：同样的剧本、同样的时间点，断言这四样事实始终为空（quotaFacts），员工休息状态与恢复时间的断言保留，文字换成新句子。
 * 另外：原第一条用「回合上限 2」让用量触顶转红；额度灯现在按员工份额的 token 算，主人直聊不进员工份额，所以改用一次真实的 429 报错转红，其余剧本不变。
 * 原第三条的「主人已确认 = true / false」两种参数已无意义（没有条目可确认），合并为一条。
 */
import { describe, expect, it } from 'vitest';
import { advance, createSimWorld, type SimWorld } from '../src/sim/runner.js';
import { commitBrain, quietBrain, scriptedBrain } from '../src/sim/brains.js';
import type { Brain } from '../src/sim/types.js';

const BOT = 'b_0000000001';
const OTHER = 'b_0000000002';
const MINUTE = 60_000;
const at = (text: string) => Date.parse(`2026-11-${text}+08:00`);

/** 同时核对记录、卡片、线程与通知：额度用完这四样都应当一直为空。 */
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
const NONE = { alerts: [], cards: [], threads: [], pushes: [] };

describe('M11 红灯持续期间额度故障不建条目、不推送', () => {
  it('真实额度报错转红后，免打扰内三次主人直聊正常结束不新增告警、卡片、线程或 P0', async () => {
    const world = await createSimWorld({ bots: [{ id: BOT, name: '巡检员',
      brain: scriptedBrain([{ result: { error: '429 quota exceeded' } }, quietBrain]) }], startAt: at('05T21:30:00') });
    expect(await world.hub.api.sendMessage(BOT, '看看今天的日志')).toMatchObject({ ok: true });
    await world.host.settle();
    await advance(world, MINUTE);
    expect(world.store.table('quota').get('quota')?.light).toBe('red');
    expect(quotaFacts(world)).toEqual(NONE);
    world.clock.advance(5 * MINUTE);
    await world.hub.tick();
    const sessionId = world.store.table('bots').get(BOT)!.sessionId!;
    for (const time of ['05T23:10:00', '05T23:40:00', '06T00:20:00']) {
      world.clock.set(at(time));
      await world.hub.tick();
      await world.hub.onTurnEvent({ type: 'owner_direct', sessionId, at: world.clock.now(), text: '再确认一个问题' });
      world.clock.advance(2 * MINUTE);
      await world.hub.onTurnEvent({ type: 'ended', sessionId, at: world.clock.now(), finalText: '已经回答', tokens: 120 });
      await world.hub.tick();
      expect(quotaFacts(world)).toEqual(NONE);
      // 红灯在 11 月 6 日 02:35 解除（首个回合 21:30 开始，加 5 小时 5 分钟）；文字按当前时刻写，跨日带月日。
      expect(world.store.table('bots').get(BOT)).toMatchObject({ activity: 'resting' });
      expect(world.store.table('bots').get(BOT)!.activityText).toMatch(/^在等额度恢复，约 (11月6日 )?02:35 继续$/);
    }
    expect(world.host.turns.filter(row => row.status === 'error')).toHaveLength(1);
    await world.hub.stop();
  });

  it('甲报 429 后，乙已交账的在途回合正常结束只恢复休息状态', async () => {
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
    world.clock.advance(5 * MINUTE);
    expect(quotaFacts(world)).toEqual(NONE);
    world.host.sessions.get(secondSession)!.running = false;
    await world.hub.onTurnEvent({ type: 'ended', sessionId: secondSession, at: world.clock.now(), finalText: '检查完毕', tokens: 300 });
    await world.hub.tick();
    expect(world.store.table('wakes').list(row => row.botId === OTHER)[0]?.status).toBe('committed');
    expect(world.store.table('bots').get(OTHER)?.activity).toBe('resting');
    expect(quotaFacts(world)).toEqual(NONE);
    await world.hub.stop();
  });

  it('网络错误试运行只延长期限、刷新休息文字，不新开任何额度条目', async () => {
    const world = await createSimWorld({ startAt: at('05T20:00:00'), bots: [{ id: BOT, name: '巡检员',
      brain: scriptedBrain([{ result: { error: '429 Too Many Requests: rate limit' } }, { result: { error: 'read ECONNRESET' } }]) }] });
    await world.hub.api.sendMessage(BOT, '看看日志');
    await world.host.settle();
    await world.hub.tick();
    const firstDeadline = world.store.table('quota').get('quota')!.redUntil!;
    world.clock.advance(3 * MINUTE);
    expect(quotaFacts(world)).toEqual(NONE);
    await world.hub.api.sendMessage(BOT, '恢复后再看一次');
    await advance(world, firstDeadline + 3 * MINUTE - world.clock.now());
    expect(world.store.table('wakes').list().map(row => row.error)).toEqual(['429 Too Many Requests: rate limit', 'read ECONNRESET']);
    expect(world.store.table('quota').get('quota')).toMatchObject({ light: 'red', probeInFlight: false,
      redUntil: firstDeadline + world.settings.quotaWindowMs + world.settings.quotaResetGraceMs });
    expect(quotaFacts(world)).toEqual(NONE);
    expect(world.store.table('bots').get(BOT)?.activityText).toBe('在等额度恢复，约 06:10 继续');
    expect(world.store.table('inbox').list(row => row.type === 'alert')).toHaveLength(0);
    await world.hub.stop();
  });

  it('试运行真实再次报 429：仍不建条目、不推送，期限顺延，两次报错都被记录', async () => {
    const world = await createSimWorld({ startAt: at('05T20:00:00'), bots: [{ id: BOT, name: '巡检员',
      brain: scriptedBrain([{ result: { error: '429 rate limit' } }, { result: { error: '429 quota exceeded' } }]) }] });
    await world.hub.api.sendMessage(BOT, '看看日志');
    await world.host.settle();
    const deadline = world.store.table('quota').get('quota')!.redUntil!;
    expect(quotaFacts(world)).toEqual(NONE);
    await world.hub.api.sendMessage(BOT, '恢复后再看一次');
    await advance(world, deadline + MINUTE - world.clock.now());
    expect(quotaFacts(world)).toEqual(NONE);
    const quota = world.store.table('quota').get('quota')!;
    expect(quota.light).toBe('red');
    expect(quota.redUntil!).toBeGreaterThan(deadline);
    expect(world.store.table('quotaWindows').get('quota')!.errors).toHaveLength(2);
    expect(world.store.table('quotaWindows').get('quota')!.errors[1]!.at).toBe(deadline);
    expect(world.store.table('inbox').list(row => row.type === 'alert')).toHaveLength(0);
    await world.hub.stop();
  });
});

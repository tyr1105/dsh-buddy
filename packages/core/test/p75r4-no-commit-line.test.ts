/**
 * P75r4 第 1 节的测试：连续不交账的停用线只管「员工自己发起的回合」。
 *
 * 规则：员工最近结束的 3 个回合，每一个都是「计入范围内的回合」且状态是没有交账，才停用。
 * 不在范围内的回合：主人发起的（含主人消息叫醒、总管）、带事情编号的、带主题编号的、技能类回合（复盘、核对、整理）。
 * 夹在中间的不在范围内的回合、出错的回合、已交账的回合，都不算连续。
 * 全部走真实的回合路径（onTurnEvent 的结束事件），不直接改员工状态。
 */
import { describe, expect, test } from 'vitest';
import { onTurnEvent } from '../src/turn/events.js';
import { processCommit } from '../src/commit/process.js';
import { createTicket } from '../src/wake/ticket.js';
import type { Bot, WakeTicket } from '../src/model/index.js';
import { commitArgs, turnContext } from './c03-turn-fixtures.js';

/** 一个回合的形状：决定它在不在停用线的范围内。 */
type Shape = 'regular' | 'job' | 'topic' | 'owner' | 'skill';
/** 一个回合怎样结束：宿主结束且没交账 / 先交账 / 出错。 */
type Ending = 'no_commit' | 'commit' | 'error';

/** 一位听吩咐的员工（执行类或总管，与真实情况一致）；回合一个接一个跑，第一个沿用夹具里的，后面的各建一张唤醒单。 */
async function crew(patch: Partial<Bot> = { name: '执行员', role: 'executor', onDemand: true }) {
  const made = await turnContext('regular', patch);
  let first = true;
  /** 跑一个回合，返回唤醒单编号。shape 决定这张唤醒单带什么标记；ending 决定怎样结束。 */
  const round = async (shape: Shape, ending: Ending = 'no_commit'): Promise<string> => {
    let wakeId = made.ticket.id;
    if (!first) {
      made.ctx.clock.advance(60_000);
      const next = createTicket(made.ctx, made.entry, made.bot.sessionId);
      made.ctx.store.table('wakes').patch(next.id, { status: 'running', dispatchedAt: made.ctx.clock.now() });
      wakeId = next.id;
    }
    first = false;
    // 给这张唤醒单打上形状标记（创建之后再改，与真实回合里「这张单带着事情编号、主题编号」等价）。
    const wake = made.ctx.store.table('wakes').get(wakeId)!;
    const marks: Partial<WakeTicket> = shape === 'job' ? { jobId: 'job_0000000001' }
      : shape === 'topic' ? { topicId: 'ptp_0000000001' }
        : shape === 'owner' ? { ownerInitiated: true, reason: { ...wake.reason, kind: 'owner_message' } }
          : shape === 'skill' ? { variant: 'reflection', subjectKey: `retro:run_one:${made.bot.id}`, reason: { ...wake.reason, kind: 'reflection' } }
            : {};
    made.ctx.store.table('wakes').patch(wakeId, marks);
    if (ending === 'commit') await processCommit(made.ctx, { botId: made.bot.id, sessionId: made.bot.sessionId!, wakeId }, commitArgs());
    made.ctx.clock.advance(1_000);
    if (ending === 'error') await onTurnEvent(made.ctx, { type: 'error', sessionId: made.bot.sessionId!, at: made.ctx.clock.now(), errorText: '宿主出错' });
    else await onTurnEvent(made.ctx, { type: 'ended', sessionId: made.bot.sessionId!, at: made.ctx.clock.now(), finalText: '', tokens: 10 });
    return wakeId;
  };
  const lifecycle = (): string => made.ctx.store.table('bots').get(made.bot.id)!.lifecycle;
  return { ...made, round, lifecycle };
}

describe('连续不交账的停用线只管员工自己发起的回合（P75r4 第 1 节）', () => {
  test('范围内的常规回合连续 3 个不交账：停用，原因与告警逐字', async () => {
    const { ctx, bot, round, lifecycle } = await crew();
    await round('regular'); await round('regular');
    expect(lifecycle()).toBe('active'); // 前两个还没到线
    await round('regular');
    expect(ctx.store.table('bots').get(bot.id)).toMatchObject({ lifecycle: 'quarantined', quarantineReason: '连续 3 个回合没有交账' });
    // 合并第三块之后同步：停用告警的句子由 P74r16b 统一（job/suspended.ts 的 suspendedAlertText）。
    expect(ctx.store.table('alerts').list().map(row => row.text)).toContain('中心停用了执行员：连续 3 个回合没有交账。');
  });

  // 下面每种范围外的回合：连续 3 个不交账都不停用（档案上的累计数照常增加，但停用线不看它）。
  const outOfScope: Array<[string, Shape]> = [['带事情编号的回合', 'job'], ['带主题编号的回合', 'topic'], ['主人消息叫醒的回合', 'owner'], ['技能类回合（复盘）', 'skill']];
  for (const [label, shape] of outOfScope) {
    test(`${label}连续 3 个不交账：不停用（反例）`, async () => {
      const { ctx, bot, round, lifecycle } = await crew();
      await round(shape); await round(shape); await round(shape);
      expect(lifecycle()).toBe('active');
      expect(ctx.store.table('bots').get(bot.id)!.quarantineReason ?? null).toBeNull();
      expect(ctx.store.table('alerts').list().filter(row => row.text.includes('没有交账'))).toHaveLength(0);
    });
  }

  test('总管被主人消息叫醒的回合连续 3 个不交账：不停用（反例）', async () => {
    const { ctx, bot, round, lifecycle } = await crew({ name: '总管', role: 'chief', onDemand: true });
    await round('owner'); await round('owner'); await round('owner');
    expect(lifecycle()).toBe('active');
    expect(ctx.store.table('alerts').list().filter(row => row.botId === bot.id && row.text.includes('没有交账'))).toHaveLength(0);
  });

  test('两个范围内的不交账，中间夹一个带事情编号的不交账：不停用（反例）', async () => {
    const { round, lifecycle } = await crew();
    await round('regular'); await round('job'); await round('regular');
    expect(lifecycle()).toBe('active');
  });

  test('两个范围内的不交账，中间夹一个出错的回合：不停用（反例）', async () => {
    const { round, lifecycle } = await crew();
    await round('regular'); await round('regular', 'error'); await round('regular');
    expect(lifecycle()).toBe('active');
  });

  test('中间夹一个已交账的回合：不停用；之后再连续 3 个范围内的不交账才停用', async () => {
    const { ctx, bot, round, lifecycle } = await crew();
    await round('regular'); await round('regular'); await round('regular', 'commit');
    expect(lifecycle()).toBe('active');
    await round('regular'); await round('regular');
    expect(lifecycle()).toBe('active');
    await round('regular');
    expect(ctx.store.table('bots').get(bot.id)).toMatchObject({ lifecycle: 'quarantined', quarantineReason: '连续 3 个回合没有交账' });
  });
});

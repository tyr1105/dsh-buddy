/**
 * P76c 每回合的上限的测试（任务卡 4.3、第 6 节第 5、6 条）。
 *
 * 4.3 的大部分在 P76c 之前由第三块的修复卡（P74r11、P74r13）提前做了（一件事里的回合不发收口提醒、总时长保护 60 分钟、
 * 唤醒包里那一句）。本文件负责：
 * 1 核对：一件事里的回合（带 jobId）与员工自己发起的回合，同样的步数、token、时长，前者没有收口提醒（steeredAt 为 null），
 *   后者有提醒（任务卡第 6 节第 5 条第一半）；
 * 2 核对：技能类唤醒（复盘、核对、整理）不带 jobId，所以仍按复盘档收口，没有被「一件事里的回合」的规则误伤；
 * 3 总时长保护的边界：一件事里的回合 59 分钟不判卡住、61 分钟判卡住、10 分钟无事件仍判卡住；其余回合 30 分钟线不变；
 * 4 唤醒包里「本次上限」那一句逐字。
 *
 * 已有同样断言的测试（不重复写）：test/p74r11-chain-turn-limits.test.ts 的第 1 组（真实 Hub 里 50 步、7 万 token、25 分钟没有提醒；
 * 10 分钟无事件被判卡住；59 与 61 分钟的真实 tick 路径）与第 5 组（唤醒包两句）；这里用 50 步、80 万 token、25 分钟更大的数、
 * 直接调用 checkTurnLimits、findStuckWakes 的纯路径，并加上自己发起的回合作对照。
 * 假时钟：每次推进不超过 10 分钟（边界用例直接改唤醒单的时间戳，不推进时钟）。
 */
import { describe, expect, it } from 'vitest';
import { checkTurnLimits, CLOSING_MESSAGE } from '../src/turn/limits.js';
import { findStuckWakes } from '../src/health/deadman.js';
import { buildWakePacket } from '../src/wake/packet.js';
import { enqueueSkillWork } from '../src/skill/enqueue.js';
import { createTicket } from '../src/wake/ticket.js';
import { JOB_DEFAULTS, BUDGET_DEFAULTS } from '../src/config/defaults.js';
import { turnContext } from './c03-turn-fixtures.js';

const MINUTE = 60_000;
const JOB_ID = 'job_0000000001';
const steers = (ctx: Awaited<ReturnType<typeof turnContext>>['ctx']) => ctx.host.calls.filter(call => call.method === 'steer');

describe('1 收口提醒：一件事里的回合不发，自己发起的回合照发', () => {
  it('一件事里的回合 50 步、80 万 token、25 分钟：没有收口提醒，steeredAt 为 null', async () => {
    const { ctx, ticket } = await turnContext();
    ctx.store.table('wakes').patch(ticket.id, { jobId: JOB_ID, steps: 50, tokens: 800_000 });
    // 每次推进不超过 10 分钟，推进的间隙检查一次。
    for (let i = 0; i < 3; i += 1) {
      ctx.clock.advance(i < 2 ? 10 * MINUTE : 5 * MINUTE);
      ctx.store.table('wakes').patch(ticket.id, { lastEventAt: ctx.clock.now() });
      await checkTurnLimits(ctx, ctx.clock.now());
    }
    expect(ctx.clock.now() - ticket.startedAt).toBe(25 * MINUTE);
    expect(steers(ctx)).toEqual([]);
    expect(ctx.store.table('wakes').get(ticket.id)).toMatchObject({ steeredAt: null, status: 'running' });
    expect(ctx.host.calls.some(call => call.method === 'cancel')).toBe(false);
  });

  it('同样的 50 步、80 万 token、25 分钟用在员工自己发起的回合：有收口提醒', async () => {
    const { ctx, ticket } = await turnContext();
    expect(ctx.store.table('wakes').get(ticket.id)!.jobId ?? null).toBeNull();
    ctx.store.table('wakes').patch(ticket.id, { steps: 50, tokens: 800_000 });
    for (let i = 0; i < 3; i += 1) {
      ctx.clock.advance(i < 2 ? 10 * MINUTE : 5 * MINUTE);
      ctx.store.table('wakes').patch(ticket.id, { lastEventAt: ctx.clock.now() });
      await checkTurnLimits(ctx, ctx.clock.now());
    }
    expect(steers(ctx)).toEqual([{ method: 'steer', args: ['session-one', CLOSING_MESSAGE] }]);
    expect(ctx.store.table('wakes').get(ticket.id)!.steeredAt).not.toBeNull();
  });

  it('一件事里的回合到了 token 兜底线（150 万）才提醒一次：兜底线保留', async () => {
    const { ctx, ticket } = await turnContext();
    ctx.store.table('wakes').patch(ticket.id, { jobId: JOB_ID, steps: 50, tokens: JOB_DEFAULTS.CHAIN_TURN_TOKEN_GUARD - 1 });
    await checkTurnLimits(ctx, ctx.clock.now());
    expect(steers(ctx)).toEqual([]);
    ctx.store.table('wakes').patch(ticket.id, { tokens: JOB_DEFAULTS.CHAIN_TURN_TOKEN_GUARD });
    await checkTurnLimits(ctx, ctx.clock.now());
    expect(steers(ctx)).toHaveLength(1);
  });
});

describe('2 技能类唤醒不带 jobId，仍按复盘档收口', () => {
  it('技能类候选（复盘、核对、整理）不带 jobId，由它生成的唤醒单也不带；步数到复盘档的线（20 步）就提醒', async () => {
    const { ctx, bot, ticket } = await turnContext();
    for (const key of [`retro:sr_0000000001:${bot.id}`, `skillcheck:sr_0000000001:${bot.id}`, `tidy:2026-11-16:${bot.id}`]) {
      const entry = enqueueSkillWork(ctx, { runId: 'sr_0000000001', botId: bot.id, key, title: '会员定价页' });
      expect(entry, key).not.toBeNull();
      expect(entry!.jobId ?? null, key).toBeNull();
      expect(entry!.variant).toBe('reflection');
      const made = createTicket(ctx, entry!, 'session-one');
      expect(made.jobId ?? null, key).toBeNull();
      ctx.store.table('queue').remove(entry!.id);
    }
    // 回合上限：把夹具回合改成复盘档的技能类回合，19 步不提醒、20 步提醒。
    ctx.store.table('wakes').patch(ticket.id, { variant: 'reflection', subjectKey: `retro:sr_0000000001:${bot.id}`, steps: 19 });
    await checkTurnLimits(ctx, ctx.clock.now());
    expect(steers(ctx)).toEqual([]);
    ctx.store.table('wakes').patch(ticket.id, { steps: 20 });
    await checkTurnLimits(ctx, ctx.clock.now());
    expect(steers(ctx)).toHaveLength(1);
  });
});

describe('3 总时长保护与无事件超时', () => {
  it('一件事里的回合：59 分钟（一直有事件）不判卡住，61 分钟判卡住；常量是 60 分钟，两处取值一致', async () => {
    const { ctx, ticket } = await turnContext();
    expect(JOB_DEFAULTS.CHAIN_TURN_HARD_MS).toBe(60 * MINUTE);
    expect(BUDGET_DEFAULTS.CHAIN_TURN_HARD_MS).toBe(JOB_DEFAULTS.CHAIN_TURN_HARD_MS);
    const now = ctx.clock.now();
    ctx.store.table('wakes').patch(ticket.id, { jobId: JOB_ID, startedAt: now - 59 * MINUTE, lastEventAt: now - MINUTE });
    expect(findStuckWakes(ctx, now)).toEqual([]);
    ctx.store.table('wakes').patch(ticket.id, { startedAt: now - 61 * MINUTE });
    expect(findStuckWakes(ctx, now).map(row => row.id)).toEqual([ticket.id]);
  });

  it('一件事里的回合：10 分钟没有事件仍判卡住；9 分钟 59 秒不判', async () => {
    const { ctx, ticket } = await turnContext();
    const now = ctx.clock.now();
    ctx.store.table('wakes').patch(ticket.id, { jobId: JOB_ID, startedAt: now - 20 * MINUTE, lastEventAt: now - 10 * MINUTE + 1_000 });
    expect(findStuckWakes(ctx, now)).toEqual([]);
    ctx.store.table('wakes').patch(ticket.id, { lastEventAt: now - 10 * MINUTE });
    expect(findStuckWakes(ctx, now).map(row => row.id)).toEqual([ticket.id]);
  });

  it('其余回合（不带 jobId）总时长线仍是 30 分钟：29 分钟不判，31 分钟判', async () => {
    const { ctx, ticket } = await turnContext();
    const now = ctx.clock.now();
    ctx.store.table('wakes').patch(ticket.id, { startedAt: now - 29 * MINUTE, lastEventAt: now - MINUTE });
    expect(findStuckWakes(ctx, now)).toEqual([]);
    ctx.store.table('wakes').patch(ticket.id, { startedAt: now - 31 * MINUTE });
    expect(findStuckWakes(ctx, now).map(row => row.id)).toEqual([ticket.id]);
  });
});

describe('4 唤醒包「本次上限」那一句', () => {
  it('一件事里的回合逐字：本回合不限步数，做完这一步就交账；超过 60 分钟中心会结束本回合。；其余回合是原句', async () => {
    const { ctx, bot, entry, ticket } = await turnContext();
    const chain = await buildWakePacket(ctx, bot, entry, { ...ticket, jobId: JOB_ID });
    expect(chain).toContain('本回合不限步数，做完这一步就交账；超过 60 分钟中心会结束本回合。');
    expect(chain).not.toContain('到线会被要求收口');
    const plain = await buildWakePacket(ctx, bot, entry, ticket);
    expect(plain).toContain('到线会被要求收口');
    expect(plain).not.toContain('本回合不限步数');
  });
});

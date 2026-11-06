/** 健康规则用假时钟和内存文件验收，覆盖告警确认、停机补课、应醒时刻、卡住边界与四类隔离。 */
import { describe, expect, it } from 'vitest';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { MemoryFs } from '../src/io/testing/memory-fs.js';
import { resolveSettings } from '../src/config/defaults.js';
import type { Downtime, QueueEntry, WakeTicket } from '../src/model/index.js';
import { raiseAlert, closeAlert, maybeWriteHeartbeat, readLastHeartbeat, detectDowntimeOnStart, detectSleep,
  catchUpCandidates, computeExpectedBy, checkDeadman, findStuckWakes, checkQuarantine, quarantine } from '../src/health/index.js';
import { recordUsage } from '../src/quota/usage.js';
import { botFixture, modelFixtures, id } from './model-fixtures.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const setup = () => { const ctx = createTestContext(); ctx.store.table('bots').put({ ...botFixture }); return ctx; };
const alertInput = { code: 'network', botId: botFixture.id, text: '网络不可用', level: 'P2' as const };
const heartbeatPath = '/hub/.hub/heartbeat.json';
function wake(patch: Partial<WakeTicket> = {}): WakeTicket { return { ...(modelFixtures.WakeTicket.valid as WakeTicket), ...patch }; }

describe('告警次数与恢复', () => {
  it('第一次只观测，第二次在同一条告警中 open', () => {
    const ctx = setup(); const first = raiseAlert(ctx, alertInput);
    expect(first).toMatchObject({ count: 1, status: 'closed' });
    expect(raiseAlert(ctx, alertInput)).toMatchObject({ id: first.id, count: 2, status: 'open' });
    expect(ctx.store.table('alerts').list()).toHaveLength(1);
  });
  it('immediate 第一条就 open', () => {
    const ctx = setup(); expect(raiseAlert(ctx, { ...alertInput, immediate: true })).toMatchObject({ count: 1, status: 'open' });
  });
  it('显式观测时间覆盖时钟，非法观测时间拒绝', () => {
    const ctx = setup(); const at = ctx.clock.now() + HOUR;
    expect(raiseAlert(ctx, { ...alertInput, at })).toMatchObject({ firstAt: at, lastAt: at });
    expect(() => raiseAlert(ctx, { ...alertInput, at: 1.5 })).toThrow('at');
  });
  it('一小时内复用记录，恰好一小时后新记录继承次数并关闭旧记录', () => {
    const ctx = setup(); const first = raiseAlert(ctx, alertInput); ctx.clock.advance(HOUR - 1);
    expect(raiseAlert(ctx, alertInput).id).toBe(first.id); ctx.clock.advance(HOUR);
    expect(raiseAlert(ctx, alertInput)).toMatchObject({ count: 3, status: 'open' });
    expect(ctx.store.table('alerts').list()).toHaveLength(2);
    expect(ctx.store.table('alerts').get(first.id)).toMatchObject({ count: 2, status: 'closed' });
  });
  it('两次失败间隔两小时仍在第二次 open，恢复后重新累计', () => {
    const ctx = setup(); const first = raiseAlert(ctx, alertInput); ctx.clock.advance(2 * HOUR);
    const second = raiseAlert(ctx, alertInput);
    expect(second).toMatchObject({ count: 2, status: 'open' });
    expect(second.id).not.toBe(first.id);
    closeAlert(ctx, alertInput.code, alertInput.botId); ctx.clock.advance(2 * HOUR);
    expect(raiseAlert(ctx, alertInput)).toMatchObject({ count: 1, status: 'closed' });
  });
  it('同 code 的不同机器人互不累计', () => {
    const ctx = setup(); raiseAlert(ctx, alertInput);
    expect(raiseAlert(ctx, { ...alertInput, botId: 'another' }).status).toBe('closed');
  });
  it('恢复关闭并重置次数，下一次不继承旧故障', () => {
    const ctx = setup(); raiseAlert(ctx, { ...alertInput, immediate: true }); closeAlert(ctx, alertInput.code, alertInput.botId);
    expect(ctx.store.table('alerts').list()[0]).toMatchObject({ status: 'closed', count: 0 });
    expect(raiseAlert(ctx, alertInput).status).toBe('closed');
  });
  it('非法告警拒绝写入', () => {
    const ctx = setup(); expect(() => raiseAlert(ctx, { ...alertInput, code: '' })).toThrow();
    expect(ctx.store.table('alerts').list()).toHaveLength(0);
  });
});

describe('心跳与停机', () => {
  it('心跳含配置 pid、机器人数量与 running 数量', async () => {
    const ctx = setup(); ctx.settings = resolveSettings({ rootDir: '/hub', heartbeatPid: 123 });
    ctx.store.table('wakes').put(wake());
    expect(await maybeWriteHeartbeat(ctx, ctx.clock.now())).toEqual({ pid: 123, at: ctx.clock.now(), bots: 1, thinking: 1, version: '0.1.0' });
    expect(await readLastHeartbeat(ctx)).toMatchObject({ pid: 123, thinking: 1 });
  });
  it('三十秒前不重写，三十秒整恢复写入', async () => {
    const ctx = setup(); const now = ctx.clock.now(); await maybeWriteHeartbeat(ctx, now);
    expect(await maybeWriteHeartbeat(ctx, now + 29_999)).toBeNull();
    expect(await maybeWriteHeartbeat(ctx, now + 30_000)).toMatchObject({ at: now + 30_000 });
  });
  it('缺失心跳不推断历史停机', async () => {
    const ctx = setup(); expect(await readLastHeartbeat(ctx)).toBeNull();
    expect(await detectDowntimeOnStart(ctx, ctx.clock.now())).toBeNull();
  });
  it('损坏心跳保留原文并记录警告', async () => {
    const ctx = setup(); await ctx.fs.writeTextAtomic(heartbeatPath, '{broken');
    expect(await readLastHeartbeat(ctx)).toBeNull();
    expect(await ctx.fs.readText(heartbeatPath)).toBe('{broken');
    expect(ctx.logger.lines.some(row => row.level === 'warn')).toBe(true);
  });
  it('心跳写入失败不消耗节流机会', async () => {
    class FailingFs extends MemoryFs {
      override async writeTextAtomic(): Promise<void> { throw new Error('写入失败'); }
    }
    const ctx = createTestContext({ fs: new FailingFs() });
    await expect(maybeWriteHeartbeat(ctx, ctx.clock.now())).rejects.toThrow('写入失败');
    expect(ctx.runtime.lastHeartbeatAt).toBeNull();
  });
  it('停机超过两分钟才记录，重复相同证据不重复记录', async () => {
    const ctx = setup(); const now = ctx.clock.now(); await maybeWriteHeartbeat(ctx, now);
    expect(await detectDowntimeOnStart(ctx, now + 2 * MINUTE)).toBeNull();
    const downtime = await detectDowntimeOnStart(ctx, now + 2 * MINUTE + 1);
    expect(downtime).toMatchObject({ from: now, to: now + 2 * MINUTE + 1, kind: 'host_down', handled: false });
    await detectDowntimeOnStart(ctx, now + 2 * MINUTE + 1);
    expect(ctx.store.table('downtime').list()).toHaveLength(1);
  });
  it('睡眠首次 tick 与十分钟整不触发，超过十分钟触发', () => {
    const ctx = setup(); const now = ctx.clock.now();
    expect(detectSleep(ctx, now)).toBeNull();
    expect(detectSleep(ctx, now + 10 * MINUTE)).toBeNull();
    expect(detectSleep(ctx, now + 20 * MINUTE + 1)).toMatchObject({ from: now + 10 * MINUTE, kind: 'sleep' });
  });
});

describe('停机补课', () => {
  function stopped(now: number, duration: number): Downtime { return { id: id('d'), from: now - duration, to: now, kind: 'sleep', handled: false }; }
  it('不足三十分钟不产生补课', () => {
    const ctx = setup(); expect(catchUpCandidates(ctx, stopped(ctx.clock.now(), 30 * MINUTE - 1), ctx.clock.now())).toEqual([]);
  });
  it('三十分钟整只对在岗及试岗机器人生成一次补课', () => {
    const ctx = setup(); const now = ctx.clock.now(); const downtime = stopped(now, 30 * MINUTE);
    ctx.store.table('bots').put({ ...botFixture, id: 'b_0000000002', lifecycle: 'probation' });
    ctx.store.table('bots').put({ ...botFixture, id: 'b_0000000003', lifecycle: 'paused' });
    const candidates = catchUpCandidates(ctx, downtime, now);
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatchObject({ variant: 'catch_up', priority: 30, reason: { kind: 'catch_up', summary: 'DSH 停了 30 分钟，补看期间变化' } });
    expect(catchUpCandidates(ctx, downtime, now)).toEqual([]);
    expect(ctx.store.table('downtime').get(downtime.id)?.handled).toBe(true);
  });
});

describe('死人开关与卡住边界', () => {
  it('取两个应醒来源较早者，加三十分钟宽限', () => {
    expect(computeExpectedBy({ nextThinkAt: 200 }, 100)).toBe(100 + 30 * MINUTE);
    expect(computeExpectedBy({ nextThinkAt: 50 }, 100)).toBe(50 + 30 * MINUTE);
  });
  it('缺少来源不生成时刻，零毫秒是合法来源', () => {
    expect(computeExpectedBy({ nextThinkAt: null }, null)).toBeNull();
    expect(computeExpectedBy({ nextThinkAt: null }, 0)).toBe(30 * MINUTE);
  });
  it('超时第一次告警和 retry，六小时内不重复，整六小时可再检查', () => {
    const ctx = setup(); const now = ctx.clock.now(); ctx.store.table('bots').patch(botFixture.id, { expectedBy: now - 1 });
    expect(checkDeadman(ctx, now)[0]?.reason.kind).toBe('retry');
    expect(ctx.store.table('alerts').list()[0]).toMatchObject({ code: 'deadman', status: 'open', level: 'P1' });
    ctx.clock.advance(6 * HOUR - 1); expect(checkDeadman(ctx, ctx.clock.now())).toEqual([]);
    ctx.clock.advance(1); expect(checkDeadman(ctx, ctx.clock.now())).toHaveLength(1);
  });
  it('应醒时刻整点不提前告警', () => {
    const ctx = setup(); ctx.store.table('bots').patch(botFixture.id, { expectedBy: ctx.clock.now() });
    expect(checkDeadman(ctx, ctx.clock.now())).toEqual([]);
  });
  it('显式 now 前进时六小时限频也按该时刻记账，不依赖同步推进假时钟', () => {
    const ctx = setup(); const now = ctx.clock.now() + HOUR;
    ctx.store.table('bots').patch(botFixture.id, { expectedBy: now - 1 });
    expect(checkDeadman(ctx, now)).toHaveLength(1);
    expect(ctx.store.table('alerts').list()[0]?.lastAt).toBe(now);
    expect(checkDeadman(ctx, now + 6 * HOUR - 1)).toEqual([]);
    expect(checkDeadman(ctx, now + 6 * HOUR)).toHaveLength(1);
    expect(checkDeadman(ctx, now + 6 * HOUR + 1)).toEqual([]);
    expect(ctx.clock.now()).toBe(now - HOUR);
  });
  it.each(['thinking', 'waiting_owner'] as const)('%s 状态不告警', activity => {
    const ctx = setup(); ctx.store.table('bots').patch(botFixture.id, { expectedBy: ctx.clock.now() - 1, activity });
    expect(checkDeadman(ctx, ctx.clock.now())).toEqual([]);
  });
  it('生命周期暂停或已有 running 单据不告警', () => {
    const ctx = setup(); ctx.store.table('bots').patch(botFixture.id, { expectedBy: 1, lifecycle: 'paused' });
    expect(checkDeadman(ctx, ctx.clock.now())).toEqual([]);
    ctx.store.table('bots').patch(botFixture.id, { lifecycle: 'active' }); ctx.store.table('wakes').put(wake());
    expect(checkDeadman(ctx, ctx.clock.now())).toEqual([]);
  });
  it('十分钟无事件整点卡住，之前不卡住', () => {
    const ctx = setup(); const now = ctx.clock.now(); ctx.store.table('wakes').put(wake({ startedAt: now, lastEventAt: now }));
    expect(findStuckWakes(ctx, now + 10 * MINUTE - 1)).toEqual([]);
    expect(findStuckWakes(ctx, now + 10 * MINUTE)).toHaveLength(1);
  });
  it('总时长三十分钟整不卡住，超过就卡住', () => {
    const ctx = setup(); const now = ctx.clock.now(); ctx.store.table('wakes').put(wake({ startedAt: now, lastEventAt: now + 30 * MINUTE }));
    expect(findStuckWakes(ctx, now + 30 * MINUTE)).toEqual([]);
    expect(findStuckWakes(ctx, now + 30 * MINUTE + 1)).toHaveLength(1);
  });
  it('已结束唤醒单不当作卡住', () => {
    const ctx = setup(); ctx.store.table('wakes').put(wake({ status: 'committed', startedAt: 1, lastEventAt: 1 }));
    expect(findStuckWakes(ctx, ctx.clock.now())).toEqual([]);
  });
});

describe('隔离四类条件', () => {
  it('连续三次回合错误隔离，两次不隔离', () => {
    const ctx = setup(); const now = ctx.clock.now();
    ctx.store.table('bots').patch(botFixture.id, { consecutiveErrors: 2 });
    for (let n = 1; n <= 2; n += 1) ctx.store.table('wakes').put(wake({ id: `w_000000000${n}`, status: 'error', endedAt: now - 3 + n }));
    expect(checkQuarantine(ctx, botFixture.id, now)).toBeNull();
    ctx.store.table('wakes').put(wake({ id: 'w_0000000003', status: 'timeout', endedAt: now }));
    ctx.store.table('bots').patch(botFixture.id, { consecutiveErrors: 3 });
    expect(checkQuarantine(ctx, botFixture.id, now)).toContain('连续 3');
  });
  it('成功回合打断连续错误，未结束投递不计错误回合', () => {
    const ctx = setup(); const now = ctx.clock.now();
    ctx.store.table('bots').patch(botFixture.id, { consecutiveErrors: 3 });
    for (let n = 1; n <= 3; n += 1) ctx.store.table('wakes').put(wake({ id: `w_000000000${n}`, status: n === 2 ? 'committed' : 'error', endedAt: now - 3 + n }));
    expect(checkQuarantine(ctx, botFixture.id, now)).toBeNull();
  });
  it('同一会话三次投递失败不冒充三次回合错误', () => {
    const ctx = setup(); const now = ctx.clock.now();
    for (let n = 1; n <= 3; n += 1) ctx.store.table('wakes').put(wake({ id: `w_000000000${n}`,
      sessionId: 'existing-session', status: 'error', endedAt: now - 3 + n, dispatchedAt: null }));
    ctx.store.table('bots').patch(botFixture.id, { consecutiveErrors: 3 });
    expect(checkQuarantine(ctx, botFixture.id, now)).toBeNull();
  });
  it('未来终态不能提前构成连续错误，真实到达结束时间后才纳入', () => {
    const ctx = setup(); const now = ctx.clock.now();
    ctx.store.table('bots').patch(botFixture.id, { consecutiveErrors: 3 });
    for (let n = 1; n <= 3; n += 1) ctx.store.table('wakes').put(wake({ id: `w_000000000${n}`,
      status: 'error', endedAt: now + n }));
    expect(checkQuarantine(ctx, botFixture.id, now)).toBeNull();
    expect(checkQuarantine(ctx, botFixture.id, now + 2)).toBeNull();
    expect(checkQuarantine(ctx, botFixture.id, now + 3)).toContain('连续 3');
  });
  it('未来复盘未交账不触发当前隔离', () => {
    const ctx = setup(); const now = ctx.clock.now();
    ctx.store.table('bots').patch(botFixture.id, { consecutiveNoCommit: 3 });
    ctx.store.table('wakes').put(wake({ variant: 'reflection', status: 'no_commit', endedAt: now + 1 }));
    expect(checkQuarantine(ctx, botFixture.id, now)).toBeNull();
    expect(checkQuarantine(ctx, botFixture.id, now + 1)).toContain('复盘');
  });
  it('第三次越界触发，第二次不触发', () => {
    const ctx = setup(); ctx.store.table('bots').patch(botFixture.id, { violations: 2 });
    expect(checkQuarantine(ctx, botFixture.id, ctx.clock.now())).toBeNull();
    ctx.store.table('bots').patch(botFixture.id, { violations: 3 });
    expect(checkQuarantine(ctx, botFixture.id, ctx.clock.now())).toContain('越界');
  });
  it('两次未交账后复盘仍未交账触发，普通未交账不冒充复盘', () => {
    const ctx = setup(); const now = ctx.clock.now(); ctx.store.table('bots').patch(botFixture.id, { consecutiveNoCommit: 3 });
    ctx.store.table('wakes').put(wake({ variant: 'regular', status: 'no_commit', endedAt: now }));
    expect(checkQuarantine(ctx, botFixture.id, now)).toBeNull();
    ctx.store.table('wakes').patch(id('w'), { variant: 'reflection' });
    expect(checkQuarantine(ctx, botFixture.id, now)).toContain('复盘');
  });
  it('单日 token 三倍预算边界触发，低一 token 不触发', () => {
    const ctx = setup(); const now = ctx.clock.now();
    ctx.store.log('ledger').append({ id: id('le'), who: botFixture.id, wakeId: null, tokens: 749_999, kind: 'other', at: now });
    expect(checkQuarantine(ctx, botFixture.id, now)).toBeNull();
    ctx.store.log('ledger').append({ id: 'le_0000000002', who: botFixture.id, wakeId: null, tokens: 1, kind: 'other', at: now });
    expect(checkQuarantine(ctx, botFixture.id, now)).toContain('三倍预算');
  });
  it('单日回合三倍预算也触发，试岗用减半后的预算', () => {
    const ctx = setup(); const now = ctx.clock.now(); ctx.store.table('bots').patch(botFixture.id, { lifecycle: 'probation' });
    for (let n = 0; n < 8; n += 1) recordUsage(ctx, { botId: botFixture.id, wakeId: `turn-${n}`, tokens: 0, steps: 0, packetBytes: 0 });
    expect(checkQuarantine(ctx, botFixture.id, now)).toBeNull();
    recordUsage(ctx, { botId: botFixture.id, wakeId: 'turn-9', tokens: 0, steps: 0, packetBytes: 0 });
    expect(checkQuarantine(ctx, botFixture.id, now)).toContain('三倍预算');
  });
  it('执行隔离只移除该机器人队列并立即报告 P1', () => {
    const ctx = setup(); const row = modelFixtures.QueueEntry.valid as QueueEntry;
    ctx.store.table('queue').put(row); ctx.store.table('queue').put({ ...row, id: 'q_0000000002', botId: 'another' });
    quarantine(ctx, botFixture.id, '连续错误');
    expect(ctx.store.table('bots').get(botFixture.id)).toMatchObject({ lifecycle: 'quarantined', quarantineReason: '连续错误', retryAt: null });
    expect(ctx.store.table('queue').list()).toHaveLength(1);
    expect(ctx.store.table('alerts').list()[0]).toMatchObject({ status: 'open', level: 'P1', code: 'quarantine' });
  });
  it('空隔离理由拒绝，已隔离不重复计算原因', () => {
    const ctx = setup(); expect(() => quarantine(ctx, botFixture.id, '')).toThrow('不能为空');
    ctx.store.table('bots').patch(botFixture.id, { lifecycle: 'quarantined', violations: 99 });
    expect(checkQuarantine(ctx, botFixture.id, ctx.clock.now())).toBeNull();
  });
  it('显式隔离时间同时写入机器人和告警，不混用环境时钟', () => {
    const ctx = setup(); const now = ctx.clock.now() + HOUR;
    quarantine(ctx, botFixture.id, '连续错误', now);
    expect(ctx.store.table('bots').get(botFixture.id)?.updatedAt).toBe(now);
    expect(ctx.store.table('alerts').list()[0]).toMatchObject({ firstAt: now, lastAt: now });
  });
});

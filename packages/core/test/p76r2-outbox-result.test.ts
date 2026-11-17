/**
 * P76r2 第 1 节的测试：主人批准的普通出站动作（不属于一件事、不在主题里的 run_command），命令运行完之后的结果唤醒，
 * 不算「员工自己发起」：当天名额用完时仍放行、不占当天名额、不计入「连续不交账」；这个回合出错之后的重试同样放行。
 * 到期处理的审批（中心按到期关掉的）不是主人亲手批准的，结果候选不带 ownerDecided，仍被每天上限拦住。
 *
 * 做法：真实 Hub（界面入口 api.decideApproval 批准）、假的命令执行接口、真实快照和闸门。
 * 夹具：员工是 researcher（不是总管、不听吩咐），额度灯为绿，每天上限默认 2，当天已写好 2 个员工自己发起的回合。
 * 启动静默：Hub 刚启动时闸门第 8 步会拦下所有非主人发起的候选，这样批准之后候选留在队列里，不会被 Hub 自己马上派出去；
 * 断言闸门之前把「启动时刻」往前挪，只让第 8 步放行，与要证明的第 6 步（每天上限）无关。
 */
import { describe, expect, it, vi } from 'vitest';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { createHub } from '../src/engine/hub.js';
import type { HubContext } from '../src/engine/context.js';
import type { QueueEntry, WakeTicket } from '../src/model/index.js';
import { createBotHome } from '../src/memory/files.js';
import { submitOutbox, executeReadyOutbox } from '../src/gate/outbox.js';
import { expireApprovals } from '../src/gate/approvals.js';
import { buildSnapshot, evaluateGates } from '../src/scheduler/gates.js';
import { createTicket } from '../src/wake/ticket.js';
import { finishTurn } from '../src/turn/events.js';
import { checkQuarantine } from '../src/health/quarantine.js';
import { isSelfWork, selfWorkUsageToday } from '../src/quota/usage.js';
import { nextLocalTime } from '../src/util/time.js';
import { botFixture } from './model-fixtures.js';
import { addSelfTurns, addWake } from './p76c-fixtures.js';

const MINUTE = 60_000;
const ok = { code: 0, stdout: '已完成', stderr: '', timedOut: false };

async function setup() {
  const ctx = createTestContext();
  const bot = { ...botFixture };
  ctx.store.table('bots').put(bot);
  await createBotHome(ctx, bot);
  await ctx.fs.writeTextAtomic(`${bot.homeDir}/work/x.py`, 'print("x")\n');
  const hub = createHub(ctx);
  await hub.start();
  return { ctx, bot, hub };
}
type Fix = Awaited<ReturnType<typeof setup>>;

/** 提交一条普通出站动作（运行命令），不属于任何一件事。 */
async function submit(fix: Fix) {
  fix.ctx.exec.set('python3', ['work/x.py'], ok);
  return submitOutbox(fix.ctx, fix.bot.id, { kind: 'run_command', payload: { cmd: 'python3', args: ['work/x.py'], cwd: fix.bot.homeDir }, why: '核对任务结果' });
}
/** 这位员工当天自己发起的回合数。 */
const turns = (ctx: HubContext) => selfWorkUsageToday(ctx, botFixture.id, ctx.clock.now()).turns;
/** 真实快照加真实闸门；前提：额度灯为绿、每天上限为默认值 2（断言证明的机制不依赖灯碰巧放行）。 */
function verdict(ctx: HubContext, entry: QueueEntry) {
  const now = ctx.clock.now();
  const snapshot = buildSnapshot(ctx, entry.botId, now, entry.jobId, entry.subjectKey);
  expect(snapshot.quota.light, '前提：额度灯为绿').toBe('green');
  expect(ctx.settings.botDailyTurnBudget, '前提：每天上限').toBe(2);
  expect(snapshot.selfTurnsToday, '前提：当天自己发起的名额已用完').toBeGreaterThanOrEqual(2);
  return evaluateGates(entry, snapshot, now, ctx.settings);
}
/** 结果候选：队列里原因为「审批结果」的那一条。 */
const resultEntry = (ctx: HubContext) => ctx.store.table('queue').list(row => row.botId === botFixture.id && row.reason.kind === 'approval_decided')[0]!;
/** 让第 8 步（启动静默）放行，时钟推进 10 分钟（候选的最早放行时刻不晚于现在）。 */
function pastStartupQuiet(ctx: HubContext): void {
  (ctx.clock as unknown as { advance(ms: number): void }).advance(10 * MINUTE);
  ctx.runtime.startedAt = ctx.clock.now() - 10 * MINUTE;
  ctx.runtime.lastDispatchAt = null;
}
/** 取出之后 deliver 的候选所对应的已投递回合。 */
function deliver(ctx: HubContext, entry: QueueEntry): WakeTicket {
  const ticket = createTicket(ctx, entry, null);
  return ctx.store.table('wakes').patch(ticket.id, { dispatchedAt: ctx.clock.now(), status: 'running' });
}

describe('1 主人批准的普通出站动作：命令运行完之后的结果唤醒', () => {
  async function approvedAndRan() {
    const fix = await setup();
    addSelfTurns(fix.ctx, 2, {}, botFixture.id);
    expect(turns(fix.ctx), '前提：当天已用 2 个名额').toBe(2);
    const row = await submit(fix);
    expect(await fix.hub.api.decideApproval(row.approvalId!, true)).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(fix.ctx.store.table('outbox').get(row.id)!.status).toBe('done'));
    await executeReadyOutbox(fix.ctx);
    return { fix, row };
  }

  it('经界面入口批准、命令运行完：结果候选带 ownerDecided；当天名额已满仍放行；投递之后不占名额，也不算自己发起', async () => {
    const { fix } = await approvedAndRan();
    const entry = resultEntry(fix.ctx);
    expect(entry, '前提：运行完之后排了结果唤醒').toBeDefined();
    expect(entry.ownerDecided).toBe(true);
    expect(isSelfWork(entry, 'researcher')).toBe(false);
    pastStartupQuiet(fix.ctx);
    expect(verdict(fix.ctx, entry)).toEqual({ pass: true });
    const ticket = deliver(fix.ctx, entry);
    expect(ticket.ownerDecided).toBe(true);
    expect(isSelfWork(ticket, 'researcher')).toBe(false);
    expect(turns(fix.ctx), '不占当天名额').toBe(2);
  });

  it('不计入「连续不交账」：连续不交账的这类结果回合，不触发停用', async () => {
    const { fix } = await approvedAndRan();
    const entry = resultEntry(fix.ctx);
    const results = Array.from({ length: fix.ctx.settings.noCommitReflectionCount + 1 }, () =>
      // 回合的归属字段原样取自中心排的结果候选（不手写 ownerDecided），所以没有第 1 节的修复时这条用例会失败。
      addWake(fix.ctx, { status: 'no_commit', reason: entry.reason, subjectKey: entry.subjectKey, ...(entry.ownerDecided ? { ownerDecided: true } : {}) }, botFixture.id));
    expect(checkQuarantine(fix.ctx, botFixture.id, fix.ctx.clock.now(), results.at(-1))).toBeNull();
    // 对照：同样的回合不带 ownerDecided（旧行为）就是员工自己发起的，连续不交账会触发停用。
    for (const wake of results) fix.ctx.store.table('wakes').put({ ...wake, ownerDecided: false });
    expect(checkQuarantine(fix.ctx, botFixture.id, fix.ctx.clock.now(), results.at(-1))).toMatch(/没有交账/);
  });

  it('这个回合出错之后的重试同样放行（带 ownerDecided、不占名额）', async () => {
    const { fix } = await approvedAndRan();
    const entry = resultEntry(fix.ctx);
    pastStartupQuiet(fix.ctx);
    const ticket = deliver(fix.ctx, entry);
    fix.ctx.store.table('queue').remove(entry.id);
    await finishTurn(fix.ctx, ticket.id, fix.ctx.clock.now(), 'error', '连接失败，稍后重试');
    const retry = fix.ctx.store.table('queue').list(row => row.botId === botFixture.id && row.reason.kind === 'retry')[0]!;
    expect(retry, '前提：中心排了重试候选').toBeDefined();
    expect(retry.ownerDecided).toBe(true);
    expect(retry.notBefore - fix.ctx.clock.now()).toBeLessThanOrEqual(10 * MINUTE);
    fix.ctx.clock.advance(retry.notBefore - fix.ctx.clock.now() + 1);
    fix.ctx.runtime.startedAt = fix.ctx.clock.now() - 10 * MINUTE;
    fix.ctx.runtime.lastDispatchAt = null;
    fix.ctx.store.table('bots').patch(botFixture.id, { lastThinkAt: null });
    expect(verdict(fix.ctx, retry)).toEqual({ pass: true });
    const again = deliver(fix.ctx, retry);
    expect(isSelfWork(again, 'researcher')).toBe(false);
    expect(turns(fix.ctx)).toBe(2);
  });

  it('反例：到期处理的审批（不是主人批准的）：结果候选不带 ownerDecided，仍算自己发起，名额已满被每天上限拦住', async () => {
    const fix = await setup();
    const row = await submit(fix);
    // 审批过期要等一整个有效期：时钟直接设到过期之后（跨天），当天的名额在过期之后再写，才算「当天」。
    fix.ctx.clock.advance(fix.ctx.settings.approvalExpiryMs + 1_000);
    await expireApprovals(fix.ctx, fix.ctx.clock.now());
    const entry = resultEntry(fix.ctx);
    expect(entry.ownerDecided).toBeUndefined();
    expect(fix.ctx.store.table('outbox').get(row.id)!.status).not.toBe('done');
    expect(isSelfWork(entry, 'researcher')).toBe(true);
    pastStartupQuiet(fix.ctx);
    addSelfTurns(fix.ctx, 2, {}, botFixture.id);
    expect(verdict(fix.ctx, entry)).toEqual({ pass: false, by: 'daily_cap', until: nextLocalTime('00:00', fix.ctx.clock.now(), fix.ctx.settings.timezone), drop: false });
  });
});

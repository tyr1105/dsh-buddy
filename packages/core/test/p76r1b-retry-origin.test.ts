/**
 * P76r1 小修（主会话裁定之后）的测试。
 *
 * 小修一：重试候选沿用原回合「是不是自己发起」的结论（字段 retryOfSelfWork，true 和 false 都带）。
 *   团队异常信号、发给总管的同伴消息的回合出错后，重试的唤醒原因变成 retry，原来的特征丢失，重试曾被当作总管自己发起的：
 *   被「等主人回答」闸门和每天上限拦住，也被数进名额和「连续不交账」线。现在重试沿用原回合的结论。
 * 小修二：复盘候选里拆出来的审批结果候选（subjectKey 为 approval:deferred:{员工}），证据里有主人亲手批准或拒绝的就带 ownerDecided。
 *
 * 夹具与真实情况一致（总管听吩咐、安静节奏；另有执行员工、不听吩咐的调研员）；每条调度用例写明额度灯为绿、每天上限 2、当天已用名额数。
 */
import { describe, expect, it } from 'vitest';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import type { HubContext } from '../src/engine/context.js';
import type { Bot, QueueEntry, WakeTicket } from '../src/model/index.js';
import { buildCandidate } from '../src/appraisal/think.js';
import { enqueue, mergeRetryOrigin } from '../src/scheduler/queue.js';
import { buildSnapshot, evaluateGates } from '../src/scheduler/gates.js';
import { createInboxItem } from '../src/outreach/inbox.js';
import { decideApproval, expireApprovals, requestApproval } from '../src/gate/approvals.js';
import { createTicket } from '../src/wake/ticket.js';
import { finishTurn } from '../src/turn/events.js';
import { checkQuarantine } from '../src/health/quarantine.js';
import { createDispatcher } from '../src/engine/dispatch.js';
import { createBotHome } from '../src/memory/files.js';
import { isSelfWork, selfWorkUsageToday } from '../src/quota/usage.js';
import { nextLocalTime } from '../src/util/time.js';
import { botFixture } from './model-fixtures.js';
import { addSelfTurns, addWake } from './p76c-fixtures.js';

const MINUTE = 60_000;
const PEER = { kind: 'peer_message' as const, score: 0.6, threshold: 0.5, summary: '执行员向总管报告', evidence: [] as string[] };
const SIGNAL = { subjectKey: 'team_signal:quarantine:b_0000000012', reason: { kind: 'percept' as const, score: 0.6, threshold: 0.5, summary: '某员工被停用', evidence: [] as string[] } };

function world() {
  const ctx = createTestContext();
  ctx.runtime.startedAt = ctx.clock.now() - 10 * MINUTE;
  const base: Bot = { ...botFixture, createdAt: ctx.clock.now(), updatedAt: ctx.clock.now(), lifecycle: 'active' };
  const chief: Bot = { ...base, id: 'b_0000000010', name: '总管', role: 'chief', onDemand: true, pace: 'quiet', homeDir: '/hub/bots/b_0000000010' };
  const executor: Bot = { ...base, id: 'b_0000000011', name: '执行员', role: 'executor', onDemand: true, homeDir: '/hub/bots/b_0000000011' };
  const researcher: Bot = { ...base, id: 'b_0000000012', name: '调研员', role: 'researcher', onDemand: false, homeDir: '/hub/bots/b_0000000012' };
  for (const bot of [chief, executor, researcher]) ctx.store.table('bots').put(bot);
  return { ctx, chief, executor, researcher };
}
type World = ReturnType<typeof world>;

/** 真实快照加真实闸门；断言额度灯为绿、每天上限为默认值 2。 */
function verdict(ctx: HubContext, entry: QueueEntry) {
  const now = ctx.clock.now();
  const snapshot = buildSnapshot(ctx, entry.botId, now, entry.jobId, entry.subjectKey);
  expect(snapshot.quota.light, '前提：额度灯为绿').toBe('green');
  expect(ctx.settings.botDailyTurnBudget, '前提：每天上限').toBe(2);
  return evaluateGates(entry, snapshot, now, ctx.settings);
}
const turns = (ctx: HubContext, botId: string) => selfWorkUsageToday(ctx, botId, ctx.clock.now()).turns;
const running = (ctx: HubContext, botId: string, patch: Partial<WakeTicket> = {}) => addWake(ctx, { status: 'running', endedAt: null, ...patch }, botId);
const askOwner = (ctx: HubContext, botId: string) => createInboxItem(ctx, { botId, type: 'question', title: '用哪个配色', body: '需要你定', options: ['甲', '乙'],
  defaultOption: '甲', priority: 'P1', refId: null, expiresAt: null, subjectKey: 'question:p76r1b' });
const clockSet = (ctx: HubContext, ms: number) => (ctx.clock as unknown as { set(ms: number): void }).set(ms);

/** 结束一个回合（出错）并取出重试候选，再把时钟推到它的最早放行时刻之后；清掉最短思考间隔这道无关的闸门。 */
async function retryOf(ctx: HubContext, botId: string, wake: WakeTicket, status: 'error' | 'timeout' = 'timeout'): Promise<QueueEntry> {
  await finishTurn(ctx, wake.id, ctx.clock.now(), status, '回合没有响应，中心已停止等待并安排重试');
  const entry = ctx.store.table('queue').list(row => row.botId === botId && row.reason.kind === 'retry')[0]!;
  expect(entry, '前提：中心排了重试候选').toBeDefined();
  expect(entry.notBefore - ctx.clock.now()).toBeLessThanOrEqual(10 * MINUTE);
  clockSet(ctx, entry.notBefore + 1);
  ctx.store.table('bots').patch(botId, { lastThinkAt: null });
  return entry;
}
function deliver(ctx: HubContext, entry: QueueEntry): WakeTicket {
  const ticket = createTicket(ctx, entry, null);
  return ctx.store.table('wakes').patch(ticket.id, { dispatchedAt: ctx.clock.now(), status: 'running' });
}

describe('小修一：重试沿用原回合是不是自己发起的结论', () => {
  it('总管处理同伴消息的回合超时后重试：带 retryOfSelfWork 为 false；有开着的提问、名额已满仍放行；不占名额', async () => {
    const w = world();
    const failed = running(w.ctx, w.chief.id, { reason: PEER });
    const retry = await retryOf(w.ctx, w.chief.id, failed);
    expect(retry.retryOfSelfWork).toBe(false);
    askOwner(w.ctx, w.chief.id);
    addSelfTurns(w.ctx, 2, {}, w.chief.id);
    expect(turns(w.ctx, w.chief.id), '前提：当天已用 2 个名额').toBe(2);
    expect(verdict(w.ctx, retry)).toEqual({ pass: true });
    const ticket = deliver(w.ctx, retry);
    expect(isSelfWork(ticket, 'chief')).toBe(false);
    expect(turns(w.ctx, w.chief.id)).toBe(2);
  });

  it('总管处理团队异常信号的回合超时后重试：闸门放行（有开着的提问、名额已满）', async () => {
    const w = world();
    const failed = running(w.ctx, w.chief.id, SIGNAL);
    const retry = await retryOf(w.ctx, w.chief.id, failed);
    expect(retry.retryOfSelfWork).toBe(false);
    askOwner(w.ctx, w.chief.id);
    addSelfTurns(w.ctx, 2, {}, w.chief.id);
    expect(verdict(w.ctx, retry)).toEqual({ pass: true });
  });

  it('这类重试不计入「连续不交账」线：连续 3 个不交账的重试唤醒单不触发停用', () => {
    const w = world();
    const retries = Array.from({ length: 3 }, () => addWake(w.ctx, { status: 'no_commit', retryOfSelfWork: false,
      reason: { kind: 'retry', score: 0.5, threshold: 0.5, summary: '重试', evidence: [] } }, w.chief.id));
    expect(checkQuarantine(w.ctx, w.chief.id, w.ctx.clock.now(), retries.at(-1))).toBeNull();
  });

  it('反例：员工自己发起的回合超时后重试，仍算自己发起的：带 true；有开着的提问被等主人闸门拦住；名额满被每天上限拦住', async () => {
    const w = world();
    addSelfTurns(w.ctx, 1, {}, w.researcher.id);
    const failed = running(w.ctx, w.researcher.id);
    const retry = await retryOf(w.ctx, w.researcher.id, failed);
    expect(retry.retryOfSelfWork).toBe(true);
    expect(turns(w.ctx, w.researcher.id), '前提：当天已用 2 个名额').toBe(2);
    expect(verdict(w.ctx, retry)).toEqual({ pass: false, by: 'daily_cap', until: nextLocalTime('00:00', w.ctx.clock.now(), w.ctx.settings.timezone), drop: false });
    askOwner(w.ctx, w.researcher.id);
    expect(verdict(w.ctx, retry)).toEqual({ pass: false, by: 'waiting_owner', until: null, drop: false });
    // 占名额的规则与原来相同：原回合数过一次，重试不另占。
    expect(turns(w.ctx, w.researcher.id)).toBe(2);
    deliver(w.ctx, retry);
    expect(turns(w.ctx, w.researcher.id)).toBe(2);
  });

  it('旧数据：重试唤醒单没有这一项时，结论与原来相同（照常规规则：自己发起的算，带主人发起的不算）', () => {
    const w = world();
    const retryReason = { kind: 'retry' as const, score: 0.5, threshold: 0.5, summary: '重试', evidence: [] as string[] };
    const plain = addWake(w.ctx, { reason: retryReason }, w.researcher.id);
    const owner = addWake(w.ctx, { reason: retryReason, ownerInitiated: true }, w.researcher.id);
    expect(plain.retryOfSelfWork).toBeUndefined();
    expect(isSelfWork(plain, 'researcher')).toBe(true);
    expect(isSelfWork(owner, 'researcher')).toBe(false);
    expect(turns(w.ctx, w.researcher.id)).toBe(1);
  });

  it('重试的重试沿用同一个结论（false 和 true 各一条）', async () => {
    const w = world();
    const secondOfChief = await retryOf(w.ctx, w.chief.id, running(w.ctx, w.chief.id, { reason: { ...PEER, kind: 'retry' }, retryOfSelfWork: false }));
    expect(secondOfChief.retryOfSelfWork).toBe(false);
    const secondOfOwn = await retryOf(w.ctx, w.researcher.id, running(w.ctx, w.researcher.id, { reason: { ...PEER, kind: 'retry' }, retryOfSelfWork: true }));
    expect(secondOfOwn.retryOfSelfWork).toBe(true);
  });

  it('队列里两条候选合并：有 false 就是 false；没有 false 有 true 就是 true；都没有就不带（纯函数）', () => {
    expect(mergeRetryOrigin(true, false)).toEqual({ retryOfSelfWork: false });
    expect(mergeRetryOrigin(undefined, false)).toEqual({ retryOfSelfWork: false });
    expect(mergeRetryOrigin(true, undefined)).toEqual({ retryOfSelfWork: true });
    expect(mergeRetryOrigin(true, true)).toEqual({ retryOfSelfWork: true });
    expect(mergeRetryOrigin(undefined, undefined)).toEqual({});
  });

  it('队列里两条重试候选真的合并时同样适用：true 加 false 得 false；true 加没有得 true；都没有不带这个键', () => {
    const merged = (a: boolean | undefined, b: boolean | undefined) => {
      const w = world();
      const make = (flag: boolean | undefined) => buildCandidate(w.ctx, { botId: w.researcher.id, kind: 'retry', score: 0.5, summary: '重试', evidence: [],
        ...(flag === undefined ? {} : { retryOfSelfWork: flag }) });
      enqueue(w.ctx, make(a));
      enqueue(w.ctx, make(b));
      const rows = w.ctx.store.table('queue').list(row => row.botId === w.researcher.id);
      expect(rows).toHaveLength(1);
      return rows[0]!;
    };
    expect(merged(true, false).retryOfSelfWork).toBe(false);
    expect(merged(true, undefined).retryOfSelfWork).toBe(true);
    expect('retryOfSelfWork' in merged(undefined, undefined)).toBe(false);
  });
});

describe('小修二：复盘候选里拆出来的审批结果候选', () => {
  /** 与 m11-approval-reflection 的「legacy」写法相同：复盘变体的候选带着审批决定的理由，投递前被拆成独立的审批候选。 */
  async function split(how: 'approve' | 'reject' | 'expire') {
    const ctx = createTestContext();
    ctx.store.table('bots').put({ ...botFixture, lifecycle: 'active', sessionId: null, lastThinkAt: null });
    await createBotHome(ctx, ctx.store.table('bots').get(botFixture.id)!);
    ctx.clock.advance(ctx.settings.startupQuietMs);
    const approval = await requestApproval(ctx, botFixture.id, 'bash', { command: 'curl -X POST https://hooks.example.com/x -d 1' }, 'C', '推送结果');
    if (how === 'expire') {
      ctx.store.table('approvals').patch(approval.id, { expiresAt: ctx.clock.now() + MINUTE });
      ctx.clock.advance(2 * MINUTE);
      await expireApprovals(ctx, ctx.clock.now());
    } else await decideApproval(ctx, approval.id, how === 'approve');
    const decided = ctx.store.table('queue').list()[0]!;
    ctx.store.table('queue').remove(decided.id);
    const reflection = enqueue(ctx, buildCandidate(ctx, { botId: botFixture.id, kind: 'reflection', variant: 'reflection', score: 0.8, summary: '复盘处理方式' }))!;
    ctx.store.table('queue').patch(reflection.id, { reason: decided.reason });
    ctx.clock.advance(ctx.settings.dispatchGapMs);
    await createDispatcher(ctx).pump();
    const entry = ctx.store.table('queue').list(row => row.subjectKey === `approval:deferred:${botFixture.id}`)[0]!;
    expect(entry, '前提：拆出了独立的审批候选').toBeDefined();
    return { ctx, entry };
  }
  /** 把候选放在「刚结束一切回合、当天已用满 2 个名额」的快照上过闸门，只看第 6 步的结论。 */
  function gate(ctx: HubContext, entry: QueueEntry) {
    addSelfTurns(ctx, 2, {}, botFixture.id);
    const now = ctx.clock.now();
    const snapshot = { ...buildSnapshot(ctx, entry.botId, now, entry.jobId, entry.subjectKey), running: false, runningCount: 0 };
    expect(snapshot.selfTurnsToday, '前提：当天已用 2 个名额').toBeGreaterThanOrEqual(2);
    return evaluateGates(entry, snapshot, now, ctx.settings);
  }

  it.each(['approve', 'reject'] as const)('主人亲手%s的：拆出的候选带 ownerDecided，不算自己发起，不被每天上限拦', async how => {
    const { ctx, entry } = await split(how);
    expect(entry.ownerDecided).toBe(true);
    expect(isSelfWork(entry, 'researcher')).toBe(false);
    const result = gate(ctx, entry);
    expect(result.pass || result.by).not.toBe('daily_cap');
  });

  it('到期处理的：不带 ownerDecided，仍算自己发起，名额已满被每天上限拦住', async () => {
    const { ctx, entry } = await split('expire');
    expect(entry.ownerDecided).toBeUndefined();
    expect(isSelfWork(entry, 'researcher')).toBe(true);
    expect(gate(ctx, entry)).toMatchObject({ pass: false, by: 'daily_cap' });
  });
});

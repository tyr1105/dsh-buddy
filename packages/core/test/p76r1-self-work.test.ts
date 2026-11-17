/**
 * P76r1 测试：哪些回合算「员工自己发起的」（独立审查之后的修复）。
 *
 * 对应任务卡 docs/tasks/P76r1-self-work-counting-fixes.md 第 2、3、4、4b 节；审查记录 docs/progress/P76b-c-review.md 第 2 节的复现写成了这里的用例。
 * 夹具与真实情况一致：总管是自动创建的那一位（听吩咐、安静节奏）；执行员工听吩咐；另造一位不听吩咐的调研员，用来测「员工自己发起的工作」。
 * 每条调度用例都写明：额度灯为绿（verdict 里断言）、每天上限是默认值 2（verdict 里断言）、当天已用的名额数（用例里先断言）。
 * 断言拦截原因码和恢复时刻本身，不依赖额度灯碰巧放行或拦下。时间只用注入的假时钟，每次推进不超过 10 分钟。
 *
 * 分组：
 * 1 主人作出决定之后的接续回合（审批）
 * 2 重试沿用原回合的归属，不另占名额
 * 3 团队异常信号、发给总管的同伴消息
 * 4 两条停用线对上述回合的口径
 * 5 用量停用线只在自己发起的回合结束时检查
 * 6 等主人的闸门只拦自己发起的候选
 * 7 额度用完时被打断的回合接着做（4b 第 1 条）
 * 8 橙灯下「主人这一侧」口径一致（4b 第 2 条）
 * 9 全项目只有一处判断
 */
import { describe, expect, it } from 'vitest';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import type { HubContext } from '../src/engine/context.js';
import type { Bot, QueueEntry, WakeTicket } from '../src/model/index.js';
import { resolveSettings } from '../src/config/defaults.js';
import { buildCandidate } from '../src/appraisal/think.js';
import { enqueue } from '../src/scheduler/queue.js';
import { buildSnapshot, evaluateGates } from '../src/scheduler/gates.js';
import { createInboxItem } from '../src/outreach/inbox.js';
import { decideApproval, expireApprovals, requestApproval } from '../src/gate/approvals.js';
import { checkTeamSignals } from '../src/peer/team.js';
import { createTicket } from '../src/wake/ticket.js';
import { finishTurn } from '../src/turn/events.js';
import { checkQuarantine } from '../src/health/quarantine.js';
import { isSelfWork, selfWorkUsageToday } from '../src/quota/usage.js';
import { defaultQuotaPlan, isOwnerSide } from '../src/quota/plan.js';
import { nextLocalTime } from '../src/util/time.js';
import { botFixture } from './model-fixtures.js';
import { addSelfTurns, addWake } from './p76c-fixtures.js';

const MINUTE = 60_000;
const JOB_ID = 'job_0000000001';
const TOPIC_ID = 'ptp_0000000001';
const QUOTA_TEXT = '已达到 5 小时的使用上限';

/** 三位员工：自动创建的总管（听吩咐、安静节奏）、执行员工（听吩咐）、不听吩咐的调研员。 */
function world(settings: Record<string, unknown> = {}) {
  const ctx = createTestContext(Object.keys(settings).length === 0 ? undefined : { settings: resolveSettings({ rootDir: '/hub', ...settings }) });
  ctx.runtime.startedAt = ctx.clock.now() - 10 * MINUTE; // 越过启动静默
  const base: Bot = { ...botFixture, createdAt: ctx.clock.now(), updatedAt: ctx.clock.now(), lifecycle: 'active' };
  const chief: Bot = { ...base, id: 'b_0000000010', name: '总管', role: 'chief', onDemand: true, pace: 'quiet', homeDir: '/hub/bots/b_0000000010' };
  const executor: Bot = { ...base, id: 'b_0000000011', name: '执行员', role: 'executor', onDemand: true, homeDir: '/hub/bots/b_0000000011' };
  const researcher: Bot = { ...base, id: 'b_0000000012', name: '调研员', role: 'researcher', onDemand: false, homeDir: '/hub/bots/b_0000000012' };
  for (const bot of [chief, executor, researcher]) ctx.store.table('bots').put(bot);
  return { ctx, chief, executor, researcher };
}

/** 真实快照加真实闸门；断言额度灯为绿、每天上限为默认值 2（用例写明的前提）。 */
function verdict(ctx: HubContext, entry: QueueEntry, expectBudget = 2) {
  const now = ctx.clock.now();
  const snapshot = buildSnapshot(ctx, entry.botId, now, entry.jobId, entry.subjectKey);
  expect(snapshot.quota.light, '前提：额度灯为绿').toBe('green');
  expect(ctx.settings.botDailyTurnBudget, '前提：每天上限').toBe(expectBudget);
  return evaluateGates(entry, snapshot, now, ctx.settings);
}

/** 放行之后真实建唤醒单并记为已投递（与调度放行同一条路径：createTicket），返回唤醒单。 */
function deliver(ctx: HubContext, entry: QueueEntry): WakeTicket {
  const ticket = createTicket(ctx, entry, null);
  return ctx.store.table('wakes').patch(ticket.id, { dispatchedAt: ctx.clock.now(), status: 'running' });
}

const turns = (ctx: HubContext, botId: string) => selfWorkUsageToday(ctx, botId, ctx.clock.now()).turns;
const queueOf = (ctx: HubContext, botId: string) => ctx.store.table('queue').list(row => row.botId === botId);
const TOMORROW = (ctx: HubContext) => nextLocalTime('00:00', ctx.clock.now(), ctx.settings.timezone);

/** 一个还在运行的回合（用来交给 finishTurn 结束）。 */
function running(ctx: HubContext, botId: string, patch: Partial<WakeTicket> = {}): WakeTicket {
  return addWake(ctx, { status: 'running', endedAt: null, ...patch }, botId);
}

describe('1 主人作出决定之后的接续回合不算自己发起的', () => {
  /** 员工已用满 2 个自己发起的名额，申请一个要审批的动作；返回审批单编号。 */
  async function applied(w: ReturnType<typeof world>) {
    const approval = await requestApproval(w.ctx, w.researcher.id, 'exec', { command: 'git push' }, 'C', '推送');
    addSelfTurns(w.ctx, 2, {}, w.researcher.id);
    expect(turns(w.ctx, w.researcher.id), '前提：当天已用 2 个名额').toBe(2);
    return approval;
  }

  it('主人批准：接续的候选放行，放行后名额仍是 2；候选不是「主人发起」（档位不变）', async () => {
    const w = world();
    const approval = await applied(w);
    await decideApproval(w.ctx, approval.id, true);
    const entry = queueOf(w.ctx, w.researcher.id).find(row => row.reason.kind === 'approval_decided')!;
    expect(entry.ownerInitiated).toBe(false);
    expect(verdict(w.ctx, entry)).toEqual({ pass: true });
    const ticket = deliver(w.ctx, entry);
    expect(isSelfWork(ticket, 'researcher')).toBe(false);
    expect(turns(w.ctx, w.researcher.id)).toBe(2);
  });

  it('主人拒绝：同样放行，名额仍是 2', async () => {
    const w = world();
    const approval = await applied(w);
    await decideApproval(w.ctx, approval.id, false);
    const entry = queueOf(w.ctx, w.researcher.id).find(row => row.reason.kind === 'approval_decided')!;
    expect(verdict(w.ctx, entry)).toEqual({ pass: true });
    deliver(w.ctx, entry);
    expect(turns(w.ctx, w.researcher.id)).toBe(2);
  });

  it('审批被中心按到期处理：候选被每天上限拦到次日 00:00；放行后仍占名额', async () => {
    const w = world();
    const approval = await applied(w);
    w.ctx.store.table('approvals').patch(approval.id, { expiresAt: w.ctx.clock.now() + MINUTE });
    w.ctx.clock.advance(2 * MINUTE);
    await expireApprovals(w.ctx, w.ctx.clock.now());
    expect(w.ctx.store.table('approvals').get(approval.id)!.status).toBe('expired');
    const entry = queueOf(w.ctx, w.researcher.id).find(row => row.reason.kind === 'approval_decided')!;
    expect(verdict(w.ctx, entry)).toEqual({ pass: false, by: 'daily_cap', until: TOMORROW(w.ctx), drop: false });
    deliver(w.ctx, entry);
    expect(turns(w.ctx, w.researcher.id)).toBe(3);
  });

  it('反例：不是审批结果的普通候选在名额已满时照旧被拦', () => {
    const w = world();
    addSelfTurns(w.ctx, 2, {}, w.researcher.id);
    const entry = enqueue(w.ctx, buildCandidate(w.ctx, { botId: w.researcher.id, kind: 'percept', score: 0.95, summary: '资料有变化', subjectKey: 'watch:p76r1' }))!;
    expect(verdict(w.ctx, entry)).toMatchObject({ pass: false, by: 'daily_cap' });
  });
});

describe('2 重试沿用原回合的归属，不另占名额', () => {
  /** 结束一个回合并取出中心排的重试候选，再把假时钟推到它的最早放行时刻之后（退避 2 分钟左右，不超过 10 分钟）。 */
  async function retryOf(ctx: HubContext, botId: string, wake: WakeTicket, status: 'error' | 'timeout' = 'error'): Promise<QueueEntry> {
    await finishTurn(ctx, wake.id, ctx.clock.now(), status, status === 'timeout' ? '回合没有响应，中心已停止等待并安排重试' : '连接重置');
    const entry = queueOf(ctx, botId).find(row => row.reason.kind === 'retry')!;
    expect(entry, '前提：中心排了重试候选').toBeDefined();
    expect(entry.notBefore - ctx.clock.now()).toBeLessThanOrEqual(10 * MINUTE);
    (ctx.clock as unknown as { set(ms: number): void }).set(entry.notBefore + 1);
    // 隔离「最短思考间隔」这一道无关的闸门，让结论只取决于第 6 步。
    ctx.store.table('bots').patch(botId, { lastThinkAt: null });
    return entry;
  }

  it('主人发起的回合出错：重试带着「主人发起」，名额已满也放行，放行后名额不变', async () => {
    const w = world();
    const failed = running(w.ctx, w.researcher.id, { ownerInitiated: true,
      reason: { kind: 'owner_message', score: 1, threshold: 0.5, summary: '主人说', evidence: [] } });
    const retry = await retryOf(w.ctx, w.researcher.id, failed);
    expect(retry.ownerInitiated).toBe(true);
    addSelfTurns(w.ctx, 2, {}, w.researcher.id);
    expect(turns(w.ctx, w.researcher.id), '前提：当天已用 2 个名额').toBe(2);
    expect(verdict(w.ctx, retry)).toEqual({ pass: true });
    deliver(w.ctx, retry);
    expect(turns(w.ctx, w.researcher.id)).toBe(2);
  });

  it('总管为主人派出的回合出错：重试带着「总管派出」，名额已满也放行，放行后名额不变', async () => {
    const w = world();
    const failed = running(w.ctx, w.executor.id, { chiefDispatch: true,
      reason: { kind: 'peer_message', score: 0.7, threshold: 0.5, summary: '总管派活', evidence: [] } });
    const retry = await retryOf(w.ctx, w.executor.id, failed);
    expect(retry.chiefDispatch).toBe(true);
    addSelfTurns(w.ctx, 2, {}, w.executor.id);
    expect(turns(w.ctx, w.executor.id)).toBe(2);
    expect(verdict(w.ctx, retry)).toEqual({ pass: true });
    deliver(w.ctx, retry);
    expect(turns(w.ctx, w.executor.id)).toBe(2);
  });

  it('主题里的回合与一件事里的回合重试：带着原回合的主题编号、事情编号', async () => {
    const w = world();
    const job = await retryOf(w.ctx, w.executor.id, running(w.ctx, w.executor.id, { jobId: JOB_ID, subjectKey: `jobwake:${JOB_ID}:${w.executor.id}` }));
    expect(job).toMatchObject({ jobId: JOB_ID, subjectKey: `jobwake:${JOB_ID}:${w.executor.id}` });
  });

  it('自己发起的回合超时后重试：名额只占 1 个（原回合数过一次，重试不再数）', async () => {
    const w = world();
    const timedOut = running(w.ctx, w.researcher.id);
    expect(turns(w.ctx, w.researcher.id), '前提：超时的原回合已投递，占 1 个名额').toBe(1);
    const retry = await retryOf(w.ctx, w.researcher.id, timedOut, 'timeout');
    expect(retry.ownerInitiated).toBe(false);
    expect(verdict(w.ctx, retry)).toEqual({ pass: true });
    const ticket = deliver(w.ctx, retry);
    expect(ticket.reason.kind).toBe('retry');
    expect(turns(w.ctx, w.researcher.id)).toBe(1);
  });

  it('名额已满时，自己发起的回合的重试仍被每天上限拦到次日（它不占新名额，但不能绕过上限）', async () => {
    const w = world();
    addSelfTurns(w.ctx, 1, {}, w.researcher.id);
    const timedOut = running(w.ctx, w.researcher.id);
    expect(turns(w.ctx, w.researcher.id), '前提：当天已用 2 个名额').toBe(2);
    const retry = await retryOf(w.ctx, w.researcher.id, timedOut, 'timeout');
    expect(verdict(w.ctx, retry)).toEqual({ pass: false, by: 'daily_cap', until: TOMORROW(w.ctx), drop: false });
  });

  it('投递之前被打断的回合不占名额；它的重试回合真正投递之后只占 1 个（不会因为「重试不另占」而一个都不数）', () => {
    const w = world();
    const interrupted = addWake(w.ctx, { status: 'canceled', canceledBy: 'owner', dispatchedAt: null }, w.researcher.id);
    const failedDelivery = addWake(w.ctx, { status: 'error', dispatchedAt: null, sessionId: null }, w.researcher.id);
    expect(turns(w.ctx, w.researcher.id), '投递之前被打断、投递失败的回合都不占名额').toBe(0);
    addWake(w.ctx, { reason: { kind: 'retry', score: 0.5, threshold: 0.5, summary: '重试', evidence: [failedDelivery.id] } }, w.researcher.id);
    expect(turns(w.ctx, w.researcher.id)).toBe(1);
    expect(interrupted.dispatchedAt).toBeNull();
  });
});

describe('3 团队异常信号、发给总管的同伴消息不算总管自己发起的', () => {
  /** 让调研员被停用，真实的 checkTeamSignals 就会给总管排团队信号候选。 */
  function signalForChief(w: ReturnType<typeof world>): QueueEntry {
    w.ctx.store.table('bots').patch(w.researcher.id, { lifecycle: 'quarantined', quarantineReason: '安全保护' });
    checkTeamSignals(w.ctx, w.ctx.clock.now());
    const entry = queueOf(w.ctx, w.chief.id)[0]!;
    expect(entry.subjectKey).toMatch(/^team_signal:/);
    return entry;
  }

  it('总管当天已有 2 个自己发起的回合：团队信号仍放行，放行后名额不变', () => {
    const w = world();
    const signal = signalForChief(w);
    addSelfTurns(w.ctx, 2, {}, w.chief.id);
    expect(turns(w.ctx, w.chief.id), '前提：当天已用 2 个名额').toBe(2);
    expect(verdict(w.ctx, signal)).toEqual({ pass: true });
    deliver(w.ctx, signal);
    expect(turns(w.ctx, w.chief.id)).toBe(2);
  });

  it('发给总管的同伴消息：名额已满仍放行，放行后名额不变', () => {
    const w = world();
    addSelfTurns(w.ctx, 2, {}, w.chief.id);
    const entry = enqueue(w.ctx, buildCandidate(w.ctx, { botId: w.chief.id, kind: 'peer_message', score: 0.6, summary: '执行员向总管报告',
      evidence: ['pc_0000000001'], subjectKey: 'peer:p76r1-report' }), { directed: true })!;
    expect(turns(w.ctx, w.chief.id)).toBe(2);
    expect(verdict(w.ctx, entry)).toEqual({ pass: true });
    deliver(w.ctx, entry);
    expect(turns(w.ctx, w.chief.id)).toBe(2);
  });

  it('反例：普通员工收到同伴消息照旧占名额，名额已满被每天上限拦到次日', () => {
    const w = world();
    addSelfTurns(w.ctx, 2, {}, w.executor.id);
    const entry = enqueue(w.ctx, buildCandidate(w.ctx, { botId: w.executor.id, kind: 'peer_message', score: 0.6, summary: '同伴发来一条消息',
      evidence: ['pc_0000000002'], subjectKey: 'peer:p76r1-plain' }), { directed: true })!;
    expect(verdict(w.ctx, entry)).toEqual({ pass: false, by: 'daily_cap', until: TOMORROW(w.ctx), drop: false });
    deliver(w.ctx, entry);
    expect(turns(w.ctx, w.executor.id)).toBe(3);
  });

  it('反例：总管的其它回合（例如审批被中心按到期处理）仍然算自己发起的', () => {
    const w = world();
    const ticket = addWake(w.ctx, { reason: { kind: 'approval_decided', score: 0.7, threshold: 0.5, summary: '审批到期', evidence: [] } }, w.chief.id);
    expect(isSelfWork(ticket, 'chief')).toBe(true);
  });
});

describe('4 两条停用线对上述四类回合的口径', () => {
  /** 四类不算自己发起的回合，各给一份唤醒单的写法（botId、补丁）。 */
  const CLASSES: Array<[string, (w: ReturnType<typeof world>) => { botId: string; patch: Partial<WakeTicket> }]> = [
    ['主人批准之后的接续回合', w => ({ botId: w.researcher.id, patch: { ownerDecided: true,
      reason: { kind: 'approval_decided', score: 0.7, threshold: 0.5, summary: '主人已批准', evidence: [] } } as Partial<WakeTicket> })],
    ['主人发起的回合的重试', w => ({ botId: w.researcher.id, patch: { ownerInitiated: true,
      reason: { kind: 'retry', score: 0.5, threshold: 0.5, summary: '重试', evidence: [] } } })],
    ['总管收到的团队信号', w => ({ botId: w.chief.id, patch: { subjectKey: 'team_signal:quarantine:b_0000000012' } })],
    ['总管收到的同伴消息', w => ({ botId: w.chief.id, patch: { reason: { kind: 'peer_message', score: 0.6, threshold: 0.5, summary: '同伴消息', evidence: [] } } })],
  ];

  it.each(CLASSES)('%s：连续 3 个不交账不触发停用', (_name, make) => {
    const w = world();
    const { botId, patch } = make(w);
    const wakes = Array.from({ length: w.ctx.settings.noCommitReflectionCount + 1 }, () => addWake(w.ctx, { status: 'no_commit', ...patch }, botId));
    expect(wakes).toHaveLength(3);
    expect(checkQuarantine(w.ctx, botId, w.ctx.clock.now(), wakes.at(-1))).toBeNull();
  });

  it('对照：同样是 3 个不交账，自己发起的回合触发停用', () => {
    const w = world();
    const wakes = addSelfTurns(w.ctx, 3, { status: 'no_commit' }, w.researcher.id);
    expect(checkQuarantine(w.ctx, w.researcher.id, w.ctx.clock.now(), wakes.at(-1))).toBe('连续 3 个回合没有交账');
  });

  it.each(CLASSES)('%s：数量不计入用量停用线（每类 7 个，再加 1 个自己发起的回合结束，仍不停用）', (_name, make) => {
    const w = world();
    const { botId, patch } = make(w);
    for (let i = 0; i < 7; i += 1) addWake(w.ctx, patch, botId);
    const own = addWake(w.ctx, {}, botId);
    expect(turns(w.ctx, botId), '前提：只有 1 个自己发起的回合').toBe(1);
    expect(checkQuarantine(w.ctx, botId, w.ctx.clock.now(), own)).toBeNull();
  });
});

describe('5 用量停用线只在自己发起的回合结束时检查', () => {
  it('升级当天（当天已有 6 个自己发起的回合，上限是 2）：一件事里的回合结束、主人发起的回合结束都不停用；之后闸门不再放行自己发起的候选', () => {
    const w = world();
    addSelfTurns(w.ctx, 6, {}, w.researcher.id);
    const inJob = addWake(w.ctx, { jobId: JOB_ID }, w.researcher.id);
    const byOwner = addWake(w.ctx, { ownerInitiated: true }, w.researcher.id);
    expect(turns(w.ctx, w.researcher.id), '前提：当天已用 6 个名额，上限 2').toBe(6);
    expect(checkQuarantine(w.ctx, w.researcher.id, w.ctx.clock.now(), inJob)).toBeNull();
    expect(checkQuarantine(w.ctx, w.researcher.id, w.ctx.clock.now(), byOwner)).toBeNull();
    const entry = enqueue(w.ctx, buildCandidate(w.ctx, { botId: w.researcher.id, kind: 'percept', score: 0.95, summary: '资料有变化', subjectKey: 'watch:p76r1-upgrade' }))!;
    expect(verdict(w.ctx, entry)).toEqual({ pass: false, by: 'daily_cap', until: TOMORROW(w.ctx), drop: false });
  });

  it('经真实的回合结束入口：一件事里的回合结束不停用，自己发起的回合结束才停用', async () => {
    const w = world();
    addSelfTurns(w.ctx, 6, {}, w.researcher.id);
    await finishTurn(w.ctx, running(w.ctx, w.researcher.id, { jobId: JOB_ID }).id, w.ctx.clock.now(), 'committed');
    expect(w.ctx.store.table('bots').get(w.researcher.id)!.lifecycle).toBe('active');
    await finishTurn(w.ctx, running(w.ctx, w.researcher.id).id, w.ctx.clock.now(), 'committed');
    expect(w.ctx.store.table('bots').get(w.researcher.id)).toMatchObject({ lifecycle: 'quarantined', quarantineReason: '自己发起的回合达到每天上限的 3 倍' });
  });

  it('闸门失灵的情形（第 6 个自己发起的回合结束）：停用，原因逐字；第 5 个不停用', () => {
    const w = world();
    const first = addSelfTurns(w.ctx, 5, {}, w.researcher.id);
    expect(checkQuarantine(w.ctx, w.researcher.id, w.ctx.clock.now(), first.at(-1))).toBeNull();
    const sixth = addWake(w.ctx, {}, w.researcher.id);
    expect(checkQuarantine(w.ctx, w.researcher.id, w.ctx.clock.now(), sixth)).toBe('自己发起的回合达到每天上限的 3 倍');
  });

  it('倍数设置成 4：原因文字写「4 倍」，8 个才停用', () => {
    const w = world({ usageQuarantineMultiplier: 4 });
    const seven = addSelfTurns(w.ctx, 7, {}, w.researcher.id);
    expect(checkQuarantine(w.ctx, w.researcher.id, w.ctx.clock.now(), seven.at(-1))).toBeNull();
    const eighth = addWake(w.ctx, {}, w.researcher.id);
    expect(checkQuarantine(w.ctx, w.researcher.id, w.ctx.clock.now(), eighth)).toBe('自己发起的回合达到每天上限的 4 倍');
  });

  it('每天上限为 0（员工不自己开工）：任何回合结束都不因这条线停用', () => {
    const w = world({ botDailyTurnBudget: 0 });
    const wakes = addSelfTurns(w.ctx, 6, {}, w.researcher.id);
    for (const wake of [...wakes, addWake(w.ctx, { jobId: JOB_ID }, w.researcher.id), addWake(w.ctx, { ownerInitiated: true }, w.researcher.id)]) {
      expect(checkQuarantine(w.ctx, w.researcher.id, w.ctx.clock.now(), wake)).toBeNull();
    }
  });

  it('没有交刚结束的回合时（例如保护文件核对时调用）不检查用量这一支', () => {
    const w = world();
    addSelfTurns(w.ctx, 6, {}, w.researcher.id);
    expect(checkQuarantine(w.ctx, w.researcher.id, w.ctx.clock.now())).toBeNull();
  });
});

describe('6 等主人的闸门只拦自己发起的候选', () => {
  /** 给这位员工开一条给主人的、不到期的提问。 */
  function askOwner(ctx: HubContext, botId: string) {
    createInboxItem(ctx, { botId, type: 'question', title: '用哪个配色', body: '需要你定', options: ['甲', '乙'], defaultOption: '甲',
      priority: 'P1', refId: null, expiresAt: null, subjectKey: 'question:p76r1' });
  }

  it('员工有开着的提问时，总管为主人派给他的活放行（审查记录发现 6 的复现）', () => {
    const w = world();
    askOwner(w.ctx, w.executor.id);
    const dispatched = enqueue(w.ctx, buildCandidate(w.ctx, { botId: w.executor.id, kind: 'peer_message', score: w.ctx.settings.c02.peerSalienceMax,
      summary: '总管派活', evidence: ['pc_0000000002'], subjectKey: 'peer:dispatch', chiefDispatch: true }), { directed: true })!;
    expect(verdict(w.ctx, dispatched)).toEqual({ pass: true });
  });

  it('总管有开着的提问时，团队信号放行', () => {
    const w = world();
    askOwner(w.ctx, w.chief.id);
    w.ctx.store.table('bots').patch(w.researcher.id, { lifecycle: 'quarantined', quarantineReason: '安全保护' });
    checkTeamSignals(w.ctx, w.ctx.clock.now());
    const signal = queueOf(w.ctx, w.chief.id)[0]!;
    expect(verdict(w.ctx, signal)).toEqual({ pass: true });
  });

  it('总管有开着的提问时，发给总管的同伴消息放行', () => {
    const w = world();
    askOwner(w.ctx, w.chief.id);
    const entry = enqueue(w.ctx, buildCandidate(w.ctx, { botId: w.chief.id, kind: 'peer_message', score: 0.6, summary: '执行员报告',
      evidence: ['pc_0000000003'], subjectKey: 'peer:p76r1-r' }), { directed: true })!;
    expect(verdict(w.ctx, entry)).toEqual({ pass: true });
  });

  it('主人决定之后的接续回合放行（审批结果）', async () => {
    const w = world();
    const approval = await requestApproval(w.ctx, w.researcher.id, 'exec', { command: 'git push' }, 'C', '推送');
    askOwner(w.ctx, w.researcher.id);
    await decideApproval(w.ctx, approval.id, true);
    const entry = queueOf(w.ctx, w.researcher.id).find(row => row.reason.kind === 'approval_decided')!;
    expect(verdict(w.ctx, entry)).toEqual({ pass: true });
  });

  it('员工自己发起的候选仍被拦，恢复时刻为空', () => {
    const w = world();
    askOwner(w.ctx, w.researcher.id);
    const entry = enqueue(w.ctx, buildCandidate(w.ctx, { botId: w.researcher.id, kind: 'percept', score: 0.6, summary: '资料有变化', subjectKey: 'watch:p76r1-ask' }))!;
    expect(verdict(w.ctx, entry)).toEqual({ pass: false, by: 'waiting_owner', until: null, drop: false });
  });

  it('员工普通同伴消息（不是总管派的）在他有开着的提问时仍被拦', () => {
    const w = world();
    askOwner(w.ctx, w.executor.id);
    const entry = enqueue(w.ctx, buildCandidate(w.ctx, { botId: w.executor.id, kind: 'peer_message', score: 0.6, summary: '同伴消息',
      evidence: ['pc_0000000004'], subjectKey: 'peer:p76r1-plain-ask' }), { directed: true })!;
    expect(verdict(w.ctx, entry)).toEqual({ pass: false, by: 'waiting_owner', until: null, drop: false });
  });
});

describe('7 额度用完时被打断的回合接着做（4b 第 1 条）', () => {
  const SUMMARY = '额度用完，恢复后继续上一轮的事';
  const owner = { kind: 'owner_message' as const, score: 1, threshold: 0.5, summary: '主人说', evidence: [] as string[] };

  async function interrupted(w: ReturnType<typeof world>, botId: string, patch: Partial<WakeTicket>) {
    const wake = running(w.ctx, botId, patch);
    await finishTurn(w.ctx, wake.id, w.ctx.clock.now(), 'error', QUOTA_TEXT);
    return queueOf(w.ctx, botId);
  }

  it('主人发来消息叫醒的回合：重排一条候选，带「主人发起」，理由逐字，不按出错退避，最早放行时刻是恢复时刻', async () => {
    const w = world();
    const entries = await interrupted(w, w.researcher.id, { ownerInitiated: true, reason: owner });
    const quota = w.ctx.store.table('quota').get('quota')!;
    expect(quota.light).toBe('red');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ ownerInitiated: true, notBefore: quota.redUntil });
    expect(entries[0]!.reason).toMatchObject({ kind: 'retry', summary: SUMMARY });
    expect(w.ctx.store.table('bots').get(w.researcher.id)).toMatchObject({ consecutiveErrors: 0, retryAt: null });
  });

  it('主题里的回合：重排一条候选，带主题编号', async () => {
    const w = world();
    const entries = await interrupted(w, w.executor.id, { topicId: TOPIC_ID });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ topicId: TOPIC_ID });
    expect(entries[0]!.reason.summary).toBe(SUMMARY);
  });

  it('一件事里的回合：重排一条候选，带事情编号', async () => {
    const w = world();
    const entries = await interrupted(w, w.executor.id, { jobId: JOB_ID });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ jobId: JOB_ID, subjectKey: `jobwake:${JOB_ID}:${w.executor.id}` });
    expect(entries[0]!.reason.summary).toBe(SUMMARY);
  });

  it('员工自己发起的回合被打断：队列为空（恢复后由新的理由产生）', async () => {
    const w = world();
    expect(await interrupted(w, w.researcher.id, {})).toHaveLength(0);
  });

  it('主人在宿主会话里直聊的回合被打断：队列为空（没有消息线程在等回复）', async () => {
    const w = world();
    expect(await interrupted(w, w.researcher.id, { ownerInitiated: true, ownerDirect: true, reason: owner })).toHaveLength(0);
  });

  it('同一位员工被打断的回合只重排一条（不重复）', async () => {
    const w = world();
    await interrupted(w, w.researcher.id, { ownerInitiated: true, reason: owner });
    const entries = await interrupted(w, w.researcher.id, { ownerInitiated: true, reason: owner });
    expect(entries).toHaveLength(1);
  });
});

describe('8 橙灯下「主人这一侧」的口径与别处一致（4b 第 2 条）', () => {
  /** 橙灯：窗口起点在一小时前、容量 100 万、员工份额已用 56 万（与 P76d 的闸门测试同一写法）。 */
  function orange(w: ReturnType<typeof world>) {
    const now = w.ctx.clock.now();
    const windowStartAt = now - 60 * MINUTE;
    w.ctx.store.table('quota').put({ id: 'quota' as const, windowStartAt, botTurns: 0, botTokens: 0, turnLimit: 40, tokenLimit: null, light: 'orange' as const,
      redUntil: null, probeAllowed: false, lastError: null, lastErrorAt: null } as never);
    w.ctx.store.table('quotaWindows').put({ ...defaultQuotaPlan(now, windowStartAt), capacityTokens: 1_000_000, staffTokens: 560_000 });
    return windowStartAt + w.ctx.settings.quotaWindowMs;
  }
  const candidate = (w: ReturnType<typeof world>, extra: Record<string, unknown>) => enqueue(w.ctx, buildCandidate(w.ctx,
    { botId: w.researcher.id, kind: 'percept', score: 0.6, summary: '资料有变化', subjectKey: 'watch:p76r1-orange', ...extra } as never))!;
  const light = (w: ReturnType<typeof world>, entry: QueueEntry) => {
    const now = w.ctx.clock.now();
    const snapshot = buildSnapshot(w.ctx, entry.botId, now, entry.jobId, entry.subjectKey);
    expect(snapshot.quota.light, '前提：额度灯为橙').toBe('orange');
    return evaluateGates(entry, snapshot, now, w.ctx.settings);
  };

  it('主题里的候选（带主题编号、不带主人发起）在橙灯时放行', () => {
    const w = world();
    orange(w);
    expect(light(w, candidate(w, { topicId: TOPIC_ID }))).toEqual({ pass: true });
  });

  it('反例：员工自己发起的候选在橙灯时仍等到窗口结束', () => {
    const w = world();
    const windowEnd = orange(w);
    expect(light(w, candidate(w, {}))).toEqual({ pass: false, by: 'quota', until: windowEnd, drop: false });
  });

  it('记账口径不变：主题回合记在主人一侧，员工自己发起的记在员工一侧', () => {
    const w = world();
    expect(isOwnerSide(addWake(w.ctx, { topicId: TOPIC_ID }, w.researcher.id))).toBe(true);
    expect(isOwnerSide(addWake(w.ctx, {}, w.researcher.id))).toBe(false);
  });
});

describe('9 一个判断，候选和唤醒单共用', () => {
  it('同一份字段，候选和唤醒单得到同一个结论', () => {
    const w = world();
    const fields: Array<Partial<WakeTicket>> = [{}, { ownerInitiated: true }, { chiefDispatch: true }, { jobId: JOB_ID }, { topicId: TOPIC_ID }, { variant: 'teach' }];
    for (const patch of fields) {
      const wake = addWake(w.ctx, patch, w.researcher.id);
      const entry = { ...buildCandidate(w.ctx, { botId: w.researcher.id, kind: 'percept', score: 0.9, summary: '资料有变化', subjectKey: 'watch:p76r1-shared',
        ...(patch.ownerInitiated ? { ownerInitiated: true } : {}), ...(patch.chiefDispatch ? { chiefDispatch: true } : {}),
        ...(patch.jobId ? { jobId: patch.jobId } : {}), ...(patch.topicId ? { topicId: patch.topicId } : {}),
        ...(patch.variant ? { variant: patch.variant } : {}) }), id: 'q_0000000001', enqueuedAt: 0 } as QueueEntry;
      expect(isSelfWork(entry, 'researcher'), JSON.stringify(patch)).toBe(isSelfWork(wake, 'researcher'));
    }
  });
});

/**
 * P74c 的测试：执行链唤醒的闸门规则（方案 7.2）。每条规则一正一反：
 * 正例是带 jobId 的候选放行（或按新规则拦下），反例是不带 jobId 的同类候选仍照旧被拦。
 * 全部走真实 Hub（真实的启动整理、真实的显著性数值），时间用注入的假时钟；不用人为调高分值的候选。
 * 预算类的用量写进真实的账本（botUsageToday 读的就是它），不是改快照里的数字。
 */
import { describe, expect, it } from 'vitest';
import { raiseAlert } from '../src/health/alerts.js';
import { createInboxItem } from '../src/outreach/inbox.js';
import { onQuotaError } from '../src/quota/window.js';
import { enqueueJobWake } from '../src/job/chain.js';
import { applyJobAction } from '../src/job/state.js';
import { capSubjectKey } from '../src/job/cap.js';
import { buildSnapshot, evaluateGates } from '../src/scheduler/gates.js';
import type { QueueEntry } from '../src/model/index.js';
import type { Job } from '../src/model/job.js';
import { MINUTE, assigned, entriesOf, jobFix, tick, wakesOf, type JobFix } from './p74c-fixtures.js';
import { addSelfTurns } from './p76c-fixtures.js';

/** 候选的纯闸门判断（用该候选自己的 jobId 取快照）。 */
function verdict(fix: JobFix, entry: QueueEntry, patch: Record<string, unknown> = {}) {
  const now = fix.ctx.clock.now();
  const snapshot = { ...buildSnapshot(fix.ctx, entry.botId, now, entry.jobId), ...patch };
  return evaluateGates(entry, snapshot as never, now, fix.ctx.settings);
}

/** 同类候选，但不属于任何一件事（去掉 jobId，换一个普通的事项键）。 */
function withoutJob(entry: QueueEntry): QueueEntry {
  const { jobId: _ignored, ...rest } = entry;
  return { ...rest, subjectKey: 'peer:x' };
}

/**
 * 派活之后的场景：10 分钟已过（越过启动静默和全局放行间隔），主人离开超过 10 分钟（允许两位同时思考），
 * 总管的回合仍开着。返回这件事和林舟的那条候选。
 */
async function scene(fix: JobFix) {
  const { job } = await assigned(fix);
  fix.ctx.clock.advance(10 * MINUTE);
  fix.ctx.runtime.ownerActiveAt = fix.ctx.clock.now() - 11 * MINUTE;
  return { job, entry: entriesOf(fix, fix.engineer.id, job.id)[0]! };
}

/** 结束总管此刻开着的回合（只改唤醒单的终态，不触发调度），让总管自己的候选不被「同一员工并发」拦住。 */
function endChiefTurn(fix: JobFix): void {
  for (const row of fix.ctx.store.table('wakes').list(item => item.botId === fix.chief.id && item.status === 'running')) {
    fix.ctx.store.table('wakes').patch(row.id, { status: 'committed', endedAt: fix.ctx.clock.now() });
  }
}

/** 把这件事改成给定状态（直接写表；状态机本身另有测试）。 */
function setJob(fix: JobFix, job: Job, patch: Partial<Job>): Job {
  return fix.ctx.store.table('jobs').patch(job.id, patch);
}

describe('1 越过「最短思考间隔」', () => {
  it('林舟 5 分钟前刚思考过：带 jobId 的候选放行；不带的同类候选被最短间隔拦住', async () => {
    const fix = await jobFix();
    const { entry } = await scene(fix);
    fix.ctx.store.table('bots').patch(fix.engineer.id, { lastThinkAt: fix.ctx.clock.now() - 5 * MINUTE });
    expect(verdict(fix, entry)).toEqual({ pass: true });
    expect(verdict(fix, withoutJob(entry))).toMatchObject({ pass: false, by: 'pace_min' });
  });

  it('同一事项冷却同样越过：这位员工刚被同一事项叫醒过，带 jobId 的放行，不带的被冷却拦住', async () => {
    const fix = await jobFix();
    const { entry } = await scene(fix);
    const now = fix.ctx.clock.now();
    const subjectWakeAt = new Map([[entry.subjectKey, now - MINUTE], ['peer:x', now - MINUTE]]);
    expect(verdict(fix, entry, { subjectWakeAt })).toEqual({ pass: true });
    expect(verdict(fix, withoutJob(entry), { subjectWakeAt })).toMatchObject({ pass: false, by: 'cooldown' });
  });
});

describe('2 评审员（调研节奏）', () => {
  it('评审甲 10 分钟前思考过：to_review 候选放行；不带 jobId 的同类候选被最短间隔拦住', async () => {
    const fix = await jobFix();
    const { job } = await scene(fix);
    setJob(fix, job, { state: 'checking', stage: 1, round: 1 });
    const checking = fix.ctx.store.table('jobs').get(job.id)!;
    fix.ctx.store.table('bots').patch(fix.reviewer.id, { lastThinkAt: fix.ctx.clock.now() - 10 * MINUTE });
    const entry = enqueueJobWake(fix.ctx, { job: checking, botId: fix.reviewer.id, why: 'to_review', eventId: null, summary: '请核对「会员定价页」' })!;
    expect(entry).toMatchObject({ jobId: job.id, subjectKey: `jobwake:${job.id}:${fix.reviewer.id}`, reason: { kind: 'peer_message', ownerSummary: '等待核对' } });
    expect(verdict(fix, entry)).toEqual({ pass: true });
    expect(verdict(fix, withoutJob(entry))).toMatchObject({ pass: false, by: 'pace_min' });
  });
});

describe('3 「等主人」只看这一件事', () => {
  it('总管有别的事的「待你处理」提问开着：这件事的 escalate 候选放行；不带 jobId 的总管候选被拦', async () => {
    const fix = await jobFix();
    const { job } = await scene(fix);
    const blocked = applyJobAction(fix.ctx.store.table('jobs').get(job.id)!, { type: 'block', kind: 'executor', no: null, text: '缺少接口文档' }, fix.ctx.clock.now());
    fix.ctx.store.table('jobs').put(blocked);
    endChiefTurn(fix);
    // 别的事的提问（普通提问：有默认选项、会到期）。
    createInboxItem(fix.ctx, { botId: fix.chief.id, type: 'question', title: '周报发给谁', body: '需要你定', options: ['全员', '管理层'], defaultOption: '管理层', subjectKey: 'question:other' });
    const entry = enqueueJobWake(fix.ctx, { job: blocked, botId: fix.chief.id, why: 'escalate', eventId: null, summary: '林舟做不下去' })!;
    expect(verdict(fix, entry)).toEqual({ pass: true });
    // P76r1 同步（第 4 节口径变化）：「等主人」闸门只拦员工自己发起的候选，发给总管的同伴消息不再被拦，
    // 所以原来用「去掉 jobId 的同伴消息」当对照不再成立；原意（不带 jobId 的、总管自己发起的候选被拦）改用议程到期的候选来证明。
    expect(verdict(fix, { ...withoutJob(entry), reason: { ...entry.reason, kind: 'agenda_due' } })).toMatchObject({ pass: false, by: 'waiting_owner' });
  });

  it('同一件事自己有 job:<id>: 条目开着时被拦，保留候选（不丢弃）；条目关闭后放行', async () => {
    const fix = await jobFix();
    const { job } = await scene(fix);
    const blocked = applyJobAction(fix.ctx.store.table('jobs').get(job.id)!, { type: 'block', kind: 'executor', no: null, text: '缺少接口文档' }, fix.ctx.clock.now());
    fix.ctx.store.table('jobs').put(blocked);
    endChiefTurn(fix);
    const entry = enqueueJobWake(fix.ctx, { job: blocked, botId: fix.chief.id, why: 'escalate', eventId: null, summary: '林舟做不下去' })!;
    const item = createInboxItem(fix.ctx, { botId: fix.chief.id, type: 'question', title: '会员定价页：核对三轮未通过', body: '请选择', options: ['办法一', '办法二'],
      defaultOption: null, expiresAt: null, subjectKey: `job:${job.id}:review_limit` });
    expect(verdict(fix, entry)).toMatchObject({ pass: false, by: 'waiting_owner', drop: false });
    fix.ctx.store.table('inbox').patch(item.id, { status: 'answered', answer: '办法一', answeredAt: fix.ctx.clock.now() });
    expect(verdict(fix, entry)).toEqual({ pass: true });
  });
});

// P76c：本组原来证明「执行链候选越过员工自主预算（每日回合、25 万 token、每日思考上限）」。员工自己发起的工作现在只剩一条上限
// （每天自己发起的回合数），所以三条用例改为：自己发起的回合到上限时执行链候选照样放行、不带 jobId 的被 daily_cap 拦；
// token 再多对两者都不拦（这条线已取消）；快照里的数字再大，执行链仍越过。
describe('4 越过员工自己发起的回合上限', () => {
  it('林舟当天已有 2 个自己发起的回合：带 jobId 的候选放行；不带的被 daily_cap 拦', async () => {
    const fix = await jobFix();
    const { entry } = await scene(fix);
    const now = fix.ctx.clock.now();
    // 真实唤醒单：当天 2 个自己发起的回合（默认每天上限 2）。
    addSelfTurns(fix.ctx, 2, {}, fix.engineer.id);
    const snapshot = buildSnapshot(fix.ctx, fix.engineer.id, now, entry.jobId);
    expect(snapshot.selfTurnsToday).toBe(2);
    expect(verdict(fix, entry)).toEqual({ pass: true });
    // 不带 jobId 的同类候选被每天上限拦住。
    expect(verdict(fix, withoutJob(entry))).toMatchObject({ pass: false, by: 'daily_cap' });
  });

  it('只是 token 很多（自己发起的回合数没到）：带 jobId 的放行，不带的也不再被拦（按 token 的线已取消）', async () => {
    const fix = await jobFix();
    const { entry } = await scene(fix);
    fix.ctx.store.log('ledger').append({ id: 'le_0000000001', who: fix.engineer.id, wakeId: null, tokens: 2_600_000, kind: 'turn',
      at: fix.ctx.clock.now() - MINUTE, ownerInitiated: false });
    expect(verdict(fix, entry)).toEqual({ pass: true });
    expect(verdict(fix, withoutJob(entry))).not.toMatchObject({ by: 'bot_budget' });
    expect(verdict(fix, withoutJob(entry))).not.toMatchObject({ by: 'daily_cap' });
  });

  it('每天上限（daily_cap）同样越过', async () => {
    const fix = await jobFix();
    const { entry } = await scene(fix);
    expect(verdict(fix, entry, { selfTurnsToday: 100 })).toEqual({ pass: true });
    expect(verdict(fix, withoutJob(entry), { selfTurnsToday: 100 })).toMatchObject({ pass: false, by: 'daily_cap' });
  });
});

describe('5 回合上限与已不需要的唤醒', () => {
  it('turnsUsed = turnCap：被 job_cap 丢弃；还剩一个回合时放行', async () => {
    const fix = await jobFix();
    const { job, entry } = await scene(fix);
    setJob(fix, job, { turnsUsed: job.turnCap - 1 });
    expect(verdict(fix, entry)).toEqual({ pass: true });
    setJob(fix, job, { turnsUsed: job.turnCap });
    expect(verdict(fix, entry)).toMatchObject({ pass: false, by: 'job_cap', drop: true });
  });

  it('这件事已完成、已停止、等你验收：被 job_inactive 丢弃；执行中放行', async () => {
    const fix = await jobFix();
    const { job, entry } = await scene(fix);
    expect(verdict(fix, entry)).toEqual({ pass: true });
    for (const state of ['done', 'stopped', 'awaiting_owner'] as const) {
      setJob(fix, job, { state, blocked: null });
      expect(verdict(fix, entry), state).toMatchObject({ pass: false, by: 'job_inactive', drop: true });
    }
  });

  it('已完成但在发布准备或等发布审批：不丢弃', async () => {
    const fix = await jobFix();
    const { job, entry } = await scene(fix);
    setJob(fix, job, { state: 'done', launchStep: true, launch: { state: 'preparing', approvalId: null, link: null } });
    expect(verdict(fix, entry)).toEqual({ pass: true });
    setJob(fix, job, { launch: { state: 'declined', approvalId: null, link: null } });
    expect(verdict(fix, entry)).toMatchObject({ pass: false, by: 'job_inactive' });
  });

  it('员工不是这件事的参与者（执行者、核对人、总管之外）：被 job_inactive 丢弃', async () => {
    const fix = await jobFix(['小周']);
    const { job } = await scene(fix);
    const stranger = enqueueJobWake(fix.ctx, { job, botId: fix.extras[0]!.id, why: 'continue', eventId: null, summary: '接着做' })!;
    expect(verdict(fix, stranger)).toMatchObject({ pass: false, by: 'job_inactive', drop: true });
  });

  it('这件事受阻时，总管的候选放行，别的员工的旧候选被丢弃', async () => {
    const fix = await jobFix();
    const { job, entry } = await scene(fix);
    const blocked = applyJobAction(fix.ctx.store.table('jobs').get(job.id)!, { type: 'block', kind: 'executor', no: null, text: '缺少接口文档' }, fix.ctx.clock.now());
    fix.ctx.store.table('jobs').put(blocked);
    expect(verdict(fix, entry)).toMatchObject({ pass: false, by: 'job_inactive', drop: true });
    const chiefEntry = enqueueJobWake(fix.ctx, { job: blocked, botId: fix.chief.id, why: 'escalate', eventId: null, summary: '林舟做不下去' })!;
    endChiefTurn(fix);
    expect(verdict(fix, chiefEntry)).toEqual({ pass: true });
  });
});

describe('6 全局保护不被执行链绕过（逐项：带 jobId 的候选照常被拦）', () => {
  it('额度灯红、橙；鉴权失败', async () => {
    const fix = await jobFix();
    const { entry } = await scene(fix);
    const now = fix.ctx.clock.now();
    const base = buildSnapshot(fix.ctx, fix.engineer.id, now, entry.jobId);
    expect(verdict(fix, entry, { quota: { ...base.quota, light: 'red', probeAllowed: false, redUntil: now + 60 * MINUTE } })).toMatchObject({ pass: false, by: 'quota' });
    // 依据：P74 合并裁定（橙灯放行带 jobId 的执行链候选，红灯与鉴权失败仍拦）。原先这里断言橙灯被拦。
    expect(verdict(fix, entry, { quota: { ...base.quota, light: 'orange' } })).toEqual({ pass: true });
    expect(verdict(fix, entry, { authBlocked: true })).toMatchObject({ pass: false, by: 'quota' });
  });

  it('启动静默、全局放行间隔、重试退避', async () => {
    const fix = await jobFix();
    const { entry } = await scene(fix);
    const now = fix.ctx.clock.now();
    expect(verdict(fix, entry, { startedAt: now - MINUTE })).toMatchObject({ pass: false, by: 'startup_quiet' });
    expect(verdict(fix, entry, { lastDispatchAt: now - 1_000 })).toMatchObject({ pass: false, by: 'dispatch_gap' });
    expect(verdict(fix, entry, { retryAt: now + 10 * MINUTE })).toMatchObject({ pass: false, by: 'retry_backoff' });
  });

  it('同一员工并发、全局并发上限', async () => {
    const fix = await jobFix();
    const { entry } = await scene(fix);
    expect(verdict(fix, entry, { running: true })).toMatchObject({ pass: false, by: 'concurrency', drop: false });
    expect(verdict(fix, entry, { runningCount: 99 })).toMatchObject({ pass: false, by: 'concurrency', drop: false });
  });

  it('员工停用、归档：丢弃（原因 paused）', async () => {
    const fix = await jobFix();
    const { entry } = await scene(fix);
    const bot = fix.ctx.store.table('bots').get(fix.engineer.id)!;
    expect(verdict(fix, entry, { bot: { ...bot, lifecycle: 'paused' } })).toMatchObject({ pass: false, by: 'paused', drop: true });
    expect(verdict(fix, entry, { bot: { ...bot, lifecycle: 'retired', archivedAt: fix.ctx.clock.now() } })).toMatchObject({ pass: false, by: 'paused', drop: true });
  });

  it('真实调度：鉴权失败、额度红灯时，执行链候选留在队列里，不产生回合', async () => {
    const fix = await jobFix();
    const { job, entry } = await scene(fix);
    // 总管结束回合，别的闸门都放行；只留鉴权这一道。
    fix.ctx.store.table('wakes').list(row => row.botId === fix.chief.id && row.status === 'running')
      .forEach(row => fix.ctx.store.table('wakes').patch(row.id, { status: 'committed', endedAt: fix.ctx.clock.now() }));
    raiseAlert(fix.ctx, { code: 'auth', botId: null, text: '宿主鉴权失败，等待主人确认后恢复', level: 'P0', immediate: true, at: fix.ctx.clock.now() });
    await tick(fix, 1_000);
    expect(wakesOf(fix, fix.engineer.id, job.id)).toHaveLength(0);
    expect(entriesOf(fix, fix.engineer.id, job.id).map(row => row.id)).toEqual([entry.id]);
    // 解除鉴权后，红灯同样拦住。
    for (const alert of fix.ctx.store.table('alerts').list(row => row.code === 'auth')) fix.ctx.store.table('alerts').patch(alert.id, { status: 'closed' });
    onQuotaError(fix.ctx, fix.ctx.clock.now());
    await tick(fix, 1_000);
    expect(wakesOf(fix, fix.engineer.id, job.id)).toHaveLength(0);
    expect(entriesOf(fix, fix.engineer.id, job.id)).toHaveLength(1);
  });

  it('事项键与回合上限条目约定：job:<id>:cap:<上限> 属于这件事', () => {
    expect(capSubjectKey('job_0000000001', 16)).toBe('job:job_0000000001:cap:16');
  });
});

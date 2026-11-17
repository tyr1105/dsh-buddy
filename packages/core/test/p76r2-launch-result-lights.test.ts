/**
 * P76r2 第 8 节第 5 处：批准发布之后，命令运行完的结果唤醒（叫醒执行者：发布命令已成功运行），在额度各种情形下的处理。
 * 审查记录原文：发布结果唤醒走 enqueueJobWake（带 jobId），属执行链：不受每天上限；橙灯放行；员工份额用完、你自己要用、真实额度用完时
 * 推迟到恢复时刻（设计如此，不丢弃）。这一处此前没有任何额度相关的断言。
 *
 * 四种情形各一条：
 * - 橙灯：放行（执行者立刻被叫醒）；
 * - 员工份额用完（红灯）、你自己要用（「我接下来 N 小时要用」）、真实额度用完（红灯、等探针）：不被叫醒、候选不丢弃、闸门写明等到恢复时刻；
 *   到恢复时刻之后放行（员工份额用完：窗口结束；你自己要用：截止时刻；真实额度用完：恢复时刻放出的探针回合就是这条候选）。
 *
 * 走真实路径：有发布步骤的事验收、执行者提交发布命令、主人批准（界面入口）、假的命令执行接口成功；额度各灯直接写额度记录与额度状态
 * （容量 100 万，员工份额比例默认 0.7）；时间用注入的假时钟，推进每次不超过 10 分钟，到恢复时刻的直接设到目标时刻。
 */
import { describe, expect, it } from 'vitest';
import { executeReadyOutbox } from '../src/gate/outbox.js';
import { buildSnapshot, evaluateGates } from '../src/scheduler/gates.js';
import { defaultQuotaPlan, getQuotaPlan, savePlan } from '../src/quota/plan.js';
import type { QueueEntry } from '../src/model/index.js';
import type { QuotaPlan } from '../src/model/quota-plan.js';
import { entriesOf, wakesOf } from './p74c-fixtures.js';
import { tick, MINUTE, type JobFix } from './p74f-fixtures.js';
import { acceptedWithLaunch, submitLaunch } from './p74g-launch-fixtures.js';

const HOUR = 60 * MINUTE;
const OK = { code: 0, stdout: '已上线', stderr: '', timedOut: false };
/** 发布命令成功之后叫醒执行者的原因（逐字）。 */
const OK_WAKE = '发布命令已成功运行，这件事已记为已发布。发布之后有可以访问的网址时，调用 hub_job_work，mode 写 launched，link 写网址；没有网址就直接交账收尾。';

type Light = 'orange' | 'staff_full' | 'owner_hold' | 'exhausted';

/** 把额度各灯写成要的样子：容量 100 万；窗口从现在开始；其余用量清零。返回恢复时刻（等待型情形用）。 */
function setLight(fix: JobFix, light: Light): number {
  const ctx = fix.ctx;
  const now = ctx.clock.now();
  const windowEnd = now + ctx.settings.quotaWindowMs;
  const base: QuotaPlan = { ...defaultQuotaPlan(now), ...getQuotaPlan(ctx, now), capacityTokens: 1_000_000, capacitySource: 'calibrated' as const,
    windowStartAt: now, staffTokens: 0, ownerTokens: 0, staffTurns: 0, ownerTurns: 0, exhausted: null, ownerHoldUntil: null, borrowJobIds: [] };
  const state = { ...(ctx.store.table('quota').get('quota') ?? { id: 'quota' as const, botTurns: 0, botTokens: 0, turnLimit: 40, tokenLimit: null, lastError: null, lastErrorAt: null }),
    id: 'quota' as const, windowStartAt: now, light: 'green' as 'green' | 'orange' | 'red', redUntil: null as number | null, probeAllowed: false, probeInFlight: false, probeWakeId: null };
  let recover = 0;
  if (light === 'orange') { base.staffTokens = 750_000; state.light = 'orange'; }
  else if (light === 'staff_full') { base.staffTokens = 700_000; state.light = 'red'; state.redUntil = windowEnd; recover = windowEnd; }
  else if (light === 'owner_hold') { base.ownerHoldUntil = now + 2 * HOUR; recover = base.ownerHoldUntil; }
  else {
    base.exhausted = { at: now, resetAt: now + HOUR, resetFromText: true };
    state.light = 'red'; state.redUntil = now + HOUR + ctx.settings.quotaResetGraceMs; recover = state.redUntil;
  }
  savePlan(ctx, base);
  ctx.store.table('quota').put(state as never);
  return recover;
}

/** 有发布步骤的事：执行者提交发布命令、额度灯设好、主人在界面批准、命令运行完。返回这件事、候选所在的环境。 */
async function scene(light: Light) {
  const { fix, job } = await acceptedWithLaunch();
  const { approval } = await submitLaunch(fix);
  const recover = setLight(fix, light);
  fix.ctx.exec.set('node', ['work/go-live.js'], OK);
  expect(await fix.hub.api.decideApproval(approval.id, true)).toMatchObject({ ok: true });
  await executeReadyOutbox(fix.ctx);
  return { fix, job, recover };
}
const wakesWithResult = (fix: JobFix, jobId: string) => wakesOf(fix, fix.engineer.id, jobId).filter(row => row.reason.summary === OK_WAKE);
const queuedResult = (fix: JobFix, jobId: string): QueueEntry[] => entriesOf(fix, fix.engineer.id, jobId).filter(row => row.reason.summary === OK_WAKE);
/** 候选的闸门判断（真实快照）。 */
function gate(fix: JobFix, entry: QueueEntry) {
  const now = fix.ctx.clock.now();
  const snapshot = buildSnapshot(fix.ctx, entry.botId, now, entry.jobId, entry.subjectKey);
  return { snapshot, result: evaluateGates(entry, snapshot, now, fix.ctx.settings) };
}

describe('8.5 批准发布之后的结果唤醒在额度各灯下', () => {
  it('橙灯：放行，执行者被叫醒一次', async () => {
    const { fix, job } = await scene('orange');
    expect(buildSnapshot(fix.ctx, fix.engineer.id, fix.ctx.clock.now()).quota.light, '前提：橙灯').toBe('orange');
    await tick(fix, 5 * MINUTE);
    expect(wakesWithResult(fix, job.id)).toHaveLength(1);
    expect(queuedResult(fix, job.id)).toHaveLength(0);
  });

  it('员工份额用完：推迟到窗口结束，不丢弃；窗口结束之后放行', async () => {
    const { fix, job, recover } = await scene('staff_full');
    const queued = queuedResult(fix, job.id);
    expect(queued, '前提：结果唤醒已排队').toHaveLength(1);
    const { snapshot, result } = gate(fix, queued[0]!);
    expect(snapshot.redKind, '前提：员工份额用完').toBe('staff_full');
    expect(result).toEqual({ pass: false, by: 'quota', until: recover, drop: false });
    await tick(fix, 5 * MINUTE);
    expect(wakesWithResult(fix, job.id)).toHaveLength(0);
    expect(queuedResult(fix, job.id)).toHaveLength(1);
    fix.ctx.clock.set(recover);
    await fix.hub.tick();
    expect(wakesWithResult(fix, job.id)).toHaveLength(1);
    expect(queuedResult(fix, job.id)).toHaveLength(0);
  });

  it('你自己要用（「我接下来 N 小时要用」）：推迟到截止时刻，不丢弃；截止之后放行', async () => {
    const { fix, job, recover } = await scene('owner_hold');
    const queued = queuedResult(fix, job.id);
    expect(queued).toHaveLength(1);
    const { snapshot, result } = gate(fix, queued[0]!);
    expect(snapshot.quota.light, '前提：灯是绿的，只是你自己要用').toBe('green');
    expect(snapshot.ownerHoldUntil).toBe(recover);
    expect(result).toEqual({ pass: false, by: 'quota', until: recover, drop: false });
    await tick(fix, 5 * MINUTE);
    expect(wakesWithResult(fix, job.id)).toHaveLength(0);
    expect(queuedResult(fix, job.id)).toHaveLength(1);
    fix.ctx.clock.set(recover);
    await fix.hub.tick();
    expect(wakesWithResult(fix, job.id)).toHaveLength(1);
    expect(queuedResult(fix, job.id)).toHaveLength(0);
  });

  it('真实额度用完：推迟到恢复时刻，不丢弃；恢复时刻放出的探针回合就是这条候选', async () => {
    const { fix, job, recover } = await scene('exhausted');
    const queued = queuedResult(fix, job.id);
    expect(queued).toHaveLength(1);
    const { snapshot, result } = gate(fix, queued[0]!);
    expect(snapshot.redKind, '前提：真实额度用完').toBe('exhausted');
    expect(result).toEqual({ pass: false, by: 'quota', until: recover, drop: false });
    await tick(fix, 5 * MINUTE);
    expect(wakesWithResult(fix, job.id)).toHaveLength(0);
    expect(queuedResult(fix, job.id)).toHaveLength(1);
    fix.ctx.clock.set(recover);
    await fix.hub.tick();
    expect(fix.ctx.store.table('quota').get('quota')).toMatchObject({ probeInFlight: true });
    expect(wakesWithResult(fix, job.id)).toHaveLength(1);
    expect(queuedResult(fix, job.id)).toHaveLength(0);
  });
});

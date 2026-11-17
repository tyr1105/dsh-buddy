/**
 * P74a 状态机验收：任务卡第 6 节动作表逐行一个正例；每个动作至少一个非法起点；
 * done、stopped 是终态；hold 只对回合用到上限有效；每次动作产出的新记录仍满足 JobSchema。
 */
import { describe, expect, it } from 'vitest';
import { applyJobAction, JOB_ACTION_LABELS, type JobAction, type JobActionType } from '../src/job/state.js';
import { JobSchema, type JobState } from '../src/model/job.js';
import { NOW, jobFixture } from './p74a-job-fixtures.js';

const T = NOW + 60_000; // 动作发生的时间
const unmet = [{ no: 2, problem: '刷新后数据没变', fixTo: '点刷新后列表时间更新' }];
const blockedJob = (kind: 'review_limit' | 'executor' | 'turn_cap' | 'owner_hold' | 'participant_off', resumeTo: 'ready' | 'doing' | 'checking' | 'rework') =>
  jobFixture({ state: 'blocked', blocked: { kind, no: null, text: '原因', since: NOW, resumeTo } });

/** 每次动作后的结果都必须仍是合法的一件事。 */
function run(job: ReturnType<typeof jobFixture>, action: JobAction) {
  const next = applyJobAction(job, action, T);
  expect(JobSchema.safeParse(next).success, JSON.stringify(JobSchema.safeParse(next).error?.issues)).toBe(true);
  expect(next.updatedAt).toBe(T);
  return next;
}

describe('动作表：每行一个正例', () => {
  it('start：待开工 → 执行中，记开工时间', () => {
    const next = run(jobFixture({ state: 'ready', startedAt: null }), { type: 'start' });
    expect(next).toMatchObject({ state: 'doing', startedAt: T });
  });
  it('submit：执行中、返工中 → 核对中，轮数加 1，清待改条目', () => {
    expect(run(jobFixture({ state: 'doing', round: 0 }), { type: 'submit' })).toMatchObject({ state: 'checking', round: 1, unmet: [] });
    expect(run(jobFixture({ state: 'rework', round: 1, unmet }), { type: 'submit' })).toMatchObject({ state: 'checking', round: 2, unmet: [] });
  });
  it('submit：轮数已用满时报错', () => {
    expect(() => applyJobAction(jobFixture({ state: 'rework', round: 3, unmet }), { type: 'submit' }, T)).toThrow(/已经交回 3 轮，达到上限 3 轮/);
  });
  it('review_pass：核对中 → 待你验收，记交付时间', () => {
    expect(run(jobFixture({ state: 'checking', round: 1 }), { type: 'review_pass' })).toMatchObject({ state: 'awaiting_owner', deliveredAt: T });
  });
  it('review_fail：核对中且不到第 3 轮 → 返工中，写入待改条目', () => {
    const next = run(jobFixture({ state: 'checking', round: 2 }), { type: 'review_fail', unmet });
    expect(next).toMatchObject({ state: 'rework', unmet, round: 2 });
  });
  it('review_fail：第 3 轮不能退回（要走三轮不过）；待改条目不能为空', () => {
    expect(() => applyJobAction(jobFixture({ state: 'checking', round: 3 }), { type: 'review_fail', unmet }, T)).toThrow(/只能走「三轮不过」/);
    expect(() => applyJobAction(jobFixture({ state: 'checking', round: 1 }), { type: 'review_fail', unmet: [] }, T)).toThrow(/至少一条/);
  });
  it('review_limit：核对中且正好第 3 轮 → 受阻（核对三轮未通过），受阻前回到返工', () => {
    const next = run(jobFixture({ state: 'checking', round: 3 }), { type: 'review_limit', no: 2, text: '第 2 条三轮没过' });
    expect(next).toMatchObject({ state: 'blocked', blocked: { kind: 'review_limit', no: 2, text: '第 2 条三轮没过', since: T, resumeTo: 'rework' } });
  });
  it('review_limit：不到第 3 轮不行', () => {
    expect(() => applyJobAction(jobFixture({ state: 'checking', round: 2 }), { type: 'review_limit', no: null, text: '不过' }, T)).toThrow(/才交回 2 轮/);
  });
  it('owner_accept：待你验收 → 已完成，记验收时间', () => {
    expect(run(jobFixture({ state: 'awaiting_owner', deliveredAt: NOW }), { type: 'owner_accept' })).toMatchObject({ state: 'done', acceptedAt: T });
  });
  it('owner_return：待你验收 → 返工中，阶段加 1，轮数归零，写入待改条目', () => {
    const next = run(jobFixture({ state: 'awaiting_owner', stage: 1, round: 2, deliveredAt: NOW }), { type: 'owner_return', unmet });
    expect(next).toMatchObject({ state: 'rework', stage: 2, round: 0, unmet });
    expect(() => applyJobAction(jobFixture({ state: 'awaiting_owner' }), { type: 'owner_return', unmet: [] }, T)).toThrow(/至少一条/);
  });
  it.each(['ready', 'doing', 'checking', 'rework'] as const)('block：%s → 受阻，resumeTo 记下原状态', from => {
    const next = run(jobFixture({ state: from, round: from === 'checking' ? 1 : 0, unmet: from === 'rework' ? unmet : [] }),
      { type: 'block', kind: 'executor', no: null, text: '做不下去' });
    expect(next.blocked).toEqual({ kind: 'executor', no: null, text: '做不下去', since: T, resumeTo: from });
  });
  it('block：原因只能是 executor、turn_cap、participant_off', () => {
    for (const kind of ['executor', 'turn_cap', 'participant_off'] as const) {
      expect(run(jobFixture(), { type: 'block', kind, no: null, text: '原因' }).blocked?.kind).toBe(kind);
    }
    expect(() => applyJobAction(jobFixture(), { type: 'block', kind: 'review_limit' as never, no: null, text: '原因' }, T)).toThrow(/不能直接标记/);
    expect(() => applyJobAction(jobFixture(), { type: 'block', kind: 'owner_hold' as never, no: null, text: '原因' }, T)).toThrow(/不能直接标记/);
  });
  it.each(['ready', 'doing', 'checking', 'rework'] as const)('unblock：受阻 → 回到 %s，清受阻', resumeTo => {
    const next = run(blockedJob('executor', resumeTo), { type: 'unblock' });
    expect(next).toMatchObject({ state: resumeTo, blocked: null });
  });
  it('hold：回合用到上限的受阻 → 改为你让先停下，其余不变', () => {
    const job = blockedJob('turn_cap', 'doing');
    const next = run(job, { type: 'hold' });
    expect(next.state).toBe('blocked');
    expect(next.blocked).toEqual({ ...job.blocked, kind: 'owner_hold' });
  });
  it.each(['review_limit', 'executor', 'owner_hold', 'participant_off'] as const)('hold：只对 turn_cap 有效，%s 不行', kind => {
    expect(() => applyJobAction(blockedJob(kind, 'rework'), { type: 'hold' }, T)).toThrow(/只有「回合用到上限」的受阻才能选择暂停/);
  });
  it('option_recheck：受阻 → 核对中，阶段加 1，轮数为 1，清受阻', () => {
    const next = run(blockedJob('review_limit', 'rework'), { type: 'option_recheck' });
    expect(next).toMatchObject({ state: 'checking', stage: 2, round: 1, blocked: null });
  });
  it('option_deliver：受阻 → 待你验收，阶段加 1，轮数为 1，记交付时间，清受阻', () => {
    const next = run(jobFixture({ ...blockedJob('review_limit', 'rework'), round: 3 }), { type: 'option_deliver' });
    expect(next).toMatchObject({ state: 'awaiting_owner', stage: 2, round: 1, deliveredAt: T, blocked: null });
  });
  it('review_limit_exit（P74r6）：受阻 → 返工中，阶段加 1、轮数归零、写入待改条目；或核对中、第 1 轮；三轮不过不能直接 unblock', () => {
    const rework = run(jobFixture({ ...blockedJob('review_limit', 'rework'), round: 3 }), { type: 'review_limit_exit', to: 'rework', unmet });
    expect(rework).toMatchObject({ state: 'rework', stage: 2, round: 0, blocked: null, unmet });
    expect(run(jobFixture({ ...blockedJob('review_limit', 'rework'), round: 3 }), { type: 'review_limit_exit', to: 'checking' }))
      .toMatchObject({ state: 'checking', stage: 2, round: 1, blocked: null, unmet: [] });
    expect(() => run(blockedJob('review_limit', 'rework'), { type: 'review_limit_exit', to: 'rework', unmet: [] })).toThrow('至少一条');
    expect(() => run(blockedJob('review_limit', 'rework'), { type: 'unblock' })).toThrow('review_limit_exit');
  });
  it.each(['ready', 'doing', 'checking', 'rework', 'awaiting_owner'] as const)('stop：%s → 已停止，记停止时间', from => {
    expect(run(jobFixture({ state: from }), { type: 'stop' })).toMatchObject({ state: 'stopped', stoppedAt: T, blocked: null });
  });
  it('stop：受阻 → 已停止，并清掉受阻', () => {
    expect(run(blockedJob('owner_hold', 'doing'), { type: 'stop' })).toMatchObject({ state: 'stopped', stoppedAt: T, blocked: null });
  });
  it('动作不改入参', () => {
    const job = jobFixture({ state: 'ready' });
    const snapshot = structuredClone(job);
    applyJobAction(job, { type: 'start' }, T);
    expect(job).toEqual(snapshot);
  });
});

describe('非法起点：每个动作至少一个反例，错误说清当前状态和允许的起点', () => {
  const actions: Record<JobActionType, JobAction> = {
    start: { type: 'start' }, submit: { type: 'submit' }, review_pass: { type: 'review_pass' },
    review_fail: { type: 'review_fail', unmet }, review_limit: { type: 'review_limit', no: null, text: '不过' },
    owner_accept: { type: 'owner_accept' }, owner_return: { type: 'owner_return', unmet },
    block: { type: 'block', kind: 'executor', no: null, text: '原因' }, unblock: { type: 'unblock' }, hold: { type: 'hold' },
    option_recheck: { type: 'option_recheck' }, option_deliver: { type: 'option_deliver' }, stop: { type: 'stop' },
    version_rework: { type: 'version_rework', unmet }, // P74e 新增的动作：类型要求每个动作都有一行
    review_limit_exit: { type: 'review_limit_exit', to: 'rework', unmet }, // P74r6 新增的动作
  };
  /** 每个动作挑一个明确不允许的起点状态。 */
  const badFrom: Record<JobActionType, JobState> = {
    start: 'doing', submit: 'ready', review_pass: 'doing', review_fail: 'doing', review_limit: 'rework',
    owner_accept: 'checking', owner_return: 'doing', block: 'awaiting_owner', unblock: 'doing', hold: 'doing',
    option_recheck: 'checking', option_deliver: 'doing', stop: 'done' as JobState, version_rework: 'doing', review_limit_exit: 'doing',
  };
  it.each(Object.keys(actions) as JobActionType[])('%s', type => {
    const from = badFrom[type];
    const job = from === 'blocked' ? blockedJob('executor', 'doing') : jobFixture({ state: from === 'done' ? 'doing' : from });
    if (type === 'stop') return; // stop 的反例在终态一节
    expect(() => applyJobAction(job, actions[type], T)).toThrow(new RegExp(`「${JOB_ACTION_LABELS[type]}」只能从`));
  });
  it('错误信息写出当前状态和允许的起点', () => {
    expect(() => applyJobAction(jobFixture({ state: 'doing' }), { type: 'start' }, T)).toThrow('这件事当前是「执行中」，「开工」只能从「待开工」发起');
    expect(() => applyJobAction(jobFixture({ state: 'doing' }), { type: 'submit' }, T)).not.toThrow();
    expect(() => applyJobAction(jobFixture({ state: 'awaiting_owner' }), { type: 'submit' }, T)).toThrow('只能从「执行中、返工中」发起');
  });
  it('员工和总管不能自己标完成：只有 owner_accept 能到已完成，且只能从待你验收出发', () => {
    for (const from of ['ready', 'doing', 'checking', 'rework'] as const) {
      expect(() => applyJobAction(jobFixture({ state: from }), { type: 'owner_accept' }, T)).toThrow(/只能从「待你验收」发起/);
    }
  });
});

describe('终态', () => {
  it.each(['done', 'stopped'] as const)('%s：任何动作都报「已…，不能再改状态」', state => {
    const job = jobFixture({ state });
    const label = state === 'done' ? '已完成' : '已停止';
    const all: JobAction[] = [
      { type: 'start' }, { type: 'submit' }, { type: 'review_pass' }, { type: 'review_fail', unmet },
      { type: 'review_limit', no: null, text: 'x' }, { type: 'owner_accept' }, { type: 'owner_return', unmet },
      { type: 'block', kind: 'executor', no: null, text: 'x' }, { type: 'unblock' }, { type: 'hold' },
      { type: 'option_recheck' }, { type: 'option_deliver' }, { type: 'stop' },
    ];
    for (const action of all) expect(() => applyJobAction(job, action, T)).toThrow(`这件事${label}，不能再改状态`);
  });
});

describe('完整流程：派活到验收，含一次退回和一次验收后指出不符', () => {
  it('走通并保持每一步合法', () => {
    let job = jobFixture({ state: 'ready', startedAt: null });
    job = run(job, { type: 'start' });
    job = run(job, { type: 'submit' });
    job = run(job, { type: 'review_fail', unmet });
    job = run(job, { type: 'submit' });
    job = run(job, { type: 'review_pass' });
    job = run(job, { type: 'owner_return', unmet });
    expect([job.state, job.stage, job.round]).toEqual(['rework', 2, 0]);
    job = run(job, { type: 'submit' });
    job = run(job, { type: 'review_pass' });
    job = run(job, { type: 'owner_accept' });
    expect(job).toMatchObject({ state: 'done', stage: 2, round: 1 });
  });
  it('三轮不过 → 选办法重新核对 → 通过 → 验收', () => {
    let job = jobFixture({ state: 'doing', round: 0 });
    for (let round = 1; round <= 3; round++) {
      job = run(job, { type: 'submit' });
      expect(job.round).toBe(round);
      job = round < 3 ? run(job, { type: 'review_fail', unmet }) : run(job, { type: 'review_limit', no: 2, text: '三轮没过' });
    }
    expect(job.blocked?.kind).toBe('review_limit');
    job = run(job, { type: 'option_recheck' });
    job = run(job, { type: 'review_pass' });
    job = run(job, { type: 'owner_accept' });
    expect(job.state).toBe('done');
  });
});

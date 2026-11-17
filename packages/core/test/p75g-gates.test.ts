/**
 * P75g 的测试二：技能类回合（复盘、技能核对、整理）的入队、闸门、上限、计数。
 * 候选来自真实验收之后的 afterJobAccepted（真实入队、真实事项键、真实快照）；拦截原因断言原因码本身。
 * 额度灯、预算这类要「碰巧放行或碰巧拦下」的前提，一律在用例里显式写出来（覆盖快照里的对应字段），
 * 并且每条放行的断言都有一条同条件下的普通候选作对照，证明放行不是因为条件本来就宽。
 */
import { describe, expect, it } from 'vitest';
import { buildCandidate } from '../src/appraisal/think.js';
import { checkQuarantine } from '../src/health/index.js';
import { createTestContext } from '../src/io/testing/create-test-context.js';
import type { HubContext } from '../src/engine/context.js';
import type { QueueEntry, WakeTicket } from '../src/model/index.js';
import { stopLaunchForCap } from '../src/job/launch-approval.js';
import { enqueue } from '../src/scheduler/queue.js';
import { onDemandBlocks, SKILL_WORK_SUBJECT_PREFIXES, isSkillWork } from '../src/scheduler/on-demand.js';
import { buildSnapshot, evaluateGates } from '../src/scheduler/gates.js';
import { enqueueSkillWork } from '../src/skill/enqueue.js';
import { parseSkillKey, retroSubjectKey, skillcheckSubjectKey, tidySubjectKey } from '../src/skill/keys.js';
import { nextLocalTime } from '../src/util/time.js';
import { botFixture, modelFixtures } from './model-fixtures.js';
import {
  MINUTE, bot, commitAndEnd, flow, lightOf, nextPacket, participantOf, retroRun, skillKeysQueued, theJob, threadOf, tick, type JobFix,
} from './p75g-fixtures.js';

const DAY = 24 * 60 * MINUTE;

/** 候选的纯闸门判断：真实快照（带事项键），可覆盖其中某些字段。 */
function verdict(fix: JobFix, entry: QueueEntry, patch: Record<string, unknown> = {}) {
  const now = fix.ctx.clock.now();
  const snapshot = { ...buildSnapshot(fix.ctx, entry.botId, now, entry.jobId, entry.subjectKey), ...patch };
  return evaluateGates(entry, snapshot as never, now, fix.ctx.settings);
}

/** 同条件下的普通候选：不是技能类的同伴消息（听吩咐的员工本来就接收），用来作对照。 */
function ordinary(entry: QueueEntry): QueueEntry {
  return { ...entry, subjectKey: 'peer:x', variant: 'regular', reason: { ...entry.reason, kind: 'peer_message' } };
}

/**
 * 场景：核对退回过一次、没有别的纠正，验收之后执行者有一条复盘候选在队列里（真实入队）。
 * 先推进 5 分钟越过「全局放行间隔」（一次不超过 10 分钟）；主人离开超过 10 分钟，允许两位同时思考。
 */
async function scene() {
  const { fix, job } = await flow({ rejectFirst: true });
  // P76c：P76b 在这里显式设过每日回合 6；一件事里的回合不再计入员工自己发起的回合数，这个场景里员工自己发起的回合为 0，
  // 用默认值 2 也不影响任何断言，所以去掉显式设置（这个文件里没有依赖旧默认值的用例了）。
  fix.ctx.clock.advance(5 * MINUTE);
  fix.ctx.runtime.ownerActiveAt = fix.ctx.clock.now() - 11 * MINUTE;
  const run = retroRun(fix, job.id)!;
  const entry = fix.ctx.store.table('queue').list(row => row.botId === fix.engineer.id && row.subjectKey === retroSubjectKey(run.id, fix.engineer.id))[0]!;
  // 前提：额度绿灯、在岗、听吩咐，这位员工的候选本来就放行。
  expect(lightOf(fix, fix.engineer.id)).toBe('green');
  expect(verdict(fix, entry)).toEqual({ pass: true });
  return { fix, job, run, entry };
}

describe('7 听吩咐的员工：技能类候选放行，普通复盘候选照旧被挡', () => {
  it('事项键是 retro:、skillcheck:、tidy: 的复盘候选：onDemandBlocks 为假；事项键不是技能类的复盘候选仍为真', async () => {
    const { fix, entry } = await scene();
    const engineer = bot(fix, fix.engineer.id);
    expect(engineer.onDemand).toBe(true);
    expect([...SKILL_WORK_SUBJECT_PREFIXES]).toEqual(['retro:', 'skillcheck:', 'tidy:']);
    expect(entry.reason.kind).toBe('reflection');
    for (const key of [retroSubjectKey('sr_0000000001', 'b_x'), retroSubjectKey('sr_0000000001', 'b_x', true), skillcheckSubjectKey('sr_0000000001', 'b_x'), tidySubjectKey('2026-11-16', 'b_x')]) {
      expect(onDemandBlocks(engineer, 'reflection', key), key).toBe(false);
      expect(isSkillWork('reflection', key), key).toBe(true);
    }
    // 反例：普通复盘候选（事项键不是技能类）仍被挡；技能类的事项键配上别的种类也不算技能类回合。
    expect(onDemandBlocks(engineer, 'reflection', 'reflection:message:m_1')).toBe(true);
    expect(onDemandBlocks(engineer, 'reflection', undefined)).toBe(true);
    expect(isSkillWork('percept', retroSubjectKey('sr_0000000001', 'b_x'))).toBe(false);
    expect(parseSkillKey('retro:sr_0000000001:b_x:rewrite')).toEqual({ kind: 'retro', runId: 'sr_0000000001', botId: 'b_x', rewrite: true });
    expect(parseSkillKey('jobwake:job_1:b_x')).toBeNull();
    // 整条闸门：真实的复盘候选放行；同样种类、事项键换成普通的，被「听吩咐」丢弃。
    const plain: QueueEntry = { ...entry, subjectKey: 'reflection:message:m_1' };
    expect(verdict(fix, entry)).toEqual({ pass: true });
    expect(verdict(fix, plain)).toMatchObject({ pass: false, by: 'on_demand', drop: true });
  });

  it('入队总闸：技能类候选入得了队，普通复盘候选入不了队', async () => {
    const { fix } = await scene();
    const candidate = (subjectKey: string) => buildCandidate(fix.ctx, {
      botId: fix.reviewer.id, kind: 'reflection', variant: 'reflection', score: 0.5, summary: '复盘', subjectKey,
    });
    expect(enqueue(fix.ctx, candidate('reflection:message:m_1'), { directed: true })).toBeNull();
    expect(enqueue(fix.ctx, candidate(retroSubjectKey('sr_0000000009', fix.reviewer.id)), { directed: true })).not.toBeNull();
  });
});

describe('8 越过冷却、最短间隔，也不受员工自主预算约束', () => {
  it('刚思考过 5 分钟：技能类候选放行，同条件的普通候选被最短思考间隔拦住；同一事项冷却同理', async () => {
    const { fix, entry } = await scene();
    fix.ctx.store.table('bots').patch(fix.engineer.id, { lastThinkAt: fix.ctx.clock.now() - 5 * MINUTE });
    expect(verdict(fix, entry)).toEqual({ pass: true });
    expect(verdict(fix, ordinary(entry))).toMatchObject({ pass: false, by: 'pace_min' });
    const now = fix.ctx.clock.now();
    const subjectWakeAt = new Map([[entry.subjectKey, now - MINUTE], ['peer:x', now - MINUTE]]);
    expect(verdict(fix, entry, { subjectWakeAt })).toEqual({ pass: true });
    expect(verdict(fix, ordinary(entry), { subjectWakeAt })).toMatchObject({ pass: false, by: 'cooldown' });
  });

  // P76c：原用例的「回合、token、窗口、思考上限都已用完」只剩一条（员工自己发起的回合数到每天上限）；快照里三个字段换成 selfTurnsToday。
  // 证明的仍是：技能类候选不受员工自己发起的名额限制，同条件的普通候选被拦住（daily_cap）。
  it('员工今天自己发起的回合已达每天上限：技能类候选放行，同条件的普通候选被 daily_cap 拦住', async () => {
    const { fix, entry } = await scene();
    // 对照用的普通候选要先越过最短间隔，才看得到预算这一道（最短间隔排在预算之前）。
    fix.ctx.store.table('bots').patch(fix.engineer.id, { lastThinkAt: null });
    const used = { selfTurnsToday: 10_000 };
    expect(verdict(fix, entry, used)).toEqual({ pass: true });
    expect(verdict(fix, ordinary(entry), used)).toMatchObject({ pass: false, by: 'daily_cap' });
  });
});

describe('9 额度灯：橙灯、红灯等待，不丢弃', () => {
  it('橙灯拦下（原因 quota、不丢弃），变回黄灯后放行；同样处境下带 jobId 的执行链候选橙灯放行（与技能类不同）', async () => {
    const { fix, entry } = await scene();
    const now = fix.ctx.clock.now();
    const base = buildSnapshot(fix.ctx, fix.engineer.id, now, undefined, entry.subjectKey);
    const orange = verdict(fix, entry, { quota: { ...base.quota, light: 'orange' } });
    expect(orange).toMatchObject({ pass: false, by: 'quota', drop: false });
    expect(verdict(fix, entry, { quota: { ...base.quota, light: 'yellow' } })).toEqual({ pass: true });
    expect(verdict(fix, entry, { quota: { ...base.quota, light: 'green' } })).toEqual({ pass: true });
    // 对照：主人确认过的事（带总管派活标记）橙灯放行，说明这里拦下靠的是「技能类不属于放行的几类」。
    expect(verdict(fix, { ...ordinary(entry), chiefDispatch: true }, { quota: { ...base.quota, light: 'orange' } })).toEqual({ pass: true });
  });

  it('红灯（没有探针）同理：拦下、不丢弃；鉴权失败也拦下', async () => {
    const { fix, entry } = await scene();
    const now = fix.ctx.clock.now();
    const base = buildSnapshot(fix.ctx, fix.engineer.id, now, undefined, entry.subjectKey);
    const red = { ...base.quota, light: 'red', probeAllowed: false, redUntil: now + 60 * MINUTE };
    expect(verdict(fix, entry, { quota: red })).toMatchObject({ pass: false, by: 'quota', drop: false, until: now + 60 * MINUTE });
    expect(verdict(fix, entry, { quota: { ...base.quota, light: 'yellow' } })).toEqual({ pass: true });
    expect(verdict(fix, entry, { authBlocked: true })).toMatchObject({ pass: false, by: 'quota', drop: false });
  });

  it('启动静默、全局放行间隔、并发、重试退避照旧', async () => {
    const { fix, entry } = await scene();
    const now = fix.ctx.clock.now();
    expect(verdict(fix, entry, { startedAt: now - MINUTE })).toMatchObject({ pass: false, by: 'startup_quiet' });
    expect(verdict(fix, entry, { lastDispatchAt: now - 1_000 })).toMatchObject({ pass: false, by: 'dispatch_gap' });
    expect(verdict(fix, entry, { running: true })).toMatchObject({ pass: false, by: 'concurrency' });
    expect(verdict(fix, entry, { retryAt: now + 10 * MINUTE })).toMatchObject({ pass: false, by: 'retry_backoff' });
  });
});

describe('10 全队每天技能类回合上限', () => {
  it('今天已用 11 个放行，12 个拦下（原因 skill_daily_cap、不丢弃、恢复时刻为次日 00:00）；教学回合算在内；昨天开始的唤醒不算', async () => {
    const { fix, entry } = await scene();
    fix.ctx.store.table('bots').patch(fix.engineer.id, { lastThinkAt: null }); // 对照用的普通候选要先越过最短间隔
    const now = fix.ctx.clock.now();
    const tz = fix.ctx.settings.timezone;
    // 事项键轮流用复盘、技能核对、整理、教学（变体 teach、事项键 learn:）。
    const specs = (count: number, offset: number) => Array.from({ length: count }, (_, i) => {
      const n = String(offset + i).padStart(10, '0');
      const key = [retroSubjectKey(`sr_${n}`, fix.reviewer.id), skillcheckSubjectKey(`sr_${n}`, fix.reviewer.id), tidySubjectKey(`2026-11-${String(1 + (i % 28)).padStart(2, '0')}`, fix.reviewer.id), `learn:x${n}`][i % 4]!;
      return { key, variant: (i % 4 === 3 ? 'teach' : 'reflection') as WakeTicket['variant'] };
    });
    // 先放 2 个昨天的唤醒：不算今天。
    addWakesFrom(fix, 500, [{ key: retroSubjectKey('sr_0000000500', fix.reviewer.id), at: now - 2 * DAY }, { key: retroSubjectKey('sr_0000000501', fix.reviewer.id), at: now - 2 * DAY }]);
    addWakesFrom(fix, 600, specs(11, 600));
    expect(buildSnapshot(fix.ctx, fix.engineer.id, now).teamSkillTurnsToday).toBe(11);
    expect(verdict(fix, entry)).toEqual({ pass: true });
    addWakesFrom(fix, 700, specs(1, 700));
    expect(buildSnapshot(fix.ctx, fix.engineer.id, now).teamSkillTurnsToday).toBe(12);
    const blocked = verdict(fix, entry);
    expect(blocked).toMatchObject({ pass: false, by: 'skill_daily_cap', drop: false });
    expect((blocked as { until: number }).until).toBe(nextLocalTime('00:00', now, tz));
    expect((blocked as { until: number }).until).toBeGreaterThan(now);
    expect((blocked as { until: number }).until).toBeLessThanOrEqual(now + DAY);
    // 对照：普通候选不受这个上限约束。
    expect(verdict(fix, ordinary(entry))).toEqual({ pass: true });
  });
});

/** 从指定起点编号补唤醒单。 */
function addWakesFrom(fix: JobFix, start: number, specs: Array<{ key: string; variant?: WakeTicket['variant']; at?: number }>): void {
  const base = fix.ctx.store.table('wakes').list()[0]!;
  specs.forEach((spec, index) => {
    fix.ctx.store.table('wakes').put({
      ...base, id: `w_${String(start + index).padStart(10, '0')}`, botId: fix.reviewer.id, subjectKey: spec.key, variant: spec.variant ?? 'reflection',
      jobId: null, startedAt: spec.at ?? fix.ctx.clock.now(), endedAt: spec.at ?? fix.ctx.clock.now(), status: 'committed',
    });
  });
}

describe('11 这次复盘的回合用完', () => {
  it('turnsUsed 到 7：下一次调度丢弃候选（原因 skill_cap），参与者 capped，记录结束，小结写「复盘回合用完……」', async () => {
    const { fix, job, run, entry } = await scene();
    // P75r5b 同步：复盘回合上限由 5 提到 7，这里的 5、4、5 随之改成 7、6、7。
    fix.ctx.store.table('skillRuns').put({ ...run, turnsUsed: 7 });
    expect(verdict(fix, entry)).toMatchObject({ pass: false, by: 'skill_cap', drop: true });
    // 对照：差一个回合时放行。
    fix.ctx.store.table('skillRuns').put({ ...run, turnsUsed: 6 });
    expect(verdict(fix, entry)).toEqual({ pass: true });
    fix.ctx.store.table('skillRuns').put({ ...run, turnsUsed: 7 });
    await tick(fix, MINUTE);
    expect(fix.ctx.store.table('queue').list(row => row.subjectKey === entry.subjectKey)).toEqual([]);
    const after = retroRun(fix, job.id)!;
    expect(participantOf(after, fix.engineer.id)).toMatchObject({ state: 'capped', reason: 'skill_cap' });
    expect(after.endedAt).not.toBeNull();
    const summaries = threadOf(fix.ctx, job.topicId).filter(row => row.refId === `retro-summary:${run.id}`);
    expect(summaries).toMatchObject([{ from: 'hub', kind: 'work', text: '复盘回合用完，林舟的更新未完成核对。' }]);
    expect(fix.ctx.store.log('appraisals').all().some(row => row.suppressedBy === 'skill_cap')).toBe(true);
    // 小结只落一次：再走几个 tick 也不会重复。
    await tick(fix, MINUTE);
    await tick(fix, MINUTE);
    expect(threadOf(fix.ctx, job.topicId).filter(row => row.refId === `retro-summary:${run.id}`)).toHaveLength(1);
  });
});

describe('12 等了 7 天仍没轮到', () => {
  it('候选入队超过 7 天：丢弃（原因 skill_expired），参与者 expired，小结写「……等待超过 7 天，未进行。」；不到 7 天仍放行', async () => {
    const { fix, job, run, entry } = await scene();
    const now = fix.ctx.clock.now();
    // 不推进时钟（一次推进太久会被当成电脑睡眠），直接把入队时间改到 6 天前、再改到 7 天多以前。
    fix.ctx.store.table('queue').put({ ...entry, enqueuedAt: now - 6 * DAY });
    expect(verdict(fix, { ...entry, enqueuedAt: now - 6 * DAY })).toEqual({ pass: true });
    fix.ctx.store.table('queue').put({ ...entry, enqueuedAt: now - 7 * DAY - MINUTE });
    expect(verdict(fix, { ...entry, enqueuedAt: now - 7 * DAY - MINUTE })).toMatchObject({ pass: false, by: 'skill_expired', drop: true });
    await tick(fix, MINUTE);
    const after = retroRun(fix, job.id)!;
    expect(participantOf(after, fix.engineer.id)).toMatchObject({ state: 'expired', reason: 'skill_expired' });
    expect(after.endedAt).not.toBeNull();
    expect(threadOf(fix.ctx, job.topicId).filter(row => row.refId === `retro-summary:${run.id}`).map(row => row.text)).toEqual(['林舟的复盘等待超过 7 天，未进行。']);
    expect(fix.ctx.store.table('queue').list(row => row.subjectKey === entry.subjectKey)).toEqual([]);
  });

  it('找不到所属记录，或参与者已经不是 queued（做完、跳过、放弃）：丢弃，参与者状态保持原样', async () => {
    const { fix, run, entry } = await scene();
    // P75r5b 同步：这两种情形的原因码由 skill_expired 改为 skill_stale（与「真的等了 7 天」分开）。
    for (const state of ['done', 'skipped', 'expired', 'capped', 'running'] as const) {
      fix.ctx.store.table('skillRuns').put({ ...run, participants: run.participants.map(row => ({ ...row, state })) });
      expect(verdict(fix, entry), state).toMatchObject({ pass: false, by: 'skill_stale', drop: true });
    }
    fix.ctx.store.table('skillRuns').remove(run.id);
    expect(verdict(fix, entry)).toMatchObject({ pass: false, by: 'skill_stale', drop: true });
  });
});

describe('13 建唤醒单时计数，回合结束累计 token', () => {
  it('拿到回合：turnsUsed 加 1、参与者 running；回合结束 token 累加进记录；全队回合数加 1', async () => {
    const { fix, job, run } = await scene();
    expect(run.turnsUsed).toBe(0);
    const before = buildSnapshot(fix.ctx, fix.engineer.id, fix.ctx.clock.now()).teamSkillTurnsToday;
    expect(before).toBe(0);
    await nextPacket(fix, fix.engineer.id);
    const during = retroRun(fix, job.id)!;
    expect(during.turnsUsed).toBe(1);
    expect(participantOf(during, fix.engineer.id)).toMatchObject({ state: 'running' });
    expect(during.tokens).toBe(0);
    expect(buildSnapshot(fix.ctx, fix.engineer.id, fix.ctx.clock.now()).teamSkillTurnsToday).toBe(1);
    const wake = fix.ctx.store.table('wakes').list(row => row.botId === fix.engineer.id && row.status === 'running')[0]!;
    expect(wake).toMatchObject({ variant: 'reflection', subjectKey: retroSubjectKey(run.id, fix.engineer.id) });
    expect(wake.jobId ?? null).toBeNull(); // 技能类回合不带 jobId，不进「一件事的回合上限」
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '没有可写的' });
    const ledger = fix.ctx.store.log('ledger').all().find(row => row.wakeId === wake.id)!;
    expect(ledger.tokens).toBeGreaterThan(0);
    expect(retroRun(fix, job.id)!.tokens).toBe(ledger.tokens);
    // 这一回合没有提交（没调用 propose）：不算完成，参与者改回 queued，补排一次。
    expect(participantOf(retroRun(fix, job.id)!, fix.engineer.id)).toMatchObject({ state: 'queued' });
    expect(skillKeysQueued(fix, fix.engineer.id)).toEqual([retroSubjectKey(run.id, fix.engineer.id)]);
    // 这件事的回合数不受影响。
    expect(theJob(fix).turnsUsed).toBe(job.turnsUsed);
  });
});

describe('入队：只在对应事项键相同时合并，其余各排各的', () => {
  it('同一员工的普通候选与技能类候选并排，互不并入；同一事项键重复入队不产生第二条', async () => {
    const { fix, job, run } = await scene();
    const key = retroSubjectKey(run.id, fix.engineer.id);
    expect(skillKeysQueued(fix, fix.engineer.id)).toEqual([key]);
    // 普通候选（同伴消息）入队：与技能类候选并排，技能类候选的键、种类、变体不被改写。
    const peer = buildCandidate(fix.ctx, { botId: fix.engineer.id, kind: 'peer_message', score: 0.9, summary: '有人找你', subjectKey: 'peer:x' });
    enqueue(fix.ctx, peer, { directed: true });
    const rows = fix.ctx.store.table('queue').list(row => row.botId === fix.engineer.id);
    expect(rows.map(row => row.subjectKey).sort()).toEqual([key, 'peer:x'].sort());
    expect(rows.find(row => row.subjectKey === key)).toMatchObject({ variant: 'reflection', reason: { kind: 'reflection' } });
    expect(rows.find(row => row.subjectKey === 'peer:x')).toMatchObject({ variant: 'regular' });
    // 另一张记录的技能类候选同样并排；同一事项键再排一次只留一条。
    const other = enqueueSkillWork(fix.ctx, { runId: 'sr_0000000777', botId: fix.engineer.id, key: retroSubjectKey('sr_0000000777', fix.engineer.id), title: '别的事' });
    expect(other).not.toBeNull();
    enqueueSkillWork(fix.ctx, { runId: run.id, botId: fix.engineer.id, key, title: '会员定价页' });
    expect(fix.ctx.store.table('queue').list(row => row.botId === fix.engineer.id && row.subjectKey === key)).toHaveLength(1);
    expect(fix.ctx.store.table('queue').list(row => row.botId === fix.engineer.id)).toHaveLength(3);
    expect(job.id).toBe(run.jobId);
  });

  it('说明文字：复盘「复盘：{标题}」，活动流里的摘要与给模型看的摘要是同一句', async () => {
    const { fix, run, entry } = await scene();
    expect(entry.reason.summary).toBe('复盘：会员定价页');
    expect(entry.reason.ownerSummary).toBe('复盘：会员定价页');
    expect(run.jobId).not.toBeNull();
  });
});

describe('派活说明第二节第 5 条：发布准备进行中时，执行者的复盘等它结束再放行', () => {
  it('执行者在准备发布（已完成、发布状态 preparing 或 approval）：拦下不丢弃；评审员的复盘不受影响；发布结束（done、declined）后放行', async () => {
    const { fix, job, run, entry } = await scene();
    const reviewerEntry = { ...entry, botId: fix.reviewer.id, subjectKey: retroSubjectKey(run.id, fix.reviewer.id) };
    fix.ctx.store.table('skillRuns').put({ ...run, participants: [...run.participants, { botId: fix.reviewer.id, role: 'reviewer', sourceIds: [], state: 'queued', reason: null }] });
    for (const state of ['preparing', 'approval'] as const) {
      fix.ctx.store.table('jobs').patch(job.id, { launch: { state, approvalId: null, link: null } });
      expect(verdict(fix, entry), state).toMatchObject({ pass: false, by: 'concurrency', drop: false });
      expect(verdict(fix, reviewerEntry), state).toEqual({ pass: true });
    }
    for (const state of ['done', 'declined'] as const) {
      fix.ctx.store.table('jobs').patch(job.id, { launch: { state, approvalId: null, link: null, ...(state === 'declined' ? { endedBy: 'hub' as const } : {}) } });
      expect(verdict(fix, entry), state).toEqual({ pass: true });
    }
    // 没有发布步骤的事（none）不等。
    fix.ctx.store.table('jobs').patch(job.id, { launch: { state: 'none', approvalId: null, link: null } });
    expect(verdict(fix, entry)).toEqual({ pass: true });
  });

  it('真实链路：验收之后执行者先拿到发布准备的回合（复盘候选等着、没有被叫醒）；发布这一步被中心结束之后，执行者才拿到复盘回合', async () => {
    const { fix, job } = await flow({ rejectFirst: true, launch: true });
    expect(theJob(fix).launch.state).toBe('preparing');
    const run = retroRun(fix, job.id)!;
    expect(skillKeysQueued(fix, fix.engineer.id)).toEqual([retroSubjectKey(run.id, fix.engineer.id)]);
    // 第一个回合是发布准备（带 jobId，唤醒包里是「你手上的事」，没有复盘段）。
    const first = await nextPacket(fix, fix.engineer.id);
    expect(first).toContain('## 你手上的事');
    expect(first).not.toContain('## 本轮复盘');
    expect(retroRun(fix, job.id)!.turnsUsed).toBe(0);
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '准备中' });
    // 发布还没结束：执行者被再叫去准备发布，复盘候选一直排队，没有任何一个回合是复盘。
    for (let i = 0; i < 3; i += 1) await tick(fix, 5 * MINUTE);
    expect(fix.ctx.store.table('wakes').list(row => row.subjectKey === retroSubjectKey(run.id, fix.engineer.id))).toEqual([]);
    expect(skillKeysQueued(fix, fix.engineer.id)).toEqual([retroSubjectKey(run.id, fix.engineer.id)]);
    // 中心结束发布这一步（回合上限的那条路径）并结束手上的发布回合，之后复盘放行。
    if (fix.ctx.store.table('wakes').count(row => row.botId === fix.engineer.id && row.status === 'running') > 0) {
      await fix.hub.onTurnEvent({ type: 'ended', sessionId: bot(fix, fix.engineer.id).sessionId!, at: fix.ctx.clock.now(), finalText: '', tokens: 500 });
    }
    stopLaunchForCap(fix.ctx, job.id);
    expect(theJob(fix).launch.state).toBe('declined');
    const second = await nextPacket(fix, fix.engineer.id);
    expect(second).toContain('## 本轮复盘：会员定价页');
    expect(retroRun(fix, job.id)!.turnsUsed).toBe(1);
  });
});

describe('派活说明第二节第 4 条：技能类回合不计入「用量超标停用」', () => {
  /** 一个已结束的回合：事项键由调用方给；账本里记一行用量。 */
  function addTurn(ctx: HubContext, n: number, tokens: number, subjectKey: string | null, variant: WakeTicket['variant']): void {
    const id = `w_${String(n).padStart(10, '0')}`;
    const base = modelFixtures.WakeTicket.valid as WakeTicket;
    // P76c：用量口径改数唤醒单，所以唤醒单要落在今天、写明已投递；复盘类回合的唤醒种类要写成 reflection（isSkillWork 看种类和事项键）。
    ctx.store.table('wakes').put({ ...base, id, botId: botFixture.id, ownerInitiated: false, jobId: null, variant, ...(subjectKey === null ? {} : { subjectKey }),
      reason: { ...base.reason, kind: variant === 'reflection' ? 'reflection' : base.reason.kind },
      status: 'committed', startedAt: ctx.clock.now() - 60_000, dispatchedAt: ctx.clock.now() - 60_000, endedAt: ctx.clock.now() });
    ctx.store.log('ledger').append({ id: `le_${String(n).padStart(10, '0')}`, who: botFixture.id, wakeId: id, tokens, kind: 'turn', at: ctx.clock.now() });
  }

  it('当天只有复盘类回合（20 个、100 万 token）：没有被停用；同样的用量换成普通回合：被停用', () => {
    const quiet = createTestContext();
    quiet.store.table('bots').put({ ...botFixture });
    for (let n = 1; n <= 20; n += 1) addTurn(quiet, n, 50_000, `retro:sr_0000000001:${botFixture.id}`, 'reflection');
    expect(checkQuarantine(quiet, botFixture.id, quiet.clock.now())).toBeNull();
    expect(quiet.store.table('bots').get(botFixture.id)!.lifecycle).not.toBe('quarantined');
    const loud = createTestContext();
    loud.store.table('bots').put({ ...botFixture });
    for (let n = 1; n <= 20; n += 1) addTurn(loud, n, 50_000, null, 'regular');
    // P76c：停用原因文字改了（不再写「三倍预算」，按回合数）；同样的 20 个普通回合仍被停用。
    // P76r1 同步：传入刚结束的唤醒单（第 20 个）；原因文字按倍数生成（「3 倍」）。
    expect(checkQuarantine(loud, botFixture.id, loud.clock.now(), loud.store.table('wakes').get(`w_${String(20).padStart(10, '0')}`)!)).toBe('自己发起的回合达到每天上限的 3 倍');
  });

  // P76c：原用例靠显式设 6 让 10 个自己发起的回合低于线（6×3=18）；现在线是 2×3=6，自己发起的取 5 个（低于线），
  // 复盘类仍是 10 个（单独或合计都高于线），证明的仍是「只数自己发起的那部分」。
  it('复盘类回合加自己发起的回合：只数自己发起的那部分（自己发起的没超线就不停用）', () => {
    const ctx = createTestContext();
    ctx.store.table('bots').put({ ...botFixture });
    for (let n = 1; n <= 10; n += 1) addTurn(ctx, n, 100_000, `skillcheck:sr_0000000001:${botFixture.id}`, 'reflection');
    for (let n = 11; n <= 15; n += 1) addTurn(ctx, n, 70_000, null, 'regular');
    expect(checkQuarantine(ctx, botFixture.id, ctx.clock.now())).toBeNull();
  });
});

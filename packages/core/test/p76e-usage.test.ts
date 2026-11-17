/**
 * P76e：一件事的分步记账（stepOf 的判断、回合记账与退还、实测 token 补记、对齐、定稿）。
 *
 * 走真实 Hub：总管自动创建（听吩咐、节奏最慢）、执行类员工听吩咐；时钟用假时钟，推进每次不超过 10 分钟。
 * 判断「这一回合记不记」的条件用直接构造的唤醒单检验（与 countJobTurn 的条件一致），记账结果读 jobUsage 表。
 */
import { describe, expect, it } from 'vitest';
import { stopJobCore } from '../src/job/stop-core.js';
import { refundJobTurn, countJobTurn } from '../src/job/turns.js';
import { addJobTurnTokens, alignmentOf, finalizeJobUsage, recordAlignment, recordJobTurn, stepOf, undoJobTurn } from '../src/job/usage.js';
import { BUDGET_DEFAULTS as D } from '../src/config/defaults.js';
import type { Job } from '../src/model/job.js';
import type { WakeTicket } from '../src/model/index.js';
import { recordUsage } from '../src/quota/usage.js';
import { retroSubjectKey } from '../src/skill/keys.js';
import { assigned, commitAndEnd, runningJob, runningOf, tick, MINUTE } from './p74c-fixtures.js';
import { jobFix } from './p74b-fixtures.js';
import { delivered } from './p74f-fixtures.js';
import { addLedger, addWake } from './p76c-fixtures.js';

/** 这件事的用量行。 */
function usageOf(fix: Awaited<ReturnType<typeof jobFix>>, jobId: string) {
  return fix.ctx.store.table('jobUsage').get(jobId)!;
}

describe('1 stepOf：一个回合属于哪一步', () => {
  async function base() {
    const fix = await jobFix(['小周']);
    const { job } = await assigned(fix);
    const who = { chief: fix.chief.id, executor: fix.engineer.id, reviewer: fix.reviewer.id, other: fix.extras[0]!.id };
    return { job: job as Job, who };
  }
  const launching = (job: Job, state: Job['launch']['state']): Job => ({ ...job, state: 'done', launch: { ...job.launch, state } });

  it('发布：已完成且发布在准备中、等批准、发布没有成功，任何一位的回合都记发布', async () => {
    const { job, who } = await base();
    for (const state of ['preparing', 'approval', 'failed'] as const) {
      for (const id of [who.executor, who.chief, who.reviewer]) expect(stepOf(launching(job, state), id), `${state}/${id}`).toBe('launch');
    }
  });

  it('发布已成功但还没补记网址的那一次叫醒也记发布；已完成而发布不在这些状态（没有发布步骤）不记发布', async () => {
    const { job, who } = await base();
    expect(stepOf({ ...job, state: 'done', launchStep: true, launch: { state: 'done', approvalId: null, link: null } }, who.executor)).toBe('launch');
    expect(stepOf({ ...job, state: 'done', launchStep: true, launch: { state: 'done', approvalId: null, link: 'http://localhost/' } }, who.executor)).toBe('exec');
    expect(stepOf({ ...job, state: 'done', launch: { ...job.launch, state: 'none' } }, who.executor)).toBe('exec');
    expect(stepOf({ ...job, state: 'done', launch: { ...job.launch, state: 'declined' } }, who.executor)).toBe('exec');
  });

  it('核对：核对人的回合，任何状态都记核对', async () => {
    const { job, who } = await base();
    expect(stepOf({ ...job, state: 'checking' }, who.reviewer)).toBe('review');
    expect(stepOf({ ...job, state: 'doing' }, who.reviewer)).toBe('review');
  });

  it('没有核对人、这件事在核对中、总管的回合：记核对；不在核对中的总管回合记总管', async () => {
    const { job, who } = await base();
    const alone = { ...job, reviewerId: null };
    expect(stepOf({ ...alone, state: 'checking' }, who.chief)).toBe('review');
    expect(stepOf({ ...alone, state: 'doing' }, who.chief)).toBe('chief');
    expect(stepOf({ ...alone, state: 'awaiting_owner' }, who.chief)).toBe('chief');
    // 有核对人时，核对中总管的回合是总管，不是核对。
    expect(stepOf({ ...job, state: 'checking' }, who.chief)).toBe('chief');
  });

  it('返工：执行者在返工中，或执行中但还有待改的条目', async () => {
    const { job, who } = await base();
    const unmet = [{ no: 3, problem: '没提示', fixTo: '要提示' }] as Job['unmet'];
    expect(stepOf({ ...job, state: 'rework', unmet }, who.executor)).toBe('rework');
    expect(stepOf({ ...job, state: 'rework', unmet: [] }, who.executor)).toBe('rework');
    expect(stepOf({ ...job, state: 'doing', unmet }, who.executor)).toBe('rework');
    // 反例：执行中没有待改条目、待开工、别人在返工中。
    expect(stepOf({ ...job, state: 'doing', unmet: [] }, who.executor)).toBe('exec');
    expect(stepOf({ ...job, state: 'ready', unmet }, who.executor)).toBe('exec');
    expect(stepOf({ ...job, state: 'rework', unmet }, who.chief)).toBe('chief');
  });

  it('执行与总管：执行者记执行，总管记总管；与这件事无关的人按总管记，并报告一次', async () => {
    const { job, who } = await base();
    expect(stepOf({ ...job, state: 'doing' }, who.executor)).toBe('exec');
    expect(stepOf({ ...job, state: 'doing' }, who.chief)).toBe('chief');
    let reported = 0;
    expect(stepOf({ ...job, state: 'doing' }, who.other, () => { reported += 1; })).toBe('chief');
    expect(reported).toBe(1);
    // 正常的人不报告。
    stepOf({ ...job, state: 'doing' }, who.executor, () => { reported += 1; });
    expect(reported).toBe(1);
  });
});

describe('2 回合记账与 token 补记', () => {
  it('派活之后执行者的第一个回合记执行；回合还没结束时 token 为 0、写「还没记账」；记账之后补上实测并写结束时间', async () => {
    const fix = await jobFix();
    const { job } = await runningJob(fix);
    const running = usageOf(fix, job.id);
    expect(running.steps.exec).toEqual({ turns: 1, tokens: 0 });
    expect(running.turns).toHaveLength(1);
    expect(running.turns[0]).toMatchObject({ step: 'exec', botId: fix.engineer.id, endedAt: null, tokens: 0, startedAt: runningOf(fix, fix.engineer.id)!.startedAt });
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '先做着' });
    const done = usageOf(fix, job.id);
    // 夹具里回合结束事件给的 token 是 500。
    expect(done.turns[0]).toMatchObject({ step: 'exec', tokens: 500, endedAt: fix.ctx.clock.now() });
    expect(done.steps.exec).toEqual({ turns: 1, tokens: 500 });
  });

  it('派活时对齐记进用量：对齐回合数 1（约定第 1 版来自总管的一个回合），token 是那一回合在账本里的实测数', async () => {
    const fix = await jobFix();
    const { job, agreementId } = await assigned(fix);
    const agreement = fix.ctx.store.table('agreements').get(agreementId)!;
    const ledger = fix.ctx.store.log('ledger').all().filter(entry => entry.wakeId === agreement.versions[0]!.wakeId);
    expect(ledger).toHaveLength(1);
    expect(usageOf(fix, job.id)).toMatchObject({ id: job.id, agreementId, finalizedAt: null,
      steps: { align: { turns: 1, tokens: Math.ceil(ledger[0]!.tokenBase!) }, exec: { turns: 0, tokens: 0 } } });
    expect(usageOf(fix, job.id).category).toBe('其他');
  });

  it('退还的回合撤掉：回合数减 1，明细里这一项也没有了；没记过的回合退还不影响别的', async () => {
    const fix = await jobFix();
    const { job } = await runningJob(fix);
    const ticket = runningOf(fix, fix.engineer.id)!;
    expect(usageOf(fix, job.id).steps.exec.turns).toBe(1);
    refundJobTurn(fix.ctx, ticket);
    expect(usageOf(fix, job.id).steps.exec).toEqual({ turns: 0, tokens: 0 });
    expect(usageOf(fix, job.id).turns).toEqual([]);
    expect(fix.ctx.store.table('jobs').get(job.id)!.turnsUsed).toBe(0);
    // 再退一次、退一张没记过的：什么都不变。
    const before = usageOf(fix, job.id);
    undoJobTurn(fix.ctx, ticket);
    undoJobTurn(fix.ctx, { ...ticket, id: 'w_zzzzzzzzzz' });
    expect(usageOf(fix, job.id)).toEqual(before);
  });

  it('你发起的回合不记（主人在主题里问这件事引起的总管回合）；没记过的用量行里也不会冒出这一项', async () => {
    const fix = await jobFix();
    const { job } = await assigned(fix);
    const before = usageOf(fix, job.id);
    const wake = addWake(fix.ctx, { jobId: job.id, ownerInitiated: true, startedAt: fix.ctx.clock.now() }, fix.chief.id);
    recordJobTurn(fix.ctx, wake);
    countJobTurn(fix.ctx, wake);
    expect(usageOf(fix, job.id)).toEqual(before);
    expect(fix.ctx.store.table('jobs').get(job.id)!.turnsUsed).toBe(0);
    // 对照：同样的唤醒单不是你发起的，记总管一步。
    const mine = addWake(fix.ctx, { jobId: job.id, ownerInitiated: false, startedAt: fix.ctx.clock.now() }, fix.chief.id);
    recordJobTurn(fix.ctx, mine);
    expect(usageOf(fix, job.id).steps.chief.turns).toBe(1);
  });

  it('技能类事项键的回合不记（复盘、核对、整理：它们有自己的上限）；同条件的普通回合记', async () => {
    const fix = await jobFix();
    const { job } = await assigned(fix);
    const wake = addWake(fix.ctx, { jobId: job.id, startedAt: fix.ctx.clock.now() }, fix.engineer.id);
    const skill: WakeTicket = { ...wake, id: 'w_0000009001', reason: { ...wake.reason, kind: 'reflection' }, subjectKey: retroSubjectKey('skr_aaaaaaaaaa', fix.engineer.id) };
    recordJobTurn(fix.ctx, skill);
    expect(usageOf(fix, job.id).turns).toEqual([]);
    expect(usageOf(fix, job.id).steps.exec.turns).toBe(0);
    recordJobTurn(fix.ctx, { ...skill, id: 'w_0000009002', reason: { ...wake.reason, kind: 'peer_message' }, subjectKey: `jobwake:${job.id}:${fix.engineer.id}` });
    expect(usageOf(fix, job.id).steps.exec.turns).toBe(1);
  });

  it('改派之后新执行者的回合记执行（不记总管，也不记前任名下）', async () => {
    const fix = await jobFix(['小周']);
    const { job } = await assigned(fix);
    const newcomer = fix.extras[0]!;
    fix.ctx.store.table('jobs').patch(job.id, { executorId: newcomer.id });
    const wake = addWake(fix.ctx, { jobId: job.id, startedAt: fix.ctx.clock.now() }, newcomer.id);
    recordJobTurn(fix.ctx, wake);
    const row = usageOf(fix, job.id);
    expect(row.turns).toMatchObject([{ step: 'exec', botId: newcomer.id }]);
    expect(row.steps.exec.turns).toBe(1);
  });

  it('同一张唤醒单只记一次；明细超过上限时丢最早的一项，各步合计不减', async () => {
    const fix = await jobFix();
    const { job } = await assigned(fix);
    const now = fix.ctx.clock.now();
    const wake = (n: number) => addWake(fix.ctx, { jobId: job.id, startedAt: now + n }, fix.engineer.id);
    const first = wake(1);
    recordJobTurn(fix.ctx, first);
    recordJobTurn(fix.ctx, first);
    expect(usageOf(fix, job.id).steps.exec.turns).toBe(1);
    for (let n = 2; n <= D.USAGE_TURNS_MAX + 1; n += 1) recordJobTurn(fix.ctx, wake(n));
    const row = usageOf(fix, job.id);
    expect(row.turns).toHaveLength(D.USAGE_TURNS_MAX);
    expect(row.turns.some(turn => turn.wakeId === first.id)).toBe(false);
    expect(row.steps.exec.turns).toBe(D.USAGE_TURNS_MAX + 1);
  });

  it('recordUsage 补 token：实测按 tokenBase 向上取整；用估算时小数向上取整；已补过的不重复补；唤醒单不属于这件事时不动', async () => {
    const fix = await jobFix();
    const { job } = await runningJob(fix);
    const ticket = runningOf(fix, fix.engineer.id)!;
    recordUsage(fix.ctx, { botId: fix.engineer.id, wakeId: ticket.id, tokens: 1234, steps: 1, packetBytes: 0 });
    expect(usageOf(fix, job.id).steps.exec).toEqual({ turns: 1, tokens: 1234 });
    expect(usageOf(fix, job.id).turns[0]).toMatchObject({ tokens: 1234, endedAt: fix.ctx.clock.now() });
    // 已补过：直接再调用补记函数不再累加。
    addJobTurnTokens(fix.ctx, ticket, 99999, fix.ctx.clock.now());
    expect(usageOf(fix, job.id).steps.exec.tokens).toBe(1234);
    // 估算：没有宿主数时按字节和步数估，向上取整。
    const second = addWake(fix.ctx, { jobId: job.id, startedAt: fix.ctx.clock.now() }, fix.engineer.id);
    recordJobTurn(fix.ctx, second);
    recordUsage(fix.ctx, { botId: fix.engineer.id, wakeId: second.id, tokens: null, steps: 0, packetBytes: 1000 });
    const expected = Math.ceil(1000 / fix.ctx.settings.estimatedBytesPerToken);
    expect(usageOf(fix, job.id).turns.at(-1)).toMatchObject({ wakeId: second.id, tokens: expected });
    // 不带 jobId 的唤醒单、找不到的唤醒单：不动。
    const before = usageOf(fix, job.id);
    addJobTurnTokens(fix.ctx, { id: ticket.id, jobId: undefined }, 5000, fix.ctx.clock.now());
    addJobTurnTokens(fix.ctx, null, 5000, fix.ctx.clock.now());
    addJobTurnTokens(fix.ctx, { id: 'w_zzzzzzzzzz', jobId: job.id }, 5000, fix.ctx.clock.now());
    expect(usageOf(fix, job.id)).toEqual(before);
  });

  it('验收之后的发布回合记发布，定稿时的合计不含它', async () => {
    const { fix, job } = await delivered([], { launch: true });
    expect(await fix.hub.api.acceptJob({ jobId: job.id, stage: job.stage })).toMatchObject({ ok: true });
    const accepted = usageOf(fix, job.id);
    expect(accepted.finalizedAt).not.toBeNull();
    expect(accepted.steps.launch.turns).toBe(0);
    await tick(fix, 10 * MINUTE);
    const launching = fix.ctx.store.table('wakes').list(wake => wake.jobId === job.id && wake.botId === fix.engineer.id && wake.startedAt >= fix.ctx.store.table('jobs').get(job.id)!.acceptedAt!);
    expect(launching.length).toBeGreaterThanOrEqual(1);
    const after = usageOf(fix, job.id);
    expect(after.steps.launch.turns).toBe(launching.length);
    expect(after.finalizedAt).toBe(accepted.finalizedAt);
    expect(after.finalUsed).toBe(accepted.finalUsed);
    // 同类估计读的四步在定稿之后不被发布回合改动。
    for (const step of ['exec', 'review', 'rework', 'chief'] as const) expect(after.steps[step]).toEqual(accepted.steps[step]);
  });
});

describe('3 对齐', () => {
  it('版本的唤醒单去重、去掉没有唤醒单的版本（主人在卡上改出的）：回合数是个数，token 是这些唤醒单的实测合计', async () => {
    const fix = await jobFix();
    const { job, agreementId } = await assigned(fix);
    const agreement = fix.ctx.store.table('agreements').get(agreementId)!;
    const w1 = addWake(fix.ctx, {}, fix.chief.id);
    const w2 = addWake(fix.ctx, {}, fix.chief.id);
    addLedger(fix.ctx, w1, 1000);
    addLedger(fix.ctx, w2, 2500);
    const v = agreement.versions[0]!;
    const versions = [{ ...v, no: 1, wakeId: w1.id }, { ...v, no: 2, wakeId: w1.id }, { ...v, no: 3, wakeId: w2.id }, { ...v, no: 4, wakeId: null }];
    fix.ctx.store.table('agreements').patch(agreementId, { versions } as never);
    expect(alignmentOf(fix.ctx, fix.ctx.store.table('agreements').get(agreementId)!)).toEqual({ turns: 2, tokens: 3500 });
    recordAlignment(fix.ctx, job);
    expect(usageOf(fix, job.id).steps.align).toEqual({ turns: 2, tokens: 3500 });
    // 只有两版来自同一个唤醒单、另一版由主人改出：对齐 1 个回合。
    fix.ctx.store.table('agreements').patch(agreementId, { versions: [{ ...v, no: 1, wakeId: w1.id }, { ...v, no: 2, wakeId: w1.id }, { ...v, no: 3, wakeId: null }] } as never);
    expect(alignmentOf(fix.ctx, fix.ctx.store.table('agreements').get(agreementId)!)).toEqual({ turns: 1, tokens: 1000 });
  });

  it('账本里找不到的唤醒单按 0 token 计，回合仍算；记对齐不动用量行里别的步骤', async () => {
    const fix = await jobFix();
    const { job, agreementId } = await runningJob(fix);
    const agreement = fix.ctx.store.table('agreements').get(agreementId)!;
    fix.ctx.store.table('agreements').patch(agreementId, { versions: [{ ...agreement.versions[0]!, wakeId: 'w_nowhere0001' }] } as never);
    const before = usageOf(fix, job.id);
    recordAlignment(fix.ctx, fix.ctx.store.table('jobs').get(job.id)!);
    const after = usageOf(fix, job.id);
    expect(after.steps.align).toEqual({ turns: 1, tokens: 0 });
    expect(after.steps.exec).toEqual(before.steps.exec);
    expect(after.turns).toEqual(before.turns);
  });
});

describe('4 定稿', () => {
  it('验收：定稿时间、类别、验收那一刻的合计；定稿之后再记的回合不改合计，已定稿的不重复定稿', async () => {
    const { fix, job } = await delivered();
    const before = usageOf(fix, job.id);
    expect(before.finalizedAt).toBeNull();
    expect(await fix.hub.api.acceptJob({ jobId: job.id, stage: job.stage })).toMatchObject({ ok: true });
    const row = usageOf(fix, job.id);
    expect(row.finalizedAt).toBe(fix.ctx.clock.now());
    expect(row.category).toBe('其他');
    const turns = (Object.values(row.steps) as Array<{ turns: number; tokens: number }>);
    expect(row.finalUsed).toBe(turns.reduce((sum, step) => sum + step.turns, 0));
    expect(row.finalTokens).toBe(turns.reduce((sum, step) => sum + step.tokens, 0));
    // 对齐 1 个回合、执行者一个回合里就交回、核对人一个回合：合计 3。
    expect([row.steps.align.turns, row.steps.exec.turns, row.steps.review.turns, row.steps.rework.turns, row.steps.chief.turns]).toEqual([1, 1, 1, 0, 0]);
    expect(row.finalUsed).toBe(3);
    fix.ctx.clock.advance(MINUTE);
    finalizeJobUsage(fix.ctx, job.id);
    expect(usageOf(fix, job.id).finalizedAt).toBe(row.finalizedAt);
  });

  it('停止也定稿；没有用量行的事（旧数据）不新建行', async () => {
    const fix = await jobFix();
    const { job } = await assigned(fix);
    stopJobCore(fix.ctx, fix.ctx.store.table('jobs').get(job.id)!, { actor: 'hub', reason: '测试', via: 'owner_words', topic: { from: 'hub', kind: 'system', text: '已停止。' } });
    expect(usageOf(fix, job.id).finalizedAt).toBe(fix.ctx.clock.now());
    fix.ctx.store.table('jobUsage').remove(job.id);
    finalizeJobUsage(fix.ctx, job.id);
    expect(fix.ctx.store.table('jobUsage').get(job.id)).toBeNull();
  });
});

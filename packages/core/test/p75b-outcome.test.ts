/**
 * P75b 的测试三：同类任务记录（afterJobAccepted、onJobAccepted 的接线、兜底、读取函数）。
 * 走真实链路：派活、交回、核对退回、再交回、核对通过、主人指出不符、返工、再核对、验收；
 * 时间全部用注入的假时钟，每次推进不超过 10 分钟；夹具里的总管和员工与真实创建出来的一致（总管是听吩咐的）。
 * 需要「同一执行者的第二件、另一个类别」时，复制这件事和它的约定（改编号和类别），不另造一套流程。
 */
import { describe, expect, it } from 'vitest';
import { afterJobAccepted, outcomesFor } from '../src/job/after-accept.js';
import { agreementCategory, jobCategory } from '../src/project/agreement-category.js';
import { AgreementSchema } from '../src/model/agreement.js';
import { JobSchema, type Job } from '../src/model/job.js';
import { executorInfo, metWithImage, putStandardFiles, reviewerInfo, started, engineerSubmits, nextPacket, type JobFix } from './p74d-fixtures.js';
import { commitAndEnd } from './p74c-fixtures.js';
import { speak } from './p74b-fixtures.js';
import { bot, callTool, chiefTurn, MINUTE, ownerTypes, reopenInfo, theJob, tick } from './p74f-fixtures.js';

/** 一轮核对：第 3 条不符（写明问题和改到什么程度算过）。 */
const FAIL_THIRD = [
  { no: 1, verdict: 'at_delivery' }, { no: 2, verdict: 'met', note: '截图无横向滚动', rechecked: true },
  { no: 3, verdict: 'unmet', note: '失败时没有提示', fixTo: '断开接口后页面显示「加载失败」' },
];

/** 核对人提交一轮核对并结束回合，必须成功。 */
async function reviewOnce(fix: JobFix, jobId: string, items: unknown[]): Promise<void> {
  const result = await callTool(fix, bot(fix, fix.reviewer.id), 'hub_job_work', { mode: 'review', jobId, items });
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  await commitAndEnd(fix, fix.reviewer.id, { outcome: 'progress', summary: '核对完成' });
}

/** 执行者针对第 3 条重新交回并结束回合，必须成功。 */
async function resubmitThird(fix: JobFix, jobId: string): Promise<void> {
  const info = executorInfo(await nextPacket(fix, fix.engineer.id));
  await putStandardFiles(fix, info);
  const result = await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', {
    mode: 'submit', jobId, changeNote: '补上了失败提示', deliverables: ['交付/报价页.html'], items: [metWithImage(3, '证据/桌面.png')],
  });
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '已交回' });
}

/**
 * 走完一件事：阶段 1 两轮核对（第 1 轮退回 1 条）、主人验收时指出第 3 条不符、阶段 2 一轮核对通过，
 * 停在「等主人验收」。共 3 次真实核对、1 次验收返工。
 */
async function twoStagesAwaitingOwner(): Promise<{ fix: JobFix; job: Job }> {
  const s = await started();
  await engineerSubmits(s.fix, s.info);
  await commitAndEnd(s.fix, s.fix.engineer.id, { outcome: 'progress', summary: '已交回' });
  await reviewOnce(s.fix, reviewerInfo(await nextPacket(s.fix, s.fix.reviewer.id)).jobId, FAIL_THIRD);
  await resubmitThird(s.fix, s.job.id);
  await reviewOnce(s.fix, reviewerInfo(await nextPacket(s.fix, s.fix.reviewer.id)).jobId, [{ no: 3, verdict: 'met' }]);
  expect(theJob(s.fix).state).toBe('awaiting_owner');
  // 主人验收时指出第 3 条不符，总管用 reopen 退回；阶段加 1。
  await ownerTypes(s.fix, theJob(s.fix).topicId, '第 3 条还是不对：失败时页面没有任何提示');
  const seen = reopenInfo(await chiefTurn(s.fix));
  const reopened = await callTool(s.fix, bot(s.fix, s.fix.chief.id), 'hub_job_manage', { mode: 'reopen', jobId: seen.jobId,
    items: [{ no: 3, problem: '失败时页面没有任何提示', fixTo: '断开接口后页面显示「加载失败」' }], missed: '核对时没有试断开接口，这次要试' });
  expect(reopened, JSON.stringify(reopened)).toMatchObject({ ok: true });
  await speak(s.fix, bot(s.fix, s.fix.chief.id), '返工第 3 条，预计今天内再交给你。', { outcome: 'progress' });
  await resubmitThird(s.fix, s.job.id);
  await reviewOnce(s.fix, reviewerInfo(await nextPacket(s.fix, s.fix.reviewer.id)).jobId, [{ no: 3, verdict: 'met' }]);
  const job = theJob(s.fix);
  expect(job).toMatchObject({ state: 'awaiting_owner', stage: 2 });
  return { fix: s.fix, job };
}

/** 复制一件已验收的事和它的约定（改编号与类别），用来造「同一执行者的第二件、另一个类别」。 */
function cloneAccepted(fix: JobFix, base: Job, suffix: string, category: string, acceptedAt: number): Job {
  const agreement = fix.ctx.store.table('agreements').get(base.agreementId)!;
  const agreementId = `agr_${suffix}`;
  fix.ctx.store.table('agreements').put(AgreementSchema.parse({ ...agreement, id: agreementId }));
  fix.ctx.store.table('agreementTags').put({ id: agreementId, category, setAt: acceptedAt });
  const job = JobSchema.parse({ ...base, id: `job_${suffix}`, agreementId, acceptedAt, ownerReturns: undefined });
  fix.ctx.store.table('jobs').put(job);
  return job;
}

describe('7 同类任务记录：数字来自记录', () => {
  it('两阶段共 3 次核对、验收返工 1 次：rounds 为 3、reworks 为 1、turns 等于 turnsUsed、seq 为 1；验收之后自动有这一行', async () => {
    const { fix, job } = await twoStagesAwaitingOwner();
    expect(fix.ctx.store.table('jobOutcomes').count()).toBe(0); // 验收之前没有
    expect(await fix.hub.api.acceptJob({ jobId: job.id, stage: job.stage })).toMatchObject({ ok: true });
    const done = theJob(fix);
    expect(done.state).toBe('done');
    // 没有任何手工调用 afterJobAccepted：这一行是 acceptJob 第二段最后自动写的。
    expect(fix.ctx.store.table('jobOutcomes').list()).toEqual([{
      id: job.id, category: '其他', executorId: fix.engineer.id, reviewerId: fix.reviewer.id, title: '会员定价页',
      rounds: 3, reworks: 1, turns: done.turnsUsed, seq: 1, acceptedAt: done.acceptedAt,
    }]);
    expect(done.turnsUsed).toBeGreaterThan(0);
    expect(jobCategory(fix.ctx, job.id)).toBe('其他');
  });

  it('同一执行者同类别第二件 seq 为 2，不同类别 seq 为 1；中心自己重排的核对记录不计入 rounds', async () => {
    const { fix, job } = await twoStagesAwaitingOwner();
    await fix.hub.api.acceptJob({ jobId: job.id, stage: job.stage });
    const first = theJob(fix);
    const second = cloneAccepted(fix, first, 'bbbbbbbbbb', '其他', first.acceptedAt! + 1000);
    const third = cloneAccepted(fix, first, 'cccccccccc', '数据核对', first.acceptedAt! + 2000);
    // 第二件：两份核对人的核对 + 一份中心重排的（byCenter），rounds 只算前两份。
    const review = fix.ctx.store.table('jobReviews').list(row => row.jobId === first.id)[0]!;
    fix.ctx.store.table('jobReviews').put({ ...review, id: 'jrv_bbbbbbbbb1', jobId: second.id });
    fix.ctx.store.table('jobReviews').put({ ...review, id: 'jrv_bbbbbbbbb2', jobId: second.id, round: 2 });
    fix.ctx.store.table('jobReviews').put({ ...review, id: 'jrv_bbbbbbbbb3', jobId: second.id, byCenter: true });
    await afterJobAccepted(fix.ctx, second.id);
    await afterJobAccepted(fix.ctx, third.id);
    expect(fix.ctx.store.table('jobOutcomes').get(second.id)).toMatchObject({ category: '其他', seq: 2, rounds: 2, reworks: 0 });
    expect(fix.ctx.store.table('jobOutcomes').get(third.id)).toMatchObject({ category: '数据核对', seq: 1, rounds: 0 });
    expect(agreementCategory(fix.ctx, third.agreementId)).toBe('数据核对');
  });

  it('outcomesFor：只取这位员工这个类别的记录，按验收时间从早到晚', async () => {
    const { fix, job } = await twoStagesAwaitingOwner();
    await fix.hub.api.acceptJob({ jobId: job.id, stage: job.stage });
    const first = theJob(fix);
    const later = cloneAccepted(fix, first, 'bbbbbbbbbb', '其他', first.acceptedAt! + 5000);
    const earlier = cloneAccepted(fix, first, 'cccccccccc', '其他', first.acceptedAt! - 5000);
    cloneAccepted(fix, first, 'dddddddddd', '设计稿', first.acceptedAt! + 1);
    // 先写「晚的」，再写「早的」：读取时仍按验收时间排序。
    await afterJobAccepted(fix.ctx, later.id);
    await afterJobAccepted(fix.ctx, earlier.id);
    await afterJobAccepted(fix.ctx, 'job_dddddddddd');
    expect(outcomesFor(fix.ctx, fix.engineer.id, '其他').map(row => row.id)).toEqual([earlier.id, first.id, later.id]);
    expect(outcomesFor(fix.ctx, fix.engineer.id, '设计稿')).toHaveLength(1);
    expect(outcomesFor(fix.ctx, fix.reviewer.id, '其他')).toEqual([]);
  });
});

describe('8 同类任务记录：幂等、出错不影响验收、兜底', () => {
  it('afterJobAccepted 重复调用只有一行；还没验收的事、不存在的事不写', async () => {
    const { fix, job } = await twoStagesAwaitingOwner();
    await afterJobAccepted(fix.ctx, job.id); // 等主人验收中：没有验收时间，不写
    expect(fix.ctx.store.table('jobOutcomes').count()).toBe(0);
    await afterJobAccepted(fix.ctx, 'job_zzzzzzzzzz');
    await fix.hub.api.acceptJob({ jobId: job.id, stage: job.stage });
    await afterJobAccepted(fix.ctx, job.id);
    await afterJobAccepted(fix.ctx, job.id);
    expect(fix.ctx.store.table('jobOutcomes').count()).toBe(1);
  });

  it('afterJobAccepted 抛错时验收照常完成（主人的话、回执都在），下一个 tick 由兜底补上同样内容的一行', async () => {
    const { fix, job } = await twoStagesAwaitingOwner();
    // 让同类任务记录表的写入失败；其余表照常。
    const store = fix.ctx.store as unknown as { table: (name: string) => object };
    const originalTable = store.table.bind(store);
    store.table = (name: string) => {
      const table = originalTable(name);
      if (name !== 'jobOutcomes') return table;
      return new Proxy(table, {
        get(target, prop) {
          if (prop === 'put') return () => { throw new Error('磁盘写入失败'); };
          const value = Reflect.get(target, prop);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    };
    const accepted = await fix.hub.api.acceptJob({ jobId: job.id, stage: job.stage });
    store.table = originalTable;
    expect(accepted).toMatchObject({ ok: true });
    const done = theJob(fix);
    expect(done).toMatchObject({ state: 'done', acceptedAt: expect.any(Number) });
    const topic = fix.ctx.store.log('thread').all().filter(row => row.thread === done.topicId);
    expect(topic.some(row => row.text === '会员定价页已完成。')).toBe(true);
    expect(topic.some(row => row.kind === 'job_card' && row.refId === `receipt:${job.id}`)).toBe(true);
    expect(fix.ctx.store.table('jobOutcomes').count()).toBe(0);
    // 下一个 tick：兜底补上，数字与正常路径一致。
    await tick(fix, MINUTE);
    expect(fix.ctx.store.table('jobOutcomes').list()).toEqual([{
      id: job.id, category: '其他', executorId: fix.engineer.id, reviewerId: fix.reviewer.id, title: '会员定价页',
      rounds: 3, reworks: 1, turns: done.turnsUsed, seq: 1, acceptedAt: done.acceptedAt,
    }]);
    // 再多走几个 tick 也不会重复。
    await tick(fix, MINUTE);
    await tick(fix, MINUTE);
    expect(fix.ctx.store.table('jobOutcomes').count()).toBe(1);
  });

  it('很久以前验收、没有记录的事，兜底也会补上（不设时间范围）；没验收的事不补', async () => {
    const { fix, job } = await twoStagesAwaitingOwner();
    await fix.hub.api.acceptJob({ jobId: job.id, stage: job.stage });
    const accepted = theJob(fix);
    // 把验收时间改到 60 天前，并去掉记录：等于升级前验收、没有记录的老事。
    const longAgo = accepted.acceptedAt! - 60 * 24 * 60 * MINUTE;
    fix.ctx.store.table('jobs').put(JobSchema.parse({ ...accepted, acceptedAt: longAgo }));
    fix.ctx.store.table('jobOutcomes').remove(job.id);
    // 另一件还在等验收的事（复制出来，状态改回等验收、没有验收时间）：不补。
    const pendingOne = JobSchema.parse({ ...accepted, id: 'job_pppppppppp', agreementId: 'agr_pppppppppp', state: 'awaiting_owner', acceptedAt: null });
    fix.ctx.store.table('jobs').put(pendingOne);
    await tick(fix, MINUTE);
    expect(fix.ctx.store.table('jobOutcomes').list()).toMatchObject([{ id: job.id, acceptedAt: longAgo, rounds: 3, reworks: 1, seq: 1 }]);
    expect(fix.ctx.store.table('jobOutcomes').get(pendingOne.id)).toBeNull();
  });
});

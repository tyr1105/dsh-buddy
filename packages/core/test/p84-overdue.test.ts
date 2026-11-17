/**
 * P84 的测试：逾期条目在各种先后顺序下留得住、不挡路（复验 K1 到 K4），以及「已用 / 预计」与原因行的口径（K5 到 K7）。
 *
 * 全部走真实 Hub（总管自动创建、听吩咐；执行者林舟听吩咐；额度灯为绿）；每条用例的预算线为默认份额（预算线 8），
 * 额度灯为绿。时间用注入的假时钟，每次推进不超过 10 分钟，2 小时写成循环。
 * 对应关系：
 *   1 K1 核对人提交结论时，逾期条目不被撤回；通过时由验收条目取代；停摆的条目仍撤回。
 *   2 K2 逾期条目不算「真的在等主人」；转受阻时撤回；停摆的条目在受阻的事上仍挡住总管。
 *   3 K3 逾期通知发不出去时，停摆的重新唤醒照做。
 *   4 K4 逾期条目了结时清记号。
 *   5 K5 主题进度行的「已用 / 预计」不含发布回合。
 *   6 K6、K7 转交材料的叫法与原因行。
 */
import { describe, expect, it } from 'vitest';
import { activeJobsView } from '../src/api/active-jobs-views.js';
import { jobProgressForTopic } from '../src/api/job-topic-views.js';
import { overrunReasons } from '../src/job/budget.js';
import { budgetBody } from '../src/job/budget-text.js';
import { ownerAskOpenOf } from '../src/job/owner-ask.js';
import { reportStall } from '../src/job/stall.js';
import { appendJobEvent, eventsOf } from '../src/job/store.js';
import { PASS_ITEMS } from './p74f-fixtures.js';
import { MINUTE, advanceSweeping, chiefSays, dropQueue, noticeRow, stallItems, sweepNow, waitForPacket } from './p76g-fixtures.js';
import { askedNotReached, openCap } from './p76f-fixtures.js';
import { HOUR, putUsage, sceneA } from './p76i-fixtures.js';
import { bot, callTool, engineerSubmits, reviewerInfo, runningOf, started, theJob, threadOf, tick, type JobFix } from './p74d-fixtures.js';
import { commitAndEnd } from './p74c-fixtures.js';
import { speak } from './p74r2b-fixtures.js';
import { ownerSays } from './p74b-fixtures.js';
import { applyJobAction } from '../src/job/state.js';

/** 第 3 条不符的一轮核对结论。 */
const FAIL_ITEMS = [{ no: 1, verdict: 'at_delivery' }, { no: 2, verdict: 'met' },
  { no: 3, verdict: 'unmet', note: '失败时没有提示', fixTo: '断开接口后页面显示「加载失败」' }];

/** 这件事的中心重新唤醒过几次。 */
function idleResumes(fix: JobFix, jobId: string): number {
  return eventsOf(fix.ctx, jobId).filter(row => row.kind === 'resumed' && row.data.idle === true).length;
}

/**
 * 起点：执行者交回，核对人拿到了回合（这件事在核对中，核对人的回合还开着）；交付时间随后改成 1 分钟前，巡检一次建出逾期条目。
 * 返回夹具、这件事的编号、逾期条目。
 */
async function checkingOverdue() {
  const s = await started();
  const { fix, job } = s;
  await engineerSubmits(fix, s.info);
  await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '已交回' });
  const seen = reviewerInfo(await waitForPacket(fix, fix.reviewer.id, 30));
  fix.ctx.store.table('jobs').patch(job.id, { dueAt: fix.ctx.clock.now() - MINUTE });
  sweepNow(fix);
  const [item] = stallItems(fix, job.id);
  expect(item).toMatchObject({ status: 'open', title: '会员定价页：已过交付时间' });
  expect(theJob(fix)).toMatchObject({ state: 'checking', inboxId: item!.id });
  return { fix, job, seen, item: item! };
}

describe('1 K1：核对人提交结论时，逾期条目不被撤回', () => {
  it('核对不通过：逾期条目仍开着、编号不清、这个交付时间不会再通知；这件事转返工中', async () => {
    const { fix, job, seen, item } = await checkingOverdue();
    const notified = noticeRow(fix, job.id)!.overdueNotifiedFor;
    expect(notified).not.toBeNull();
    expect(await callTool(fix, bot(fix, fix.reviewer.id), 'hub_job_work', { mode: 'review', jobId: seen.jobId, items: FAIL_ITEMS })).toMatchObject({ ok: true });
    expect(theJob(fix).state).toBe('rework');
    expect(fix.ctx.store.table('inbox').get(item.id)).toMatchObject({ status: 'open' });
    expect(theJob(fix).inboxId).toBe(item.id);
    expect(noticeRow(fix, job.id)).toMatchObject({ overdueNotifiedFor: notified, stallKind: 'overdue' });
  });

  it('核对通过：这件事转待你验收，逾期条目由验收条目取代（现有逻辑不变）', async () => {
    const { fix, job, seen, item } = await checkingOverdue();
    expect(await callTool(fix, bot(fix, fix.reviewer.id), 'hub_job_work', { mode: 'review', jobId: seen.jobId, items: PASS_ITEMS })).toMatchObject({ ok: true });
    await commitAndEnd(fix, fix.reviewer.id, { outcome: 'progress', summary: '核对通过' });
    await tick(fix, MINUTE);
    expect(theJob(fix).state).toBe('awaiting_owner');
    expect(fix.ctx.store.table('inbox').get(item.id)).toMatchObject({ status: 'withdrawn' });
    expect(theJob(fix).inboxId).not.toBe(item.id);
    expect(noticeRow(fix, job.id)!.stallKind).toBeNull();
  });

  it('反例：停摆的条目在核对不通过时仍然撤回，答复栏「核对结论已提交」，编号清空', async () => {
    const s = await started();
    const { fix, job } = s;
    await engineerSubmits(fix, s.info);
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '已交回' });
    const seen = reviewerInfo(await waitForPacket(fix, fix.reviewer.id, 30));
    expect(reportStall(fix.ctx, theJob(fix), 'idle', fix.ctx.clock.now(), { actorId: fix.reviewer.id })).toBe(true);
    const [idle] = stallItems(fix, job.id);
    expect(theJob(fix).inboxId).toBe(idle!.id);
    expect(await callTool(fix, bot(fix, fix.reviewer.id), 'hub_job_work', { mode: 'review', jobId: seen.jobId, items: FAIL_ITEMS })).toMatchObject({ ok: true });
    expect(fix.ctx.store.table('inbox').get(idle!.id)).toMatchObject({ status: 'withdrawn', answer: '核对结论已提交' });
    expect(theJob(fix).inboxId).toBeNull();
  });
});

describe('2 K2：逾期条目不算「真的在等主人」', () => {
  it('逾期条目开着、执行者说明做不下去：这件事转受阻，总管很快拿到回合；逾期条目撤回，答复栏逐字，同一个交付时间不再通知', async () => {
    const { fix, job } = await started();
    fix.ctx.store.table('jobs').patch(job.id, { dueAt: fix.ctx.clock.now() - MINUTE });
    sweepNow(fix);
    const [item] = stallItems(fix, job.id);
    expect(item).toMatchObject({ status: 'open' });
    const notified = noticeRow(fix, job.id)!.overdueNotifiedFor;
    expect(theJob(fix).inboxId).toBe(item!.id);
    // 执行者说明做不下去并结束回合。
    expect(await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', { mode: 'block', jobId: job.id, stuckAt: '缺报价接口的文档', tried: ['查了仓库'] })).toMatchObject({ ok: true });
    expect(theJob(fix)).toMatchObject({ state: 'blocked', blocked: { kind: 'executor' } });
    // 逾期条目开着也不算「真的在等主人」（受阻之后也一样）。
    expect(ownerAskOpenOf(fix.ctx, theJob(fix))).toBe(false);
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '已说明' });
    // 总管不被挡住：几分钟内拿到写说明的回合。
    expect(await waitForPacket(fix, fix.chief.id, 30)).toContain('做不下去');
    // 下一次巡检撤回逾期条目：答复栏逐字，编号清空，交付时间的通知记号不变。
    expect(fix.ctx.store.table('inbox').get(item!.id)).toMatchObject({ status: 'withdrawn', answer: '这件事已转为受阻，另有说明' });
    expect(theJob(fix).inboxId).toBeNull();
    expect(noticeRow(fix, job.id)).toMatchObject({ overdueNotifiedFor: notified, stallKind: null });
    // 之后不再通知同一个交付时间：不再建新的逾期条目。
    advanceSweeping(fix, 60 * MINUTE);
    expect(stallItems(fix, job.id)).toHaveLength(1);
  });

  it('C2：先受阻、之后才过交付时间：逾期条目建出后经过几次巡检仍然开着，答复栏为空，不算甲', async () => {
    const { fix, job } = await started();
    expect(await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', { mode: 'block', jobId: job.id, stuckAt: '缺文档', tried: ['查了仓库'] })).toMatchObject({ ok: true });
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '已说明' });
    expect(theJob(fix).state).toBe('blocked');
    fix.ctx.clock.advance(5 * MINUTE);
    fix.ctx.store.table('jobs').patch(job.id, { dueAt: fix.ctx.clock.now() - MINUTE });
    sweepNow(fix);
    const [item] = stallItems(fix, job.id);
    expect(item).toMatchObject({ status: 'open', title: '会员定价页：已过交付时间' });
    advanceSweeping(fix, 30 * MINUTE);
    expect(stallItems(fix, job.id)).toHaveLength(1);
    expect(fix.ctx.store.table('inbox').get(item!.id)).toMatchObject({ status: 'open', answer: null });
    expect(ownerAskOpenOf(fix.ctx, theJob(fix))).toBe(false);
  });

  it('反例：停摆的条目在受阻的事上仍然算「真的在等主人」（挡住总管）', async () => {
    const { fix, job } = await started();
    expect(await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', { mode: 'block', jobId: job.id, stuckAt: '缺文档', tried: ['查了仓库'] })).toMatchObject({ ok: true });
    expect(theJob(fix).state).toBe('blocked');
    expect(ownerAskOpenOf(fix.ctx, theJob(fix))).toBe(false);
    expect(reportStall(fix.ctx, theJob(fix), 'idle', fix.ctx.clock.now(), { actorId: fix.chief.id })).toBe(true);
    expect(noticeRow(fix, job.id)!.stallKind).toBe('idle');
    expect(ownerAskOpenOf(fix.ctx, theJob(fix))).toBe(true);
  });
});

describe('3 K3：逾期通知被挡住期间，停摆的重新唤醒照做', () => {
  it('「将超出预计」条目开着、逾期，接力断了：2 小时后重新唤醒一次，没有建逾期条目', async () => {
    const { fix, job } = await askedNotReached();
    const cap = openCap(fix, job.id)!;
    fix.ctx.clock.advance(MINUTE);
    appendJobEvent(fix.ctx, { jobId: job.id, actor: 'hub', kind: 'forwarded', to: [fix.engineer.id], refId: null, data: {} });
    dropQueue(fix, fix.engineer.id, job.id);
    fix.ctx.store.table('jobs').patch(job.id, { dueAt: fix.ctx.clock.now() - MINUTE });
    advanceSweeping(fix, 130 * MINUTE);
    expect(idleResumes(fix, job.id)).toBe(1);
    // 通知仍被条目挡住：没有建「没有进展」条目，也没有写 overdueNotifiedFor。
    expect(stallItems(fix, job.id)).toHaveLength(0);
    expect(noticeRow(fix, job.id)!.overdueNotifiedFor).toBeNull();
    expect(fix.ctx.store.table('inbox').get(cap.id)).toMatchObject({ status: 'open' });
  });
});

describe('4 K4：逾期条目了结时清掉记号', () => {
  it('你答复逾期条目：记号清空；之后新建的「回合被结束」条目不被「交付时间已改」撤回', async () => {
    const { fix, job } = await started();
    fix.ctx.store.table('jobs').patch(job.id, { dueAt: fix.ctx.clock.now() - MINUTE });
    sweepNow(fix);
    const [item] = stallItems(fix, job.id);
    expect(noticeRow(fix, job.id)!.stallKind).toBe('overdue');
    expect(await fix.hub.api.answerJobStall({ jobId: job.id, answer: '再提醒一次' })).toMatchObject({ ok: true });
    expect(fix.ctx.store.table('inbox').get(item!.id)).toMatchObject({ status: 'answered' });
    expect(noticeRow(fix, job.id)!.stallKind).toBeNull();
    // 交付时间改到很久以后，巡检一次；再建一条「回合被结束」条目，之后巡检：条目仍开着。
    fix.ctx.store.table('jobs').patch(job.id, { dueAt: fix.ctx.clock.now() + 10 * HOUR });
    sweepNow(fix);
    expect(reportStall(fix.ctx, theJob(fix), 'ended', fix.ctx.clock.now(), { actorId: fix.chief.id, facts: { body: '总管核对的回合被结束了两次。', thread: '总管核对的回合被结束了两次。' } })).toBe(true);
    const ended = stallItems(fix, job.id).find(row => row.status === 'open')!;
    fix.ctx.clock.advance(MINUTE);
    sweepNow(fix);
    expect(fix.ctx.store.table('inbox').get(ended.id)).toMatchObject({ status: 'open' });
  });

  it('改了交付时间撤回逾期条目：记号同时清空；条目被别的路径了结（直接标成撤回）时下一次巡检清掉', async () => {
    const { fix, job } = await started();
    fix.ctx.store.table('jobs').patch(job.id, { dueAt: fix.ctx.clock.now() - MINUTE });
    sweepNow(fix);
    fix.ctx.store.table('jobs').patch(job.id, { dueAt: fix.ctx.clock.now() + 30 * MINUTE });
    sweepNow(fix);
    expect(noticeRow(fix, job.id)!.stallKind).toBeNull();
  });

  it('逾期条目被别的路径了结（直接标成撤回，模拟被别的条目取代）：下一次巡检清掉记号', async () => {
    const { fix, job } = await started();
    fix.ctx.store.table('jobs').patch(job.id, { dueAt: fix.ctx.clock.now() - MINUTE });
    sweepNow(fix);
    const [open] = stallItems(fix, job.id);
    expect(noticeRow(fix, job.id)!.stallKind).toBe('overdue');
    fix.ctx.store.table('inbox').patch(open!.id, { status: 'withdrawn', answer: '别的原因', answeredAt: fix.ctx.clock.now() });
    fix.ctx.clock.advance(MINUTE);
    sweepNow(fix);
    expect(noticeRow(fix, job.id)!.stallKind).toBeNull();
  });
});

describe('5 K5：主题进度行的「已用 / 预计」不含发布回合', () => {
  it('发布环节的事：进度行与「在办的事」同为 9 / 14 回合；分布里仍列「发布 3」', async () => {
    const { ctx, fix, report } = await sceneA();
    ctx.store.table('jobs').patch(report.id, { state: 'done', launch: { state: 'preparing', approvalId: null, link: null } });
    putUsage(ctx, report, { align: { turns: 1, tokens: 40_000 }, exec: { turns: 5, tokens: 1_000_000 }, review: { turns: 2, tokens: 200_000 },
      rework: { turns: 1, tokens: 160_000 }, launch: { turns: 3, tokens: 0 } });
    const progress = jobProgressForTopic(ctx, report.topicId)!;
    expect(progress.costLine!.startsWith('消耗：9 / 14 回合')).toBe(true);
    expect(progress.costLine).toContain('发布 3');
    // 回合明细仍列全部回合（这里没有逐回合记录）。
    const row = activeJobsView(ctx, fix.chief.id).rows.find(item => item.key === report.id)!;
    expect(row.costText.startsWith('9 / 14 回合')).toBe(true);
  });
});

describe('6 K6、K7：文字', () => {
  it('K7：返工中，或执行中且待改清单不为空：原因行写「返工已用 k 回合，还没有交回」；反例：待你验收、核对中不写', () => {
    const usage = (rework: number) => ({ steps: {
      align: { turns: 1, tokens: 0 }, exec: { turns: 3, tokens: 0 }, review: { turns: 1, tokens: 0 },
      rework: { turns: rework, tokens: 0 }, chief: { turns: 0, tokens: 0 }, launch: { turns: 0, tokens: 0 } } });
    const estimate = { steps: { align: 1, exec: 3, review: 1, rework: 3, chief: 1 } };
    expect(overrunReasons(usage(2), estimate, { state: 'rework', unmet: [] })).toEqual(['返工已用 2 回合，还没有交回']);
    expect(overrunReasons(usage(1), estimate, { state: 'doing', unmet: [{ no: 3 } as never] })).toEqual(['返工已用 1 回合，还没有交回']);
    // k 为 0 时不写（落到兜底句）；k 为 1 时写。
    expect(overrunReasons(usage(0), estimate, { state: 'rework', unmet: [] })).toEqual([]);
    expect(overrunReasons(usage(1), estimate, { state: 'rework', unmet: [] })).toEqual(['返工已用 1 回合，还没有交回']);
    expect(overrunReasons(usage(2), estimate, { state: 'awaiting_owner', unmet: [] })).toEqual([]);
    expect(overrunReasons({ steps: { ...usage(2).steps, review: { turns: 0, tokens: 0 } } }, estimate, { state: 'checking', unmet: [] })).toEqual([]);
  });

  it('K7：兜底句逐字；有原因时第二行写原因', () => {
    const base = { usedAll: 7, total: 9, needAll: 10, reasons: [] as string[], n: 2, tokenLow: 1, tokenHigh: 2 };
    expect(budgetBody({ ...base, reason: 'projected' }).split('\n')[1]).toBe('按现在的进度，做完还需要的回合超过了预计。');
    expect(budgetBody({ ...base, reason: 'projected', reasons: ['返工已用 2 回合，还没有交回'] }).split('\n')[1]).toBe('超出的部分：返工已用 2 回合，还没有交回。');
  });

  it('K7 复验路径：默认份额，第 3 个执行回合交回、第 1 轮核对退回、返工用了 2 个回合还没交回：「将超出预计」条目第二行是新加的那一句', async () => {
    const s = await started();
    const { fix, job } = s;
    // 执行 3 个回合（第 3 个交回）：先 2 个 progress，再交回。
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '先做着' });
    for (let i = 0; i < 2; i += 1) {
      await waitForPacket(fix, fix.engineer.id, 30);
      if (i === 0) { await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '先做着' }); continue; }
      await engineerSubmits(fix, s.info);
      await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '已交回' });
    }
    expect(openCap(fix, job.id), '交回之前没有问过').toBeUndefined();
    const seen = reviewerInfo(await waitForPacket(fix, fix.reviewer.id, 30));
    expect(await callTool(fix, bot(fix, fix.reviewer.id), 'hub_job_work', { mode: 'review', jobId: seen.jobId, items: FAIL_ITEMS })).toMatchObject({ ok: true });
    await commitAndEnd(fix, fix.reviewer.id, { outcome: 'progress', summary: '核对未通过' });
    // 返工用 2 个回合，还没有交回。
    for (let i = 0; i < 2; i += 1) {
      await waitForPacket(fix, fix.engineer.id, 30);
      await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '改着' });
    }
    await tick(fix, MINUTE);
    const cap = openCap(fix, job.id);
    expect(cap, JSON.stringify(theJob(fix))).toBeDefined();
    expect(cap!.title).toBe('会员定价页：消耗将超出预计');
    expect(cap!.body.split('\n')[1]).toBe('超出的部分：返工已用 2 回合，还没有交回。');
    expect(chiefSays(fix).join('\n')).not.toContain('按现在的进度');
  });

  it('K6：因预算线受阻的事，转交材料的话：有预计写「已用到预计消耗」；没有预计的旧事保留「回合用到上限」', async () => {
    for (const hasEstimate of [true, false]) {
      const { fix, job } = await started();
      if (!hasEstimate) fix.ctx.store.table('jobEstimates').remove(job.agreementId);
      fix.ctx.store.table('jobs').put(applyJobAction(theJob(fix), { type: 'block', kind: 'turn_cap', no: null, text: '回合用完' }, fix.ctx.clock.now()));
      // 总管在主人发起的回合里转交一份材料：只存文件，不叫人，返回文字写停在哪。
      for (const who of [fix.engineer, fix.reviewer]) if (runningOf(fix, who.id)) await commitAndEnd(fix, who.id, { outcome: 'progress', summary: '先收尾' });
      if (runningOf(fix, fix.chief.id)) await speak(fix, bot(fix, fix.chief.id), '好。', { outcome: 'progress' });
      await ownerSays(fix, fix.chief.id, '补一份材料。');
      const result = await callTool(fix, fix.chief, 'hub_job_manage', { mode: 'forward', jobId: job.id, title: '价格表', text: '价格表的原文' });
      const why = hasEstimate ? '已用到预计消耗' : '回合用到上限';
      expect(result, String(hasEstimate)).toEqual({ ok: true, text: `已存为主题文件「价格表」。这件事现在停在：${why}，材料等它恢复后林舟会看到。` });
      // 总管私聊里落的是同一句，叫法一致。
      expect(threadOf(fix.ctx, fix.chief.id).map(row => row.text).join('\n'), String(hasEstimate)).toContain(`这件事现在停在：${why}，`);
    }
  });
});

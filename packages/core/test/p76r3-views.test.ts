/**
 * P76r3 的测试（三）：约定新版本的预计与各视图的口径（审查 R5、R6、R14 前半）、离开期间摘要的「在等你{事项}」（R9）、
 * 核对结论撤回「没有进展」条目时的答复栏（R10 第 1 点）。
 *
 * 一部分走真实 Hub（约定改版、核对），一部分是纯函数（一句的对照表）。
 * 额度灯为绿；预算线在真实 Hub 的用例里写明。
 */
import { describe, expect, it } from 'vitest';
import { latestEstimate } from '../src/job/estimate.js';
import { jobProgressForTopic } from '../src/api/job-topic-views.js';
import { activeJobsView } from '../src/api/active-jobs-views.js';
import { sentenceOf, type AwayJobInput } from '../src/api/away-views.js';
import { reportStall } from '../src/job/stall.js';
import { PASS_ITEMS } from './p74f-fixtures.js';
import { callTool, bot, commitAndEnd, nextPacket, reachedAfterAsked, theJob } from './p76f-fixtures.js';
import { sectionOf, engineerSubmits, reviewerInfo, started } from './p74d-fixtures.js';
import { HOUR, MINUTE, NOW, putEstimate, putUsage, sceneA } from './p76i-fixtures.js';

describe('1 R5、R6：约定新版本不写 draft；两个视图的预计与条目一致', () => {
  it('有进行中的事时提交新版本：不写 draft；主题进度行与「在办的事」分母都取当前生效的预计', async () => {
    const { fix, job } = await reachedAfterAsked();
    expect(await fix.hub.api.answerJobCap({ jobId: job.id, answer: '缩小范围' })).toMatchObject({ ok: true });
    const text = sectionOf(await nextPacket(fix, fix.chief.id));
    const agreementId = /agreementId 写 (agr_[0-9a-z]{10})/.exec(text)![1]!;
    const paragraph = text.slice(text.indexOf('主人选了缩小范围。约定里还没通过的条目：'));
    const items = [...paragraph.matchAll(/^doneWhen (\d+)\. (.+)$/gm)];
    expect(items.length).toBeGreaterThan(0);
    expect(await callTool(fix, bot(fix, fix.chief.id), 'hub_agreement_submit', {
      mode: 'revise', agreementId, changeNote: '放宽第 3 条的要求，先把能用的部分做完',
      doneWhen: items.map(match => (Number(match[1]) === 3 ? '价格页能正常打开，三档价格都显示' : match[2]!)),
      continuing: ['第 1、2 条对应的工作'], paused: ['第 3 条对应的工作'],
    })).toMatchObject({ ok: true });
    await commitAndEnd(fix, fix.chief.id, { outcome: 'progress', summary: '已拟好新版本' });
    // R5：这一版在等确认，但没有写 draft（这一版还没生效）。
    const versions = fix.ctx.store.table('jobEstimates').get(job.agreementId)!.versions;
    expect(versions.some(row => row.versionNo === 2 && row.reason === 'draft')).toBe(false);
    const estimate = latestEstimate(fix.ctx, job.agreementId)!;
    // R6：主题进度行的消耗与「在办的事」的消耗用同一个分母。
    const progress = jobProgressForTopic(fix.ctx, job.topicId)!;
    expect(progress.costLine).toContain(` / ${estimate.total} 回合`);
    const row = activeJobsView(fix.ctx, fix.chief.id).rows.find(item => item.key === job.id)!;
    expect(row.costText).toContain(`${estimate.total} 回合`);
    expect(row.costText.startsWith(`${(progress.costLine!.match(/消耗：(\d+) \//) ?? [])[1]} / ${estimate.total} 回合`)).toBe(true);
  });

  it('发布环节：已用与消耗条不含发布的回合，比例不超过 100%', async () => {
    const { ctx, fix, report } = await sceneA();
    ctx.store.table('jobs').patch(report.id, { state: 'done', launch: { state: 'preparing', approvalId: null, link: null } });
    putUsage(ctx, report, { align: { turns: 1, tokens: 40_000 }, exec: { turns: 5, tokens: 1_000_000 }, review: { turns: 2, tokens: 200_000 },
      rework: { turns: 1, tokens: 160_000 }, launch: { turns: 3, tokens: 0 } });
    putEstimate(ctx, report.agreementId, 14);
    const row = activeJobsView(ctx, fix.chief.id).rows.find(item => item.key === report.id)!;
    expect(row.costText.startsWith('9 / 14 回合')).toBe(true); // 9 = 1 + 5 + 2 + 1，不含发布的 3 个
    expect(row.costRatio).not.toBeNull();
    expect(row.costRatio!).toBeLessThanOrEqual(1);
  });

  it('R14 前半：停摆已经重新唤醒、还没到通知时，也显示「{时长}没有进展」', async () => {
    const { ctx, fix, report } = await sceneA();
    ctx.store.table('jobs').patch(report.id, { state: 'doing', round: 0 });
    ctx.store.table('jobNotices').put({ id: report.id, lastProgressAt: NOW - 3 * HOUR, rewakeAt: NOW - 10 * MINUTE, stallNotifiedAt: null,
      stallKind: null, overdueNotifiedFor: null, remindedItemIds: [], budgetAskedCaps: [], holdAtCap: false, narrowRequestedAt: null,
      dueRiskNotifiedAt: null, updatedAt: NOW });
    const row = activeJobsView(ctx, fix.chief.id).rows.find(item => item.key === report.id)!;
    expect(row.waitText).toBe('在等：林舟　3 小时没有进展　交付：11月17日 18:00 前');
  });
});

describe('2 R9：离开期间摘要里「在等你{事项}」优先于兜底句', () => {
  const base: AwayJobInput = { title: '活动报名页', turns: 1, tokens: 1000, lastTurnAt: NOW, events: [], stateLabel: '执行中',
    waitingOn: '林舟', waitingOwner: false, waitItem: null, hasOpenItem: false, noticeItem: null, waitedMs: 0 };
  const names = { b_0000000002: '林舟' };

  it('甲成立：「{状态词}，在等你{事项}」', () => {
    expect(sentenceOf({ ...base, hasOpenItem: true, waitingOwner: true, waitItem: '验收' }, names)).toBe('执行中，在等你验收');
  });

  it('只有乙成立：「{状态词}，另有一条在等你{事项}」', () => {
    expect(sentenceOf({ ...base, hasOpenItem: true, noticeItem: '决定怎样继续' }, names)).toBe('执行中，另有一条在等你决定怎样继续');
  });

  it('反例：没有开着的条目时仍是「{状态词}，在等{谁}」', () => {
    expect(sentenceOf(base, names)).toBe('执行中，在等林舟');
  });
});

describe('3 R10 第 1 点：核对结论撤回「没有进展」条目的答复栏不带主语', () => {
  it('核对人是总管：答复栏写「核对结论已提交」，不写「总管已提交核对结论」', async () => {
    const s = await started([], { reviewer: '总管' });
    const { fix, job, info } = s;
    await engineerSubmits(fix, info);
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '已交回' });
    // 造一条「没有进展」条目（核对中、没有别的条目）。
    expect(reportStall(fix.ctx, theJob(fix), 'idle', fix.ctx.clock.now() + 2 * HOUR, { actorId: fix.chief.id })).toBe(true);
    const [item] = fix.ctx.store.table('inbox').list(row => row.subjectKey.startsWith(`job:${job.id}:stall:`));
    expect(item).toBeDefined();
    // 总管提交核对结论：条目撤回，答复栏逐字。
    const seen = reviewerInfo(await nextPacket(fix, fix.chief.id));
    expect(await callTool(fix, bot(fix, fix.chief.id), 'hub_job_work', { mode: 'review', jobId: seen.jobId, items: PASS_ITEMS })).toMatchObject({ ok: true });
    expect(fix.ctx.store.table('inbox').get(item!.id)).toMatchObject({ status: 'withdrawn', answer: '核对结论已提交' });
  });
});

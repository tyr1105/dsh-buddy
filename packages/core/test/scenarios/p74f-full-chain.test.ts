/**
 * P74f 场景：从需求到验收的完整一条链（第一次：交付、验收、主人指出不符）。
 *
 * 真实的中心 + 假宿主 + 真实工具：主人提需求、总管提交约定、主人说「定了」、总管派活给林舟（评审甲核对）；
 * 林舟交回，评审甲退回第 3 条，林舟返工，评审甲通过；中心交付；主人在主题里打字指出第 2 条不符，总管 reopen，
 * 林舟只改第 2 条，评审甲通过，中心第二次交付；主人点交付卡上的「验收通过」。
 * 全程断言：主人只被「待你处理」找了约定确认和两次验收（第一次被撤回）；每次执行链唤醒都在假时钟 2 分钟内被放行；
 * 给主人看的全部消息不含内部名称；回执的数字正确。
 */
import { describe, expect, it } from 'vitest';
import { agreementIdIn } from '../p73d-fixtures.js';
import { MINUTE, assignArgs, bot, callTool, commitAndEnd, jobFix, lockedAndAwake, runningOf, speak, tick, theJob, eventsOf, type JobFix } from '../p74c-fixtures.js';
import { executorInfo, lastPacket, metWithImage, putStandardFiles, reviewerInfo, firstSubmitArgs, INTERNAL } from '../p74d-fixtures.js';
import { reopenInfo, ownerTypes } from '../p74f-fixtures.js';

/** 每 10 秒调度一次，等这位员工拿到回合；超过 2 分钟视为失败。 */
async function waitRunning(fix: JobFix, botId: string, what: string): Promise<void> {
  let waited = 0;
  while (!runningOf(fix, botId) && waited < 120_000) {
    await tick(fix, 10_000);
    waited += 10_000;
  }
  expect(runningOf(fix, botId), `${what}：${waited / 1000} 秒内应该被放行`).toBeDefined();
}

describe('场景 P74f：需求、约定、派活、核对、交付、主人指出不符、返工、验收', () => {
  it('主人只被「待你处理」找了约定确认和两次验收；每次唤醒 2 分钟内放行；回执数字正确；全程没有内部名称', async () => {
    const fix = await jobFix();
    fix.ctx.clock.advance(10 * MINUTE);
    // 1. 需求、约定、定了、派活。
    const packet = await lockedAndAwake(fix);
    const agreementId = agreementIdIn(packet);
    expect(await callTool(fix, fix.chief, 'hub_job_manage', assignArgs(agreementId, { deliveryItems: [1] }))).toMatchObject({ ok: true });
    await speak(fix, fix.chief, '这件事由林舟执行，评审甲核对。', { outcome: 'progress' });
    const jobId = theJob(fix).id;
    const topicId = theJob(fix).topicId;
    // 2. 林舟第 1 轮交回；评审甲退回第 3 条；林舟返工；评审甲通过。
    await waitRunning(fix, fix.engineer.id, '林舟拿到第一个回合');
    const info = executorInfo(lastPacket(fix, bot(fix, fix.engineer.id)));
    await putStandardFiles(fix, info);
    expect(await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', firstSubmitArgs(info))).toMatchObject({ ok: true });
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '已交回' });
    await waitRunning(fix, fix.reviewer.id, '评审甲拿到核对的回合');
    const seen = reviewerInfo(lastPacket(fix, bot(fix, fix.reviewer.id)));
    expect(await callTool(fix, bot(fix, fix.reviewer.id), 'hub_job_work', { mode: 'review', jobId: seen.jobId, items: [
      { no: 1, verdict: 'at_delivery' }, { no: 2, verdict: 'met' }, { no: 3, verdict: 'unmet', note: '失败时没有提示', fixTo: '断开接口后页面显示「加载失败」' }] })).toMatchObject({ ok: true });
    await commitAndEnd(fix, fix.reviewer.id, { outcome: 'progress', summary: '退回' });
    await waitRunning(fix, fix.engineer.id, '林舟拿到返工的回合');
    expect(await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', { mode: 'submit', jobId, changeNote: '补了失败提示', deliverables: ['交付/报价页.html'],
      items: [metWithImage(3, '证据/桌面.png')] })).toMatchObject({ ok: true });
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '已交回' });
    await waitRunning(fix, fix.reviewer.id, '评审甲拿到第 2 轮核对');
    expect(await callTool(fix, bot(fix, fix.reviewer.id), 'hub_job_work', { mode: 'review', jobId, items: [{ no: 3, verdict: 'met', note: '提示一致' }],
      spotChecked: [2], carriedNote: '只改了失败提示' })).toMatchObject({ ok: true });
    await commitAndEnd(fix, fix.reviewer.id, { outcome: 'progress', summary: '通过' });

    // 3. 中心交付：主题一句话加交付卡，「待你处理」一条验收；总管没有新的执行链回合。
    expect(theJob(fix)).toMatchObject({ state: 'awaiting_owner', stage: 1 });
    expect(fix.ctx.store.table('wakes').list(row => row.botId === fix.chief.id && row.jobId === jobId)).toHaveLength(0);
    expect(fix.ctx.store.table('inbox').list(row => row.subjectKey === `job:${jobId}:accept:1`)).toHaveLength(1);

    // 4. 主人在主题里打字指出第 2 条不符；总管用唤醒包里的文字 reopen；林舟只改第 2 条；评审甲通过。
    await ownerTypes(fix, topicId, '第 2 条不对：点了刷新页面没有变化');
    await waitRunning(fix, fix.chief.id, '总管拿到主人发话的回合');
    const chief = reopenInfo(lastPacket(fix, bot(fix, fix.chief.id)));
    expect(await callTool(fix, bot(fix, fix.chief.id), 'hub_job_manage', { mode: 'reopen', jobId: chief.jobId,
      items: [{ no: chief.nos[1]!, problem: '点了刷新页面没有变化', fixTo: '点刷新后价格数字更新' }], missed: '核对时没有真的点刷新，这次要点' })).toMatchObject({ ok: true });
    await speak(fix, bot(fix, fix.chief.id), '返工第 2 条，改到点刷新后价格更新；核对时漏了点刷新，这次补上；预计半小时后再交给你。', { outcome: 'progress' });
    await waitRunning(fix, fix.engineer.id, '林舟拿到主人指出不符后的回合');
    expect(await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', { mode: 'submit', jobId, changeNote: '修了刷新', deliverables: ['交付/报价页.html'],
      items: [metWithImage(2, '证据/手机.png')] })).toMatchObject({ ok: true });
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '已交回' });
    await waitRunning(fix, fix.reviewer.id, '评审甲拿到新阶段的核对');
    expect(await callTool(fix, bot(fix, fix.reviewer.id), 'hub_job_work', { mode: 'review', jobId, items: [{ no: 2, verdict: 'met', note: '点刷新后数字更新', rechecked: true }],
      spotChecked: [3], carriedNote: '只改了刷新' })).toMatchObject({ ok: true });
    await commitAndEnd(fix, fix.reviewer.id, { outcome: 'progress', summary: '通过' });
    expect(theJob(fix)).toMatchObject({ state: 'awaiting_owner', stage: 2 });

    // 5. 主人点交付卡上的「验收通过」。
    expect(await fix.hub.api.acceptJob({ jobId, stage: 2 })).toMatchObject({ ok: true });
    expect(theJob(fix)).toMatchObject({ state: 'done', inboxId: null });

    // 全程断言：主人被「待你处理」找了几次，各是什么、最后的状态。
    const mine = fix.ctx.store.table('inbox').list().map(row => [row.subjectKey.replace(/:(agr|job)_[a-z0-9]{10}/, ':{id}'), row.status]).sort();
    expect(mine).toEqual([['agreement:{id}:1', 'answered'], ['job:{id}:accept:1', 'withdrawn'], ['job:{id}:accept:2', 'answered']]);
    // 给主人看的全部消息不含内部名称（工作往来是员工之间的，不算）。
    for (const thread of [topicId, theJob(fix).chiefId]) {
      for (const row of fix.hub.api.thread(thread).messages) {
        if (row.kind === 'work') continue;
        expect(row.text, row.text).not.toMatch(INTERNAL);
        if (row.jobCard) expect(JSON.stringify({ ...row.jobCard, jobId: undefined, evidenceJobId: undefined, evidenceSubmissionId: undefined }), row.text).not.toMatch(INTERNAL);
      }
    }
    // 回执的数字：核对 3 轮（第 1 阶段两轮、第 2 阶段一轮），第 1 轮退回 1 条；没有回答；约定第 1 版。
    const receipt = fix.hub.api.thread(topicId).messages.find(row => row.jobCard?.kind === 'receipt')!.jobCard!;
    const rows = receipt.kind === 'receipt' ? receipt.rows : [];
    // P76e：视图在五行之后追加第六行「消耗」，这里只比较原来的五行里的后三行，并检查多出来的那一行是「消耗」。
    expect(rows.slice(2, 5).map(row => row.value)).toEqual(['0 个', '3 轮，第 1 轮退回 1 条；你指出不符 1 次', '第 1 版']);
    expect(rows.slice(5).map(row => row.label)).toEqual(['消耗']);
    // 事件：指出不符、验收各一条，记录落在这件事上（第四块读的）。
    expect(eventsOf(fix.ctx, jobId).filter(row => ['owner_returned', 'owner_accepted'].includes(row.kind)).map(row => row.kind)).toEqual(['owner_returned', 'owner_accepted']);
    expect(theJob(fix).ownerReturns).toMatchObject([{ stage: 1, items: [{ no: 2 }], missed: '核对时没有真的点刷新，这次要点' }]);
  });
});

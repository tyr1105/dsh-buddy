/**
 * P74c 场景（P74d 起走真实工具）：一件事走完整条执行链。
 *
 * 真实的中心 + 假宿主：主人提需求、总管提交约定、主人点「定了」、总管派活给林舟（评审甲核对）；
 * 林舟做一轮交回，评审甲退回，林舟返工再交回，评审甲通过，事进入「待你验收」。
 * 要确认的是：每一步的执行链唤醒都在 2 分钟（假时钟）内被放行；林舟和评审甲当天之前已经有了好几个回合也不影响
 * （执行链越过员工自主预算与最短思考间隔）；全程宿主收到的投递次数与预期一致；通过之后不再有新的唤醒。
 * P74c 时交回与核对还没有工具，只能用「直接追加事件、调用状态机」来模拟；P74d 起交回、核对都是员工自己调用
 * hub_job_work（只用唤醒包里的文字取值），叫醒下一个人也由工具完成，不再手工入队。断言的意图不变。
 */
import { describe, expect, it } from 'vitest';
import { jobProgressForTopic } from '../../src/api/job-topic-views.js';
import {
  MINUTE, assignArgs, bot, callTool, commitAndEnd, entriesOf, jobFix, lockedAndAwake, runningOf, speak, tick, theJob, wakesOf,
  agreementIdIn, type JobFix,
} from '../p74c-fixtures.js';
import { executorInfo, firstSubmitArgs, lastPacket, metWithImage, putStandardFiles, reviewerInfo } from '../p74d-fixtures.js';
import { addSelfTurns } from '../p76c-fixtures.js';

/** 这位员工的会话被投递了几次（假宿主记录的 deliver 调用）。 */
function deliveries(fix: JobFix, botId: string): number {
  return fix.ctx.host.calls.filter(call => call.method === 'deliver' && call.args[0] === bot(fix, botId).sessionId).length;
}

/** 每 10 秒调度一次，等这位员工拿到回合；返回等了多少毫秒。超过 2 分钟视为失败。 */
async function waitRunning(fix: JobFix, botId: string, what: string): Promise<number> {
  let waited = 0;
  while (!runningOf(fix, botId) && waited < 120_000) {
    await tick(fix, 10_000);
    waited += 10_000;
  }
  expect(runningOf(fix, botId), `${what}：${waited / 1000} 秒内应该被放行`).toBeDefined();
  expect(waited, what).toBeLessThanOrEqual(120_000);
  return waited;
}

describe('场景 P74c：执行链走完一件事（核对退回一次）', () => {
  it('每一步的唤醒都在 2 分钟内被放行，员工当天已有回合也不影响；投递次数与预期一致；通过后不再有唤醒', async () => {
    // P76c：员工自己发起的工作只剩一条上限（默认每天 2 个自己发起的回合），P76b 在这里显式设的 6 去掉，用默认值。
    // 原来预置「6 个自主回合、超过 25 万 token」的账本行来表示「当天已用满预算」；现在上限数的是唤醒单：
    // 给两位员工各预置 2 张自己发起的唤醒单（正好用满每天 2 个），账本行（42000 token × 6）保留，表示 token 再多也不影响放行。
    const fix = await jobFix([], {});
    // 中心已经启动了一阵子（越过启动静默）。
    fix.ctx.clock.advance(10 * MINUTE);
    // 林舟和评审甲当天已用满 2 个自己发起的回合、账本里 token 很多，而且 5 分钟前刚思考过：
    // 如果执行链唤醒要看自己发起的回合上限和最短思考间隔，下面每一步都会被挡住。
    const now = fix.ctx.clock.now();
    let ledgerNo = 0;
    for (const botId of [fix.engineer.id, fix.reviewer.id]) {
      addSelfTurns(fix.ctx, fix.ctx.settings.botDailyTurnBudget, { startedAt: now - 20 * MINUTE, dispatchedAt: now - 20 * MINUTE,
        subjectKey: `other:${botId}`, reason: { kind: 'percept', score: 0.8, threshold: 0.6, summary: '当天已做过的自己发起的回合', evidence: [] } }, botId);
      for (let i = 0; i < 6; i += 1) {
        ledgerNo += 1;
        fix.ctx.store.log('ledger').append({ id: `le_${String(ledgerNo).padStart(10, '0')}`, who: botId, wakeId: null, tokens: 42_000,
          kind: 'turn', at: now - (i + 10) * MINUTE, ownerInitiated: false });
      }
      fix.ctx.store.table('bots').patch(botId, { lastThinkAt: now - 5 * MINUTE });
    }

    // 1. 主人提需求、总管提交约定、主人点「定了」、总管派活。
    const packet = await lockedAndAwake(fix);
    const agreementId = agreementIdIn(packet);
    expect(await callTool(fix, fix.chief, 'hub_job_manage', assignArgs(agreementId, { deliveryItems: [1] }))).toMatchObject({ ok: true });
    // P74r7：交付时核对的条目必须写了时间；夹具第 1 条带「今天」，第 3 条没有，所以交付时核对改为第 1 条（原来是第 3 条）。
    await speak(fix, fix.chief, '这件事由林舟执行，评审甲核对。', { outcome: 'progress' });
    const job = theJob(fix);

    // 2. 林舟拿到第一个回合。
    await waitRunning(fix, fix.engineer.id, '派活后林舟开工');
    expect(theJob(fix)).toMatchObject({ state: 'doing', turnsUsed: 1 });
    // 3. 他交账 progress、没有交回：中心续排，第二个回合。
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '搭好了页面骨架' });
    await waitRunning(fix, fix.engineer.id, '续排');
    expect(theJob(fix).turnsUsed).toBe(2);

    // 4. 他交回（真实工具，只用唤醒包里的文字取值），评审甲被工具叫去核对。
    const info = executorInfo(lastPacket(fix, bot(fix, fix.engineer.id)));
    expect(info.jobId).toBe(job.id);
    await putStandardFiles(fix, info);
    const submitted = await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', firstSubmitArgs(info));
    expect(submitted, JSON.stringify(submitted)).toMatchObject({ ok: true });
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '已交回', reply: '第一轮交回了' });
    expect(entriesOf(fix, fix.engineer.id, job.id)).toHaveLength(0); // 已经交回，不续排
    await waitRunning(fix, fix.reviewer.id, '叫评审甲核对');

    // 5. 评审甲退回（真实工具）：第 2 条不符，林舟被工具叫去返工。
    const seen = reviewerInfo(lastPacket(fix, bot(fix, fix.reviewer.id)));
    const returned = await callTool(fix, bot(fix, fix.reviewer.id), 'hub_job_work', { mode: 'review', jobId: seen.jobId,
      items: [{ no: 1, verdict: 'at_delivery' }, { no: 2, verdict: 'unmet', note: '价格没有分档', fixTo: '页面上能看到三档价格' }, { no: 3, verdict: 'met' }] });
    expect(returned, JSON.stringify(returned)).toMatchObject({ ok: true });
    await commitAndEnd(fix, fix.reviewer.id, { outcome: 'progress', summary: '第 2 条不符' });
    expect(entriesOf(fix, fix.reviewer.id, job.id)).toHaveLength(0); // 已有结论，不续排
    await waitRunning(fix, fix.engineer.id, '退回后林舟返工');

    // 6. 林舟返工后只重交第 2 条，评审甲第二次核对。
    const again = await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', { mode: 'submit', jobId: job.id, changeNote: '价格页改成三档了',
      deliverables: ['交付/报价页.html'], items: [metWithImage(2, '证据/桌面.png')] });
    expect(again, JSON.stringify(again)).toMatchObject({ ok: true });
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '改好了', reply: '第二轮交回了' });
    await waitRunning(fix, fix.reviewer.id, '第二轮核对');

    // 7. 评审甲通过，事进入「待你验收」。
    const passed = await callTool(fix, bot(fix, fix.reviewer.id), 'hub_job_work', { mode: 'review', jobId: job.id,
      items: [{ no: 2, verdict: 'met', note: '三档价格都能看到' }], spotChecked: [3], carriedNote: '本轮只改了价格分档' });
    expect(passed, JSON.stringify(passed)).toMatchObject({ ok: true });
    await commitAndEnd(fix, fix.reviewer.id, { outcome: 'done', summary: '全部符合' });
    expect(theJob(fix).state).toBe('awaiting_owner');
    expect(jobProgressForTopic(fix.ctx, job.topicId)).toMatchObject({ stateLabel: '待你验收' });

    // 投递次数：林舟 3 次（开工、续排、返工），评审甲 2 次；回合数一致。
    expect(wakesOf(fix, fix.engineer.id, job.id)).toHaveLength(3);
    expect(wakesOf(fix, fix.reviewer.id, job.id)).toHaveLength(2);
    expect(deliveries(fix, fix.engineer.id)).toBe(3);
    expect(deliveries(fix, fix.reviewer.id)).toBe(2);
    expect(theJob(fix).turnsUsed).toBe(5);
    // 总管只在主人发话的两个回合里出现，没有执行链回合。
    expect(wakesOf(fix, fix.chief.id, job.id)).toHaveLength(0);

    // 通过之后再过很久，不再有新的唤醒，队列里也没有这件事的候选。
    for (let i = 0; i < 8; i += 1) await tick(fix, 31 * MINUTE);
    expect(wakesOf(fix, fix.engineer.id, job.id)).toHaveLength(3);
    expect(wakesOf(fix, fix.reviewer.id, job.id)).toHaveLength(2);
    expect(fix.ctx.store.table('queue').list(row => row.jobId === job.id)).toHaveLength(0);
    expect(theJob(fix).state).toBe('awaiting_owner');
  });
});

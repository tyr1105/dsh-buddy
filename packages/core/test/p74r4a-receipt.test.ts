/**
 * P74r4a 的测试（四）：回执和试用反馈的数字（第 5 条，第三次审查 K6、K8），提问人停用期间约定新版本回答了他（第 6 条，L5）。
 *
 * - 「核对几轮」数核对人真实做过的核对：选办法之后的复核、只删条目重排之后的核对都算，只排除中心自己生成的那一份；
 * - 回执五行在验收时一次算好存下；交付 31 天后（模拟已关闭的条目被清）数字不变；
 * - 打字验收：交付 15 天后（模拟内存里的线程日志被清）仍然成功；
 * - 试用反馈里执行者那一句只算这位执行者自己的交回和对它们的核对，改派过的事不把前任的算给后任；
 * - 提问人停用期间被约定新版本回答，恢复在岗时唤醒包里带着那条回答。
 * 全部走真实 Hub，假时钟每次不超过 10 分钟（只有直接调用存储的清理时用来模拟 15 天、31 天之后）。
 */
import { describe, expect, it } from 'vitest';
import { lifecycleAction } from '../src/api/bots.js';
import { receiptCardView } from '../src/api/job-delivery-views.js';
import { flushJobHooks } from '../src/job/agreement-hooks.js';
import { realReviews, receiptRowsOf } from '../src/job/receipt.js';
import { deliveryCardMessage } from '../src/job/deliver.js';
import type { JobReview } from '../src/model/job.js';
import { agreementIdIn } from './p73d-fixtures.js';
import { assignArgs, commitAndEnd, runningOf } from './p74c-fixtures.js';
import { chiefDrafts, ownerSays, speak, threadOf } from './p74b-fixtures.js';
import { engineerSubmits, executorInfo, jobFix, metWithImage, putStandardFiles, reviewerInfo, reviewerThoughtRecently } from './p74d-fixtures.js';
import { PASS_ITEMS, delivered, ownerTypes } from './p74f-fixtures.js';
import { idsIn, reviseArgs } from './p74r2b-fixtures.js';
import { askedChiefTurn } from './p74r2b-fixtures.js';
import {
  MINUTE, bot, callTool, escalateFromPacket, lastPacket, limitFix, nextPacket, sectionOf, started, theJob, tick, type JobFix,
} from './p74f2-fixtures.js';

const DAY = 24 * 60 * MINUTE;
const REWRITE = { title: '放宽这一条', detail: '改成有提示或备用文案都算做完；代价是提示可以简单一些', change: { no: 3, text: '接口失败时页面有提示或有备用文案' } };
const OTHER = { title: '换一位执行者再试', detail: '换人重做这一条；代价是多花一轮时间' };
const DONES = ['打开页面能看到今天的报价', '点刷新后数据更新', '接口失败时有提示', '能导出表格'];

/** 回执五行里某一行的值（读这件事记录上存下的回执）。 */
function receiptRow(fix: JobFix, label: string): string {
  const rows = theJob(fix).receipt;
  expect(rows, '验收时应该已经把回执存在这件事的记录上').toBeDefined();
  return rows!.find(row => row.label === label)!.value;
}

/** 总管私聊里的试用反馈句子。 */
function trialLines(fix: JobFix): string[] {
  return threadOf(fix.ctx, fix.chief.id).filter(row => row.text.includes('的第一件事做完了')).map(row => row.text);
}

describe('核对几轮：只排除中心自己生成的那一份', () => {
  it('记录上有 byCenter 标记的才排除；对着中心重排的交回做的核对（没有标记）照算', () => {
    const base = { jobId: 'job_aaaaaaaaaa', stage: 1, round: 1, reviewerId: 'b_0000000003', carriedNote: null, spotChecked: [], createdAt: 1,
      items: [{ no: 1, verdict: 'met' as const, note: null, fixTo: null, rechecked: false }] };
    const reviews: JobReview[] = [
      { ...base, id: 'jrv_0000000001', submissionId: 'jsb_0000000001' },
      { ...base, id: 'jrv_0000000002', submissionId: 'jsb_0000000002' },
      { ...base, id: 'jrv_0000000003', submissionId: 'jsb_0000000003', byCenter: true }];
    expect(realReviews(reviews).map(row => row.id)).toEqual(['jrv_0000000001', 'jrv_0000000002']);
  });

  it('主人选办法之后复核通过：回执写 4 轮（三轮不过加一次复核），试用反馈里评审员的轮数同样是 4', async () => {
    const { fix, job } = await limitFix();
    await escalateFromPacket(fix, [REWRITE, OTHER]);
    expect(await fix.hub.api.chooseJobOption({ jobId: job.id, stage: 1, option: 0 })).toMatchObject({ ok: true });
    await flushJobHooks(fix.ctx);
    const seen = reviewerInfo(await nextPacket(fix, fix.reviewer.id));
    expect(await callTool(fix, bot(fix, fix.reviewer.id), 'hub_job_work', { mode: 'review', jobId: seen.jobId, items: [{ no: 3, verdict: 'met' }] })).toMatchObject({ ok: true });
    expect(theJob(fix).state).toBe('awaiting_owner');
    expect(await fix.hub.api.acceptJob({ jobId: job.id, stage: theJob(fix).stage })).toMatchObject({ ok: true });
    // P74r13 第 6 节改了预期：原来写「4 轮，第 1 轮退回 1 条」（只看第 1 轮）；三轮核对都判了不符，现在如实写有退回的轮数。
    expect(receiptRow(fix, '核对')).toBe('4 轮，其中 3 轮有退回');
    expect(trialLines(fix).find(text => text.startsWith('评审甲'))).toBe('评审甲（评审员）的第一件事做完了：核对 4 轮，你验收时没有发现漏判。');
  });

  it('选办法后只删条目直接交付：中心重排的那一份核对不算，回执写 3 轮', async () => {
    const { fix, job } = await limitFix(DONES);
    await escalateFromPacket(fix, [{ title: '删去这一条', detail: '这次不做失败提示；代价是失败时用户看不到原因', change: { no: 3, text: null } }, OTHER]);
    expect(await fix.hub.api.chooseJobOption({ jobId: job.id, stage: 1, option: 0 })).toMatchObject({ ok: true });
    await flushJobHooks(fix.ctx);
    expect(theJob(fix).state).toBe('awaiting_owner');
    expect(fix.ctx.store.table('jobReviews').list(row => row.jobId === job.id && row.byCenter === true)).toHaveLength(1);
    expect(await fix.hub.api.acceptJob({ jobId: job.id, stage: theJob(fix).stage })).toMatchObject({ ok: true });
    // P74r13 第 6 节改了预期：原来写「3 轮，第 1 轮退回 1 条」；三轮核对都判了不符，现在写「3 轮，其中 3 轮有退回」。
    expect(receiptRow(fix, '核对')).toBe('3 轮，其中 3 轮有退回');
  });

  it('核对中约定只删去一条、中心重排交回、核对人按新编号核对通过：这一轮算，回执写 1 轮，一次通过', async () => {
    const fix = await jobFix();
    await chiefDrafts(fix as never, { title: '会员定价页', doneWhen: DONES });
    await speak(fix, fix.chief, '这件事有 2 项需要你定。确认前不会开工。', { outcome: 'needs_owner' });
    await ownerSays(fix, fix.chief.id, '定了');
    const agreementId = agreementIdIn(lastPacket(fix, bot(fix, fix.chief.id)));
    expect(await callTool(fix, fix.chief, 'hub_job_manage', assignArgs(agreementId, { deliveryItems: [1] }))).toMatchObject({ ok: true });
    await speak(fix, fix.chief, '这件事由林舟执行，评审甲核对。', { outcome: 'progress' });
    await tick(fix, 10 * MINUTE);
    reviewerThoughtRecently(fix);
    const info = executorInfo(lastPacket(fix, bot(fix, fix.engineer.id)));
    await putStandardFiles(fix, info);
    await engineerSubmits(fix, info);
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '已交回' });
    // 核对中：主人让去掉最后一条，确认第 2 版；中心按新编号重排最近一次交回，评审甲被重新叫醒。
    await ownerSays(fix, fix.chief.id, '导出表格这条不要了');
    const ids = idsIn(lastPacket(fix, bot(fix, fix.chief.id)));
    expect(await callTool(fix, bot(fix, fix.chief.id), 'hub_agreement_submit', reviseArgs(ids.agreementId, { changeNote: '去掉导出', doneWhen: DONES.slice(0, 3), removals: [DONES[3]] }))).toMatchObject({ ok: true });
    await speak(fix, bot(fix, fix.chief.id), '已请主人确认。', { outcome: 'needs_owner' });
    expect(await fix.hub.api.confirmAgreement({ agreementId: ids.agreementId, version: 2 })).toMatchObject({ ok: true });
    await flushJobHooks(fix.ctx);
    const seen = reviewerInfo(await nextPacket(fix, fix.reviewer.id));
    expect(seen.nos).toEqual([1, 2, 3]);
    expect(await callTool(fix, bot(fix, fix.reviewer.id), 'hub_job_work', { mode: 'review', jobId: seen.jobId, items: PASS_ITEMS })).toMatchObject({ ok: true });
    await commitAndEnd(fix, fix.reviewer.id, { outcome: 'progress', summary: '核对通过' });
    expect(theJob(fix).state).toBe('awaiting_owner');
    expect(await fix.hub.api.acceptJob({ jobId: seen.jobId, stage: theJob(fix).stage })).toMatchObject({ ok: true });
    expect(receiptRow(fix, '核对')).toBe('1 轮，一次通过');
  });
});

describe('回执：验收时一次算好；打字验收不依赖线程日志', () => {
  it('交付 31 天后（已关闭的条目被清）回执的数字不变；「打扰你」是记录上累计的数字', async () => {
    const { fix, job } = await delivered();
    expect(await fix.hub.api.acceptJob({ jobId: job.id, stage: job.stage })).toMatchObject({ ok: true });
    const stored = receiptRowsOf(fix.ctx, theJob(fix));
    const disturb = theJob(fix).disturbCount;
    expect(disturb).toBeGreaterThanOrEqual(2);
    expect(stored.find(row => row.label === '需要你处理')!.value).toBe(`${disturb} 次`);
    const itemsBefore = fix.ctx.store.table('inbox').count(row => row.subjectKey.startsWith(`job:${job.id}:`) || row.subjectKey.startsWith(`agreement:${job.agreementId}:`));
    expect(itemsBefore).toBeGreaterThanOrEqual(2);
    // 模拟 31 天后：已关闭的条目超过 30 天被清掉。
    await fix.ctx.store.prune(fix.ctx.clock.now() + 31 * DAY);
    const itemsAfter = fix.ctx.store.table('inbox').count(row => row.subjectKey.startsWith(`job:${job.id}:`) || row.subjectKey.startsWith(`agreement:${job.agreementId}:`));
    expect(itemsAfter).toBeLessThan(itemsBefore);
    expect(receiptRowsOf(fix.ctx, theJob(fix))).toEqual(stored);
    // 回执卡的视图读的也是存下的数字。
    // P76e：视图在存下的五行之后追加第六行「消耗」，前五行与存下的逐项相同。
    const viewRows = receiptCardView(fix.ctx, `receipt:${job.id}`)!.rows;
    expect(viewRows.slice(0, 5)).toEqual(stored);
    expect(viewRows.map(row => row.label).slice(5)).toEqual(['消耗']);
  });

  it('交付 15 天后（模拟内存里的线程日志被清，交付卡已读不到）打字「验收通过」仍然成功', async () => {
    const { fix, job } = await delivered();
    expect(deliveryCardMessage(fix.ctx, theJob(fix))).not.toBeNull();
    await fix.ctx.store.prune(fix.ctx.clock.now() + 15 * DAY);
    expect(deliveryCardMessage(fix.ctx, theJob(fix)), '日志被清之后，线程里已找不到交付卡').toBeNull();
    expect(theJob(fix).delivery).toMatchObject({ stage: job.stage });
    expect(theJob(fix).delivery!.cardMessageId).not.toBeNull();
    expect(theJob(fix).delivery!.cardAt).not.toBeNull();
    await ownerTypes(fix, job.topicId, '验收通过');
    expect(theJob(fix).state).toBe('done');
  });

  it('打字验收仍要求这句话不早于交付卡：交付记录上的落楼时间晚于这句话时不识别', async () => {
    const { fix, job } = await delivered();
    fix.ctx.store.table('jobs').patch(job.id, { delivery: { ...theJob(fix).delivery!, cardAt: fix.ctx.clock.now() + 60 * MINUTE } });
    await ownerTypes(fix, job.topicId, '验收通过');
    expect(theJob(fix).state).toBe('awaiting_owner');
  });
});

describe('试用反馈：改派过的事，只算这位执行者自己的交回', () => {
  it('林舟交回第 1 轮被判一条不符，林舟停用、总管改派给小周，小周返工一次通过：小周那一句是「交回 1 次，第一次就全部符合」', async () => {
    const s = await started(['小周'], { deliveryItems: [] });
    const { fix, job } = s;
    await engineerSubmits(fix, s.info);
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '已交回' });
    const seen = reviewerInfo(await nextPacket(fix, fix.reviewer.id));
    expect(await callTool(fix, bot(fix, fix.reviewer.id), 'hub_job_work', { mode: 'review', jobId: seen.jobId, items: [
      { no: 1, verdict: 'met', rechecked: true }, { no: 2, verdict: 'met', rechecked: true },
      { no: 3, verdict: 'unmet', note: '接口失败时页面空白', fixTo: '接口失败时显示提示' }] })).toMatchObject({ ok: true });
    await commitAndEnd(fix, fix.reviewer.id, { outcome: 'progress', summary: '核对了' }).catch(() => undefined);
    expect(theJob(fix)).toMatchObject({ state: 'rework', unmet: [{ no: 3 }] });
    await nextPacket(fix, fix.engineer.id);
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '继续做' });
    // 林舟停用，主人让总管改派给小周。
    await lifecycleAction(fix.ctx, { botId: fix.engineer.id, action: 'suspend' });
    await ownerSays(fix, fix.chief.id, '林舟停用了，换小周做');
    expect(await callTool(fix, bot(fix, fix.chief.id), 'hub_job_manage', { mode: 'reassign', jobId: job.id, executor: '小周' })).toMatchObject({ ok: true });
    await commitAndEnd(fix, fix.chief.id, { outcome: 'progress', summary: '已改派', reply: '已改派给小周。' });
    const newcomer = fix.extras[0]!.id;
    await nextPacket(fix, newcomer);
    const submitted = await callTool(fix, bot(fix, newcomer), 'hub_job_work', { mode: 'submit', jobId: job.id, changeNote: '补了失败提示', deliverables: ['交付/报价页.html'],
      items: [metWithImage(3, '证据/桌面.png')] });
    expect(submitted, JSON.stringify(submitted)).toMatchObject({ ok: true });
    await commitAndEnd(fix, newcomer, { outcome: 'progress', summary: '已交回' });
    const again = reviewerInfo(await nextPacket(fix, fix.reviewer.id));
    expect(await callTool(fix, bot(fix, fix.reviewer.id), 'hub_job_work', { mode: 'review', jobId: again.jobId, items: [{ no: 3, verdict: 'met' }] })).toMatchObject({ ok: true });
    expect(theJob(fix).state).toBe('awaiting_owner');
    expect(await fix.hub.api.acceptJob({ jobId: job.id, stage: theJob(fix).stage })).toMatchObject({ ok: true });
    const line = trialLines(fix).find(text => text.startsWith('小周'));
    expect(line, '小周的第一件事做完了').toBeDefined();
    expect(line).toContain('交回 1 次，第一次就全部符合，你验收时没有指出不符');
  });
});

describe('第 6 条（L5）：提问人停用期间约定新版本回答了他', () => {
  it('林舟提问、总管出新版并说明在回答它、林舟停用、主人确认：恢复在岗后唤醒包里有「总管刚回答你：按约定第 2 版处理：……」', async () => {
    const { fix, job, agreementId } = await askedChiefTurn();
    expect(await callTool(fix, bot(fix, fix.chief.id), 'hub_agreement_submit', reviseArgs(agreementId, { answersAsk: true }))).toMatchObject({ ok: true });
    await speak(fix, bot(fix, fix.chief.id), '暗色模式约定里没有写，已请主人确认。', { outcome: 'needs_owner' });
    if (runningOf(fix, fix.engineer.id)) await commitAndEnd(fix, fix.engineer.id, { outcome: 'no_change', summary: '在等约定确认' });
    await lifecycleAction(fix.ctx, { botId: fix.engineer.id, action: 'suspend' });
    expect(await fix.hub.api.confirmAgreement({ agreementId, version: 2 })).toMatchObject({ ok: true });
    await flushJobHooks(fix.ctx);
    expect(theJob(fix).openAsk).toBeNull();
    const answered = fix.ctx.store.log('jobEvents').all().filter(row => row.jobId === job.id && row.kind === 'answered');
    expect(answered).toHaveLength(1);
    expect(answered[0]!.data.woken).toBe(false);
    // 恢复在岗：他被叫醒，唤醒包里带着那条回答。
    await lifecycleAction(fix.ctx, { botId: fix.engineer.id, action: 'reinstate' });
    const packet = await nextPacket(fix, fix.engineer.id);
    expect(sectionOf(packet)).toContain('总管刚回答你：按约定第 2 版处理：加暗色模式。');
  });
});

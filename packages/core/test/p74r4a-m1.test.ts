/**
 * P74r4a-m1 的测试：说明卡在主人没有选的情况下，状态按事实写；「打扰你」的累计不被旧记录覆盖。
 *
 * 一、失效原因在事情发生时记下（reconfirming、updated、withdrawn、released），卡片文字、选办法被拒的文字按原因区分；
 *    released：这件事离开了这次说明所针对的那一次受阻，主人没有选（回答、改派、恢复在岗各一条）；
 *    再次受阻重新说明之后旧卡保持当时的原因，已停止的事写「已失效：这件事已停止」。
 * 二、「打扰你」：两条完整流程里，回执的次数等于这件事实际建过的相关条目数（直接数表里的条目对照，不写死数字）。
 * 全部走真实 Hub，总管只用唤醒包里的文字调用，假时钟每次不超过 10 分钟。
 */
import { describe, expect, it } from 'vitest';
import { lifecycleAction } from '../src/api/bots.js';
import { escalationCardView } from '../src/api/job-escalation-views.js';
import { flushJobHooks } from '../src/job/agreement-hooks.js';
import { commitAndEnd, runningOf } from './p74c-fixtures.js';
import { executorInfo, metWithImage, putStandardFiles, reviewerInfo } from './p74d-fixtures.js';
import { chiefTurn, delivered, ownerTypes, reopenInfo } from './p74f-fixtures.js';
import { idsIn, reviseArgs } from './p74r2b-fixtures.js';
import {
  bot, callTool, escalateFromPacket, lastPacket, limitFix, nextPacket, ownerSays, speak, started, theJob, type JobFix,
} from './p74f2-fixtures.js';

const PLAIN = [{ title: '换小周做', detail: '换一位执行者重做；代价是多花一轮时间' }, { title: '先等文档', detail: '等文档到了再做；代价是交付时间会晚' }];
const REWRITE = { title: '放宽这一条', detail: '改成有提示或备用文案都算做完；代价是提示可以简单一些', change: { no: 3, text: '接口失败时页面有提示或有备用文案' } };
const OTHER = { title: '换一位执行者再试', detail: '换人重做这一条；代价是多花一轮时间' };

async function chiefEnds(fix: JobFix, reply?: string): Promise<void> {
  if (runningOf(fix, fix.chief.id)) await commitAndEnd(fix, fix.chief.id, { outcome: 'progress', summary: '已处理', ...(reply === undefined ? {} : { reply }) });
}

/** 林舟做不下去，总管写了说明（主人还没选）。 */
async function escalatedExecutor() {
  const s = await started(['小周']);
  expect(await callTool(s.fix, bot(s.fix, s.fix.engineer.id), 'hub_job_work', { mode: 'block', jobId: s.job.id, stuckAt: '缺报价接口的文档', tried: ['查了仓库'] })).toMatchObject({ ok: true });
  await commitAndEnd(s.fix, s.fix.engineer.id, { outcome: 'blocked', blocker: '缺报价接口的文档', summary: '做不下去' });
  await escalateFromPacket(s.fix, PLAIN);
  return s;
}

/** 旧卡（第 1 阶段、修订 0）的视图。 */
function oldCard(fix: JobFix, jobId: string, rev = 0) {
  return escalationCardView(fix.ctx, rev === 0 ? `escalation:${jobId}#1` : `escalation:${jobId}#1~${rev}`)!;
}

const RELEASED = { stateText: '已失效：这件事已继续进行', selectable: false, chosen: null };
const RELEASED_REFUSAL = { ok: false, error: '这件事已经继续进行了，这张卡上的办法不用再选。' };
const REASSIGNED = { stateText: '已失效：总管已改派', selectable: false, chosen: null };
const REASSIGNED_REFUSAL = { ok: false, error: '总管已经改派，这张卡上的办法不用再选。' };

describe('released：这件事离开了那一次受阻，主人没有选', () => {
  it('总管回答解除受阻：旧卡「已失效：这件事已接着做」、不可选，点旧卡被拒', async () => {
    const { fix, job } = await escalatedExecutor();
    await ownerSays(fix, fix.chief.id, '你看着办');
    expect(await callTool(fix, bot(fix, fix.chief.id), 'hub_job_manage', { mode: 'answer', jobId: job.id, to: '林舟', text: '文档在仓库的 docs 目录里', basis: [{ section: 'doneWhen', no: 1 }] })).toMatchObject({ ok: true });
    expect(theJob(fix).escalation).toMatchObject({ invalid: 'released' });
    expect(oldCard(fix, job.id)).toMatchObject(RELEASED);
    expect(await fix.hub.api.chooseJobOption({ jobId: job.id, stage: 1, option: 0, revision: 0 })).toEqual(RELEASED_REFUSAL);
  });

  it('总管改派解除受阻：同上', async () => {
    const { fix, job } = await escalatedExecutor();
    await ownerSays(fix, fix.chief.id, '换小周');
    expect(await callTool(fix, bot(fix, fix.chief.id), 'hub_job_manage', { mode: 'reassign', jobId: job.id, executor: '小周' })).toMatchObject({ ok: true });
    // P74r6 改了预期：原来断言 released、「已失效：这件事已接着做」；现在改派标为 reassigned、「已失效：总管已改派」。
    expect(theJob(fix).escalation).toMatchObject({ invalid: 'reassigned' });
    expect(oldCard(fix, job.id)).toMatchObject(REASSIGNED);
    expect(await fix.hub.api.chooseJobOption({ jobId: job.id, stage: 1, option: 0, revision: 0 })).toEqual(REASSIGNED_REFUSAL);
  });

  it('员工恢复在岗解除受阻：同上', async () => {
    const { fix, job } = await escalatedExecutor();
    // 这件事的受阻原因变成「参与者停用」（模拟），随后恢复在岗。
    await lifecycleAction(fix.ctx, { botId: fix.engineer.id, action: 'suspend' });
    const now = theJob(fix);
    fix.ctx.store.table('jobs').put({ ...now, blocked: { ...now.blocked!, kind: 'participant_off', text: '林舟已停用' } });
    await lifecycleAction(fix.ctx, { botId: fix.engineer.id, action: 'reinstate' });
    expect(theJob(fix).state).not.toBe('blocked');
    expect(oldCard(fix, job.id)).toMatchObject(RELEASED);
    expect(await fix.hub.api.chooseJobOption({ jobId: job.id, stage: 1, option: 0, revision: 0 })).toEqual(RELEASED_REFUSAL);
  });

  it('再次受阻重新说明之后：旧卡保持原因，新卡「等你决定」；之后约定更新，旧卡文字不变', async () => {
    const { fix, job } = await escalatedExecutor();
    await ownerSays(fix, fix.chief.id, '换小周');
    expect(await callTool(fix, bot(fix, fix.chief.id), 'hub_job_manage', { mode: 'reassign', jobId: job.id, executor: '小周' })).toMatchObject({ ok: true });
    await chiefEnds(fix, '已改派给小周。');
    const newcomer = fix.extras[0]!.id;
    await nextPacket(fix, newcomer);
    expect(await callTool(fix, bot(fix, newcomer), 'hub_job_work', { mode: 'block', jobId: job.id, stuckAt: '文档还是没有', tried: ['问了同事'] })).toMatchObject({ ok: true });
    await commitAndEnd(fix, newcomer, { outcome: 'blocked', blocker: '文档还是没有', summary: '做不下去' });
    expect((await escalateFromPacket(fix, PLAIN)).result).toMatchObject({ ok: true });
    expect(oldCard(fix, job.id)).toMatchObject(REASSIGNED);
    expect(oldCard(fix, job.id, 1)).toMatchObject({ stateText: '等你决定', selectable: true });
    // 约定更新（主人亲口的小改动直接生效）：新卡变「已失效：约定已更新」，旧卡文字不变。
    await ownerSays(fix, fix.chief.id, '那句话说得更准确些');
    const ids = idsIn(lastPacket(fix, bot(fix, fix.chief.id)));
    expect(await callTool(fix, bot(fix, fix.chief.id), 'hub_agreement_submit', { mode: 'amend', agreementId: ids.agreementId, changeNote: '说得更准确', summary: '做一个能查看每日报价、可以手动刷新的小页面' })).toMatchObject({ ok: true });
    await flushJobHooks(fix.ctx);
    expect(oldCard(fix, job.id, 1)).toMatchObject({ stateText: '已失效：约定已更新', selectable: false });
    expect(oldCard(fix, job.id)).toMatchObject(REASSIGNED);
  });

  it('这件事已停止：没有选过的说明卡写「已失效：这件事已停止」，点它被拒', async () => {
    const { fix, job } = await escalatedExecutor();
    await ownerSays(fix, fix.chief.id, '这件事不做了');
    expect(await callTool(fix, bot(fix, fix.chief.id), 'hub_job_manage', { mode: 'stop', jobId: job.id, reason: '你说不做了' })).toMatchObject({ ok: true });
    expect(oldCard(fix, job.id)).toMatchObject({ stateText: '已失效：这件事已停止', selectable: false, chosen: null });
    expect(await fix.hub.api.chooseJobOption({ jobId: job.id, stage: 1, option: 0, revision: 0 })).toEqual({ ok: false, error: '这件事已停止，这张卡上的办法不用再选。' });
  });
});

describe('withdrawn：待确认的版本被撤销', () => {
  it('说明之后出待确认版本（reconfirming）、总管撤销（withdrawn）：卡片「已失效：约定修改已撤销」、不可选；拒绝文字如卡里所写；写入时机正确', async () => {
    const { fix, job } = await limitFix();
    await escalateFromPacket(fix, [REWRITE, OTHER]);
    await chiefEnds(fix);
    await ownerSays(fix, fix.chief.id, '约定里的条目要调整一下');
    const ids = idsIn(lastPacket(fix, bot(fix, fix.chief.id)));
    expect(await callTool(fix, bot(fix, fix.chief.id), 'hub_agreement_submit', reviseArgs(ids.agreementId, { changeNote: '加手机', doneWhen: ['页面在手机上能看', '打开页面能看到今天的报价', '点刷新后数据更新', '接口失败时有提示'] }))).toMatchObject({ ok: true });
    await speak(fix, bot(fix, fix.chief.id), '已请主人确认。', { outcome: 'needs_owner' });
    expect(theJob(fix).escalation).toMatchObject({ invalid: 'reconfirming' });
    expect(oldCard(fix, job.id)).toMatchObject({ stateText: '已失效：约定在重新确认', selectable: false });
    await ownerSays(fix, fix.chief.id, '不用加了');
    expect(await callTool(fix, bot(fix, fix.chief.id), 'hub_agreement_submit', { mode: 'withdraw', agreementId: ids.agreementId, reason: '主人不要了' })).toMatchObject({ ok: true });
    expect(theJob(fix).escalation).toMatchObject({ invalid: 'withdrawn' });
    expect(oldCard(fix, job.id)).toMatchObject({ stateText: '已失效：约定修改已撤销', selectable: false, chosen: null });
    expect(await fix.hub.api.chooseJobOption({ jobId: job.id, stage: 1, option: 0 })).toEqual({ ok: false, error: '这张卡上的办法在约定重新确认期间已失效。总管会重新处理。' });
  });

  it('等你决定：没有失效时 selectable 为真', async () => {
    const { fix, job } = await limitFix();
    await escalateFromPacket(fix, [REWRITE, OTHER]);
    expect(oldCard(fix, job.id)).toMatchObject({ stateText: '等你决定', selectable: true });
  });
});

/** 一件事实际建过的相关条目数：直接数表里这份约定和这件事的全部条目（含已回答、已撤回的）。 */
function relatedItems(fix: JobFix, job: { id: string; agreementId: string }): number {
  return fix.ctx.store.table('inbox').count(row => row.subjectKey.startsWith(`agreement:${job.agreementId}:`) || row.subjectKey.startsWith(`job:${job.id}:`));
}

/** 回执里「打扰你」的次数。 */
function disturbedRow(fix: JobFix): string {
  return theJob(fix).receipt!.find(row => row.label === '需要你处理')!.value;
}

describe('「打扰你」的累计不被旧记录覆盖', () => {
  it('约定确认、交付、主人指出不符后返工、再次交付、验收：回执次数等于实际建过的条目数', async () => {
    const { fix, job } = await delivered();
    await ownerTypes(fix, job.topicId, '第 3 条不对：失败时页面没有任何提示');
    const seen = reopenInfo(await chiefTurn(fix));
    expect(await callTool(fix, bot(fix, fix.chief.id), 'hub_job_manage', { mode: 'reopen', jobId: seen.jobId,
      items: [{ no: seen.nos[2]!, problem: '失败时页面没有任何提示', fixTo: '断开接口后页面显示「加载失败」' }], missed: '核对时只看了正常情况，这次要试' })).toMatchObject({ ok: true });
    await speak(fix, bot(fix, fix.chief.id), '返工第 3 条。', { outcome: 'progress' });
    const again = executorInfo(await nextPacket(fix, fix.engineer.id));
    await putStandardFiles(fix, again);
    expect(await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', { mode: 'submit', jobId: again.jobId, changeNote: '补了失败提示', deliverables: ['交付/报价页.html'], items: [metWithImage(3)] })).toMatchObject({ ok: true });
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '已交回' });
    const rv = reviewerInfo(await nextPacket(fix, fix.reviewer.id));
    expect(await callTool(fix, bot(fix, fix.reviewer.id), 'hub_job_work', { mode: 'review', jobId: rv.jobId, items: [{ no: 3, verdict: 'met' }] })).toMatchObject({ ok: true });
    expect(theJob(fix).state).toBe('awaiting_owner');
    expect(await fix.hub.api.acceptJob({ jobId: job.id, stage: theJob(fix).stage })).toMatchObject({ ok: true });
    const created = relatedItems(fix, job);
    expect(created).toBeGreaterThanOrEqual(3);
    expect(theJob(fix).disturbCount).toBe(created);
    expect(disturbedRow(fix)).toBe(`${created} 次`);
  });

  it('三轮不过、说明、选办法、再交付、验收：回执次数等于实际建过的条目数', async () => {
    const { fix, job } = await limitFix();
    await escalateFromPacket(fix, [REWRITE, OTHER]);
    expect(await fix.hub.api.chooseJobOption({ jobId: job.id, stage: 1, option: 0 })).toMatchObject({ ok: true });
    await flushJobHooks(fix.ctx);
    const rv = reviewerInfo(await nextPacket(fix, fix.reviewer.id));
    expect(await callTool(fix, bot(fix, fix.reviewer.id), 'hub_job_work', { mode: 'review', jobId: rv.jobId, items: [{ no: 3, verdict: 'met' }] })).toMatchObject({ ok: true });
    expect(theJob(fix).state).toBe('awaiting_owner');
    expect(await fix.hub.api.acceptJob({ jobId: job.id, stage: theJob(fix).stage })).toMatchObject({ ok: true });
    const created = relatedItems(fix, job);
    expect(created).toBeGreaterThanOrEqual(3);
    expect(theJob(fix).disturbCount).toBe(created);
    expect(disturbedRow(fix)).toBe(`${created} 次`);
  });
});

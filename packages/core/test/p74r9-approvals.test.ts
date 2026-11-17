/**
 * P74r9 第 2、3 节的测试：
 * 第 2 节：这件事验收通过（已完成）、停止或执行者被改派走时，属于这件事、还在等主人处理的普通审批由中心作废
 * （统一作废写法：已过期加 voided，卡片撤回，答复栏写原因）；作废之后主人批准不了、命令不会运行；发布审批不受影响；
 * 第 3 节：审批卡视图的三行（notes）：发布审批照旧给三行（缺的写「未说明」）；非发布审批员工写了至少一行给三行；一行都没写为 null。
 * 全部走真实的 Hub 和真实工具，时间用注入的假时钟。
 */
import { describe, expect, it } from 'vitest';
import { voidJobApprovals, VOID_JOB_DONE_TEXT, VOID_JOB_REASSIGNED_TEXT, VOID_JOB_STOPPED_TEXT } from '../src/job/void-job-approvals.js';
import { commitAndEnd, tick } from './p74c-fixtures.js';
import { ownerSays } from './p74b-fixtures.js';
import { bot, callTool, engineerSubmits, lastPacket, nextPacket, reviewerInfo, sectionOf, started, theJob, type JobFix } from './p74d-fixtures.js';
import { PASS_ITEMS } from './p74f-fixtures.js';
import { acceptedWithLaunch, launchArgs, submitLaunch } from './p74g-launch-fixtures.js';

/** 林舟在做这件事时提交一条普通命令的审批（不带费用等三行）；tag 不同，命令内容就不同，各自是一张审批。返回审批编号。 */
async function submitOrdinary(fix: JobFix, tag: string, extra: Record<string, unknown> = {}): Promise<string> {
  const base = launchArgs(fix) as { payload: Record<string, unknown> };
  const before = new Set(fix.ctx.store.table('approvals').list().map(row => row.id));
  const result = await callTool(fix, bot(fix, fix.engineer.id), 'hub_outbox_submit', {
    kind: 'run_command', why: `跑一次${tag}`, payload: { ...base.payload, args: [`work/${tag}.js`] }, ...extra });
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  return fix.ctx.store.table('approvals').list().find(row => !before.has(row.id))!.id;
}

/** 林舟交回、评审甲核对通过：这件事等主人验收（approvals 已在这之前提交）。 */
async function deliverNow(s: Awaited<ReturnType<typeof started>>, afterSubmit?: () => Promise<void>): Promise<void> {
  await engineerSubmits(s.fix, s.info);
  // P74r18a：执行者交回时，他此前提交的审批已由中心作废；要测「验收时仍开着的审批」，审批在交回之后、回合结束之前提交（afterSubmit）。
  if (afterSubmit !== undefined) await afterSubmit();
  await commitAndEnd(s.fix, s.fix.engineer.id, { outcome: 'progress', summary: '已交回' });
  const seen = reviewerInfo(await nextPacket(s.fix, s.fix.reviewer.id));
  expect(await callTool(s.fix, bot(s.fix, s.fix.reviewer.id), 'hub_job_work', { mode: 'review', jobId: seen.jobId, items: PASS_ITEMS })).toMatchObject({ ok: true });
  await commitAndEnd(s.fix, s.fix.reviewer.id, { outcome: 'progress', summary: '核对通过' });
}

/** 某张审批卡（收件箱条目）。 */
const cardOf = (fix: JobFix, approvalId: string) => fix.ctx.store.table('inbox').list(row => row.type === 'approval' && row.refId === approvalId)[0]!;

/** 断言一张审批已被中心作废：已过期加 voided、卡片撤回并写原因、主人批准不了、命令没有运行。 */
async function expectVoided(fix: JobFix, approvalId: string, reason: string): Promise<void> {
  expect(fix.ctx.store.table('approvals').get(approvalId)).toMatchObject({ status: 'expired', voided: true });
  expect(cardOf(fix, approvalId)).toMatchObject({ status: 'withdrawn', answer: reason });
  const decided = await fix.hub.api.decideApproval(approvalId, true);
  expect(decided.ok, JSON.stringify(decided)).toBe(false);
  await tick(fix, 2 * 60_000);
  expect(fix.ctx.exec.calls).toHaveLength(0);
  expect(fix.ctx.store.table('outbox').list(row => row.approvalId === approvalId).every(row => row.status !== 'done')).toBe(true);
}

describe('2 这件事结束时，还开着的普通审批作废', () => {
  it('固定句', () => {
    expect(VOID_JOB_DONE_TEXT).toBe('这件事已完成，这条审批不再需要，已作废');
    expect(VOID_JOB_STOPPED_TEXT).toBe('这件事已停止，这条审批不再需要，已作废');
    expect(VOID_JOB_REASSIGNED_TEXT).toBe('这件事已改派，这条审批不再需要，已作废');
  });

  it('验收通过：三张还在等的普通审批全部作废，答复栏逐字相同，主人批准不了，命令不会运行', async () => {
    const s = await started();
    const ids: string[] = [];
    await deliverNow(s, async () => { for (const tag of ['a', 'b', 'c']) ids.push(await submitOrdinary(s.fix, tag)); });
    expect(ids.every(id => s.fix.ctx.store.table('approvals').get(id)!.status === 'pending')).toBe(true);
    expect(await s.fix.hub.api.acceptJob({ jobId: theJob(s.fix).id, stage: theJob(s.fix).stage })).toMatchObject({ ok: true });
    for (const id of ids) await expectVoided(s.fix, id, '这件事已完成，这条审批不再需要，已作废');
  });

  it('已经主人处理过的审批不动：已拒绝的仍是已拒绝，不被改成作废', async () => {
    const s = await started();
    const rejected = await submitOrdinary(s.fix, 'a');
    const open = await submitOrdinary(s.fix, 'b');
    expect(await s.fix.hub.api.decideApproval(rejected, false)).toMatchObject({ ok: true });
    await deliverNow(s);
    expect(await s.fix.hub.api.acceptJob({ jobId: theJob(s.fix).id, stage: theJob(s.fix).stage })).toMatchObject({ ok: true });
    expect(s.fix.ctx.store.table('approvals').get(rejected)).toMatchObject({ status: 'rejected' });
    expect(s.fix.ctx.store.table('approvals').get(rejected)!.voided).toBeUndefined();
    expect(s.fix.ctx.store.table('approvals').get(open)).toMatchObject({ status: 'expired', voided: true });
  });

  it('发布审批不受影响：函数作废这件事的审批时，发布这一步的那一张仍在等主人；另一张普通审批作废', async () => {
    const { fix, job } = await acceptedWithLaunch();
    const { approval } = await submitLaunch(fix);
    // 同一件事上另有一张还在等的普通审批（P74r4a 第 9 条的情形：发布审批之外的第二张）：按发布审批的记录复制出一张，内容哈希与事的编号照旧。
    const other = 'ap_r9other001';
    fix.ctx.store.table('approvals').put({ ...approval, id: other, contentHash: 'b'.repeat(64) });
    fix.ctx.store.table('approvalNotes').put({ id: other, cost: null, undo: null, after: null, jobId: job.id, createdAt: fix.ctx.clock.now() });
    expect(theJob(fix).launch).toMatchObject({ state: 'approval', approvalId: approval.id });
    expect(voidJobApprovals(fix.ctx, theJob(fix), 'done', fix.ctx.clock.now())).toBe(1);
    expect(fix.ctx.store.table('approvals').get(approval.id)).toMatchObject({ status: 'pending' });
    expect(cardOf(fix, approval.id).status).toBe('open');
    expect(fix.ctx.store.table('approvals').get(other)).toMatchObject({ status: 'expired', voided: true });
    expect(theJob(fix).id).toBe(job.id);
  });

  it('停止：这件事停止时，还在等的普通审批作废，答复栏写「已停止」', async () => {
    const { fix, job } = await started();
    const id = await submitOrdinary(fix, 'a');
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '继续' });
    await ownerSays(fix, fix.chief.id, '这件事先不做了');
    expect(sectionOf(lastPacket(fix, bot(fix, fix.chief.id)))).toContain(job.id);
    const result = await callTool(fix, bot(fix, fix.chief.id), 'hub_job_manage', { mode: 'stop', jobId: job.id, reason: '你说这件事先不做了' });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(theJob(fix).state).toBe('stopped');
    await expectVoided(fix, id, '这件事已停止，这条审批不再需要，已作废');
  });

  it('改派：被换下的执行者提交的审批作废，答复栏写「已改派」；没有换执行者（只换核对人）时不作废', async () => {
    const { fix, job } = await started(['小周']);
    const id = await submitOrdinary(fix, 'a');
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '继续' });
    await ownerSays(fix, fix.chief.id, '换小周来做');
    // 只换核对人：审批不动。
    const reviewerOnly = await callTool(fix, bot(fix, fix.chief.id), 'hub_job_manage', { mode: 'reassign', jobId: job.id, reviewer: '总管' });
    expect(reviewerOnly, JSON.stringify(reviewerOnly)).toMatchObject({ ok: true });
    expect(fix.ctx.store.table('approvals').get(id)).toMatchObject({ status: 'pending' });
    // 换执行者：作废。
    const swapped = await callTool(fix, bot(fix, fix.chief.id), 'hub_job_manage', { mode: 'reassign', jobId: job.id, executor: '小周' });
    expect(swapped, JSON.stringify(swapped)).toMatchObject({ ok: true });
    await expectVoided(fix, id, '这件事已改派，这条审批不再需要，已作废');
  });

  it('不属于这件事的审批不动：员工私聊里主人叫他做事时提交的审批，这件事验收之后仍在等主人', async () => {
    const s = await started();
    // 与这件事无关的审批：直接按「没有旁表」的形状补一张（不带事的编号），验收后必须仍是待审批。
    const mine = await submitOrdinary(s.fix, 'a');
    s.fix.ctx.store.table('approvalNotes').remove(mine);
    await deliverNow(s);
    expect(await s.fix.hub.api.acceptJob({ jobId: theJob(s.fix).id, stage: theJob(s.fix).stage })).toMatchObject({ ok: true });
    expect(s.fix.ctx.store.table('approvals').get(mine)).toMatchObject({ status: 'pending' });
  });
});

describe('3 审批卡视图的三行', () => {
  /** 这张审批在「待你处理」里的视图。 */
  const viewOf = (fix: JobFix, approvalId: string) => fix.hub.api.inbox().items.find(row => row.approvalId === approvalId)!.approval!;

  it('发布审批：员工一行都没写，三行都写「未说明」，launch 为真', async () => {
    const { fix } = await acceptedWithLaunch();
    const { approval } = await submitLaunch(fix, { cost: undefined, undo: undefined, after: undefined });
    expect(viewOf(fix, approval.id)).toMatchObject({ launch: true, notes: { cost: '未说明', undo: '未说明', after: '未说明' } });
  });

  it('发布审批：员工只写了一行，其余写「未说明」', async () => {
    const { fix } = await acceptedWithLaunch();
    const { approval } = await submitLaunch(fix, { cost: '不产生费用', undo: undefined, after: undefined });
    expect(viewOf(fix, approval.id)).toMatchObject({ launch: true, notes: { cost: '不产生费用', undo: '未说明', after: '未说明' } });
  });

  it('非发布审批、员工写了至少一行：给三行，没写的项写「未说明」', async () => {
    const { fix } = await started();
    const id = await submitOrdinary(fix, 'a', { undo: '删掉生成的文件即可' });
    expect(viewOf(fix, id)).toMatchObject({ launch: false, onBehalfOf: '由林舟执行', notes: { cost: '未说明', undo: '删掉生成的文件即可', after: '未说明' } });
  });

  it('非发布审批、一行都没有写：notes 为 null，「由林舟执行」不受影响', async () => {
    const { fix } = await started();
    const id = await submitOrdinary(fix, 'a');
    expect(viewOf(fix, id)).toMatchObject({ launch: false, notes: null, onBehalfOf: '由林舟执行' });
  });
});

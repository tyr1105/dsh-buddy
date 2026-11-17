/**
 * P74r18a 第 3.2 节的测试：执行者交回时，他为这件事提交、还没有用掉的审批由中心作废。
 *
 * 走真实路径：执行者在干活的回合里用自己的命令工具（会话里的 bash 调用）触发审批，然后用 hub_job_work 的 submit 交回。
 * 覆盖：
 * - 两张审批作废，答复栏文字逐字，「待你处理」里只剩（核对通过之后的）验收一条；
 * - 核对人为这件事提交的审批、没有挂在这件事上的审批不受影响；
 * - 主人已批准、执行者没有用掉的那一张同样作废，之后用同样的命令再调用不会被放行；
 * - 返工之后执行者重新触发的审批照常建立。
 * 时间用注入的假时钟。
 */
import { describe, expect, it } from 'vitest';
import { VOID_JOB_DELIVERED_TEXT } from '../src/job/void-job-approvals.js';
import { commitAndEnd } from './p74c-fixtures.js';
import { bot, callTool, engineerSubmits, nextPacket, reviewerInfo, started, theJob, type JobFix } from './p74d-fixtures.js';
import { PASS_ITEMS } from './p74f-fixtures.js';

/** 需要主人批准的命令（对外 POST）。tag 不同，命令内容就不同，各自是一张审批。 */
const needsApproval = (tag: string) => ({ command: `curl -X POST https://example.com/api/${tag} -d x=1` });

/** 员工（按 id）用自己的会话调用命令工具；返回闸门的决定。 */
const runCommand = (fix: JobFix, botId: string, tag: string) => fix.hub.guardToolCall(bot(fix, botId).sessionId!, 'bash', needsApproval(tag));

/** 全部审批（按创建顺序）。 */
const approvalsOf = (fix: JobFix) => fix.ctx.store.table('approvals').list();

/** 这张审批的卡片（收件箱条目）。 */
const cardOf = (fix: JobFix, approvalId: string) => fix.ctx.store.table('inbox').list(row => row.type === 'approval' && row.refId === approvalId)[0]!;

/** 执行者用命令工具触发一张审批，返回这张审批的编号。 */
function triggerApproval(fix: JobFix, botId: string, tag: string): string {
  const before = new Set(approvalsOf(fix).map(row => row.id));
  expect(runCommand(fix, botId, tag)).toMatchObject({ allow: false, message: expect.stringContaining('已提交审批单') });
  return approvalsOf(fix).find(row => !before.has(row.id))!.id;
}

describe('3.2 执行者交回时作废他为这件事提交的审批', () => {
  it('固定句', () => {
    expect(VOID_JOB_DELIVERED_TEXT).toBe('这件事已交回核对，这条审批不再需要，已作废');
  });

  it('两张审批作废，答复栏逐字；核对通过之后「待你处理」里只剩验收一条', async () => {
    const s = await started();
    const a = triggerApproval(s.fix, s.fix.engineer.id, 'a');
    const b = triggerApproval(s.fix, s.fix.engineer.id, 'b');
    // 交回之前：两张审批和它们的卡片都开着。
    expect(s.fix.hub.api.inbox().items.filter(row => row.approvalId === a || row.approvalId === b)).toHaveLength(2);
    expect(await engineerSubmitsOk(s)).toBe(true);
    for (const id of [a, b]) {
      expect(s.fix.ctx.store.table('approvals').get(id)).toMatchObject({ status: 'expired', voided: true });
      expect(cardOf(s.fix, id)).toMatchObject({ status: 'withdrawn', answer: '这件事已交回核对，这条审批不再需要，已作废' });
      // 作废之后主人批准不了。
      expect((await s.fix.hub.api.decideApproval(id, true)).ok).toBe(false);
    }
    // 核对通过：待你处理里没有这两张审批，只剩验收这一条。
    await reviewPasses(s.fix);
    const items = s.fix.hub.api.inbox().items;
    expect(items.some(row => row.approvalId === a || row.approvalId === b)).toBe(false);
    expect(items).toHaveLength(1);
    expect(items[0]!.type).not.toBe('approval');
    expect(theJob(s.fix).state).toBe('awaiting_owner');
  });

  it('核对人为这件事提交的审批、没有挂在这件事上的审批不受影响', async () => {
    const s = await started();
    const mine = triggerApproval(s.fix, s.fix.engineer.id, 'mine');
    // 没有挂在这件事上的审批：执行者提交的，但旁表里没有这件事的编号（等同「为别的事提交的」）。
    const other = triggerApproval(s.fix, s.fix.engineer.id, 'other');
    s.fix.ctx.store.table('approvalNotes').remove(other);
    // 核对人为这件事提交的审批：核对人的会话里调用需要审批的命令。
    expect(await engineerSubmitsOk(s)).toBe(true);
    await nextPacket(s.fix, s.fix.reviewer.id);
    const reviewerOwn = triggerApproval(s.fix, s.fix.reviewer.id, 'reviewer');
    expect(s.fix.ctx.store.table('approvals').get(mine)).toMatchObject({ status: 'expired', voided: true });
    expect(s.fix.ctx.store.table('approvals').get(other)).toMatchObject({ status: 'pending' });
    expect(s.fix.ctx.store.table('approvals').get(reviewerOwn)).toMatchObject({ status: 'pending' });
  });

  it('主人已批准、执行者没有用掉的那一张同样作废；之后用同样的命令再调用不会被放行', async () => {
    const s = await started();
    const id = triggerApproval(s.fix, s.fix.engineer.id, 'approved');
    expect(await s.fix.hub.api.decideApproval(id, true)).toMatchObject({ ok: true });
    expect(s.fix.ctx.store.table('approvals').get(id)).toMatchObject({ status: 'approved', usedAt: null });
    expect(await engineerSubmitsOk(s)).toBe(true);
    expect(s.fix.ctx.store.table('approvals').get(id)).toMatchObject({ status: 'expired', voided: true });
    expect(cardOf(s.fix, id)).toMatchObject({ status: 'withdrawn', answer: '这件事已交回核对，这条审批不再需要，已作废' });
    // 之后执行者用同样的参数再调用：批准已作废，不放行（只会建一张新的审批）。
    const again = runCommand(s.fix, s.fix.engineer.id, 'approved');
    expect(again.allow).toBe(false);
  });

  it('返工之后执行者重新触发的审批照常建立，不被作废', async () => {
    const s = await started();
    const first = triggerApproval(s.fix, s.fix.engineer.id, 'first');
    expect(await engineerSubmitsOk(s)).toBe(true);
    expect(s.fix.ctx.store.table('approvals').get(first)).toMatchObject({ status: 'expired', voided: true });
    // 核对人退回一条：这件事返工。
    const seen = reviewerInfo(await nextPacket(s.fix, s.fix.reviewer.id));
    const items = [{ no: 1, verdict: 'at_delivery' }, { no: 2, verdict: 'met' }, { no: 3, verdict: 'unmet', note: '没有失败提示', fixTo: '失败时显示「加载失败」' }];
    expect(await callTool(s.fix, bot(s.fix, s.fix.reviewer.id), 'hub_job_work', { mode: 'review', jobId: seen.jobId, items })).toMatchObject({ ok: true });
    await commitAndEnd(s.fix, s.fix.reviewer.id, { outcome: 'progress', summary: '退回一条' });
    await nextPacket(s.fix, s.fix.engineer.id);
    expect(theJob(s.fix).state).toBe('rework');
    const second = triggerApproval(s.fix, s.fix.engineer.id, 'second');
    expect(s.fix.ctx.store.table('approvals').get(second)).toMatchObject({ status: 'pending' });
    expect(cardOf(s.fix, second).status).toBe('open');
  });
});

/** 执行者交回（真实工具）并结束回合；成功返回 true。 */
async function engineerSubmitsOk(s: Awaited<ReturnType<typeof started>>): Promise<boolean> {
  await engineerSubmits(s.fix, s.info);
  await commitAndEnd(s.fix, s.fix.engineer.id, { outcome: 'progress', summary: '已交回' });
  return true;
}

/** 核对人核对通过，这件事等主人验收。 */
async function reviewPasses(fix: JobFix): Promise<void> {
  const seen = reviewerInfo(await nextPacket(fix, fix.reviewer.id));
  expect(await callTool(fix, bot(fix, fix.reviewer.id), 'hub_job_work', { mode: 'review', jobId: seen.jobId, items: PASS_ITEMS })).toMatchObject({ ok: true });
  await commitAndEnd(fix, fix.reviewer.id, { outcome: 'progress', summary: '核对通过' });
}

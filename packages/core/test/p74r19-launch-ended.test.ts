/**
 * P74r19 第 2、4 节的测试：发布这一步结束时不留下没人处理的审批；暂不发布之后这件事的主题里落一句。
 *
 * 走真实路径（假时钟、假命令执行接口）：验收之后执行者在发布准备回合里先提交发布命令（成为发布审批），
 * 再用自己的命令工具触发一张属于这件事的普通审批（leftover，待批准）。然后让发布这一步用不同方式结束：
 * 主人点暂不发布、命令成功记为已发布、发布审批过期、中心结束（回合用满）、中心结束（执行者交账 blocked）。
 * 第 2 节：三种结束方式（暂不发布、已发布、审批过期）各一条正例；发布没有成功不算结束；别的事、别的员工、不属于任何事的审批不受影响。
 * 第 4 节：主人点暂不发布 -> 主题里「你选择了暂不发布。」；中心结束 -> 「这件事没有发布。」；主题不能再落话时不报错。
 */
import { describe, expect, it } from 'vitest';
import { executeReadyOutbox } from '../src/gate/outbox.js';
import { expireApprovals } from '../src/gate/approvals.js';
import { stopLaunchForCap } from '../src/job/launch-approval.js';
import { VOID_JOB_LAUNCH_ENDED_TEXT } from '../src/job/void-job-approvals.js';
import { commitAndEnd } from './p74c-fixtures.js';
import { bot, callTool, nextPacket, theJob, threadOf, tick, MINUTE, type JobFix } from './p74f-fixtures.js';
import { acceptedWithLaunch, launchArgs } from './p74g-launch-fixtures.js';

const OK = { code: 0, stdout: '', stderr: '', timedOut: false };
const DENIED = { code: 1, stdout: '', stderr: 'mkdir: /tmp/x: Operation not permitted', timedOut: false };
const ENDED = '这件事的发布已结束';

const approvals = (fix: JobFix) => fix.ctx.store.table('approvals').list();
const card = (fix: JobFix, approvalId: string) => fix.ctx.store.table('inbox').list(row => row.type === 'approval' && row.refId === approvalId)[0]!;
const topicTexts = (fix: JobFix) => threadOf(fix.ctx, theJob(fix).topicId).map(row => row.text);

/** 执行者用自己的命令工具触发一张需要批准的审批（会话里的 bash 调用），返回审批编号。tag 不同内容就不同。 */
function triggerApproval(fix: JobFix, tag: string): string {
  const before = new Set(approvals(fix).map(row => row.id));
  expect(fix.hub.guardToolCall(bot(fix, fix.engineer.id).sessionId!, 'bash', { command: `curl -X POST https://example.com/api/${tag} -d x=1` }))
    .toMatchObject({ allow: false, message: expect.stringContaining('已提交审批单') });
  return approvals(fix).find(row => !before.has(row.id))!.id;
}

/** 验收之后：执行者提交发布命令（发布审批），再触发一张属于这件事的待批准普通审批。 */
async function withLeftover() {
  const { fix, job } = await acceptedWithLaunch();
  await nextPacket(fix, fix.engineer.id);
  const result = await callTool(fix, bot(fix, fix.engineer.id), 'hub_outbox_submit', launchArgs(fix));
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  const launchApproval = approvals(fix)[0]!;
  // 稍等一会儿再触发：让这张普通审批的到期时间晚于发布审批，「审批过期」那条里只有发布审批先到期。
  await tick(fix, 5 * MINUTE);
  const leftoverId = triggerApproval(fix, 'leftover');
  expect(fix.ctx.store.table('approvalNotes').get(leftoverId)!.jobId).toBe(job.id);
  expect(fix.ctx.store.table('approvals').get(leftoverId)).toMatchObject({ status: 'pending' });
  await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '已提交发布审批，等主人批准' });
  return { fix, job, launchApproval, leftoverId };
}

/** 作废的结果：审批单已过期且带作废标记，卡片已撤回、答复栏写原因。 */
function expectVoided(fix: JobFix, id: string) {
  expect(fix.ctx.store.table('approvals').get(id)).toMatchObject({ status: 'expired', voided: true });
  expect(card(fix, id)).toMatchObject({ status: 'withdrawn', answer: ENDED });
}

describe('2 发布这一步结束：这件事其余待批准的审批作废', () => {
  it('固定句', () => {
    expect(VOID_JOB_LAUNCH_ENDED_TEXT).toBe('这件事的发布已结束');
  });

  it('主人点暂不发布：那张普通审批作废（答复栏逐字），待你处理里不再有它；主人批准不了', async () => {
    const { fix, launchApproval, leftoverId } = await withLeftover();
    expect(await fix.hub.api.decideApproval(launchApproval.id, false)).toMatchObject({ ok: true });
    expect(theJob(fix).launch).toMatchObject({ state: 'declined', endedBy: 'owner' });
    expectVoided(fix, leftoverId);
    expect(fix.hub.api.inbox().items.filter(row => row.type === 'approval')).toHaveLength(0);
    expect(await fix.hub.api.decideApproval(leftoverId, true)).toMatchObject({ ok: false });
  });

  it('命令成功、记为已发布：那张普通审批作废', async () => {
    const { fix, launchApproval, leftoverId } = await withLeftover();
    fix.ctx.exec.set('node', ['work/go-live.js'], OK);
    expect(await fix.hub.api.decideApproval(launchApproval.id, true)).toMatchObject({ ok: true });
    await executeReadyOutbox(fix.ctx);
    expect(theJob(fix).launch.state).toBe('done');
    expectVoided(fix, leftoverId);
  });

  it('发布审批过期：那张普通审批作废', async () => {
    const { fix, launchApproval, leftoverId } = await withLeftover();
    await expireApprovals(fix.ctx, launchApproval.expiresAt + 1);
    expect(theJob(fix).launch).toMatchObject({ state: 'declined', endedBy: 'hub' });
    expectVoided(fix, leftoverId);
  });

  it('中心结束（发布这一步用满回合）：那张普通审批作废', async () => {
    const { fix, job, leftoverId } = await withLeftover();
    stopLaunchForCap(fix.ctx, job.id);
    expect(theJob(fix).launch).toMatchObject({ state: 'declined', endedBy: 'hub' });
    expectVoided(fix, leftoverId);
  });

  it('反例：发布没有成功不算结束，那张普通审批仍在等批准', async () => {
    const { fix, launchApproval, leftoverId } = await withLeftover();
    fix.ctx.exec.set('node', ['work/go-live.js'], DENIED);
    expect(await fix.hub.api.decideApproval(launchApproval.id, true)).toMatchObject({ ok: true });
    await executeReadyOutbox(fix.ctx);
    expect(theJob(fix).launch.state).toBe('failed');
    expect(fix.ctx.store.table('approvals').get(leftoverId)).toMatchObject({ status: 'pending' });
    expect(card(fix, leftoverId).status).toBe('open');
  });

  it('反例：别的事的审批、别的员工的审批、不属于任何事的审批不受影响', async () => {
    const { fix, job, launchApproval, leftoverId } = await withLeftover();
    const row = fix.ctx.store.table('approvals').get(leftoverId)!;
    const clone = (id: string, patch: Record<string, unknown>) => {
      fix.ctx.store.table('approvals').put({ ...row, ...patch, id, contentHash: id.replace(/\W/g, '').padEnd(64, 'a').slice(0, 64).toLowerCase().replace(/[^a-f0-9]/g, 'b') });
      return id;
    };
    const note = (id: string, jobId: string | null) => fix.ctx.store.table('approvalNotes').put({ id, cost: null, undo: null, after: null, jobId, createdAt: fix.ctx.clock.now() });
    const otherJob = clone('ap_otherjob01', {}); note(otherJob, 'job_otherjob01');
    const otherBot = clone('ap_otherbot01', { botId: fix.reviewer.id }); note(otherBot, job.id);
    const noJob = clone('ap_nojobbb001', {}); note(noJob, null);
    const noNote = clone('ap_nonotes001', {});
    expect(await fix.hub.api.decideApproval(launchApproval.id, false)).toMatchObject({ ok: true });
    expectVoided(fix, leftoverId);
    for (const id of [otherJob, otherBot, noJob, noNote]) {
      expect(fix.ctx.store.table('approvals').get(id), id).toMatchObject({ status: 'pending' });
    }
  });
});

describe('4 暂不发布之后这件事的主题里落一句', () => {
  it('主人点暂不发布：主题里落「你选择了暂不发布。」，且只落一句', async () => {
    const { fix, launchApproval } = await withLeftover();
    const before = topicTexts(fix).length;
    expect(await fix.hub.api.decideApproval(launchApproval.id, false)).toMatchObject({ ok: true });
    expect(topicTexts(fix).filter(text => text === '你选择了暂不发布。')).toHaveLength(1);
    expect(topicTexts(fix).filter(text => text === '这件事没有发布。')).toHaveLength(0);
    expect(topicTexts(fix).length).toBeGreaterThan(before);
    const line = threadOf(fix.ctx, theJob(fix).topicId).find(row => row.text === '你选择了暂不发布。')!;
    expect(line).toMatchObject({ from: 'hub', kind: 'system' });
  });

  it('中心结束：审批过期、回合用满、执行者交账 blocked 三种，主题里都落「这件事没有发布。」', async () => {
    const expired = await withLeftover();
    await expireApprovals(expired.fix.ctx, expired.launchApproval.expiresAt + 1);
    expect(topicTexts(expired.fix).filter(text => text === '这件事没有发布。')).toHaveLength(1);
    expect(topicTexts(expired.fix).filter(text => text === '你选择了暂不发布。')).toHaveLength(0);

    const capped = await withLeftover();
    stopLaunchForCap(capped.fix.ctx, capped.job.id);
    expect(topicTexts(capped.fix).filter(text => text === '这件事没有发布。')).toHaveLength(1);

    // 执行者交账 blocked：发布准备中、还没有提交审批。
    const blocked = await acceptedWithLaunch();
    await nextPacket(blocked.fix, blocked.fix.engineer.id);
    await commitAndEnd(blocked.fix, blocked.fix.engineer.id, { outcome: 'blocked', blocker: '发布位置不在能写入的范围内', summary: '写不进去' });
    expect(theJob(blocked.fix).launch).toMatchObject({ state: 'declined', endedBy: 'hub' });
    expect(topicTexts(blocked.fix).filter(text => text === '这件事没有发布。')).toHaveLength(1);
  });

  it('反例：发布没有成功（failed）不算结束，主题里没有这两句', async () => {
    const { fix, launchApproval } = await withLeftover();
    fix.ctx.exec.set('node', ['work/go-live.js'], DENIED);
    expect(await fix.hub.api.decideApproval(launchApproval.id, true)).toMatchObject({ ok: true });
    await executeReadyOutbox(fix.ctx);
    expect(topicTexts(fix).filter(text => text === '这件事没有发布。' || text === '你选择了暂不发布。')).toHaveLength(0);
  });

  it('主题已经不能再落话（项目已归档）：不报错，发布状态照常变，也没有这两句', async () => {
    const { fix, launchApproval } = await withLeftover();
    const topic = fix.ctx.store.table('projectTopics').get(theJob(fix).topicId)!;
    fix.ctx.store.table('projects').patch(topic.projectId, { status: 'archived' });
    const before = topicTexts(fix).length;
    expect(await fix.hub.api.decideApproval(launchApproval.id, false)).toMatchObject({ ok: true });
    expect(theJob(fix).launch).toMatchObject({ state: 'declined', endedBy: 'owner' });
    expect(topicTexts(fix)).toHaveLength(before);
  });
});

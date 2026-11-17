/**
 * P74b 的测试：归档与停用对「一件事」的处理。
 * - 正在做事的员工不能归档（先请总管改派）；归档时补上第二块留下的疑点：未处理的交接、认领、待批的审批单；
 * - 停用（含系统隔离）：这件事转受阻，总管私聊一句；恢复在岗：回到原状态并叫他一次。
 * 走真实 Hub，时间用注入的假时钟。
 */
import { describe, expect, it } from 'vitest';
import { lifecycleAction } from '../src/api/bots.js';
import { quarantine } from '../src/health/quarantine.js';
import { requestApproval } from '../src/gate/approvals.js';
import { eventsOf } from '../src/job/store.js';
import { claim, createHandoff } from '../src/peer/index.js';
import { agreementIdIn } from './p73d-fixtures.js';
import { assignArgs, callTool, jobFix, lockedAndAwake, threadOf, type JobFix } from './p74b-fixtures.js';

const INTERNAL = /hub_|b_|job_|agr_/;

/** 总管已把「会员定价页」派给林舟（评审甲核对），事还在待开工；返回这件事。 */
async function assigned(fix: JobFix) {
  const id = agreementIdIn(await lockedAndAwake(fix));
  expect(await callTool(fix, fix.chief, 'hub_job_manage', assignArgs(id))).toMatchObject({ ok: true });
  return fix.ctx.store.table('jobs').list()[0]!;
}

/** 某员工因这件事被叫醒了没有：有唤醒单，或候选还排着。 */
function woken(fix: JobFix, botId: string, jobId: string): number {
  return fix.ctx.store.table('wakes').count(row => row.botId === botId && row.jobId === jobId)
    + fix.ctx.store.table('queue').count(row => row.botId === botId && row.jobId === jobId);
}

describe('15 归档', () => {
  it('林舟正在做 A 时归档被拒（文字正确）；改派后可归档，并从项目成员里移出', async () => {
    const fix = await jobFix(['小周']);
    const job = await assigned(fix);
    await expect(lifecycleAction(fix.ctx, { botId: fix.engineer.id, action: 'archive' })).rejects.toThrow('林舟正在做「会员定价页」，请先请总管改派。');
    // 核对人同样不能归档。
    await expect(lifecycleAction(fix.ctx, { botId: fix.reviewer.id, action: 'archive' })).rejects.toThrow('评审甲正在做「会员定价页」，请先请总管改派。');
    expect(fix.ctx.store.table('bots').get(fix.engineer.id)!.lifecycle).toBe('active');
    // 改派后可以归档。
    expect(await callTool(fix, fix.chief, 'hub_job_manage', { mode: 'reassign', jobId: job.id, executor: '小周' })).toMatchObject({ ok: true });
    const archived = await lifecycleAction(fix.ctx, { botId: fix.engineer.id, action: 'archive' });
    expect(archived.lifecycle).toBe('retired');
    expect(fix.ctx.store.table('projects').get(job.projectId)!.memberBotIds).not.toContain(fix.engineer.id);
  });

  it('已完成、已停止的事不拦归档', async () => {
    const fix = await jobFix();
    const job = await assigned(fix);
    fix.ctx.store.table('jobs').patch(job.id, { state: 'stopped' });
    fix.ctx.store.table('jobs').patch(job.id, { reviewerId: null });
    const archived = await lifecycleAction(fix.ctx, { botId: fix.engineer.id, action: 'archive' });
    expect(archived.lifecycle).toBe('retired');
  });

  it('归档一位有未处理交接、认领、待批审批单的员工：交接变已拒绝并通知发起人，认领删除，审批单拒绝且「待你处理」条目关闭', async () => {
    const fix = await jobFix(['小钱']);
    const staff = fix.extras[0]!;
    const handoff = await createHandoff(fix.ctx, fix.chief.id, { to: staff.id, task: '整理资料', why: '约定' });
    expect(handoff.status).toBe('offered');
    claim(fix.ctx, staff.id, { resource: '报告目录', why: '正在整理' });
    const approval = await requestApproval(fix.ctx, staff.id, 'http_post', { url: 'https://example.test/x' }, 'C', '发布一条公开消息');
    expect(fix.ctx.store.table('inbox').count(row => row.status === 'open' && row.refId === approval.id)).toBe(1);

    const archived = await lifecycleAction(fix.ctx, { botId: staff.id, action: 'archive' });
    expect(archived.lifecycle).toBe('retired');
    // 交接：已拒绝，发起人（总管）收到通知。
    expect(fix.ctx.store.table('handoffs').get(handoff.id)!.status).toBe('declined');
    expect(fix.ctx.store.table('percepts').list(row => row.botId === fix.chief.id).some(row => row.summary.includes('拒绝了交接：整理资料'))).toBe(true);
    // 认领：全部删除。
    expect(fix.ctx.store.table('claims').count(row => row.botId === staff.id)).toBe(0);
    // 审批单：拒绝，对应条目关闭；他已归档，不会被叫醒。
    expect(fix.ctx.store.table('approvals').get(approval.id)!.status).toBe('rejected');
    expect(fix.ctx.store.table('inbox').count(row => row.status === 'open' && row.refId === approval.id)).toBe(0);
    expect(fix.ctx.store.table('queue').count(row => row.botId === staff.id)).toBe(0);
    // 各写一条审计。
    const actions = fix.ctx.store.log('audit').all().map(row => row.action);
    for (const action of ['archive_handoff_declined', 'archive_claim_released', 'archive_approval_rejected']) expect(actions).toContain(action);
  });
});

describe('16 停用与恢复在岗', () => {
  it('停用林舟：A 受阻（participant_off），总管私聊一句；恢复在岗：A 回到原状态，林舟被叫醒', async () => {
    const fix = await jobFix();
    const job = await assigned(fix);
    fix.ctx.store.table('jobs').patch(job.id, { state: 'doing', startedAt: fix.ctx.clock.now() });
    // 派活时排的唤醒先清掉，才能看出恢复在岗那一次。
    for (const entry of fix.ctx.store.table('queue').list(row => row.botId === fix.engineer.id)) fix.ctx.store.table('queue').remove(entry.id);

    await lifecycleAction(fix.ctx, { botId: fix.engineer.id, action: 'suspend' });
    const blocked = fix.ctx.store.table('jobs').get(job.id)!;
    expect(blocked).toMatchObject({ state: 'blocked', blocked: { kind: 'participant_off', text: '林舟已停用', resumeTo: 'doing' } });
    const note = threadOf(fix.ctx, fix.chief.id).find(row => row.from === 'hub' && row.text.startsWith('林舟已停用，'))!;
    expect(note.text).toBe('林舟已停用，「会员定价页」停在执行。恢复在岗，或告诉总管改派。');
    expect(note.text).not.toMatch(INTERNAL);
    expect(eventsOf(fix.ctx, job.id).map(row => row.kind)).toContain('participant_off');

    const before = woken(fix, fix.engineer.id, job.id);
    await lifecycleAction(fix.ctx, { botId: fix.engineer.id, action: 'reinstate' });
    expect(fix.ctx.store.table('jobs').get(job.id)).toMatchObject({ state: 'doing', blocked: null });
    expect(woken(fix, fix.engineer.id, job.id)).toBe(before + 1);
  });

  it('系统隔离同样让这件事受阻，恢复在岗后回到原状态', async () => {
    const fix = await jobFix();
    const job = await assigned(fix);
    quarantine(fix.ctx, fix.engineer.id, '越界');
    expect(fix.ctx.store.table('jobs').get(job.id)).toMatchObject({ state: 'blocked', blocked: { kind: 'participant_off', resumeTo: 'ready' } });
    await lifecycleAction(fix.ctx, { botId: fix.engineer.id, action: 'reinstate' });
    expect(fix.ctx.store.table('jobs').get(job.id)).toMatchObject({ state: 'ready', blocked: null });
  });

  it('核对人停用：核对中的事受阻；恢复在岗后叫的是核对人；等主人验收的事不受影响', async () => {
    const fix = await jobFix();
    const job = await assigned(fix);
    fix.ctx.store.table('jobs').patch(job.id, { state: 'checking', round: 1 });
    for (const entry of fix.ctx.store.table('queue').list()) fix.ctx.store.table('queue').remove(entry.id);
    await lifecycleAction(fix.ctx, { botId: fix.reviewer.id, action: 'suspend' });
    expect(fix.ctx.store.table('jobs').get(job.id)).toMatchObject({ state: 'blocked', blocked: { kind: 'participant_off', resumeTo: 'checking', text: '评审甲已停用' } });
    expect(threadOf(fix.ctx, fix.chief.id).some(row => row.text === '评审甲已停用，「会员定价页」停在核对。恢复在岗，或告诉总管改派。')).toBe(true);
    await lifecycleAction(fix.ctx, { botId: fix.reviewer.id, action: 'reinstate' });
    expect(fix.ctx.store.table('jobs').get(job.id)).toMatchObject({ state: 'checking', blocked: null });
    expect(woken(fix, fix.reviewer.id, job.id)).toBe(1);
    expect(woken(fix, fix.engineer.id, job.id)).toBe(0);
    // 等主人验收：停用执行者不改变状态。
    fix.ctx.store.table('jobs').patch(job.id, { state: 'awaiting_owner' });
    await lifecycleAction(fix.ctx, { botId: fix.engineer.id, action: 'suspend' });
    expect(fix.ctx.store.table('jobs').get(job.id)!.state).toBe('awaiting_owner');
  });

  it('两位参与者都停用：先恢复一位时不解除受阻，两位都恢复后才回到原状态', async () => {
    const fix = await jobFix();
    const job = await assigned(fix);
    await lifecycleAction(fix.ctx, { botId: fix.engineer.id, action: 'suspend' });
    await lifecycleAction(fix.ctx, { botId: fix.reviewer.id, action: 'suspend' });
    await lifecycleAction(fix.ctx, { botId: fix.engineer.id, action: 'reinstate' });
    expect(fix.ctx.store.table('jobs').get(job.id)!.state).toBe('blocked');
    await lifecycleAction(fix.ctx, { botId: fix.reviewer.id, action: 'reinstate' });
    expect(fix.ctx.store.table('jobs').get(job.id)).toMatchObject({ state: 'ready', blocked: null });
  });

  it('反例：没有参与任何事的员工停用，不产生任何提示和事件', async () => {
    const fix = await jobFix(['小周']);
    await assigned(fix);
    const notesBefore = threadOf(fix.ctx, fix.chief.id).length;
    await lifecycleAction(fix.ctx, { botId: fix.extras[0]!.id, action: 'suspend' });
    expect(threadOf(fix.ctx, fix.chief.id).length).toBe(notesBefore);
    expect(fix.ctx.store.log('jobEvents').all().some(row => row.kind === 'participant_off')).toBe(false);
  });
});

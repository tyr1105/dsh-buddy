/**
 * P74r17 第 1、2、3 节的测试：发布这一步结束之后，入口把关在「宿主取消失败」和「员工自己的工具」两种情形下同样起作用。
 *
 * 全部走真实的 Hub、真实工具；时间用注入的假时钟，每次推进不超过 10 分钟。夹具与 p74r15-launch-end 相同（holdCancel 卡住宿主取消）。
 * 覆盖：
 * 1 宿主取消抛错：回合仍开着；执行者另提交一条不同的发布命令：被拒（逐字）、不建审批、总管私聊没有新消息；
 *   宿主取消期间回合交了账：回合状态仍是已交账，没有被改写成超时（低-6）；
 * 2 取消卡住的空档里，执行者用自己的命令工具运行要审批的命令：返回逐字的一句、审批表和总管私聊都没有新增；
 *   反例：发布环节还没结束时照常建审批；员工没有挂在已完成的事上时照常建审批；不需要审批的命令照常放行；
 * 3 发布审批被拒、取消被卡住时原样再提交：返回 LAUNCH_ENDED_REFUSAL_TEXT，旧的出站记录状态不再是等待批准；
 *   反例：与发布无关的普通审批被拒之后再提交，当作新的提交。
 */
import { describe, expect, it, vi } from 'vitest';
import type { FakeHost } from '../src/io/testing/fake-host.js';
import { LAUNCH_ENDED_REFUSAL_TEXT, LAUNCH_ENDED_TOOL_REFUSAL_TEXT } from '../src/job/launch-cancel.js';
import { commitAs, runningOf } from './p74c-fixtures.js';
import { bot, callTool, nextPacket, theJob, threadOf, type JobFix } from './p74f-fixtures.js';
import { acceptedWithLaunch, launchArgs } from './p74g-launch-fixtures.js';

/** 给模型看的两句拒绝文字（逐字，与任务卡一致）。 */
const TOOL_REFUSAL = '这件事已经完成，对外发布也已结束（或约定里没有对外发布），需要主人批准的动作不再提交。请直接交账收尾。';

/** 一条需要审批的原生命令（对外 POST）和一条不需要审批的只读命令。 */
const NEEDS_APPROVAL = { command: 'curl -X POST https://example.com/api -d x=1' };
const READ_ONLY = { command: 'ls' };

/** 总管私聊目前的全部文字。 */
const chiefTexts = (fix: JobFix) => threadOf(fix.ctx, fix.chief.id).map(row => row.text);

/** 让宿主的取消先不返回，直到调用返回的 release：模拟「取消还没有生效」的空档。 */
function holdCancel(fix: JobFix): () => void {
  const host = fix.ctx.host as unknown as FakeHost;
  const original = host.cancel.bind(host);
  let release: () => void = () => undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  host.cancel = async (sessionId: string) => { await gate; await original(sessionId); };
  return release;
}

/** 让宿主的取消抛错；返回「已被调用的次数」的读取函数。 */
function failCancel(fix: JobFix): () => number {
  const host = fix.ctx.host as unknown as FakeHost;
  let calls = 0;
  host.cancel = async () => { calls += 1; throw new Error('宿主取消失败'); };
  return () => calls;
}

/** 当前的快照：总管私聊文字、审批数、出站记录数。 */
const snapshot = (fix: JobFix) => ({ thread: chiefTexts(fix), approvals: fix.ctx.store.table('approvals').list().length, outbox: fix.ctx.store.table('outbox').list().length });

/** 执行者拿到发布准备的回合并提交发布命令（审批建立），回合仍开着。返回审批编号和这一回合。 */
async function launchSubmitted(fix: JobFix) {
  await nextPacket(fix, fix.engineer.id);
  expect(await callTool(fix, bot(fix, fix.engineer.id), 'hub_outbox_submit', launchArgs(fix))).toMatchObject({ ok: true });
  const approval = fix.ctx.store.table('approvals').list()[0]!;
  return { approvalId: approval.id, turn: runningOf(fix, fix.engineer.id)! };
}

describe('1 宿主取消抛错：回合保持打开，入口把关照常起作用', () => {
  it('取消抛错后回合仍开着；执行者另提交一条不同的发布命令被拒（逐字），不建审批，总管私聊没有新消息', async () => {
    const { fix } = await acceptedWithLaunch();
    const { approvalId, turn } = await launchSubmitted(fix);
    const calls = failCancel(fix);
    expect(await fix.hub.api.decideApproval(approvalId, false)).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(calls()).toBe(1));
    // 让取消失败之后的异步收尾跑完（旧写法会在这里把回合记为结束）。
    for (let i = 0; i < 5; i += 1) await new Promise(resolve => setTimeout(resolve, 5));
    expect(theJob(fix).launch).toMatchObject({ state: 'declined', endedBy: 'owner' });
    expect(fix.ctx.store.table('wakes').get(turn.id)).toMatchObject({ endedAt: null, status: 'running' });
    const before = snapshot(fix);
    // 与被拒的那条不同的发布命令。
    const result = await callTool(fix, bot(fix, fix.engineer.id), 'hub_outbox_submit',
      launchArgs(fix, { payload: { cmd: 'node', args: ['work/go-live.js', '--force'], cwd: bot(fix, fix.engineer.id).homeDir } }));
    expect(result).toEqual({ ok: false, error: LAUNCH_ENDED_REFUSAL_TEXT });
    expect(LAUNCH_ENDED_REFUSAL_TEXT).toBe('这件事的对外发布已经结束（或约定里没有对外发布），不再提交发布。');
    expect(snapshot(fix)).toEqual(before);
  });

  it('宿主取消期间回合交了账：回合状态仍是已交账，没有被改写成超时', async () => {
    const { fix } = await acceptedWithLaunch();
    const { approvalId, turn } = await launchSubmitted(fix);
    const host = fix.ctx.host as unknown as FakeHost;
    const original = host.cancel.bind(host);
    let release: () => void = () => undefined;
    let cancelReturned = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    host.cancel = async (sessionId: string) => { await gate; await original(sessionId); cancelReturned = true; };
    const deciding = fix.hub.api.decideApproval(approvalId, false);
    await vi.waitFor(() => expect(theJob(fix).launch).toMatchObject({ state: 'declined' }));
    // 取消还没有生效，回合在这个空档里交账。
    expect(await commitAs(fix, fix.engineer.id, { outcome: 'progress', summary: '主人暂不发布，收尾' })).toMatchObject({ ok: true });
    expect(fix.ctx.store.table('wakes').get(turn.id)).toMatchObject({ status: 'committed', endedAt: null });
    release();
    expect(await deciding).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(cancelReturned).toBe(true));
    for (let i = 0; i < 5; i += 1) await new Promise(resolve => setTimeout(resolve, 5));
    const after = fix.ctx.store.table('wakes').get(turn.id)!;
    expect(after.status).toBe('committed');
    expect(after.error ?? '').not.toContain('中心结束本回合');
  });
});

describe('2 员工自己的工具触发的审批同样把关', () => {
  /** 发布审批被拒、取消被卡住、回合仍开着。 */
  async function gapAfterDecline() {
    const { fix } = await acceptedWithLaunch();
    const { approvalId, turn } = await launchSubmitted(fix);
    const release = holdCancel(fix);
    const deciding = fix.hub.api.decideApproval(approvalId, false);
    await vi.waitFor(() => expect(theJob(fix).launch).toMatchObject({ state: 'declined', endedBy: 'owner' }));
    expect(fix.ctx.store.table('wakes').get(turn.id)!.endedAt).toBeNull();
    return { fix, release, deciding };
  }

  it('空档里员工用命令工具运行要审批的命令：返回逐字的一句，审批表和总管私聊都没有新增', async () => {
    const { fix, release, deciding } = await gapAfterDecline();
    const before = snapshot(fix);
    const decision = fix.hub.guardToolCall(bot(fix, fix.engineer.id).sessionId!, 'bash', NEEDS_APPROVAL);
    expect(decision).toEqual({ allow: false, message: TOOL_REFUSAL });
    expect(LAUNCH_ENDED_TOOL_REFUSAL_TEXT).toBe(TOOL_REFUSAL);
    expect(snapshot(fix)).toEqual(before);
    expect(chiefTexts(fix).some(text => text.includes('在准备发布'))).toBe(false);
    // 不需要审批的命令照常放行（反例）。
    expect(fix.hub.guardToolCall(bot(fix, fix.engineer.id).sessionId!, 'bash', READ_ONLY).allow).toBe(true);
    release();
    await deciding;
  });

  it('反例：发布环节还没结束时同样的调用照常建审批', async () => {
    const { fix } = await acceptedWithLaunch();
    await nextPacket(fix, fix.engineer.id);
    expect(theJob(fix).launch.state).toBe('preparing');
    const before = fix.ctx.store.table('approvals').list().length;
    const decision = fix.hub.guardToolCall(bot(fix, fix.engineer.id).sessionId!, 'bash', NEEDS_APPROVAL);
    expect(decision).toMatchObject({ allow: false, message: expect.stringContaining('已提交审批单') });
    expect(fix.ctx.store.table('approvals').list().length).toBe(before + 1);
  });

  it('反例：这位员工没有挂在任何已完成的事上时照常建审批（核对人不是这件事的执行者）', async () => {
    const { fix, release, deciding } = await gapAfterDecline();
    // 评审甲不是这件事的执行者，只要他有会话，他的要审批的调用就照常建审批。
    const reviewer = bot(fix, fix.reviewer.id);
    expect(reviewer.sessionId, '评审甲应该有会话').toBeTruthy();
    const before = fix.ctx.store.table('approvals').list().length;
    const decision = fix.hub.guardToolCall(reviewer.sessionId!, 'bash', NEEDS_APPROVAL);
    expect(decision).toMatchObject({ allow: false, message: expect.stringContaining('已提交审批单') });
    expect(fix.ctx.store.table('approvals').list().length).toBe(before + 1);
    release();
    await deciding;
  });
});

describe('3 被拒之后原样再提交', () => {
  it('发布审批被拒、取消被卡住时原样再提交：返回发布已结束的拒绝，旧的出站记录不再是等待批准', async () => {
    const { fix } = await acceptedWithLaunch();
    const { approvalId } = await launchSubmitted(fix);
    const old = fix.ctx.store.table('outbox').list()[0]!;
    expect(old.status).toBe('pending_approval');
    const release = holdCancel(fix);
    const deciding = fix.hub.api.decideApproval(approvalId, false);
    await vi.waitFor(() => expect(theJob(fix).launch).toMatchObject({ state: 'declined' }));
    // 原因所在：审批已经被拒绝，出站记录却还停在「等待批准」，要等下一轮定时执行才改。
    expect(fix.ctx.store.table('approvals').get(approvalId)!.status).toBe('rejected');
    expect(fix.ctx.store.table('outbox').get(old.id)!.status).toBe('pending_approval');
    const before = snapshot(fix);
    const again = await callTool(fix, bot(fix, fix.engineer.id), 'hub_outbox_submit', launchArgs(fix));
    expect(again).toEqual({ ok: false, error: LAUNCH_ENDED_REFUSAL_TEXT });
    expect(fix.ctx.store.table('outbox').get(old.id)!.status).not.toBe('pending_approval');
    expect(fix.ctx.store.table('outbox').get(old.id)!.status).toBe('rejected');
    expect(snapshot(fix)).toEqual(before);
    release();
    await deciding;
  });

  it('反例：与发布无关的普通审批被拒之后原样再提交，当作一次新的提交（新记录、新审批）', async () => {
    const { fix } = await acceptedWithLaunch();
    // 发布环节里的另一类命令：提交一条普通的 HTTP POST 出站，不是发布；先取消「发布」的语境：直接用没有挂事的员工（评审甲）提交。
    await nextPacket(fix, fix.engineer.id);
    const args = { kind: 'http_post', why: '提交一份与发布无关的数据', payload: { url: 'https://example.com/api', body: 'x=1' } };
    const first = await callTool(fix, bot(fix, fix.reviewer.id), 'hub_outbox_submit', args);
    expect(first, JSON.stringify(first)).toMatchObject({ ok: true });
    const approval = fix.ctx.store.table('approvals').list(row => row.botId === fix.reviewer.id)[0]!;
    expect(await fix.hub.api.decideApproval(approval.id, false)).toMatchObject({ ok: true });
    const old = fix.ctx.store.table('outbox').list(row => row.botId === fix.reviewer.id)[0]!;
    expect(fix.ctx.store.table('outbox').get(old.id)!.status).toBe('pending_approval');
    const again = await callTool(fix, bot(fix, fix.reviewer.id), 'hub_outbox_submit', args);
    expect(again, JSON.stringify(again)).toMatchObject({ ok: true });
    const rows = fix.ctx.store.table('outbox').list(row => row.botId === fix.reviewer.id);
    expect(rows).toHaveLength(2);
    expect(fix.ctx.store.table('outbox').get(old.id)!.status).toBe('rejected');
    expect(rows.filter(row => row.status === 'pending_approval')).toHaveLength(1);
    expect(fix.ctx.store.table('approvals').list(row => row.botId === fix.reviewer.id && row.status === 'pending')).toHaveLength(1);
  });
});

/**
 * P74r19 第 1 节的测试：发布这一步同一时间只有一条命令在等批准。
 *
 * 走真实路径（假命令执行接口、假时钟）：验收、执行者拿到发布准备回合、用 hub_outbox_submit 提交命令、主人在界面入口批准或拒绝。
 * 覆盖：
 * 1 第三次验证的情形：同一个回合先交只建目录的命令，再不带 replace 交完整命令：第二次被拒（文字逐字），
 *   「待你处理」里只有一条、没有新消息、越界次数不变；
 * 2 带 replace: true：发布审批换成新的一条，旧的四处（审批单、出站记录、待你处理条目、总管私聊的卡）都是已作废；
 *   总管私聊没有多出「下一步是对外发布，需要你批准」；工具返回的话逐字；批准新的一条运行的是完整命令、旧命令没运行；
 * 3 主人对已作废的旧审批点批准、点暂不发布：都不生效；
 * 4 反例：准备中第一次提交（带不带 replace 一样）；发布没有成功之后改正重提不需要 replace；别的员工不受影响；
 *   执行中途（还没验收）的审批照旧是普通审批；已批准之后再提交照旧是普通审批；
 * 5 唤醒包新增的两行逐字；
 * 6 replace 的参数说明逐字。
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { OutboxInputSchema, executeReadyOutbox } from '../src/gate/outbox.js';
import type { FakeExec } from '../src/io/testing/fake-exec.js';
import { LAUNCH_ONE_AT_A_TIME_REFUSAL, LAUNCH_REPLACED_TOOL_TEXT, REPLACE_PARAM_DESCRIPTION } from '../src/job/launch-replace.js';
import { launchSucceededText } from '../src/job/launch-result.js';
import { LAUNCH_BLOCKER_WORDING_LINE, LAUNCH_NOTES_TRUTH_LINE, LAUNCH_ONE_COMMAND_LINE } from '../src/wake/job-section-launch.js';
import { FIXTURE_LAUNCH_HOW, commitAndEnd, eventsOf } from './p74c-fixtures.js';
import { started } from './p74d-fixtures.js';
import { bot, callTool, nextPacket, sectionOf, theJob, threadOf } from './p74f-fixtures.js';
import type { JobFix } from './p74f-fixtures.js';
import { acceptedWithLaunch, launchArgs, submitLaunch } from './p74g-launch-fixtures.js';
import { approveWithoutRun } from './p74r18b-fixtures.js';

const SITE = '/tmp/p74r19-site';
const OK = { code: 0, stdout: '', stderr: '', timedOut: false };
const DENIED = { code: 1, stdout: '', stderr: 'mkdir: /tmp/p74r19-site: Operation not permitted', timedOut: false };
/** 第三次验证里第一条：只建目录。 */
const MKDIR_ONLY = (fix: JobFix) => ({ cmd: 'mkdir', args: ['-p', SITE], cwd: bot(fix, fix.engineer.id).homeDir });
/** 完整命令：建目录并复制文件（一条命令）。 */
const FULL_ARGS = ['-c', `mkdir -p ${SITE} && cp work/index.html ${SITE}/index.html`];
const FULL = (fix: JobFix) => ({ cmd: 'bash', args: FULL_ARGS, cwd: bot(fix, fix.engineer.id).homeDir });
const FULL_AGAIN = (fix: JobFix) => ({ cmd: 'bash', args: ['-c', `mkdir -p ${SITE} && cp work/page.html ${SITE}/index.html`], cwd: bot(fix, fix.engineer.id).homeDir });

const submit = (fix: JobFix, payload: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  callTool(fix, bot(fix, fix.engineer.id), 'hub_outbox_submit', launchArgs(fix, { payload, ...extra }));
const approvals = (fix: JobFix) => fix.ctx.store.table('approvals').list();
/** 「待你处理」里还开着的审批条目。 */
const openApprovalItems = (fix: JobFix) => fix.hub.api.inbox().items.filter(row => row.type === 'approval');
const chiefTexts = (fix: JobFix) => threadOf(fix.ctx, fix.chief.id).map(row => row.text);
const NEED_APPROVAL_LINE = '会员定价页已验收，下一步是对外发布，需要你批准；批准前不会发布。';
const cardOf = (fix: JobFix, approvalId: string) => fix.hub.api.thread(fix.chief.id).messages.find(row => row.card?.approvalId === approvalId)?.card;
const snapshot = (fix: JobFix) => ({ approvals: approvals(fix).length, outbox: fix.ctx.store.table('outbox').list().length,
  chief: threadOf(fix.ctx, fix.chief.id).length, topic: threadOf(fix.ctx, theJob(fix).topicId).length,
  violations: bot(fix, fix.engineer.id).violations, launch: theJob(fix).launch, items: openApprovalItems(fix).length,
  events: eventsOf(fix.ctx, theJob(fix).id).length });

/** 验收之后、执行者在发布准备回合里先提交了只建目录的命令（成为发布审批）。 */
async function afterFirst() {
  const { fix, job } = await acceptedWithLaunch();
  await nextPacket(fix, fix.engineer.id);
  const first = await submit(fix, MKDIR_ONLY(fix), { why: '先建目录' });
  expect(first, JSON.stringify(first)).toMatchObject({ ok: true });
  const firstApproval = approvals(fix)[0]!;
  expect(theJob(fix).launch).toEqual({ state: 'approval', approvalId: firstApproval.id, link: null });
  return { fix, job, firstApproval };
}

describe('1 没有带 replace 再提交：被拒', () => {
  it('第二次被拒、文字逐字；待你处理里与这件事有关的审批只有一条；没有新消息、越界不变、没有新记录', async () => {
    const { fix, firstApproval } = await afterFirst();
    const before = snapshot(fix);
    expect(openApprovalItems(fix)).toHaveLength(1);
    const second = await submit(fix, FULL(fix), { why: '完整命令，建目录并复制' });
    expect(second).toEqual({ ok: false, error: '这件事已有一条发布命令在等主人批准，同一时间只能有一条。要用新的命令取代它，重新提交并把 replace 设为 true；发布之外的动作等发布结束之后再提交。' });
    expect(LAUNCH_ONE_AT_A_TIME_REFUSAL).toBe((second as { error: string }).error);
    expect(snapshot(fix)).toEqual(before);
    expect(openApprovalItems(fix)).toHaveLength(1);
    expect(approvals(fix)[0]).toMatchObject({ id: firstApproval.id, status: 'pending' });
  });

  it('replace 写 false 与不写一样被拒；replace 对不是命令的动作（写文件）不起作用，同样被拒', async () => {
    const { fix } = await afterFirst();
    const before = snapshot(fix);
    expect(await submit(fix, FULL(fix), { replace: false })).toMatchObject({ ok: false, error: LAUNCH_ONE_AT_A_TIME_REFUSAL });
    const write = await callTool(fix, bot(fix, fix.engineer.id), 'hub_outbox_submit', { kind: 'write_file', why: '写到发布位置', replace: true,
      payload: { path: '/Users/someone/Desktop/p74r19/index.html', content: 'x' } });
    expect(write).toMatchObject({ ok: false });
    expect(snapshot(fix)).toEqual(before);
  });

  it('同一条命令原样再提交：仍返回原来那条（去重在前），不被拒、不新建', async () => {
    const { fix } = await afterFirst();
    const before = snapshot(fix);
    expect(await submit(fix, MKDIR_ONLY(fix), { why: '先建目录' })).toMatchObject({ ok: true, text: expect.stringContaining('等待主人批准') });
    expect(snapshot(fix)).toEqual(before);
  });
});

describe('2 带 replace: true：新的一条取代原来那条', () => {
  it('发布审批换成新的一条；旧的四处都是已作废；总管私聊没有多出说明；工具返回的话逐字；不叫醒任何人', async () => {
    const { fix, job, firstApproval } = await afterFirst();
    const firstOutbox = fix.ctx.store.table('outbox').list(row => row.approvalId === firstApproval.id)[0]!;
    const queued = fix.ctx.store.table('queue').list().length;
    const needLines = chiefTexts(fix).filter(text => text === NEED_APPROVAL_LINE).length;
    expect(needLines).toBe(1);
    const second = await submit(fix, FULL(fix), { why: '完整命令，建目录并复制', replace: true });
    expect(second, JSON.stringify(second)).toMatchObject({ ok: true });
    expect((second as { text: string }).text).toMatch(/^出站动作 o_[0-9a-z]{10} 已记录：等待主人批准。前一条发布命令已作废，主人只会看到这一条。$/);
    expect(LAUNCH_REPLACED_TOOL_TEXT).toBe('前一条发布命令已作废，主人只会看到这一条。');
    const secondApproval = approvals(fix).find(row => row.id !== firstApproval.id)!;
    // 发布审批换成新的一条，与第一条被记为发布审批时同一路径：发布状态、事件、审批卡第一行。
    expect(theJob(fix).launch).toEqual({ state: 'approval', approvalId: secondApproval.id, link: null });
    expect(eventsOf(fix.ctx, job.id).filter(row => row.kind === 'launch_requested').map(row => row.data))
      .toEqual([{ step: 'prepare' }, { approvalId: firstApproval.id }, { approvalId: secondApproval.id }]);
    expect(secondApproval).toMatchObject({ status: 'pending', actionText: `按约定对外发布：${FIXTURE_LAUNCH_HOW}` });
    // 旧的：审批单、出站记录、待你处理条目、总管私聊里的卡，状态一致地已作废。
    expect(fix.ctx.store.table('approvals').get(firstApproval.id)).toMatchObject({ status: 'expired', voided: true });
    expect(fix.ctx.store.table('outbox').get(firstOutbox.id)).toMatchObject({ status: 'rejected', result: '执行者提交了新的发布命令' });
    const oldInbox = fix.ctx.store.table('inbox').list(row => row.refId === firstApproval.id)[0]!;
    expect(oldInbox).toMatchObject({ status: 'withdrawn', answer: '执行者提交了新的发布命令' });
    expect(cardOf(fix, firstApproval.id)).toMatchObject({ status: 'withdrawn' });
    // 主人面前只有新的一条：待你处理里一条（是发布审批），总管私聊里的新卡带发布标记。
    const items = openApprovalItems(fix);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ approvalId: secondApproval.id });
    expect(items[0]!.approval).toMatchObject({ launch: true, actionText: `按约定对外发布：${FIXTURE_LAUNCH_HOW}` });
    expect(cardOf(fix, secondApproval.id)).toMatchObject({ status: 'open' });
    expect(cardOf(fix, secondApproval.id)?.approval?.launch).toBe(true);
    // 总管私聊没有重复落那一句；没有叫醒任何人。
    expect(chiefTexts(fix).filter(text => text === NEED_APPROVAL_LINE)).toHaveLength(needLines);
    expect(fix.ctx.store.table('queue').list().length).toBe(queued);
  });

  it('主人批准新的一条：运行的是完整命令，旧命令没有运行；成功的那一句照 P74r18b', async () => {
    const { fix, job, firstApproval } = await afterFirst();
    await submit(fix, FULL(fix), { why: '完整命令', replace: true });
    const secondApproval = approvals(fix).find(row => row.id !== firstApproval.id)!;
    const exec = fix.ctx.exec as FakeExec;
    exec.set('bash', FULL_ARGS, OK);
    expect(await fix.hub.api.decideApproval(secondApproval.id, true)).toMatchObject({ ok: true });
    await executeReadyOutbox(fix.ctx);
    // 只运行了完整命令；建目录那条没有运行（也没有预设它的结果，真运行会抛错）。
    expect(exec.calls.map(call => [call.cmd, call.args])).toEqual([['bash', FULL_ARGS]]);
    expect(theJob(fix).launch).toEqual({ state: 'done', approvalId: secondApproval.id, link: null });
    const says = threadOf(fix.ctx, fix.chief.id).filter(row => row.from === fix.chief.id && row.kind === 'reply').map(row => row.text);
    expect(says.filter(text => text === launchSucceededText('会员定价页', FIXTURE_LAUNCH_HOW))).toHaveLength(1);
    expect(fix.ctx.store.table('approvals').get(firstApproval.id)).toMatchObject({ status: 'expired', voided: true });
    expect(job.id).toBe(theJob(fix).id);
  });

  it('取代两次：只剩最后一条在等，前两条都已作废', async () => {
    const { fix, firstApproval } = await afterFirst();
    await submit(fix, FULL(fix), { why: '完整命令', replace: true });
    const mid = approvals(fix).find(row => row.id !== firstApproval.id)!;
    const third = await submit(fix, FULL_AGAIN(fix), { why: '换成复制 page.html', replace: true });
    expect(third, JSON.stringify(third)).toMatchObject({ ok: true, text: expect.stringContaining(LAUNCH_REPLACED_TOOL_TEXT) });
    const last = approvals(fix).find(row => row.id !== firstApproval.id && row.id !== mid.id)!;
    expect(theJob(fix).launch.approvalId).toBe(last.id);
    expect([firstApproval.id, mid.id].map(id => fix.ctx.store.table('approvals').get(id)?.voided)).toEqual([true, true]);
    expect(openApprovalItems(fix)).toHaveLength(1);
  });
});

describe('3 主人对已作废的旧审批做决定：不生效', () => {
  it('点批准、点暂不发布、在待你处理里答复旧条目：都不生效，旧命令没运行，发布状态不变', async () => {
    const { fix, firstApproval } = await afterFirst();
    await submit(fix, FULL(fix), { why: '完整命令', replace: true });
    const secondApproval = approvals(fix).find(row => row.id !== firstApproval.id)!;
    const exec = fix.ctx.exec as FakeExec;
    exec.set('mkdir', ['-p', SITE], OK);
    const launchBefore = theJob(fix).launch;
    expect(await fix.hub.api.decideApproval(firstApproval.id, true)).toMatchObject({ ok: false, error: '审批单已经处理，不能重复决定' });
    expect(await fix.hub.api.decideApproval(firstApproval.id, false)).toMatchObject({ ok: false, error: '审批单已经处理，不能重复决定' });
    const oldInbox = fix.ctx.store.table('inbox').list(row => row.refId === firstApproval.id)[0]!;
    expect((await fix.hub.api.answerInbox(oldInbox.id, '批准')).ok).toBe(false);
    await executeReadyOutbox(fix.ctx);
    expect(exec.calls).toHaveLength(0);
    expect(theJob(fix).launch).toEqual(launchBefore);
    expect(fix.ctx.store.table('approvals').get(secondApproval.id)).toMatchObject({ status: 'pending' });
    expect(fix.ctx.store.table('approvals').get(firstApproval.id)).toMatchObject({ status: 'expired', voided: true });
  });
});

describe('4 反例', () => {
  it('发布准备中第一次提交照旧成为发布审批：带不带 replace 结果相同，工具返回的话不带取代那一句', async () => {
    const plain = await acceptedWithLaunch();
    await nextPacket(plain.fix, plain.fix.engineer.id);
    const a = await submit(plain.fix, FULL(plain.fix));
    const withReplace = await acceptedWithLaunch();
    await nextPacket(withReplace.fix, withReplace.fix.engineer.id);
    const b = await submit(withReplace.fix, FULL(withReplace.fix), { replace: true });
    for (const [fix, result] of [[plain.fix, a], [withReplace.fix, b]] as const) {
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
      expect((result as { text: string }).text).not.toContain('前一条发布命令已作废');
      const only = approvals(fix)[0]!;
      expect(approvals(fix)).toHaveLength(1);
      expect(theJob(fix).launch).toEqual({ state: 'approval', approvalId: only.id, link: null });
      expect(chiefTexts(fix).filter(text => text === NEED_APPROVAL_LINE)).toHaveLength(1);
    }
  });

  it('发布没有成功之后改正重提：不需要 replace，照 P74r18b', async () => {
    const { fix, job } = await acceptedWithLaunch();
    const { approval } = await submitLaunch(fix);
    fix.ctx.exec.set('node', ['work/go-live.js'], DENIED);
    expect(await fix.hub.api.decideApproval(approval.id, true)).toMatchObject({ ok: true });
    await executeReadyOutbox(fix.ctx);
    expect(theJob(fix).launch.state).toBe('failed');
    await nextPacket(fix, fix.engineer.id);
    const again = await submit(fix, { cmd: 'node', args: ['work/go-live-2.js'], cwd: bot(fix, fix.engineer.id).homeDir }, { why: '改正后重新发布' });
    expect(again, JSON.stringify(again)).toMatchObject({ ok: true });
    const second = approvals(fix).find(row => row.id !== approval.id)!;
    expect(theJob(fix).launch).toEqual({ state: 'approval', approvalId: second.id, link: null });
    expect((again as { text: string }).text).not.toContain('前一条发布命令已作废');
    expect(job.id).toBe(theJob(fix).id);
  });

  it('已批准、命令在运行（发布状态仍是等批准）之后再提交：不适用取代，照旧是普通审批（没有 replace 也不被拒）', async () => {
    const { fix, firstApproval } = await afterFirst();
    await approveWithoutRun(fix, firstApproval.id);
    const second = await submit(fix, FULL(fix), { why: '另一条' });
    expect(second, JSON.stringify(second)).toMatchObject({ ok: true });
    expect((second as { text: string }).text).not.toContain('前一条发布命令已作废');
    const other = approvals(fix).find(row => row.id !== firstApproval.id)!;
    expect(theJob(fix).launch.approvalId).toBe(firstApproval.id);
    expect(other).toMatchObject({ status: 'pending' });
    expect(fix.ctx.store.table('approvals').get(firstApproval.id)).toMatchObject({ status: 'approved' });
  });

  it('已发布之后再提交：照现有规则被「发布已结束」拒绝，不适用取代（这里只固定现有行为）', async () => {
    const { fix } = await acceptedWithLaunch();
    const { approval } = await submitLaunch(fix);
    fix.ctx.exec.set('node', ['work/go-live.js'], OK);
    expect(await fix.hub.api.decideApproval(approval.id, true)).toMatchObject({ ok: true });
    await executeReadyOutbox(fix.ctx);
    expect(theJob(fix).launch).toEqual({ state: 'done', approvalId: approval.id, link: null });
    await nextPacket(fix, fix.engineer.id);
    // 已发布（命令成功、还没记网址）：发布状态已不是「等批准」，现有的把关（job/launch-cancel.ts 的 launchEndedRefusal）拒绝再提交，
    // 带不带 replace 都一样；记下网址之后同样。取代不适用，也没有任何改动。
    const refused = { ok: false, error: '这件事的对外发布已经结束（或约定里没有对外发布），不再提交发布。' };
    expect(await submit(fix, FULL(fix), { why: '再来一条' })).toEqual(refused);
    expect(await submit(fix, FULL(fix), { why: '再来一条', replace: true })).toEqual(refused);
    expect(theJob(fix).launch).toEqual({ state: 'done', approvalId: approval.id, link: null });
    expect(await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', { mode: 'launched', jobId: theJob(fix).id, link: 'https://example.com/x' })).toMatchObject({ ok: true });
    expect(await submit(fix, FULL_AGAIN(fix), { why: '又一条', replace: true })).toEqual(refused);
    expect(approvals(fix)).toHaveLength(1);
  });

  it('别的员工提交不受影响（不是这件事的执行者）', async () => {
    const { fix } = await afterFirst();
    const reviewer = bot(fix, fix.reviewer.id);
    await nextPacket(fix, reviewer.id).catch(() => undefined);
    const result = await callTool(fix, reviewer, 'hub_outbox_submit', { kind: 'run_command', why: '核对人自己的命令',
      payload: { cmd: 'node', args: ['work/check.js'], cwd: reviewer.homeDir } });
    expect(result, JSON.stringify(result)).not.toMatchObject({ error: LAUNCH_ONE_AT_A_TIME_REFUSAL });
  });

  it('执行中途（还没验收）的审批照旧是普通审批：连交两条都成功，没有 replace 也不被拒', async () => {
    const { fix, job } = await started();
    const home = bot(fix, fix.engineer.id).homeDir;
    const one = await callTool(fix, bot(fix, fix.engineer.id), 'hub_outbox_submit', launchArgs(fix, { payload: { cmd: 'node', args: ['work/a.js'], cwd: home } }));
    const two = await callTool(fix, bot(fix, fix.engineer.id), 'hub_outbox_submit', launchArgs(fix, { payload: { cmd: 'node', args: ['work/b.js'], cwd: home } }));
    expect(one, JSON.stringify(one)).toMatchObject({ ok: true });
    expect(two, JSON.stringify(two)).toMatchObject({ ok: true });
    expect(approvals(fix)).toHaveLength(2);
    expect(approvals(fix).every(row => row.status === 'pending')).toBe(true);
    expect(theJob(fix).launch.state).toBe('none');
    expect(job.id).toBe(theJob(fix).id);
  });
});

describe('5 唤醒包与参数说明', () => {
  it('发布准备正文多两行，逐字', async () => {
    const { fix } = await acceptedWithLaunch();
    const text = sectionOf(await nextPacket(fix, fix.engineer.id));
    expect(text).toContain('发布用一条命令做完全部动作：要先建目录再复制时，写成一条命令（例如用 bash -c 把几步用 && 连起来）。同一时间只有一条发布命令在等主人批准。');
    expect(text).toContain('审批卡上的三行只写这一条命令实际做的事，不写它没有做的事。');
    expect(LAUNCH_ONE_COMMAND_LINE).toBe('发布用一条命令做完全部动作：要先建目录再复制时，写成一条命令（例如用 bash -c 把几步用 && 连起来）。同一时间只有一条发布命令在等主人批准。');
    expect(LAUNCH_NOTES_TRUTH_LINE).toBe('审批卡上的三行只写这一条命令实际做的事，不写它没有做的事。');
    expect(LAUNCH_BLOCKER_WORDING_LINE).toBe('交账写 blocked 时，blocker 用主人看得懂的一句话写清缺什么，不写内部的说法。');
  });

  it('replace 的参数说明逐字，出现在工具的参数规格里', () => {
    expect(REPLACE_PARAM_DESCRIPTION).toBe('只在发布这一步用：这件事已有一条发布命令在等主人批准、你要用这一条取代它时设为 true。');
    const spec = JSON.stringify(z.toJSONSchema(OutboxInputSchema, { unrepresentable: 'any', io: 'input' }));
    expect(spec).toContain('只在发布这一步用：这件事已有一条发布命令在等主人批准、你要用这一条取代它时设为 true。');
  });

  it('一个回合里的执行者只用唤醒包文字：先交一条命令、再带 replace 取代它，两次都成功', async () => {
    const { fix } = await acceptedWithLaunch();
    const packet = await nextPacket(fix, fix.engineer.id);
    expect(sectionOf(packet)).toContain('同一时间只有一条发布命令在等主人批准');
    expect(await submit(fix, MKDIR_ONLY(fix))).toMatchObject({ ok: true });
    expect(await submit(fix, FULL(fix), { replace: true })).toMatchObject({ ok: true });
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '已提交发布审批，等主人批准' });
    expect(openApprovalItems(fix)).toHaveLength(1);
  });
});

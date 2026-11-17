/**
 * P74r18b 第 2、4.4 节的测试：发布命令的结果回到这件事上。
 *
 * 走真实路径：验收、执行者提交发布审批、主人批准（界面入口 api.decideApproval，批准之后立刻执行），
 * 用假的命令执行接口控制成功或失败。覆盖：
 * 1 成功：发布状态已发布；主题与总管私聊各一句（逐字）；执行者被叫醒一次、原因逐字；进度行（含「中心运行发布命令」）；
 *   之后带网址回报一次被接受、网址记上、不再多落一句；不带网址直接交账也可以；
 * 2 失败（写入被拒）：发布状态 failed；两处各一句（逐字，不含命令、退出码、绝对路径）；执行者私聊没有新增消息；
 *   执行者被叫醒一次、原因逐字；进度行两处逐字；出站记录里仍有命令全文和错误输出；其他两种失败原因的文字；
 * 3 失败之后执行者改正命令重新提交：回到等待批准，批准后成功；
 * 4 失败之后执行者交账 blocked：走现有的发布受阻流程；
 * 5 失败后重提的回合计入发布这一步的回合上限；
 * 6 不是发布审批的普通出站动作：不改发布状态，不落这些话；
 * 7 4.4 唤醒包正文：各状态逐字，没有任何一种同时出现「执行发布」和「不要再次调用」。
 */
import { describe, expect, it, vi } from 'vitest';
import { jobProgressForTopic } from '../src/api/job-topic-views.js';
import { executeReadyOutbox } from '../src/gate/outbox.js';
import { memberProjectDirs } from '../src/gate/gate-context.js';
import type { FakeExec } from '../src/io/testing/fake-exec.js';
import { HOST_SANDBOX_UNAVAILABLE } from '../src/io/interfaces.js';
import { launchBlockedText } from '../src/job/launch-blocked.js';
import { launchCapText } from '../src/job/launch-approval.js';
import { LAUNCH_OK_WAKE_TEXT, launchFailedText, launchFailedWakeText, launchSucceededText } from '../src/job/launch-result.js';
import type { QueueEntry } from '../src/model/index.js';
import { buildJobBodyDetailed } from '../src/wake/job-section.js';
import { commitAndEnd, entriesOf, eventsOf, wakesOf } from './p74c-fixtures.js';
import { started } from './p74d-fixtures.js';
import { bot, callTool, nextPacket, sectionOf, theJob, threadOf, tick, MINUTE, type JobFix } from './p74f-fixtures.js';
import { acceptedWithLaunch, jobIdIn, launchArgs, submitLaunch } from './p74g-launch-fixtures.js';
import { approveWithoutRun } from './p74r18b-fixtures.js';

const OK = { code: 0, stdout: '已上线', stderr: '', timedOut: false };
const DENIED_ERR = 'mkdir: /tmp/p74l2-site: Operation not permitted';
const DENIED = { code: 1, stdout: '', stderr: DENIED_ERR, timedOut: false };
/** 夹具约定里的发布方式（逐字出现在成功那句里；末尾的括号不是句号，所以句号是中心加的）。 */
const HOW = '发布到 /tmp/p74k-site（复制到本机目录）';
const OK_TEXT = `「会员定价页」已发布：${HOW}。`;
const DENIED_TEXT = '「会员定价页」没有发布成功：要发布到的位置写不进去。'; // P74r20 同步（第 1 节第 2 条）：去掉「中心」两个字
const FAILED_WAKE = `发布命令运行失败：${DENIED_ERR}。是命令本身写错了，就改正后重新提交一次发布审批；是发布的位置中心写不进去，或别的你解决不了的原因，就交账写 blocked，说明原因。不要自己更换约定里写的发布位置。`;
const OK_WAKE = '发布命令已成功运行，这件事已记为已发布。发布之后有可以访问的网址时，调用 hub_job_work，mode 写 launched，link 写网址；没有网址就直接交账收尾。';

/** 总管私聊、主题里以总管名义落的话。 */
const chiefSays = (fix: JobFix) => threadOf(fix.ctx, fix.chief.id).filter(row => row.from === fix.chief.id && row.kind === 'reply').map(row => row.text);
const topicSays = (fix: JobFix, topicId: string) => threadOf(fix.ctx, topicId).filter(row => row.from === fix.chief.id && row.kind === 'reply').map(row => row.text);
/** 执行者私聊里中心落的系统文字。 */
const engineerSystem = (fix: JobFix) => threadOf(fix.ctx, fix.engineer.id).filter(row => row.from === 'hub' && row.kind === 'system').map(row => row.text);
/** 执行者在这件事上排着的、或已经开始的唤醒里，原因恰好是这句话的。 */
function wakesWith(fix: JobFix, jobId: string, summary: string) {
  return [...entriesOf(fix, fix.engineer.id, jobId), ...wakesOf(fix, fix.engineer.id, jobId)].filter(row => row.reason.summary === summary);
}
/** 让假的命令执行接口先卡住，直到调用 release；返回已开始运行的次数。 */
function holdExec(fix: JobFix): { release: () => void; started: () => number } {
  const exec = fix.ctx.exec as FakeExec;
  const original = exec.run.bind(exec);
  let release: () => void = () => undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let count = 0;
  exec.run = async (cmd, args, opts) => { count += 1; await gate; return original(cmd, args, opts); };
  return { release, started: () => count };
}
/** 批准（界面入口）并等中心运行完。 */
async function approveAndRun(fix: JobFix, approvalId: string, result: typeof OK | typeof DENIED, args = ['work/go-live.js']): Promise<void> {
  fix.ctx.exec.set('node', args, result);
  expect(await fix.hub.api.decideApproval(approvalId, true)).toMatchObject({ ok: true });
  await executeReadyOutbox(fix.ctx);
}
const progressOf = (fix: JobFix, topicId: string) => jobProgressForTopic(fix.ctx, topicId)!;

describe('1 成功', () => {
  it('发布状态已发布；两处各一句逐字；执行者被叫醒一次、原因逐字；批准时没有叫醒；进度行', async () => {
    const { fix, job } = await acceptedWithLaunch();
    const { approval } = await submitLaunch(fix);
    expect(progressOf(fix, job.topicId)).toMatchObject({ stateLabel: '已完成', waitingOn: '你' });
    fix.ctx.exec.set('node', ['work/go-live.js'], OK);
    const hold = holdExec(fix);
    expect(await fix.hub.api.decideApproval(approval.id, true)).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(hold.started()).toBe(1));
    // 批准了、命令还在跑：进度行「在等」写中心；批准的那一刻没有叫醒执行者。
    expect(progressOf(fix, job.topicId)).toMatchObject({ stateLabel: '已完成', waitingOn: '中心运行发布命令' });
    expect([...entriesOf(fix, fix.engineer.id, job.id), ...wakesOf(fix, fix.engineer.id, job.id)].filter(row => row.reason.kind === 'approval_decided')).toHaveLength(0);
    expect(theJob(fix).launch.state).toBe('approval');
    hold.release();
    await executeReadyOutbox(fix.ctx);
    // 发布状态：已发布（还没有网址）；记事件。
    expect(theJob(fix).launch).toEqual({ state: 'done', approvalId: approval.id, link: null });
    expect(eventsOf(fix.ctx, job.id).filter(row => row.kind === 'launched')).toMatchObject([{ actor: 'hub', data: { link: null, reason: 'command_ok' } }]);
    // 两处各一句，逐字。
    expect(OK_TEXT).toBe(launchSucceededText('会员定价页', HOW));
    expect(chiefSays(fix).filter(text => text === OK_TEXT)).toHaveLength(1);
    expect(topicSays(fix, job.topicId).filter(text => text === OK_TEXT)).toHaveLength(1);
    // 执行者私聊里没有那行带命令全文的系统文字。
    expect(engineerSystem(fix).filter(text => text.includes('已执行你批准的'))).toHaveLength(0);
    // 执行者被叫醒一次，原因逐字。
    expect(LAUNCH_OK_WAKE_TEXT).toBe(OK_WAKE);
    expect(wakesWith(fix, job.id, OK_WAKE)).toHaveLength(1);
    // 进度行：已完成，五步都完成，没有人在等。
    const progress = progressOf(fix, job.topicId);
    expect(progress).toMatchObject({ stateLabel: '已完成', waitingOn: null });
    expect(progress.steps.every(step => step.state === 'done')).toBe(true);
  });

  it('之后执行者带网址回报一次被接受：网址记上，不再多落一句；再报一次被拒', async () => {
    const { fix, job } = await acceptedWithLaunch();
    const { approval } = await submitLaunch(fix);
    await approveAndRun(fix, approval.id, OK);
    const packet = await nextPacket(fix, fix.engineer.id);
    const before = { chief: chiefSays(fix), topic: topicSays(fix, job.topicId) };
    const result = await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', { mode: 'launched', jobId: jobIdIn(packet), link: 'https://example.com/signup' });
    expect(result, JSON.stringify(result)).toEqual({ ok: true, text: '已记下发布地址。' });
    expect(theJob(fix).launch).toEqual({ state: 'done', approvalId: approval.id, link: 'https://example.com/signup' });
    expect({ chief: chiefSays(fix), topic: topicSays(fix, job.topicId) }).toEqual(before);
    expect(await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', { mode: 'launched', jobId: job.id, link: 'https://example.com/again' }))
      .toEqual({ ok: false, error: '这件事现在不在等发布结果' });
    expect(theJob(fix).launch.link).toBe('https://example.com/signup');
  });

  it('没有网址：执行者直接交账收尾也可以，之后没有人再被叫醒', async () => {
    const { fix, job } = await acceptedWithLaunch();
    const { approval } = await submitLaunch(fix);
    await approveAndRun(fix, approval.id, OK);
    await nextPacket(fix, fix.engineer.id);
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'done', summary: '已发布，没有网址' });
    expect(theJob(fix).launch).toEqual({ state: 'done', approvalId: approval.id, link: null });
    const wakes = wakesOf(fix, fix.engineer.id, job.id).length;
    for (let i = 0; i < 4; i += 1) await tick(fix, 10 * MINUTE);
    expect(wakesOf(fix, fix.engineer.id, job.id)).toHaveLength(wakes);
    expect(entriesOf(fix, fix.engineer.id, job.id)).toHaveLength(0);
  });

  it('反例：网址不合格（不是 http、https）仍被拒，记录不变', async () => {
    const { fix, job } = await acceptedWithLaunch();
    const { approval } = await submitLaunch(fix);
    await approveAndRun(fix, approval.id, OK);
    await nextPacket(fix, fix.engineer.id);
    const result = await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', { mode: 'launched', jobId: job.id, link: 'ftp://example.com/x' });
    expect(result.ok).toBe(false);
    expect(theJob(fix).launch.link).toBeNull();
  });
});

describe('2 失败（写入被拒）', () => {
  it('发布状态 failed；两处各一句逐字，不含命令、退出码、绝对路径；执行者私聊没有新增；被叫醒一次原因逐字；进度行；出站记录里仍有命令与错误输出', async () => {
    const { fix, job } = await acceptedWithLaunch();
    const { approval } = await submitLaunch(fix);
    const engineerBefore = engineerSystem(fix).length;
    await approveAndRun(fix, approval.id, DENIED);
    expect(theJob(fix).launch).toEqual({ state: 'failed', approvalId: approval.id, link: null });
    expect(eventsOf(fix.ctx, job.id).filter(row => row.kind === 'launch_failed')).toMatchObject([{ actor: 'hub', data: { reason: 'command_failed' } }]);
    expect(eventsOf(fix.ctx, job.id).filter(row => row.kind === 'launch_declined')).toHaveLength(0);
    // 两处各一句，逐字；全文不含命令、退出码、绝对路径、错误输出。
    expect(launchFailedText('会员定价页', { ownerFailureReason: '命令退出码 1', result: `命令退出码 1：${DENIED_ERR}` })).toBe(DENIED_TEXT);
    expect(chiefSays(fix).filter(text => text === DENIED_TEXT)).toHaveLength(1);
    expect(topicSays(fix, job.topicId).filter(text => text === DENIED_TEXT)).toHaveLength(1);
    for (const text of [DENIED_TEXT]) {
      expect(text).not.toMatch(/node|go-live|退出码|Operation|\/[A-Za-z]/);
    }
    const visible = [...threadOf(fix.ctx, fix.chief.id), ...threadOf(fix.ctx, job.topicId)].filter(row => row.text.includes('没有发布成功'));
    expect(visible.every(row => !/node|go-live|退出码|Operation not permitted|\/tmp\/p74l2/.test(row.text))).toBe(true);
    // 执行者私聊没有新增那行系统文字。
    expect(engineerSystem(fix)).toHaveLength(engineerBefore);
    // 执行者被叫醒一次，原因逐字。
    expect(launchFailedWakeText(DENIED_ERR)).toBe(FAILED_WAKE);
    expect(wakesWith(fix, job.id, FAILED_WAKE)).toHaveLength(1);
    // 进度行：现在写「已完成（发布没有成功）」，发布一步不标为完成；他有唤醒在排队或在跑，在等他。
    const waiting = progressOf(fix, job.topicId);
    expect(waiting).toMatchObject({ stateLabel: '已完成（发布没有成功）', waitingOn: '林舟' });
    expect(waiting.steps.find(step => step.label === '发布')!.state).toBe('todo');
    expect(waiting.steps.filter(step => step.label !== '发布').every(step => step.state === 'done')).toBe(true);
    // 出站记录里仍有命令全文和错误输出。
    const row = fix.ctx.store.table('outbox').list(item => item.approvalId === approval.id)[0]!;
    expect(row).toMatchObject({ status: 'failed', payload: { cmd: 'node', args: ['work/go-live.js'] }, ownerFailureReason: '命令退出码 1' });
    expect(row.result).toContain('Operation not permitted');
    // 他拿到回合、交账结束之后没有别的唤醒了：「在等」写你。
    await nextPacket(fix, fix.engineer.id);
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '还没想好怎么办' });
    expect(progressOf(fix, job.topicId)).toMatchObject({ stateLabel: '已完成（发布没有成功）', waitingOn: '你' });
  });

  it('错误输出里有 Permission denied 同样算写入被拒；沙箱不可用、超时沿用固定说明；其他写「发布命令运行出错」并带上原因；错误只取前 200 字', () => {
    expect(launchFailedText('会员定价页', { ownerFailureReason: '命令退出码 1', result: '命令退出码 1：cp: x: Permission denied' })).toBe(DENIED_TEXT);
    // 沙箱不可用的报错里也可能夹着 Operation not permitted：先按固定说明。
    expect(launchFailedText('会员定价页', { ownerFailureReason: HOST_SANDBOX_UNAVAILABLE, result: `沙箱不可用（sandbox_apply: Operation not permitted）` }))
      .toBe(`「会员定价页」没有发布成功：${HOST_SANDBOX_UNAVAILABLE}`);
    expect(launchFailedText('会员定价页', { ownerFailureReason: '命令超时', result: '命令超时：' })).toBe('「会员定价页」没有发布成功：命令超时');
    // P82：宿主原文（中心确认的失败原因）如实带给主人，不再只有「发布命令运行出错」。
    expect(launchFailedText('会员定价页', { ownerFailureReason: '命令退出码 2', result: '命令退出码 2：boom' }))
      .toBe('「会员定价页」没有发布成功：发布命令运行出错（命令退出码 2）。');
    // P85 同步：命令没有运行（executionStarted 为 false）时不再把异常原文带给主人，改为固定的几种原因（原来括号里是宿主原文）。
    expect(launchFailedText('会员定价页', { ownerFailureReason: '命令执行目录必须在家目录或共享目录内，宿主命令不运行', result: 'x', executionStarted: false }))
      .toBe('「会员定价页」没有发布成功：发布命令没有运行（命令的执行目录不在允许的范围内）。');
  });

  it('其他退出原因：两处各写「发布命令运行出错（命令退出码 2）。」', async () => {
    const { fix, job } = await acceptedWithLaunch();
    const { approval } = await submitLaunch(fix);
    await approveAndRun(fix, approval.id, { code: 2, stdout: '', stderr: 'boom\n第二行', timedOut: false });
    expect(theJob(fix).launch.state).toBe('failed');
    const ownerText = '「会员定价页」没有发布成功：发布命令运行出错（命令退出码 2）。';
    expect(chiefSays(fix).filter(text => text === ownerText)).toHaveLength(1);
    expect(topicSays(fix, job.topicId).filter(text => text === ownerText)).toHaveLength(1);
    // 唤醒原因里的错误：错误输出，换行去掉。
    expect(wakesWith(fix, job.id, launchFailedWakeText('boom 第二行'))).toHaveLength(1);
  });
});

describe('3 失败之后执行者改正命令重新提交', () => {
  it('新的发布审批建立，发布状态回到等待批准；主人批准后成功，走成功的那条路', async () => {
    const { fix, job } = await acceptedWithLaunch();
    const { approval } = await submitLaunch(fix);
    await approveAndRun(fix, approval.id, DENIED);
    await nextPacket(fix, fix.engineer.id);
    const home = bot(fix, fix.engineer.id).homeDir;
    const again = await callTool(fix, bot(fix, fix.engineer.id), 'hub_outbox_submit', launchArgs(fix, { why: '改正命令后重新发布', payload: { cmd: 'node', args: ['work/go-live-2.js'], cwd: home } }));
    expect(again, JSON.stringify(again)).toMatchObject({ ok: true });
    const second = fix.ctx.store.table('approvals').list().find(row => row.id !== approval.id)!;
    expect(second.status).toBe('pending');
    expect(theJob(fix).launch).toEqual({ state: 'approval', approvalId: second.id, link: null });
    expect(progressOf(fix, job.topicId)).toMatchObject({ stateLabel: '已完成', waitingOn: '你' });
    expect(eventsOf(fix.ctx, job.id).filter(row => row.kind === 'launch_requested').map(row => row.data)).toEqual([{ step: 'prepare' }, { approvalId: approval.id }, { approvalId: second.id }]);
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '已改正，等批准' });
    await approveAndRun(fix, second.id, OK, ['work/go-live-2.js']);
    expect(theJob(fix).launch).toEqual({ state: 'done', approvalId: second.id, link: null });
    expect(chiefSays(fix).filter(text => text === OK_TEXT)).toHaveLength(1);
    expect(chiefSays(fix).filter(text => text === DENIED_TEXT)).toHaveLength(1);
    expect(wakesWith(fix, job.id, OK_WAKE)).toHaveLength(1);
  });
});

describe('4 失败之后执行者交账 blocked', () => {
  it('走现有的发布受阻流程：暂不发布（中心结束），总管私聊落那句话，之后没有人被叫醒', async () => {
    const { fix, job } = await acceptedWithLaunch();
    const { approval } = await submitLaunch(fix);
    await approveAndRun(fix, approval.id, DENIED);
    await nextPacket(fix, fix.engineer.id);
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'blocked', blocker: '发布位置中心写不进去', summary: '写不进约定的位置' });
    expect(theJob(fix)).toMatchObject({ state: 'done', launch: { state: 'declined', endedBy: 'hub' } });
    // P74r20 同步（第 1 节第 1 条）：发布命令已运行失败之后交账 blocked，总管私聊落固定的一句，不引用执行者的原话。
    expect(chiefSays(fix).filter(text => text === '会员定价页没有发布：发布命令没有运行成功，林舟无法改正。要换一个发布位置或方式时告诉我，我再安排。')).toHaveLength(1);
    expect(progressOf(fix, job.topicId)).toMatchObject({ stateLabel: '已完成（没有发布）', waitingOn: null });
    const wakes = wakesOf(fix, fix.engineer.id, job.id).length;
    for (let i = 0; i < 4; i += 1) await tick(fix, 10 * MINUTE);
    expect(wakesOf(fix, fix.engineer.id, job.id)).toHaveLength(wakes);
    expect(entriesOf(fix, fix.engineer.id, job.id)).toHaveLength(0);
  });
});

describe('5 回合上限', () => {
  it('失败后重提的回合计入发布这一步的上限（4 个）：用满之后这一步以「运行失败，没有发布」结束', async () => {
    const { fix, job } = await acceptedWithLaunch();
    let { approval } = await submitLaunch(fix); // 第 1 个回合（发布准备），命令是 work/go-live.js
    let lastArgs = ['work/go-live.js'];
    const home = bot(fix, fix.engineer.id).homeDir;
    for (let n = 2; n <= 4; n += 1) {
      await approveAndRun(fix, approval.id, DENIED, lastArgs);
      expect(theJob(fix).launch.state, `第 ${n - 1} 次失败`).toBe('failed');
      await nextPacket(fix, fix.engineer.id); // 第 n 个回合（失败的结果唤醒）
      lastArgs = [`work/go-live-${n}.js`];
      expect(await callTool(fix, bot(fix, fix.engineer.id), 'hub_outbox_submit', launchArgs(fix, { why: `第 ${n} 次`, payload: { cmd: 'node', args: lastArgs, cwd: home } }))).toMatchObject({ ok: true });
      approval = fix.ctx.store.table('approvals').list().find(row => row.status === 'pending')!;
      await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: `第 ${n} 次重新提交` });
    }
    // 第 4 次提交也失败：结果唤醒是第 5 个回合，超过上限，被闸门丢弃，这一步按「运行失败」结束。
    await approveAndRun(fix, approval.id, DENIED, lastArgs);
    for (let i = 0; i < 3; i += 1) await tick(fix, 2 * MINUTE);
    expect(theJob(fix)).toMatchObject({ state: 'done', launch: { state: 'declined', endedBy: 'hub' } });
    expect(chiefSays(fix).filter(text => text === launchCapText('ran_failed', { title: '会员定价页', turns: 4, executor: '林舟' }))).toHaveLength(1);
    expect(job.id).toBe(theJob(fix).id);
  });
});

describe('6 不是发布审批的普通出站动作', () => {
  it('这件事执行中的普通审批：不改发布状态，主题和总管私聊没有发布结果的话；执行者被叫醒（带这件事），原因是普通出站动作的结果', async () => {
    const { fix, job } = await started();
    const { cost: _c, undo: _u, after: _a, ...plain } = launchArgs(fix);
    expect(await callTool(fix, bot(fix, fix.engineer.id), 'hub_outbox_submit', { ...plain, why: '跑一次整理脚本' })).toMatchObject({ ok: true });
    const approval = fix.ctx.store.table('approvals').list()[0]!;
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '等批准' });
    const chiefBefore = chiefSays(fix);
    await approveAndRun(fix, approval.id, OK);
    expect(theJob(fix)).toMatchObject({ state: 'doing', launch: { state: 'none', approvalId: null } });
    expect(chiefSays(fix)).toEqual(chiefBefore);
    expect(topicSays(fix, job.topicId).some(text => text.includes('已发布') || text.includes('没有发布成功'))).toBe(false);
    expect(wakesWith(fix, job.id, '你提交的动作已由中心运行成功：请中心代为运行一条命令。')).toHaveLength(1);
    // 普通出站动作的结果仍落在执行者私聊（不含命令全文）。
    expect(engineerSystem(fix).filter(text => text.startsWith('已执行你批准的：请中心代为运行一条命令 → 已完成'))).toHaveLength(1);
  });
});

describe('7 唤醒包「你手上的事」：发布各状态的正文', () => {
  async function bodyOf(fix: JobFix): Promise<string> {
    const ticket = wakesOf(fix, fix.engineer.id).at(-1)!;
    return (await buildJobBodyDetailed(fix.ctx, bot(fix, fix.engineer.id), { jobId: theJob(fix).id } as QueueEntry, ticket)).text;
  }
  const noContradiction = (text: string) => expect(text.includes('执行发布') && text.includes('不要再次调用')).toBe(false);

  it('发布准备（还没有提交审批）：多一行可写范围，逐字', async () => {
    const { fix } = await acceptedWithLaunch();
    const text = sectionOf(await nextPacket(fix, fix.engineer.id));
    expect(text).toContain('中心代为运行的发布命令只能写：你的文件夹、共享文件夹、项目文件夹、本机临时文件夹（含 /tmp）；可以联网。约定里的发布位置不在这个范围内时，不要提交审批，交账写 blocked，blocker 逐字写：发布位置不在能写入的范围内。'); // P74r19 同步：末尾改成逐字的 blocker（第 3 节第 1 条）
    expect(text).toContain('批准后：由中心运行这条命令，你不用再做任何事；结果出来中心会叫醒你。主人拒绝时也不用做任何事。');
    expect(text).not.toContain('执行发布');
    noContradiction(text);
  });

  it('等主人批准：保持现有写法，没有让员工自己执行的话', async () => {
    const { fix } = await acceptedWithLaunch();
    await submitLaunch(fix);
    const text = await bodyOf(fix);
    expect(text).toMatch(/」（jobId 为 job_[0-9a-z]{10}）的发布申请在等主人批准。批准前不要发布，也不用做别的。/);
    noContradiction(text);
  });

  it('已批准、中心正在运行：逐字；这一回合不用做任何事', async () => {
    const { fix } = await acceptedWithLaunch();
    const { approval } = await submitLaunch(fix);
    await approveWithoutRun(fix, approval.id);
    const text = await bodyOf(fix);
    expect(text).toContain('发布申请主人已批准，中心正在运行发布命令。这一回合不用做任何事，直接交账；结果出来中心会叫醒你。');
    expect(text).not.toContain('执行发布，然后调用');
    noContradiction(text);
  });

  it('发布没有成功：说明怎样处理，不要自己更换发布位置；命令成功、等补记网址：写明 launched 的用法', async () => {
    const failed = await acceptedWithLaunch();
    const { approval: first } = await submitLaunch(failed.fix);
    await approveAndRun(failed.fix, first.id, DENIED);
    const failedText = await bodyOf(failed.fix);
    expect(failedText).toContain('发布命令运行失败，这件事没有发布。');
    expect(failedText).toContain('不要自己更换约定里写的发布位置。');
    noContradiction(failedText);
    const ok = await acceptedWithLaunch();
    const { approval: second } = await submitLaunch(ok.fix);
    await approveAndRun(ok.fix, second.id, OK);
    const okText = await bodyOf(ok.fix);
    expect(okText).toMatch(/」（jobId 为 job_[0-9a-z]{10}）\n发布命令已成功运行，这件事已记为已发布。/);
    expect(okText).toContain('没有网址就直接交账收尾。');
    noContradiction(okText);
  });
});

describe('8 提交时预先核对（4.3）：发布命令要写可写范围之外的位置', () => {
  const REFUSAL = (path: string) => `这条命令要写 ${path}，中心代为运行时写不进去。中心代为运行的命令只能写：你的文件夹、共享文件夹、项目文件夹、本机临时文件夹（含 /tmp）；可以联网。这是约定里写明的发布位置时，不要更换位置，交账写 blocked，blocker 逐字写：发布位置不在能写入的范围内。`; // P74r19 同步：末尾改成逐字的 blocker（第 3 节第 1 条）
  const snapshot = (fix: JobFix) => ({ approvals: fix.ctx.store.table('approvals').list().length, outbox: fix.ctx.store.table('outbox').list().length,
    chief: threadOf(fix.ctx, fix.chief.id).length, violations: bot(fix, fix.engineer.id).violations, launch: theJob(fix).launch });

  it('要写主人桌面上的文件夹：被拒、文字逐字，没有新的审批和消息，越界不变；随后执行者交账 blocked，走现有的发布受阻流程', async () => {
    const { fix, job } = await acceptedWithLaunch();
    await nextPacket(fix, fix.engineer.id);
    const home = bot(fix, fix.engineer.id).homeDir;
    const before = snapshot(fix);
    const refused = await callTool(fix, bot(fix, fix.engineer.id), 'hub_outbox_submit', launchArgs(fix, { payload: { cmd: 'mkdir', args: ['-p', '/Users/someone/Desktop/p74r18b-site'], cwd: home } }));
    expect(refused).toEqual({ ok: false, error: REFUSAL('/Users/someone/Desktop/p74r18b-site') });
    expect(snapshot(fix)).toEqual(before);
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'blocked', blocker: '发布位置中心写不进去', summary: '约定里的发布位置写不进去' });
    expect(theJob(fix)).toMatchObject({ state: 'done', launch: { state: 'declined', endedBy: 'hub' } });
    expect(chiefSays(fix).filter(text => text === launchBlockedText({ title: '会员定价页', executor: '林舟', reason: '发布位置中心写不进去' }))).toHaveLength(1);
    expect(job.id).toBe(theJob(fix).id);
  });

  it('要写 /tmp 下、项目文件夹下、家目录下的命令：照常建审批；分析不出路径的命令：照常建审批', async () => {
    const { fix } = await acceptedWithLaunch();
    await nextPacket(fix, fix.engineer.id);
    const executor = bot(fix, fix.engineer.id);
    const projectDir = memberProjectDirs(fix.ctx, executor.id)[0];
    expect(projectDir, '夹具里执行者应该在一个项目里').toBeDefined();
    const targets = ['/tmp/p74r18b-site', `${projectDir}/p74r18b-site`, `${executor.homeDir}/work/p74r18b-site`];
    // P74r19 同步（第 1 节）：原意是每种路径的命令都能建审批；现在同一时间只有一条发布命令在等批准，
    // 第一条之后的提交要带 replace: true 才被接受（取代前一条，审批单仍各建一张，总数不变）。
    for (const [index, target] of targets.entries()) {
      const result = await callTool(fix, executor, 'hub_outbox_submit', { kind: 'run_command', why: `发布到 ${target}`, payload: { cmd: 'mkdir', args: ['-p', target], cwd: executor.homeDir }, ...(index > 0 ? { replace: true } : {}) });
      expect(result, `${target} ${JSON.stringify(result)}`).toMatchObject({ ok: true });
    }
    const unknown = await callTool(fix, executor, 'hub_outbox_submit', { kind: 'run_command', why: '路径来自变量', payload: { cmd: 'mkdir', args: ['-p', '$SITE_DIR'], cwd: executor.homeDir }, replace: true });
    expect(unknown, JSON.stringify(unknown)).toMatchObject({ ok: true });
    expect(fix.ctx.store.table('approvals').list().length).toBe(4);
  });

  it('项目里由中心维护的文件（context.md）不可写：提交时被拒', async () => {
    const { fix } = await acceptedWithLaunch();
    await nextPacket(fix, fix.engineer.id);
    const executor = bot(fix, fix.engineer.id);
    const projectDir = memberProjectDirs(fix.ctx, executor.id)[0]!;
    const result = await callTool(fix, executor, 'hub_outbox_submit', { kind: 'run_command', why: '改项目上下文', payload: { cmd: 'touch', args: [`${projectDir}/context.md`], cwd: executor.homeDir } });
    expect(result).toEqual({ ok: false, error: REFUSAL(`${projectDir}/context.md`) });
  });
});

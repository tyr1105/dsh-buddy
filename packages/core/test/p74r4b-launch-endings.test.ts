/**
 * P74r4b 第 1 节的测试：发布这一步用满自己的回合上限时，按当时的事实说话。
 *
 * 四种事实（命令已运行的分成功、失败两条，共五条）各断言三样：发布状态、审批状态、总管私聊里那句话逐字相同；
 * 另外断言：主人批准过的审批在任何一种情况下都不会变成「已拒绝」。
 * 用真实 Hub、真实工具、假时钟（每次推进不超过 10 分钟）。回合数靠往唤醒表补几行「已提交的回合」凑满 4 个，
 * 然后调用 cap.ts 在闸门丢弃发布叫醒时调用的同一个函数 stopLaunchForCap（整条闸门链路已由 p74g-launch-limits 测过）。
 */
import { describe, expect, it } from 'vitest';
import { JOB_DEFAULTS } from '../src/config/defaults.js';
import { LAUNCH_VOIDED_TEXT, launchCapText, stopLaunchForCap } from '../src/job/launch-approval.js';
import { launchTurnsUsed } from '../src/job/launch-turns.js';
import { eventsOf } from './p74c-fixtures.js';
import { bot, MINUTE, theJob, threadOf, tick, type JobFix } from './p74f-fixtures.js';
import { acceptedWithLaunch, submitLaunch } from './p74g-launch-fixtures.js';
import { approveWithoutRun } from './p74r18b-fixtures.js';

/** 把脚本文件放好（命令内容绑定进批准票）。 */
async function putScript(fix: JobFix): Promise<void> {
  const home = bot(fix, fix.engineer.id).homeDir;
  await fix.ctx.fs.mkdirp(`${home}/work`);
  await fix.ctx.fs.writeTextAtomic(`${home}/work/go-live.js`, 'console.log("v1")');
}

/** 往唤醒表补几行已提交的回合，补到验收之后执行者在这件事上恰好有 4 个回合；返回实际回合数。 */
function fillTurns(fix: JobFix, jobId: string): number {
  const job = theJob(fix);
  const sample = fix.ctx.store.table('wakes').list()[0]!;
  for (let index = launchTurnsUsed(fix.ctx, job); index < JOB_DEFAULTS.LAUNCH_TURN_CAP; index += 1) {
    fix.ctx.store.table('wakes').put({ ...sample, id: `w_endfill${index}${index}`, botId: fix.engineer.id, jobId, startedAt: job.acceptedAt! + 1 + index, endedAt: fix.ctx.clock.now(), status: 'committed' });
  }
  return launchTurnsUsed(fix.ctx, theJob(fix));
}

/** 总管私聊里总管名义的话。 */
const chiefSays = (fix: JobFix) => threadOf(fix.ctx, fix.chief.id).filter(row => row.from === fix.chief.id).map(row => row.text);

describe('发布这一步用满回合上限：按事实说话', () => {
  it('1 执行者还没有提交发布审批：暂不发布，审批无，那句话逐字相同', async () => {
    const { fix, job } = await acceptedWithLaunch();
    const turns = fillTurns(fix, job.id);
    stopLaunchForCap(fix.ctx, job.id);
    expect(theJob(fix)).toMatchObject({ state: 'done', launch: { state: 'declined', approvalId: null, link: null } });
    expect(fix.ctx.store.table('approvals').count()).toBe(0);
    const text = '会员定价页的发布这一步用了 4 个回合，林舟仍没有提交发布审批，发布这一步到此结束，没有发布。需要时告诉我。';
    expect(turns).toBe(4);
    expect(launchCapText('no_approval', { title: '会员定价页', turns, executor: '林舟' })).toBe(text);
    expect(chiefSays(fix).filter(said => said === text)).toHaveLength(1);
    expect(eventsOf(fix.ctx, job.id).filter(row => row.kind === 'launch_declined')).toMatchObject([{ data: { reason: 'turn_cap', turns: 4 } }]);
  });

  it('2 审批在等你批准：暂不发布，审批作废（不是已拒绝），待你处理里的审批卡撤回，那句话逐字相同', async () => {
    const { fix, job } = await acceptedWithLaunch();
    await putScript(fix);
    const { approval } = await submitLaunch(fix);
    expect(fix.ctx.store.table('approvals').get(approval.id)!.status).toBe('pending');
    expect(fix.ctx.store.table('inbox').list(item => item.type === 'approval' && item.refId === approval.id && item.status === 'open')).toHaveLength(1);
    const turns = fillTurns(fix, job.id);
    stopLaunchForCap(fix.ctx, job.id);
    expect(theJob(fix)).toMatchObject({ state: 'done', launch: { state: 'declined', approvalId: approval.id } });
    const after = fix.ctx.store.table('approvals').get(approval.id)!;
    expect(after.status).toBe('expired');
    expect(after.status).not.toBe('rejected');
    expect(fix.ctx.store.table('inbox').list(item => item.type === 'approval' && item.refId === approval.id && item.status === 'open')).toHaveLength(0);
    const text = `会员定价页的发布这一步用了 ${turns} 个回合仍没有完成，等你批准的那张发布审批已作废，没有发布。需要时告诉我。`;
    expect(launchCapText('pending', { title: '会员定价页', turns, executor: '林舟' })).toBe(text);
    expect(chiefSays(fix).filter(said => said === text)).toHaveLength(1);
    // 之后中心也不会运行那条命令。
    await tick(fix, 2 * MINUTE);
    expect(fix.ctx.exec.calls).toHaveLength(0);
  });

  it('3 你已批准、命令还没有运行：暂不发布，审批作废（不是已拒绝），之后命令不会运行，那句话逐字相同', async () => {
    const { fix, job } = await acceptedWithLaunch();
    await putScript(fix);
    const { approval } = await submitLaunch(fix);
    expect(await approveWithoutRun(fix, approval.id)).toMatchObject({ ok: true }); // P74r18b 同步：只记下批准的决定（界面入口会立刻开始执行）
    expect(fix.ctx.store.table('approvals').get(approval.id)!.status).toBe('approved');
    const turns = fillTurns(fix, job.id);
    stopLaunchForCap(fix.ctx, job.id);
    expect(theJob(fix)).toMatchObject({ state: 'done', launch: { state: 'declined', link: null } });
    const after = fix.ctx.store.table('approvals').get(approval.id)!;
    expect(after.status).toBe('expired');
    expect(after.status).not.toBe('rejected');
    const text = `会员定价页的发布这一步用了 ${turns} 个回合仍没有完成，你批准的发布命令还没有运行，已作废，没有发布。需要时告诉我。`;
    expect(launchCapText('approved', { title: '会员定价页', turns, executor: '林舟' })).toBe(text);
    expect(chiefSays(fix).filter(said => said === text)).toHaveLength(1);
    await tick(fix, 2 * MINUTE);
    expect(fix.ctx.exec.calls).toHaveLength(0);
    expect(fix.ctx.store.table('approvals').get(approval.id)!.status).toBe('expired');
  });

  /** 批准并让中心运行命令（命令结果由 code 决定），返回这张审批。 */
  async function approveAndRun(fix: JobFix, code: number) {
    await putScript(fix);
    const { approval } = await submitLaunch(fix);
    // P74r18b 同步：命令运行完之后中心马上把结果记到这件事上（发布状态不再停在等批准），这里要测的是「结果没有记到这件事上」时
    // 回合用满的收尾，所以不真的运行命令：直接构造状态——批准票已使用（命令已运行）、出站记录是终点状态（成功或失败）、发布状态仍是等批准。
    expect(await approveWithoutRun(fix, approval.id)).toMatchObject({ ok: true });
    fix.ctx.store.table('approvals').patch(approval.id, { status: 'used', usedAt: fix.ctx.clock.now() });
    const row = fix.ctx.store.table('outbox').list(item => item.approvalId === approval.id)[0]!;
    fix.ctx.store.table('outbox').patch(row.id, code === 0 ? { status: 'done', result: '已上线', executionStarted: true, doneAt: fix.ctx.clock.now() }
      : { status: 'failed', result: `命令退出码 ${code}：出错了`, ownerFailureReason: `命令退出码 ${code}`, executionStarted: true, doneAt: fix.ctx.clock.now() });
    return approval;
  }

  it('4a 命令已经运行、成功：发布状态记为已发布（没有地址），审批不动，那句话逐字相同', async () => {
    const { fix, job } = await acceptedWithLaunch();
    const approval = await approveAndRun(fix, 0);
    // P74r18b 同步：状态是直接构造的（见 approveAndRun 里的说明），命令没有真的运行。
    expect(fix.ctx.exec.calls).toHaveLength(0);
    expect(fix.ctx.store.table('approvals').get(approval.id)!.status).toBe('used');
    expect(fix.ctx.store.table('outbox').list(row => row.approvalId === approval.id)[0]!.status).toBe('done');
    const turns = fillTurns(fix, job.id);
    stopLaunchForCap(fix.ctx, job.id);
    expect(theJob(fix)).toMatchObject({ state: 'done', launch: { state: 'done', approvalId: approval.id, link: null } });
    expect(fix.ctx.store.table('approvals').get(approval.id)!.status).toBe('used');
    const text = '会员定价页的发布命令已经运行，林舟没有回报发布后的地址。请你确认是否已上线。';
    expect(launchCapText('ran_ok', { title: '会员定价页', turns, executor: '林舟' })).toBe(text);
    expect(chiefSays(fix).filter(said => said === text)).toHaveLength(1);
    expect(eventsOf(fix.ctx, job.id).filter(row => row.kind === 'launched')).toMatchObject([{ actor: 'hub', data: { link: null, reason: 'turn_cap' } }]);
  });

  it('4b 命令已经运行、失败：发布状态记为暂不发布，审批不动，那句话逐字相同', async () => {
    const { fix, job } = await acceptedWithLaunch();
    const approval = await approveAndRun(fix, 1);
    expect(fix.ctx.store.table('approvals').get(approval.id)!.status).toBe('used');
    expect(fix.ctx.store.table('outbox').list(row => row.approvalId === approval.id)[0]!.status).toBe('failed');
    const turns = fillTurns(fix, job.id);
    stopLaunchForCap(fix.ctx, job.id);
    expect(theJob(fix)).toMatchObject({ state: 'done', launch: { state: 'declined', approvalId: approval.id, link: null } });
    expect(fix.ctx.store.table('approvals').get(approval.id)!.status).toBe('used');
    const text = '会员定价页的发布命令运行失败，没有发布。需要时告诉我。';
    expect(launchCapText('ran_failed', { title: '会员定价页', turns, executor: '林舟' })).toBe(text);
    expect(chiefSays(fix).filter(said => said === text)).toHaveLength(1);
    expect(eventsOf(fix.ctx, job.id).filter(row => row.kind === 'launch_declined')).toMatchObject([{ data: { reason: 'turn_cap_command_failed' } }]);
  });

  it('主人批准过的审批在任何一种情况下都不会变成已拒绝；整个收尾只说一句，重复调用不再说话', async () => {
    const { fix, job } = await acceptedWithLaunch();
    await putScript(fix);
    const { approval } = await submitLaunch(fix);
    expect(await approveWithoutRun(fix, approval.id)).toMatchObject({ ok: true }); // P74r18b 同步：只记下批准的决定
    fillTurns(fix, job.id);
    const before = chiefSays(fix).length;
    stopLaunchForCap(fix.ctx, job.id);
    stopLaunchForCap(fix.ctx, job.id);
    expect(chiefSays(fix)).toHaveLength(before + 1);
    expect(fix.ctx.store.table('approvals').list().filter(row => row.status === 'rejected')).toHaveLength(0);
  });

  it('对照：批准之后脚本被改动的作废（P74g 已有路径）句子不变', () => {
    expect(LAUNCH_VOIDED_TEXT).toBe('发布审批已作废（批准之后要运行的命令有改动），没有发布。需要时告诉我。');
  });
});

/**
 * P74r4b-m1 的测试：复核后的三处小改。
 * 第 1 节：中心作废的审批统一记为「已过期」并带 voided 标记（两条路径共用 gate/void-approval.ts），审批卡视图 voided；
 * 第 2 节：交回时同样要求预览文件在「交付」文件夹里，与打开时同一个判断；
 * 第 3 节：命令已运行、出站记录还不是终点状态时，发布这一步用满回合上限这一次不下结论；到终点状态按结果说；满 30 分钟按「结果没有记录下来」说。
 */
import { describe, expect, it } from 'vitest';
import * as nodeFs from 'node:fs';
import { join } from 'node:path';
import { expireApprovals } from '../src/gate/approvals.js';
import { VOID_OWNER_TEXT, VOID_REASON_CHANGED, VOID_REASON_LAUNCH_CAP, voidApproval } from '../src/gate/void-approval.js';
import { previewError } from '../src/job/evidence.js';
import { launchCapText, stopLaunchForCap } from '../src/job/launch-approval.js';
import { launchTurnsUsed } from '../src/job/launch-turns.js';
import { PREVIEW_NOT_IN_DELIVERY_TEXT } from '../src/job/preview-copy.js';
import { jobPreviewTarget } from '../src/job/preview.js';
import { JOB_DEFAULTS } from '../src/config/defaults.js';
import { eventsOf } from './p74c-fixtures.js';
import { jobFix, started } from './p74d-fixtures.js';
import { bot, callTool, MINUTE, nextPacket, theJob, threadOf, tick, type JobFix } from './p74f-fixtures.js';
import { acceptedWithLaunch, launchArgs, submitLaunch } from './p74g-launch-fixtures.js';
import { registerCleanup, setup } from './p74g-fixtures.js';
import { approveWithoutRun } from './p74r18b-fixtures.js';

registerCleanup();

async function putScript(fix: JobFix): Promise<string> {
  const home = bot(fix, fix.engineer.id).homeDir;
  await fix.ctx.fs.mkdirp(`${home}/work`);
  await fix.ctx.fs.writeTextAtomic(`${home}/work/go-live.js`, 'console.log("v1")');
  return `${home}/work/go-live.js`;
}
const chiefSays = (fix: JobFix) => threadOf(fix.ctx, fix.chief.id).filter(row => row.from === fix.chief.id).map(row => row.text);
const cardOf = (fix: JobFix, threadId: string, approvalId: string) => fix.hub.api.thread(threadId).messages.find(row => row.card?.approvalId === approvalId)?.card;

describe('1 中心作废的审批：统一记为已过期并带 voided', () => {
  it('发布这一步用满回合上限而作废：状态已过期、voided 为真、撤回的卡片上写事实原因、视图 voided 为真', async () => {
    const { fix, job } = await acceptedWithLaunch();
    const { approval } = await submitLaunch(fix);
    const card = fix.ctx.store.table('inbox').list(row => row.refId === approval.id)[0]!;
    const sample = fix.ctx.store.table('wakes').list()[0]!;
    for (let index = launchTurnsUsed(fix.ctx, theJob(fix)); index < JOB_DEFAULTS.LAUNCH_TURN_CAP; index += 1) {
      fix.ctx.store.table('wakes').put({ ...sample, id: `w_m1fill${index}${index}`, botId: fix.engineer.id, jobId: job.id, startedAt: theJob(fix).acceptedAt! + 1 + index, endedAt: fix.ctx.clock.now(), status: 'committed' });
    }
    stopLaunchForCap(fix.ctx, job.id);
    expect(fix.ctx.store.table('approvals').get(approval.id)).toMatchObject({ status: 'expired', voided: true });
    expect(fix.ctx.store.table('inbox').get(card.id)).toMatchObject({ status: 'withdrawn', answer: '发布这一步没有在规定的回合内完成，已作废' });
    expect(VOID_REASON_LAUNCH_CAP).toBe('发布这一步没有在规定的回合内完成，已作废');
    expect(cardOf(fix, fix.chief.id, approval.id)?.approval).toMatchObject({ voided: true, launch: true });
  });

  it('作废函数本身：撤回卡片时答复栏写传入的原因，批准后内容被改动的原因逐字固定', async () => {
    const { fix } = await acceptedWithLaunch();
    const { approval } = await submitLaunch(fix);
    const card = fix.ctx.store.table('inbox').list(row => row.refId === approval.id)[0]!;
    voidApproval(fix.ctx, approval.id, VOID_REASON_CHANGED, fix.ctx.clock.now());
    expect(fix.ctx.store.table('inbox').get(card.id)).toMatchObject({ status: 'withdrawn', answer: '批准之后要运行的内容被改动，已作废，没有运行' });
    expect(fix.ctx.store.table('approvals').get(approval.id)).toMatchObject({ status: 'expired', voided: true });
  });

  it('批准之后内容被改动（发布审批）：已过期加 voided，不是已拒绝；总管私聊那句话里没有「拒绝」', async () => {
    const { fix } = await acceptedWithLaunch();
    const script = await putScript(fix);
    const { approval } = await submitLaunch(fix);
    // P74r18b 同步：构造「已批准、还没有执行」的中间状态，只记下批准的决定（界面入口会立刻开始执行，见 p74r18b-fixtures.ts）。
    expect(await approveWithoutRun(fix, approval.id)).toMatchObject({ ok: true });
    await fix.ctx.fs.writeTextAtomic(script, 'console.log("v2")');
    await tick(fix, 2 * MINUTE);
    expect(fix.ctx.store.table('approvals').get(approval.id)).toMatchObject({ status: 'expired', voided: true });
    expect(cardOf(fix, fix.chief.id, approval.id)?.approval).toMatchObject({ voided: true });
    const said = chiefSays(fix).filter(text => text.includes('已作废'));
    expect(said.length).toBeGreaterThan(0);
    for (const text of said) expect(text).not.toContain('拒绝');
  });

  it('批准之后内容被改动（执行中途、属于这件事的审批）：总管私聊落「……已作废，没有运行。需要时让员工重新提交。」', async () => {
    const { fix } = await started();
    const script = await putScript(fix);
    const { cost: _c, undo: _u, after: _a, ...plain } = launchArgs(fix);
    expect(await callTool(fix, bot(fix, fix.engineer.id), 'hub_outbox_submit', { ...plain, why: '跑一次整理脚本' })).toMatchObject({ ok: true });
    const approval = fix.ctx.store.table('approvals').list()[0]!;
    expect(await approveWithoutRun(fix, approval.id)).toMatchObject({ ok: true }); // P74r18b 同步：只记下批准的决定
    await fix.ctx.fs.writeTextAtomic(script, 'console.log("v2")');
    await tick(fix, 2 * MINUTE);
    expect(fix.ctx.store.table('approvals').get(approval.id)).toMatchObject({ status: 'expired', voided: true });
    expect(VOID_OWNER_TEXT).toBe('批准之后要运行的内容被改动，这张审批已作废，没有运行。需要时让员工重新提交。');
    expect(threadOf(fix.ctx, fix.chief.id).filter(row => row.text === VOID_OWNER_TEXT)).toHaveLength(1);
  });

  it('批准之后内容被改动（与任何事无关的审批）：已过期加 voided；员工私聊里的回执没有「拒绝」，总管私聊没有新话', async () => {
    const fix = await jobFix();
    const script = await putScript(fix);
    await fix.hub.api.sendMessage(fix.engineer.id, '请帮我跑一次整理脚本');
    await nextPacket(fix, fix.engineer.id);
    const { cost: _c, undo: _u, after: _a, ...plain } = launchArgs(fix);
    expect(await callTool(fix, bot(fix, fix.engineer.id), 'hub_outbox_submit', { ...plain, why: '跑一次整理脚本' })).toMatchObject({ ok: true });
    const approval = fix.ctx.store.table('approvals').list()[0]!;
    expect(await approveWithoutRun(fix, approval.id)).toMatchObject({ ok: true }); // P74r18b 同步：只记下批准的决定
    const chiefBefore = threadOf(fix.ctx, fix.chief.id).length;
    await fix.ctx.fs.writeTextAtomic(script, 'console.log("v2")');
    await tick(fix, 2 * MINUTE);
    expect(fix.ctx.store.table('approvals').get(approval.id)).toMatchObject({ status: 'expired', voided: true });
    expect(threadOf(fix.ctx, fix.chief.id)).toHaveLength(chiefBefore);
    const receipts = threadOf(fix.ctx, fix.engineer.id).filter(row => row.from === 'hub' && row.text.includes('脚本在批准后被改动'));
    expect(receipts.length).toBeGreaterThan(0);
    for (const row of receipts) expect(row.text).not.toContain('拒绝');
  });

  it('主人点拒绝：状态已拒绝、voided 为假；到期没有人处理：状态已过期、voided 为假', async () => {
    const { fix } = await acceptedWithLaunch();
    await putScript(fix);
    const { approval } = await submitLaunch(fix);
    expect(await fix.hub.api.decideApproval(approval.id, false)).toMatchObject({ ok: true });
    expect(fix.ctx.store.table('approvals').get(approval.id)).toMatchObject({ status: 'rejected' });
    expect(fix.ctx.store.table('approvals').get(approval.id)!.voided).toBeUndefined();
    expect(cardOf(fix, fix.chief.id, approval.id)?.approval?.voided).toBe(false);

    const second = await jobFix();
    await second.hub.api.sendMessage(second.engineer.id, '请帮我跑一次整理脚本');
    await nextPacket(second, second.engineer.id);
    const { cost: _c, undo: _u, after: _a, ...plain } = launchArgs(second);
    expect(await callTool(second, bot(second, second.engineer.id), 'hub_outbox_submit', { ...plain, why: '跑一次整理脚本' })).toMatchObject({ ok: true });
    const pending = second.ctx.store.table('approvals').list()[0]!;
    await expireApprovals(second.ctx, second.ctx.clock.now() + 48 * 60 * MINUTE);
    expect(second.ctx.store.table('approvals').get(pending.id)).toMatchObject({ status: 'expired' });
    expect(second.ctx.store.table('approvals').get(pending.id)!.voided).toBeUndefined();
    expect(second.hub.api.thread(second.engineer.id).messages.find(row => row.card?.approvalId === pending.id)?.card?.approval?.voided).toBe(false);
  });
});

describe('2 交回时预览文件要在「交付」文件夹里', () => {
  it('交回 证据/ 下的 .html 被拒、文字逐字相同；交付/ 下的通过；打开时同样不通过', async () => {
    const s = setup();
    s.write('证据/页面.html', '<html></html>');
    s.write('交付/index.html', '<html></html>');
    expect(await previewError(s.ctx, s.job, '证据/页面.html'))
      .toBe('preview：预览文件要放在这件事的「交付」文件夹里（现在是 证据/页面.html）。放进「交付」文件夹后再交回，或者不写 preview。');
    expect(await previewError(s.ctx, s.job, '交付/index.html')).toBeNull();
    s.submit({ preview: '证据/页面.html' });
    expect(await jobPreviewTarget(s.ctx, { jobId: 'job_0000000001' })).toEqual({ ok: false, error: PREVIEW_NOT_IN_DELIVERY_TEXT });
    s.submit({ preview: '交付/index.html', id: 'jsb_0000000002', createdAt: 9_000_000_000_000 });
    expect((await jobPreviewTarget(s.ctx, { jobId: 'job_0000000001' })).ok).toBe(true);
    // 只是顺带确认测试用的临时目录存在。
    expect(nodeFs.existsSync(join(s.jobDir, '证据/页面.html'))).toBe(true);
  });
});

describe('3 命令已运行、出站记录还不是终点状态：不下结论', () => {
  /** 批准、让中心运行命令（成功），之后把出站记录改回「就绪」模拟运行中；回合凑满 4 个。 */
  async function running() {
    const { fix, job } = await acceptedWithLaunch();
    await putScript(fix);
    const { approval } = await submitLaunch(fix);
    // P74r18b 同步：命令运行完之后中心马上把结果记到这件事上（发布状态不再停在等批准），所以这里不真的运行命令，
    // 直接构造本节要测的状态——批准票已使用（命令已开始运行）、出站记录还是「就绪」（运行中）、发布状态仍是等批准。
    expect(await approveWithoutRun(fix, approval.id)).toMatchObject({ ok: true });
    const row = fix.ctx.store.table('outbox').list(item => item.approvalId === approval.id)[0]!;
    fix.ctx.store.table('approvals').patch(approval.id, { status: 'used', usedAt: fix.ctx.clock.now() });
    fix.ctx.store.table('outbox').patch(row.id, { status: 'ready', doneAt: null });
    const sample = fix.ctx.store.table('wakes').list()[0]!;
    for (let index = launchTurnsUsed(fix.ctx, theJob(fix)); index < JOB_DEFAULTS.LAUNCH_TURN_CAP; index += 1) {
      fix.ctx.store.table('wakes').put({ ...sample, id: `w_m1run${index}${index}`, botId: fix.engineer.id, jobId: job.id, startedAt: theJob(fix).acceptedAt! + 1 + index, endedAt: fix.ctx.clock.now(), status: 'committed' });
    }
    return { fix, job, approval, row };
  }

  it('运行中：这一次不结束、不落话；之后变成功：落「已经运行……没有回报发布后的地址」', async () => {
    const { fix, job, row } = await running();
    const before = chiefSays(fix).length;
    stopLaunchForCap(fix.ctx, job.id);
    expect(theJob(fix)).toMatchObject({ state: 'done', launch: { state: 'approval' } });
    expect(chiefSays(fix)).toHaveLength(before);
    fix.ctx.store.table('outbox').patch(row.id, { status: 'done' });
    stopLaunchForCap(fix.ctx, job.id);
    expect(theJob(fix)).toMatchObject({ launch: { state: 'done', link: null } });
    expect(chiefSays(fix).filter(text => text === '会员定价页的发布命令已经运行，林舟没有回报发布后的地址。请你确认是否已上线。')).toHaveLength(1);
  });

  it('运行中，之后变失败：落「运行失败，没有发布」，发布状态暂不发布', async () => {
    const { fix, job, row } = await running();
    stopLaunchForCap(fix.ctx, job.id);
    expect(theJob(fix).launch.state).toBe('approval');
    fix.ctx.store.table('outbox').patch(row.id, { status: 'failed' });
    stopLaunchForCap(fix.ctx, job.id);
    expect(theJob(fix).launch.state).toBe('declined');
    expect(chiefSays(fix).filter(text => text === '会员定价页的发布命令运行失败，没有发布。需要时告诉我。')).toHaveLength(1);
  });

  it('30 分钟仍在运行中：落「结果没有记录下来」，已发布（没有地址）；每次推进不超过 10 分钟，之后也不重复说', async () => {
    const { fix, job } = await running();
    // 出站记录是「运行中」时巡检（sweep）每个 tick 都再看一次；这里直接调用巡检补做，避免出站循环把运行中的记录收尾掉。
    for (let step = 0; step < 2; step += 1) {
      fix.ctx.clock.advance(10 * MINUTE);
      stopLaunchForCap(fix.ctx, job.id);
      expect(theJob(fix).launch.state, `第 ${(step + 1) * 10} 分钟`).toBe('approval');
    }
    fix.ctx.clock.advance(10 * MINUTE);
    stopLaunchForCap(fix.ctx, job.id);
    const text = '会员定价页的发布命令已经运行，结果没有记录下来。请你确认是否已上线。';
    expect(launchCapText('ran_unknown', { title: '会员定价页', turns: 4, executor: '林舟' })).toBe(text);
    expect(theJob(fix)).toMatchObject({ launch: { state: 'done', link: null } });
    expect(chiefSays(fix).filter(said => said === text)).toHaveLength(1);
    stopLaunchForCap(fix.ctx, job.id);
    expect(chiefSays(fix).filter(said => said === text)).toHaveLength(1);
    expect(eventsOf(fix.ctx, job.id).filter(event => event.kind === 'launched')).toHaveLength(1);
  });

  it('出站记录是已拒绝（命令运行途中中心退出、重启后被收尾）：不说运行失败，按「结果没有记录下来」说', async () => {
    const { fix, job, row } = await running();
    fix.ctx.store.table('outbox').patch(row.id, { status: 'rejected' });
    stopLaunchForCap(fix.ctx, job.id);
    expect(chiefSays(fix).filter(text => text === '会员定价页的发布命令已经运行，结果没有记录下来。请你确认是否已上线。')).toHaveLength(1);
    expect(chiefSays(fix).filter(text => text.includes('运行失败'))).toHaveLength(0);
  });

  it('巡检补做：回合用满、命令已使用、记录终点状态后，下一次 tick 自己落话（没有叫醒也不会漏）', async () => {
    const { fix, job, row } = await running();
    stopLaunchForCap(fix.ctx, job.id);
    expect(theJob(fix).launch.state).toBe('approval');
    fix.ctx.store.table('outbox').patch(row.id, { status: 'failed' });
    await tick(fix, 1 * MINUTE);
    expect(theJob(fix).launch.state).toBe('declined');
    expect(chiefSays(fix).filter(text => text === '会员定价页的发布命令运行失败，没有发布。需要时告诉我。')).toHaveLength(1);
  });
});

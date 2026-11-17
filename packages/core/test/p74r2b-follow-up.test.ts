/**
 * P74r2b 的测试（三）：约定固定之后的收尾（审查报告第 4 节疑点 1、疑点 2）。
 *
 * 疑点 1：固定后的收尾按版本号判断是否退回返工：最近一次交回已经是按新版本做的，不退回。
 * 疑点 2：收尾只登记在内存里，约定已经写成固定、收尾还没跑完时进程退出，重启后暂停永远不清、主题文件不重写、
 *         执行者不被叫醒。现在每件事记下「已处理到约定第几版」，启动整理和每次巡检发现约定的固定版本更大就补做，
 *         与正常收尾走同一个函数，话、往来、事件、叫醒都只出现一次。
 * 「重启」的做法：停掉旧的中心，用同一份存储和文件重新建一个中心（与 p73r2 的重启测试同一做法）。
 * 「收尾没跑完」的做法：把约定写成固定（applyLock 之后直接写存储），不调用收尾。
 */
import { describe, expect, it } from 'vitest';
import { createHub } from '../src/engine/hub.js';
import { catchUpJobFollowUps } from '../src/job/catch-up.js';
import { flushJobHooks, onAgreementLocked } from '../src/job/agreement-hooks.js';
import { jobFolderPaths } from '../src/job/files.js';
import { AgreementSchema } from '../src/model/agreement.js';
import { confirmAgreementCommand } from '../src/project/agreement-confirm.js';
import { applyLock } from '../src/project/agreements.js';
import { latestSubmission } from '../src/job/store.js';
import { engineerSubmits, executorInfo, theJob, threadOf } from './p74d-fixtures.js';
import {
  MINUTE, bot, callTool, commitAndEnd, entriesOf, idsIn, lastPacket, nextPacket, ownerSays, pendingReopen, started, tick, wakesOf, wokenFor,
  type JobFix,
} from './p74r2b-fixtures.js';

/** 把约定第 n 版写成固定，但不做收尾（模拟「约定已写成固定、收尾还没跑完」）。 */
function lockWithoutFollowUp(fix: JobFix, agreementId: string, version: number): void {
  const agreement = fix.ctx.store.table('agreements').get(agreementId)!;
  const locked = applyLock(agreement, { version, via: 'button', choices: null, at: fix.ctx.clock.now(), confirmMessageId: null });
  fix.ctx.store.table('agreements').put(AgreementSchema.parse({ ...locked, inboxId: null }));
}

/** 重启：停掉旧的中心，用同一份存储和文件重新建一个中心并启动。 */
async function restart(fix: JobFix) {
  await fix.hub.stop();
  const hub = createHub({ ...fix.ctx, settings: { ...fix.ctx.settings } });
  await hub.start();
  return hub;
}

/** 主题里含这句话的消息条数。 */
function lineCount(fix: JobFix, topicId: string, part: string): number {
  return threadOf(fix.ctx, topicId).filter(row => row.text.includes(part)).length;
}

/** 这件事的「resumed」事件里，属于约定第 n 版的条数。 */
function resumedCount(fix: JobFix, jobId: string, versionNo: number): number {
  return fix.ctx.store.log('jobEvents').all().filter(row => row.jobId === jobId && row.kind === 'resumed' && row.data.versionNo === versionNo).length;
}

/** 约定文件的全文。 */
async function agreementFile(fix: JobFix): Promise<string> {
  return (await fix.ctx.fs.readText(`${jobFolderPaths(fix.ctx, theJob(fix)).jobDir}/约定.md`)) ?? '';
}

describe('疑点 1：固定后的收尾按版本号判断是否退回返工', () => {
  it('新版本固定后、收尾开始之前，林舟已经按新版本交回（状态已是核对中）：收尾跑完后仍是核对中，核对人的候选还在', async () => {
    const { fix, job, agreementId } = await pendingReopen({ doneWhen: ['打开页面能看到今天的报价', '点刷新后数据更新', '接口失败时有提示，并写明原因'] });
    // 林舟拿到回合（这时约定还是等确认），之后约定固定、收尾还没开始，他按新版本交回。
    const packet = await nextPacket(fix, fix.engineer.id);
    lockWithoutFollowUp(fix, agreementId, 2);
    await engineerSubmits(fix, executorInfo(packet));
    expect(theJob(fix)).toMatchObject({ state: 'checking', round: 1 });
    expect(latestSubmission(fix.ctx, job.id)!.versionNo).toBe(2);
    const reviewerBefore = entriesOf(fix, fix.reviewer.id, job.id).length + wakesOf(fix, fix.reviewer.id, job.id).length;
    expect(reviewerBefore).toBeGreaterThan(0);
    // 收尾现在才跑。
    onAgreementLocked(fix.ctx, agreementId, 2, 'confirm');
    await flushJobHooks(fix.ctx);
    expect(theJob(fix)).toMatchObject({ state: 'checking', round: 1, unmet: [], pause: null, handledVersionNo: 2 });
    expect(entriesOf(fix, fix.reviewer.id, job.id).length + wakesOf(fix, fix.reviewer.id, job.id).length).toBe(reviewerBefore);
    expect(lineCount(fix, job.topicId, '按新版本返工')).toBe(0);
  });
});

describe('疑点 2：收尾没有做完时补做', () => {
  it('固定一版之后、收尾跑之前重启：暂停已清、主题文件是新版本、林舟被叫醒、主题里那句话恰好一条；再跑几次巡检没有重复', async () => {
    const { fix, job, agreementId } = await pendingReopen();
    lockWithoutFollowUp(fix, agreementId, 2);
    expect(theJob(fix)).toMatchObject({ handledVersionNo: 1, pause: { versionNo: 2 } });
    expect(await agreementFile(fix)).not.toContain('支持暗色模式');
    const hub = await restart(fix);
    expect(theJob(fix)).toMatchObject({ pause: null, handledVersionNo: 2 });
    expect(await agreementFile(fix)).toContain('支持暗色模式');
    expect(wokenFor(fix, '约定第 2 版已生效，请接着做')).toBe(1);
    expect(lineCount(fix, job.topicId, '约定第 2 版已按你的确认固定')).toBe(1);
    expect(resumedCount(fix, job.id, 2)).toBe(1);
    // 再跑几次巡检：没有任何重复。
    for (let i = 0; i < 4; i += 1) { fix.ctx.clock.advance(10 * MINUTE); await hub.tick(); }
    expect(wokenFor(fix, '约定第 2 版已生效，请接着做')).toBe(1);
    expect(lineCount(fix, job.topicId, '约定第 2 版已按你的确认固定')).toBe(1);
    expect(resumedCount(fix, job.id, 2)).toBe(1);
    await hub.stop();
  });

  it('不重启，只靠巡检：固定一版而收尾没做，下一次巡检补做，补做一次', async () => {
    const { fix, job, agreementId } = await pendingReopen();
    lockWithoutFollowUp(fix, agreementId, 2);
    await tick(fix, 10 * MINUTE);
    await flushJobHooks(fix.ctx);
    expect(theJob(fix)).toMatchObject({ pause: null, handledVersionNo: 2 });
    for (let i = 0; i < 3; i += 1) await tick(fix, 10 * MINUTE);
    expect(lineCount(fix, job.topicId, '约定第 2 版已按你的确认固定')).toBe(1);
    expect(resumedCount(fix, job.id, 2)).toBe(1);
    expect(wokenFor(fix, '约定第 2 版已生效，请接着做')).toBe(1);
  });

  it('正常收尾跑完之后再跑巡检：没有任何重复；收尾还在跑时巡检不再开一份', async () => {
    const { fix, job, agreementId } = await pendingReopen();
    // 收尾还在跑（同步登记、异步写文件）时，巡检补做被挡住。
    confirmAgreementCommand(fix.ctx, { agreementId, version: 2 });
    catchUpJobFollowUps(fix.ctx);
    await flushJobHooks(fix.ctx);
    expect(theJob(fix)).toMatchObject({ pause: null, handledVersionNo: 2 });
    for (let i = 0; i < 4; i += 1) { catchUpJobFollowUps(fix.ctx); await flushJobHooks(fix.ctx); await tick(fix, 10 * MINUTE); }
    expect(lineCount(fix, job.topicId, '约定第 2 版已按你的确认固定')).toBe(1);
    expect(resumedCount(fix, job.id, 2)).toBe(1);
    expect(wokenFor(fix, '约定第 2 版已生效，请接着做')).toBe(1);
  });

  it('amend 之后重启（收尾没跑完）：主题文件是新版本，林舟被叫醒一次', async () => {
    const { fix, job } = await started();
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '继续做' });
    await ownerSays(fix, fix.chief.id, '那句话说得更准确些');
    const { agreementId } = idsIn(lastPacket(fix, bot(fix, fix.chief.id)));
    const amended = await callTool(fix, bot(fix, fix.chief.id), 'hub_agreement_submit', {
      mode: 'amend', agreementId, changeNote: '把一句话说得更准确', summary: '做一个能查看每日报价、可以手动刷新的小页面',
    });
    expect(amended, JSON.stringify(amended)).toMatchObject({ ok: true });
    expect(theJob(fix).handledVersionNo).toBe(2);
    // 模拟收尾没跑完：记录回到「已处理到第 1 版」，主题文件是旧的。
    fix.ctx.store.table('jobs').patch(job.id, { handledVersionNo: 1 });
    await fix.ctx.fs.writeTextAtomic(`${jobFolderPaths(fix.ctx, theJob(fix)).jobDir}/约定.md`, '旧版本的约定');
    const wokenBefore = wokenFor(fix, '约定第 2 版已生效，请接着做');
    const hub = await restart(fix);
    expect(theJob(fix).handledVersionNo).toBe(2);
    expect(await agreementFile(fix)).toContain('做一个能查看每日报价、可以手动刷新的小页面');
    expect(wokenFor(fix, '约定第 2 版已生效，请接着做') - wokenBefore).toBe(1);
    for (let i = 0; i < 3; i += 1) { fix.ctx.clock.advance(10 * MINUTE); await hub.tick(); }
    expect(wokenFor(fix, '约定第 2 版已生效，请接着做') - wokenBefore).toBe(1);
    await hub.stop();
  });

  it('暂停指向已撤下的版本：巡检之后暂停已清、林舟被叫醒、往来一句；再巡检不重复', async () => {
    const { fix, job, agreementId } = await pendingReopen();
    const agreement = fix.ctx.store.table('agreements').get(agreementId)!;
    // 模拟「撤销已经写成、清暂停的后续没做完」：约定回到已固定，第 2 版作废，这件事的暂停还指着第 2 版。
    fix.ctx.store.table('agreements').put(AgreementSchema.parse({ ...agreement, state: 'locked', inboxId: null,
      versions: agreement.versions.map(row => row.state === 'pending' ? { ...row, state: 'superseded' as const } : row) }));
    expect(theJob(fix).pause).toMatchObject({ versionNo: 2 });
    await tick(fix, 10 * MINUTE);
    expect(theJob(fix).pause).toBeNull();
    expect(wokenFor(fix, '约定第 2 版没有采用，仍按第 1 版做')).toBe(1);
    expect(lineCount(fix, job.topicId, '约定第 2 版没有采用，仍按第 1 版做')).toBe(1);
    for (let i = 0; i < 3; i += 1) await tick(fix, 10 * MINUTE);
    expect(wokenFor(fix, '约定第 2 版没有采用，仍按第 1 版做')).toBe(1);
    expect(lineCount(fix, job.topicId, '约定第 2 版没有采用，仍按第 1 版做')).toBe(1);
  });

  it('重写主题文件失败时：状态步骤照常做（暂停已清、已处理到新版本），主题文件里的约定仍是旧版本（只记日志）', async () => {
    const { fix, agreementId } = await pendingReopen();
    const original = fix.ctx.fs.writeTextAtomic.bind(fix.ctx.fs);
    fix.ctx.fs.writeTextAtomic = async () => { throw new Error('磁盘已满'); };
    try {
      confirmAgreementCommand(fix.ctx, { agreementId, version: 2 });
      await flushJobHooks(fix.ctx);
    } finally { fix.ctx.fs.writeTextAtomic = original; }
    expect(theJob(fix)).toMatchObject({ pause: null, handledVersionNo: 2 });
    expect(await agreementFile(fix)).not.toContain('支持暗色模式');
  });
});

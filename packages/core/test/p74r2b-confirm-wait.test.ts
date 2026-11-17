/**
 * P74r2b 的测试（二）：约定有新版本等主人确认期间，执行者做完照常在做的部分之后不再被续排（审查报告 G6）。
 *
 * 原来的现象：新版本待确认、主人一直没确认，林舟每个回合做照常的部分，尝试交回被拒，交账 progress，中心续排；
 * 10 小时用掉 16 个回合、15 次交回被拒，直到回合上限。
 * 现在：他的交回因等确认被拒、或交账结果写 no_change、blocked、needs_owner，就记下「执行者在等确认」：不再续排，
 * 这件事此刻在等谁为空，兜底巡检不叫人；确认或撤销时随暂停一起清掉，中心叫醒他。
 * 全部走真实 Hub，时间用假时钟，每次推进 10 分钟。
 */
import { describe, expect, it } from 'vitest';
import { expectedActorOf } from '../src/job/chain.js';
import { jobDelayNote } from '../src/job/delay.js';
import { flushJobHooks } from '../src/job/agreement-hooks.js';
import { commitAs } from './p74c-fixtures.js';
import { theJob } from './p74d-fixtures.js';
import {
  MINUTE, bot, callTool, commitAndEnd, engineerDelivers, entriesOf, nextPacket, ownerSays, pendingReopen, runningOf, sectionOf, tick, touches,
  wakesOf, type JobFix,
} from './p74r2b-fixtures.js';

/** 林舟尝试交回（被拒），再交账。 */
async function refusedThenCommit(fix: JobFix, jobId: string, outcome: 'progress' | 'no_change' = 'progress'): Promise<void> {
  const refused = await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', {
    mode: 'submit', jobId, changeNote: '做完了', items: [{ no: 1, selfCheck: 'at_delivery' }], deliverables: ['交付/报价页.html'],
  });
  expect(refused.ok).toBe(false);
  expect(refused.error).toContain('照常在做的部分做完了就结束这一回合，主人确认后中心会叫你。');
  await commitAndEnd(fix, fix.engineer.id, { outcome, summary: '照常的部分做完了，等确认' });
}

describe('G6 的复现场景：交回被拒之后交账 progress', () => {
  it('不再续排；推进 10 小时林舟的回合不超过 2 个；没有回合上限条目；确认后他被叫醒并能交回', async () => {
    const { fix, job, agreementId } = await pendingReopen();
    // 先让林舟拿到被叫醒的那个回合（这是确认之前唯一的一次）。
    const first = await nextPacket(fix, fix.engineer.id);
    expect(sectionOf(first)).toContain('照常在做的部分做完之后，交账的结果写 no_change，说明在等约定确认；主人确认后中心会叫你。');
    await refusedThenCommit(fix, job.id);
    expect(theJob(fix).pause).toMatchObject({ versionNo: 2, executorWaiting: true });
    expect(expectedActorOf(theJob(fix))).toBeNull();
    const after = touches(fix, job.id);
    for (let i = 0; i < 60; i += 1) {
      if (runningOf(fix, fix.engineer.id)) await refusedThenCommit(fix, job.id);
      await tick(fix, 10 * MINUTE);
    }
    expect(touches(fix, job.id)).toBe(after);
    expect(wakesOf(fix, fix.engineer.id, job.id).length).toBeLessThanOrEqual(2);
    expect(fix.ctx.store.table('inbox').list(row => row.subjectKey.startsWith(`job:${job.id}:cap:`))).toHaveLength(0);
    expect(theJob(fix)).toMatchObject({ state: 'doing', blocked: null });
    // 进度行如实写在等主人确认第 2 版。
    expect(jobDelayNote(fix.ctx, theJob(fix), fix.ctx.clock.now())).toBe('在等你确认约定第 2 版');
    // 主人确认：暂停和「在等确认」一起清掉，林舟被叫醒并能交回。
    expect(await fix.hub.api.confirmAgreement({ agreementId, version: 2 })).toMatchObject({ ok: true });
    await flushJobHooks(fix.ctx);
    expect(theJob(fix).pause).toBeNull();
    await engineerDelivers(fix);
    expect(theJob(fix).state).toBe('checking');
  });
});

describe('等确认期间交账 no_change', () => {
  it('不转受阻、不续排；兜底不叫人；总管撤销之后林舟被叫醒', async () => {
    const { fix, job, agreementId } = await pendingReopen();
    await nextPacket(fix, fix.engineer.id);
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'no_change', summary: '在等约定确认' });
    expect(theJob(fix)).toMatchObject({ state: 'doing', blocked: null, pause: { executorWaiting: true } });
    expect(expectedActorOf(theJob(fix))).toBeNull();
    const after = touches(fix, job.id);
    for (let i = 0; i < 18; i += 1) await tick(fix, 10 * MINUTE);
    expect(touches(fix, job.id)).toBe(after);
    expect(theJob(fix).state).toBe('doing');
    // blocked、needs_owner 同样不当作做不下去：交账的结果在等确认期间只记「在等确认」。
    // 主人不同意，总管（主人发起的回合）撤销：暂停清掉，林舟被叫醒。
    await ownerSays(fix, fix.chief.id, '不用改了，按原来的做');
    const withdrawn = await callTool(fix, bot(fix, fix.chief.id), 'hub_agreement_submit', { mode: 'withdraw', agreementId, reason: '主人不改了' });
    expect(withdrawn, JSON.stringify(withdrawn)).toMatchObject({ ok: true });
    expect(theJob(fix).pause).toBeNull();
    expect(touches(fix, job.id)).toBeGreaterThan(after);
    const packet = await nextPacket(fix, fix.engineer.id);
    expect(sectionOf(packet)).not.toContain('在等主人确认');
  });

  it('交账结果写 blocked 也不转受阻（needs_owner 要带向主人的提问，执行链回合里员工带提问的交账本来就被拒，到不了这里）', async () => {
    const { fix } = await pendingReopen();
    await nextPacket(fix, fix.engineer.id);
    const result = await commitAs(fix, fix.engineer.id, { outcome: 'blocked', blocker: '在等约定确认', summary: '等确认' });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(theJob(fix)).toMatchObject({ state: 'doing', blocked: null, pause: { executorWaiting: true } });
    expect(expectedActorOf(theJob(fix))).toBeNull();
  });
});

describe('从不发出信号、一直交账 progress', () => {
  it('续排到回合上限；条目正文的「现在卡在」写约定第 2 版在等你确认', async () => {
    const { fix, job } = await pendingReopen();
    for (let i = 0; i < 150 && theJob(fix).state !== 'blocked'; i += 1) {
      if (runningOf(fix, fix.engineer.id)) await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '继续做照常的部分' });
      await tick(fix, 10 * MINUTE);
    }
    expect(theJob(fix)).toMatchObject({ state: 'blocked', blocked: { kind: 'turn_cap' } });
    // P76f：条目是预计消耗条目（事项键 job:<id>:cap:...）；执行者一直做到预算线之前，已经因「将超出预计」问过一次（不停），
    // 到预算线时不再另建，所以这一条是在执行多用时建的，正文没有「目前停在」一行。
    const items = fix.ctx.store.table('inbox').list(row => row.subjectKey.startsWith(`job:${job.id}:cap:`));
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toBe('会员定价页：消耗将超出预计');
    expect(entriesOf(fix, fix.engineer.id, job.id)).toHaveLength(0);
  });
});

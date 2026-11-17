/**
 * P74r14 第 1、2 节的测试：总管向主人说明之后怎样交账；这次说明有了结果之后清掉总管因它写下的受阻状态。
 *
 * 覆盖：
 * 1 escalate 成功的返回文字逐字带交账提示；守则里讲 escalate 的做法说明加了半句；只用唤醒包文字：escalate 加 blocked 交账都成功；
 * 2 主人选了办法之后总管的状态不再是受阻；两件事都在等、只选其中一件仍是受阻；说明失效（约定更新）同样清掉；
 *   总管的受阻不是做一件事的回合写下的时不动。
 * 全部走真实的 Hub，时间用注入的假时钟。
 */
import { describe, expect, it } from 'vitest';
import { invalidateOpenEscalation } from '../src/job/escalation-expiry.js';
import { CHIEF_RULES_TEXT } from '../src/wake/chief-packet.js';
import { commitAndEnd } from './p74c-fixtures.js';
import { MINUTE, bot, callTool, limitFix, nextPacket, sectionOf, theJob, type JobFix } from './p74f2-fixtures.js';

const HINT = '这一回合交账时 outcome 写 blocked（这件事在等主人选办法），不要写 needs_owner，不要带 ownerQuestion。';
const A = { title: '放宽这一条', detail: '改成有提示或备用文案都算做完；代价是提示可以简单一些', change: { no: 3, text: '接口失败时页面有提示或有备用文案' } };
const B = { title: '换一位执行者再试', detail: '换人重做这一条；代价是多花一轮时间' };

/** 总管只用唤醒包文字调用 escalate，再以 blocked 交账（不是 progress）。返回 escalate 的结果。 */
async function escalateThenBlocked(fix: JobFix) {
  const text = sectionOf(await nextPacket(fix, fix.chief.id));
  const jobId = /写说明：调用 hub_job_manage，mode 写 escalate，jobId 写 (job_[0-9a-z]{10})/.exec(text)?.[1];
  expect(jobId, '包里应该有「写说明」的做法').toBeDefined();
  const result = await callTool(fix, bot(fix, fix.chief.id), 'hub_job_manage', {
    mode: 'escalate', jobId, stuckAt: '接口失败时的提示，页面一直做不到让人看得懂', options: [A, B], suggested: 0, reason: '最小的改动，其余条目不受影响' });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  await commitAndEnd(fix, fix.chief.id, { outcome: 'blocked', blocker: '这件事在等你选办法', summary: '已把办法交给主人' });
  return { result, jobId: jobId! };
}

describe('1 说明之后怎样交账', () => {
  it('escalate 成功的返回文字逐字带交账提示；按提示用 blocked 交账成功', async () => {
    const { fix } = await limitFix();
    const { result } = await escalateThenBlocked(fix);
    expect(result).toEqual({ ok: true, text: `已把卡在哪和办法交给主人。${HINT}` });
    expect(bot(fix, fix.chief.id).activity).toBe('blocked');
  });

  it('守则里讲 escalate 的那一段加了「说明之后交账写 blocked，不写 needs_owner」', () => {
    expect(CHIEF_RULES_TEXT).toContain('用 mode escalate 交给主人决定，不要用 ownerQuestion；说明之后交账写 blocked，不写 needs_owner。');
  });
});

describe('2 说明有了结果之后清掉总管的受阻状态', () => {
  it('主人选了办法：总管的状态不再是受阻，文字与正常做完一个回合之后相同', async () => {
    const { fix, job } = await limitFix();
    await escalateThenBlocked(fix);
    expect(bot(fix, fix.chief.id)).toMatchObject({ activity: 'blocked' });
    expect(bot(fix, fix.chief.id).activityText).toContain('受阻');
    expect(await fix.hub.api.chooseJobOption({ jobId: job.id, stage: 1, option: 0 })).toMatchObject({ ok: true });
    expect(bot(fix, fix.chief.id)).toMatchObject({ activity: 'watching', activityText: '继续关注变化' });
  });

  it('两件事都在等主人选办法、只选了其中一件：总管仍是受阻', async () => {
    const { fix, job } = await limitFix();
    await escalateThenBlocked(fix);
    // 总管名下另有一件事也在等主人选办法（照这件事的记录复制一条，换编号和约定）。
    const other = { ...theJob(fix), id: 'job_r14second1', agreementId: 'agr_r14second1' };
    fix.ctx.store.table('jobs').put(other);
    expect(await fix.hub.api.chooseJobOption({ jobId: job.id, stage: 1, option: 0 })).toMatchObject({ ok: true });
    expect(bot(fix, fix.chief.id).activity).toBe('blocked');
  });

  it('说明失效（约定更新）：同样清掉', async () => {
    const { fix, job } = await limitFix();
    await escalateThenBlocked(fix);
    expect(bot(fix, fix.chief.id).activity).toBe('blocked');
    expect(invalidateOpenEscalation(fix.ctx, job.id, 'updated')).toBe(true);
    expect(bot(fix, fix.chief.id)).toMatchObject({ activity: 'watching', activityText: '继续关注变化' });
  });

  it('反例：总管的受阻不是做一件事的回合写下的（没有带这件事编号的 blocked 交账）时不动', async () => {
    const { fix, job } = await limitFix();
    await escalateThenBlocked(fix);
    // 把最近那次交账的唤醒单改成不带 jobId，等价于总管自己别的原因受阻。
    for (const wake of fix.ctx.store.table('wakes').list(row => row.botId === fix.chief.id && Boolean(row.commitId))) {
      fix.ctx.store.table('wakes').patch(wake.id, { jobId: null });
    }
    expect(invalidateOpenEscalation(fix.ctx, job.id, 'updated')).toBe(true);
    expect(bot(fix, fix.chief.id).activity).toBe('blocked');
    void MINUTE;
  });
});

/**
 * P76r3 的测试（二）：预算线与预计同步（审查 R3）、「将超出预计」的原因行（R7）、
 * 补建条目时的第一句（R10 第 5 点）。
 *
 * 每条路径走完都断言不变量：latestEstimate().total − 对齐的回合数 == job.turnCap。
 * 额度灯都是绿；预算线、已用回合在每条用例里写明。
 */
import { describe, expect, it } from 'vitest';
import { repairCapStop } from '../src/job/budget-ask.js';
import { budgetBody } from '../src/job/budget-text.js';
import { overrunReasons } from '../src/job/budget.js';
import { latestEstimate } from '../src/job/estimate.js';
import type { JobUsage } from '../src/model/budget.js';
import { askedNotReached, chiefSaid, commitAndEnd, nextPacket, openCap, reachedAfterAsked, reachedUnasked, theJob, callTool, bot } from './p76f-fixtures.js';
import { sweepNow } from './p76g-fixtures.js';
import { ownerSays } from './p74b-fixtures.js';
import { flushJobHooks } from '../src/job/agreement-hooks.js';
import { escalateSubjectKey } from '../src/job/escalate.js';
import { sectionOf } from './p74d-fixtures.js';
import { started, type JobFix } from './p74d-fixtures.js';

/** 不变量：预计总数 − 对齐的回合数 == 预算线。返回新的预计总数。 */
function invariants(fix: JobFix, jobId: string): number {
  const job = theJob(fix);
  const estimate = latestEstimate(fix.ctx, job.agreementId);
  expect(estimate, '这件事应该有预计').not.toBeNull();
  const usage = fix.ctx.store.table('jobUsage').get(jobId);
  expect(usage, '这件事应该有用量行').not.toBeNull();
  expect(estimate!.total - usage!.steps.align.turns, '预计总数 − 对齐 == 预算线').toBe(job.turnCap);
  return estimate!.total;
}

/** 一步：选「缩小范围」，总管拿回合、提交新版本。返回约定编号。 */
async function narrowAndSubmit(fix: JobFix, jobId: string): Promise<string> {
  expect(await fix.hub.api.answerJobCap({ jobId, answer: '缩小范围' })).toMatchObject({ ok: true });
  const text = sectionOf(await nextPacket(fix, fix.chief.id));
  const agreementId = /agreementId 写 (agr_[0-9a-z]{10})/.exec(text)![1]!;
  const listed = [...text.slice(text.indexOf('主人选了缩小范围。约定里还没通过的条目：')).matchAll(/^doneWhen (\d+)\. (.+)$/gm)]
    .map(match => ({ no: Number(match[1]), text: match[2]! }));
  expect(await callTool(fix, bot(fix, fix.chief.id), 'hub_agreement_submit', {
    mode: 'revise', agreementId, changeNote: '放宽第 3 条的要求，先把能用的部分做完',
    doneWhen: listed.map(row => (row.no === 3 ? '价格页能正常打开，三档价格都显示' : row.text)),
    continuing: ['第 1、2 条对应的工作'], paused: ['第 3 条对应的工作'],
  })).toMatchObject({ ok: true });
  await commitAndEnd(fix, fix.chief.id, { outcome: 'progress', summary: '已拟好新版本' });
  return agreementId;
}

describe('1 R3：抬高预算线的每条路径同时追加预计', () => {
  it('答复「追加 n 个回合」：预算线与预计一起加；不变量成立，之后到预算线时文字里的预计是新数', async () => {
    const { fix, job } = await askedNotReached();
    const cap = openCap(fix, job.id)!;
    expect(await fix.hub.api.answerJobCap({ jobId: job.id, answer: cap.options[0]! })).toMatchObject({ ok: true });
    const total = invariants(fix, job.id);
    expect(theJob(fix).turnCap).toBe(10);
    expect(total).toBe(11);
    // 真实流程里追加之后，下一轮巡检会按新的预计再问一次「将超出预计」（这件事不停）；这里先让它出现。
    sweepNow(fix);
    expect(openCap(fix, job.id)).toBeDefined();
    // 接着到新的预算线（把已用回合记为预算线，模拟执行者用满）：条目与私聊里的预计是新数。
    fix.ctx.store.table('jobs').patch(job.id, { turnsUsed: theJob(fix).turnCap });
    sweepNow(fix);
    expect(theJob(fix)).toMatchObject({ state: 'blocked', blocked: { kind: 'turn_cap' }, turnCap: 10 });
    expect(openCap(fix, job.id)!.body).toContain('预计 11');
    expect(chiefSaid(fix).at(-1)).toBe('会员定价页已用到预计的 11 回合，超出的部分已停下，在等你决定。');
    invariants(fix, job.id);
  });

  it('答复「缩小范围」：预算线加 1，总管预留也加 1；确认新版本后剩余为 0 再加 2，不变量仍成立', async () => {
    const { fix, job } = await reachedAfterAsked();
    let total = invariants(fix, job.id); // 答复前：9 − 1 = 8
    const agreementId = await narrowAndSubmit(fix, job.id);
    // 缩小范围那一刻：预算线 9，预计总数 10。
    total = invariants(fix, job.id);
    expect(theJob(fix).turnCap).toBe(9);
    expect(total).toBe(10);
    // 确认新版本：剩余回合为 0，追加 2 个；预计也加 2。
    expect(await fix.hub.api.confirmAgreement({ agreementId, version: 2 })).toMatchObject({ ok: true });
    await flushJobHooks(fix.ctx);
    const again = invariants(fix, job.id);
    expect(theJob(fix).turnCap).toBe(11);
    expect(again).toBe(12);
  });

  it('恢复（resume）：回合已用完的追加 8 个，预计也加 8', async () => {
    const s = await started();
    const { fix, job } = s;
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '先到这里' });
    for (const entry of fix.ctx.store.table('queue').list(row => row.jobId === job.id)) fix.ctx.store.table('queue').remove(entry.id);
    // 构造「你让先停下」：已用 8 = 预算线 8。
    fix.ctx.store.table('jobs').put({ ...theJob(fix), state: 'blocked', turnsUsed: 8,
      blocked: { kind: 'owner_hold', no: null, text: '已用到预计消耗', since: fix.ctx.clock.now(), resumeTo: 'doing' } });
    await ownerSays(fix, fix.chief.id, '接着做吧');
    await nextPacket(fix, fix.chief.id);
    expect(await callTool(fix, bot(fix, fix.chief.id), 'hub_job_manage', { mode: 'resume', jobId: job.id })).toMatchObject({ ok: true });
    expect(theJob(fix).turnCap).toBe(16);
    expect(invariants(fix, job.id)).toBe(17);
  });

  it('选办法时回合已用完：自动追加 8 个，预计也加 8', async () => {
    const s = await started();
    const { fix, job } = s;
    const now = fix.ctx.clock.now();
    // 构造一份「执行者做不下去」的说明卡，并把这件事的已用回合记为预算线。
    fix.ctx.store.table('inbox').put({ id: 'i_escalate01', botId: fix.chief.id, type: 'question', title: '会员定价页：说明', body: '卡在哪',
      options: ['先放一放', '换个做法'], defaultOption: null, priority: 'P1', status: 'open', answer: null, refId: job.id,
      subjectKey: escalateSubjectKey(job.id, 1), pushed: false, createdAt: now, expiresAt: null, answeredAt: null });
    fix.ctx.store.table('jobs').put({ ...theJob(fix), state: 'blocked', turnsUsed: 8, inboxId: 'i_escalate01',
      blocked: { kind: 'executor', no: null, text: '执行者做不下去', since: now, resumeTo: 'doing' },
      escalation: { stage: 1, rev: 0, blockedSince: now, versionNo: 1, kind: 'executor', stuckAt: '缺报价接口的文档', no: null, noText: null,
        options: [
          { title: '先放一放', detail: '等文档到了再做；代价是交付时间会晚', change: null, followUp: false },
          { title: '换个做法', detail: '先用假数据把页面做完；代价是价格不是真的', change: null, followUp: false },
        ], suggested: 0, reason: '缺文档', tried: ['查了仓库'], at: now, chosen: null, chosenAt: null } });
    expect(await fix.hub.api.chooseJobOption({ jobId: job.id, stage: 1, option: 0 })).toMatchObject({ ok: true });
    expect(theJob(fix).turnCap).toBe(16);
    expect(invariants(fix, job.id)).toBe(17);
  });
});

describe('2 R7：「将超出预计」的原因行', () => {
  const usage = (steps: Partial<Record<keyof JobUsage['steps'], number>>): Pick<JobUsage, 'steps'> => ({
    steps: {
      align: { turns: 1, tokens: 0 }, exec: { turns: steps.exec ?? 0, tokens: 0 }, review: { turns: steps.review ?? 0, tokens: 0 },
      rework: { turns: steps.rework ?? 0, tokens: 0 }, chief: { turns: steps.chief ?? 0, tokens: 0 }, launch: { turns: 0, tokens: 0 },
    },
  });
  const estimate = { steps: { align: 1, exec: 3, review: 1, rework: 3, chief: 1 } };

  it('执行已用满预计、仍在执行中且没有待改的条目：写「执行已用满预计的 3 回合，还没有交回」', () => {
    expect(overrunReasons(usage({ exec: 3 }), estimate, { state: 'doing', unmet: [] })).toEqual(['执行已用满预计的 3 回合，还没有交回']);
    // 反例：有待改的条目（在返工）或不在执行中时，不写这一句（P84 K7：有待改条目的执行中改写「返工已用 0 回合，还没有交回」）。
    expect(overrunReasons(usage({ exec: 3 }), estimate, { state: 'doing', unmet: [{ no: 1 } as never] })).toEqual([]); // 主会话裁定：返工已用 0 回合时不写，原因为空，由兜底句接手
    expect(overrunReasons(usage({ exec: 3, rework: 1 }), estimate, { state: 'doing', unmet: [{ no: 1 } as never] })).toEqual(['返工已用 1 回合，还没有交回']);
    expect(overrunReasons(usage({ exec: 3 }), estimate, { state: 'checking', unmet: [] })).toEqual([]);
  });

  it('核对已用满预计、仍在核对中：写「核对已用满预计的 1 回合，还没有结论」', () => {
    expect(overrunReasons(usage({ exec: 3, review: 1 }), estimate, { state: 'checking', unmet: [] })).toEqual(['核对已用满预计的 1 回合，还没有结论']);
    expect(overrunReasons(usage({ exec: 3, review: 2 }), estimate, { state: 'checking', unmet: [] })).toEqual(['核对 2 轮']);
  });

  it('「已用到预计的回合数。」只在已经到预算线、别的原因都不成立时才写', () => {
    const base = { usedAll: 4, total: 9, needAll: 10, reasons: [] as string[], n: 2, tokenLow: 1, tokenHigh: 2 };
    expect(budgetBody({ ...base, reason: 'reached' }).split('\n')[1]).toBe('已用到预计的回合数。');
    // 「将超出预计」而原因没有列出来（理论上不会发生）：不把「已用到」提前说出来。
    expect(budgetBody({ ...base, reason: 'projected' }).split('\n')[1]).toBe('按现在的进度，做完还需要的回合超过了预计。'); // P84（K7）：兜底句改成书面写法
    expect(budgetBody({ ...base, reason: 'projected', reasons: ['执行已用满预计的 3 回合，还没有交回'] }).split('\n')[1])
      .toBe('超出的部分：执行已用满预计的 3 回合，还没有交回。');
  });
});

describe('3 R10 第 5 点：补建条目时的第一句', () => {
  it('之前告诉过主人「已停下」（问过这个预算线）：用带「仍」的那一句', async () => {
    const { fix, job } = await reachedUnasked();
    const item = openCap(fix, job.id)!;
    // 构造：条目被别的条目顶替撤回（原来问过这个预算线）。
    fix.ctx.store.table('inbox').patch(item.id, { status: 'withdrawn' });
    fix.ctx.store.table('jobs').patch(job.id, { inboxId: null });
    expect(repairCapStop(fix.ctx, job.id)).toBe(true);
    expect(chiefSaid(fix).at(-1)).toBe('会员定价页仍停在预计的 9 回合上，在等你决定。');
  });
});

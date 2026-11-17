/**
 * P74r3 的测试（二）：这件事受阻期间固定了新版本，按「解除受阻后要回到的环节」处理（复验报告 H2）。
 *
 * 场景：林舟交回第 1 轮（核对中），评审甲被停用（或核对人两次没有动静），这件事转受阻；主人让总管改「怎样算做完」，
 * 主人确认新版本。裁定：收尾按这件事「实际所处的环节」处理，受阻时取解除后要回到的状态：
 * - 回到核对中、有新增或改写的条目：把解除后要回到的状态改为返工中，仍然受阻、受阻原因不变；解除之后进入返工，叫醒执行者；
 * - 回到核对中、只有删去：现在就由中心重排最近一次交回，解除后核对人按新编号核对；
 * - 回到返工中：待改清单换算并加入新增、改写的条目；
 * - 回到待开工、执行中：与不受阻时相同。
 * 解除受阻的每条现有路径（恢复在岗、换核对人、回答）之后，被叫醒的人与这件事所处的环节一致。
 * 全部走真实 Hub，时间每次推进不超过 10 分钟；断言要证明的机制不依赖额度灯。
 */
import { describe, expect, it } from 'vitest';
import { lifecycleAction } from '../src/api/bots.js';
import { flushJobHooks } from '../src/job/agreement-hooks.js';
import { blockExecutor } from '../src/job/stuck.js';
import { isCenterRemapped } from '../src/job/item-remap.js';
import { latestSubmission } from '../src/job/store.js';
import { effectiveStateOf, reviewStalled, reworkForVersion } from '../src/job/version-stage.js';
import type { Job } from '../src/model/job.js';
import { agreementIdIn } from './p73d-fixtures.js';
import { assignArgs, commitAndEnd, runningOf, wakesOf } from './p74c-fixtures.js';
import { chiefDrafts, ownerSays, speak } from './p74b-fixtures.js';
import {
  MINUTE, bot, callTool, engineerSubmits, entriesOf, executorInfo, jobFix, lastPacket, metWithImage, nextPacket, putStandardFiles, reviewerInfo,
  reviewerThoughtRecently, sectionOf, started, theJob, tick, type JobFix,
} from './p74d-fixtures.js';
import { idsIn, reviseArgs } from './p74r2b-fixtures.js';

/** 约定第 1 版的三条：与夹具一致。 */
const T1 = '打开页面能看到今天的报价';
const T2 = '点刷新后数据更新';
const T3 = '接口失败时有提示';
const T3_NEW = '接口失败时提示失败原因';
const T4 = '能导出表格';

/** 按指定的「怎样算做完」派活（第 1 条交付时核对），林舟拿到第一个回合，文件已放好（与 p74r2c 同一做法）。 */
async function startedWith(doneWhen: string[]) {
  const fix = await jobFix();
  await chiefDrafts(fix as never, { title: '会员定价页', doneWhen });
  await speak(fix, fix.chief, '这件事有 2 项需要你定。确认前不会开工。', { outcome: 'needs_owner' });
  await ownerSays(fix, fix.chief.id, '定了');
  const agreementId = agreementIdIn(lastPacket(fix, bot(fix, fix.chief.id)));
  expect(await callTool(fix, fix.chief, 'hub_job_manage', assignArgs(agreementId, { deliveryItems: [1] }))).toMatchObject({ ok: true });
  await speak(fix, fix.chief, '这件事由林舟执行，评审甲核对。', { outcome: 'progress' });
  await tick(fix, 10 * MINUTE);
  reviewerThoughtRecently(fix);
  const info = executorInfo(lastPacket(fix, bot(fix, fix.engineer.id)));
  await putStandardFiles(fix, info);
  return { fix, job: theJob(fix), info };
}

/** 总管结束当前回合（有回合开着才结束）。 */
async function chiefEndsTurn(fix: JobFix): Promise<void> {
  if (runningOf(fix, fix.chief.id)) await commitAndEnd(fix, fix.chief.id, { outcome: 'progress', summary: '已处理' });
}

/** 主人发话，总管 revise 出第 2 版并交账（等确认），主人确认，收尾做完。extra 覆盖 revise 的参数。 */
async function reviseAndConfirm(fix: JobFix, extra: Record<string, unknown>): Promise<void> {
  await chiefEndsTurn(fix);
  await ownerSays(fix, fix.chief.id, '验收条目要调整一下');
  const ids = idsIn(lastPacket(fix, bot(fix, fix.chief.id)));
  const result = await callTool(fix, bot(fix, fix.chief.id), 'hub_agreement_submit', reviseArgs(ids.agreementId, extra));
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  await speak(fix, bot(fix, fix.chief.id), '已请主人确认。', { outcome: 'needs_owner' });
  expect(await fix.hub.api.confirmAgreement({ agreementId: ids.agreementId, version: 2 })).toMatchObject({ ok: true });
  await flushJobHooks(fix.ctx);
  await tick(fix, 5 * MINUTE);
  await chiefEndsTurn(fix);
}

/** 该员工（含候选）与这件事有关的回合数：已有的唤醒单加排着的候选。 */
function touches(fix: JobFix, botId: string, jobId: string): number {
  return wakesOf(fix, botId, jobId).length + entriesOf(fix, botId, jobId).length;
}

/** 林舟三条都附证据交回第 1 轮（没有交付时核对的条目）并结束回合，评审甲随后被停用：这件事转受阻（核对中）。 */
async function reviewerOffInChecking() {
  const s = await started([], { deliveryItems: [] });
  await engineerSubmits(s.fix, s.info);
  await commitAndEnd(s.fix, s.fix.engineer.id, { outcome: 'progress', summary: '已交回' });
  await lifecycleAction(s.fix.ctx, { botId: s.fix.reviewer.id, action: 'suspend' });
  expect(theJob(s.fix)).toMatchObject({ state: 'blocked', blocked: { kind: 'participant_off', resumeTo: 'checking' } });
  return s;
}

/** 林舟只交第 3 条（页面空白）之外的返工：评审甲核对第 1 轮，第 3 条不符，转返工中；林舟的返工回合已结束。 */
async function inRework() {
  const s = await started([], { deliveryItems: [] });
  await engineerSubmits(s.fix, s.info);
  await commitAndEnd(s.fix, s.fix.engineer.id, { outcome: 'progress', summary: '已交回' });
  const seen = reviewerInfo(await nextPacket(s.fix, s.fix.reviewer.id));
  const reviewed = await callTool(s.fix, bot(s.fix, s.fix.reviewer.id), 'hub_job_work', { mode: 'review', jobId: seen.jobId, items: [
    { no: 1, verdict: 'met', note: '看得到报价', rechecked: true }, { no: 2, verdict: 'met', note: '截图无问题', rechecked: true },
    { no: 3, verdict: 'unmet', note: '接口失败时页面空白', fixTo: '接口失败时显示提示' }] });
  expect(reviewed, JSON.stringify(reviewed)).toMatchObject({ ok: true });
  await commitAndEnd(s.fix, s.fix.reviewer.id, { outcome: 'progress', summary: '核对了' }).catch(() => undefined);
  expect(theJob(s.fix)).toMatchObject({ state: 'rework', unmet: [{ no: 3 }] });
  await nextPacket(s.fix, s.fix.engineer.id);
  await commitAndEnd(s.fix, s.fix.engineer.id, { outcome: 'progress', summary: '继续做' });
  return s;
}

/** 林舟只交返工的那几条（其余沿用）。 */
function reworkSubmit(fix: JobFix, jobId: string, nos: number[], changeNote: string) {
  return callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', {
    mode: 'submit', jobId, changeNote, deliverables: ['交付/报价页.html'], items: nos.map(no => metWithImage(no, '证据/桌面.png')) });
}

describe('H2：核对中受阻，固定改写条目的新版本', () => {
  it('评审甲停用、改写第 3 条、确认第 2 版：仍然受阻、解除后回到返工中、待改清单是第 3 条；评审甲恢复在岗后是返工中，林舟被叫醒，评审甲没有新回合；林舟只交第 3 条后评审甲按新版本核对，最近一次交回是第 2 版', async () => {
    const { fix, job, info } = await reviewerOffInChecking();
    await reviseAndConfirm(fix, { changeNote: '失败提示要写原因', doneWhen: [T1, T2, T3_NEW] });
    // 固定后：仍然受阻，受阻原因不变；解除后回到返工中；待改清单是第 3 条；已处理到第 2 版。
    expect(theJob(fix)).toMatchObject({
      state: 'blocked', blocked: { kind: 'participant_off', resumeTo: 'rework' }, round: 0, stage: 2, handledVersionNo: 2, pause: null,
      unmet: [{ no: 3, problem: '约定第 2 版改了这一条', fixTo: T3_NEW }],
    });
    // 评审甲恢复在岗：这件事回到返工中，林舟被叫醒（不是评审甲）。
    const reviewerBefore = touches(fix, fix.reviewer.id, job.id);
    await lifecycleAction(fix.ctx, { botId: fix.reviewer.id, action: 'reinstate' });
    expect(theJob(fix)).toMatchObject({ state: 'rework', blocked: null, unmet: [{ no: 3 }] });
    const packet = await nextPacket(fix, fix.engineer.id);
    expect(sectionOf(packet)).toContain(`第 3 条：问题：约定第 2 版改了这一条；改到什么程度算过：${T3_NEW}。`);
    expect(executorInfo(packet).items[2]).toMatchObject({ no: 3, text: T3_NEW });
    expect(touches(fix, fix.reviewer.id, job.id)).toBe(reviewerBefore);
    // 林舟只交第 3 条，评审甲按新版本核对。
    const submitted = await reworkSubmit(fix, job.id, [3], '失败时写出原因');
    expect(submitted, JSON.stringify(submitted)).toMatchObject({ ok: true });
    expect(latestSubmission(fix.ctx, job.id)).toMatchObject({ versionNo: 2 });
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '已交回' });
    const seen = reviewerInfo(await nextPacket(fix, fix.reviewer.id));
    expect(seen.nos).toEqual([1, 2, 3]);
    expect(sectionOf(lastPacket(fix, bot(fix, fix.reviewer.id)))).toContain(`3. ${T3_NEW}`);
    const reviewed = await callTool(fix, bot(fix, fix.reviewer.id), 'hub_job_work', { mode: 'review', jobId: seen.jobId, items: [
      { no: 1, verdict: 'met', note: '沿用', rechecked: true }, { no: 2, verdict: 'met', note: '沿用', rechecked: true },
      { no: 3, verdict: 'met', note: '提示里有失败原因', rechecked: true }] });
    expect(reviewed, JSON.stringify(reviewed)).toMatchObject({ ok: true });
    expect(theJob(fix).state).toBe('awaiting_owner');
  });

  it('同样的开头，改用 reassign 换核对人解除：结果相同（返工中、待改第 3 条、林舟被叫醒），不叫新核对人', async () => {
    const { fix, job } = await reviewerOffInChecking();
    await reviseAndConfirm(fix, { changeNote: '失败提示要写原因', doneWhen: [T1, T2, T3_NEW] });
    expect(theJob(fix)).toMatchObject({ state: 'blocked', blocked: { resumeTo: 'rework' } });
    await ownerSays(fix, fix.chief.id, '评审甲不用等了，你自己核对');
    const result = await callTool(fix, bot(fix, fix.chief.id), 'hub_job_manage', { mode: 'reassign', jobId: job.id, reviewer: '总管' });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(theJob(fix)).toMatchObject({ state: 'rework', blocked: null, reviewerId: null, unmet: [{ no: 3, fixTo: T3_NEW }] });
    // 叫醒的是执行者（返工），不是新核对人（总管）。
    expect(entriesOf(fix, fix.engineer.id, job.id).length + wakesOf(fix, fix.engineer.id, job.id).length).toBeGreaterThan(1);
    const packet = await nextPacket(fix, fix.engineer.id);
    expect(sectionOf(packet)).toContain(`第 3 条：问题：约定第 2 版改了这一条；改到什么程度算过：${T3_NEW}。`);
  });

  it('核对人两次没有动静造成的受阻（受阻原因是执行者、回到核对中）：改写第 3 条并确认后仍卡在核对人；换核对人解除，结果相同；answer 仍被拒、文字不变', async () => {
    const s = await started([], { deliveryItems: [] });
    const { fix, job } = s;
    await engineerSubmits(fix, s.info);
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '已交回' });
    // 评审甲拿到回合却不核对；P76g：原来由巡检的兜底（叫满两次）把这件事转受阻，兜底已删除，直接用 blockExecutor 造出同样的受阻状态。
    await tick(fix, 10 * MINUTE);
    if (runningOf(fix, fix.reviewer.id)) await commitAndEnd(fix, fix.reviewer.id, { outcome: 'progress', summary: '还在看' });
    blockExecutor(fix.ctx, theJob(fix), '连续两次叫醒都没有进展', fix.ctx.clock.now(), 'hub', { idle: true }, fix.reviewer.id);
    expect(theJob(fix)).toMatchObject({ state: 'blocked', blocked: { kind: 'executor', resumeTo: 'checking' } });
    expect(reviewStalled(theJob(fix))).toBe(true);
    await reviseAndConfirm(fix, { changeNote: '失败提示要写原因', doneWhen: [T1, T2, T3_NEW] });
    const stalled = theJob(fix);
    expect(stalled).toMatchObject({ state: 'blocked', blocked: { kind: 'executor', resumeTo: 'rework', stalledAtReview: true }, unmet: [{ no: 3 }] });
    // 卡住的仍是核对人：总管 answer 被拒（文字不变），换核对人才能解除。
    await ownerSays(fix, fix.chief.id, '评审甲没反应，换你自己核对');
    const refused = await callTool(fix, bot(fix, fix.chief.id), 'hub_job_manage', { mode: 'answer', jobId: job.id, text: '好', basis: [{ section: 'scopeIn', no: 1 }] });
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain('这件事卡在核对环节，不是在等回答');
    const result = await callTool(fix, bot(fix, fix.chief.id), 'hub_job_manage', { mode: 'reassign', jobId: job.id, reviewer: '总管' });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(theJob(fix)).toMatchObject({ state: 'rework', blocked: null, unmet: [{ no: 3 }] });
    expect(sectionOf(await nextPacket(fix, fix.engineer.id))).toContain(`第 3 条：问题：约定第 2 版改了这一条；改到什么程度算过：${T3_NEW}。`);
  });
});

describe('H2：核对中受阻，固定只删条目的新版本', () => {
  it('评审甲停用、删去第 2 条、确认第 2 版：现在就有中心重排的交回记录；评审甲恢复在岗后核对人按新编号核对并通过', async () => {
    // 四条的约定（「怎样算做完」至少要三条，删去一条后还剩三条），第 1 条交付时核对。
    const s = await startedWith([T1, T2, T3, T4]);
    const { fix, job } = s;
    await engineerSubmits(fix, s.info);
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '已交回' });
    await lifecycleAction(fix.ctx, { botId: fix.reviewer.id, action: 'suspend' });
    const original = latestSubmission(fix.ctx, job.id)!;
    await reviseAndConfirm(fix, { changeNote: '去掉刷新那条', doneWhen: [T1, T3, T4], removals: [T2], deliveryItems: [1] });
    // 受阻没有变，解除后仍回核对中；重排的交回记录已经在（不等解除）。
    expect(theJob(fix)).toMatchObject({ state: 'blocked', blocked: { kind: 'participant_off', resumeTo: 'checking' }, round: 1, handledVersionNo: 2 });
    const remapped = latestSubmission(fix.ctx, job.id)!;
    expect(isCenterRemapped(remapped)).toBe(true);
    expect(remapped).toMatchObject({ remappedFrom: original.id, versionNo: 2 });
    expect(remapped.items.map(item => [item.no, item.text])).toEqual([[1, T1], [2, T3], [3, T4]]);
    // 评审甲恢复在岗：回到核对中，被叫醒，按新编号核对通过。
    await lifecycleAction(fix.ctx, { botId: fix.reviewer.id, action: 'reinstate' });
    expect(theJob(fix).state).toBe('checking');
    const seen = reviewerInfo(await nextPacket(fix, fix.reviewer.id));
    expect(seen.nos).toEqual([1, 2, 3]);
    const ok = await callTool(fix, bot(fix, fix.reviewer.id), 'hub_job_work', { mode: 'review', jobId: seen.jobId, items: [
      { no: 1, verdict: 'at_delivery' }, { no: 2, verdict: 'met', note: '失败时有提示', rechecked: true },
      { no: 3, verdict: 'met', note: '能导出', rechecked: true }] });
    expect(ok, JSON.stringify(ok)).toMatchObject({ ok: true });
    expect(theJob(fix)).toMatchObject({ state: 'awaiting_owner', round: 1 });
  });
});

describe('H2：返工中受阻、执行中受阻', () => {
  it('返工中评审甲停用（解除后回到返工中），在最前面插入一条：待改清单里原来的第 3 条换成第 4 条，新插入的第 1 条也在清单里；恢复在岗后林舟被叫醒', async () => {
    const { fix, job } = await inRework();
    await lifecycleAction(fix.ctx, { botId: fix.reviewer.id, action: 'suspend' });
    expect(theJob(fix)).toMatchObject({ state: 'blocked', blocked: { kind: 'participant_off', resumeTo: 'rework' } });
    await reviseAndConfirm(fix, { changeNote: '前面加载入提示', doneWhen: ['加载时有提示', T1, T2, T3] });
    expect(theJob(fix)).toMatchObject({ state: 'blocked', blocked: { resumeTo: 'rework' } });
    expect(theJob(fix).unmet).toEqual([
      { no: 1, problem: '约定第 2 版改了这一条', fixTo: '加载时有提示' },
      { no: 4, problem: '接口失败时页面空白', fixTo: '接口失败时显示提示' },
    ]);
    await lifecycleAction(fix.ctx, { botId: fix.reviewer.id, action: 'reinstate' });
    expect(theJob(fix).state).toBe('rework');
    const text = sectionOf(await nextPacket(fix, fix.engineer.id));
    expect(text).toContain('第 4 条：问题：接口失败时页面空白；改到什么程度算过：接口失败时显示提示。');
    expect(text).toContain('第 1 条：问题：约定第 2 版改了这一条；改到什么程度算过：加载时有提示。');
    expect(theJob(fix).id).toBe(job.id);
  });

  it('执行中林舟做不下去而受阻，固定新版本，总管回答后解除：林舟被叫醒，唤醒包里是新版本的条目', async () => {
    const { fix, job } = await started([], { deliveryItems: [] });
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'blocked', summary: '做不下去', blocker: '报价接口一直不通' });
    expect(theJob(fix)).toMatchObject({ state: 'blocked', blocked: { kind: 'executor', resumeTo: 'doing' } });
    await reviseAndConfirm(fix, { changeNote: '失败提示要写原因', doneWhen: [T1, T2, T3_NEW] });
    // 解除后回到的仍是执行中；不用待改清单（第一轮本来就要全部交回）。
    expect(theJob(fix)).toMatchObject({ state: 'blocked', blocked: { kind: 'executor', resumeTo: 'doing' }, unmet: [], handledVersionNo: 2 });
    await ownerSays(fix, fix.chief.id, '接口的事你按约定回答他');
    const answered = await callTool(fix, bot(fix, fix.chief.id), 'hub_job_manage', {
      mode: 'answer', jobId: job.id, to: '林舟', text: '先用假数据把页面做完。', basis: [{ section: 'scopeIn', no: 1 }] });
    expect(answered, JSON.stringify(answered)).toMatchObject({ ok: true });
    expect(theJob(fix).state).toBe('doing');
    const packet = await nextPacket(fix, fix.engineer.id);
    const info = executorInfo(packet);
    expect(info.items.map(item => item.text)).toEqual([T1, T2, T3_NEW]);
  });
});

describe('纯函数：按环节处理（供 P74f 调用）', () => {
  const unmetNew = [{ no: 3, problem: '约定第 2 版改了这一条', fixTo: 'x' }];
  const baseJob = (patch: Partial<Job>): Job => ({
    id: 'job_aaaaaaaaaa', chiefId: 'b_aaaaaaaaaa', executorId: 'b_bbbbbbbbbb', reviewerId: 'b_cccccccccc', agreementId: 'agr_aaaaaaaaaa',
    projectId: 'prj_aaaaaaaaaa', topicId: 'top_aaaaaaaaaa', state: 'doing', stage: 1, round: 0, unmet: [], blocked: null, pause: null, openAsk: null,
    deliveryItems: [], turnsUsed: 0, turnCap: 20, ...patch } as unknown as Job);

  it('effectiveStateOf：不受阻取当前状态，受阻取解除后要回到的状态', () => {
    expect(effectiveStateOf({ state: 'checking', blocked: null })).toBe('checking');
    expect(effectiveStateOf({ state: 'blocked', blocked: { kind: 'participant_off', no: null, text: 'x', since: 1, resumeTo: 'rework' } })).toBe('rework');
  });

  it('reworkForVersion：各环节的处理方式；没有被改到的条目什么都不做', () => {
    const blocked = (resumeTo: 'ready' | 'doing' | 'checking' | 'rework', kind: 'participant_off' | 'executor' = 'participant_off') =>
      baseJob({ state: 'blocked', blocked: { kind, no: null, text: 'x', since: 1, resumeTo } });
    expect(reworkForVersion(baseJob({ state: 'checking', round: 1 }), unmetNew, 5)).toMatchObject({ how: 'now', job: { state: 'rework', round: 0, stage: 2 } });
    expect(reworkForVersion(blocked('checking'), unmetNew, 5)).toMatchObject({ how: 'after_unblock', job: { state: 'blocked', blocked: { resumeTo: 'rework' }, round: 0, stage: 2 } });
    expect(reworkForVersion(blocked('checking'), unmetNew, 5).job.blocked!.stalledAtReview).toBeUndefined();
    expect(reworkForVersion(blocked('checking', 'executor'), unmetNew, 5).job.blocked).toMatchObject({ resumeTo: 'rework', stalledAtReview: true });
    expect(reworkForVersion(blocked('rework'), unmetNew, 5)).toMatchObject({ how: 'merged', job: { unmet: unmetNew } });
    expect(reworkForVersion(blocked('doing'), unmetNew, 5).how).toBe('none');
    expect(reworkForVersion(baseJob({ state: 'doing' }), unmetNew, 5).how).toBe('none');
    expect(reworkForVersion(baseJob({ state: 'checking' }), [], 5).how).toBe('none');
  });
});

describe('没有受阻时行为不变', () => {
  it('核对中（评审甲在岗）改写第 3 条并确认：退回返工，林舟被叫醒（与以前相同）', async () => {
    const { fix, info } = await started([], { deliveryItems: [] });
    await engineerSubmits(fix, info);
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '已交回' });
    await reviseAndConfirm(fix, { changeNote: '失败提示要写原因', doneWhen: [T1, T2, T3_NEW] });
    expect(theJob(fix)).toMatchObject({ state: 'rework', blocked: null, unmet: [{ no: 3 }] });
    expect(sectionOf(await nextPacket(fix, fix.engineer.id))).toContain(`第 3 条：问题：约定第 2 版改了这一条；改到什么程度算过：${T3_NEW}。`);
  });
});

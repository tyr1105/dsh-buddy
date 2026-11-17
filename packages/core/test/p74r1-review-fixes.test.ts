/**
 * P74r1 的测试：修复第一次独立审查（P74a 至 P74c）发现的问题，每条裁定至少一个正例一个反例。
 * 全部走真实 Hub（真实的启动整理、真实的显著性数值），时间用注入的假时钟；不用人为调高分值的候选。
 *
 * 目录：
 *   R1 主人确认之前，总管不能用任何办法叫员工动手（hub_send、主题里的 @、同回合先叫后提交）
 *   R2 一件事不能无声无息地停下（回合上限与受阻叠加、兜底叫满）
 *   R3 改派之后的状态与返回文字相符
 *   R4 总管在执行链回合里可以改派
 *   R5 「你手上的事」段被截断时不能丢掉做法说明
 *   R6 兜底写给主人看的话要说对是谁
 *   R7 项目里有进行中的事时不能归档
 *   R8 原话文件的兜底说明；改派后退还回合时状态还原
 */
import { describe, expect, it } from 'vitest';
import { archiveProject } from '../src/project/service.js';
import { sweepJobs } from '../src/job/sweep.js';
import { blockForTurnCap } from '../src/job/cap.js';
import { createTicket } from '../src/wake/ticket.js';
import { refundJobTurn } from '../src/job/turns.js';
import { enqueueJobWake } from '../src/job/chain.js';
import { blockExecutor } from '../src/job/stuck.js';
import { applyJobAction } from '../src/job/state.js';
import { renderOwnerWordsFile } from '../src/job/files.js';
import { fitJobBody } from '../src/wake/job-section-fit.js';
import { byteLength } from '../src/util/text.js';
import { JOB_DEFAULTS } from '../src/config/defaults.js';
import { lastPacket } from './p63-topic-fixtures.js';
import { floors, newAgreementArgs, openTopic, queued, runningWake } from './p72b-fixtures.js';
import {
  MINUTE, assignArgs, callTool, chiefDrafts, jobFix, lockAgreement, ownerSays, speak, threadOf, type JobFix,
} from './p74b-fixtures.js';
import {
  assigned, bot, commitAndEnd, entriesOf, eventsOf, runningJob, runningOf, theJob, tick, topicMessages, wakesOf,
} from './p74c-fixtures.js';
import { advanceSweeping } from './p76g-fixtures.js';

/** 给主人看的文字里不许出现的内部名称。 */
const INTERNAL = /hub_|b_[0-9a-z]{10}|job_|agr_|jev_/;

/** 在「季度战役」项目里（全体员工都是成员）提交约定、主人点「定了」，返回约定。回合是主人「定了」叫醒总管的那一个，仍开着。 */
async function lockedInProject(fix: JobFix, title = '会员定价页') {
  await chiefDrafts(fix as never, { title, projectId: fix.project.id });
  await speak(fix, fix.chief, '这件事有 2 项需要你定。确认前不会开工。', { outcome: 'needs_owner' });
  await ownerSays(fix, fix.chief.id, '定了');
  const agreement = fix.ctx.store.table('agreements').list().find(row => row.title === title)!;
  expect(agreement.state).toBe('locked');
  return agreement;
}

/** 让这位员工拿到一个回合（最多试几次）。 */
async function untilRunning(fix: JobFix, botId: string, step = 5 * MINUTE): Promise<void> {
  for (let i = 0; i < 8 && !runningOf(fix, botId); i += 1) await tick(fix, step);
  expect(runningOf(fix, botId), '应该已经拿到一个回合').toBeDefined();
}

// ---------------------------------------------------------------------------
// R1
// ---------------------------------------------------------------------------

describe('R1 主人确认之前，总管不能用 hub_send 叫员工动手（审查发现 F1）', () => {
  it('复现：总管提交新约定（待确认）后，同一回合 hub_send 给没有在办的事的林舟被拒，林舟没有排上队、没有新增唤醒', async () => {
    const fix = await jobFix();
    await ownerSays(fix, fix.chief.id, '帮我做个会员定价页');
    expect(await callTool(fix, fix.chief, 'hub_agreement_submit', newAgreementArgs({ title: '会员定价页' }))).toMatchObject({ ok: true });
    const sent = await callTool(fix, fix.chief, 'hub_send', { to: '林舟', text: '会员定价页先按草图开始做' });
    expect(sent).toMatchObject({ ok: false, error: '约定「会员定价页」还在等主人确认，确认前不能叫员工动手。' });
    expect(entriesOf(fix, fix.engineer.id)).toHaveLength(0);
    expect(fix.ctx.store.table('mail').count()).toBe(0);
    for (let i = 0; i < 4; i += 1) await tick(fix, 30 * MINUTE);
    expect(wakesOf(fix, fix.engineer.id)).toHaveLength(0);
  });

  it('反例：约定固定之后、或者没有待确认约定时，同样的 hub_send 照常成功', async () => {
    const fix = await jobFix();
    await ownerSays(fix, fix.chief.id, '帮我做个会员定价页');
    const id = (await (async () => {
      expect(await callTool(fix, fix.chief, 'hub_agreement_submit', newAgreementArgs({ title: '会员定价页' }))).toMatchObject({ ok: true });
      return fix.ctx.store.table('agreements').list()[0]!.id;
    })());
    lockAgreement(fix.ctx, id);
    expect(await callTool(fix, fix.chief, 'hub_send', { to: '林舟', text: '有空看一下定价页' })).toMatchObject({ ok: true });
    expect(entriesOf(fix, fix.engineer.id)).toHaveLength(1);
  });

  it('第 2 点：已固定的约定因为改约定而重新确认（不是新约定）不拦 hub_send', async () => {
    const fix = await jobFix(['小周']);
    const agreement = await lockedInProject(fix);
    await speak(fix, fix.chief, '预计周五交付。', { outcome: 'progress' });
    fix.ctx.clock.advance(10 * MINUTE);
    await ownerSays(fix, fix.chief.id, '会员定价页的范围改一下');
    const revised = await callTool(fix, fix.chief, 'hub_agreement_submit', { agreementId: agreement.id, mode: 'revise', changeNote: '改交付', summary: '重新来过' });
    expect(revised, JSON.stringify(revised)).toMatchObject({ ok: true });
    expect(fix.ctx.store.table('agreements').get(agreement.id)!.state).toBe('pending');
    // 重新确认中的约定有过固定的版本，不算「新约定」：给没有在办的事的小周发小事消息照常成功。
    expect(await callTool(fix, fix.chief, 'hub_send', { to: '小周', text: '有空看一下' })).toMatchObject({ ok: true });
  });
});
// 组队卡待确认时 hub_send 被拒、卡处理后放行：夹具在 p73d 里，断言在 p73r3-review-fixes 的 S4（已恢复），这里不重复搭场景。

describe('R1 主题里的 @（审查发现 F2）', () => {
  it('复现：临时主题里提交约定，约定落到另一个主题；回到原主题 @ 林舟，不叫醒，之后一直没有新增唤醒；旁白一条', async () => {
    const fix = await jobFix();
    const topicId = await openTopic(fix as never, '先聊聊这件事');
    expect(await callTool(fix, fix.chief, 'hub_agreement_submit', newAgreementArgs({ title: '会员定价页' }))).toMatchObject({ ok: true });
    const agreement = fix.ctx.store.table('agreements').list()[0]!;
    expect(agreement.topicId).not.toBe(topicId);
    await speak(fix, fix.chief, '@林舟 你来做');
    expect(queued(fix.ctx, fix.engineer.id, topicId)).toBeUndefined();
    expect(runningWake(fix.ctx, fix.engineer.id)).toBeUndefined();
    expect(floors(fix.ctx, topicId).filter(row => row.kind === 'system' && row.text === '约定还没确认，这次没有叫 林舟。')).toHaveLength(1);
    for (let i = 0; i < 4; i += 1) await tick(fix, 30 * MINUTE);
    expect(wakesOf(fix, fix.engineer.id)).toHaveLength(0);
  });

  it('反例：没有待确认的新约定时，总管在主题里 @ 手上没有在办的事的林舟照常叫醒', async () => {
    const fix = await jobFix();
    const topicId = await openTopic(fix as never, '先聊聊这件事');
    await speak(fix, fix.chief, '@林舟 你看一下');
    expect(runningWake(fix.ctx, fix.engineer.id) ?? queued(fix.ctx, fix.engineer.id, topicId)).toMatchObject({ topicId });
  });
});

describe('R1 第 4 点：总管 @ 正在做某件事的员工', () => {
  it('在这件事的主题里 @ 执行者林舟不叫醒（旁白不含工具名）；同一句里 @ 手上没有在办的事的小周照常叫醒', async () => {
    const fix = await jobFix(['小周']);
    const agreement = await lockedInProject(fix);
    expect(await callTool(fix, fix.chief, 'hub_job_manage', assignArgs(agreement.id))).toMatchObject({ ok: true });
    await speak(fix, fix.chief, '这件事由林舟执行，评审甲核对。', { outcome: 'progress' });
    fix.ctx.clock.advance(10 * MINUTE);
    await ownerSays(fix, agreement.topicId, '你怎么看');
    fix.ctx.clock.advance(1_000);
    await fix.hub.tick();
    expect(runningWake(fix.ctx, fix.chief.id)).toMatchObject({ topicId: agreement.topicId });
    await speak(fix, fix.chief, '@林舟 @小周 你们各自看看');
    const notes = floors(fix.ctx, agreement.topicId).filter(row => row.kind === 'system' && row.text.includes('林舟正在做'));
    expect(notes).toHaveLength(1);
    expect(notes[0]!.text).toBe('林舟正在做「会员定价页」，这次没有直接叫他；这件事的往来请走这件事自己的流程。');
    expect(notes[0]!.text).not.toMatch(INTERNAL);
    // 林舟没有因为这个 @ 得到这个主题的回合；小周被叫醒（在跑或在队里）。
    expect(queued(fix.ctx, fix.engineer.id, agreement.topicId)).toBeUndefined();
    expect(runningWake(fix.ctx, fix.engineer.id)?.topicId ?? null).not.toBe(agreement.topicId);
    expect(runningWake(fix.ctx, fix.extras[0]!.id) ?? queued(fix.ctx, fix.extras[0]!.id, agreement.topicId)).toMatchObject({ topicId: agreement.topicId });
  });
});

describe('R1 第 3 点：同一回合先叫了员工、后提交新约定', () => {
  it('先 hub_send 叫了林舟，再提交新约定被拒，约定没有记下，总管私聊落一条旁白点名林舟', async () => {
    const fix = await jobFix();
    await ownerSays(fix, fix.chief.id, '帮我做个会员定价页');
    expect(await callTool(fix, fix.chief, 'hub_send', { to: '林舟', text: '先开始做定价页' })).toMatchObject({ ok: true });
    const result = await callTool(fix, fix.chief, 'hub_agreement_submit', newAgreementArgs({ title: '会员定价页' }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('已经叫员工动手');
    expect(fix.ctx.store.table('agreements').count()).toBe(0);
    const note = threadOf(fix.ctx, fix.chief.id).find(row => row.from === 'hub' && row.kind === 'system' && row.text.includes('已经叫员工动手'));
    expect(note?.text).toContain('林舟');
    expect(note?.text).toContain('先开始做定价页');
  });

  it('反例：本回合没有叫过员工，提交新约定照常成功，没有旁白', async () => {
    const fix = await jobFix();
    await ownerSays(fix, fix.chief.id, '帮我做个会员定价页');
    expect(await callTool(fix, fix.chief, 'hub_agreement_submit', newAgreementArgs({ title: '会员定价页' }))).toMatchObject({ ok: true });
    expect(threadOf(fix.ctx, fix.chief.id).some(row => row.text.includes('已经叫员工动手'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// R2
// ---------------------------------------------------------------------------

describe('R2 一件事不能无声无息地停下', () => {
  it('F3 复现：最后一个回合以「做不下去」结束，总管的说明唤醒被上限丢弃；「待你处理」里恰好一条回合上限条目，写明卡在哪里，之后不再产生新的回合', async () => {
    const fix = await jobFix();
    // P76e：派活的预算线按预计算（首次估计是 8）；这条证明的机制与线的取值无关，显式设回 16（条目文案里的 16、再给 8 个照旧）。
    const { job } = await runningJob(fix, { turnCap: 16 });
    fix.ctx.store.table('jobs').patch(job.id, { turnsUsed: job.turnCap });
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'no_change', summary: '没有进展', blocker: null });
    expect(theJob(fix)).toMatchObject({ state: 'blocked', blocked: { kind: 'executor' } });
    for (let i = 0; i < 12; i += 1) await tick(fix, 30 * MINUTE);
    const items = fix.ctx.store.table('inbox').list(row => row.subjectKey.startsWith(`job:${job.id}:`));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ botId: fix.chief.id, status: 'open', defaultOption: null, expiresAt: null, title: '会员定价页：已用到预计消耗',
      options: ['追加 2 个回合', '缩小范围', '暂停'], subjectKey: `job:${job.id}:cap:16` });
    // P76f：有预计的事，正文改为预计消耗的几行，「目前停在」仍在最后一行。
    expect(items[0]!.body.split('\n')[0]).toMatch(/^已用 \d+ 回合，预计 9，估计共需 \d+ 回合。$/);
    expect(items[0]!.body.split('\n').at(-1)).toBe('目前停在：没有进展');
    // 受阻原因保持（执行者做不下去），条目编号记在这件事上；没有新增回合。
    const after = theJob(fix);
    expect(after).toMatchObject({ state: 'blocked', blocked: { kind: 'executor', text: '没有进展' }, inboxId: items[0]!.id, turnsUsed: 16 });
    expect(wakesOf(fix, fix.chief.id, job.id).filter(row => !row.ownerInitiated)).toHaveLength(0);
    // 总管私聊落一句；再巡检不会重复建。
    expect(threadOf(fix.ctx, fix.chief.id).filter(row => row.from === fix.chief.id && row.text.includes('已用到预计的 9 回合'))).toHaveLength(1);
    sweepJobs(fix.ctx, fix.ctx.clock.now());
    expect(fix.ctx.store.table('inbox').list(row => row.subjectKey.startsWith(`job:${job.id}:`))).toHaveLength(1);
    expect(items[0]!.title + items[0]!.body).not.toMatch(INTERNAL);
  });

  it('反例：没有受阻原因的事（进行中）到上限，条目正文不带「现在卡在」；回合没用满的受阻事不建回合上限条目', async () => {
    const fix = await jobFix();
    const { job } = await assigned(fix, { turnCap: 16 }); // P76e：显式把预算线设回 16（见上一条的说明）
    fix.ctx.store.table('jobs').patch(job.id, { turnsUsed: job.turnCap });
    sweepJobs(fix.ctx, fix.ctx.clock.now());
    const item = fix.ctx.store.table('inbox').list(row => row.subjectKey === `job:${job.id}:cap:16`);
    expect(item).toHaveLength(1);
    // P76f：有预计的事，正文改为预计消耗的几行；仍然没有「目前停在」一行。
    expect(item[0]!.body.split('\n')[0]).toMatch(/^已用 \d+ 回合，预计 9，估计共需 \d+ 回合。$/);
    expect(item[0]!.body).not.toContain('目前停在');
    // 另一件事：受阻（执行者做不下去）但回合没用满，不建回合上限条目。
    const other = await jobFix();
    const running = await runningJob(other);
    await commitAndEnd(other, other.engineer.id, { outcome: 'no_change', summary: '没有进展', blocker: null });
    expect(blockForTurnCap(other.ctx, running.job.id, other.ctx.clock.now())).toBe(false);
    expect(other.ctx.store.table('inbox').list(row => row.subjectKey.startsWith(`job:${running.job.id}:cap`))).toHaveLength(0);
  });

  /** 一件因执行者做不下去而受阻的事，总管的说明唤醒被丢掉（模拟总管两次都没有处理）。 */
  async function stuckAndSilent(fix: JobFix) {
    const { job } = await runningJob(fix);
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'no_change', summary: '没有进展', blocker: null });
    const dropChief = () => { for (const entry of entriesOf(fix, fix.chief.id, job.id)) fix.ctx.store.table('queue').remove(entry.id); };
    dropChief();
    return { job, dropChief };
  }

  // P76g：原来两条测的是第三块兜底（叫满两次再建「没有进展」条目）。兜底已删除，改为本卡口径：
  // 已受阻、在等总管的事，2 小时没有记录重新唤醒总管一次，再过 1 小时仍没有记录才通知你；原意不变：不会无声停下、条目恰好一条、之后不重复。
  it('F8 复现：已受阻、在等总管的事，重新唤醒一次仍无进展：不再叫；「待你处理」恰好一条，总管私聊落一句，之后不再重复', async () => {
    const fix = await jobFix();
    const { job, dropChief } = await stuckAndSilent(fix);
    advanceSweeping(fix, 120 * MINUTE);
    expect(entriesOf(fix, fix.chief.id, job.id), '2 小时后重新唤醒总管一次').toHaveLength(1);
    // 之前没有条目。
    expect(fix.ctx.store.table('inbox').list(row => row.subjectKey.startsWith(`job:${job.id}:`))).toHaveLength(0);
    dropChief();
    advanceSweeping(fix, 60 * MINUTE);
    expect(entriesOf(fix, fix.chief.id, job.id)).toHaveLength(0);
    const items = fix.ctx.store.table('inbox').list(row => row.subjectKey.startsWith(`job:${job.id}:`));
    expect(items).toHaveLength(1);
    // 卡住的是总管，没有「换{名字}接手」这一项。
    expect(items[0]).toMatchObject({ botId: fix.chief.id, type: 'question', status: 'open', title: '会员定价页：没有进展', options: ['再提醒一次', '暂停'], defaultOption: null, expiresAt: null });
    expect(items[0]!.body.split('\n')[0]).toMatch(/^已 3 小时没有进展，停在执行这一步，在等总管。$/);
    expect(theJob(fix)).toMatchObject({ state: 'blocked', blocked: { kind: 'executor' }, inboxId: items[0]!.id });
    const said = threadOf(fix.ctx, fix.chief.id).filter(row => row.from === fix.chief.id && row.text.includes('没有进展'));
    expect(said).toHaveLength(1);
    expect(said[0]!.text.split('\n').at(-1)).toBe('之后 24 小时内，不会再因为会员定价页没有进展通知你；有新进展之后重新计时。');
    expect(items[0]!.title + items[0]!.body + said[0]!.text).not.toMatch(INTERNAL);
    // 之后每个巡检都不再叫，也不再建第二条。
    advanceSweeping(fix, 6 * 31 * MINUTE);
    expect(entriesOf(fix, fix.chief.id, job.id)).toHaveLength(0);
    expect(fix.ctx.store.table('inbox').list(row => row.subjectKey.startsWith(`job:${job.id}:`))).toHaveLength(1);
    expect(eventsOf(fix.ctx, job.id).filter(row => row.kind === 'resumed')).toHaveLength(1);
  });

  it('F8 反例：重新唤醒之后总管回应了一次（别的事件）：计时重新开始，不建条目', async () => {
    const fix = await jobFix();
    const { job, dropChief } = await stuckAndSilent(fix);
    advanceSweeping(fix, 120 * MINUTE);
    dropChief();
    advanceSweeping(fix, 10 * MINUTE);
    // 总管回应了一次（别的事件）：计时重新开始，再过 1 小时也不会通知。
    const { appendJobEvent } = await import('../src/job/store.js');
    appendJobEvent(fix.ctx, { jobId: job.id, actor: fix.chief.id, kind: 'answered', to: [fix.engineer.id], refId: null, data: { text: '先试试' } });
    advanceSweeping(fix, 60 * MINUTE);
    expect(fix.ctx.store.table('inbox').list(row => row.subjectKey.startsWith(`job:${job.id}:`))).toHaveLength(0);
    expect(entriesOf(fix, fix.chief.id, job.id)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// R3、R4
// ---------------------------------------------------------------------------

/** 执行者做不下去：林舟交账 no_change，这件事受阻（执行者）。 */
async function executorStuck(fix: JobFix) {
  const { job } = await runningJob(fix);
  await commitAndEnd(fix, fix.engineer.id, { outcome: 'no_change', summary: '没有进展', blocker: null });
  expect(theJob(fix)).toMatchObject({ state: 'blocked', blocked: { kind: 'executor', resumeTo: 'doing' } });
  return job;
}

/** 总管被执行链唤醒（escalate），回合开着。 */
async function chiefChainTurn(fix: JobFix, jobId: string): Promise<void> {
  await untilRunning(fix, fix.chief.id);
  expect(runningOf(fix, fix.chief.id)).toMatchObject({ jobId, ownerInitiated: false });
}

/** 总管结束当前回合，再让新执行者拿到回合；返回新执行者的唤醒单。 */
async function newcomerRuns(fix: JobFix, jobId: string, newcomerId: string) {
  await speak(fix, fix.chief, '已安排。', { outcome: 'progress' });
  for (let i = 0; i < 8 && wakesOf(fix, newcomerId, jobId).length === 0; i += 1) await tick(fix, 5 * MINUTE);
  const wakes = wakesOf(fix, newcomerId, jobId);
  expect(wakes.length, '新执行者应该真的被叫醒（闸门放行）').toBeGreaterThanOrEqual(1);
  return wakes[0]!;
}

describe('R3 改派之后的状态与返回文字相符（审查发现 F4）', () => {
  it('1 执行者做不下去：改派解除受阻，回到待开工；新执行者的唤醒入队并被放行，旧执行者与总管的候选都没有残留', async () => {
    const fix = await jobFix(['小周']);
    const job = await executorStuck(fix);
    await chiefChainTurn(fix, job.id);
    const result = await callTool(fix, fix.chief, 'hub_job_manage', { mode: 'reassign', jobId: job.id, executor: '小周' });
    expect(result).toEqual({ ok: true, text: '已改派给小周。' });
    const newcomer = fix.extras[0]!;
    expect(theJob(fix)).toMatchObject({ state: 'ready', blocked: null, executorId: newcomer.id, startedAt: null });
    expect(entriesOf(fix, newcomer.id, job.id)).toHaveLength(1);
    expect(entriesOf(fix, fix.engineer.id, job.id)).toHaveLength(0);
    expect(entriesOf(fix, fix.chief.id, job.id)).toHaveLength(0);
    const wake = await newcomerRuns(fix, job.id, newcomer.id);
    expect(wake).toMatchObject({ jobId: job.id, botId: newcomer.id });
    // 新执行者的第一个回合把待开工变成执行中。
    expect(theJob(fix).state).toBe('doing');
    expect(topicMessages(fix, job).filter(row => row.kind === 'work' && row.text === '总管把这件事改派给小周。')).toHaveLength(1);
  });

  it('1 返工中受阻的事改派：仍是返工中，要改的条目留给新执行者', async () => {
    const fix = await jobFix(['小周']);
    const { job } = await runningJob(fix);
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '先做着' });
    fix.ctx.store.table('jobs').put({ ...theJob(fix), state: 'blocked', blocked: { kind: 'executor', no: null, text: '做不下去', since: fix.ctx.clock.now(), resumeTo: 'rework' },
      unmet: [{ no: 2, problem: '价格没有分档', fixTo: '页面上能看到三档价格' }] });
    for (const entry of entriesOf(fix, fix.engineer.id, job.id)) fix.ctx.store.table('queue').remove(entry.id);
    await ownerSays(fix, fix.chief.id, '换小周做');
    const result = await callTool(fix, fix.chief, 'hub_job_manage', { mode: 'reassign', jobId: job.id, executor: '小周' });
    expect(result, JSON.stringify(result)).toEqual({ ok: true, text: '已改派给小周。' });
    expect(theJob(fix)).toMatchObject({ state: 'rework', blocked: null, unmet: [{ no: 2 }] });
    expect(entriesOf(fix, fix.extras[0]!.id, job.id)).toHaveLength(1);
  });

  it('3 有人停用而受阻：保持原做法，解除受阻，新执行者的唤醒入队并被放行', async () => {
    const fix = await jobFix(['小周']);
    const { job } = await assigned(fix);
    fix.ctx.store.table('jobs').put({ ...job, state: 'blocked', blocked: { kind: 'participant_off', no: null, text: '林舟已停用', since: fix.ctx.clock.now(), resumeTo: 'ready' } });
    expect(await callTool(fix, fix.chief, 'hub_job_manage', { mode: 'reassign', jobId: job.id, executor: '小周' })).toMatchObject({ ok: true });
    expect(theJob(fix)).toMatchObject({ state: 'ready', blocked: null });
    expect(entriesOf(fix, fix.extras[0]!.id, job.id)).toHaveLength(1);
    await speak(fix, fix.chief, '已改派给小周。', { outcome: 'progress' });
    for (let i = 0; i < 8 && wakesOf(fix, fix.extras[0]!.id, job.id).length === 0; i += 1) await tick(fix, 5 * MINUTE);
    expect(wakesOf(fix, fix.extras[0]!.id, job.id).length).toBeGreaterThanOrEqual(1);
  });

  it('2 回合上限而受阻的事改派被拒，文字说明要等主人的答复；状态、执行者、队列都不变', async () => {
    const fix = await jobFix(['小周']);
    const { job } = await runningJob(fix, { turnCap: 16 }); // P76e：显式把预算线设回 16（断言文案里的 16 个）
    fix.ctx.store.table('jobs').patch(job.id, { turnsUsed: job.turnCap });
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '还在做' });
    sweepJobs(fix.ctx, fix.ctx.clock.now());
    expect(theJob(fix)).toMatchObject({ state: 'blocked', blocked: { kind: 'turn_cap' } });
    await ownerSays(fix, fix.chief.id, '换小周做');
    const result = await callTool(fix, fix.chief, 'hub_job_manage', { mode: 'reassign', jobId: job.id, executor: '小周' });
    expect(result).toMatchObject({ ok: false, error: '这件事的回合已经用到上限（16 个），要等主人对回合上限的答复（再给回合或暂停）之后才能改派。' });
    expect(theJob(fix)).toMatchObject({ state: 'blocked', blocked: { kind: 'turn_cap' }, executorId: fix.engineer.id });
    expect(entriesOf(fix, fix.extras[0]!.id, job.id)).toHaveLength(0);
  });

  it('4 其他受阻原因逐种处理：主人选了先停下、核对三轮不过、卡在核对环节的执行者受阻，一律拒绝并说明；回合用满而没有受阻的事同样拒绝', async () => {
    const fix = await jobFix(['小周']);
    const { job } = await assigned(fix, { turnCap: 16 }); // P76e：显式把预算线设回 16（最后一例的文案里是 16 个）
    const since = fix.ctx.clock.now();
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['owner_hold', { state: 'blocked', blocked: { kind: 'owner_hold', no: null, text: '你已暂停', since, resumeTo: 'doing' } }, '主人已暂停，这件事暂时不再往下做，不能改派。'],
      ['review_limit', { state: 'blocked', blocked: { kind: 'review_limit', no: 2, text: '三轮不过', since, resumeTo: 'rework' } }, '这件事核对三轮仍未通过，要等主人选定办法之后才能改派。'],
      // P74r2a（任务卡第 3 条第 1 点）：拒绝文字改为只写现在能做的事（换核对人），不再写「不能改派」。
      ['executor+checking', { state: 'blocked', blocked: { kind: 'executor', no: null, text: '核对人没有动', since, resumeTo: 'checking' } }, '这件事卡在核对环节，换执行者解决不了。要换核对人，写 reviewer；写「总管」表示由你自己核对。'],
      ['回合用满、未受阻', { state: 'doing', turnsUsed: 16 }, '这件事的回合已经用到上限（16 个），要等主人对回合上限的答复（再给回合或暂停）之后才能改派。'],
    ];
    for (const [label, patch, expected] of cases) {
      fix.ctx.store.table('jobs').put({ ...job, ...patch } as never);
      const result = await callTool(fix, fix.chief, 'hub_job_manage', { mode: 'reassign', jobId: job.id, executor: '小周' });
      expect(result, label).toMatchObject({ ok: false, error: expected });
      expect(theJob(fix).executorId, label).toBe(fix.engineer.id);
      expect(entriesOf(fix, fix.extras[0]!.id, job.id), label).toHaveLength(0);
    }
  });
});

describe('R4 总管在执行链回合里可以改派（审查发现 F5）', () => {
  it('执行者做不下去，总管被执行链唤醒（不是主人发起）：改派成功', async () => {
    const fix = await jobFix(['小周']);
    const job = await executorStuck(fix);
    await chiefChainTurn(fix, job.id);
    expect(runningOf(fix, fix.chief.id)!.ownerInitiated).toBe(false);
    expect(await callTool(fix, fix.chief, 'hub_job_manage', { mode: 'reassign', jobId: job.id, executor: '小周' })).toEqual({ ok: true, text: '已改派给小周。' });
    expect(theJob(fix).executorId).toBe(fix.extras[0]!.id);
  });

  it('反例：非总管调用被拒；总管在既不是主人发起、也不是这件事的执行链唤醒的回合里被拒；派活（assign）在执行链回合里仍被拒', async () => {
    const fix = await jobFix(['小周']);
    const job = await executorStuck(fix);
    await chiefChainTurn(fix, job.id);
    const asEngineer = await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_manage', { mode: 'reassign', jobId: job.id, executor: '小周' });
    expect(asEngineer).toMatchObject({ ok: false, error: '只有总管能改派' });
    // 把这一回合改成「不属于这件事」的普通回合：被拒，文字不变。
    const wake = runningOf(fix, fix.chief.id)!;
    fix.ctx.store.table('wakes').patch(wake.id, { jobId: undefined } as never);
    expect(await callTool(fix, fix.chief, 'hub_job_manage', { mode: 'reassign', jobId: job.id, executor: '小周' }))
      .toMatchObject({ ok: false, error: '改派只能在主人发话、确认或回答叫醒的回合里进行' });
    fix.ctx.store.table('wakes').patch(wake.id, { jobId: job.id });
    expect(await callTool(fix, fix.chief, 'hub_job_manage', { mode: 'assign', agreementId: theJob(fix).agreementId, executor: '小周', dueAt: '2026-11-17 18:00', launchStep: false }))
      .toMatchObject({ ok: false, error: '派活只能在主人发话、确认或回答叫醒的回合里进行' });
    expect(theJob(fix).executorId).toBe(fix.engineer.id);
  });
});

// ---------------------------------------------------------------------------
// R5
// ---------------------------------------------------------------------------

describe('R5 「你手上的事」段被截断时不能丢掉做法说明（审查发现 F6）', () => {
  const long = (n: number) => `${String(n).padStart(2, '0')}${'说明'.repeat(48)}`;
  const SECTION = '## 你手上的事（中心维护）';

  /** 取出「你手上的事」段的正文。 */
  function sectionOf(packet: string): string {
    const start = packet.indexOf(SECTION);
    expect(start).toBeGreaterThanOrEqual(0);
    const rest = packet.slice(start + SECTION.length);
    const next = rest.search(/\n\n## /);
    return (next === -1 ? rest : rest.slice(0, next)).trim();
  }

  // P74r2d 第 1 条：原来的「按条删、写其余 N 条见约定文件」整条删掉的做法已被逐级压缩取代；
  // 这一条单元测试改成新接口（fitJobBody 按级别生成正文、逐级压缩），断言「没超限时与逐行拼接一致、超限时一条不删」。
  it('单元：fitJobBody 逐级压缩，开头和末尾一行不丢、清单一条不删；没超限时与逐行拼接一致', () => {
    const build = (level: number) => ({
      head: ['开头 1', '开头 2'],
      flex: [{ items: Array.from({ length: 10 }, (_, i) => `条目 ${i + 1} ${'字'.repeat(level >= 2 ? 10 : 100)}`), render: (kept: string[]) => kept.length === 0 ? null : kept.join('\n') }],
      tail: ['末尾说明 A', '末尾说明 B'],
    });
    const full = fitJobBody(build, 100_000);
    expect(full.level).toBe(0);
    expect(full.text).toBe([...build(0).head, ...build(0).flex[0]!.items, ...build(0).tail].join('\n'));
    const cut = fitJobBody(build, 1_000);
    expect(cut.level).toBe(2);
    expect(byteLength(cut.text)).toBeLessThanOrEqual(1_000);
    for (const line of [...build(2).head, ...build(2).tail]) expect(cut.text).toContain(line);
    expect((cut.text.match(/条目 \d+ /g) ?? []).length).toBe(10);
    expect(cut.text).not.toContain('其余');
  });

  it('执行者返工：待改条目和「怎样算做完」很多时，交回、提问、禁止事项三类说明的每一行都在，截断说明里的条数正确', async () => {
    const fix = await jobFix();
    const { job, agreementId } = await runningJob(fix);
    const agreement = fix.ctx.store.table('agreements').get(agreementId)!;
    const version = agreement.versions.find(row => row.state === 'locked')!;
    fix.ctx.store.table('agreements').put({ ...agreement, versions: agreement.versions.map(row => row.no !== version.no ? row : { ...row, content: {
      ...row.content, doneWhen: Array.from({ length: 5 }, (_, i) => long(i + 20)) } }) });
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '已交回' });
    const unmet = [1, 2, 3].map(no => ({ no, problem: `问题${no}${'错'.repeat(190)}`, fixTo: `标准${no}${'改'.repeat(190)}` }));
    const rework = { ...theJob(fix), state: 'rework' as const, round: 1, unmet };
    fix.ctx.store.table('jobs').put(rework);
    expect(enqueueJobWake(fix.ctx, { job: rework, botId: fix.engineer.id, why: 'returned', eventId: null, summary: '核对退回' })).not.toBeNull();
    await untilRunning(fix, fix.engineer.id);
    const text = sectionOf(lastPacket(fix, bot(fix, fix.engineer.id)));
    expect(byteLength(text)).toBeLessThanOrEqual(JOB_DEFAULTS.PACKET_MAX_BYTES);
    expect(text).toContain(`交回：调用 hub_job_work，mode 写 submit，jobId 写 ${job.id}`);
    expect(text).toContain('有问题问总管：mode 写 ask，text 写问题。做不下去：mode 写 block，stuckAt 写卡在哪，tried 写试过什么。');
    expect(text).toContain('不要直接找主人，不要用 hub_send。交账的 reply 只写一句这一回合做了什么。');
    expect(text).toContain('现在：返工中');
    // P74r2d 第 1 条：上限放宽到 16 KB，这个场景（5 条怎样算做完加 3 条待改）放得下，一条都不删、不压缩；
    // 原来断言「被截断、其余 N 条见约定文件」的预期改为「全部在、没有这种写法」。
    expect((text.match(/^\d+\. /gm) ?? []).length).toBe(5);
    expect((text.match(/第 \d+ 条：问题：/g) ?? []).length).toBe(3);
    expect(text).not.toMatch(/其余 \d+ 条见约定文件/);
    expect(text).not.toContain('条目全文见约定文件');
    expect(text).not.toContain('…（已截断');
  });

  it('核对人：5 条自查各 4 项证据（都在字数上限内）时，核对规则、提交结论、禁止事项每一行都在，产出物行也在，条数正确', async () => {
    const fix = await jobFix();
    const { job, agreementId } = await runningJob(fix);
    const agreement = fix.ctx.store.table('agreements').get(agreementId)!;
    const version = agreement.versions.find(row => row.state === 'locked')!;
    const done = Array.from({ length: 5 }, (_, i) => long(i + 20));
    fix.ctx.store.table('agreements').put({ ...agreement, versions: agreement.versions.map(row => row.no !== version.no ? row : { ...row, content: { ...row.content, doneWhen: done } }) });
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '已交回' });
    const checking = applyJobAction(theJob(fix), { type: 'submit' }, fix.ctx.clock.now());
    fix.ctx.store.table('jobs').put(checking);
    const evidence = (no: number, k: number) => ({ id: `ev${no}${k}`, kind: 'test' as const, path: null, url: null,
      summary: `第${no}条的证据${k}${'证'.repeat(100)}`, command: `pnpm test ${'a'.repeat(280)}`, check: { status: 'unchecked' as const, detail: '' } });
    fix.ctx.store.table('jobSubmissions').put({
      id: 'jsb_0000000001', jobId: job.id, stage: 1, round: 1, executorId: fix.engineer.id, versionNo: 1, changeNote: '搭好了',
      items: done.map((text, index) => ({ no: index + 1, text, selfCheck: 'met' as const, note: null, evidence: [1, 2, 3, 4].map(k => evidence(index + 1, k)) })),
      deliverables: ['交付/报价页.html'], preview: null, createdAt: fix.ctx.clock.now(),
    });
    expect(enqueueJobWake(fix.ctx, { job: checking, botId: fix.reviewer.id, why: 'to_review', eventId: null, summary: '请核对' })).not.toBeNull();
    await untilRunning(fix, fix.reviewer.id);
    const text = sectionOf(lastPacket(fix, bot(fix, fix.reviewer.id)));
    expect(byteLength(text)).toBeLessThanOrEqual(JOB_DEFAULTS.PACKET_MAX_BYTES);
    expect(text).toContain('核对规则：只核对是否符合约定、是否正确；配色、字体、文案语气不在核对范围。');
    expect(text).toContain(`提交结论：调用 hub_job_work，mode 写 review，jobId 写 ${job.id}，items 逐条写 no、verdict（met、unmet 或 at_delivery）、note、fixTo。`);
    expect(text).toContain('不要直接找主人，不要用 hub_send。交账的 reply 只写一句。');
    expect(text).toMatch(/产出物：\S+\/交付\/报价页\.html/);
    // P74r2d 第 1 条：不再整条删：5 条自查和每一项证据（20 项）都在；原来断言「只留部分条目、其余 N 条见约定文件」的预期改掉。
    expect((text.match(/^\d+\. /gm) ?? []).length).toBe(5);
    expect((text.match(/^证据 ev\d\d：/gm) ?? []).length).toBe(20);
    expect(text).not.toMatch(/其余 \d+ 条见约定文件/);
  });

  it('反例：条目不多、没超限时没有截断说明', async () => {
    const fix = await jobFix();
    await runningJob(fix);
    const text = sectionOf(lastPacket(fix, bot(fix, fix.engineer.id)));
    expect(text).not.toContain('其余');
  });
});

// ---------------------------------------------------------------------------
// R6
// ---------------------------------------------------------------------------

describe('R6 转受阻时写给主人看的话要说对是谁（审查发现 F7）', () => {
  // P76g：第三块的兜底（巡检叫满两次转受阻）已删除，巡检不再调用 blockExecutor；但 blockExecutor 的「按实际没有动的人写话」
  // 仍然存在（执行者自己报做不下去、续排空手而归会调用它），这一组改为直接调用它，证明话仍然说对是谁。
  const workLines = (fix: JobFix, job: { topicId: string }) =>
    threadOf(fix.ctx, job.topicId).filter(row => row.from === 'hub' && row.kind === 'work' && row.text.includes('连续两次叫醒都没有进展')).map(row => row.text);
  const stall = (fix: JobFix, stalledId: string) => blockExecutor(fix.ctx, theJob(fix), '连续两次叫醒都没有进展', fix.ctx.clock.now(), 'hub', { idle: true }, stalledId);

  it('执行者没有动：写执行者（沿用「做不下去」）', async () => {
    const fix = await jobFix();
    const { job } = await assigned(fix);
    for (const entry of entriesOf(fix, fix.engineer.id, job.id)) fix.ctx.store.table('queue').remove(entry.id);
    stall(fix, fix.engineer.id);
    expect(workLines(fix, job)).toEqual(['林舟无法继续：连续两次叫醒都没有进展。已告诉总管。']);
    expect(theJob(fix)).toMatchObject({ state: 'blocked', blocked: { kind: 'executor' } });
  });

  it('核对人没有动：写核对人，不写执行者做不下去', async () => {
    const fix = await jobFix();
    const { job } = await runningJob(fix);
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '已交回' });
    for (const entry of entriesOf(fix, fix.engineer.id, job.id)) fix.ctx.store.table('queue').remove(entry.id);
    fix.ctx.store.table('jobs').put(applyJobAction(theJob(fix), { type: 'submit' }, fix.ctx.clock.now()));
    stall(fix, fix.reviewer.id);
    const lines = workLines(fix, job);
    expect(lines).toEqual(['评审甲一直没有提交核对结论：连续两次叫醒都没有进展。已告诉总管。']);
    expect(lines.join('')).not.toContain('林舟无法继续');
    expect(lines.join('')).not.toMatch(INTERNAL);
    expect(theJob(fix)).toMatchObject({ state: 'blocked', blocked: { kind: 'executor' } });
  });

  it('总管没有动（总管自己核对）：不转受阻、不落「总管一直没有……」往来，改由「没有进展」条目告诉主人；仍不会写成执行者做不下去', async () => {
    const fix = await jobFix();
    const { job } = await runningJob(fix, { reviewer: '总管' });
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '已交回' });
    for (const entry of entriesOf(fix, fix.engineer.id, job.id)) fix.ctx.store.table('queue').remove(entry.id);
    for (const entry of entriesOf(fix, fix.chief.id, job.id)) fix.ctx.store.table('queue').remove(entry.id);
    fix.ctx.store.table('jobs').put(applyJobAction(theJob(fix), { type: 'submit' }, fix.ctx.clock.now()));
    // 原来用巡检叫满两次来触发；现在由停滞判断：2 小时重新唤醒总管一次，再 1 小时仍没有记录，建「没有进展」条目。
    advanceSweeping(fix, 120 * MINUTE);
    expect(entriesOf(fix, fix.chief.id, job.id)).toHaveLength(1);
    for (const entry of entriesOf(fix, fix.chief.id, job.id)) fix.ctx.store.table('queue').remove(entry.id);
    advanceSweeping(fix, 60 * MINUTE);
    expect(fix.ctx.store.table('inbox').list(row => row.subjectKey.startsWith(`job:${job.id}:stall:`))).toHaveLength(1);
    // 没有这句往来，这件事仍是核对中（转了受阻总管自己就提交不了结论）。
    expect(workLines(fix, job)).toEqual([]);
    expect(theJob(fix)).toMatchObject({ state: 'checking', blocked: null });
    expect(threadOf(fix.ctx, job.topicId).map(row => row.text).join('')).not.toContain('林舟无法继续');
  });
});

// ---------------------------------------------------------------------------
// R7
// ---------------------------------------------------------------------------

describe('R7 项目里有进行中的事时不能归档项目（审查发现 F9）', () => {
  it('有进行中的事时拒绝，文字列出件数和标题；事收尾（完成或停止）之后可以归档', async () => {
    const fix = await jobFix();
    const { job } = await assigned(fix);
    expect(() => archiveProject(fix.ctx, job.projectId)).toThrow('项目里有 1 件进行中的事：「会员定价页」。先完成或停止它们');
    expect(fix.ctx.store.table('projects').get(job.projectId)!.status).not.toBe('archived');
    // 已完成不挡。
    fix.ctx.store.table('jobs').patch(job.id, { state: 'done' });
    expect(archiveProject(fix.ctx, job.projectId).status).toBe('archived');
  });

  it('已停止的事不挡；别的项目里的事不挡', async () => {
    const fix = await jobFix();
    const { job } = await assigned(fix);
    fix.ctx.store.table('jobs').patch(job.id, { state: 'stopped', stoppedAt: fix.ctx.clock.now() });
    expect(archiveProject(fix.ctx, job.projectId).status).toBe('archived');
    // 另一个项目（夹具里的「季度战役」）里没有事，可以归档。
    expect(archiveProject(fix.ctx, fix.project.id).status).toBe('archived');
  });
});

// ---------------------------------------------------------------------------
// R8
// ---------------------------------------------------------------------------

describe('R8 小问题', () => {
  it('原话文件：线程日志里找不到、但当时的感知还在，取感知里的原话；都找不到写固定说明；没有来源消息写直接说的说明；从不留空', async () => {
    const fix = await jobFix();
    await ownerSays(fix, fix.chief.id, '帮我做个会员定价页');
    expect(await callTool(fix, fix.chief, 'hub_agreement_submit', newAgreementArgs({ title: '会员定价页' }))).toMatchObject({ ok: true });
    const real = fix.ctx.store.table('agreements').list()[0]!;
    const sourceId = real.versions[0]!.sourceMessageId!;
    // 日志里找不到这条消息（用一个不存在的编号模拟超出保留范围），但感知里有同一编号的主人消息：取感知里的原话。
    const ghost = 'm_0000000999';
    fix.ctx.store.table('percepts').put({ ...fix.ctx.store.table('percepts').list(row => row.location === sourceId)[0]!, id: 'p_0000000999', location: ghost, summary: '当时说的那句原话' } as never);
    const viaPercept = renderOwnerWordsFile(fix.ctx, { ...real, versions: [{ ...real.versions[0]!, sourceMessageId: ghost }] });
    expect(viaPercept).toContain('当时说的那句原话');
    // 感知也没有：写固定说明。
    const gone = renderOwnerWordsFile(fix.ctx, { ...real, versions: [{ ...real.versions[0]!, sourceMessageId: 'm_0000000888' }] });
    expect(gone).toContain('原话记录已超出保留范围，以约定为准');
    // 没有来源消息：沿用原来的说明。
    const direct = renderOwnerWordsFile(fix.ctx, { ...real, versions: [{ ...real.versions[0]!, sourceMessageId: null }] });
    expect(direct).toContain('（主人在 DSH 会话里直接说的，没有存下原文）');
    // 正常情况仍取日志里的原话。
    expect(renderOwnerWordsFile(fix.ctx, real)).toContain('帮我做个会员定价页');
  });

  it('退还回合：改派后新执行者第一个回合（回合数已大于 1）被撤回时，状态还原为待开工；不是这次开工的回合不还原', async () => {
    const fix = await jobFix();
    const { job } = await assigned(fix);
    // 模拟改派后的待开工：回合数已有 3（总管的说明回合等也计数）。
    fix.ctx.store.table('jobs').patch(job.id, { turnsUsed: 3 });
    const entry = { ...entriesOf(fix, fix.engineer.id, job.id)[0]!, id: 'q_0000000001', ownerInitiated: false };
    const ticket = createTicket(fix.ctx, entry, null);
    expect(theJob(fix)).toMatchObject({ state: 'doing', turnsUsed: 4, startedAt: ticket.startedAt });
    refundJobTurn(fix.ctx, ticket);
    expect(theJob(fix)).toMatchObject({ state: 'ready', turnsUsed: 3, startedAt: null });
    // 反例：这件事早就在执行中（开工时间不是这张唤醒单的），退还只减回合数。
    const again = createTicket(fix.ctx, { ...entry, id: 'q_0000000002' }, null);
    fix.ctx.clock.advance(MINUTE);
    const later = createTicket(fix.ctx, { ...entry, id: 'q_0000000003' }, null);
    expect(later.startedAt).toBeGreaterThan(again.startedAt);
    refundJobTurn(fix.ctx, later);
    expect(theJob(fix)).toMatchObject({ state: 'doing', startedAt: again.startedAt });
  });
});

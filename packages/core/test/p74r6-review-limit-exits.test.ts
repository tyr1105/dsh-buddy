/**
 * P74r6 第 1、2、3 节的测试：核对三轮不过之后，凡是让这件事回到执行者或核对人手里的出口，都进入新的一个阶段；
 * 说明开着时不另建回合上限条目；卡上写的约定版本号与实际生成的一致。
 *
 * 为什么每条都走到「执行者交回成功」「核对通过」「交付」：之前改派、恢复这一步本身都「成功」，
 * 但这件事仍是「返工中、本阶段第 3 轮」，新执行者一交回就被拒（本阶段已经交回 3 轮），这件事只能停止。
 * 只断言改派或恢复成功，会漏掉这个问题。全部走真实 Hub，总管只用唤醒包里的文字调用，假时钟每次不超过 10 分钟。
 */
import { describe, expect, it } from 'vitest';
import { escalationCardView } from '../src/api/job-escalation-views.js';
import { lifecycleAction } from '../src/api/bots.js';
import { flushJobHooks } from '../src/job/agreement-hooks.js';
import { reportStall } from '../src/job/stall.js';
import { budgetOptions, LEGACY_TOP_UP_TURNS } from '../src/job/block-options.js';
import { capSubjectKey } from '../src/job/cap.js';
import { createInboxItem } from '../src/outreach/inbox.js';
import { JOB_DEFAULTS as D } from '../src/config/defaults.js';
import type { Job } from '../src/model/job.js';
import { commitAndEnd, entriesOf, runningOf } from './p74c-fixtures.js';
import { threadOf } from './p74b-fixtures.js';
import { idsIn, reviseArgs } from './p74r2b-fixtures.js';
import {
  MINUTE, bot, callTool, escalateFromPacket, lastPacket, limitFix, nextPacket, ownerSays, sectionOf, speak, started, theJob, tick, type JobFix,
} from './p74f2-fixtures.js';

const A = { title: '放宽这一条', detail: '改成有提示或备用文案都算做完；代价是提示可以简单一些', change: { no: 3, text: '接口失败时页面有提示或有备用文案' } };
const B = { title: '换一位执行者再试', detail: '换人重做这一条；代价是多花一轮时间' };
const CHOSEN_LINE = '主人为这件事选的办法：「换一位执行者再试」：换人重做这一条；代价是多花一轮时间。';

/** 总管有回合开着就结束它。 */
async function chiefEnds(fix: JobFix): Promise<void> {
  if (runningOf(fix, fix.chief.id)) await commitAndEnd(fix, fix.chief.id, { outcome: 'progress', summary: '已处理', reply: '好的，已处理。' });
}

/** 主人没有选过办法之前的起点：核对三轮不过、总管说明了两个办法（A 带改动、B 不带），总管这一回合已结束。 */
async function escalated() {
  const { fix, job } = await limitFix();
  fix.ctx.store.table('jobs').patch(job.id, { turnCap: 60 }); // 回合上限不是这些测试要测的东西
  await escalateFromPacket(fix, [A, B]);
  return { fix, job };
}

/** 主人选了不带改动的办法 B，总管被主人的话叫醒、拿到回合（回合开着）。 */
async function chosenPlain() {
  const s = await escalated();
  expect(await s.fix.hub.api.chooseJobOption({ jobId: s.job.id, stage: 1, option: 1 })).toMatchObject({ ok: true });
  await tick(s.fix, 5 * MINUTE);
  const packet = await nextPacket(s.fix, s.fix.chief.id);
  return { ...s, packet };
}

/** 新执行者（或原执行者）拿到回合，交回第 3 条成功；返回交回之后的这件事。 */
async function executorSubmits(fix: JobFix, executorId: string, job: Job): Promise<Job> {
  const packet = await nextPacket(fix, executorId);
  expect(sectionOf(packet)).toContain(CHOSEN_LINE);
  const submitted = await callTool(fix, bot(fix, executorId), 'hub_job_work', {
    mode: 'submit', jobId: job.id, changeNote: '换了做法', deliverables: ['交付/报价页.html'],
    items: [{ no: 3, selfCheck: 'met', evidence: [{ kind: 'file', path: '交付/报价页.html', summary: '页面文件' }] }] });
  expect(submitted, JSON.stringify(submitted)).toMatchObject({ ok: true });
  await commitAndEnd(fix, executorId, { outcome: 'progress', summary: '已交回' });
  return theJob(fix);
}

/** 核对人对第 3 条给结论：通过则交付；返回之后的这件事。 */
async function reviewerRules(fix: JobFix, reviewerId: string, jobId: string, verdict: 'met' | 'unmet'): Promise<Job> {
  await nextPacket(fix, reviewerId);
  const item = verdict === 'met' ? { no: 3, verdict: 'met' } : { no: 3, verdict: 'unmet', note: '还是没有提示', fixTo: '断开接口后页面显示加载失败' };
  const result = await callTool(fix, bot(fix, reviewerId), 'hub_job_work', { mode: 'review', jobId, items: [item] });
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  await commitAndEnd(fix, reviewerId, { outcome: 'progress', summary: '已核对' });
  return theJob(fix);
}

/** 不变式：这件事处在待开工、执行中、返工中时，本阶段轮数小于上限。 */
function expectUnderLimit(job: Job): void {
  if (job.state === 'ready' || job.state === 'doing' || job.state === 'rework') expect(job.round).toBeLessThan(D.REVIEW_ROUNDS_MAX);
}

/** 路径一：总管换执行者。返回改派之后（执行者交回之前）的这件事。 */
async function pathReassignExecutor() {
  const { fix, job, packet } = await chosenPlain();
  expect(sectionOf(packet)).toContain('主人为这件事选了办法「换一位执行者再试」');
  expect(sectionOf(packet)).toContain('mode 写 resume');
  expect(sectionOf(packet)).toContain('换人或接着做之后，核对从新的三轮算起。');
  expect(sectionOf(packet)).toContain('stopsJob 写 true');
  const swap = await callTool(fix, bot(fix, fix.chief.id), 'hub_job_manage', { mode: 'reassign', jobId: job.id, executor: '小周' });
  expect(swap, JSON.stringify(swap)).toMatchObject({ ok: true });
  expect(String((swap as { text?: string }).text)).toContain('核对从新的三轮算起');
  return { fix, job, after: theJob(fix) };
}

describe('第 1 节：三轮不过之后的出口都进入新阶段', () => {
  it('总管换执行者：新阶段、返工中、轮数归零、待改条目带问题和改法；新执行者唤醒包有主人选的办法；交回成功 → 核对通过 → 交付', async () => {
    const { fix, job, after } = await pathReassignExecutor();
    expect(after).toMatchObject({ state: 'rework', stage: 2, round: 0, blocked: null, inboxId: null, executorId: fix.extras[0]!.id,
      unmet: [{ no: 3, problem: '第3轮的问题', fixTo: '第3轮的改法' }], ownerChoice: { stage: 2, title: B.title } });
    expectUnderLimit(after);
    await chiefEnds(fix);
    const packet = sectionOf(await nextPacket(fix, fix.extras[0]!.id));
    expect(packet).toContain(CHOSEN_LINE);
    expect(packet).toContain('第 3 条：问题：第3轮的问题；改到什么程度算过：第3轮的改法。');
    const submitted = await executorSubmits(fix, fix.extras[0]!.id, job);
    expect(submitted).toMatchObject({ state: 'checking', stage: 2, round: 1 });
    const passed = await reviewerRules(fix, fix.reviewer.id, job.id, 'met');
    expect(passed.state).toBe('awaiting_owner');
    expect(fix.ctx.store.table('inbox').list(row => row.status === 'open' && row.subjectKey === `job:${job.id}:accept:2`)).toHaveLength(1);
    expect(await fix.hub.api.acceptJob({ jobId: job.id, stage: 2, revision: 0 })).toMatchObject({ ok: true });
    expect(theJob(fix).state).toBe('done');
  });

  it('总管只换核对人：新阶段、核对中、第 1 轮，交回由中心重排；新核对人对上一次判不符的条目给结论；通过后交付，判不符则退回返工（后面还有两轮）', async () => {
    for (const verdict of ['met', 'unmet'] as const) {
      const { fix, job } = await chosenPlain();
      const swap = await callTool(fix, bot(fix, fix.chief.id), 'hub_job_manage', { mode: 'reassign', jobId: job.id, reviewer: '总管' });
      expect(swap, JSON.stringify(swap)).toMatchObject({ ok: true });
      const now = theJob(fix);
      expect(now).toMatchObject({ state: 'checking', stage: 2, round: 1, blocked: null, reviewerId: null, recheckNos: [3], ownerChoice: { stage: 2 } });
      const subs = fix.ctx.store.table('jobSubmissions').list(row => row.jobId === job.id && row.stage === 2);
      expect(subs).toHaveLength(1);
      expect(subs[0]).toMatchObject({ round: 1, remappedFrom: expect.any(String) });
      await chiefEnds(fix);
      const reviewerPacket = sectionOf(await nextPacket(fix, fix.chief.id));
      expect(reviewerPacket).toContain(CHOSEN_LINE);
      expect(reviewerPacket).toContain('只需要给第 3 条写结论');
      const result = await reviewerRules(fix, fix.chief.id, job.id, verdict);
      if (verdict === 'met') {
        expect(result.state).toBe('awaiting_owner');
      } else {
        expect(result).toMatchObject({ state: 'rework', stage: 2, round: 1 });
        expectUnderLimit(result);
        const again = await executorSubmits(fix, fix.engineer.id, job);
        expect(again).toMatchObject({ state: 'checking', stage: 2, round: 2 });
      }
    }
  });

  it('总管用 resume（不换人）：新阶段、返工中、轮数归零，原执行者被叫醒；交回成功 → 核对通过 → 交付', async () => {
    const { fix, job } = await chosenPlain();
    const resumed = await callTool(fix, bot(fix, fix.chief.id), 'hub_job_manage', { mode: 'resume', jobId: job.id });
    expect(resumed, JSON.stringify(resumed)).toMatchObject({ ok: true });
    expect(theJob(fix)).toMatchObject({ state: 'rework', stage: 2, round: 0, blocked: null, inboxId: null, unmet: [{ no: 3 }], ownerChoice: { stage: 2 } });
    await chiefEnds(fix);
    await executorSubmits(fix, fix.engineer.id, job);
    expect((await reviewerRules(fix, fix.reviewer.id, job.id, 'met')).state).toBe('awaiting_owner');
  });

  it('执行者做不下去 → 说明 → 主人选不带改动的办法 → resume：回到受阻前的环节，执行者被叫醒、能交回，同一阶段', async () => {
    const { fix, job } = await started(['小周']);
    fix.ctx.store.table('jobs').patch(job.id, { turnCap: 60 });
    expect(await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', { mode: 'block', jobId: job.id, stuckAt: '缺报价接口的文档', tried: ['查了仓库'] })).toMatchObject({ ok: true });
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'blocked', blocker: '缺报价接口的文档', summary: '做不下去' });
    expect((await escalateFromPacket(fix, [{ title: '先放一放', detail: '等文档到了再做；代价是交付时间会晚' }, B])).result).toMatchObject({ ok: true });
    expect(await fix.hub.api.chooseJobOption({ jobId: job.id, stage: 1, option: 0 })).toMatchObject({ ok: true });
    await tick(fix, 5 * MINUTE);
    await nextPacket(fix, fix.chief.id);
    const resumed = await callTool(fix, bot(fix, fix.chief.id), 'hub_job_manage', { mode: 'resume', jobId: job.id });
    expect(resumed, JSON.stringify(resumed)).toMatchObject({ ok: true });
    expect(theJob(fix)).toMatchObject({ state: 'doing', stage: 1, blocked: null, ownerChoice: { stage: 1, title: '先放一放' } });
    await chiefEnds(fix);
    const packet = sectionOf(await nextPacket(fix, fix.engineer.id));
    expect(packet).toContain('主人为这件事选的办法：「先放一放」：等文档到了再做；代价是交付时间会晚。');
    const submitted = await callTool(fix, bot(fix, fix.engineer.id), 'hub_job_work', {
      mode: 'submit', jobId: job.id, changeNote: '文档到了', deliverables: ['交付/报价页.html'],
      items: [{ no: 1, selfCheck: 'at_delivery' }, { no: 2, selfCheck: 'not_met', note: '还没做' }, { no: 3, selfCheck: 'not_met', note: '还没做' }] });
    expect(submitted, JSON.stringify(submitted)).toMatchObject({ ok: true });
  });

  it('三轮不过 → 总管没有写出说明 →「没有进展」条目 → 主人选「暂停」→ 总管 resume：回到三轮不过的受阻，总管被叫醒并能说明；选办法 → 换执行者 → 交付', async () => {
    const { fix, job } = await limitFix();
    fix.ctx.store.table('jobs').patch(job.id, { turnCap: 60 });
    // P76g：原来用 announceStall（第三块兜底）造「没有进展」条目；现在经 reportStall（停摆）造，这一用例要证明的是之后的暂停与恢复，与条目怎样产生无关。
    expect(reportStall(fix.ctx, theJob(fix), 'idle', fix.ctx.clock.now() + 2 * 60 * MINUTE, { actorId: fix.chief.id })).toBe(true);
    expect(await fix.hub.api.answerJobStall({ jobId: job.id, answer: '暂停' })).toMatchObject({ ok: true });
    expect(theJob(fix).blocked).toMatchObject({ kind: 'owner_hold', heldFrom: { kind: 'review_limit', no: 3 } });
    await chiefEnds(fix);
    await ownerSays(fix, fix.chief.id, '接着做吧');
    const before = theJob(fix).blocked!.since;
    const resumed = await callTool(fix, bot(fix, fix.chief.id), 'hub_job_manage', { mode: 'resume', jobId: job.id });
    expect(resumed, JSON.stringify(resumed)).toMatchObject({ ok: true });
    const back = theJob(fix);
    expect(back).toMatchObject({ state: 'blocked', stage: 1, blocked: { kind: 'review_limit', no: 3, resumeTo: 'rework' } });
    expect(back.blocked!.heldFrom).toBeUndefined();
    expect(back.blocked!.since).toBeGreaterThanOrEqual(before);
    expect(entriesOf(fix, fix.chief.id, job.id).length + (runningOf(fix, fix.chief.id) ? 1 : 0)).toBeGreaterThan(0);
    await chiefEnds(fix);
    // 总管被叫醒，能写说明；主人选办法，总管换执行者，走到交付。
    expect((await escalateFromPacket(fix, [A, B])).result).toMatchObject({ ok: true });
    expect(await fix.hub.api.chooseJobOption({ jobId: job.id, stage: 1, option: 1 })).toMatchObject({ ok: true });
    await tick(fix, 5 * MINUTE);
    await nextPacket(fix, fix.chief.id);
    expect(await callTool(fix, bot(fix, fix.chief.id), 'hub_job_manage', { mode: 'reassign', jobId: job.id, executor: '小周' })).toMatchObject({ ok: true });
    expect(theJob(fix)).toMatchObject({ state: 'rework', stage: 2, round: 0 });
    await chiefEnds(fix);
    await executorSubmits(fix, fix.extras[0]!.id, job);
    expect((await reviewerRules(fix, fix.reviewer.id, job.id, 'met')).state).toBe('awaiting_owner');
  });

  it('旧数据：三轮不过之后暂停、没有记下原来的受阻原因，resume 同样进入新阶段（不回到第 3 轮的返工中）', async () => {
    const { fix, job } = await limitFix();
    fix.ctx.store.table('jobs').patch(job.id, { turnCap: 60 });
    const now = theJob(fix);
    fix.ctx.store.table('jobs').put({ ...now, inboxId: null, blocked: { ...now.blocked!, kind: 'owner_hold' } });
    await chiefEnds(fix);
    await ownerSays(fix, fix.chief.id, '接着做吧');
    expect(await callTool(fix, bot(fix, fix.chief.id), 'hub_job_manage', { mode: 'resume', jobId: job.id })).toMatchObject({ ok: true });
    expect(theJob(fix)).toMatchObject({ state: 'rework', stage: 2, round: 0 });
  });

  it('三轮不过 → 主人选换人 → 改派后另一位仍停用 → 那位恢复在岗：执行者被叫醒、能交回', async () => {
    const { fix, job } = await chosenPlain();
    await lifecycleAction(fix.ctx, { botId: fix.reviewer.id, action: 'suspend' });
    const swap = await callTool(fix, bot(fix, fix.chief.id), 'hub_job_manage', { mode: 'reassign', jobId: job.id, executor: '小周' });
    expect(swap, JSON.stringify(swap)).toMatchObject({ ok: true });
    // 先进入新阶段，再记为有人停用的受阻（解除后回到新阶段的返工中）。
    expect(theJob(fix)).toMatchObject({ state: 'blocked', stage: 2, round: 0, blocked: { kind: 'participant_off', resumeTo: 'rework' }, unmet: [{ no: 3 }] });
    await chiefEnds(fix);
    await lifecycleAction(fix.ctx, { botId: fix.reviewer.id, action: 'reinstate' });
    expect(theJob(fix)).toMatchObject({ state: 'rework', stage: 2, round: 0, blocked: null });
    await executorSubmits(fix, fix.extras[0]!.id, job);
    expect((await reviewerRules(fix, fix.reviewer.id, job.id, 'met')).state).toBe('awaiting_owner');
  });

  it('总断言：所有让这件事从三轮不过回到待开工、执行中、返工中、核对中的路径，回到之后轮数都小于上限', async () => {
    const paths: Job[] = [];
    paths.push((await pathReassignExecutor()).after);
    for (const how of ['reviewer', 'resume'] as const) {
      const { fix, job } = await chosenPlain();
      const args = how === 'reviewer' ? { mode: 'reassign', jobId: job.id, reviewer: '总管' } : { mode: 'resume', jobId: job.id };
      expect(await callTool(fix, bot(fix, fix.chief.id), 'hub_job_manage', args)).toMatchObject({ ok: true });
      paths.push(theJob(fix));
    }
    expect(paths).toHaveLength(3);
    for (const job of paths) {
      expect(['ready', 'doing', 'rework', 'checking']).toContain(job.state);
      expect(job.stage).toBe(2);
      expect(job.round).toBeLessThan(D.REVIEW_ROUNDS_MAX);
    }
  });

  it('主人还没有选办法时，resume 和改派照旧被拒', async () => {
    const { fix, job } = await escalated();
    await ownerSays(fix, fix.chief.id, '现在怎么样了');
    const resumed = await callTool(fix, bot(fix, fix.chief.id), 'hub_job_manage', { mode: 'resume', jobId: job.id });
    expect(resumed).toEqual({ ok: false, error: '只有主人已暂停的事、或主人已为这次受阻选了办法的事才能恢复；这件事现在不是这两种状态' });
    const swap = await callTool(fix, bot(fix, fix.chief.id), 'hub_job_manage', { mode: 'reassign', jobId: job.id, executor: '小周' });
    expect(swap).toEqual({ ok: false, error: '这件事核对三轮仍未通过，要等主人选定办法之后才能改派。' });
    expect(theJob(fix)).toMatchObject({ state: 'blocked', stage: 1, round: 3 });
  });
});

describe('第 2 节：说明开着时不另建回合上限条目', () => {
  it('写说明的那一回合正好用满回合上限：巡检之后说明条目还开着、没有回合上限条目、卡片可选；选办法追加回合并落那句话，流程走得下去', async () => {
    const { fix, job } = await limitFix();
    fix.ctx.store.table('jobs').patch(job.id, { turnCap: theJob(fix).turnsUsed + 1 });
    await escalateFromPacket(fix, [A, B]);
    await tick(fix, 1_000);
    await tick(fix, 60_000);
    const open = fix.ctx.store.table('inbox').list(row => row.status === 'open' && row.subjectKey.startsWith(`job:${job.id}:`));
    expect(open.map(row => row.subjectKey)).toEqual([`job:${job.id}:escalate:1`]);
    expect(fix.ctx.store.table('inbox').list(row => row.subjectKey.startsWith(`job:${job.id}:cap:`))).toHaveLength(0);
    expect(escalationCardView(fix.ctx, `escalation:${job.id}#1`)).toMatchObject({ stateText: '等你决定', selectable: true });
    const capBefore = theJob(fix).turnCap;
    expect(await fix.hub.api.chooseJobOption({ jobId: job.id, stage: 1, option: 1 })).toMatchObject({ ok: true });
    expect(theJob(fix).turnCap).toBe(capBefore + LEGACY_TOP_UP_TURNS);
    expect(threadOf(fix.ctx, fix.chief.id).some(row => row.from === fix.chief.id && row.text === `这件事的回合已经用完，按你选的办法继续需要回合，已追加 ${LEGACY_TOP_UP_TURNS} 个。`)).toBe(true);
    await tick(fix, 5 * MINUTE);
    await nextPacket(fix, fix.chief.id);
    expect(await callTool(fix, bot(fix, fix.chief.id), 'hub_job_manage', { mode: 'reassign', jobId: job.id, executor: '小周' })).toMatchObject({ ok: true });
    expect(theJob(fix)).toMatchObject({ state: 'rework', stage: 2, round: 0 });
  });

  it('建这件事的其他条目（回合上限）时不撤回说明条目：说明条目只由说明自己的流程处理', async () => {
    const { fix, job } = await escalated();
    createInboxItem(fix.ctx, { botId: fix.chief.id, type: 'question', title: '回合上限', body: '', options: [...budgetOptions(2)], defaultOption: null, expiresAt: null,
      priority: 'P1', refId: job.id, subjectKey: capSubjectKey(job.id, 99) });
    const open = fix.ctx.store.table('inbox').list(row => row.status === 'open' && row.subjectKey.startsWith(`job:${job.id}:`)).map(row => row.subjectKey).sort();
    expect(open).toEqual([`job:${job.id}:cap:99`, `job:${job.id}:escalate:1`]);
    expect(escalationCardView(fix.ctx, `escalation:${job.id}#1`)).toMatchObject({ stateText: '等你决定', selectable: true });
  });

  it('回合没有用完时选办法：不追加回合，也没有那句话', async () => {
    const { fix, job } = await escalated();
    const cap = theJob(fix).turnCap;
    expect(await fix.hub.api.chooseJobOption({ jobId: job.id, stage: 1, option: 1 })).toMatchObject({ ok: true });
    expect(theJob(fix).turnCap).toBe(cap);
    expect(threadOf(fix.ctx, fix.chief.id).some(row => row.text.startsWith('这件事的回合已经用完'))).toBe(false);
  });

  it('这件事受阻、在等总管写说明、还没有说明时回合用到上限：建回合上限条目；主人追加回合后总管被叫醒，可以说明', async () => {
    const { fix, job } = await limitFix();
    fix.ctx.store.table('jobs').patch(job.id, { turnCap: theJob(fix).turnsUsed });
    await tick(fix, 5 * MINUTE);
    await tick(fix, 5 * MINUTE);
    const cap = fix.ctx.store.table('inbox').list(row => row.status === 'open' && row.subjectKey.startsWith(`job:${job.id}:cap:`));
    expect(cap).toHaveLength(1);
    expect(await fix.hub.api.answerJobCap({ jobId: job.id, answer: cap[0]!.options[0]! })).toMatchObject({ ok: true });
    expect(theJob(fix)).toMatchObject({ state: 'blocked', blocked: { kind: 'review_limit' } });
    expect((await escalateFromPacket(fix, [A, B])).result).toMatchObject({ ok: true });
  });
});

describe('第 3 节：卡上的版本号与实际生成的一致', () => {
  it('说明、出待确认版本、撤销、重新说明：卡上写的版本号等于选了之后实际记下的版本号', async () => {
    const { fix, job } = await limitFix();
    await escalateFromPacket(fix, [A, B]);
    await chiefEnds(fix);
    await ownerSays(fix, fix.chief.id, '约定里的条目要调整一下');
    const ids = idsIn(lastPacket(fix, bot(fix, fix.chief.id)));
    const agreement = fix.ctx.store.table('agreements').get(ids.agreementId)!;
    const doneNow = agreement.versions[0]!.content.doneWhen;
    expect(await callTool(fix, bot(fix, fix.chief.id), 'hub_agreement_submit', reviseArgs(ids.agreementId, { changeNote: '加手机', doneWhen: ['页面在手机上能看', ...doneNow] }))).toMatchObject({ ok: true });
    await speak(fix, bot(fix, fix.chief.id), '已请主人确认。', { outcome: 'needs_owner' });
    await ownerSays(fix, fix.chief.id, '不用加了，还是原来的');
    expect(await callTool(fix, bot(fix, fix.chief.id), 'hub_agreement_submit', { mode: 'withdraw', agreementId: ids.agreementId, reason: '主人不要这一条了' })).toMatchObject({ ok: true });
    await speak(fix, bot(fix, fix.chief.id), '好的，仍按第 1 版。', { outcome: 'progress' });
    await flushJobHooks(fix.ctx);
    await nextPacket(fix, fix.chief.id);
    expect(await callTool(fix, bot(fix, fix.chief.id), 'hub_job_manage', { mode: 'escalate', jobId: job.id, stuckAt: '接口失败时的提示做不到', suggested: 0, reason: '改动最小', options: [A, B] })).toMatchObject({ ok: true });
    const card = escalationCardView(fix.ctx, `escalation:${job.id}#1~1`)!;
    expect(card.optionsTitle).toContain('约定第 3 版');
    expect(await fix.hub.api.chooseJobOption({ jobId: job.id, stage: 1, option: 0, revision: 1 })).toMatchObject({ ok: true });
    const versions = fix.ctx.store.table('agreements').get(ids.agreementId)!.versions;
    expect(versions.at(-1)).toMatchObject({ no: 3, state: 'locked' });
    expect(threadOf(fix.ctx, fix.chief.id).some(row => row.text === '已按你选的办法记为约定第 3 版。')).toBe(true);
  });
});

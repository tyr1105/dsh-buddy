/**
 * P74r4a 第 3 条的测试：解除受阻时，这件事开着的受阻条目（说明、「停住了」、回合上限）一律撤回，条目编号清空；
 * 巡检自我修复条目编号与条目的不一致（第三次审查 K3）。
 *
 * 场景一（审查报告 K3 原样）：执行者做不下去，总管说明，主人让换人，总管改派；新执行者再做不下去：
 * 旧条目已撤回、编号为空；总管被叫醒；推进 6 小时，事情不会无声停下。
 * 场景二：每一条解除受阻的路径各一条断言（回答、转交材料、换执行者、换核对人、员工恢复在岗、主人选办法、
 * 答复回合上限、「再叫一次」、先停下之后的恢复）：解除之后没有开着的说明、「停住了」条目，条目编号为空。
 * 场景三：人为把条目编号改成指向已关闭的条目，巡检之后被清掉；不在受阻却有开着的说明条目，巡检之后被撤回。
 * 全部走真实 Hub，假时钟每次不超过 10 分钟。
 */
import { describe, expect, it } from 'vitest';
import { lifecycleAction } from '../src/api/bots.js';
import { openBlockItems } from '../src/job/block-items.js';
import { budgetOptions } from '../src/job/block-options.js';
import { capSubjectKey } from '../src/job/cap.js';
import { escalateSubjectKey } from '../src/job/escalate.js';
import { stallSubjectKey } from '../src/job/stall.js';
import { STALL_OPTIONS } from '../src/job/blocked-answer.js';
import { createInboxItem } from '../src/outreach/inbox.js';
import { applyJobAction } from '../src/job/state.js';
import { commitAndEnd, runningOf, wakesOf } from './p74c-fixtures.js';
import { engineerSubmits } from './p74d-fixtures.js';
import { threadOf } from './p74b-fixtures.js';
import {
  MINUTE, bot, callTool, escalateFromPacket, nextPacket, ownerSays, sectionOf, started, theJob, tick, type JobFix,
} from './p74f2-fixtures.js';

/** 这件事开着的受阻条目（说明、「停住了」、回合上限）。 */
function openOf(fix: JobFix, jobId: string) {
  return openBlockItems(fix.ctx, jobId);
}

/** 解除受阻之后应有的样子：没有开着的受阻条目，条目编号为空。 */
function expectReleased(fix: JobFix, jobId: string): void {
  expect(openOf(fix, jobId).map(row => row.subjectKey)).toEqual([]);
  expect(fix.ctx.store.table('jobs').get(jobId)!.inboxId).toBeNull();
}

/** 总管有回合开着就结束它（主人的话叫醒总管之前，上一个回合必须已经结束）。 */
async function chiefEnds(fix: JobFix, reply?: string): Promise<void> {
  if (runningOf(fix, fix.chief.id)) await commitAndEnd(fix, fix.chief.id, { outcome: 'progress', summary: '已处理', ...(reply === undefined ? {} : { reply }) });
}

/** 林舟做不下去，总管拿到回合（回合开着）。 */
async function executorBlocked() {
  const s = await started(['小周']);
  expect(await callTool(s.fix, bot(s.fix, s.fix.engineer.id), 'hub_job_work', { mode: 'block', jobId: s.job.id, stuckAt: '缺报价接口的文档', tried: ['查了仓库'] })).toMatchObject({ ok: true });
  await commitAndEnd(s.fix, s.fix.engineer.id, { outcome: 'blocked', blocker: '缺报价接口的文档', summary: '做不下去' });
  return s;
}

/**
 * 在这件事上放一条指定种类的开着的条目，并把编号记在这件事上（模拟各路径出现过的条目）。
 * 同一件事同一时刻只会有一条开着（createInboxItem 撤回其余的），所以一次放一种。
 */
function plant(fix: JobFix, jobId: string, kind: 'escalate' | 'stall' | 'cap') {
  const job = fix.ctx.store.table('jobs').get(jobId)!;
  const spec = kind === 'escalate'
    ? { subjectKey: escalateSubjectKey(jobId, job.stage, 9), options: ['A　甲', 'B　乙'] }
    : kind === 'stall' ? { subjectKey: stallSubjectKey(jobId, 9), options: [...STALL_OPTIONS] }
      : { subjectKey: capSubjectKey(jobId, job.turnCap), options: [...budgetOptions(2)] };
  const item = createInboxItem(fix.ctx, { botId: job.chiefId, type: 'question', title: `会员定价页：${kind}`, body: '测试放入的条目', ...spec,
    defaultOption: null, expiresAt: null, priority: 'P1', refId: jobId });
  fix.ctx.store.table('jobs').patch(jobId, { inboxId: item.id });
  return item;
}

describe('K3：改派之后，旧的说明条目撤回；新执行者再做不下去，事情不会无声停下', () => {
  it('说明做不下去，主人让换人，总管改派：旧条目撤回、编号为空；新执行者做不下去后总管被叫醒；推进 6 小时总管处理了或有新条目', async () => {
    const { fix, job } = await executorBlocked();
    await escalateFromPacket(fix, [
      { title: '换小周做', detail: '换一位执行者重做；代价是多花一轮时间' }, { title: '先等文档', detail: '等文档到了再做；代价是交付时间会晚' }]);
    const old = openOf(fix, job.id);
    expect(old).toHaveLength(1);
    await ownerSays(fix, fix.chief.id, '直接换小周做吧');
    expect(await callTool(fix, bot(fix, fix.chief.id), 'hub_job_manage', { mode: 'reassign', jobId: job.id, executor: '小周' })).toMatchObject({ ok: true });
    // 改派之后：旧条目已撤回，条目编号为空。
    expect(fix.ctx.store.table('inbox').get(old[0]!.id)).toMatchObject({ status: 'withdrawn' });
    expectReleased(fix, job.id);
    await chiefEnds(fix, '已改派给小周。');
    // 新执行者做不下去。
    const newcomer = fix.extras[0]!.id;
    await nextPacket(fix, newcomer);
    expect(await callTool(fix, bot(fix, newcomer), 'hub_job_work', { mode: 'block', jobId: job.id, stuckAt: '文档还是没有', tried: ['问了同事'] })).toMatchObject({ ok: true });
    await commitAndEnd(fix, newcomer, { outcome: 'blocked', blocker: '文档还是没有', summary: '做不下去' });
    // 总管被叫醒（只看唤醒包里的文字：有「写说明」的做法）。
    expect(sectionOf(await nextPacket(fix, fix.chief.id))).toContain('写说明：调用 hub_job_manage，mode 写 escalate');
    // 推进 6 小时（36 次 10 分钟）：总管处理了（说明已写，条目是新的一条），不会无声停下。
    const wrote = await callTool(fix, bot(fix, fix.chief.id), 'hub_job_manage', { mode: 'escalate', jobId: job.id, stuckAt: '文档一直没有', suggested: 0, reason: '先等一等',
      options: [{ title: '先放一放', detail: '等文档到了再做；代价是交付时间会晚' }, { title: '再换一位', detail: '换人重做；代价是多花一轮时间' }] });
    expect(wrote, JSON.stringify(wrote)).toMatchObject({ ok: true });
    await commitAndEnd(fix, fix.chief.id, { outcome: 'progress', summary: '已说明' });
    for (let i = 0; i < 36; i += 1) await tick(fix, 10 * MINUTE);
    const now = openOf(fix, job.id);
    expect(now).toHaveLength(1);
    expect(now[0]!.id).not.toBe(old[0]!.id);
    expect(now[0]!.title).toBe('会员定价页：小周无法继续');
    expect(theJob(fix).inboxId).toBe(now[0]!.id);
  });

  it('新执行者做不下去后总管没有动：6 小时内中心告诉主人（「停住了」条目），事情不会无声停下', async () => {
    const { fix, job } = await executorBlocked();
    await escalateFromPacket(fix, [
      { title: '换小周做', detail: '换一位执行者重做；代价是多花一轮时间' }, { title: '先等文档', detail: '等文档到了再做；代价是交付时间会晚' }]);
    await ownerSays(fix, fix.chief.id, '直接换小周做吧');
    expect(await callTool(fix, bot(fix, fix.chief.id), 'hub_job_manage', { mode: 'reassign', jobId: job.id, executor: '小周' })).toMatchObject({ ok: true });
    await chiefEnds(fix, '已改派给小周。');
    const newcomer = fix.extras[0]!.id;
    await nextPacket(fix, newcomer);
    expect(await callTool(fix, bot(fix, newcomer), 'hub_job_work', { mode: 'block', jobId: job.id, stuckAt: '文档还是没有', tried: ['问了同事'] })).toMatchObject({ ok: true });
    await commitAndEnd(fix, newcomer, { outcome: 'blocked', blocker: '文档还是没有', summary: '做不下去' });
    const before = wakesOf(fix, fix.chief.id).length;
    // 总管被叫醒的回合里什么都不做（只结束回合）：之后总管再被兜底叫醒，最终要么处理，要么中心建「停住了」条目。
    await nextPacket(fix, fix.chief.id);
    await commitAndEnd(fix, fix.chief.id, { outcome: 'progress', summary: '先看一下' });
    for (let i = 0; i < 36; i += 1) {
      await tick(fix, 10 * MINUTE);
      if (runningOf(fix, fix.chief.id)) await commitAndEnd(fix, fix.chief.id, { outcome: 'progress', summary: '还没处理' }).catch(() => undefined);
    }
    const open = openOf(fix, job.id);
    expect(wakesOf(fix, fix.chief.id).length > before || open.length > 0).toBe(true);
    expect(open.map(row => row.subjectKey.split(':')[2])).toContain('stall');
    expect(theJob(fix).inboxId).toBe(open[0]!.id);
  });
});

describe('每条解除受阻的路径之后，没有开着的说明或「停住了」条目，编号为空', () => {
  it('回答（answer）', async () => {
    const { fix, job } = await executorBlocked();
    await nextPacket(fix, fix.chief.id);
    plant(fix, job.id, 'stall');
    const answered = await callTool(fix, bot(fix, fix.chief.id), 'hub_job_manage', { mode: 'answer', jobId: job.id, to: '林舟',
      text: '报价接口的文档在仓库的 docs 目录里', basis: [{ section: 'doneWhen', no: 1 }] });
    expect(answered, JSON.stringify(answered)).toMatchObject({ ok: true });
    expect(theJob(fix).state).not.toBe('blocked');
    expectReleased(fix, job.id);
  });

  it('转交材料（forward）', async () => {
    const { fix, job } = await executorBlocked();
    await chiefEnds(fix);
    plant(fix, job.id, 'escalate');
    await ownerSays(fix, fix.chief.id, '这是接口文档');
    const forwarded = await callTool(fix, bot(fix, fix.chief.id), 'hub_job_manage', { mode: 'forward', jobId: job.id, title: '接口文档', text: '报价接口在 docs 目录' });
    expect(forwarded, JSON.stringify(forwarded)).toMatchObject({ ok: true });
    expect(theJob(fix).state).not.toBe('blocked');
    expectReleased(fix, job.id);
  });

  it('换执行者（reassign executor）', async () => {
    const { fix, job } = await executorBlocked();
    await nextPacket(fix, fix.chief.id);
    plant(fix, job.id, 'escalate');
    expect(await callTool(fix, bot(fix, fix.chief.id), 'hub_job_manage', { mode: 'reassign', jobId: job.id, executor: '小周' })).toMatchObject({ ok: true });
    expectReleased(fix, job.id);
  });

  it('换核对人（reassign reviewer）：核对环节没有动静而受阻，条目是「停住了」', async () => {
    const { fix, job, info } = await started();
    await engineerSubmits(fix, info);
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '已交回' });
    const stuck = theJob(fix);
    // 核对人没有动静：受阻（执行者原因）、解除后回到核对中。
    fix.ctx.store.table('jobs').put({ ...applyJobAction(stuck, { type: 'block', kind: 'executor', no: null, text: '连续两次叫醒都没有进展' }, fix.ctx.clock.now()) });
    plant(fix, job.id, 'stall');
    await chiefEnds(fix);
    await ownerSays(fix, fix.chief.id, '换个人核对');
    const swapped = await callTool(fix, bot(fix, fix.chief.id), 'hub_job_manage', { mode: 'reassign', jobId: job.id, reviewer: '总管' });
    expect(swapped, JSON.stringify(swapped)).toMatchObject({ ok: true });
    expectReleased(fix, job.id);
  });

  it('员工恢复在岗', async () => {
    const { fix, job } = await started();
    await lifecycleAction(fix.ctx, { botId: fix.engineer.id, action: 'suspend' });
    expect(theJob(fix)).toMatchObject({ state: 'blocked', blocked: { kind: 'participant_off' } });
    plant(fix, job.id, 'stall');
    await lifecycleAction(fix.ctx, { botId: fix.engineer.id, action: 'reinstate' });
    expect(theJob(fix).state).not.toBe('blocked');
    expectReleased(fix, job.id);
  });

  it('主人选办法（不带改动的办法）：说明条目已回答，其余受阻条目撤回，编号为空', async () => {
    const { fix, job } = await executorBlocked();
    await escalateFromPacket(fix, [
      { title: '换小周做', detail: '换一位执行者重做；代价是多花一轮时间' }, { title: '先等文档', detail: '等文档到了再做；代价是交付时间会晚' }]);
    expect(await fix.hub.api.chooseJobOption({ jobId: job.id, stage: 1, option: 0 })).toMatchObject({ ok: true });
    expectReleased(fix, job.id);
  });

  it('答复回合上限（P76f 起选项是「追加 n 个回合」，原「再给 8 个回合」）', async () => {
    const { fix, job } = await executorBlocked();
    fix.ctx.store.table('jobs').patch(job.id, { turnsUsed: job.turnCap });
    await tick(fix, 10 * MINUTE);
    const cap = openOf(fix, job.id).find(row => row.subjectKey.includes(':cap:'));
    const item = cap ?? plant(fix, job.id, 'cap');
    expect(item.options[0]).toMatch(/^追加 \d+ 个回合$/);
    expect(await fix.hub.api.answerJobCap({ jobId: job.id, answer: item.options[0]! })).toMatchObject({ ok: true });
    expectReleased(fix, job.id);
  });

  it('答复「再叫一次」：条目已回答，编号为空', async () => {
    const { fix, job } = await executorBlocked();
    plant(fix, job.id, 'stall');
    expect(await fix.hub.api.answerJobStall({ jobId: job.id, answer: '再提醒一次' })).toMatchObject({ ok: true });
    expectReleased(fix, job.id);
  });

  it('先停下之后总管恢复（resume）', async () => {
    const { fix, job } = await executorBlocked();
    plant(fix, job.id, 'stall');
    expect(await fix.hub.api.answerJobStall({ jobId: job.id, answer: '暂停' })).toMatchObject({ ok: true });
    expect(theJob(fix).blocked).toMatchObject({ kind: 'owner_hold' });
    // 先停下之后又出现了一条不该留着的条目（例如中途出错留下的），恢复时一并撤回。
    plant(fix, job.id, 'escalate');
    await chiefEnds(fix);
    await ownerSays(fix, fix.chief.id, '接着做吧');
    const resumed = await callTool(fix, bot(fix, fix.chief.id), 'hub_job_manage', { mode: 'resume', jobId: job.id });
    expect(resumed, JSON.stringify(resumed)).toMatchObject({ ok: true });
    // P74r6 改了预期：原来断言「不再受阻」；现在执行者做不下去的事暂停后恢复，回到原来的受阻（由总管处理），不再直接回到执行中。
    expect(theJob(fix)).toMatchObject({ state: 'blocked', blocked: { kind: 'executor' } });
    expectReleased(fix, job.id);
  });
});

describe('巡检的自我修复', () => {
  it('条目编号指向已关闭的条目：巡检之后清掉，并记一条日志', async () => {
    const { fix, job } = await executorBlocked();
    const item = plant(fix, job.id, 'stall');
    fix.ctx.store.table('inbox').patch(item.id, { status: 'answered', answer: '再提醒一次', answeredAt: fix.ctx.clock.now() });
    expect(theJob(fix).inboxId).toBe(item.id);
    await tick(fix, MINUTE);
    expect(theJob(fix).inboxId).toBeNull();
  });

  it('条目编号指向不存在的条目：巡检之后清掉', async () => {
    const { fix, job } = await executorBlocked();
    fix.ctx.store.table('jobs').patch(job.id, { inboxId: 'i_zzzzzzzzzz' });
    await tick(fix, MINUTE);
    expect(theJob(fix).inboxId).toBeNull();
  });

  it('不在受阻、不在等验收，却有开着的说明条目：巡检之后撤回；「没有进展」条目不撤回（P76g：停摆、空转、逾期的事本来就在进行中）', async () => {
    const { fix, job } = await started();
    const escalate = plant(fix, job.id, 'escalate');
    expect(theJob(fix).state).toBe('doing');
    await tick(fix, MINUTE);
    expect(fix.ctx.store.table('inbox').get(escalate.id)).toMatchObject({ status: 'withdrawn' });
    expect(theJob(fix).inboxId).toBeNull();
    // 原来这里断言「停住了」条目同样被撤回（它只在受阻、或总管自己核对时才有）；P76g 起进行中的事也会有「没有进展」条目，所以不撤回。
    const stall = plant(fix, job.id, 'stall');
    await tick(fix, MINUTE);
    expect(fix.ctx.store.table('inbox').get(stall.id)).toMatchObject({ status: 'open' });
  });

  it('仍在受阻时条目不被误撤；总管自己核对没有动静时的「停住了」条目不被误撤', async () => {
    const { fix, job } = await executorBlocked();
    const item = plant(fix, job.id, 'stall');
    await tick(fix, MINUTE);
    expect(fix.ctx.store.table('inbox').get(item.id)).toMatchObject({ status: 'open' });
    expect(theJob(fix).inboxId).toBe(item.id);
    // 总管自己核对（没有核对人）、状态是核对中：「停住了」条目有效。
    const { fix: other, job: running, info } = await started();
    await engineerSubmits(other, info);
    other.ctx.store.table('jobs').patch(running.id, { reviewerId: null });
    const stall = plant(other, running.id, 'stall');
    await tick(other, MINUTE);
    expect(other.ctx.store.table('inbox').get(stall.id)).toMatchObject({ status: 'open' });
    expect(threadOf(other.ctx, other.chief.id).length).toBeGreaterThan(0);
  });
});

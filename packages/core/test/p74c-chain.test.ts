/**
 * P74c 的测试：执行链的回合计数、续排、兜底、回合上限、重试、合并，以及交账的限制与回复落点。
 * 全部走真实 Hub（真实的启动整理和显著性数值），时间用注入的假时钟；不用人为调高分值的候选。
 * 员工是 Hub 启动整理后的默认（听吩咐、安静节奏）；有一条测试专门断言这一点，防止夹具悄悄变了。
 */
import { describe, expect, it } from 'vitest';
import { createTicket } from '../src/wake/ticket.js';
import { appendJobEvent } from '../src/job/store.js';
import { applyJobAction } from '../src/job/state.js';
import { enqueueJobWake } from '../src/job/chain.js';
import { sweepJobs } from '../src/job/sweep.js';
import { blockForTurnCap } from '../src/job/cap.js';
import { routeCommit } from '../src/commit/effects.js';
import { selectNext } from '../src/scheduler/select.js';
import { sendOwnerMessage } from '../src/outreach/thread.js';
import { jobProgressForTopic } from '../src/api/job-topic-views.js';
import { goalFixture } from './model-fixtures.js';
import { jobDelayNote } from '../src/job/delay.js';
import { createInboxItem } from '../src/outreach/inbox.js';
import { raiseAlert } from '../src/health/alerts.js';
import { onQuotaError } from '../src/quota/window.js';
import { localParts } from '../src/util/time.js';
import type { Commit } from '../src/model/index.js';
import {
  MINUTE, assigned, bot, commitAndEnd, commitAs, countEvents, endTurn, entriesOf, eventsOf, jobFix, runningJob, runningOf,
  theJob, tick, topicMessages, wakesOf, type JobFix,
} from './p74c-fixtures.js';
import { threadOf } from './p74b-fixtures.js';
import { advanceSweeping } from './p76g-fixtures.js';

/** 给主人看的文字里不许出现的内部名称。 */
const INTERNAL = /hub_|b_[0-9a-z]{10}|job_|agr_|jev_/;

/** 让时间过去、调度一次，直到这位员工拿到一个回合（最多试几次，防止永远等下去）。 */
async function untilRunning(fix: JobFix, botId: string, step = 5 * MINUTE): Promise<void> {
  for (let i = 0; i < 6 && !runningOf(fix, botId); i += 1) await tick(fix, step);
  expect(runningOf(fix, botId), '应该已经拿到一个回合').toBeDefined();
}

describe('夹具自检', () => {
  it('员工是启动整理之后的默认：听吩咐', async () => {
    const fix = await jobFix();
    expect(bot(fix, fix.engineer.id).onDemand).toBe(true);
    expect(bot(fix, fix.reviewer.id).onDemand).toBe(true);
  });
});

describe('7 回合计数', () => {
  it('建唤醒单后 turnsUsed 加一；执行者的第一个回合把待开工变成执行中', async () => {
    const fix = await jobFix();
    const { job } = await assigned(fix);
    expect(job).toMatchObject({ state: 'ready', turnsUsed: 0, startedAt: null });
    await runningJobAfterAssign(fix);
    const after = theJob(fix);
    expect(after).toMatchObject({ state: 'doing', turnsUsed: 1 });
    expect(after.startedAt).not.toBeNull();
    expect(wakesOf(fix, fix.engineer.id, job.id)).toHaveLength(1);
    expect(wakesOf(fix, fix.engineer.id, job.id)[0]).toMatchObject({ jobId: job.id, ownerInitiated: false });
  });

  it('主人发起的总管回合不加；总管的非主人发起回合加一但不开工；核对人的回合加一也不开工', async () => {
    const fix = await jobFix();
    const { job } = await assigned(fix);
    const candidate = (botId: string, ownerInitiated: boolean) => ({
      ...entriesOf(fix, fix.engineer.id, job.id)[0]!, id: 'q_0000000001', botId, ownerInitiated,
    });
    createTicket(fix.ctx, candidate(fix.chief.id, true), null);
    expect(theJob(fix).turnsUsed).toBe(0);
    createTicket(fix.ctx, candidate(fix.chief.id, false), null);
    expect(theJob(fix)).toMatchObject({ turnsUsed: 1, state: 'ready' });
    createTicket(fix.ctx, candidate(fix.reviewer.id, false), null);
    expect(theJob(fix)).toMatchObject({ turnsUsed: 2, state: 'ready' });
    // 不属于任何一件事的唤醒不动它。
    const { jobId: _ignored, ...plain } = candidate(fix.engineer.id, false);
    createTicket(fix.ctx, plain, null);
    expect(theJob(fix).turnsUsed).toBe(2);
  });

  it('唤醒因主人占用会话而被撤回、没有真正开始时，退还那一个回合（并还原开工）', async () => {
    const fix = await jobFix();
    await assigned(fix);
    await runningJobAfterAssign(fix, { hold: true });
    // 林舟的会话被主人占用：调度只删掉占位的唤醒单，候选留着。
    const job = theJob(fix);
    expect(job).toMatchObject({ turnsUsed: 0, state: 'ready' });
    expect(entriesOf(fix, fix.engineer.id, job.id)).toHaveLength(1);
  });
});

/** 总管结束回合；需要时先让林舟的会话显示为「主人正占用」。时间推进 10 分钟后调度一次。 */
async function runningJobAfterAssign(fix: JobFix, options: { hold?: boolean } = {}): Promise<void> {
  const { speak } = await import('./p74c-fixtures.js');
  await speak(fix, fix.chief, '这件事由林舟执行，评审甲核对。', { outcome: 'progress' });
  if (options.hold) fix.ctx.host.sessions.set(bot(fix, fix.engineer.id).sessionId!, { exists: true, running: true, contextRatio: 0 });
  await tick(fix, 10 * MINUTE);
  if (!options.hold) expect(runningOf(fix, fix.engineer.id), '林舟应该已经拿到第一个回合').toBeDefined();
}

describe('8 续排', () => {
  it('执行者交账 progress 且没有交回：续排一次（带 jobId 的 next_think 候选），放行后回合数加一', async () => {
    const fix = await jobFix();
    const { job } = await runningJob(fix);
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '做了第一步', reply: '先搭好了页面骨架' });
    const queued = entriesOf(fix, fix.engineer.id, job.id);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ jobId: job.id, subjectKey: `jobwake:${job.id}:${fix.engineer.id}`, reason: { kind: 'next_think', ownerSummary: '继续做「会员定价页」' } });
    expect(queued[0]!.reason.ownerSummary).not.toMatch(INTERNAL);
    await tick(fix, 5 * MINUTE);
    expect(wakesOf(fix, fix.engineer.id, job.id)).toHaveLength(2);
    expect(theJob(fix)).toMatchObject({ turnsUsed: 2, state: 'doing' });
  });

  it('outcome 为 done 也续排（done 不等于已交回）', async () => {
    const fix = await jobFix();
    const { job } = await runningJob(fix);
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'done', summary: '页面做完了' });
    expect(entriesOf(fix, fix.engineer.id, job.id)).toHaveLength(1);
  });

  it('no_change：这件事受阻（执行者做不下去），总管被叫醒，工作往来落一条，不续排', async () => {
    const fix = await jobFix();
    const { job } = await runningJob(fix);
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'no_change', summary: '没有进展', blocker: null });
    const blocked = theJob(fix);
    expect(blocked).toMatchObject({ state: 'blocked', blocked: { kind: 'executor', resumeTo: 'doing' } });
    expect(blocked.blocked!.text).toBe('没有进展');
    // 总管被叫醒：队列里有一条给总管的 escalate 候选（给主人看的短句「等待写说明」）。
    const chiefEntries = entriesOf(fix, fix.chief.id, job.id);
    expect(chiefEntries).toHaveLength(1);
    expect(chiefEntries[0]!.reason.ownerSummary).toBe('等待写说明');
    expect(entriesOf(fix, fix.engineer.id, job.id)).toHaveLength(0);
    // 事件与工作往来。
    expect(countEvents(fix, job.id, 'executor_blocked')).toBe(1);
    const work = topicMessages(fix, job).filter(row => row.kind === 'work' && row.text.includes('无法继续'));
    expect(work).toHaveLength(1);
    expect(work[0]!.text).toBe('林舟无法继续：没有进展。已告诉总管。');
    expect(work[0]!.text).not.toMatch(INTERNAL);
    // 进度行如实显示受阻。
    expect(jobProgressForTopic(fix.ctx, job.topicId)).toMatchObject({ stateLabel: '受阻' });
  });

  it('blocked 且写了 blocker：受阻说明取 blocker', async () => {
    const fix = await jobFix();
    await runningJob(fix);
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'blocked', summary: '卡住了', blocker: '缺少价格表' });
    expect(theJob(fix)).toMatchObject({ state: 'blocked', blocked: { kind: 'executor', text: '缺少价格表' } });
  });

  it('反例：本回合已有 submitted 事件时不续排，也不判做不下去', async () => {
    const fix = await jobFix();
    const { job } = await runningJob(fix);
    appendJobEvent(fix.ctx, { jobId: job.id, actor: fix.engineer.id, kind: 'submitted', to: [fix.reviewer.id], refId: null, data: {} });
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '已交回' });
    expect(entriesOf(fix, fix.engineer.id, job.id)).toHaveLength(0);
    const same = await jobFix();
    const second = await runningJob(same);
    appendJobEvent(same.ctx, { jobId: second.job.id, actor: same.engineer.id, kind: 'submitted', to: [same.reviewer.id], refId: null, data: {} });
    await commitAndEnd(same, same.engineer.id, { outcome: 'no_change', summary: '没有新变化' });
    expect(theJob(same).state).toBe('doing');
    expect(entriesOf(same, same.chief.id, second.job.id)).toHaveLength(0);
  });

  it('反例：已经提问（asked 事件，或 openAsk 非空）、已经说明做不下去（executor_blocked 事件）后不续排', async () => {
    for (const mode of ['asked', 'openAsk', 'executor_blocked'] as const) {
      const fix = await jobFix();
      const { job } = await runningJob(fix);
      if (mode === 'openAsk') {
        const eventId = appendJobEvent(fix.ctx, { jobId: job.id, actor: fix.engineer.id, kind: 'asked', to: [fix.chief.id], refId: null, data: {} }).id;
        fix.ctx.store.table('jobs').patch(job.id, { openAsk: { eventId, fromId: fix.engineer.id, at: fix.ctx.clock.now() } });
        // 只看 openAsk：把 asked 事件的时间挪到本回合之前，让它不算「本回合产生的」。
      } else {
        appendJobEvent(fix.ctx, { jobId: job.id, actor: fix.engineer.id, kind: mode, to: [fix.chief.id], refId: null, data: {} });
      }
      await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '问了一个问题' });
      expect(entriesOf(fix, fix.engineer.id, job.id), mode).toHaveLength(0);
    }
  });

  it('反例：总管的执行链回合不续排', async () => {
    const fix = await jobFix();
    const { job } = await runningJob(fix);
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'no_change', summary: '没有进展' });
    // 总管被叫醒做 escalate，他的回合交账 progress 之后不续排。
    await untilRunning(fix, fix.chief.id);
    expect(wakesOf(fix, fix.chief.id, job.id)).toHaveLength(1);
    await commitAndEnd(fix, fix.chief.id, { outcome: 'progress', summary: '已处理', reply: '我来看看' });
    expect(entriesOf(fix, fix.chief.id, job.id)).toHaveLength(0);
  });

  it('中心替没交账的回合合成的交账不算「做不下去」：按还没做完续排', async () => {
    const fix = await jobFix();
    const { job } = await runningJob(fix);
    await endTurn(fix, fix.engineer.id); // 没有调用 hub_commit
    expect(theJob(fix).state).toBe('doing');
    expect(entriesOf(fix, fix.engineer.id, job.id)).toHaveLength(1);
  });

  it('续排的候选不会被同一位员工别的回合的交账顺手清掉', async () => {
    const fix = await jobFix();
    const { job } = await runningJob(fix);
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '做了第一步' });
    const kept = entriesOf(fix, fix.engineer.id, job.id)[0]!;
    // 同一位员工另有一个不属于这件事的回合交账（process 里会清理旧的 next_think / light_check 候选）。
    fix.ctx.store.table('wakes').put({ ...wakesOf(fix, fix.engineer.id)[0]!, id: 'w_0000000099', jobId: undefined, status: 'running', endedAt: null, commitId: null,
      sessionId: bot(fix, fix.engineer.id).sessionId, startedAt: fix.ctx.clock.now() });
    const result = await commitAs(fix, fix.engineer.id, { outcome: 'no_change', summary: '别的事' });
    expect(result.ok).toBe(true);
    expect(entriesOf(fix, fix.engineer.id, job.id).map(row => row.id)).toContain(kept.id);
  });
});

describe('9 核对人的续排', () => {
  /** 林舟交回（直接改状态）、评审甲被叫去核对，评审甲拿到一个回合。 */
  async function reviewerRunning(fix: JobFix) {
    const { job } = await runningJob(fix);
    appendJobEvent(fix.ctx, { jobId: job.id, actor: fix.engineer.id, kind: 'submitted', to: [fix.reviewer.id], refId: null, data: {} });
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '已交回' });
    const checking = applyJobAction(theJob(fix), { type: 'submit' }, fix.ctx.clock.now());
    fix.ctx.store.table('jobs').put(checking);
    expect(enqueueJobWake(fix.ctx, { job: checking, botId: fix.reviewer.id, why: 'to_review', eventId: null, summary: '请核对' })).not.toBeNull();
    await untilRunning(fix, fix.reviewer.id);
    return { job: checking };
  }

  it('核对人交账没有结论：续排一次；同一轮不再续排第二次', async () => {
    const fix = await jobFix();
    const { job } = await reviewerRunning(fix);
    await commitAndEnd(fix, fix.reviewer.id, { outcome: 'progress', summary: '看了一部分' });
    expect(entriesOf(fix, fix.reviewer.id, job.id)).toHaveLength(1);
    expect(eventsOf(fix.ctx, job.id).filter(row => row.kind === 'resumed' && row.data.continue === true)).toHaveLength(1);
    await untilRunning(fix, fix.reviewer.id);
    await commitAndEnd(fix, fix.reviewer.id, { outcome: 'progress', summary: '还是没有结论' });
    expect(entriesOf(fix, fix.reviewer.id, job.id)).toHaveLength(0);
    expect(wakesOf(fix, fix.reviewer.id, job.id)).toHaveLength(2);
  });

  it('反例：本回合已有 reviewed 事件时不续排', async () => {
    const fix = await jobFix();
    const { job } = await reviewerRunning(fix);
    appendJobEvent(fix.ctx, { jobId: job.id, actor: fix.reviewer.id, kind: 'reviewed', to: [fix.chief.id], refId: null, data: {} });
    await commitAndEnd(fix, fix.reviewer.id, { outcome: 'progress', summary: '已给结论' });
    expect(entriesOf(fix, fix.reviewer.id, job.id)).toHaveLength(0);
  });
});

describe('10 兜底', () => {
  /** 派活后把队列里的候选拿掉（模拟唤醒丢了），林舟没有排队、没有在跑。 */
  async function lostWake(fix: JobFix) {
    const { job } = await assigned(fix);
    for (const entry of entriesOf(fix, fix.engineer.id, job.id)) fix.ctx.store.table('queue').remove(entry.id);
    return job;
  }
  const sweep = (fix: JobFix) => sweepJobs(fix.ctx, fix.ctx.clock.now());
  const dropQueued = (fix: JobFix, jobId: string) => {
    for (const entry of entriesOf(fix, fix.engineer.id, jobId)) fix.ctx.store.table('queue').remove(entry.id);
  };

  // P76g：第三块的兜底（30 分钟无事件叫醒、叫两次转受阻叫总管）已整段删除，由停滞判断替代（job/stall-check.ts）。
  // 下面四条原来的原意是「接力断了不会无声停下」「有候选、有回合在跑、人不在岗不叫」「总管恢复在岗后重新叫他」：
  // 现在改为本卡口径：2 小时没有记录才重新唤醒一次，再过 1 小时仍没有记录才通知你（不再转受阻、不叫总管）。
  it('1 小时 50 分不动；满 2 小时重新唤醒一次（候选、事件）；已排上队再巡检不重复；再过 1 小时仍没有记录通知你，不转受阻、不叫总管', async () => {
    const fix = await jobFix();
    const job = await lostWake(fix);
    advanceSweeping(fix, 110 * MINUTE);
    expect(entriesOf(fix, fix.engineer.id, job.id)).toHaveLength(0);
    expect(countEvents(fix, job.id, 'resumed')).toBe(0);

    advanceSweeping(fix, 10 * MINUTE);
    expect(entriesOf(fix, fix.engineer.id, job.id)).toHaveLength(1);
    expect(entriesOf(fix, fix.engineer.id, job.id)[0]).toMatchObject({ reason: { kind: 'next_think', ownerSummary: '继续做「会员定价页」' } });
    expect(eventsOf(fix.ctx, job.id).filter(row => row.kind === 'resumed' && row.data.idle === true)).toHaveLength(1);
    expect(fix.ctx.store.table('jobNotices').get(job.id)!.rewakeAt).toBe(fix.ctx.clock.now());
    // 已经排上队，再巡检不会重复叫。
    advanceSweeping(fix, 30 * MINUTE);
    expect(entriesOf(fix, fix.engineer.id, job.id)).toHaveLength(1);
    expect(countEvents(fix, job.id, 'resumed')).toBe(1);

    // 被叫醒的回合没有留下任何记录就结束了（候选没了、也没有新事件）：再过 1 小时通知你。
    dropQueued(fix, job.id);
    advanceSweeping(fix, 20 * MINUTE);
    expect(fix.ctx.store.table('inbox').list(row => row.subjectKey.startsWith(`job:${job.id}:stall:`))).toHaveLength(0);
    advanceSweeping(fix, 10 * MINUTE);
    const items = fix.ctx.store.table('inbox').list(row => row.subjectKey.startsWith(`job:${job.id}:stall:`));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ title: '会员定价页：没有进展', status: 'open' });
    expect(theJob(fix)).toMatchObject({ state: 'ready', blocked: null });
    expect(entriesOf(fix, fix.chief.id, job.id)).toHaveLength(0);
    expect(countEvents(fix, job.id, 'resumed')).toBe(1);
  });

  it('中间有别的事件：重新唤醒之后出现新记录，计时重新开始（rewakeAt 清空），再满 2 小时才重新唤醒第二次', async () => {
    const fix = await jobFix();
    const job = await lostWake(fix);
    advanceSweeping(fix, 120 * MINUTE);
    expect(countEvents(fix, job.id, 'resumed')).toBe(1);
    dropQueued(fix, job.id);
    advanceSweeping(fix, 10 * MINUTE);
    appendJobEvent(fix.ctx, { jobId: job.id, actor: fix.chief.id, kind: 'forwarded', to: [fix.engineer.id], refId: null, data: {} });
    advanceSweeping(fix, 60 * MINUTE);
    // 有了新记录：不通知，rewakeAt 已清空。
    expect(fix.ctx.store.table('inbox').list(row => row.subjectKey.startsWith(`job:${job.id}:stall:`))).toHaveLength(0);
    expect(fix.ctx.store.table('jobNotices').get(job.id)!.rewakeAt).toBeNull();
    expect(countEvents(fix, job.id, 'resumed')).toBe(1);
    // 从新记录算起再满 2 小时，才重新唤醒第二次。
    advanceSweeping(fix, 50 * MINUTE);
    expect(countEvents(fix, job.id, 'resumed')).toBe(1);
    advanceSweeping(fix, 20 * MINUTE);
    expect(countEvents(fix, job.id, 'resumed')).toBe(2);
    expect(theJob(fix).state).toBe('ready');
    expect(entriesOf(fix, fix.engineer.id, job.id)).toHaveLength(1);
  });

  it('反例：有候选排着、有回合在跑、预期的人不在岗，都不重新唤醒', async () => {
    const fix = await jobFix();
    const { job } = await assigned(fix);
    advanceSweeping(fix, 150 * MINUTE);
    sweep(fix); // 候选还排着
    expect(countEvents(fix, job.id, 'resumed')).toBe(0);
    for (const entry of entriesOf(fix, fix.engineer.id, job.id)) fix.ctx.store.table('queue').remove(entry.id);
    fix.ctx.store.table('bots').patch(fix.engineer.id, { lifecycle: 'paused' });
    sweep(fix); // 预期的人停用了
    expect(countEvents(fix, job.id, 'resumed')).toBe(0);
    expect(entriesOf(fix, fix.engineer.id, job.id)).toHaveLength(0);
    // 他恢复在岗之后，下一次巡检就叫他。
    fix.ctx.store.table('bots').patch(fix.engineer.id, { lifecycle: 'active' });
    sweep(fix);
    expect(entriesOf(fix, fix.engineer.id, job.id)).toHaveLength(1);
  });

  it('反例：回合在跑时不重新唤醒', async () => {
    const fix = await jobFix();
    const { job } = await runningJob(fix);
    advanceSweeping(fix, 150 * MINUTE);
    expect(countEvents(fix, job.id, 'resumed')).toBe(0);
  });

  it('总管在等的事（执行者做不下去、总管停用了）：总管恢复在岗后，下一次巡检重新叫他', async () => {
    const fix = await jobFix();
    const { job } = await runningJob(fix);
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'no_change', summary: '没有进展' });
    // 总管此刻停用：队列被清，唤醒丢了。
    fix.ctx.store.table('bots').patch(fix.chief.id, { lifecycle: 'paused' });
    for (const entry of entriesOf(fix, fix.chief.id, job.id)) fix.ctx.store.table('queue').remove(entry.id);
    advanceSweeping(fix, 130 * MINUTE);
    expect(entriesOf(fix, fix.chief.id, job.id)).toHaveLength(0);
    fix.ctx.store.table('bots').patch(fix.chief.id, { lifecycle: 'active' });
    sweep(fix);
    expect(entriesOf(fix, fix.chief.id, job.id)).toHaveLength(1);
  });
});

describe('11 回合上限', () => {
  it('用到上限：受阻（turn_cap），队列里这件事的候选清空，总管私聊一句，「待你处理」恰好一条（没有默认选项、不到期）', async () => {
    const fix = await jobFix();
    // P76e：派活的预算线按预计算（首次估计是 8）；这条证明的是「用到预算线时受阻、条目恰好一条」，与线的取值无关，显式设回 16（文案里的 16、再给 8 个照旧）。
    const { job } = await assigned(fix, { turnCap: 16 });
    fix.ctx.store.table('jobs').patch(job.id, { turnsUsed: job.turnCap });
    expect(entriesOf(fix, fix.engineer.id, job.id)).toHaveLength(1);
    sweepJobs(fix.ctx, fix.ctx.clock.now());
    const blocked = theJob(fix);
    expect(blocked).toMatchObject({ state: 'blocked', blocked: { kind: 'turn_cap', text: '已用到预计消耗' } });
    expect(fix.ctx.store.table('queue').list(row => row.jobId === job.id)).toHaveLength(0);
    expect(countEvents(fix, job.id, 'turn_cap')).toBe(1);
    // P76f：有预计的事，条目改为「已用到预计消耗」，三个办法；私聊落「已停下」那一句（文字见 budget-text.ts）。
    const said = threadOf(fix.ctx, fix.chief.id).filter(row => row.from === fix.chief.id && row.text.includes('已停下'));
    expect(said.map(row => row.text)).toEqual(['会员定价页已用到预计的 9 回合，已停下，在等你决定。']);
    const items = fix.ctx.store.table('inbox').list(row => row.subjectKey.startsWith(`job:${job.id}:`));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ botId: fix.chief.id, type: 'question', status: 'open', defaultOption: null, expiresAt: null,
      title: '会员定价页：已用到预计消耗', options: ['追加 2 个回合', '缩小范围', '暂停'], subjectKey: `job:${job.id}:cap:16` });
    expect(items[0]!.body.split('\n')[0]).toBe('已用 1 回合，预计 9，估计共需 18 回合。');
    expect(blocked.inboxId).toBe(items[0]!.id);
    for (const text of [said[0]!.text, items[0]!.title, items[0]!.body]) expect(text).not.toMatch(INTERNAL);
    // 再巡检不会重复。
    sweepJobs(fix.ctx, fix.ctx.clock.now());
    expect(fix.ctx.store.table('inbox').list(row => row.subjectKey.startsWith(`job:${job.id}:`))).toHaveLength(1);
    expect(countEvents(fix, job.id, 'turn_cap')).toBe(1);
  });

  it('最后一个回合还在跑时不动它；回合结束后才停', async () => {
    const fix = await jobFix();
    const { job } = await runningJob(fix);
    fix.ctx.store.table('jobs').patch(job.id, { turnsUsed: job.turnCap });
    expect(blockForTurnCap(fix.ctx, job.id, fix.ctx.clock.now())).toBe(false);
    expect(theJob(fix).state).toBe('doing');
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '做到一半' });
    await tick(fix, 1_000);
    expect(theJob(fix)).toMatchObject({ state: 'blocked', blocked: { kind: 'turn_cap' } });
    expect(entriesOf(fix, fix.engineer.id, job.id)).toHaveLength(0);
  });

  it('续排与兜底都计入上限：不断续排，到 16 个回合后不再产生新的回合；受阻，「待你处理」恰好一条', async () => {
    // P76d 修改：原来靠「起始回合数 8」让一个窗口放行 8 个回合；额度灯现在按员工份额的 token 比例算，
    // 所以第一个回合结束后按它实测的 token 把窗口估计容量设成「员工份额恰好够 8 个回合」，其余写法与原意不变。
    const fix = await jobFix();
    const { job } = await runningJob(fix, { turnCap: 16 }); // P76e：显式把预算线设回 16（这条要走满 16 个回合）
    // 执行者每个回合都交账 progress（永远不交回）；每次交账后中心续排，直到用到上限。
    // 额度灯红灯仍是全局保护，执行链照常受它约束：一个额度窗口放行有限个回合，用完（员工份额用满，亮红灯）要等下一个窗口，
    // 所以这里遇到灯亮就把时间推过一个窗口（5 小时）再继续。橙灯（P74 合并裁定）不再拦执行链，只有红灯拦。
    const window = 5 * 60 * MINUTE + MINUTE;
    let waited = 0;
    for (let turn = 1; turn <= 40; turn += 1) {
      if (!runningOf(fix, fix.engineer.id)) {
        if (theJob(fix).state === 'blocked') break;
        // 额度灯红：候选没有丢，仍排在队列里，进度行说明恢复时间。
        expect(fix.ctx.store.table('queue').count(row => row.jobId === job.id)).toBe(1);
        expect(jobProgressForTopic(fix.ctx, job.topicId)!.delayNote).toMatch(/^额度恢复，约 \d\d:\d\d 继续$/);
        await tick(fix, window);
        waited += 1;
        if (!runningOf(fix, fix.engineer.id)) break;
      }
      await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: `第 ${turn} 步` });
      if (turn === 1) {
        const first = fix.ctx.store.log('ledger').all().at(-1)!;
        const plan = fix.ctx.store.table('quotaWindows').get('quota')!;
        // 员工份额 = 容量 x 0.7，设成恰好 8 个这样的回合；用了 1 个，第 8 个回合结束时到红线。
        fix.ctx.store.table('quotaWindows').put({ ...plan, capacityTokens: Math.ceil(first.tokenBase! * 8 / fix.ctx.settings.botQuotaShare) });
      }
      await tick(fix, 5 * MINUTE);
    }
    expect(waited).toBeGreaterThanOrEqual(1);
    const wakes = wakesOf(fix, fix.engineer.id, job.id);
    expect(wakes).toHaveLength(16);
    expect(theJob(fix)).toMatchObject({ state: 'blocked', turnsUsed: 16, blocked: { kind: 'turn_cap' } });
    expect(fix.ctx.store.table('queue').list(row => row.jobId === job.id)).toHaveLength(0);
    const items = fix.ctx.store.table('inbox').list(row => row.subjectKey.startsWith(`job:${job.id}:`));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ status: 'open', defaultOption: null, expiresAt: null });
    // 兜底也不能越过上限：久等之后再巡检、再调度，仍没有新的回合。
    for (let i = 0; i < 4; i += 1) await tick(fix, 31 * MINUTE);
    expect(wakesOf(fix, fix.engineer.id, job.id)).toHaveLength(16);
    expect(fix.ctx.store.table('inbox').list(row => row.subjectKey.startsWith(`job:${job.id}:`))).toHaveLength(1);
    // 进度行如实显示受阻。
    expect(jobProgressForTopic(fix.ctx, job.topicId)).toMatchObject({ stateLabel: '受阻' });
  });

  it('重新唤醒也计入上限：只靠重新唤醒也不会无限叫', async () => {
    const fix = await jobFix();
    const { job } = await assigned(fix);
    fix.ctx.store.table('jobs').patch(job.id, { turnsUsed: job.turnCap - 1 });
    for (const entry of entriesOf(fix, fix.engineer.id, job.id)) fix.ctx.store.table('queue').remove(entry.id);
    fix.ctx.store.table('wakes').list(row => row.botId === fix.chief.id && row.status === 'running')
      .forEach(row => fix.ctx.store.table('wakes').patch(row.id, { status: 'committed', endedAt: fix.ctx.clock.now() }));
    // P76g：重新唤醒要等 2 小时没有记录（原来的兜底 30 分钟）：前面每步 10 分钟巡检，最后一步整个 tick（巡检加放行）。
    advanceSweeping(fix, 110 * MINUTE);
    fix.ctx.clock.advance(10 * MINUTE);
    await fix.hub.tick(); // 重新唤醒，放行，计入第 16 个回合
    expect(wakesOf(fix, fix.engineer.id, job.id)).toHaveLength(1);
    expect(theJob(fix).turnsUsed).toBe(job.turnCap);
    await endTurn(fix, fix.engineer.id); // 没交账：合成交账，按没做完续排
    await tick(fix, 5 * MINUTE);
    expect(wakesOf(fix, fix.engineer.id, job.id)).toHaveLength(1);
    expect(theJob(fix).state).toBe('blocked');
  });
});

describe('丢弃之后的状态与事实相符', () => {
  it('job_inactive：这件事已在等你验收，旧候选被丢弃并留下带原因的评估记录；状态与进度行不变', async () => {
    const fix = await jobFix();
    const { job } = await assigned(fix);
    fix.ctx.store.table('jobs').put({ ...applyJobAction(applyJobAction(job, { type: 'start' }, fix.ctx.clock.now()), { type: 'submit' }, fix.ctx.clock.now()), state: 'awaiting_owner', deliveredAt: fix.ctx.clock.now() });
    fix.ctx.clock.advance(10 * MINUTE);
    expect(selectNext(fix.ctx, fix.ctx.clock.now())).toBeNull();
    expect(entriesOf(fix, fix.engineer.id, job.id)).toHaveLength(0);
    const log = fix.ctx.store.log('appraisals').all().filter(row => row.botId === fix.engineer.id && row.suppressedBy === 'job_inactive');
    expect(log).toHaveLength(1);
    expect(log[0]!.text).toContain('这件事已不需要这次唤醒');
    expect(theJob(fix).state).toBe('awaiting_owner');
    expect(jobProgressForTopic(fix.ctx, job.topicId)).toMatchObject({ stateLabel: '待你验收' });
  });

  it('job_cap：候选在被选择时丢弃，这件事立刻受阻、私聊一句、「待你处理」一条', async () => {
    const fix = await jobFix();
    const { job } = await assigned(fix);
    fix.ctx.store.table('jobs').patch(job.id, { turnsUsed: job.turnCap });
    fix.ctx.clock.advance(10 * MINUTE);
    expect(selectNext(fix.ctx, fix.ctx.clock.now())).toBeNull();
    expect(theJob(fix)).toMatchObject({ state: 'blocked', blocked: { kind: 'turn_cap' } });
    const log = fix.ctx.store.log('appraisals').all().filter(row => row.botId === fix.engineer.id && row.suppressedBy === 'job_cap');
    expect(log).toHaveLength(1);
    expect(log[0]!.text).toContain('这件事的回合用到上限');
    expect(fix.ctx.store.table('inbox').list(row => row.subjectKey.startsWith(`job:${job.id}:`))).toHaveLength(1);
    expect(jobProgressForTopic(fix.ctx, job.topicId)).toMatchObject({ stateLabel: '受阻' });
  });

  it('paused：员工停用后候选被丢弃（评估记录写明）；这件事的状态不变，他恢复在岗后重新唤醒他', async () => {
    const fix = await jobFix();
    const { job } = await assigned(fix);
    fix.ctx.store.table('bots').patch(fix.engineer.id, { lifecycle: 'paused' });
    fix.ctx.clock.advance(10 * MINUTE);
    expect(selectNext(fix.ctx, fix.ctx.clock.now())).toBeNull();
    expect(entriesOf(fix, fix.engineer.id, job.id)).toHaveLength(0);
    const log = fix.ctx.store.log('appraisals').all().filter(row => row.botId === fix.engineer.id && row.suppressedBy === 'paused');
    expect(log).toHaveLength(1);
    expect(log[0]!.text).toContain('移出队列');
    expect(theJob(fix).state).toBe('ready');
    fix.ctx.store.table('bots').patch(fix.engineer.id, { lifecycle: 'active' });
    // P76g：他恢复在岗后，2 小时没有记录才重新唤醒（原来的兜底 31 分钟）。
    advanceSweeping(fix, 130 * MINUTE);
    expect(entriesOf(fix, fix.engineer.id, job.id)).toHaveLength(1);
  });
});

describe('12 重试保留 jobId', () => {
  it('带 jobId 的回合出错后，重试候选带同一个 jobId 和事项键', async () => {
    const fix = await jobFix();
    const { job } = await runningJob(fix);
    await fix.hub.onTurnEvent({ type: 'error', sessionId: bot(fix, fix.engineer.id).sessionId!, at: fix.ctx.clock.now(), errorText: '执行失败' });
    const retry = fix.ctx.store.table('queue').list(row => row.botId === fix.engineer.id && row.reason.kind === 'retry');
    expect(retry).toHaveLength(1);
    expect(retry[0]).toMatchObject({ jobId: job.id, subjectKey: `jobwake:${job.id}:${fix.engineer.id}` });
  });

  it('投递超过两分钟没有送达（孤儿投递）时：重试候选带同一个 jobId，建唤醒单时计的回合退还', async () => {
    const fix = await jobFix();
    const { job } = await assigned(fix);
    // 模拟调度刚建好唤醒单、还没送达：候选已移出队列，唤醒单停在「投递中」。
    const entry = entriesOf(fix, fix.engineer.id, job.id)[0]!;
    const ticket = createTicket(fix.ctx, entry, null);
    fix.ctx.store.table('queue').remove(entry.id);
    expect(theJob(fix).turnsUsed).toBe(1);
    fix.ctx.store.table('wakes').list(row => row.botId === fix.chief.id && row.status === 'running')
      .forEach(row => fix.ctx.store.table('wakes').patch(row.id, { status: 'committed', endedAt: fix.ctx.clock.now() }));
    await tick(fix, 3 * MINUTE);
    expect(fix.ctx.store.table('wakes').get(ticket.id)).toMatchObject({ status: 'error', dispatchedAt: null });
    const retry = fix.ctx.store.table('queue').list(row => row.botId === fix.engineer.id && row.reason.kind === 'retry');
    expect(retry).toHaveLength(1);
    expect(retry[0]).toMatchObject({ jobId: job.id, subjectKey: `jobwake:${job.id}:${fix.engineer.id}` });
    expect(theJob(fix).turnsUsed).toBe(0);
  });

  it('不属于一件事的回合出错后，重试候选不带 jobId', async () => {
    const fix = await jobFix();
    await assigned(fix);
    // 总管这一回合是主人发起的，没有 jobId。
    await fix.hub.onTurnEvent({ type: 'error', sessionId: bot(fix, fix.chief.id).sessionId!, at: fix.ctx.clock.now(), errorText: '执行失败' });
    const retry = fix.ctx.store.table('queue').list(row => row.botId === fix.chief.id && row.reason.kind === 'retry');
    expect(retry.every(row => row.jobId === undefined)).toBe(true);
  });
});

describe('13 合并', () => {
  it('同一位员工：主人私聊的唤醒和一件事的唤醒不合并；同一件事的两次唤醒合并且保留 jobId', async () => {
    const fix = await jobFix();
    const { job } = await assigned(fix);
    const ownerBefore = fix.ctx.store.table('queue').count();
    sendOwnerMessage(fix.ctx, fix.engineer.id, '你好，先看一下我昨天的留言');
    const rows = entriesOf(fix, fix.engineer.id);
    expect(rows).toHaveLength(2);
    expect(rows.filter(row => row.jobId === job.id)).toHaveLength(1);
    expect(rows.filter(row => row.jobId === undefined)).toHaveLength(1);
    expect(fix.ctx.store.table('queue').count()).toBe(ownerBefore + 1);
    // 同一件事再叫一次：合并。
    const merged = enqueueJobWake(fix.ctx, { job, botId: fix.engineer.id, why: 'forwarded', eventId: null, summary: '总管转来材料' })!;
    expect(merged.jobId).toBe(job.id);
    expect(entriesOf(fix, fix.engineer.id, job.id)).toHaveLength(1);
    expect(entriesOf(fix, fix.engineer.id)).toHaveLength(2);
    expect(entriesOf(fix, fix.engineer.id, job.id)[0]!.reason.evidence).toHaveLength(2);
  });
});

describe('14 交账里的 ownerQuestion', () => {
  const question = { text: '价格定多少？', options: ['九块', '十块'], defaultOption: '九块', whyNeeded: '需要主人定' };

  it('执行者在执行链里带 ownerQuestion 被拒，「待你处理」没有新条目；改正后可以再交账', async () => {
    const fix = await jobFix();
    await runningJob(fix);
    const before = fix.ctx.store.table('inbox').count();
    const refused = await commitAs(fix, fix.engineer.id, { outcome: 'progress', summary: '问问', ownerQuestion: question });
    expect(refused).toEqual({ ok: false, error: '员工不直接问主人。问总管用 hub_job_work 的 ask；做不下去用 block。' });
    expect(fix.ctx.store.table('inbox').count()).toBe(before);
    const again = await commitAs(fix, fix.engineer.id, { outcome: 'progress', summary: '先做别的' });
    expect(again.ok).toBe(true);
  });

  it('总管在执行链（非主人发起）里带 ownerQuestion 被拒；主人发起的执行链回合照旧', async () => {
    const fix = await jobFix();
    const { job } = await runningJob(fix);
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'no_change', summary: '没有进展' });
    await untilRunning(fix, fix.chief.id);
    const before = fix.ctx.store.table('inbox').count();
    const refused = await commitAs(fix, fix.chief.id, { outcome: 'progress', summary: '问主人', ownerQuestion: question });
    // P74r2a（任务卡「四条贯穿全卡的要求」第 4 条）：原文提到 P74f 才有的 escalate，改为只写现在真能做成的做法。
    expect(refused).toEqual({ ok: false, error: '这一回合是处理一件事的回合，不能直接向主人提问。能按约定回答的，用 hub_job_manage 的 answer；要换人，用 hub_job_manage 的 reassign；核对三轮仍不过、或执行者做不下去而你解决不了时，用 hub_job_manage 的 mode escalate 向主人说明并给出办法；执行者或核对人的提问在约定里推不出答案时，用 hub_agreement_submit 的 mode revise 出新版本请主人确认。' });
    expect(fix.ctx.store.table('inbox').count()).toBe(before);
    // 把这一回合改成主人发起的：照旧允许（P74e/P74f 里总管回答主人时会遇到）。
    const wake = runningOf(fix, fix.chief.id)!;
    expect(wake.jobId).toBe(job.id);
    fix.ctx.store.table('wakes').patch(wake.id, { ownerInitiated: true });
    const allowed = await commitAs(fix, fix.chief.id, { outcome: 'needs_owner', summary: '问主人', ownerQuestion: question });
    expect(allowed, JSON.stringify(allowed)).toMatchObject({ ok: true });
  });

  it('不在执行链里的员工回合不受影响', async () => {
    const fix = await jobFix();
    await assigned(fix);
    // 总管主人发起的回合（没有 jobId）带 ownerQuestion 照旧可以。
    const result = await commitAs(fix, fix.chief.id, { outcome: 'needs_owner', summary: '问主人', reply: '有个价格需要你定', ownerQuestion: question });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  });
});

describe('15 执行链回合的回复落点', () => {
  it('reply 落在这件事的主题、kind 为 work、refId 是交账；不落私聊；不生成目标验收提问', async () => {
    const fix = await jobFix();
    const { job } = await runningJob(fix);
    fix.ctx.store.table('goals').put({ ...goalFixture, id: 'g_0000000001', botId: fix.engineer.id, status: 'active' });
    const chiefThreadBefore = threadOf(fix.ctx, fix.engineer.id).length;
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'done', summary: '页面做完了', reply: '页面骨架已搭好', report: '已完成骨架' });
    const commit = fix.ctx.store.table('commits').list(row => row.botId === fix.engineer.id)[0]!;
    const work = topicMessages(fix, job).filter(row => row.from === fix.engineer.id);
    expect(work.map(row => [row.kind, row.text, row.refId])).toEqual([
      ['work', '页面骨架已搭好', commit.id], ['work', '已完成骨架', commit.id],
    ]);
    expect(threadOf(fix.ctx, fix.engineer.id)).toHaveLength(chiefThreadBefore);
    expect(threadOf(fix.ctx, fix.engineer.id).some(row => row.text === '机器人没有回复')).toBe(false);
    expect(fix.ctx.store.table('inbox').list(row => row.subjectKey.startsWith('goal_check:'))).toHaveLength(0);
    expect(fix.ctx.store.table('goals').get('g_0000000001')!.status).toBe('active');
  });

  it('本回合已有 submitted 事件时 reply 不落，report 照落', async () => {
    const fix = await jobFix();
    const { job } = await runningJob(fix);
    appendJobEvent(fix.ctx, { jobId: job.id, actor: fix.engineer.id, kind: 'submitted', to: [fix.reviewer.id], refId: null, data: {} });
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '已交回', reply: '交回了', report: '这一轮改了两处' });
    const texts = topicMessages(fix, job).filter(row => row.from === fix.engineer.id).map(row => row.text);
    expect(texts).toEqual(['这一轮改了两处']);
  });

  it('没有回复也不出现「机器人没有回复」：合成交账、主人消息类理由都不出现', async () => {
    const fix = await jobFix();
    const { job } = await assigned(fix);
    const wake = { ...createTicket(fix.ctx, { ...entriesOf(fix, fix.engineer.id, job.id)[0]!, id: 'q_0000000001' }, null),
      syntheticCommit: true, reason: { kind: 'owner_message' as const, score: 1, threshold: 0.5, summary: '主人发来消息', evidence: [] } };
    const commit = { id: 'c_0000000001', wakeId: wake.id, botId: fix.engineer.id, outcome: 'no_change', summary: '未交账', worldChanges: [], evidence: [],
      verification: { level: 'none', notCovered: '' }, blocker: null, nextThink: { mode: 'auto', reason: '等待' }, ownerQuestion: null,
      reply: '本轮未交账，中心尚未收到有效答复。', report: null, importance: 1, proposals: [], createdAt: fix.ctx.clock.now() } as unknown as Commit;
    await routeCommit(fix.ctx, commit, wake, []);
    const texts = [...topicMessages(fix, job), ...threadOf(fix.ctx, fix.engineer.id)].map(row => row.text);
    expect(texts).not.toContain('机器人没有回复');
    // 这条 reply 照常作为工作往来落在主题里，而不是私聊里的 reply。
    expect(topicMessages(fix, job).filter(row => row.from === fix.engineer.id).map(row => row.kind)).toEqual(['work']);
  });

  it('hub_project_put 在执行链回合里放文件的说明，落到这件事的主题，kind 为 work', async () => {
    const fix = await jobFix();
    const { job } = await runningJob(fix);
    const home = bot(fix, fix.engineer.id).homeDir;
    await fix.ctx.fs.mkdirp(`${home}/work`);
    await fix.ctx.fs.writeTextAtomic(`${home}/work/报价页.html`, '<html>页面</html>');
    const tool = fix.hub.tools().find(item => item.name === 'hub_project_put')!;
    const result = await tool.handler(bot(fix, fix.engineer.id).sessionId!, { from: 'work/报价页.html', to: `jobs/${job.id}/交付/报价页.html`, project: job.projectId }) as { ok: boolean; error?: string };
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    const notes = topicMessages(fix, job).filter(row => row.text.includes('报价页.html') && row.from === 'hub');
    expect(notes.map(row => row.kind)).toEqual(['work']);
    expect(notes[0]!.text).toBe(`林舟把「jobs/${job.id}/交付/报价页.html」放进了项目文件夹`);
  });
});

describe('18 进度行的延迟说明（jobDelayNote）', () => {
  /** 按设置里的时区写「HH:mm」，和被测函数同一口径。 */
  const hm = (fix: JobFix, at: number): string => {
    const parts = localParts(at, fix.ctx.settings.timezone);
    return `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
  };
  /** 派活后、候选还排着、总管的回合结束：10 分钟已过（越过启动静默和放行间隔）。 */
  async function queuedScene(fix: JobFix) {
    const { job } = await assigned(fix);
    fix.ctx.store.table('wakes').list(row => row.botId === fix.chief.id && row.status === 'running')
      .forEach(row => fix.ctx.store.table('wakes').patch(row.id, { status: 'committed', endedAt: fix.ctx.clock.now() }));
    fix.ctx.clock.advance(10 * MINUTE);
    return { job: fix.ctx.store.table('jobs').get(job.id)!, now: fix.ctx.clock.now() };
  }

  it('放行时为 null；没有候选也没有在跑时为 null（P74r16b：没有候选就不写「排队中」）；有回合在跑时为 null', async () => {
    const fix = await jobFix();
    const { job, now } = await queuedScene(fix);
    expect(jobDelayNote(fix.ctx, job, now)).toBeNull();
    for (const entry of entriesOf(fix, fix.engineer.id, job.id)) fix.ctx.store.table('queue').remove(entry.id);
    expect(jobDelayNote(fix.ctx, job, now)).toBeNull();
    // 回合在跑。
    const second = await jobFix();
    const running = await runningJob(second);
    expect(jobDelayNote(second.ctx, running.job, second.ctx.clock.now())).toBeNull();
  });

  it('启动静默、全局放行间隔：排队中', async () => {
    const fix = await jobFix();
    const { job, now } = await queuedScene(fix);
    fix.ctx.runtime.startedAt = now - MINUTE;
    expect(jobDelayNote(fix.ctx, job, now)).toBe('排队中');
    fix.ctx.runtime.startedAt = now - 60 * MINUTE;
    fix.ctx.runtime.lastDispatchAt = now - 1_000;
    expect(jobDelayNote(fix.ctx, job, now)).toBe('排队中');
  });

  it('额度灯红：额度恢复，约 HH:mm 继续；鉴权失败：模型服务需要重新登录', async () => {
    // P76d 修改：原句「额度用完，约 HH:mm 恢复」改为额度视图给的「额度恢复，约 HH:mm 继续」（任务卡 4.7），原意（红灯时进度行写恢复时间）不变。
    const fix = await jobFix();
    const { job, now } = await queuedScene(fix);
    onQuotaError(fix.ctx, now);
    const state = fix.ctx.store.table('quota').get('quota')!;
    expect(state.light).toBe('red');
    expect(jobDelayNote(fix.ctx, job, now)).toBe(`额度恢复，约 ${hm(fix, state.redUntil!)} 继续`);
    // 进度行上同样显示这一句。
    expect(jobProgressForTopic(fix.ctx, job.topicId)!.delayNote).toBe(`额度恢复，约 ${hm(fix, state.redUntil!)} 继续`);
    raiseAlert(fix.ctx, { code: 'auth', botId: null, text: '宿主鉴权失败，等待主人确认后恢复', level: 'P0', immediate: true, at: now });
    expect(jobDelayNote(fix.ctx, job, now)).toBe('模型服务需要重新登录');
  });

  it('额度灯橙：不再是执行链被挡住的原因，没有延迟说明（红灯照旧写恢复时间，见上一条）', async () => {
    const fix = await jobFix();
    const { job, now } = await queuedScene(fix);
    const state = fix.ctx.store.table('quota').get('quota') ?? undefined;
    fix.ctx.store.table('quota').put({ ...(state ?? { id: 'quota', windowStartAt: now, botTurns: 0, botTokens: 0, turnLimit: 8, tokenLimit: null,
      redUntil: null, probeAllowed: false, lastError: null, lastErrorAt: null }), light: 'orange', windowStartAt: now } as never);
    // 依据：P74 合并裁定第 2 条：橙灯放行执行链候选，不再为橙灯写「额度用完，约某时恢复」。原先这里断言写恢复时刻。
    expect(jobDelayNote(fix.ctx, job, now)).toBeNull();
  });

  it('同一员工正在忙别的事：林舟正在忙别的事', async () => {
    const fix = await jobFix();
    const { job, now } = await queuedScene(fix);
    // 林舟另有一个不属于这件事的回合在跑。
    fix.ctx.store.table('wakes').put({ ...wakesOf(fix, fix.chief.id)[0]!, id: 'w_0000000555', botId: fix.engineer.id, jobId: undefined,
      status: 'running', endedAt: null, commitId: null, startedAt: now });
    expect(jobDelayNote(fix.ctx, job, now)).toBe('林舟正在忙别的事');
  });

  it('上次出错：上次出错，约 HH:mm 重试', async () => {
    const fix = await jobFix();
    const { job, now } = await queuedScene(fix);
    fix.ctx.store.table('bots').patch(fix.engineer.id, { retryAt: now + 20 * MINUTE });
    expect(jobDelayNote(fix.ctx, job, now)).toBe(`上次出错，约 ${hm(fix, now + 20 * MINUTE)} 重试`);
  });

  it('这件事自己有「待你处理」条目开着：在等你回答；不在进行中的状态为 null', async () => {
    const fix = await jobFix();
    const { job, now } = await queuedScene(fix);
    createInboxItem(fix.ctx, { botId: fix.chief.id, type: 'question', title: '会员定价页：补充', body: '请选择', options: ['甲', '乙'],
      defaultOption: null, expiresAt: null, subjectKey: `job:${job.id}:extra` });
    expect(jobDelayNote(fix.ctx, job, now)).toBe('在等你回答');
    expect(jobDelayNote(fix.ctx, { ...job, state: 'awaiting_owner' }, now)).toBeNull();
    expect(jobDelayNote(fix.ctx, { ...job, state: 'done' }, now)).toBeNull();
  });

  it('延迟说明里没有工具名、机器人 id、内部编号', async () => {
    const fix = await jobFix();
    const { job, now } = await queuedScene(fix);
    fix.ctx.store.table('bots').patch(fix.engineer.id, { retryAt: now + 20 * MINUTE });
    expect(jobDelayNote(fix.ctx, job, now)).not.toMatch(INTERNAL);
  });
});

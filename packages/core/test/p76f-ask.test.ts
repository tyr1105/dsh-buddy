/**
 * P76f：问一次（askBudget、checkBudget）与用到预算线时停下（blockForTurnCap 经 askBudget 的 reached 分支）。
 *
 * 全部走真实 Hub（夹具说明见 p76f-fixtures.ts）：额度灯为绿、预算线 8（预计 9 减对齐 1）、时钟每次推进不超过 10 分钟。
 * 每条用例写明各步已用回合数；断言条目数、条目文字、私聊文字、这件事的状态与队列。
 * 断言要证明的机制不依赖额度灯碰巧放行：额度记录不存在，闸门第 7 步不拦。
 */
import { describe, expect, it } from 'vitest';
import { askBudget, checkBudget } from '../src/job/budget-ask.js';
import { blockForTurnCap } from '../src/job/cap.js';
import {
  MINUTE, askedNotReached, assigned, capItems, chiefSaid, commitAndEnd, countEvents, engineerProgress, engineerTurns, entriesOf, noticeRow, openCap,
  plannedRun, reachedAfterAsked, reachedUnasked, started, stepTurns, theJob, threadOf, tick,
} from './p76f-fixtures.js';
import { jobFix } from './p74b-fixtures.js';
import { INTERNAL } from './p74d-fixtures.js';

describe('2 照计划进行不问', () => {
  it('执行 3 个回合（第 3 个回合交回）、核对 1 个回合一次通过、交付：全程没有预计消耗条目，私聊没有预计消耗的话', async () => {
    // 各步已用：对齐 1、执行 3、核对 1；已用加余下每一刻都等于预算线 8，不超出。
    const { fix, job } = await plannedRun();
    expect(theJob(fix).state).toBe('awaiting_owner');
    expect([stepTurns(fix, job.id, 'exec'), stepTurns(fix, job.id, 'review'), stepTurns(fix, job.id, 'rework'), stepTurns(fix, job.id, 'chief')]).toEqual([3, 1, 0, 0]);
    expect(capItems(fix, job.id)).toHaveLength(0);
    expect(chiefSaid(fix).filter(text => text.includes('预计'))).toEqual([]);
    expect(noticeRow(fix, job.id)?.budgetAskedCaps ?? []).toEqual([]);
  });
});

describe('3 执行多用：问一次，这件事不停', () => {
  it('执行第 3 个回合结束还没交回：已用加余下 9 超出预算线 8，建条目一次；标题、六行正文、三个选项、总管私聊逐字', async () => {
    // 额度灯绿；预算线 8；各步已用：对齐 1、执行 3；这一回合结束时状态是执行中。
    const { fix, job } = await askedNotReached();
    const items = capItems(fix, job.id);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ botId: fix.chief.id, type: 'question', status: 'open', defaultOption: null, expiresAt: null, priority: 'P1',
      title: '会员定价页：消耗将超出预计', options: ['追加 2 个回合', '缩小范围', '暂停'], subjectKey: `job:${job.id}:cap:8`, refId: job.id });
    expect(items[0]!.body).toBe([
      '已用 4 回合，预计 9，估计共需 10 回合。',
      // P76r3（R7）：正好用满执行、还在做、没有待改的条目：原因按事实写，不再写「已用到预计的回合数」。
      '超出的部分：执行已用满预计的 3 回合，还没有交回。',
      '追加：按原约定做完，多用 2 回合，约 320K 到 780K token。',
      '缩小范围：总管用 1 个回合拟一版改动，你确认后照新版本做。',
      '暂停：用到 9 回合时停下，等你再定。',
      '在这之前，预计之内的部分照常在做。',
    ].join('\n'));
    // 这件事不停：仍是执行中，没有受阻原因，队列里林舟的续排还在，预算线不变。
    expect(theJob(fix)).toMatchObject({ state: 'doing', blocked: null, turnCap: 8, inboxId: null });
    expect(entriesOf(fix, fix.engineer.id, job.id)).toHaveLength(1);
    expect(chiefSaid(fix).at(-1)).toBe('会员定价页预计要用 10 回合，超出约定的 9 回合，在等你决定；预计之内的部分照常在做。');
    expect(noticeRow(fix, job.id)).toMatchObject({ budgetAskedCaps: [8], holdAtCap: false, narrowRequestedAt: null });
    for (const text of [items[0]!.title, items[0]!.body, chiefSaid(fix).at(-1)!]) expect(text).not.toMatch(INTERNAL);
  });

  it('执行多用 1 个回合（已用执行 4）时原因写「执行多用 1 回合」；条目正文第二行对应', async () => {
    // 各步已用：对齐 1、执行 4（预计 3）；第 3 个回合结束时已经问过，所以这里直接改记录再问一次另一个预算线。
    const { fix, job } = await started();
    await engineerProgress(fix);
    fix.ctx.store.table('jobUsage').patch(job.id, { steps: { ...fix.ctx.store.table('jobUsage').get(job.id)!.steps, exec: { turns: 4, tokens: 0 } } });
    fix.ctx.store.table('jobs').patch(job.id, { turnsUsed: 4 });
    checkBudget(fix.ctx, job.id);
    const [item] = capItems(fix, job.id);
    expect(item!.body.split('\n').slice(0, 2)).toEqual(['已用 5 回合，预计 9，估计共需 11 回合。', '超出的部分：执行多用 1 回合。']);
  });

  it('反例：已用加余下不超过预算线时不问（第 2 个回合结束，已用加余下正好 8）', async () => {
    const { fix, job } = await started();
    await engineerProgress(fix);
    await engineerTurns(fix, 1);
    expect(stepTurns(fix, job.id, 'exec')).toBe(2);
    expect(capItems(fix, job.id)).toHaveLength(0);
    expect(theJob(fix).state).toBe('doing');
  });

  it('反例：没有预计的旧事、发布环节、受阻的事，checkBudget 什么都不做', async () => {
    const { fix, job } = await started();
    fix.ctx.store.table('jobUsage').patch(job.id, { steps: { ...fix.ctx.store.table('jobUsage').get(job.id)!.steps, exec: { turns: 6, tokens: 0 } } });
    // 没有预计：不问。
    const estimates = fix.ctx.store.table('jobEstimates').get(job.agreementId)!;
    fix.ctx.store.table('jobEstimates').remove(job.agreementId);
    checkBudget(fix.ctx, job.id);
    expect(capItems(fix, job.id)).toHaveLength(0);
    fix.ctx.store.table('jobEstimates').put(estimates);
    // 受阻：不算余下，不问。
    fix.ctx.store.table('jobs').patch(job.id, { state: 'blocked', blocked: { kind: 'executor', no: null, text: '做不下去', since: fix.ctx.clock.now(), resumeTo: 'doing' } });
    checkBudget(fix.ctx, job.id);
    expect(capItems(fix, job.id)).toHaveLength(0);
    // 已完成且发布准备中：发布有自己的回合上限，不问。
    fix.ctx.store.table('jobs').patch(job.id, { state: 'done', blocked: null, launch: { state: 'preparing', approvalId: null, link: null } });
    checkBudget(fix.ctx, job.id);
    expect(capItems(fix, job.id)).toHaveLength(0);
  });

  it('反例：这件事已有别的条目开着（例如「停住了」）时不另问，主人面前同一件事只有一个入口', async () => {
    const { fix, job } = await started();
    fix.ctx.store.table('jobUsage').patch(job.id, { steps: { ...fix.ctx.store.table('jobUsage').get(job.id)!.steps, exec: { turns: 6, tokens: 0 } } });
    const other = fix.ctx.store.table('inbox').list()[0]!;
    fix.ctx.store.table('inbox').put({ ...other, id: 'i_zzzzzzzzzz', subjectKey: `job:${job.id}:stall:1`, status: 'open', options: ['再提醒一次', '暂停'], type: 'question' });
    checkBudget(fix.ctx, job.id);
    expect(capItems(fix, job.id)).toHaveLength(0);
  });

  it('条件只看记录：执行者的第 3 个回合还在跑时，改记录再检查，同样问一次（巡检在回合进行中也会看）', async () => {
    const { fix, job } = await started();
    await engineerProgress(fix);
    await engineerTurns(fix, 1);
    await tick(fix, MINUTE);
    fix.ctx.store.table('jobUsage').patch(job.id, { steps: { ...fix.ctx.store.table('jobUsage').get(job.id)!.steps, exec: { turns: 3, tokens: 0 } } });
    checkBudget(fix.ctx, job.id);
    expect(capItems(fix, job.id)).toHaveLength(1);
  });
});

describe('4 同一预算线不再问', () => {
  it('问过之后再用 1 个回合：没有新条目、总管私聊没有第二句、记号不变', async () => {
    const { fix, job } = await askedNotReached();
    const said = chiefSaid(fix).length;
    await engineerTurns(fix, 1);
    expect(capItems(fix, job.id)).toHaveLength(1);
    expect(chiefSaid(fix)).toHaveLength(said);
    expect(noticeRow(fix, job.id)!.budgetAskedCaps).toEqual([8]);
    expect(theJob(fix).state).toBe('doing');
    // 巡检、再次检查同样不再问。
    await tick(fix, MINUTE);
    checkBudget(fix.ctx, job.id);
    expect(capItems(fix, job.id)).toHaveLength(1);
  });
});

describe('4 同一预算线不再问（条目已经不开着）', () => {
  it('问过的条目被别的条目顶替撤回之后，再用 1 个回合、再巡检：仍没有新条目（靠「问过」的记号去重，不靠条目是否开着）', async () => {
    const { fix, job } = await askedNotReached();
    const first = openCap(fix, job.id)!;
    fix.ctx.store.table('inbox').patch(first.id, { status: 'withdrawn', answer: '这件事有了新的待办', answeredAt: fix.ctx.clock.now() });
    await engineerTurns(fix, 1);
    await tick(fix, MINUTE);
    checkBudget(fix.ctx, job.id);
    const items = capItems(fix, job.id);
    expect(items).toHaveLength(1);
    expect(items[0]!.status).toBe('withdrawn');
    expect(noticeRow(fix, job.id)!.budgetAskedCaps).toEqual([8]);
  });
});

describe('5 用到预算线（问过）：不建条目，只停下', () => {
  it('转受阻（用到上限）、队列清空、私聊「超出的部分已停下」一句；条目仍是开着的，仍可答复', async () => {
    // 各步已用：对齐 1、执行 8；预算线 8；问过一次。
    const { fix, job } = await reachedAfterAsked();
    expect(capItems(fix, job.id)).toHaveLength(1);
    expect(fix.ctx.store.table('queue').list(row => row.jobId === job.id)).toHaveLength(0);
    const blocked = theJob(fix);
    expect(blocked).toMatchObject({ state: 'blocked', blocked: { kind: 'turn_cap', text: '已用到预计消耗' } });
    expect(blocked.inboxId).toBe(openCap(fix, job.id)!.id);
    expect(chiefSaid(fix).filter(text => text.includes('已停下'))).toEqual(['会员定价页已用到预计的 9 回合，超出的部分已停下，在等你决定。']);
    expect(chiefSaid(fix).filter(text => text.includes('预计要用'))).toHaveLength(1);
    expect(countEvents(fix, job.id, 'turn_cap')).toBe(1);
    // 再巡检不会重复。
    await tick(fix, MINUTE);
    expect(capItems(fix, job.id)).toHaveLength(1);
    expect(chiefSaid(fix).filter(text => text.includes('已停下'))).toHaveLength(1);
    // 条目仍可答复。
    expect(await fix.hub.api.answerJobCap({ jobId: job.id, answer: '暂停' })).toMatchObject({ ok: true });
  });
});

describe('6 用到预算线（没问过）：建条目再停下', () => {
  it('标题「已用到预计消耗」，暂停一行是「现在停下」，没有「在这之前」一行；私聊「已停下，在等你决定」', async () => {
    // 各步已用：对齐 1、执行 1；已用回合数直接跳到预算线 8（一个回合就到），没有问过。
    const { fix, job } = await reachedUnasked();
    const items = capItems(fix, job.id);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ title: '会员定价页：已用到预计消耗', status: 'open', defaultOption: null, expiresAt: null, subjectKey: `job:${job.id}:cap:8` });
    const lines = items[0]!.body.split('\n');
    expect(lines[0]).toMatch(/^已用 2 回合，预计 9，估计共需 \d+ 回合。$/);
    expect(lines[4]).toBe('暂停：现在停下，等你再定。');
    expect(items[0]!.body).not.toContain('在这之前');
    expect(chiefSaid(fix).filter(text => text.includes('已停下'))).toEqual(['会员定价页已用到预计的 9 回合，已停下，在等你决定。']);
    expect(fix.ctx.store.table('queue').list(row => row.jobId === job.id)).toHaveLength(0);
    expect(theJob(fix).inboxId).toBe(items[0]!.id);
    expect(noticeRow(fix, job.id)!.budgetAskedCaps).toEqual([8]);
    // 再巡检不重复建条目。
    await tick(fix, MINUTE);
    expect(capItems(fix, job.id)).toHaveLength(1);
  });

  it('最后一个回合还在跑时不动它（前置条件保留）；回合结束后才停', async () => {
    const { fix, job } = await started();
    fix.ctx.store.table('jobs').patch(job.id, { turnsUsed: job.turnCap });
    expect(blockForTurnCap(fix.ctx, job.id, fix.ctx.clock.now())).toBe(false);
    expect(theJob(fix).state).toBe('doing');
    expect(capItems(fix, job.id)).toHaveLength(0);
    await engineerProgress(fix);
    await tick(fix, MINUTE);
    expect(theJob(fix)).toMatchObject({ state: 'blocked', blocked: { kind: 'turn_cap' } });
    expect(capItems(fix, job.id)).toHaveLength(1);
  });

  it('有开着的说明条目时不另建预算线条目（前置条件保留）', async () => {
    const { fix, job } = await started();
    await engineerProgress(fix);
    const any = fix.ctx.store.table('inbox').list()[0]!;
    fix.ctx.store.table('inbox').put({ ...any, id: 'i_yyyyyyyyyy', subjectKey: `job:${job.id}:escalate:1:0`, status: 'open', options: ['A　办法一', 'B　办法二'], type: 'question' });
    fix.ctx.store.table('jobs').patch(job.id, { turnsUsed: job.turnCap });
    expect(blockForTurnCap(fix.ctx, job.id, fix.ctx.clock.now())).toBe(false);
    expect(capItems(fix, job.id)).toHaveLength(0);
  });
});

describe('12 两段式：建条目失败时什么都不记', () => {
  it('建条目出错（总管记录不在了，建条目会拒绝）：记号不变、没有私聊、这件事状态与队列不变，条目一条也没有', async () => {
    const { fix, job } = await started();
    await engineerProgress(fix);
    fix.ctx.store.table('jobUsage').patch(job.id, { steps: { ...fix.ctx.store.table('jobUsage').get(job.id)!.steps, exec: { turns: 4, tokens: 0 } } });
    const jobBefore = JSON.stringify(theJob(fix));
    const saidBefore = threadOf(fix.ctx, fix.chief.id).length;
    const queueBefore = JSON.stringify(entriesOf(fix, fix.engineer.id, job.id));
    const noticeBefore = JSON.stringify(noticeRow(fix, job.id));
    const chief = fix.ctx.store.table('bots').get(fix.chief.id)!;
    fix.ctx.store.table('bots').remove(chief.id);
    try {
      expect(() => askBudget(fix.ctx, job.id, 'projected')).toThrow('机器人不存在');
      // checkBudget 吞掉错误，只记日志，也什么都不记。
      checkBudget(fix.ctx, job.id);
    } finally {
      fix.ctx.store.table('bots').put(chief);
    }
    expect(capItems(fix, job.id)).toHaveLength(0);
    expect(JSON.stringify(noticeRow(fix, job.id))).toBe(noticeBefore);
    expect(JSON.stringify(theJob(fix))).toBe(jobBefore);
    expect(threadOf(fix.ctx, fix.chief.id)).toHaveLength(saidBefore);
    expect(JSON.stringify(entriesOf(fix, fix.engineer.id, job.id))).toBe(queueBefore);
    // 总管回来之后下一次检查能问（没有因为这次失败而被「问过」的记号挡住）。
    checkBudget(fix.ctx, job.id);
    expect(capItems(fix, job.id)).toHaveLength(1);
  });
});

describe('预算线条目与总管会话（额外的反例）', () => {
  it('约定固定时的预计与预算线：新派的事预算线 8，什么都没用时 checkBudget 不问', async () => {
    const fix = await jobFix();
    const { job } = await assigned(fix);
    expect(job.turnCap).toBe(8);
    checkBudget(fix.ctx, job.id);
    expect(capItems(fix, job.id)).toHaveLength(0);
    await commitAndEnd(fix, fix.chief.id, { outcome: 'progress', summary: '派好了' }).catch(() => undefined);
  });
});

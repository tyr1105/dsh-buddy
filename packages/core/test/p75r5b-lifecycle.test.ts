/**
 * P75r5b 的测试一：技能类回合（复盘、学习、整理）不经回合收尾就结束时，参与者状态要收回来（审查 H1）；
 * 每一次记录都有终点（审查 H2）；闸门「参与者不是排队中」与「真的等了 7 天」分开；兜底认得「进行中却没有回合在跑」的参与者。
 *
 * 做法：全部走真实链路（真实验收、真实调度闸门、真实唤醒包、真实工具）。复盘、学习、整理三种记录各自覆盖「打断」「投递失败」，
 * 其余情形只用复盘。每种「在等某人」的情形都让那个人真跑一个回合，只用唤醒包里的文字调用工具。
 * 时间用注入的假时钟，每次推进不超过 10 分钟；要「真的等了 7 天」时直接改记录建立时间或入队时间，不推进时钟。
 * 夹具里总管、执行者、评审员都是听吩咐的（与真实创建出来的一致）。
 */
import { describe, expect, it } from 'vitest';
import type { FakeHost } from '../src/io/testing/fake-host.js';
import type { QueueEntry } from '../src/model/index.js';
import { createTicket } from '../src/wake/ticket.js';
import { buildSnapshot, evaluateGates } from '../src/scheduler/gates.js';
import { retroSubjectKey } from '../src/skill/keys.js';
import {
  MINUTE, THIRD_BACK, bot, callTool, commitAndEnd, flow, learnAsked, learnRun, learnerProposes, nextPacket, participantOf, retroRun, seedExport,
  skillKeysQueued, tick, tidyRuns, tidyScene, tidySectionOf, theJob, threadOf, updatesIn, MONDAY, expectMigrated, chiefChat,
  type JobFix,
} from './p75i-fixtures.js';
import { ownerSays } from './p72b-fixtures.js';
import { chiefTurn } from './p74f-fixtures.js';

const DAY = 24 * 60 * MINUTE;

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 宿主的第一次投递调用（deliver 或 createSession，先到先失败）抛错，之后恢复正常。 */
function failFirstDelivery(fix: JobFix): void {
  const host = fix.ctx.host as FakeHost;
  let armed = true;
  const deliver = host.deliver.bind(host);
  const createSession = host.createSession.bind(host);
  host.deliver = async (...args) => { if (armed) { armed = false; throw new Error('宿主投递失败'); } return deliver(...args); };
  host.createSession = async input => { if (armed) { armed = false; throw new Error('宿主投递失败'); } return createSession(input); };
}

/**
 * 打断之后员工的会话被中心解绑，下一个回合会新建会话、唤醒包随新会话一起送出（夹具读不到）。
 * 测试只关心参与者状态与记录的走向，所以打断之后把原会话接回去（仍是同一位员工、空闲），让唤醒包走「投递」、夹具读得到。
 */
async function interruptAndResume(fix: JobFix, botId: string): Promise<void> {
  const sessionId = bot(fix, botId).sessionId!;
  expect(await fix.hub.api.interruptBot({ botId })).toMatchObject({ ok: true });
  expect(bot(fix, botId).sessionId).toBeNull();
  fix.ctx.host.sessions.set(sessionId, { exists: true, running: false, contextRatio: 0 });
  fix.ctx.store.table('bots').patch(botId, { sessionId, sessionStartedAt: fix.ctx.clock.now() });
}

/** 执行者拿到复盘回合，提交「没有可写的」并交账（复盘只有执行者一位参与者时，这样就结束了）。 */
async function executorFinishesRetro(fix: JobFix): Promise<void> {
  await nextPacket(fix, fix.engineer.id);
  const proposed = await callTool(fix, bot(fix, fix.engineer.id), 'hub_skill', { mode: 'propose', updates: [], note: '这次没有可复用的做法' });
  expect(proposed, JSON.stringify(proposed)).toMatchObject({ ok: true });
  await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '复盘完成', reply: '没有可写的。' });
}

/** 主题、总管私聊、活动流里主人看得见的文字，全部拼在一起。 */
function visibleTexts(fix: JobFix, topicId: string | null): string[] {
  const rows = fix.hub.api.activity().rows.flatMap(row => [row.text, ...(row.lines ?? [])]);
  return [...(topicId === null ? [] : threadOf(fix.ctx, topicId).map(row => row.text)), ...chiefChat(fix).map(row => row.text), ...rows];
}

/** 复盘的前提：核对退回过一次，验收之后执行者一位参与者排着复盘候选。 */
async function retroScene() {
  const made = await flow({ rejectFirst: true });
  const run = retroRun(made.fix, made.job.id)!;
  expect(run.participants).toMatchObject([{ botId: made.fix.engineer.id, role: 'executor', state: 'queued' }]);
  return { ...made, run };
}

/** 学习的前提：林舟有一条已有技能；总管问过主人，主人选了第一段会话（可事先让宿主的第一次投递失败）。返回学习记录编号。 */
async function learnScene(options: { failFirst?: boolean } = {}) {
  const { fix } = await flow();
  expectMigrated(fix);
  await seedExport(fix);
  const asked = await learnAsked(fix);
  if (options.failFirst === true) failFirstDelivery(fix);
  const view = fix.hub.api.thread(fix.chief.id).messages.find(row => row.id === asked.card.id)!;
  expect(await fix.hub.api.chooseLearnSession({ runId: view.card!.learnRunId, option: view.card!.options[0] })).toMatchObject({ ok: true });
  return { fix, runId: asked.run.id };
}

/** 学习的员工拿到回合、提交、交账；核对人核对通过，学习记录结束。 */
async function learnRunsToEnd(fix: JobFix): Promise<void> {
  const { result } = await learnerProposes(fix);
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '学习完成', reply: '学好了。' });
  const packet = await nextPacket(fix, fix.reviewer.id);
  const checked = await callTool(fix, bot(fix, fix.reviewer.id), 'hub_skill', { mode: 'check', updateId: updatesIn(packet)[0]!.id, consistent: 'met', withinScope: 'met' });
  expect(checked, JSON.stringify(checked)).toMatchObject({ ok: true });
  await commitAndEnd(fix, fix.reviewer.id, { outcome: 'progress', summary: '核对完成', reply: '核对完了。' });
}

/** 整理的前提：假时钟在周一 03:10，巡检建了整理记录、给林舟排了整理唤醒。 */
async function tidyScenario(options: { failFirst?: boolean } = {}) {
  const made = await tidyScene();
  if (options.failFirst === true) failFirstDelivery(made.fix);
  await tick(made.fix, MINUTE);
  expect(tidyRuns(made.fix, made.fix.engineer.id, MONDAY)).toHaveLength(1);
  return made;
}

/** 整理的员工拿到回合，提交「没有可合并的」并交账，整理记录结束。 */
async function tidyRunsToEnd(fix: JobFix): Promise<void> {
  const packet = await nextPacket(fix, fix.engineer.id);
  expect(tidySectionOf(packet)).toContain('## 每周整理：你的技能库');
  const result = await callTool(fix, bot(fix, fix.engineer.id), 'hub_skill', { mode: 'tidy', note: '没有发现相互矛盾的条目', merges: [] });
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '整理完成', reply: '整理好了。' });
}

/** 这位员工在这条整理记录里的那一项。 */
function tidyParticipant(fix: JobFix) {
  return tidyRuns(fix, fix.engineer.id, MONDAY)[0]!.participants.find(row => row.botId === fix.engineer.id)!;
}

// ---------------------------------------------------------------------------
// 第 1 节：不经回合收尾就结束的几条路径
// ---------------------------------------------------------------------------

describe('1.1 主人打断：参与者改回排队中，已用回合数不退，之后补排、照常做完', () => {
  it('复盘：打断之后 queued、turnsUsed 仍是 1；之后被补排、做完，记录正常结束，小结和活动流里没有「等待超过 7 天」', async () => {
    const { fix, job, run } = await retroScene();
    await nextPacket(fix, fix.engineer.id);
    expect(participantOf(retroRun(fix, job.id)!, fix.engineer.id)).toMatchObject({ state: 'running' });
    await interruptAndResume(fix, fix.engineer.id);
    const after = retroRun(fix, job.id)!;
    expect(participantOf(after, fix.engineer.id)).toMatchObject({ state: 'queued' });
    expect(after.turnsUsed).toBe(1);
    // 由兜底补排（不是立刻就有候选）：之后某个 tick 里重新排上并投递，执行者做完，记录结束。
    await executorFinishesRetro(fix);
    const end = retroRun(fix, job.id)!;
    expect(end.endedAt).not.toBeNull();
    expect(end.turnsUsed).toBe(2);
    expect(participantOf(end, fix.engineer.id)).toMatchObject({ state: 'done' });
    const summaries = threadOf(fix.ctx, job.topicId).filter(row => row.refId === `retro-summary:${run.id}`).map(row => row.text);
    expect(summaries).toEqual(['复盘没有新的技能更新。']);
    expect(visibleTexts(fix, job.topicId).filter(text => text.includes('等待超过 7 天'))).toEqual([]);
  });

  it('学习：打断之后 queued，之后被补排、做完，学习记录正常结束，总管私聊里没有「等待超过 7 天」', async () => {
    const { fix, runId } = await learnScene();
    await nextPacket(fix, fix.engineer.id);
    expect(participantOf(learnRun(fix)!, fix.engineer.id)).toMatchObject({ state: 'running' });
    await interruptAndResume(fix, fix.engineer.id);
    expect(participantOf(learnRun(fix)!, fix.engineer.id)).toMatchObject({ state: 'queued' });
    expect(learnRun(fix)!.turnsUsed).toBe(1);
    await learnRunsToEnd(fix);
    const end = learnRun(fix)!;
    expect(end.id).toBe(runId);
    expect(end.endedAt).not.toBeNull();
    expect(chiefChat(fix).at(-1)!.text).toContain('已从这段会话学到');
    expect(visibleTexts(fix, null).filter(text => text.includes('等待超过 7 天'))).toEqual([]);
  });

  it('整理：打断之后 queued，之后被补排、做完，整理记录正常结束，活动流里没有「等待超过 7 天」「整理回合用完」', async () => {
    const { fix } = await tidyScenario();
    await nextPacket(fix, fix.engineer.id);
    expect(tidyParticipant(fix)).toMatchObject({ state: 'running' });
    await interruptAndResume(fix, fix.engineer.id);
    expect(tidyParticipant(fix)).toMatchObject({ state: 'queued' });
    expect(tidyRuns(fix, fix.engineer.id, MONDAY)[0]!.turnsUsed).toBe(1);
    await tidyRunsToEnd(fix);
    const end = tidyRuns(fix, fix.engineer.id, MONDAY)[0]!;
    expect(end.endedAt).not.toBeNull();
    expect(tidyParticipant(fix)).toMatchObject({ state: 'done' });
    expect(visibleTexts(fix, null).filter(text => text.includes('等待超过 7 天') || text.includes('整理回合用完'))).toEqual([]);
  });
});

describe('1.1 投递失败一次：已用回合数退回，之后照常进行，不出现「等待超过 7 天」', () => {
  it('复盘：宿主投递抛错一次，turnsUsed 退回 0、参与者 queued；约 20 分钟之后照常做完', async () => {
    const { fix, job } = await retroScene();
    failFirstDelivery(fix);
    await tick(fix, 5 * MINUTE); // 这个 tick 里候选放行、投递抛错；退避结束之前不会再投递
    // 失败之后：没有真正开始的回合不计数，参与者回到排队中（不是 running，更不是 expired）。
    const mid = retroRun(fix, job.id)!;
    expect(fix.ctx.store.table('wakes').list(row => row.botId === fix.engineer.id && row.status === 'error')).toHaveLength(1);
    expect(mid.turnsUsed).toBe(0);
    expect(participantOf(mid, fix.engineer.id)).toMatchObject({ state: 'queued' });
    await executorFinishesRetro(fix);
    const end = retroRun(fix, job.id)!;
    expect(end.endedAt).not.toBeNull();
    expect(end.turnsUsed).toBe(1);
    expect(participantOf(end, fix.engineer.id)).toMatchObject({ state: 'done' });
    expect(visibleTexts(fix, job.topicId).filter(text => text.includes('等待超过 7 天'))).toEqual([]);
  });

  it('学习：投递失败一次，turnsUsed 退回 0、参与者 queued；之后照常做完', async () => {
    const { fix } = await learnScene({ failFirst: true });
    expect(fix.ctx.store.table('wakes').list(row => row.botId === fix.engineer.id && row.status === 'error')).toHaveLength(1);
    expect(learnRun(fix)!.turnsUsed).toBe(0);
    expect(participantOf(learnRun(fix)!, fix.engineer.id)).toMatchObject({ state: 'queued' });
    await learnRunsToEnd(fix);
    expect(learnRun(fix)!.endedAt).not.toBeNull();
    expect(chiefChat(fix).at(-1)!.text).toContain('已从这段会话学到');
    expect(visibleTexts(fix, null).filter(text => text.includes('等待超过 7 天'))).toEqual([]);
  });

  it('整理：投递失败一次，turnsUsed 退回 0、参与者 queued；之后照常做完', async () => {
    const { fix } = await tidyScenario({ failFirst: true }); // 建记录、排候选、投递抛错都在这一个 tick 里
    expect(fix.ctx.store.table('wakes').list(row => row.botId === fix.engineer.id && row.status === 'error')).toHaveLength(1);
    expect(tidyRuns(fix, fix.engineer.id, MONDAY)[0]!.turnsUsed).toBe(0);
    expect(tidyParticipant(fix)).toMatchObject({ state: 'queued' });
    await tidyRunsToEnd(fix);
    expect(tidyRuns(fix, fix.engineer.id, MONDAY)[0]!.endedAt).not.toBeNull();
    expect(visibleTexts(fix, null).filter(text => text.includes('等待超过 7 天'))).toEqual([]);
  });
});

describe('1.1 会话被主人占用、投递超过两分钟：已用回合数退回，之后照常进行', () => {
  it('复盘：投递时员工的会话正被主人占用，唤醒单撤掉、回合数不增加、参与者 queued、候选还在；占用结束后照常做完', async () => {
    const { fix, job } = await retroScene();
    const sessionId = bot(fix, fix.engineer.id).sessionId!;
    expect(fix.ctx.host.sessions.get(sessionId)).toBeDefined();
    fix.ctx.host.sessions.set(sessionId, { exists: true, running: true, contextRatio: 0 });
    for (let i = 0; i < 2; i += 1) await tick(fix, 5 * MINUTE);
    const mid = retroRun(fix, job.id)!;
    expect(mid.turnsUsed).toBe(0);
    expect(participantOf(mid, fix.engineer.id)).toMatchObject({ state: 'queued' });
    expect(skillKeysQueued(fix, fix.engineer.id)).toEqual([retroSubjectKey(mid.id, fix.engineer.id)]);
    expect(fix.ctx.store.table('wakes').list(row => row.botId === fix.engineer.id && row.subjectKey === retroSubjectKey(mid.id, fix.engineer.id))).toHaveLength(0);
    fix.ctx.host.sessions.set(sessionId, { exists: true, running: false, contextRatio: 0 });
    await executorFinishesRetro(fix);
    const end = retroRun(fix, job.id)!;
    expect(end.endedAt).not.toBeNull();
    expect(end.turnsUsed).toBe(1);
    expect(visibleTexts(fix, job.topicId).filter(text => text.includes('等待超过 7 天'))).toEqual([]);
  });

  it('复盘：投递超过两分钟仍没有收到开始事件（孤儿投递），回合数退回、参与者 queued；之后补排、照常做完', async () => {
    const { fix, job, run } = await retroScene();
    // 模拟调度刚建好唤醒单、还没送达：候选已移出队列，唤醒单停在「投递中」（写法同 p74c-chain 的孤儿投递用例）。
    const entry = fix.ctx.store.table('queue').list(row => row.botId === fix.engineer.id && row.subjectKey === retroSubjectKey(run.id, fix.engineer.id))[0]!;
    const ticket = createTicket(fix.ctx, entry, null);
    fix.ctx.store.table('queue').remove(entry.id);
    expect(retroRun(fix, job.id)!.turnsUsed).toBe(1);
    expect(participantOf(retroRun(fix, job.id)!, fix.engineer.id)).toMatchObject({ state: 'running' });
    await tick(fix, 3 * MINUTE);
    expect(fix.ctx.store.table('wakes').get(ticket.id)).toMatchObject({ status: 'error', dispatchedAt: null });
    const mid = retroRun(fix, job.id)!;
    expect(mid.turnsUsed).toBe(0);
    expect(participantOf(mid, fix.engineer.id)).toMatchObject({ state: 'queued' });
    await executorFinishesRetro(fix);
    expect(retroRun(fix, job.id)!.endedAt).not.toBeNull();
    expect(visibleTexts(fix, job.topicId).filter(text => text.includes('等待超过 7 天'))).toEqual([]);
  });
});

describe('1.3 闸门的原因码分开：参与者不是排队中只丢弃候选，真的等了 7 天才改状态', () => {
  /** 候选的纯闸门判断：真实快照（带事项键）。 */
  function verdict(fix: JobFix, entry: QueueEntry) {
    const now = fix.ctx.clock.now();
    return evaluateGates(entry, buildSnapshot(fix.ctx, entry.botId, now, entry.jobId, entry.subjectKey), now, fix.ctx.settings);
  }

  it('参与者不是 queued 时到来的候选：原因 skill_stale、丢弃；真实调度之后参与者的状态不变、记录不被记成过期', async () => {
    const { fix, job, run } = await retroScene();
    fix.ctx.runtime.ownerActiveAt = fix.ctx.clock.now() - 11 * MINUTE;
    const entry = fix.ctx.store.table('queue').list(row => row.botId === fix.engineer.id)[0]!;
    // 同一份数据：参与者 queued 时放行（对照），其余五种状态都因 skill_stale 丢弃。
    fix.ctx.clock.advance(5 * MINUTE);
    expect(verdict(fix, entry)).toEqual({ pass: true });
    for (const state of ['running', 'done', 'skipped', 'expired', 'capped'] as const) {
      fix.ctx.store.table('skillRuns').put({ ...run, participants: run.participants.map(row => ({ ...row, state })) });
      expect(verdict(fix, entry), state).toMatchObject({ pass: false, by: 'skill_stale', drop: true });
    }
    // 真实调度：参与者记为 done（比如别处已经做完），队列里留着旧候选；一个 tick 之后候选被丢弃，参与者仍是 done，不是 expired。
    fix.ctx.store.table('skillRuns').put({ ...run, participants: run.participants.map(row => ({ ...row, state: 'done' as const })) });
    await tick(fix, MINUTE);
    expect(fix.ctx.store.table('queue').list(row => row.botId === fix.engineer.id && row.subjectKey === entry.subjectKey)).toEqual([]);
    expect(participantOf(retroRun(fix, job.id)!, fix.engineer.id)).toMatchObject({ state: 'done', reason: null });
    expect(fix.ctx.store.log('appraisals').all().some(row => row.suppressedBy === 'skill_stale')).toBe(true);
    expect(fix.ctx.store.log('appraisals').all().some(row => row.suppressedBy === 'skill_expired')).toBe(false);
  });

  it('真的超过 7 天：仍丢弃（原因 skill_expired），参与者记等待过期，小结那一句照旧', async () => {
    const { fix, job, run } = await retroScene();
    const entry = fix.ctx.store.table('queue').list(row => row.botId === fix.engineer.id)[0]!;
    fix.ctx.clock.advance(5 * MINUTE);
    const now = fix.ctx.clock.now();
    fix.ctx.store.table('queue').put({ ...entry, enqueuedAt: now - 7 * DAY - MINUTE });
    expect(verdict(fix, { ...entry, enqueuedAt: now - 7 * DAY - MINUTE })).toMatchObject({ pass: false, by: 'skill_expired', drop: true });
    await tick(fix, MINUTE);
    const after = retroRun(fix, job.id)!;
    expect(participantOf(after, fix.engineer.id)).toMatchObject({ state: 'expired', reason: 'skill_expired' });
    expect(after.endedAt).not.toBeNull();
    expect(threadOf(fix.ctx, job.topicId).filter(row => row.refId === `retro-summary:${run.id}`).map(row => row.text)).toEqual(['林舟的复盘等待超过 7 天，未进行。']);
  });
});

describe('1.4 兜底认得「进行中却没有回合在跑」的参与者', () => {
  it('参与者是 running，既没有在跑的唤醒、也没有排队的候选（例如进程重启造成）：巡检改回 queued 并补排，之后照常做完', async () => {
    const { fix, job, run } = await retroScene();
    // 造出这种状态：候选从队列里拿掉，参与者写成 running（没有任何未结束的唤醒单）。
    for (const entry of fix.ctx.store.table('queue').list(row => row.botId === fix.engineer.id)) fix.ctx.store.table('queue').remove(entry.id);
    fix.ctx.store.table('skillRuns').put({ ...run, turnsUsed: 1, participants: run.participants.map(row => ({ ...row, state: 'running' as const })) });
    expect(fix.ctx.store.table('wakes').list(row => row.botId === fix.engineer.id && row.endedAt === null)).toEqual([]);
    await tick(fix, MINUTE);
    expect(participantOf(retroRun(fix, job.id)!, fix.engineer.id)).toMatchObject({ state: 'queued' });
    expect(skillKeysQueued(fix, fix.engineer.id)).toEqual([retroSubjectKey(run.id, fix.engineer.id)]);
    await executorFinishesRetro(fix);
    expect(retroRun(fix, job.id)!.endedAt).not.toBeNull();
    expect(visibleTexts(fix, job.topicId).filter(text => text.includes('等待超过 7 天'))).toEqual([]);
  });

  it('反例：参与者是 running、且确实有一个在跑的唤醒时，巡检不动他', async () => {
    const { fix, job } = await retroScene();
    await nextPacket(fix, fix.engineer.id);
    expect(participantOf(retroRun(fix, job.id)!, fix.engineer.id)).toMatchObject({ state: 'running' });
    await tick(fix, MINUTE);
    expect(participantOf(retroRun(fix, job.id)!, fix.engineer.id)).toMatchObject({ state: 'running' });
    expect(skillKeysQueued(fix, fix.engineer.id)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 第 2 节：每一次记录都有终点
// ---------------------------------------------------------------------------

describe('2.1 角色按「他为什么在这次复盘里」定：漏判的核对人在返工期间被换掉之后仍被叫醒复盘', () => {
  it('第 1 阶段由评审甲判第 3 条符合，验收时主人指出，返工期间总管用换人（reassign）把核对人换成周岚，周岚核对通过后验收：评审甲在执行者之后被叫醒复盘，记录正常结束', async () => {
    const swapped: { id: string | null } = { id: null };
    const { fix, job } = await flow({
      rejectFirst: true, ownerReturn: THIRD_BACK, extraEngineers: ['周岚'], accept: false,
      beforeRecheck: async f => {
        // 真实的换人路径：总管在主人发话的回合里调用 hub_job_manage 的 reassign，核对人写「周岚」。
        await ownerSays(f, f.chief.id, '核对人换成周岚吧');
        await chiefTurn(f);
        const result = await callTool(f, bot(f, f.chief.id), 'hub_job_manage', { mode: 'reassign', jobId: theJob(f).id, reviewer: '周岚' });
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
        await commitAndEnd(f, f.chief.id, { outcome: 'progress', summary: '已换核对人', reply: '已把核对人换成周岚。' });
        swapped.id = f.extras[0]!.id;
        return swapped.id;
      },
    });
    const other = fix.extras[0]!;
    expect(swapped.id).toBe(other.id);
    expect(theJob(fix)).toMatchObject({ state: 'awaiting_owner', reviewerId: other.id });
    // 前提：评审甲在第 1 阶段最后一次核对里把第 3 条判了符合（漏判），而他此刻已不是这件事的评审员。
    const lastOfStage1 = fix.ctx.store.table('jobReviews').list(row => row.stage === 1).sort((a, b) => b.round - a.round)[0]!;
    expect(lastOfStage1.reviewerId).toBe(fix.reviewer.id);
    expect(lastOfStage1.items.find(row => row.no === 3)).toMatchObject({ verdict: 'met' });
    expect(theJob(fix).reviewerId).not.toBe(fix.reviewer.id);
    expect(await fix.hub.api.acceptJob({ jobId: job.id, stage: theJob(fix).stage })).toMatchObject({ ok: true });
    const run = retroRun(fix, job.id)!;
    // 评审甲有自己的出处，角色按评审员的顺序处理（不是纯核对人）。
    expect(participantOf(run, fix.reviewer.id)).toMatchObject({ role: 'reviewer', state: 'queued' });
    expect(participantOf(run, fix.reviewer.id)!.sourceIds.length).toBeGreaterThan(0);
    // 执行者先做：没有可写的；之后评审甲被叫醒复盘（真跑回合，只用唤醒包里的文字），记录正常结束。
    await executorFinishesRetro(fix);
    expect(retroRun(fix, job.id)!.endedAt).toBeNull();
    const packet = await nextPacket(fix, fix.reviewer.id);
    expect(packet).toContain('## 本轮复盘：');
    const proposed = await callTool(fix, bot(fix, fix.reviewer.id), 'hub_skill', { mode: 'propose', updates: [], note: '这次没有可复用的做法' });
    expect(proposed, JSON.stringify(proposed)).toMatchObject({ ok: true });
    await commitAndEnd(fix, fix.reviewer.id, { outcome: 'progress', summary: '复盘完成', reply: '没有可写的。' });
    const end = retroRun(fix, job.id)!;
    expect(end.endedAt).not.toBeNull();
    expect(end.participants.map(row => row.state)).toEqual(expect.arrayContaining(['done']));
    expect(end.participants.every(row => row.state === 'done')).toBe(true);
    expect(visibleTexts(fix, job.topicId).filter(text => text.includes('等待超过 7 天'))).toEqual([]);
  });
});

describe('2.2 兜底里的 7 天过期判断在「该不该他动」之前', () => {
  it('一位排队中的参与者按规则轮不到他动（纯核对人、没有等他核对的更新），记录建立超过 7 天：他被记等待过期，记录结束；7 天之内不动他', async () => {
    const { fix, job, run } = await retroScene();
    // 执行者已经做完（done、没有候选）；评审甲作为纯核对人排队中，没有更新等他核对：按规则兜底不会叫他。
    for (const entry of fix.ctx.store.table('queue').list(row => row.botId === fix.engineer.id)) fix.ctx.store.table('queue').remove(entry.id);
    fix.ctx.store.table('skillRuns').put({ ...run, participants: [
      { ...run.participants[0]!, state: 'done' as const },
      { botId: fix.reviewer.id, role: 'checker' as const, sourceIds: [], state: 'queued' as const, reason: null }] });
    await tick(fix, MINUTE);
    // 7 天之内：不叫他、不过期，记录也不结束。
    expect(participantOf(retroRun(fix, job.id)!, fix.reviewer.id)).toMatchObject({ state: 'queued', reason: null });
    expect(retroRun(fix, job.id)!.endedAt).toBeNull();
    expect(skillKeysQueued(fix, fix.reviewer.id)).toEqual([]);
    // 记录建立超过 7 天：他被记等待过期，记录结束。
    fix.ctx.store.table('skillRuns').put({ ...retroRun(fix, job.id)!, createdAt: fix.ctx.clock.now() - 7 * DAY - MINUTE });
    await tick(fix, MINUTE);
    const end = retroRun(fix, job.id)!;
    expect(participantOf(end, fix.reviewer.id)).toMatchObject({ state: 'expired', reason: 'skill_expired' });
    expect(end.endedAt).not.toBeNull();
    expect(threadOf(fix.ctx, job.topicId).filter(row => row.refId === `retro-summary:${run.id}`).map(row => row.text)).toEqual(['评审甲的复盘等待超过 7 天，未进行。']);
  });
});

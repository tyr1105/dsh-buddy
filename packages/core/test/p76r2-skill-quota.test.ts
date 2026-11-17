/**
 * P76r2 第 3 节的测试（R4）：技能类回合被额度打断，不算「没有提交」。
 * 以前：技能记录按「这个键上已经结束过几个唤醒」数第几次没有提交，不区分被额度打断的回合；被额度打断两次，复盘以「没有新的技能更新」结束。
 * 现在：回合以额度用完的报错结束时，参与者改回排队中、补排一条最早放行时刻不早于额度恢复时刻的同键候选、回合数退回一个、不数「第几次」。
 * 步骤（复盘、学习、每周整理各一条）：回合报额度 -> 到恢复时刻，探针回合正是这条技能候选 -> 探针再报额度：
 *   记录没有结束、没有落小结（复盘）、参与者仍是排队中、回合数没有增加 -> 额度恢复后这个回合成功，照常提交。
 * 夹具：真实链路，总管、执行者、评审员都是听吩咐的；时间用注入的假时钟，推进不超过 10 分钟，跨额度恢复时刻的直接设到目标时刻。
 */
import { describe, expect, it } from 'vitest';
import { learnSubjectKey, retroSubjectKey } from '../src/skill/keys.js';
import { endTurn } from './p74c-fixtures.js';
import {
  bot, callTool, chooseLearn, commitAndEnd, entriesOf, fail, flow, learnAsked, learnRun, learnerProposes, lightOf, nextPacket,
  participantOf, queueOf, quotaText, retroFlow, retroRun, retroTurn, runningOf, seedExport, tidyRuns, tidyScene, expectMigrated, threadOf,
  wakesOf, type JobFix,
} from './p76r2-skill-fixtures.js';

/** 额度记录里的恢复时刻（红灯时一定有）。 */
const redUntilOf = (fix: JobFix): number => fix.ctx.store.table('quota').get('quota')!.redUntil!;
/** 把假时钟设到额度恢复时刻（跨窗口，直接设到目标时刻），跑一次调度：放出探针回合。 */
async function toProbe(fix: JobFix): Promise<void> {
  fix.ctx.clock.set(redUntilOf(fix));
  await fix.hub.tick();
  expect(fix.ctx.store.table('quota').get('quota'), '探针已放行并在途').toMatchObject({ light: 'red', probeInFlight: true });
}
/** 这位员工被额度打断的回合数（唤醒单上有标记）。 */
const interrupted = (fix: JobFix, botId: string) => wakesOf(fix, botId).filter(row => row.quotaInterrupted === true).length;

describe('3 复盘回合被额度打断', () => {
  it('回合报额度、探针回合再报额度：记录没有结束、没有落小结、参与者仍是排队中、回合数没有增加；额度恢复后这个回合成功，照常提交', async () => {
    const { fix, job } = await retroFlow();
    const runId = retroRun(fix, job.id)!.id;
    const key = retroSubjectKey(runId, fix.engineer.id);
    await retroTurn(fix, fix.engineer.id);
    const turnsRunning = retroRun(fix, job.id)!.turnsUsed;
    // 第一次：回合报额度。
    await fail(fix, fix.engineer.id, quotaText(fix.ctx.clock.now()));
    expect(fix.ctx.store.table('quota').get('quota')).toMatchObject({ light: 'red' });
    expect(participantOf(retroRun(fix, job.id)!, fix.engineer.id)).toMatchObject({ state: 'queued' });
    expect(retroRun(fix, job.id)!.turnsUsed, '回合数退回一个').toBe(turnsRunning - 1);
    const queued = queueOf(fix, fix.engineer.id);
    expect(queued.map(row => row.subjectKey), '只有这一条技能候选').toEqual([key]);
    expect(queued[0]!.notBefore, '不早于额度恢复时刻').toBeGreaterThanOrEqual(redUntilOf(fix));
    // 到恢复时刻：探针回合正是这条技能候选。
    await toProbe(fix);
    expect(runningOf(fix, fix.engineer.id)).toMatchObject({ subjectKey: key });
    expect(retroRun(fix, job.id)!.turnsUsed).toBe(turnsRunning);
    // 第二次：探针又报额度。
    await fail(fix, fix.engineer.id, quotaText(fix.ctx.clock.now()));
    const after = retroRun(fix, job.id)!;
    expect(after.endedAt, '记录没有结束').toBeNull();
    expect(after.summaryPostedAt, '没有落小结').toBeNull();
    expect(threadOf(fix.ctx, job.topicId).filter(row => (row.refId ?? '').startsWith('retro-summary:'))).toEqual([]);
    expect(participantOf(after, fix.engineer.id), '参与者仍是排队中').toMatchObject({ state: 'queued', reason: null });
    expect(after.turnsUsed, '回合数没有增加').toBe(turnsRunning - 1);
    expect(interrupted(fix, fix.engineer.id)).toBe(2);
    expect(queueOf(fix, fix.engineer.id).map(row => row.subjectKey)).toEqual([key]);
    // 额度恢复后：探针回合再次是这条候选，这次成功，照常提交。
    await toProbe(fix);
    expect(runningOf(fix, fix.engineer.id)).toMatchObject({ subjectKey: key });
    expect(await callTool(fix, bot(fix, fix.engineer.id), 'hub_skill', { mode: 'propose', updates: [], note: '这次没有可复用的做法' })).toMatchObject({ ok: true });
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '复盘完成', reply: '好了。' });
    expect(participantOf(retroRun(fix, job.id)!, fix.engineer.id)).toMatchObject({ state: 'done' });
    expect(retroRun(fix, job.id)!.turnsUsed).toBe(turnsRunning);
    await fix.hub.tick();
    expect(lightOf(fix, fix.engineer.id), '探针成功之后额度灯恢复').not.toBe('red');
  });

  it('反例：回合正常结束而没有提交（不是额度）：第一次补排一次，第二次记 done、原因 no_update（仍按「第几次」数）', async () => {
    const { fix, job } = await retroFlow();
    const key = retroSubjectKey(retroRun(fix, job.id)!.id, fix.engineer.id);
    await retroTurn(fix, fix.engineer.id);
    await endTurn(fix, fix.engineer.id);
    expect(participantOf(retroRun(fix, job.id)!, fix.engineer.id)).toMatchObject({ state: 'queued' });
    expect(queueOf(fix, fix.engineer.id).map(row => row.subjectKey)).toEqual([key]);
    await retroTurn(fix, fix.engineer.id);
    await endTurn(fix, fix.engineer.id);
    expect(participantOf(retroRun(fix, job.id)!, fix.engineer.id)).toMatchObject({ state: 'done', reason: 'no_update' });
    expect(interrupted(fix, fix.engineer.id)).toBe(0);
  });
});

describe('3 学习回合被额度打断', () => {
  it('回合报额度、探针回合再报额度：学习记录没有结束、参与者仍是排队中、回合数没有增加；额度恢复后成功提交', async () => {
    const { fix } = await flow();
    expectMigrated(fix);
    await seedExport(fix);
    const asked = await learnAsked(fix);
    await chooseLearn(fix, asked.card.id);
    const key = learnSubjectKey(learnRun(fix)!.id, fix.engineer.id);
    await nextPacket(fix, fix.engineer.id);
    const turnsRunning = learnRun(fix)!.turnsUsed;
    await fail(fix, fix.engineer.id, quotaText(fix.ctx.clock.now()));
    expect(participantOf(learnRun(fix)!, fix.engineer.id)).toMatchObject({ state: 'queued' });
    expect(learnRun(fix)!.turnsUsed).toBe(turnsRunning - 1);
    expect(queueOf(fix, fix.engineer.id).map(row => row.subjectKey)).toEqual([key]);
    await toProbe(fix);
    expect(runningOf(fix, fix.engineer.id)).toMatchObject({ subjectKey: key });
    await fail(fix, fix.engineer.id, quotaText(fix.ctx.clock.now()));
    const after = learnRun(fix)!;
    expect(after.endedAt, '学习记录没有结束').toBeNull();
    expect(after.summaryPostedAt).toBeNull();
    expect(participantOf(after, fix.engineer.id)).toMatchObject({ state: 'queued', reason: null });
    expect(after.turnsUsed).toBe(turnsRunning - 1);
    expect(entriesOf(fix, fix.engineer.id).map(row => row.subjectKey)).toEqual([key]);
    await toProbe(fix);
    const { result } = await learnerProposes(fix);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '学习完成', reply: '学好了。' });
    expect(participantOf(learnRun(fix)!, fix.engineer.id)).toMatchObject({ state: 'done' });
  });
});

describe('3 每周整理回合被额度打断', () => {
  it('回合报额度、探针回合再报额度：整理记录没有结束、参与者仍是排队中（不记「回合用完」）、回合数没有增加；额度恢复后成功提交', async () => {
    const { fix } = await tidyScene();
    await nextPacket(fix, fix.engineer.id);
    const runId = tidyRuns(fix, fix.engineer.id)[0]!.id;
    const get = () => fix.ctx.store.table('skillRuns').get(runId)!;
    const key = wakesOf(fix, fix.engineer.id).at(-1)!.subjectKey!;
    expect(key.startsWith('tidy:')).toBe(true);
    const turnsRunning = get().turnsUsed;
    await fail(fix, fix.engineer.id, quotaText(fix.ctx.clock.now()));
    expect(participantOf(get(), fix.engineer.id)).toMatchObject({ state: 'queued' });
    expect(get().turnsUsed).toBe(turnsRunning - 1);
    expect(queueOf(fix, fix.engineer.id).map(row => row.subjectKey)).toEqual([key]);
    await toProbe(fix);
    expect(runningOf(fix, fix.engineer.id)).toMatchObject({ subjectKey: key });
    await fail(fix, fix.engineer.id, quotaText(fix.ctx.clock.now()));
    expect(get().endedAt, '整理记录没有结束').toBeNull();
    expect(participantOf(get(), fix.engineer.id), '不记回合用完').toMatchObject({ state: 'queued', reason: null });
    expect(get().turnsUsed).toBe(turnsRunning - 1);
    expect(queueOf(fix, fix.engineer.id).map(row => row.subjectKey)).toEqual([key]);
    await toProbe(fix);
    expect(await callTool(fix, bot(fix, fix.engineer.id), 'hub_skill', { mode: 'tidy', note: '没有发现相互矛盾的条目', merges: [] })).toMatchObject({ ok: true });
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '整理完成', reply: '好了。' });
    expect(participantOf(get(), fix.engineer.id)).toMatchObject({ state: 'done' });
  });
});

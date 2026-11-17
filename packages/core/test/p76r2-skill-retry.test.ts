/**
 * P76r2 第 2、5 节的测试：
 * 第 2 节（R2、R3）：技能类回合（复盘、核对、改写、整理、学习）出错、投递卡住、被额度打断时，不排通用的重试，
 *   队列里只有技能记录自己补排的那一条技能候选；员工只被叫醒一次，叫醒的是带技能段的回合；补排的候选不早于员工的退避时刻放行。
 *   「先核对」的结论：闸门第 9 步 retryAt = max(员工的退避时刻, 候选最早放行时刻)，对所有候选（含技能类）都生效，
 *   所以退避已经由闸门按员工整体拦住，技能记录补排时不必再带 notBefore。下面的用例证明这一点（候选在退避时刻之前不放行）。
 * 第 5 节（R6）：总管替主人派出的活（不带事情编号）被额度打断后重排，带「总管派出」，到恢复时刻员工被叫醒一次。
 *
 * 夹具与真实情况一致：总管、执行者、评审员都是听吩咐的；真实链路（派活、交回、核对、验收、复盘）；时间用注入的假时钟，
 * 每次推进不超过 10 分钟（跨额度恢复时刻的直接把假时钟设到目标时刻）；额度灯为绿（出错用的文字不含额度关键词）。
 */
import { describe, expect, it } from 'vitest';
import { createTicket } from '../src/wake/ticket.js';
import { learnSubjectKey, retroSubjectKey } from '../src/skill/keys.js';
import { finishTurn } from '../src/turn/events.js';
import { isSelfWork } from '../src/quota/usage.js';
import { addWake } from './p76c-fixtures.js';
import {
  MINUTE, bot, callTool, chooseLearn, commitAndEnd, fail, flow, learnAsked, learnRun, learnSectionOf, lightOf, nextPacket,
  queueOf, retroFlow, retroRun, retroSectionOf, retroTurn, seedExport, wakesOf, runningOf, entriesOf, quotaText, expectMigrated, tick, type JobFix,
} from './p76r2-skill-fixtures.js';
import { callTool as chiefCall, ownerSays, setup as chiefSetup, speak } from './p72b-fixtures.js';
import { jobFix, runningJob } from './p74c-fixtures.js';

const GENERIC_ERROR = '服务暂时异常，请稍后再试';

/** 员工做完这一回合：复盘没有可写的、提交并结束，不留任何后续。 */
async function finishRetro(fix: JobFix, botId: string): Promise<void> {
  expect(await callTool(fix, bot(fix, botId), 'hub_skill', { mode: 'propose', updates: [], note: '这次没有可复用的做法' })).toMatchObject({ ok: true });
  await commitAndEnd(fix, botId, { outcome: 'progress', summary: '复盘完成', reply: '好了。' });
}

/**
 * 出错之后的共同断言：员工的队列里只有这一条技能候选（没有任何 retry 候选、没有别的候选）；
 * 退避时刻之前不放行（闸门按员工的退避时刻整体拦住）；之后只被叫醒一次，叫醒的是带技能段的回合。
 */
async function expectOneSkillWake(fix: JobFix, botId: string, key: string, wakesAfterError: number, sectionOf: (packet: string) => string) {
  const queued = queueOf(fix, botId);
  expect(queued.map(row => row.subjectKey), '队列里只有这一条技能候选').toEqual([key]);
  expect(queued.some(row => row.reason.kind === 'retry'), '没有通用的重试候选').toBe(false);
  const retryAt = bot(fix, botId).retryAt;
  expect(retryAt, '前提：这次是普通出错，员工有退避时刻').not.toBeNull();
  expect(lightOf(fix, botId), '前提：额度灯为绿').toBe('green');
  // 退避时刻之前：技能候选不放行。
  fix.ctx.clock.set(retryAt! - 1_000);
  await fix.hub.tick();
  expect(runningOf(fix, botId), '退避时刻之前不放行').toBeUndefined();
  expect(wakesOf(fix, botId)).toHaveLength(wakesAfterError);
  // 退避之后：叫醒一次，是带技能段的回合。
  const packet = await nextPacket(fix, botId);
  expect(sectionOf(packet).length).toBeGreaterThan(0);
  const woken = wakesOf(fix, botId);
  expect(woken).toHaveLength(wakesAfterError + 1);
  expect(woken.at(-1)).toMatchObject({ subjectKey: key });
  expect(woken.at(-1)!.startedAt).toBeGreaterThanOrEqual(retryAt!);
  expect(woken.at(-1)!.reason.kind).not.toBe('retry');
  return packet;
}

/** 后面再推进一会儿：员工不再被叫醒（没有留下通用重试）。 */
async function expectNoMoreWakes(fix: JobFix, botId: string, count: number) {
  await tick(fix, 5 * MINUTE); await tick(fix, 5 * MINUTE); await tick(fix, 5 * MINUTE);
  expect(wakesOf(fix, botId), '之后不再被叫醒').toHaveLength(count);
  expect(entriesOf(fix, botId).filter(row => row.reason.kind === 'retry')).toEqual([]);
}

describe('2 技能类回合出错：只有技能候选一条', () => {
  it('复盘回合出错：队列里只有复盘候选；员工只被叫醒一次、叫醒的是带复盘段的回合；候选不早于退避时刻放行', async () => {
    const { fix, job } = await retroFlow();
    const key = retroSubjectKey(retroRun(fix, job.id)!.id, fix.engineer.id);
    await retroTurn(fix, fix.engineer.id);
    await fail(fix, fix.engineer.id, GENERIC_ERROR);
    const before = wakesOf(fix, fix.engineer.id).length;
    expect(retroRun(fix, job.id)!.participants.find(row => row.botId === fix.engineer.id)!.state).toBe('queued');
    await expectOneSkillWake(fix, fix.engineer.id, key, before, retroSectionOf);
    await finishRetro(fix, fix.engineer.id);
    await expectNoMoreWakes(fix, fix.engineer.id, before + 1);
  });

  it('学习回合出错：队列里只有学习候选（没有主人一侧的通用重试）；只被叫醒一次、叫醒的是带学习段的回合', async () => {
    const { fix } = await flow();
    expectMigrated(fix);
    await seedExport(fix);
    const asked = await learnAsked(fix);
    await chooseLearn(fix, asked.card.id);
    const key = learnSubjectKey(learnRun(fix)!.id, fix.engineer.id);
    expect(learnSectionOf(await nextPacket(fix, fix.engineer.id))).toContain('学习');
    await fail(fix, fix.engineer.id, GENERIC_ERROR);
    const before = wakesOf(fix, fix.engineer.id).length;
    await expectOneSkillWake(fix, fix.engineer.id, key, before, learnSectionOf);
    expect(await callTool(fix, bot(fix, fix.engineer.id), 'hub_skill', { mode: 'propose', updates: [], note: '这次没有可学的' })).toMatchObject({ ok: true });
    await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '学习结束', reply: '好了。' });
    await expectNoMoreWakes(fix, fix.engineer.id, before + 1);
  });

  it('投递卡住（孤儿投递）：手工建一张投递中的复盘唤醒单，推进到超时再跑巡检：队列里只有复盘候选；只被叫醒一次', async () => {
    const { fix, job } = await retroFlow();
    const key = retroSubjectKey(retroRun(fix, job.id)!.id, fix.engineer.id);
    const entry = queueOf(fix, fix.engineer.id).find(row => row.subjectKey === key)!;
    expect(entry, '前提：复盘验收之后排了员工的复盘候选').toBeDefined();
    // 手工建投递中的唤醒单（候选已被取走，与派发时一致）；参与者随之记为进行中。
    fix.ctx.store.table('queue').remove(entry.id);
    createTicket(fix.ctx, entry, null);
    expect(retroRun(fix, job.id)!.participants.find(row => row.botId === fix.engineer.id)!.state).toBe('running');
    fix.ctx.clock.advance(fix.ctx.settings.c02.deliveryTimeoutMs + 1_000);
    await fix.hub.tick();
    const before = wakesOf(fix, fix.engineer.id).length;
    expect(retroRun(fix, job.id)!.participants.find(row => row.botId === fix.engineer.id)!.state, '回合数退回、参与者改回排队中').toBe('queued');
    await expectOneSkillWake(fix, fix.engineer.id, key, before, retroSectionOf);
    await finishRetro(fix, fix.engineer.id);
    await expectNoMoreWakes(fix, fix.engineer.id, before + 1);
  });

  it('反例：普通回合（一件事里的执行回合）出错，照旧排通用重试', async () => {
    const fix = await jobFix();
    const { job } = await runningJob(fix);
    fix.ctx.clock.advance(MINUTE);
    await fix.hub.onTurnEvent({ type: 'error', sessionId: bot(fix, fix.engineer.id).sessionId!, at: fix.ctx.clock.now(), errorText: GENERIC_ERROR });
    const retries = entriesOf(fix, fix.engineer.id, job.id).filter(row => row.reason.kind === 'retry');
    expect(retries).toHaveLength(1);
    expect(retries[0]!.reason.summary).toContain('按退避重试');
  });
});

describe('2 学习回合被额度打断：队列里只有学习候选一条', () => {
  it('学习回合报额度：只有学习候选（不再另排主人一侧的通用重试）；候选不早于额度恢复时刻', async () => {
    const { fix } = await flow();
    expectMigrated(fix);
    await seedExport(fix);
    const asked = await learnAsked(fix);
    await chooseLearn(fix, asked.card.id);
    const key = learnSubjectKey(learnRun(fix)!.id, fix.engineer.id);
    await nextPacket(fix, fix.engineer.id);
    await fail(fix, fix.engineer.id, quotaText(fix.ctx.clock.now() + MINUTE));
    expect(fix.ctx.store.table('quota').get('quota')).toMatchObject({ light: 'red' });
    const queued = queueOf(fix, fix.engineer.id);
    expect(queued.map(row => row.subjectKey)).toEqual([key]);
    expect(queued.some(row => row.reason.kind === 'retry')).toBe(false);
    expect(queued[0]!.notBefore).toBeGreaterThanOrEqual(fix.ctx.store.table('quota').get('quota')!.redUntil!);
  });
});

describe('5 总管替主人派出的活被额度打断之后重排', () => {
  /** 总管在主人发起的回合里用 hub_send 给小李派一件事（不带事情编号）；小李拿到回合。 */
  async function liRunning() {
    const fix = await chiefSetup();
    await ownerSays(fix, fix.chief.id, '请小李做个报价页');
    fix.ctx.clock.advance(10 * MINUTE);
    expect((await chiefCall(fix, fix.chief, 'hub_send', { to: '小李', text: '请开始做报价页' })).ok).toBe(true);
    await speak(fix, fix.chief, '已派给小李。', { outcome: 'progress' });
    fix.ctx.clock.advance(1_000);
    await fix.hub.tick();
    const wake = fix.ctx.store.table('wakes').list(row => row.botId === fix.li.id)[0]!;
    expect(wake, '前提：小李拿到了总管派的活').toBeDefined();
    expect(wake).toMatchObject({ chiefDispatch: true, status: 'running' });
    expect(wake.jobId ?? null, '前提：不带事情编号').toBeNull();
    return { fix, wake };
  }

  it('员工的回合报额度：队列里留一条重排候选、带总管派出；到恢复时刻员工被叫醒一次', async () => {
    const { fix, wake } = await liRunning();
    const liId = fix.li.id;
    fix.ctx.clock.advance(MINUTE);
    await fix.hub.onTurnEvent({ type: 'error', sessionId: fix.ctx.store.table('bots').get(liId)!.sessionId!, at: fix.ctx.clock.now(),
      errorText: quotaText(fix.ctx.clock.now()) });
    const quota = fix.ctx.store.table('quota').get('quota')!;
    expect(quota.light).toBe('red');
    const kept = fix.ctx.store.table('queue').list(row => row.botId === liId);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ chiefDispatch: true, reason: { kind: 'retry', summary: '额度用完，恢复后继续上一轮的事' } });
    expect(kept[0]!.notBefore).toBeGreaterThanOrEqual(quota.redUntil!);
    // 恢复之前一直等；到恢复时刻放探针，探针回合就是这条重排候选：员工被叫醒一次。
    fix.ctx.clock.advance(5 * MINUTE);
    await fix.hub.tick();
    expect(fix.ctx.store.table('wakes').list(row => row.botId === liId && row.id !== wake.id)).toHaveLength(0);
    fix.ctx.clock.set(quota.redUntil!);
    await fix.hub.tick();
    const woken = fix.ctx.store.table('wakes').list(row => row.botId === liId && row.id !== wake.id);
    expect(woken).toHaveLength(1);
    expect(woken[0]).toMatchObject({ chiefDispatch: true, reason: { kind: 'retry' } });
  });

  it('反例：员工自己发起的回合被额度打断，不重排', async () => {
    const fix = await chiefSetup();
    // 员工自己发起：一个没有任何归属标记（不是主人发起、不是总管派出、没有主题和事情编号）的运行中回合。
    const wake = addWake(fix.ctx, { status: 'running', endedAt: null }, fix.li.id);
    expect(isSelfWork(wake, 'researcher')).toBe(true);
    await finishTurn(fix.ctx, wake.id, fix.ctx.clock.now(), 'error', quotaText(fix.ctx.clock.now()));
    expect(fix.ctx.store.table('quota').get('quota')).toMatchObject({ light: 'red' });
    expect(fix.ctx.store.table('queue').list(row => row.botId === fix.li.id)).toEqual([]);
  });
});

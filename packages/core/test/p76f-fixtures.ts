/**
 * P76f 测试的公共环境（不是测试文件）：预计消耗条目（将超出预计、用到预算线）相关的几个起点和小工具。
 *
 * 为什么走真实链路：问一次、停下、答复都挂在回合收尾、巡检、闸门和答复流程上，只有走真实的 Hub 才能测到接线。
 * 夹具与真实一致：总管自动创建（听吩咐、安静节奏），执行类员工听吩咐；约定固定时按默认份额估计
 * （对齐 1、执行 3、核对 1、返工预留 3、总管 1，共 9 回合，预算线 8）；额度灯为绿（没有额度记录）；时钟推进每次不超过 10 分钟。
 */
import { expect } from 'vitest';
import type { InboxItem } from '../src/model/outreach.js';
import type { Job } from '../src/model/job.js';
import { jobTitleOf } from '../src/job/chain.js';
import { PASS_ITEMS } from './p74f-fixtures.js';
import { assigned, commitAndEnd, countEvents, entriesOf, runningOf, theJob, threadOf, tick, MINUTE, type JobFix } from './p74c-fixtures.js';
import { bot, callTool, engineerSubmits, nextPacket, reviewerInfo, started } from './p74d-fixtures.js';

export { MINUTE, assigned, callTool, commitAndEnd, countEvents, entriesOf, nextPacket, runningOf, started, theJob, threadOf, tick };
export type { JobFix };

/** 这件事的预算线条目（事项键 job:<id>:cap:...），任何状态，按建立顺序。 */
export function capItems(fix: JobFix, jobId: string): InboxItem[] {
  return fix.ctx.store.table('inbox').list(row => row.subjectKey.startsWith(`job:${jobId}:cap:`)).sort((a, b) => a.createdAt - b.createdAt);
}

/** 这件事开着的预算线条目；没有为 undefined。 */
export function openCap(fix: JobFix, jobId: string): InboxItem | undefined {
  return capItems(fix, jobId).find(row => row.status === 'open');
}

/** 总管私聊里总管自己说的话（文字，按先后）。 */
export function chiefSaid(fix: JobFix): string[] {
  return threadOf(fix.ctx, fix.chief.id).filter(row => row.from === fix.chief.id).map(row => row.text);
}

/** 这件事的提醒记号（没有记录为 null）。 */
export function noticeRow(fix: JobFix, jobId: string) {
  return fix.ctx.store.table('jobNotices').get(jobId);
}

/** 这件事的用量行里某一步已用的回合数。 */
export function stepTurns(fix: JobFix, jobId: string, step: 'align' | 'exec' | 'review' | 'rework' | 'chief' | 'launch'): number {
  return fix.ctx.store.table('jobUsage').get(jobId)!.steps[step].turns;
}

/** 执行者（林舟）结束当前回合：交账 progress，不交回（中心续排下一个回合）。 */
export async function engineerProgress(fix: JobFix): Promise<void> {
  await commitAndEnd(fix, fix.engineer.id, { outcome: 'progress', summary: '先做着' });
}

/** 执行者再拿到一个回合（越过启动静默等）并结束它，不交回；count 个。 */
export async function engineerTurns(fix: JobFix, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await nextPacket(fix, fix.engineer.id);
    await engineerProgress(fix);
  }
}

/**
 * 林舟做了 3 个回合都没交回：第 3 个回合结束时，已用执行 3 个、还要至少再 1 个，已用加余下 9 超出预算线 8，中心问了一次。
 * 返回起点；这件事仍是执行中，林舟的续排还在队列里。
 */
export async function askedNotReached(): Promise<{ fix: JobFix; job: Job; info: Awaited<ReturnType<typeof started>>['info'] }> {
  const s = await started();
  await engineerProgress(s.fix);
  await engineerTurns(s.fix, 2);
  expect(openCap(s.fix, s.job.id), '第 3 个回合结束时问过一次').toBeDefined();
  return s;
}

/**
 * 在 askedNotReached 之后，林舟接着做到预算线（共 8 个回合）：用到预算线时这件事因预算线受阻，不再另建条目。
 * 返回起点；这件事是受阻（用到上限），队列清空。
 */
export async function reachedAfterAsked(): Promise<{ fix: JobFix; job: Job; info: Awaited<ReturnType<typeof started>>['info'] }> {
  const s = await askedNotReached();
  await engineerTurns(s.fix, 5);
  await tick(s.fix, MINUTE);
  expect(theJob(s.fix)).toMatchObject({ state: 'blocked', blocked: { kind: 'turn_cap' }, turnsUsed: 8 });
  return s;
}

/**
 * 没问过就用到预算线：林舟第 1 个回合结束后，把已用回合数直接改成预算线（模拟「一个回合就跳到预算线」），巡检停下并建条目。
 * 返回起点；这件事是受阻（用到上限）。
 */
export async function reachedUnasked(): Promise<{ fix: JobFix; job: Job; info: Awaited<ReturnType<typeof started>>['info'] }> {
  const s = await started();
  await engineerProgress(s.fix);
  s.fix.ctx.store.table('jobs').patch(s.job.id, { turnsUsed: s.job.turnCap });
  await tick(s.fix, MINUTE);
  expect(theJob(s.fix)).toMatchObject({ state: 'blocked', blocked: { kind: 'turn_cap' } });
  return s;
}

/** 照计划完整做完：执行 3 个回合（第 3 个回合交回）、核对 1 个回合一次通过、交付。返回这件事。 */
export async function plannedRun(): Promise<{ fix: JobFix; job: Job }> {
  const s = await started();
  await engineerProgress(s.fix);
  await engineerTurns(s.fix, 1);
  await nextPacket(s.fix, s.fix.engineer.id);
  await engineerSubmits(s.fix, s.info);
  await commitAndEnd(s.fix, s.fix.engineer.id, { outcome: 'progress', summary: '已交回' });
  const seen = reviewerInfo(await nextPacket(s.fix, s.fix.reviewer.id));
  const result = await callTool(s.fix, bot(s.fix, s.fix.reviewer.id), 'hub_job_work', { mode: 'review', jobId: seen.jobId, items: PASS_ITEMS });
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  await commitAndEnd(s.fix, s.fix.reviewer.id, { outcome: 'progress', summary: '核对通过' });
  return { fix: s.fix, job: theJob(s.fix) };
}

/** 这件事的标题（总管私聊文字里用）。 */
export function titleOf(fix: JobFix, job: Job): string {
  return jobTitleOf(fix.ctx, job);
}

export { assigned as assignedJob, bot };

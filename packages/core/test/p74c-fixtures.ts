/**
 * P74c 测试的公共环境（不是测试文件）：在 P74b 的真实 Hub 夹具上，提供「派活并让执行者拿到第一个回合」
 * 「员工交账并结束回合」「取队列、唤醒单、事件」等小工具。
 * 为什么走真实链路：回合计数、闸门、续排、兜底、交账落点都挂在 Hub 的调度和交账流程上，只有走真实流程才能测到接线；
 * 员工都是 Hub 启动整理之后的默认（听吩咐、安静节奏、I 型），不用人为调高分值的候选，也不用跳过启动整理的仿真世界。
 * 时间全部用注入的假时钟。
 */
import { expect } from 'vitest';
import type { Bot, QueueEntry } from '../src/model/index.js';
import type { Job } from '../src/model/job.js';
import { eventsOf } from '../src/job/store.js';
import { setJobBudget } from '../src/job/budget-line.js';
import { commitArgs } from './c03-turn-fixtures.js';
import { agreementIdIn } from './p73d-fixtures.js';
import {
  MINUTE, assignArgs, callTool, jobFix, lockedAndAwake, speak, threadOf, type JobFix,
} from './p74b-fixtures.js';

export { MINUTE, assignArgs, callTool, jobFix, lockedAndAwake, speak, threadOf, eventsOf, agreementIdIn };
export type { JobFix };

/** 总管已把「会员定价页」派给林舟（评审甲核对）。总管的回合还开着。返回这件事和总管这一回合的唤醒包。 */
/** P74r9：夹具里「约定带对外发布」时写的发布方式（唤醒包、约定文件、约定卡里都能看到这句）。 */
export const FIXTURE_LAUNCH_HOW = '发布到 /tmp/p74k-site（复制到本机目录）';

export async function assigned(fix: JobFix, extra: Record<string, unknown> = {}): Promise<{ job: Job; packet: string; agreementId: string }> {
  // P74r9：这件事有没有发布这一步由约定里的 launch 决定，派活参数不再填 launchStep。
  // 夹具参数 launch: true 表示「约定里带对外发布」：建约定时带 launch，派活时不传 launchStep；不会转给工具。
  // P76e：夹具参数 turnCap：派活之后用 setJobBudget 把预算线显式设成这个数（不会转给工具）。
  // 派活的预算线现在按预计算（首次估计是 8），原来依赖「一件事能走 16 个回合」的用例传 turnCap: 16，把它设回旧线；这些用例证明的机制与预算线的取值无关。
  const { launch, turnCap, ...assignExtra } = extra;
  // P81：launch 也可以是对象（{ how, localDir }）：约定里带指定的发布方式和发布位置。
  const launchObject = launch !== null && typeof launch === 'object' ? launch : launch === true ? { how: FIXTURE_LAUNCH_HOW } : null;
  const packet = await lockedAndAwake(fix, undefined, launchObject !== null ? { launch: launchObject } : {});
  const agreementId = agreementIdIn(packet);
  expect(await callTool(fix, fix.chief, 'hub_job_manage', assignArgs(agreementId, launchObject !== null ? { launchStep: undefined, ...assignExtra } : assignExtra))).toMatchObject({ ok: true });
  const created = fix.ctx.store.table('jobs').list()[0]!;
  if (typeof turnCap === 'number') setJobBudget(fix.ctx, created.id, turnCap, 'assign');
  return { job: fix.ctx.store.table('jobs').get(created.id)!, packet, agreementId };
}

/** 最新的员工记录（会话编号会随回合变化，不能用夹具里的旧对象）。 */
export function bot(fix: JobFix, botId: string): Bot {
  return fix.ctx.store.table('bots').get(botId)!;
}

/** 推进时间并跑一次调度。 */
export async function tick(fix: JobFix, ms = 1_000): Promise<void> {
  fix.ctx.clock.advance(ms);
  await fix.hub.tick();
}

/** 这位员工的全部唤醒单，从旧到新。 */
export function wakesOf(fix: JobFix, botId: string, jobId?: string) {
  return fix.ctx.store.table('wakes').list(row => row.botId === botId && (jobId === undefined || row.jobId === jobId))
    .sort((a, b) => a.startedAt - b.startedAt);
}

/** 这位员工在队列里的候选（可只看某件事的）。 */
export function entriesOf(fix: JobFix, botId: string, jobId?: string): QueueEntry[] {
  return fix.ctx.store.table('queue').list(row => row.botId === botId && (jobId === undefined || row.jobId === jobId));
}

/** 这位员工当前在跑的唤醒单。 */
export function runningOf(fix: JobFix, botId: string) {
  return fix.ctx.store.table('wakes').list(row => row.botId === botId && row.status === 'running')[0];
}

/** 员工交账并结束当前回合（和宿主真实调用同一入口）。返回交账工具的结果。 */
export async function commitAs(fix: JobFix, botId: string, patch: Record<string, unknown> = {}) {
  const current = bot(fix, botId);
  const tool = fix.hub.tools().find(item => item.name === 'hub_commit')!;
  const result = await tool.handler(current.sessionId!, commitArgs(patch as never)) as { ok: boolean; text?: string; error?: string };
  return result;
}

/** 结束这位员工的当前回合（宿主回报回合结束）。 */
export async function endTurn(fix: JobFix, botId: string): Promise<void> {
  await fix.hub.onTurnEvent({ type: 'ended', sessionId: bot(fix, botId).sessionId!, at: fix.ctx.clock.now(), finalText: '', tokens: 500 });
}

/** 交账并结束回合；交账必须成功。 */
export async function commitAndEnd(fix: JobFix, botId: string, patch: Record<string, unknown> = {}): Promise<void> {
  const result = await commitAs(fix, botId, patch);
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  await endTurn(fix, botId);
}

/**
 * 派活、总管结束回合，时钟推进 10 分钟（越过启动静默），调度一次：林舟拿到第一个回合（回合开着，还没交账）。
 * 返回这件事（回合开始之后的最新记录）和总管那一回合的唤醒包。
 */
export async function runningJob(fix: JobFix, extra: Record<string, unknown> = {}): Promise<{ job: Job; packet: string; agreementId: string }> {
  const base = await assigned(fix, extra);
  await speak(fix, fix.chief, '这件事由林舟执行，评审甲核对。', { outcome: 'progress' });
  await tick(fix, 10 * MINUTE);
  expect(runningOf(fix, fix.engineer.id), '林舟应该已经拿到第一个回合').toBeDefined();
  return { ...base, job: fix.ctx.store.table('jobs').get(base.job.id)! };
}

/** 事件里某类事件的条数。 */
export function countEvents(fix: JobFix, jobId: string, kind: string): number {
  return eventsOf(fix.ctx, jobId).filter(row => row.kind === kind).length;
}

/** 当前这件事（只有一件时）。 */
export function theJob(fix: JobFix): Job {
  const rows = fix.ctx.store.table('jobs').list();
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

/** 主题里的全部消息。 */
export function topicMessages(fix: JobFix, job: Job) {
  return threadOf(fix.ctx, job.topicId);
}

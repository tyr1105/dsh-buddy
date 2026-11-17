/**
 * P76i 测试的公共环境（不是测试文件）：设计稿场景 A 的三件事，以及造「条目、事件、用量、预计」的小工具。
 *
 * 夹具与真实情况一致：真实的中心（Hub），总管是自动创建的那一位（听吩咐、安静节奏），执行员工「林舟」听吩咐，评审员「评审甲」是建议类角色；
 * 约定与第一件事来自真实的派活（assigned），其余两件事由它复制出来（新编号、新标题）——视图测试只关心记录，
 * 不需要把三件事各自走完整条执行链。停滞记号（jobNotices）按派活说明直接构造。
 * 假时钟：场景统一设在 2026-11-17 14:00（北京时间）；推进都不超过 10 分钟，跨天的直接设到目标时刻。
 * 场景 A 的三件事（中心的总管是「老大」）：
 *  - 活动推文：对齐中，在等你确认约定第 1 版，已用 1 回合，预计 5；
 *  - 嘉宾介绍页：受阻（回合用到预算线），在等你，已等 6 小时，4 / 8 回合，没有交付时间；
 *  - 活动报名页：核对中，第 1 轮，9 / 14 回合，交付 11月17日 18:00；执行者林舟，核对人评审甲。
 */
import type { HubContext } from '../src/engine/context.js';
import type { Agreement } from '../src/model/agreement.js';
import type { Job, JobEventKind } from '../src/model/job.js';
import type { InboxItem } from '../src/model/outreach.js';
import { JobUsageSchema, type JobUsage, type UsageStep } from '../src/model/budget.js';
import { MINUTE, assigned, jobFix, type JobFix } from './p74c-fixtures.js';

export { MINUTE, assigned, jobFix };
export type { JobFix };
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
/** 北京时间的时刻。 */
export const at = (text: string): number => Date.parse(`${text}+08:00`);
/** 场景的「现在」。 */
export const NOW = at('2026-11-17T14:00:00');

/** 造一条「待你处理」条目（直接写表，状态开着）；createdAt 由调用者给。 */
export function putItem(ctx: HubContext, row: { id: string; botId: string; subjectKey: string; title: string; createdAt: number; status?: InboxItem['status'] }): InboxItem {
  const item: InboxItem = { id: row.id, botId: row.botId, type: 'question', title: row.title, body: '', options: ['知道了'], defaultOption: null,
    priority: 'P1', status: row.status ?? 'open', answer: null, refId: null, subjectKey: row.subjectKey, pushed: false, createdAt: row.createdAt,
    expiresAt: null, answeredAt: null };
  ctx.store.table('inbox').put(item);
  return item;
}

/** 造一件事的用量行：每步的回合数与 token（没写的步为 0），逐回合明细可选。 */
export function putUsage(ctx: HubContext, job: Pick<Job, 'id' | 'agreementId'>, steps: Partial<Record<UsageStep, { turns: number; tokens: number }>>,
  turns: JobUsage['turns'] = []): JobUsage {
  const full = { align: { turns: 0, tokens: 0 }, exec: { turns: 0, tokens: 0 }, review: { turns: 0, tokens: 0 },
    rework: { turns: 0, tokens: 0 }, chief: { turns: 0, tokens: 0 }, launch: { turns: 0, tokens: 0 }, ...steps };
  const row = JobUsageSchema.parse({ id: job.id, agreementId: job.agreementId, category: 'page', steps: full, turns, finalizedAt: null, updatedAt: NOW });
  ctx.store.table('jobUsage').put(row);
  // P87r1：整行换成造出来的用量，「你发起的回合」那一栏（新表，派活时已记一项）一并清掉，让这些用例继续只验六步的文字。
  ctx.store.table('jobOwnerTurns').remove(job.id);
  return row;
}

/** 造一份约定的预计（锁定的一项，或待确认时的 draft），总回合数 total（拆分只是凑数，视图只读 total）。 */
export function putEstimate(ctx: HubContext, agreementId: string, total: number, reason: 'lock' | 'draft' = 'lock', versionNo = 1): void {
  ctx.store.table('jobEstimates').put({ id: agreementId, versions: [{ versionNo, total, steps: { align: 1, exec: total - 2, review: 1, rework: 0, chief: 0 },
    tokenLow: 100_000, tokenHigh: 400_000, basis: 'default', historyCount: 0, reason, createdAt: NOW - DAY }] });
}

/** 在事件日志里记一个事件（时间、发出者、接收者、附带内容由调用者给）。 */
export function logEvent(ctx: HubContext, row: { jobId: string; kind: JobEventKind; at: number; actor: string; to?: string[]; data?: Record<string, unknown> }): void {
  ctx.store.log('jobEvents').append({ id: `jev_${String(ctx.store.log('jobEvents').all().length + 1).padStart(10, '0')}`, jobId: row.jobId, at: row.at,
    actor: row.actor, kind: row.kind, to: row.to ?? [], refId: null, data: row.data ?? {} });
}

/** 把已有的约定复制成另一份（新编号、新标题、新主题）；编号后缀是 10 位小写字母或数字。 */
export function cloneAgreement(ctx: HubContext, base: Agreement, suffix: string, title: string): Agreement {
  const copy: Agreement = { ...base, id: `agr_${suffix}`, topicId: `ptp_${suffix}`, title, inboxId: null };
  ctx.store.table('agreements').put(copy);
  return copy;
}

/** 把已有的一件事复制成另一件（新编号，挂到另一份约定上）。 */
export function cloneJob(ctx: HubContext, base: Job, suffix: string, agreement: Agreement, patch: Partial<Job>): Job {
  const copy: Job = { ...base, id: `job_${suffix}`, agreementId: agreement.id, topicId: agreement.topicId, inboxId: null, ...patch };
  ctx.store.table('jobs').put(copy);
  return copy;
}

/** 场景 A 的返回：三件事的记录与夹具。 */
export interface SceneA { fix: JobFix; ctx: JobFix['ctx']; report: Job; guest: Job; tweet: Agreement; capItem: InboxItem }

export async function sceneA(): Promise<SceneA> {
  const fix = await jobFix();
  const ctx = fix.ctx;
  const { job: base } = await assigned(fix);
  // 派活留下的队列、未结束的唤醒与候选与视图测试无关，清掉，让每件事的「在等谁」只由记录决定。
  for (const entry of ctx.store.table('queue').list()) ctx.store.table('queue').remove(entry.id);
  ctx.clock.set(NOW);

  // 活动报名页：核对中，第 1 轮，9 / 14 回合，交付 11月17日 18:00（执行者林舟，核对人评审甲）。
  const reportAgreement = ctx.store.table('agreements').patch(base.agreementId, { title: '活动报名页' });
  const report = ctx.store.table('jobs').patch(base.id, { state: 'checking', round: 1, turnsUsed: 9, turnCap: 13,
    dueAt: at('2026-11-17T18:00:00'), updatedAt: NOW - HOUR });
  putUsage(ctx, report, { align: { turns: 1, tokens: 40_000 }, exec: { turns: 5, tokens: 1_000_000 }, review: { turns: 2, tokens: 200_000 }, rework: { turns: 1, tokens: 160_000 } });
  putEstimate(ctx, reportAgreement.id, 14);

  // 嘉宾介绍页：回合用到预算线而受阻，在等你，已等 6 小时，4 / 8 回合，没有交付时间；核对人是总管自己（reviewerId 为空）。
  const guestAgreement = cloneAgreement(ctx, reportAgreement, 'guestpage1', '嘉宾介绍页');
  const guest = cloneJob(ctx, report, 'guestpage1', guestAgreement, { state: 'blocked', round: 0, turnsUsed: 4, turnCap: 8, dueAt: null, reviewerId: null,
    blocked: { kind: 'turn_cap', no: null, text: '回合用到预算线', since: NOW - 6 * HOUR, resumeTo: 'doing' }, updatedAt: NOW - 6 * HOUR });
  putUsage(ctx, guest, { align: { turns: 1, tokens: 30_000 }, exec: { turns: 3, tokens: 600_000 } });
  putEstimate(ctx, guestAgreement.id, 8);
  const capItem = putItem(ctx, { id: 'i_capguest01', botId: fix.chief.id, subjectKey: `job:${guest.id}:cap:8`, title: '嘉宾介绍页：消耗将超出预计', createdAt: NOW - 6 * HOUR });
  ctx.store.table('jobs').patch(guest.id, { inboxId: capItem.id });

  // 活动推文：约定待确认（对齐中），已用 1 回合（对齐），预计 5；对齐回合在账本里有 50000 token。
  const tweetBase = cloneAgreement(ctx, reportAgreement, 'tweetpage1', '活动推文');
  const tweet: Agreement = { ...tweetBase, state: 'pending', updatedAt: NOW - 20 * MINUTE,
    versions: [{ ...reportAgreement.versions[0]!, no: 1, state: 'pending', wakeId: 'w_aligntweet' }] };
  ctx.store.table('agreements').put(tweet);
  putEstimate(ctx, tweet.id, 5, 'draft');
  ctx.store.log('ledger').append({ id: 'le_aligntweet', who: fix.chief.id, wakeId: 'w_aligntweet', tokens: 50_000, kind: 'turn', at: NOW - 30 * MINUTE,
    tokenSource: 'host', tokenBase: 50_000, accountingMultiplier: 1 });
  putItem(ctx, { id: 'i_agrtweet01', botId: fix.chief.id, subjectKey: `agreement:${tweet.id}:1`, title: '活动推文：确认约定', createdAt: NOW - 20 * MINUTE });
  return { fix, ctx, report, guest, tweet, capItem };
}

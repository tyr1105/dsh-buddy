/**
 * 一件事的分步记账（P76e，第五块）：每个执行链回合记进这件事的某一步，带实测 token。
 *
 * 做什么：
 * - stepOf：判断一个回合属于哪一步（对齐、执行、核对、返工、总管、发布）；
 * - recordJobTurn / undoJobTurn：回合开始时记一项（带 jobId、不是你发起的、不是技能类），回合被退还时撤掉；
 * - addJobTurnTokens：这张唤醒单记账（recordUsage）之后，把实测 token 补进那一项；
 * - alignmentOf / recordAlignment：对齐这一步的回合与 token（约定各版本的唤醒单）；
 * - finalizeJobUsage：验收或停止时定稿，之后只读，同类估计只读定稿的行。
 *
 * 为什么这样设计：
 * - 记账放在回合计数（job/turns.ts 的 countJobTurn）之后，条件与它完全相同，不另写一套「是不是你发起的」判断，
 *   所以回合数和这里的记账永远对得上；技能类事项键的回合另外排除（它们有自己的上限，不属于这件事的消耗）；
 * - token 来自账本里的 tokenBase（宿主原数或估算基数，向上取整），不用带保护倍率的记账值：预计和实际用同一口径；
 * - 这些数据只存新表 jobUsage（P76b），不改一件事（Job）的结构；
 * - 所有写入出错都只记日志，不能影响回合开始、记账和验收。
 * 给主人看的文字（进度行的消耗一行、明细）在 usage-text.ts。
 */
import { BUDGET_DEFAULTS as D } from '../config/defaults.js';
import type { HubContext } from '../engine/context.js';
import { JobUsageSchema, USAGE_STEPS, type JobUsage, type UsageStep } from '../model/budget.js';
import type { Agreement } from '../model/agreement.js';
import type { Job } from '../model/job.js';
import type { WakeTicket } from '../model/wake.js';
import { jobCategory } from '../project/agreement-category.js';
import { isSkillWork } from '../skill/keys.js';
import { inLaunchPhase, launchLinkOpen } from './launch-turns.js';
import { finalizeOwnerTurns } from './owner-turns.js';

/** 六步各自为 0 的步骤合计。 */
export function emptySteps(): JobUsage['steps'] {
  return Object.fromEntries(USAGE_STEPS.map(step => [step, { turns: 0, tokens: 0 }])) as JobUsage['steps'];
}

/**
 * 一个回合属于哪一步，按顺序取第一个成立的：
 * 1 在发布环节（验收之后的发布准备、等批准、发布没有成功，以及发布已成功但还没补记网址的那一次叫醒）→ launch；
 * 2 这位员工是核对人，或没有核对人、这件事在核对中而这位员工是总管（总管自己核对）→ review；
 * 3 这位员工是执行者，并且在返工、或执行中但还有待改的条目 → rework；
 * 4 这位员工是执行者 → exec；
 * 5 这位员工是总管 → chief；
 * 6 其余（不应出现）→ chief，并通过 onUnknown 报告一次，由调用方记日志。
 * 纯函数：只读传入的这件事。
 */
export function stepOf(job: Job, botId: string, onUnknown?: () => void): UsageStep {
  if (inLaunchPhase(job) || launchLinkOpen(job)) return 'launch';
  if (job.reviewerId !== null ? botId === job.reviewerId : job.state === 'checking' && botId === job.chiefId) return 'review';
  if (botId === job.executorId && (job.state === 'rework' || (job.state === 'doing' && job.unmet.length > 0))) return 'rework';
  if (botId === job.executorId) return 'exec';
  if (botId === job.chiefId) return 'chief';
  onUnknown?.();
  return 'chief';
}

/** 取这件事的用量行；没有就按当前类别新建（不写入）。 */
export function usageRowOf(ctx: HubContext, job: Pick<Job, 'id' | 'agreementId'>, now: number): JobUsage {
  const existing = ctx.store.table('jobUsage').get(job.id);
  if (existing !== null) return existing;
  return { id: job.id, agreementId: job.agreementId, category: jobCategory(ctx, job.id), steps: emptySteps(), turns: [], finalizedAt: null, updatedAt: now };
}

/** 这件事至今的回合数与实测 token 合计（六步相加，含对齐与发布）。 */
export function usageTotals(usage: Pick<JobUsage, 'steps'>): { turns: number; tokens: number } {
  let turns = 0;
  let tokens = 0;
  for (const step of USAGE_STEPS) { turns += usage.steps[step].turns; tokens += usage.steps[step].tokens; }
  return { turns, tokens };
}

/**
 * 回合开始时记一项。条件与 countJobTurn 相同（带 jobId、不是你发起的），另外排除技能类事项键。
 * jobBefore：回合数加一之前的这件事（stepOf 要看那时的状态：待开工、执行中、返工……）；省略时读存储里现在的。
 * 同一张唤醒单只记一次；明细超过上限时丢最早的一项（各步合计不减）。出错只记日志。
 */
export function recordJobTurn(ctx: HubContext, ticket: WakeTicket, jobBefore?: Job): void {
  if (!ticket.jobId || ticket.ownerInitiated) return;
  if (isSkillWork(ticket.reason.kind, ticket.subjectKey)) return;
  try {
    const job = jobBefore ?? ctx.store.table('jobs').get(ticket.jobId);
    if (job === null || job === undefined) return;
    const row = usageRowOf(ctx, job, ticket.startedAt);
    if (row.turns.some(turn => turn.wakeId === ticket.id)) return;
    const step = stepOf(job, ticket.botId, () => {
      ctx.logger.warn('回合记账：这位员工不是这件事的总管、执行者或核对人，按总管一步记', { jobId: job.id, botId: ticket.botId });
    });
    const turns = [...row.turns, { wakeId: ticket.id, step, botId: ticket.botId, startedAt: ticket.startedAt, endedAt: null, tokens: 0 }];
    while (turns.length > D.USAGE_TURNS_MAX) turns.shift();
    const steps = { ...row.steps, [step]: { ...row.steps[step], turns: row.steps[step].turns + 1 } };
    ctx.store.table('jobUsage').put(JobUsageSchema.parse({ ...row, steps, turns, updatedAt: ticket.startedAt }));
  } catch (error) {
    try { ctx.logger.error('分步记账（回合）失败', error); } catch { /* 日志出错也不能挡住投递。 */ }
  }
}

/** 退还回合时撤掉这一项：该步回合数减一（项里已有的 token 一并减掉）。找不到这一项（没记过、已被丢弃）不做。 */
export function undoJobTurn(ctx: HubContext, ticket: WakeTicket): void {
  if (!ticket.jobId || ticket.ownerInitiated) return;
  try {
    const row = ctx.store.table('jobUsage').get(ticket.jobId);
    if (row === null) return;
    const turn = row.turns.find(item => item.wakeId === ticket.id);
    if (turn === undefined) return;
    const steps = { ...row.steps, [turn.step]: {
      turns: Math.max(0, row.steps[turn.step].turns - 1), tokens: Math.max(0, row.steps[turn.step].tokens - turn.tokens) } };
    ctx.store.table('jobUsage').put(JobUsageSchema.parse({ ...row, steps, turns: row.turns.filter(item => item !== turn), updatedAt: ticket.startedAt }));
  } catch (error) {
    try { ctx.logger.error('分步记账（退还回合）失败', error); } catch { /* 同上。 */ }
  }
}

/**
 * 这张唤醒单记账之后，把实测 token 补进它那一项（recordUsage 调用）：tokenBase 向上取整；
 * 对应步骤的 tokens 累加，endedAt 写记账时间。唤醒单不带 jobId、这件事没有这一项（你发起的回合、已被丢弃）、
 * 或这一项已经补过时不做。出错只记日志。
 */
export function addJobTurnTokens(ctx: HubContext, wake: Pick<WakeTicket, 'id' | 'jobId'> | null, tokenBase: number, now: number): void {
  if (wake === null || !wake.jobId) return;
  try {
    const row = ctx.store.table('jobUsage').get(wake.jobId);
    if (row === null) return;
    const index = row.turns.findIndex(item => item.wakeId === wake.id);
    const turn = row.turns[index];
    if (turn === undefined || turn.endedAt !== null) return;
    const base = Math.ceil(tokenBase);
    const turns = row.turns.map((item, position) => position === index ? { ...item, tokens: base, endedAt: now } : item);
    const steps = { ...row.steps, [turn.step]: { ...row.steps[turn.step], tokens: row.steps[turn.step].tokens + base } };
    ctx.store.table('jobUsage').put(JobUsageSchema.parse({ ...row, steps, turns, updatedAt: now }));
  } catch (error) {
    try { ctx.logger.error('分步记账（token）失败', error); } catch { /* 同上。 */ }
  }
}

/**
 * 对齐这一步的回合与 token：这份约定全部版本的 wakeId（去重、去掉 null，主人在卡上改出的版本没有）的个数是回合数；
 * token 是这些唤醒单在账本里的 tokenBase 合计（向上取整后相加；找不到的按 0 并记日志）。
 * 约定提交新版本和派活都用它：预计算的是对齐已用，派活时记进 steps.align。
 */
export function alignmentOf(ctx: HubContext, agreement: Pick<Agreement, 'id' | 'versions'>): { turns: number; tokens: number } {
  const wakeIds = [...new Set(agreement.versions.map(version => version.wakeId).filter((id): id is string => id !== null))];
  if (wakeIds.length === 0) return { turns: 0, tokens: 0 };
  const wanted = new Set(wakeIds);
  const found = new Map<string, number>();
  for (const entry of ctx.store.log('ledger').all()) {
    if (entry.kind === 'turn' && entry.wakeId !== null && wanted.has(entry.wakeId) && !found.has(entry.wakeId)) {
      found.set(entry.wakeId, Math.ceil(entry.tokenBase ?? entry.tokens));
    }
  }
  const missing = wakeIds.filter(id => !found.has(id));
  if (missing.length > 0) ctx.logger.info('对齐的用量：有唤醒单在账本里找不到，按 0 计', { agreementId: agreement.id, wakeIds: missing });
  return { turns: wakeIds.length, tokens: [...found.values()].reduce((sum, value) => sum + value, 0) };
}

/** 派活之后（这件事建好）记对齐这一步；已有用量行时只改 align，其余不动。出错只记日志。 */
export function recordAlignment(ctx: HubContext, job: Job): void {
  try {
    const agreement = ctx.store.table('agreements').get(job.agreementId);
    if (agreement === null) return;
    const now = ctx.clock.now();
    const row = usageRowOf(ctx, job, now);
    const align = alignmentOf(ctx, agreement);
    ctx.store.table('jobUsage').put(JobUsageSchema.parse({ ...row, steps: { ...row.steps, align }, updatedAt: now }));
  } catch (error) {
    try { ctx.logger.error('分步记账（对齐）失败', error); } catch { /* 同上。 */ }
  }
}

/**
 * 定稿：验收（onJobAccepted）和停止收尾时调用。写 finalizedAt、类别、定稿那一刻的合计；已经定稿的不再改。
 * 没有用量行的事（旧数据）不新建：全零的行会把同类估计拉低。定稿之后 recordJobTurn 仍会记（发布这一步在验收之后）。
 */
export function finalizeJobUsage(ctx: HubContext, jobId: string): void {
  try {
    const row = ctx.store.table('jobUsage').get(jobId);
    if (row === null || row.finalizedAt !== null) return;
    const now = ctx.clock.now();
    const totals = usageTotals(row);
    ctx.store.table('jobUsage').put(JobUsageSchema.parse({ ...row, category: jobCategory(ctx, jobId), finalizedAt: now,
      finalUsed: totals.turns, finalTokens: totals.tokens, updatedAt: now }));
    // P87：「你发起的回合」一栏在自己的表里写下定稿数（回执读它）；不动 jobUsage 的行。
    finalizeOwnerTurns(ctx, jobId, now);
  } catch (error) {
    try { ctx.logger.error('分步记账（定稿）失败', error); } catch { /* 同上。 */ }
  }
}

export { costLineOf } from './usage-text.js';

/**
 * 「你发起的回合」的记录（P87，遗留 I101）：这件事上你亲口说话或答复审批、由这件事的员工执行的回合，也用掉了 token，要让你看得到。
 *
 * 背景：job/turns.ts 的 countJobTurn 与 job/usage.ts 的 recordJobTurn 对你发起的回合一律不计（预计、预算线、
 * 六步都不含它，你自己说话不能让员工被预算线挡住）。这个口径不改。这里另外记一栏，只用于给你看的消耗文字：
 * 回执、进度行、逐回合明细、右侧栏「在办的事」。六步的回合数与 token、turnsUsed、turnCap、预计、同类估计一个数都不变。
 *
 * 存在哪里：新表 jobOwnerTurns（id 为 jobId），不写进 jobUsage 的行。jobUsage 是 strictObject，行里多了新键，
 * 数据退回旧版本后旧代码整行解析失败；新表旧版本直接忽略。所以 jobUsage 的行与 P87 之前逐字节相同。
 *
 * 归属规则：一个你发起的回合，满足下面任一条，就记在这件事的这一栏里：
 * 1 唤醒单带这件事的 jobId，做回合的是这件事的总管、执行者或核对人之一（现有代码里这类唤醒单来自审批答复，常叫醒执行者；
 *   入口：countJobTurn 建唤醒单时）；
 * 2 做回合的是这件事的总管，回合里对这件事成功调用了 hub_job_manage（任一 mode；assign 只按约定找刚建的事；入口：tools/common.ts 工具成功之后）；
 * 3 做回合的是这件事的总管，回合里对这件事依据的约定成功调用了 hub_agreement_submit（带 agreementId，任一 mode 含省略 mode 与 withdraw），
 *   而这件事存在、还没收尾。
 * 一张唤醒单最多记在一件事上（取先发生的那一件），同一件事上同一张唤醒单只记一次。
 * 「唤醒单属于哪件事」直接扫这张表：明细落盘，进程重启后对应关系不会丢，不需要另存内存表。
 * 没有用量行（jobUsage）的旧事不记、不新建：与 finalizeJobUsage 同理，旧事本来就没有消耗记录。
 *
 * token：回合记账（quota/usage.ts 的 recordUsage）时由 addOwnerTurnTokens 补进来，口径与六步明细相同（tokenBase 向上取整）；
 * 若记归属时账本里已有这张唤醒单的记账（先记账后记归属），当场按账本补齐。
 * 所有写入出错都只记日志，不能影响工具结果、回合开始和记账。
 */
import { BUDGET_DEFAULTS as D } from '../config/defaults.js';
import type { HubContext } from '../engine/context.js';
import { JobOwnerTurnsSchema, type JobOwnerTurns } from '../model/budget.js';
import type { Job } from '../model/job.js';
import type { WakeTicket } from '../model/wake.js';
import { isSkillWork } from '../skill/keys.js';
import { isJobClosed, jobOfAgreement } from './store.js';

/** 记归属需要的唤醒单字段（建唤醒单时的 WakeTicket 与工具里取到的唤醒单都满足）。 */
type OwnerWake = Pick<WakeTicket, 'id' | 'botId' | 'startedAt' | 'ownerInitiated' | 'reason' | 'subjectKey'>;

/** 这件事上你发起的回合（没有记过为 null）；文字函数读它。 */
export function ownerTurnsOf(ctx: HubContext, jobId: string): JobOwnerTurns | null {
  return ctx.store.table('jobOwnerTurns').get(jobId);
}

/** 这张唤醒单已经记在哪件事的这一栏里；没记过为 null。 */
function rowOfOwnerWake(ctx: HubContext, wakeId: string): JobOwnerTurns | null {
  return ctx.store.table('jobOwnerTurns').list(row => row.turns.some(turn => turn.wakeId === wakeId))[0] ?? null;
}

/** 账本里这张唤醒单的记账（取第一条回合账）；没有为 null。口径与 alignmentOf 相同：tokenBase 向上取整。 */
function ledgerOf(ctx: HubContext, wakeId: string): { tokens: number; at: number } | null {
  for (const entry of ctx.store.log('ledger').all()) {
    if (entry.kind === 'turn' && entry.wakeId === wakeId) return { tokens: Math.ceil(entry.tokenBase ?? entry.tokens), at: entry.at };
  }
  return null;
}

/**
 * 把这个回合记在这件事的这一栏。条件：唤醒单是你发起的、做回合的人有资格（见文件开头）、不是技能类事项键、
 * 这张唤醒单还没记在任何一件事上、这件事已经有用量行。出错只记日志。
 */
export function recordOwnerTurn(ctx: HubContext, wake: OwnerWake, job: Job, anyParticipant = false): void {
  if (!wake.ownerInitiated) return;
  // 工具成功的入口只认这件事的总管；带 jobId 的入口（anyParticipant）总管、执行者、核对人都算（审批答复常叫醒执行者）。
  const allowed = wake.botId === job.chiefId || (anyParticipant && (wake.botId === job.executorId || wake.botId === job.reviewerId));
  if (!allowed) return;
  if (isSkillWork(wake.reason.kind, wake.subjectKey)) return;
  try {
    if (rowOfOwnerWake(ctx, wake.id) !== null) return; // 已经记过（同一件事或另一件事），不重复、不转记
    if (ctx.store.table('jobUsage').get(job.id) === null) return;
    const row = ownerTurnsOf(ctx, job.id);
    const booked = ledgerOf(ctx, wake.id); // 先记账后记归属时，当场补齐
    const turns = [...(row?.turns ?? []), { wakeId: wake.id, botId: wake.botId, startedAt: wake.startedAt,
      endedAt: booked === null ? null : booked.at, tokens: booked === null ? 0 : booked.tokens }];
    while (turns.length > D.OWNER_TURNS_MAX) turns.shift(); // 明细超过上限丢最早的，合计不减
    const total = { turns: (row?.total.turns ?? 0) + 1, tokens: (row?.total.tokens ?? 0) + (booked === null ? 0 : booked.tokens) };
    ctx.store.table('jobOwnerTurns').put(JobOwnerTurnsSchema.parse({ ...(row ?? { id: job.id }), total, turns, updatedAt: wake.startedAt }));
  } catch (error) {
    try { ctx.logger.error('你发起的回合记账失败', error); } catch { /* 日志出错也不能挡住投递。 */ }
  }
}

/** 建唤醒单时：带 jobId 的你发起的回合（入口 1）。不是你发起的、没有 jobId、找不到这件事都不做。 */
export function recordOwnerTurnByJobId(ctx: HubContext, ticket: WakeTicket): void {
  if (!ticket.ownerInitiated || !ticket.jobId) return;
  try {
    const job = ctx.store.table('jobs').get(ticket.jobId);
    if (job !== null && job !== undefined) recordOwnerTurn(ctx, ticket, job, true);
  } catch (error) {
    try { ctx.logger.error('你发起的回合记账失败', error); } catch { /* 同上。 */ }
  }
}

/**
 * 工具成功之后（入口 2、3，由 defineTool 调用）：这个回合里办成了与这件事有关的事，就记在这件事上。
 * hub_job_manage：任一 mode；assign 不看参数里的 jobId（模型可能顺手带上已停止的旧事的编号），只按约定编号找刚建的事；
 *   其余 mode 按 jobId 找。
 * hub_agreement_submit：参数带约定编号（agreementId）就算，不限 mode；这份约定对应的事存在并且没有收尾才记。
 * 其余工具不记。
 */
export function recordOwnerTurnFromTool(ctx: HubContext, wake: OwnerWake, name: string, args: unknown): void {
  if (!wake.ownerInitiated) return;
  try {
    const input = (args ?? {}) as { mode?: unknown; jobId?: unknown; agreementId?: unknown };
    let job: Job | null = null;
    if (name === 'hub_job_manage') {
      if (input.mode === 'assign') {
        if (typeof input.agreementId === 'string') job = jobOfAgreement(ctx, input.agreementId);
      } else if (typeof input.jobId === 'string') job = ctx.store.table('jobs').get(input.jobId) ?? null;
    } else if (name === 'hub_agreement_submit' && typeof input.agreementId === 'string') {
      job = jobOfAgreement(ctx, input.agreementId);
      if (job !== null && isJobClosed(job)) job = null;
    }
    if (job !== null) recordOwnerTurn(ctx, wake, job);
  } catch (error) {
    try { ctx.logger.error('你发起的回合记账失败', error); } catch { /* 同上。 */ }
  }
}

/**
 * 这张唤醒单记账之后，把实测 token 补进它在这一栏里的那一项（recordUsage 调用，口径同 addJobTurnTokens）。
 * 没记在任何一件事上（与这件事无关的私聊回合、还没记归属）或这一项已补过时不做。出错只记日志。
 */
export function addOwnerTurnTokens(ctx: HubContext, wakeId: string, tokenBase: number, now: number): void {
  try {
    const row = rowOfOwnerWake(ctx, wakeId);
    if (row === null) return;
    const turn = row.turns.find(item => item.wakeId === wakeId);
    if (turn === undefined || turn.endedAt !== null) return;
    const base = Math.ceil(tokenBase);
    const turns = row.turns.map(item => item === turn ? { ...item, tokens: base, endedAt: now } : item);
    ctx.store.table('jobOwnerTurns').put(JobOwnerTurnsSchema.parse({ ...row, total: { turns: row.total.turns, tokens: row.total.tokens + base }, turns, updatedAt: now }));
  } catch (error) {
    try { ctx.logger.error('你发起的回合记账（token）失败', error); } catch { /* 同上。 */ }
  }
}

/**
 * 回合被退还（唤醒单建好后因你正在占用会话被撤掉）：撤掉这一栏里对应的一项，回合数减一、项里已有的 token 一并减掉。
 * 没记过（与这件事无关的回合、已被丢弃）不做。这一栏撤空且没有定稿数时整行删掉，表回到没记过的样子。
 */
export function undoOwnerTurn(ctx: HubContext, ticket: Pick<WakeTicket, 'id' | 'startedAt'>): void {
  try {
    const row = rowOfOwnerWake(ctx, ticket.id);
    if (row === null) return;
    const turn = row.turns.find(item => item.wakeId === ticket.id);
    if (turn === undefined) return;
    const left = row.turns.filter(item => item !== turn);
    const total = { turns: Math.max(0, row.total.turns - 1), tokens: Math.max(0, row.total.tokens - turn.tokens) };
    if (total.turns === 0 && left.length === 0 && row.finalTurns === undefined) { ctx.store.table('jobOwnerTurns').remove(row.id); return; }
    ctx.store.table('jobOwnerTurns').put(JobOwnerTurnsSchema.parse({ ...row, total, turns: left, updatedAt: ticket.startedAt }));
  } catch (error) {
    try { ctx.logger.error('你发起的回合记账（退还）失败', error); } catch { /* 同上。 */ }
  }
}

/**
 * 定稿（finalizeJobUsage 调用）：写下这一栏定稿那一刻的回合数与 token（回执读它）；这一栏没有回合时不写；已写过的不再改。
 */
export function finalizeOwnerTurns(ctx: HubContext, jobId: string, now: number): void {
  try {
    const row = ownerTurnsOf(ctx, jobId);
    if (row === null || row.total.turns === 0 || row.finalTurns !== undefined) return;
    ctx.store.table('jobOwnerTurns').put(JobOwnerTurnsSchema.parse({ ...row, finalTurns: row.total.turns, finalTokens: row.total.tokens, updatedAt: now }));
  } catch (error) {
    try { ctx.logger.error('你发起的回合记账（定稿）失败', error); } catch { /* 同上。 */ }
  }
}

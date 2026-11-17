/**
 * 执行链回合的计数（P74c，方案 7.2 的「计数」）：一处写入、一处函数。
 *
 * 为什么只放一处：回合上限（每件事 JOB_DEFAULTS.TURN_CAP 个）是执行链唯一的消耗兜底。P76 要把它改成「按预计消耗」时，
 * 只改这个文件里的 countJobTurn 就行，不用去找所有排队的地方。
 *
 * 调用位置：wake/ticket.ts 的 createTicket 在保存唤醒单之后立刻调用（唤醒单是一次回合的起点，
 * 重试、续排、兜底、回答、退回……最终都要经过它，所以不会漏）。
 *
 * 规则：
 * - 唤醒单带 jobId、不是主人发起的：这件事 turnsUsed 加 1。主人发起的总管回合不计入；
 * - 这位员工是执行者、这件事还是「待开工」：同时开工（ready 变 doing，记开工时间）。
 */
import type { HubContext } from '../engine/context.js';
import type { WakeTicket } from '../model/wake.js';
import { applyJobAction } from './state.js';
import { emitJobTopic, putJob } from './store.js';
import { recordOwnerTurnByJobId, undoOwnerTurn } from './owner-turns.js';
import { recordJobTurn, undoJobTurn } from './usage.js';

/** 建好唤醒单后计一个回合；出错只记日志，不能挡住投递。 */
export function countJobTurn(ctx: HubContext, ticket: WakeTicket): void {
  // P87：你发起的回合仍不计入这件事的回合数（turnsUsed）和六步；带 jobId 的另记在「你发起的总管回合」一栏，只用于给你看的消耗文字。
  if (ticket.ownerInitiated) { recordOwnerTurnByJobId(ctx, ticket); return; }
  if (!ticket.jobId) return;
  try {
    const job = ctx.store.table('jobs').get(ticket.jobId);
    if (!job) return;
    let next = { ...job, turnsUsed: job.turnsUsed + 1, updatedAt: ticket.startedAt };
    // 执行者的第一个回合：待开工变执行中。时间取唤醒单的开始时间，退还回合时据此认出这次开工。
    if (job.state === 'ready' && ticket.botId === job.executorId) next = applyJobAction(next, { type: 'start' }, ticket.startedAt);
    putJob(ctx, next);
    // P76e：分步记账：记进这件事的某一步；按加一之前的这件事判断属于哪一步（条件与上面的回合计数相同，技能类另外排除）。
    recordJobTurn(ctx, ticket, job);
    // P74r16b：回合开始：这件事的延迟说明（「排队中」）随之消失，状态也可能由待开工变成执行中；
    // 状态没变（已经是执行中）时 putJob 不发事件，这里补发，通知打开着的主题重新读取进度行。
    emitJobTopic(ctx, next);
  } catch (error) {
    try { ctx.logger.error('执行链回合计数失败', error); } catch { /* 日志出错也不能挡住投递。 */ }
  }
}

/**
 * 退还一个回合：唤醒单建好后又因为主人正在占用会话而被撤掉、没有真正开始时调用（engine/dispatch.ts）。
 * 不退还的话，等待期间每重试一次就白白用掉一个回合。若这个回合同时让事情从「待开工」变成「执行中」，也一并还原。
 */
export function refundJobTurn(ctx: HubContext, ticket: WakeTicket): void {
  // P87：你发起的回合没有计过回合数，只需撤掉「你发起的总管回合」一栏里对应的一项（没记过就什么都不做）。
  if (ticket.ownerInitiated) { undoOwnerTurn(ctx, ticket); return; }
  if (!ticket.jobId) return;
  try {
    const job = ctx.store.table('jobs').get(ticket.jobId);
    if (!job || job.turnsUsed <= 0) return;
    // P74r1（R8）：认出「这次开工」只看开工时间等于这张唤醒单的开始时间，不再要求这是第一个回合：
    // 改派后新执行者的第一个回合，回合数早已大于 1，旧条件会让撤回之后的事仍显示为执行中。
    const started = job.state === 'doing' && job.startedAt === ticket.startedAt;
    putJob(ctx, { ...job, turnsUsed: job.turnsUsed - 1, updatedAt: ticket.startedAt,
      ...(started ? { state: 'ready' as const, startedAt: null } : {}) });
    // P76e：分步记账也撤掉这一项（没记过就什么都不做）。
    undoJobTurn(ctx, ticket);
  } catch (error) {
    try { ctx.logger.error('退还执行链回合失败', error); } catch { /* 同上。 */ }
  }
}

/**
 * hub_job_work 各个 mode 共用的小工具（P74d）：找到「调用者所在的这件事」、统一的拒绝文字、
 * 以及「排一次唤醒并确认它不会被闸门直接丢弃」。
 *
 * 为什么把「闸门会不会丢弃」放在这里检查：工具返回「已交回」「已问总管」之前，下一个人必须真的会被叫醒。
 * 入队成功只说明候选进了队列；如果这件事的回合已经用到上限，候选一到调度就会被丢弃（job_cap），
 * 下一个人永远不会醒，状态却显示「核对中」。所以入队之后立刻用同一个纯函数 evaluateGates 重放一遍闸门：
 * 只有「会被丢弃」（drop 为真）才算失败，暂时被额度、并发、退避拦住只是等一等，不是失败。
 * 本文件只读存储（入队函数除外，它自带撤销闭包）。
 */
import type { HubContext } from '../engine/context.js';
import type { Bot } from '../model/bot.js';
import { JOB_STATE_LABELS, type Job } from '../model/job.js';
import type { QueueEntry } from '../model/wake.js';
import { buildSnapshot, evaluateGates } from '../scheduler/gates.js';
import type { ToolContext } from '../tools/types.js';
import { enqueueJobWakeUndoable, jobTitleOf, type JobWakeInput } from './chain.js';
import { activeJobsOf, isJobClosed } from './store.js';

/** 撤销步骤清单：失败时从后往前执行。 */
export type UndoSteps = Array<() => void | Promise<void>>;

/** 找到调用者所在的这件事。找不到或调用者与这件事无关：报错并列出调用者手上的事。 */
export function locateJob(ctx: HubContext, tc: ToolContext, jobId: string): { bot: Bot; job: Job } {
  const bot = ctx.store.table('bots').get(tc.botId);
  if (!bot) throw new Error('botId：员工不存在');
  const job = ctx.store.table('jobs').get(jobId);
  // 与这件事有关的人：执行者、核对人、这件事的总管（总管自己核对时也是核对人）。
  const involved = job !== null && (job.executorId === bot.id || job.reviewerId === bot.id || job.chiefId === bot.id);
  if (job === null || !involved) {
    const mine = activeJobsOf(ctx, bot.id);
    const listed = mine.length === 0 ? '无' : mine.map(row => `${jobTitleOf(ctx, row)}（${row.id}）`).join('、');
    throw new Error(`jobId：没有这件事，或你不在这件事里。你手上的事：${listed}`);
  }
  return { bot, job };
}

/** 已完成或已停止的事不能再有任何动作：说明原因。verb 是这次想做的事（「提问」「交回」……）。 */
export function assertJobOpen(job: Job, verb: string): void {
  if (isJobClosed(job)) throw new Error(`这件事${JOB_STATE_LABELS[job.state]}，不能再${verb}`);
}

/** 状态不对时的统一说法。allowed 是允许的状态词。 */
export function stateRefusal(job: Job, verb: string, allowed: readonly Job['state'][]): Error {
  return new Error(`这件事当前是「${JOB_STATE_LABELS[job.state]}」，只有${allowed.map(state => JOB_STATE_LABELS[state]).join('、')}时才能${verb}`);
}

/** 闸门丢弃原因换成一句话（给模型看）。 */
function dropWords(ctx: HubContext, job: Job, by: string): string {
  switch (by) {
    case 'job_cap': return `这件事的回合已经用到上限（${job.turnCap} 个），要等主人答复（再给回合或暂停）后才能继续`;
    case 'job_inactive': return '这件事现在不需要这次叫醒（已完成、已停止或在等主人验收）';
    case 'paused': return '对方此刻不在岗';
    default: return `闸门会直接丢弃这次叫醒（${by}）`;
  }
}

/**
 * 排一次唤醒并确认放得进去：入队、登记撤销、检查闸门。任何一步不成立都抛出中文错误，
 * 由调用方在 catch 里执行撤销清单。调用前，这件事的新状态必须已经写进存储（闸门读的是存储里的状态）。
 */
export function queueWake(ctx: HubContext, input: JobWakeInput, undo: UndoSteps, whom: string): QueueEntry {
  const wake = enqueueJobWakeUndoable(ctx, input);
  undo.push(wake.undo);
  if (wake.entry === null) throw new Error(`没有排上${whom}的队（${whom}此刻可能不在岗，或这次提醒被合并丢弃）`);
  const now = ctx.clock.now();
  const verdict = evaluateGates(wake.entry, buildSnapshot(ctx, input.botId, now, input.job.id), now, ctx.settings);
  if (!verdict.pass && verdict.drop) throw new Error(`叫不醒${whom}：${dropWords(ctx, input.job, verdict.by)}`);
  return wake.entry;
}

/**
 * 交回、提交核对结论专用的入队（P74e 修正）：和 queueWake 一样入队并重放闸门，区别只有一点——
 * 叫不醒下一个人的原因恰好是「这件事的回合用到上限」（job_cap）时，不当作失败：
 * 刚排上的候选撤掉（上限用完，它本来也会被闸门丢弃），返回 null，由调用方照常记录交回或核对结论，
 * 再交给回合上限的处理（job/cap.ts 的 blockForTurnCap）接手：这件事转为因回合上限受阻，「待你处理」里放一条，
 * 等主人决定是否追加回合。为什么这样：执行者在最后一个回合里已经做完了，却因为叫不醒核对人而交不上来，
 * 等主人追加回合后还要再花一个回合重交，是纯粹的浪费。
 * 其他原因（核对人已停用、不在岗、这件事已停止……）叫不醒，仍然抛出错误，由调用方整体恢复。
 */
export function queueWakeUnlessCapped(ctx: HubContext, input: JobWakeInput, undo: UndoSteps, whom: string): QueueEntry | null {
  const wake = enqueueJobWakeUndoable(ctx, input);
  if (wake.entry === null) {
    undo.push(wake.undo);
    throw new Error(`没有排上${whom}的队（${whom}此刻可能不在岗，或这次提醒被合并丢弃）`);
  }
  const now = ctx.clock.now();
  const verdict = evaluateGates(wake.entry, buildSnapshot(ctx, input.botId, now, input.job.id), now, ctx.settings);
  if (!verdict.pass && verdict.drop) {
    // 只有回合上限不算失败；撤掉刚排的候选，让队列保持入队前的样子。
    if (verdict.by === 'job_cap') { wake.undo(); return null; }
    undo.push(wake.undo);
    throw new Error(`叫不醒${whom}：${dropWords(ctx, input.job, verdict.by)}`);
  }
  undo.push(wake.undo);
  return wake.entry;
}

/** 执行撤销清单：从后往前，某一步出错只记日志，保证剩下的步骤仍会执行。 */
export async function runUndo(ctx: HubContext, undo: UndoSteps, what: string, jobId: string): Promise<void> {
  for (const step of [...undo].reverse()) {
    try { await step(); } catch (error) { ctx.logger.warn(`${what}恢复时某一步没有撤销成功`, { jobId, error: String(error) }); }
  }
}

/** 同步版的撤销：撤销清单里都是同步步骤时用（答复主人的条目是同步函数）。 */
export function runUndoSync(ctx: HubContext, undo: UndoSteps, what: string, jobId: string): void {
  for (const step of [...undo].reverse()) {
    try { void step(); } catch (error) { ctx.logger.warn(`${what}恢复时某一步没有撤销成功`, { jobId, error: String(error) }); }
  }
}

/** 第二段的一步：出错只记日志，不影响已经成功的状态。 */
export function softly(ctx: HubContext, what: string, work: () => void): void {
  try { work(); } catch (error) { ctx.logger.warn(`${what}失败`, { error: String(error) }); }
}

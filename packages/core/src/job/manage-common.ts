/**
 * hub_job_manage 的 answer、forward、stop、resume 四个 mode 共用的小工具（P74e）：
 * 确认调用者是总管、找到总管名下的这件事、判断本回合是不是主人发起的、一个名字解析函数。
 *
 * 为什么单独放一个文件：四个 mode 的前几步校验完全一样（只有总管；jobId 写错时要列出手上的事；
 * 「只能主人发起」的回合判断口径一致），各写一份容易走样。本文件只读存储，不写任何东西。
 */
import type { HubContext } from '../engine/context.js';
import type { Bot } from '../model/bot.js';
import { JOB_STATE_LABELS, type Job } from '../model/job.js';
import { wakeOfToolContext } from '../peer/common.js';
import type { WakeTicket } from '../model/wake.js';
import type { ToolContext } from '../tools/types.js';
import { jobTitleOf } from './chain.js';
import { isJobClosed } from './store.js';

/** 调用者必须是总管；action 是「回答」「转交材料」这类动作名，写进报错。 */
export function requireChief(ctx: HubContext, tc: ToolContext, action: string): Bot {
  const chief = ctx.store.table('bots').get(tc.botId);
  if (!chief || chief.role !== 'chief') throw new Error(`只有总管能${action}`);
  return chief;
}

/** 缺几项一次列全；mode 写进提示。 */
export function requireFields(mode: string, args: object, keys: readonly string[]): void {
  const missing = keys.filter(key => (args as Record<string, unknown>)[key] === undefined);
  if (missing.length > 0) throw new Error(`缺少必填项：${missing.join('、')}（mode 为 ${mode} 时都要填写）`);
}

/** 找到总管名下的这件事；找不到时报错并列出总管手上没收尾的事（标题和 jobId）。 */
export function chiefJobOf(ctx: HubContext, chief: Bot, jobId: string): Job {
  const job = ctx.store.table('jobs').get(jobId);
  if (job !== null && job.chiefId === chief.id) return job;
  const mine = ctx.store.table('jobs').list(row => row.chiefId === chief.id && !isJobClosed(row));
  const listed = mine.length === 0 ? '你现在没有在办的事'
    : `你手上的事：${mine.map(row => `「${jobTitleOf(ctx, row)}」（jobId 为 ${row.id}）`).join('、')}`;
  throw new Error(`jobId：没有你名下的这件事。${listed}`);
}

/** 这一回合的唤醒单；找不到时为 null。 */
export function currentWake(ctx: HubContext, tc: ToolContext): WakeTicket | null {
  return wakeOfToolContext(ctx, tc);
}

/** 本回合是不是主人发起的（主人发话、确认、回答叫醒的回合）。 */
export function isOwnerTurn(ctx: HubContext, tc: ToolContext): boolean {
  return currentWake(ctx, tc)?.ownerInitiated === true;
}

/**
 * P74r13：这件事此刻能不能转交材料（forward）：还没有收尾，并且不是「待你验收」（交付之后在等主人验收，转交没有人接）。
 * forward 自己的状态检查（job/forward.ts）和修订成功后的转交提醒（job/forward-reminder.ts）共用这一个判断，
 * 免得提醒出现了、总管照做却被拒。
 */
export function canForwardNow(job: Pick<Job, 'state'>): boolean {
  return !isJobClosed(job) && job.state !== 'awaiting_owner';
}

/** 已完成、已停止的事不能再有任何动作。 */
export function assertOpen(job: Job, verb: string): void {
  if (isJobClosed(job)) throw new Error(`这件事${JOB_STATE_LABELS[job.state]}，不能再${verb}`);
}

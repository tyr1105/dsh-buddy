/**
 * 解除受阻之后叫对的人、以及「先停下」的状态改法（P74f-2，补充要求 3.4 第 5 点、P74r3 第 2 点）。
 * 主人答复回合上限、「停住了」两类条目、选办法之后，这件事继续往下走，都要「叫此刻该动的人」，不能一律叫执行者：
 * 核对中叫核对人，返工中、执行中、待开工叫执行者，三轮不过等总管写说明的叫总管。口径与兜底巡检相同（expectedActorOf），
 * 这里只负责挑唤醒的原因并入队；入队成功与否交还调用方，调用方据此决定是否整体恢复。
 */
import type { HubContext } from '../engine/context.js';
import { JobSchema, type Job } from '../model/job.js';
import { newId } from '../util/ids.js';
import { enqueueJobWakeUndoable, expectedActorOf, type JobWakeWhy } from './chain.js';
import { markReleased } from './escalation-expiry.js';
import { applyJobAction } from './state.js';
import { queueWake, type UndoSteps } from './work-common.js';

/** 这件事此刻该叫谁（没有该叫的人时为 null）和用哪种原因叫。 */
export function actorToWake(job: Job): { botId: string; why: JobWakeWhy } | null {
  const botId = expectedActorOf(job);
  if (botId === null) return null;
  const why: JobWakeWhy = job.openAsk !== null && botId === job.chiefId ? 'asked'
    : job.state === 'blocked' ? 'escalate'
      : job.state === 'checking' ? 'to_review'
        : job.state === 'rework' ? 'returned' : 'resumed';
  return { botId, why };
}

/**
 * 叫此刻该动的人（状态必须已经写进存储：闸门读的是存储里的状态）。
 * 叫不醒（不在岗、回合已到上限）抛出中文错误，由调用方执行撤销清单；没有该叫的人返回 null。
 * 返回被叫醒的员工 id。
 */
export function wakeExpected(ctx: HubContext, job: Job, summary: string, undo: UndoSteps): string | null {
  const target = actorToWake(job);
  if (target === null) return null;
  const name = target.botId === job.chiefId ? '总管' : ctx.store.table('bots').get(target.botId)?.name ?? '对方';
  queueWake(ctx, { job, botId: target.botId, why: target.why, eventId: newId('jev', ctx.rng), summary }, undo, name);
  return target.botId;
}

/** 同上，但叫不醒时不抛错（只返回是否叫上）：用在「再叫一次」这类允许叫不醒、由巡检继续兜底的地方。 */
export function tryWakeExpected(ctx: HubContext, job: Job, summary: string): string | null {
  const target = actorToWake(job);
  if (target === null) return null;
  const wake = enqueueJobWakeUndoable(ctx, { job, botId: target.botId, why: target.why, eventId: newId('jev', ctx.rng), summary });
  if (wake.entry === null) { ctx.logger.warn('没有排上唤醒（对方此刻可能不在岗）', { jobId: job.id, botId: target.botId }); return null; }
  return target.botId;
}

/**
 * 「先停下」：这件事转为「你让先停下」（owner_hold）。已经受阻的事只改受阻原因（原来的受阻状态和回到的环节不变）；
 * 还在进行中的事（例如总管自己核对没有动静）先转受阻再改原因。条目编号清空。纯函数，不改入参。
 */
export function holdForOwner(job: Job, now: number): Job {
  const blocked = job.state === 'blocked' ? job : applyJobAction(job, { type: 'block', kind: 'turn_cap', no: null, text: '你已暂停' }, now);
  // P74r6：记下原来的受阻原因和条目信息，恢复时三轮不过、执行者做不下去的按它还原（已经是暂停的保持原来记下的）。
  const was = blocked.blocked!;
  const heldFrom = was.kind === 'owner_hold' ? was.heldFrom : job.state === 'blocked' ? { kind: was.kind, no: was.no, text: was.text } : undefined;
  const { heldFrom: _drop, ...restBlocked } = was;
  // 受阻原因变成「你已暂停」：原来的说明针对的受阻已经过去，没选的说明标为「已暂停」（P74r4a-m1，P74r6 分清原因）。
  return JobSchema.parse(markReleased({ ...blocked, inboxId: null, updatedAt: now,
    blocked: { ...restBlocked, kind: 'owner_hold', ...(heldFrom === undefined ? {} : { heldFrom }) } }, 'held'));
}

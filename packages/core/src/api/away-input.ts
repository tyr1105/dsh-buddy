/**
 * 从存储里取离开期间摘要的输入（P76i）：把时间段内每件事的事件、回合、当前状态整理成 away-views.ts 的纯函数要的样子。
 *
 * 为什么和纯函数分开：纯函数只管「输入 → 文字」；这里只读存储、不做任何文字判断，也不写任何东西。
 * 事件取自事件日志（内存里只保留近 14 天，摘要最长也就几天，够用）；回合数与 token 取自一件事的用量行里开始时间在时间段内的回合，
 * 与「在办的事」「用量表」同一个来源；通知次数取通知队列里这段时间已发出的行。
 */
import type { HubContext } from '../engine/context.js';
import { isJobClosed } from '../job/store.js';
import { inLaunchPhase } from '../job/launch-turns.js';
import { jobWaitState } from './active-jobs-views.js';
import type { AwayInput, AwayJobInput } from './away-views.js';
import { nameTable } from './job-progress-base.js';

/** 时间段 [from, to] 的摘要输入；now 是生成摘要的时刻（决定「今天」「昨天」）。 */
export function awayInputOf(ctx: HubContext, from: number, to: number, now: number): AwayInput {
  const within = (at: number): boolean => at >= from && at <= to;
  // 事件日志只读一遍，按事件所属的事分组。
  const eventsByJob = new Map<string, AwayInput['jobs'][number]['events']>();
  for (const event of ctx.store.log('jobEvents').all()) {
    if (!within(event.at)) continue;
    const list = eventsByJob.get(event.jobId) ?? [];
    list.push({ kind: event.kind, at: event.at, actor: event.actor, to: event.to, data: event.data });
    eventsByJob.set(event.jobId, list);
  }
  const jobs: AwayJobInput[] = [];
  for (const job of ctx.store.table('jobs').list()) {
    const turns = (ctx.store.table('jobUsage').get(job.id)?.turns ?? []).filter(turn => within(turn.startedAt));
    const events = (eventsByJob.get(job.id) ?? []).sort((a, b) => a.at - b.at);
    // 没收尾（含发布环节）的事才可能「仍在等你」；已收尾的事只有这段时间里有回合或事件时才进摘要。
    const open = !isJobClosed(job) || inLaunchPhase(job);
    if (turns.length === 0 && events.length === 0 && !open) continue;
    const wait = jobWaitState(ctx, job, now);
    jobs.push({
      title: ctx.store.table('agreements').get(job.agreementId)?.title ?? '未命名',
      turns: turns.length, tokens: turns.reduce((sum, turn) => sum + turn.tokens, 0),
      lastTurnAt: turns.length === 0 ? null : Math.max(...turns.map(turn => turn.startedAt)),
      events, stateLabel: wait.stateLabel, waitingOn: wait.waitingOn,
      // 已收尾的事不算「仍在等你」（已完成但在发布环节的除外，它还没有收尾）。
      waitingOwner: open && wait.waitingOwner, waitItem: open ? wait.itemText : null,
      hasOpenItem: open && wait.hasOpenItem, noticeItem: open ? wait.noticeText : null, waitedMs: wait.waitedMs,
    });
  }
  const sentCount = ctx.store.table('pushQueue').count(row => row.state === 'sent' && row.sentAt !== null && within(row.sentAt));
  return { from, to, now, timezone: ctx.settings.timezone, names: nameTable(ctx), jobs, sentCount };
}

/**
 * 一件事的巡检（P74c，方案 7.2 的「兜底」与 7.3 的「回合上限」；P76g 把兜底换成停滞判断）：engine/tick.ts 每个 tick 在调度之前调用一次。
 *
 * 为什么需要：执行链靠「谁完成一步就叫醒下一步的人」接力，但接力可能断——回合被打断、额度故障没有重试、
 * 总管停用期间的唤醒被清掉、员工交账时什么都没做……巡检保证没有任何一件进行中的事会无声无息地停下。检查项：
 *
 * 一、回合上限：进行中（待开工、执行中、核对中、返工中）且已用回合数达到上限的事，停下并告诉主人（job/cap.ts）。
 * 二、预计消耗：已用加余下大于预算线就问一次（job/budget-ask.ts，P76f）。
 * 三、停滞（P76g，job/stall-check.ts）：停摆（距最近一次记录满 2 小时，先重新唤醒一次，再过 1 小时仍没有记录才通知你）、
 *    空转（连续 3 个回合没有新文件或新证据，直接通知你）、逾期（过了交付时间，直接通知你）。
 *    原来的兜底（30 分钟、叫两次、转受阻叫总管）已整段删除：它会在一个很短的时间里把事情推给总管，
 *    而总管多半也解决不了；现在先轻轻叫一次，仍没有动静才由主人定。
 * 四、在等你满 24 小时的提醒（job/wait-remind.ts，P76g）：总管私聊提醒一次。
 *
 * 每件事各自兜底：一件事出错只记日志，不影响别的事。
 */
import type { HubContext } from '../engine/context.js';
import type { Job, JobEvent } from '../model/job.js';
import type { ThreadMessage } from '../model/outreach.js';
import { repairBlockItems } from './block-items.js';
import { blockForTurnCap } from './cap.js';
import { checkBudget, repairCapStop } from './budget-ask.js';
import { isJobClosed } from './store.js';
import { isIdleResumeEvent } from './sweep-events.js';
import { catchUpJobFollowUps } from './catch-up.js';
import { ensureDeliveries } from './deliver.js';
import { recheckLaunchCaps } from './launch-approval.js';
import { sweepStalledLaunches } from './launch-blocked.js';
import { checkStall } from './stall-check.js';
import { remindWaitingOwner } from './wait-remind.js';

export { isIdleResumeEvent };

/** 巡检所有没收尾的事。 */
export function sweepJobs(ctx: HubContext, now: number): void {
  // P74r2b：约定已固定而收尾没做完（进程退出留下的），补做；暂停指向已撤下的版本，按撤销处理（见 catch-up.ts）。
  catchUpJobFollowUps(ctx);
  // P74f：待你验收的事缺交付卡或验收条目时补齐（核对通过时进程退出、建条目失败留下的）。
  ensureDeliveries(ctx);
  // P74r4b-m1：发布这一步已用满回合上限、命令已运行而结果还没记下的事，再看一次（到终点状态按结果说，满 30 分钟按「结果没有记录下来」说）。
  recheckLaunchCaps(ctx);
  // P74r7：发布准备中、没有审批、没有人被排着、30 分钟没有动静的事，结束发布这一步（兜底）。
  sweepStalledLaunches(ctx, now);
  const jobs = ctx.store.table('jobs').list(job => !isJobClosed(job));
  if (jobs.length > 0) sweepOpenJobs(ctx, jobs, now);
  // P76g：在等你满 24 小时的提醒（也包括还没有事的约定确认条目，所以没有进行中的事时也要看）。出错只记日志。
  try {
    remindWaitingOwner(ctx, now);
  } catch (error) {
    try { ctx.logger.error('在等你的提醒失败', { error: String(error) }); } catch { /* 日志出错也不能挡住别的事。 */ }
  }
}

/** 逐件检查没收尾的事。 */
function sweepOpenJobs(ctx: HubContext, jobs: Job[], now: number): void {
  // 事件日志只读一遍，按事分组（每个 tick 都会跑，不能每件事各扫一遍）。
  const byJob = new Map<string, JobEvent[]>();
  for (const event of ctx.store.log('jobEvents').all()) {
    const rows = byJob.get(event.jobId);
    if (rows) rows.push(event);
    else byJob.set(event.jobId, [event]);
  }
  // 这些事的主题里的消息同样只读一遍（停滞判断的「记录」包含主题里的任一条消息）。
  const topics = new Set(jobs.map(job => job.topicId));
  const earliest = Math.min(...jobs.map(job => job.assignedAt));
  const byTopic = new Map<string, ThreadMessage[]>();
  for (const message of ctx.store.log('thread').since(earliest, row => topics.has(row.thread))) {
    const rows = byTopic.get(message.thread);
    if (rows) rows.push(message);
    else byTopic.set(message.thread, [message]);
  }
  for (const job of jobs) {
    try {
      // P74r4a 第 3 条：先自我修复条目编号与受阻条目（编号指向已关闭的条目、不在受阻却有开着的说明或「没有进展」条目），
      // 免得旧编号让巡检不叫总管、事情无声停下。
      repairBlockItems(ctx, job.id, now);
      // 第一项：回合上限。
      if (blockForTurnCap(ctx, job.id, now)) continue;
      // P76f：预算线之前先看预计消耗：已用加余下大于预算线就问一次（这件事不停；兜底，回合收尾时已经看过一次）。
      checkBudget(ctx, job.id);
      // 小修：因预算线受阻的事必有条目或等确认的新版本；没有就重新建条目。
      if (repairCapStop(ctx, job.id)) continue;
      // 第二项：停滞判断（读最新的记录，上一步可能已经改过它）。
      const fresh = ctx.store.table('jobs').get(job.id);
      if (fresh) checkStall(ctx, fresh, now, { events: byJob.get(job.id) ?? [], topicMessages: byTopic.get(job.topicId) ?? [] });
    } catch (error) {
      try { ctx.logger.error('一件事的巡检失败', { jobId: job.id, error: String(error) }); } catch { /* 日志出错也不能挡住别的事。 */ }
    }
  }
}

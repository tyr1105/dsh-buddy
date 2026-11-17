/**
 * 发布这一步做不成时的收尾（P74r7 第 2 节）。
 *
 * 为什么需要：真实模型当执行者时，发现约定里没有写发布到哪里、用什么方式，没有提交发布审批，以「受阻」交账。
 * 之后没有任何人被叫醒，「待你处理」里没有条目，总管私聊里没有话，这件事的发布状态一直停在「准备中」，
 * 主人看到总管说过「下一步是对外发布」，然后再也没有下文。
 *
 * 本文件管三件事：
 * 1. 发布准备的回合结束时的接续（continueLaunchAfterCommit）：
 *    交账写的是做不下去（blocked，或执行者不能直接问主人的 needs_owner）、而且还没有发布审批：立即结束发布这一步，
 *    发布状态记为「暂不发布」（endedBy 记 hub：是中心结束的，不是主人决定的），在总管私聊以总管名义落一句；
 *    不是做不下去：照常接着排下一回合，直到发布这一步自己的回合上限（上限的结束语已有，见 launch-approval.ts）。
 * 2. 兜底（sweepStalledLaunches，巡检调用）：发布状态是「准备中」、没有发布审批、执行者没有排着的唤醒也不在回合中，
 *    而且已经 30 分钟没有任何动静：按第一种文字（不带原因）结束。
 * 3. 那句话本身（launchBlockedText），原因要过内部名称检查。
 */
import type { HubContext } from '../engine/context.js';
import type { Commit, WakeTicket } from '../model/wake.js';
import type { Job } from '../model/job.js';
import { postThread } from '../outreach/thread.js';
import { LAUNCH_LOCATION_BLOCKER } from '../gate/host-writable.js';
import { isOnDutyNow, jobTitleOf } from './chain.js';
import { markDeclined, wakeForLaunch } from './launch-approval.js';
import { internalNameIn, oneLineClip } from './owner-text.js';
import { eventsOf } from './store.js';

/** 兜底：发布准备中的事这么久没有任何动静，就结束这一步（30 分钟）。 */
export const LAUNCH_STALL_MS = 30 * 60 * 1000;

/** 发布准备中执行者调用提问被拒的文字（给模型看）。 */
export const LAUNCH_ASK_REFUSAL_TEXT = '这件事已完成，不能再提问。发布缺条件时，交账的结果写 blocked，blocker 写清缺什么，中心会转告主人。';

/** 原因最多显示多少字（超出截断加省略号）。 */
const REASON_MAX_CHARS = 80;

/**
 * P74r19 第 3 节：发布位置写不进去时总管私聊里那句固定的话（逐字；不引用执行者的原话）。
 * 为什么固定：第三次真实模型验证里，引用执行者的原话被截断成「…中心代为运行的发…」，还带着「中心可写范围」「~/Desktop」这类主人看不懂的说法。
 */
export function launchLocationBlockedText(title: string): string {
  // P81 第 4 节：改为这句（逐字）：位置不在员工能写的范围内，多半是约定里没有写明发布到主人电脑上的哪个文件夹。
  return `${title}没有发布：约定里没有写明发布到你电脑上的哪个文件夹，员工写不进去。做好的成果在项目文件夹里。告诉我具体的文件夹（例如桌面上的一个文件夹），我再安排。`;
}

/**
 * P74r20 第 1 节第 1 条：发布命令已经运行过、没有成功（发布状态 failed），执行者被叫醒后交账写做不下去时，总管私聊里那句固定的话（逐字；不引用执行者的原话）。
 * 为什么固定：主人在这之前已经从中心那里看到过「没有发布成功：……」那句白话；执行者的原话常带路径和权限字样（第四次真实模型验证），不需要再给主人看。
 */
export function launchFailedBlockedText(title: string, executor: string): string {
  return `${title}没有发布：发布命令没有运行成功，${executor}无法改正。要换一个发布位置或方式时告诉我，我再安排。`;
}

/** 取原因的第一句：到第一个「。」「；」「！」「？」或换行为止，不含这个标点（P74r19 第 3 节第 2 条）。 */
function firstSentenceOf(text: string): string {
  return text.split(/[。；！？\r\n]/)[0] ?? '';
}

/**
 * 总管私聊里那句话（三种文字，逐字固定）：
 * - 原因里含「发布位置不在能写入的范围内」：用固定的那一句（P74r19，不引用执行者的原话）；
 *   任务卡还写了「这次发布准备期间有过一次预先核对的拒绝」也算，但预先核对的拒绝只抛错给模型，不留任何记录，判断不了，所以只按原因判断（记入 docs/questions.md）；
 * - 其他原因：只引用原因的第一句，再按 80 字上限截断（截断加「…」）；
 * - 空原因、或原因里含内部名称（工具名、编号等）：不写原因，免得主人看到看不懂的名称。
 */
export function launchBlockedText(input: { title: string; executor: string; reason: string | null; afterFailed?: boolean }): string {
  const { title, executor } = input;
  // 发布命令已运行过、没有成功：不引用执行者的原话，落固定的一句。
  if (input.afterFailed === true) return launchFailedBlockedText(title, executor);
  const tail = '没有发布。要发布时告诉我发布到哪里、用什么方式，我再安排。';
  const full = (input.reason ?? '').replace(/\s+/g, ' ').trim();
  if (full.includes(LAUNCH_LOCATION_BLOCKER)) return launchLocationBlockedText(title);
  // 先在换行处取第一句、再整理空白；内部名称仍按整段原因检查（比只查第一句更保守）。
  const reason = firstSentenceOf(input.reason ?? '').replace(/\s+/g, ' ').trim();
  if (reason === '' || internalNameIn(full) !== null) return `${title}的发布这一步没有做成：${executor}说缺少条件。${tail}`;
  return `${title}的发布这一步没有做成：${executor}说缺少条件（${oneLineClip(reason, REASON_MAX_CHARS)}）。${tail}`;
}

/** 发布这一步处于「准备中」：已验收、发布状态是准备中、还没有发布审批。 */
function isPreparingWithoutApproval(job: Job): boolean {
  return job.state === 'done' && job.launch.state === 'preparing' && job.launch.approvalId === null;
}

/**
 * 结束发布这一步：先改发布状态（写失败会抛出，什么都不会说），再在总管私聊以总管名义落一句。
 * reason 为空表示不写原因（兜底）。
 */
export function endLaunchBlocked(ctx: HubContext, job: Job, reason: string | null, why: 'executor_blocked' | 'stalled', now: number): void {
  // 在改发布状态之前记下：这一步是不是「发布命令运行没有成功」之后结束的（决定用哪句话）。
  const afterFailed = job.launch.state === 'failed';
  markDeclined(ctx, job, now, { reason: why }, 'hub');
  try {
    const executor = ctx.store.table('bots').get(job.executorId)?.name ?? '执行者';
    postThread(ctx, { thread: job.chiefId, from: job.chiefId, kind: 'reply', refId: job.id, text: launchBlockedText({ title: jobTitleOf(ctx, job), executor, reason, afterFailed }) });
  } catch (error) {
    ctx.logger.warn('总管私聊里发布没有做成的说明没有落下', { jobId: job.id, error: String(error) });
  }
}

/**
 * 发布准备的回合交账之后（job/continue.ts 调用，这件事已是「已完成」）：
 * - 只管这件事的执行者、发布状态是准备中、还没有发布审批的情形；已经提交审批（状态不再是准备中）的不管；
 * - 交账写 blocked 或 needs_owner（执行者不能直接问主人，按做不下去处理）：结束发布这一步，原因取交账的 blocker；
 * - 其余（还没做完、中心替没交账的回合合成的交账）：接着排下一回合，受发布这一步自己的回合上限约束。
 */
export function continueLaunchAfterCommit(ctx: HubContext, commit: Commit, wake: WakeTicket, job: Job): void {
  // P74r18b：发布没有成功（failed）之后，执行者被叫醒的那个回合交账写 blocked 或 needs_owner：走同一条「发布做不成」的收尾
  // （发布状态记为暂不发布，总管私聊说明）。其他交账不续排：失败的原因不会因为再叫一次而变，进度行写「已完成（发布没有成功）」，在等你。
  if (commit.botId === job.executorId && job.launch.state === 'failed') {
    if (wake.startedAt < (job.acceptedAt ?? 0)) return;
    if (wake.syntheticCommit !== true && (commit.outcome === 'blocked' || commit.outcome === 'needs_owner')) {
      endLaunchBlocked(ctx, job, commit.blocker ?? null, 'executor_blocked', ctx.clock.now());
    }
    return;
  }
  if (commit.botId !== job.executorId || !isPreparingWithoutApproval(job)) return;
  // 验收之前开始的回合（极少见的迟到交账）不属于发布准备。
  if (wake.startedAt < (job.acceptedAt ?? 0)) return;
  const now = ctx.clock.now();
  if (wake.syntheticCommit !== true && (commit.outcome === 'blocked' || commit.outcome === 'needs_owner')) {
    endLaunchBlocked(ctx, job, commit.blocker ?? null, 'executor_blocked', now);
    return;
  }
  // 已经排着发布的唤醒时不重复排。
  if (ctx.store.table('queue').count(row => row.botId === job.executorId && row.jobId === job.id) > 0) return;
  if (!wakeForLaunch(ctx, job)) ctx.logger.warn('发布准备的续排没有排上（员工此刻可能不在岗），等兜底巡检处理', { jobId: job.id });
}

/** 这件事最近一次有动静的时间：验收时间、执行者在这件事上的回合（开始或结束）、这件事的事件，取最晚的。 */
function lastActivityOf(ctx: HubContext, job: Job): number {
  let latest = job.acceptedAt ?? job.updatedAt;
  for (const wake of ctx.store.table('wakes').list(row => row.botId === job.executorId && row.jobId === job.id)) {
    latest = Math.max(latest, wake.startedAt, wake.endedAt ?? 0);
  }
  for (const event of eventsOf(ctx, job.id)) latest = Math.max(latest, event.at);
  return latest;
}

/**
 * 兜底巡检（job/sweep.ts 每个 tick 调用一次）：
 * 发布准备中、没有发布审批、执行者没有排着的唤醒、也不在回合中，持续超过 30 分钟：结束这一步，不写原因。
 * 执行者此刻不在岗（停用）的不处理：他恢复在岗时由中心叫醒（resumeLaunchOfReinstated），那时这一步还要做。
 * 每件事各自 try/catch：一件事出错只记日志。
 */
export function sweepStalledLaunches(ctx: HubContext, now: number): void {
  for (const job of ctx.store.table('jobs').list(isPreparingWithoutApproval)) {
    try {
      if (!isOnDutyNow(ctx, job.executorId)) continue;
      if (ctx.store.table('queue').count(row => row.botId === job.executorId && row.jobId === job.id) > 0) continue;
      if (ctx.store.table('wakes').count(wake => wake.botId === job.executorId && wake.jobId === job.id && wake.endedAt === null
        && ['delivering', 'running', 'committed'].includes(wake.status)) > 0) continue;
      if (now - lastActivityOf(ctx, job) < LAUNCH_STALL_MS) continue;
      endLaunchBlocked(ctx, job, null, 'stalled', now);
    } catch (error) {
      ctx.logger.warn('发布准备的兜底巡检失败', { jobId: job.id, error: String(error) });
    }
  }
}

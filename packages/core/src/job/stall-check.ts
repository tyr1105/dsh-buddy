/**
 * 停滞判断（P76g，方案 7.6；P76r3 按审查 R1、R2、R4、R11 改写）：每个 tick 的巡检里，对每件进行中的事判断「是不是停滞了、该做什么」。
 * 替换第三块的兜底（30 分钟、两次、转受阻叫总管）。
 *
 * 分两层：
 * - stallOf：纯函数。输入全是已经读好的事实，输出「哪一种停滞」或「不算停滞的原因码」，原因码给测试断言；
 * - checkStall：读取层。读事件、主题消息、队列、额度闸门，算出事实，调用 stallOf，然后按结果处理：
 *   停摆先重新唤醒一次（不受 24 小时通知间隔限制），再过 1 小时仍没有记录才通知你；空转、逾期直接通知你。
 *
 * 只对进行中的事：待开工、执行中、核对中、返工中，以及受阻且在等总管的（执行者做不下去；核对三轮不过、总管还没说明）。
 *
 * 「在等你」有两个口径（P76r3，job/owner-ask.ts）：
 *   甲 真的停下在等你（与闸门口径相同）：不算停滞，重新唤醒和通知都不做；
 *   乙 这件事有任一开着的 job:<编号>: 条目（含不记进 job.inboxId 的「将超出预计」条目）：不发新的停滞通知，
 *     但停摆的重新唤醒照做（推进与通知是两件事）；逾期因此没有通知成时不写 overdueNotifiedFor，等条目了结后再判。
 *
 * 其余先排除（任一成立就不算停滞，按下面的顺序取第一个原因）：
 *   budget 预算线用完（主人已经由预计消耗条目知道了）；
 *   quota 预期的人的候选被额度挡住（等额度恢复不算没有进展）；
 *   off_duty 预期的人不在岗（含你一键停用全队）；
 *   launch 在发布环节（发布有自己的兜底）。
 * 然后判断三种：
 *   overdue 逾期：过了交付时间，且这个交付时间还没通知过；不受「有回合在排」的排除；
 *   spin    空转：预期的人连续 SPIN_TURNS 个已结束的回合没有新文件或新证据（算法见 stall-spin.ts）；
 *   idle    停摆：距离最近一次记录已经 STALL_IDLE_MS（2 小时）。
 *   idle 和 spin 都要求预期的人没有回合在跑、也没有候选在排队（排着的候选说明接力没断，只是在等）；这一条照任务卡的 running 排除。
 *   注意：续排不断时，下一个回合的候选一直排着，所以空转只会在接力断了（没有候选排着）之后才判出来
 *   （见 docs/questions.md P76g 第 1 条）。
 *
 * 处理顺序（P76r3 3.1）：
 *   1 现算「记录」，更新提醒记号；
 *   2 通知之后有了新记录、开着的是停摆、空转或「回合被结束」的条目（stallKind 不是 overdue）：撤回，答复栏「这件事有了新进展」；
 *     逾期的条目不因新记录撤回（R2：逾期之后这件事本来就还在做，有新进展不等于交付时间的问题解决了）；
 *   3 逾期的条目开着、而交付时间已经不是通知时的那个：撤回，答复栏「交付时间已改」；
 *   4 第 2、3 步撤回后清空条目编号：先重读这件事，只在编号仍等于被撤回的那一条时才清空（R11）；
 *   5 排除甲、预算线、额度、不在岗、发布；判定逾期、空转、停摆；
 *   6 停摆：还没有重新唤醒过就重新唤醒一次（不受 24 小时通知间隔限制，R4）；重新唤醒之后满 1 小时仍没有记录，才进入通知；
 *   7 发通知之前：乙不成立，并且满足「从没通知过，或距上次通知满 24 小时且之后有新记录」，否则返回 held。
 */
import { BUDGET_DEFAULTS as D } from '../config/defaults.js';
import type { HubContext } from '../engine/context.js';
import type { JobNotice, StallKind } from '../model/budget.js';
import type { Job, JobEvent } from '../model/job.js';
import type { ThreadMessage } from '../model/outreach.js';
import { buildSnapshot, evaluateGates } from '../scheduler/gates.js';
import { listQueue } from '../scheduler/queue.js';
import { isOpenWake } from '../turn/session.js';
import { newId } from '../util/ids.js';
import { enqueueJobWake, expectedActorOf, isOnDutyNow, jobTitleOf } from './chain.js';
import { confirmWaitNo } from './confirm-wait.js';
import { inLaunchPhase } from './launch-turns.js';
import { clearOverdueMark, noticeOf, patchNotice } from './notices.js';
import { hasAnyOpenJobItem, ownerAskOpenOf } from './owner-ask.js';
import { lastProgressAtOf } from './progress-mark.js';
import { reportStall, stallSubjectPrefix, withdrawStallItems } from './stall.js';
import { spinRunOf } from './stall-spin.js';
import { appendJobEvent } from './store.js';

/** 不算停滞的原因码。 */
export const STALL_EXCLUSIONS = ['waiting_owner', 'budget', 'quota', 'off_duty', 'launch', 'not_applicable', 'no_actor', 'running'] as const;
export type StallExclusion = (typeof STALL_EXCLUSIONS)[number];

/** 判断的结果：算停滞给出种类；不算且有原因给出原因码；什么都不用做两者都为 null。 */
export interface StallVerdict { kind: StallKind | null; reason: StallExclusion | null }

/** stallOf 的输入：全是已经读好的事实。 */
export interface StallInput {
  now: number;
  job: Job;
  /** 预期的人（expectedActorOf）；没有人在等为 null。 */
  actor: string | null;
  /** 甲：这件事真的停下在等你（与闸门口径相同，见 job/owner-ask.ts）。 */
  waitingOwner: boolean;
  /** 预期的人排着的候选，重放闸门的结果是额度挡住。 */
  quotaBlocked: boolean;
  /** 预期的人此刻在岗。 */
  actorOnDuty: boolean;
  /** 预期的人在这件事上有候选在排队。 */
  actorQueued: boolean;
  /** 预期的人在这件事上有回合正在跑。 */
  actorRunning: boolean;
  /** 最近一次记录的时间。 */
  lastProgressAt: number;
  /** 已为哪个交付时间通知过逾期。 */
  overdueNotifiedFor: number | null;
  /** 预期的人连续几个已结束的回合没有新文件或新证据（用到时才算，读审计记录比较费）。 */
  spinRun: () => number;
}

/** 受阻的事里，哪些是「在等总管」（算进行中）：执行者做不下去；核对三轮不过且总管还没说明。 */
function blockedWaitingChief(job: Job): boolean {
  if (job.blocked === null) return false;
  if (job.blocked.kind === 'executor') return true;
  return job.blocked.kind === 'review_limit' && (job.escalation == null || job.escalation.stage !== job.stage);
}

/** 纯函数：判断一件事是不是停滞。 */
export function stallOf(input: StallInput): StallVerdict {
  const { job, now } = input;
  const none = (reason: StallExclusion): StallVerdict => ({ kind: null, reason });
  // 先排除，按固定顺序取第一个成立的。
  if (input.waitingOwner || confirmWaitNo(job) !== null || job.pause !== null || job.state === 'awaiting_owner') return none('waiting_owner');
  if (job.turnsUsed >= job.turnCap) return none('budget');
  if (input.quotaBlocked) return none('quota');
  if (input.actor !== null && !input.actorOnDuty) return none('off_duty');
  if (inLaunchPhase(job)) return none('launch');
  const active = job.state === 'ready' || job.state === 'doing' || job.state === 'checking' || job.state === 'rework'
    || (job.state === 'blocked' && blockedWaitingChief(job));
  if (!active) return none('not_applicable');
  if (input.actor === null) return none('no_actor');
  // 逾期不受「有回合在排」的排除。
  if (job.dueAt !== null && now >= job.dueAt && input.overdueNotifiedFor !== job.dueAt) return { kind: 'overdue', reason: null };
  // 预期的人有回合在跑、或有候选排着（接力没断，只是在等）：空转、停摆都不判。
  if (input.actorQueued || input.actorRunning) return none('running');
  if (input.spinRun() >= D.SPIN_TURNS) return { kind: 'spin', reason: null };
  if (now - input.lastProgressAt >= D.STALL_IDLE_MS) return { kind: 'idle', reason: null };
  return { kind: null, reason: null };
}

/** checkStall 做了什么：none 没有动作；held 前置不满足；waiting 重新唤醒之后还在等那一小时；rewoke 重新唤醒了一次；notified 通知了你。 */
export type StallAction = 'none' | 'held' | 'waiting' | 'rewoke' | 'notified';
export interface StallOutcome extends StallVerdict { action: StallAction }

/** 巡检一次读好的、按事分组的数据（每个 tick 只读一遍，不能每件事各扫一遍）。 */
export interface StallShared {
  events: readonly JobEvent[];
  topicMessages: readonly ThreadMessage[];
}

/** 预期的人的候选重放闸门，结果是不是额度挡住（做法同 delay.ts 的延迟说明，不写日志、不改状态）。 */
function quotaBlockedFor(ctx: HubContext, job: Job, actor: string, now: number): boolean {
  const entry = listQueue(ctx).find(row => row.jobId === job.id && row.botId === actor);
  if (entry === undefined) return false;
  const verdict = evaluateGates(entry, buildSnapshot(ctx, actor, now, job.id), now, ctx.settings);
  return !verdict.pass && verdict.by === 'quota';
}

/** 重新唤醒一次：排一次 idle 唤醒、追加 resumed 事件（data.idle 为真，不算记录）、记 rewakeAt。排不上只记日志，下个 tick 再试。 */
function rewake(ctx: HubContext, job: Job, actor: string, now: number): boolean {
  const eventId = newId('jev', ctx.rng);
  const entry = enqueueJobWake(ctx, {
    job, botId: actor, why: 'idle', eventId,
    summary: `「${jobTitleOf(ctx, job)}」已有一阵子没有动静，请接着做或说明卡在哪`,
  });
  if (entry === null) {
    ctx.logger.warn('停摆的重新唤醒没有排上（员工此刻可能不在岗），下个 tick 再试', { jobId: job.id, botId: actor });
    return false;
  }
  appendJobEvent(ctx, { id: eventId, jobId: job.id, actor: 'hub', kind: 'resumed', to: [actor], refId: null, data: { idle: true } });
  patchNotice(ctx, job.id, { rewakeAt: now });
  return true;
}

/** 通知的前置：从没通知过，或距上次通知满 24 小时且上次通知之后有了新记录。 */
function mayNotify(notice: Pick<JobNotice, 'stallNotifiedAt'>, lastProgressAt: number, now: number): boolean {
  return notice.stallNotifiedAt === null
    || (now - notice.stallNotifiedAt >= D.STALL_NOTIFY_GAP_MS && lastProgressAt > notice.stallNotifiedAt);
}

/** 读取层：现算「记录」写进提醒记号，判断，处理。出错抛出，由 sweepJobs 按事兜底记日志。 */
export function checkStall(ctx: HubContext, jobIn: Job, now: number, shared: StallShared): StallOutcome {
  let job = jobIn;
  // 一、记录：现算，写进 jobNotices.lastProgressAt；比 rewakeAt 新就清空 rewakeAt 与 stallKind（有了新进展，计时重新开始）。
  const lastProgressAt = lastProgressAtOf(job, shared.events, shared.topicMessages);
  let notice = noticeOf(ctx, job.id);
  const changes: Partial<Omit<JobNotice, 'id'>> = {};
  if (notice.lastProgressAt !== lastProgressAt) changes.lastProgressAt = lastProgressAt;
  if (notice.rewakeAt !== null && lastProgressAt > notice.rewakeAt) {
    changes.rewakeAt = null;
    // P76r3（R2）：逾期通知的记号留到条目了结（交付时间改了、你答复了、这件事待你验收），
    // 不能因为有了新记录就丢掉——那样下一次巡检会把还开着的逾期条目当成停摆条目撤回。
    if (notice.stallKind !== 'overdue') changes.stallKind = null;
  }
  if (Object.keys(changes).length > 0) {
    patchNotice(ctx, job.id, changes);
    notice = { ...notice, ...changes };
  }
  // 二、撤回开着的「没有进展」条目。P76r3（R2）：逾期的条目不因新记录撤回（有新进展不等于交付时间的问题解决了）。
  // 停了、空转的条目遇到新记录仍然撤回：停滞已经结束，条目一直开着会让下一次停滞被判成「在等你」。
  const newRecord = notice.stallNotifiedAt !== null && lastProgressAt > notice.stallNotifiedAt;
  if (newRecord && notice.stallKind !== 'overdue') {
    job = withdrawStallItemsForJob(ctx, job, now, '这件事有了新进展');
  }
  // P76r3（R2）：逾期的条目开着、而交付时间已经不是通知时的那个：撤回，答复栏写「交付时间已改」。
  if (notice.stallKind === 'overdue' && notice.overdueNotifiedFor !== null && job.dueAt !== notice.overdueNotifiedFor) {
    job = withdrawStallItemsForJob(ctx, job, now, '交付时间已改');
  } else if (notice.stallKind === 'overdue' && job.state === 'blocked' && job.blocked !== null
    && notice.stallNotifiedAt !== null && job.blocked.since >= notice.stallNotifiedAt) {
    // P84 复验（C2）：只有「建条目之后才转受阻」的才撤回（受阻开始的时间不早于条目建出的时间 stallNotifiedAt，不新增记号）；
    // 建条目时这件事已经受阻的，条目正文本来就写着受阻和在等谁，符合事实，留到你答复、交付时间改了或这件事交付为止。
    // P84（K2）：这件事转受阻了，逾期条目里写的「现在执行中，在等某人」已经不符合事实：撤回，答复栏写明。
    // overdueNotifiedFor 保持不变：同一个交付时间不再通知第二次。
    job = withdrawStallItemsForJob(ctx, job, now, '这件事已转为受阻，另有说明');
  } else if (notice.stallKind === 'overdue'
    && ctx.store.table('inbox').count(row => row.status === 'open' && row.subjectKey.startsWith(stallSubjectPrefix(job.id))) === 0) {
    // P84（K4）：逾期条目已经被别的路径了结（取代、撤回），记号还留着：清掉。
    clearOverdueMark(ctx, job.id);
  }
  // 三、事实。
  const actor = expectedActorOf(job);
  const queued = actor === null ? 0 : ctx.store.table('queue').count(row => row.botId === actor && row.jobId === job.id);
  const running = actor === null ? 0 : ctx.store.table('wakes').count(wake => wake.botId === actor && wake.jobId === job.id && isOpenWake(wake));
  const input: StallInput = {
    now, job, actor, lastProgressAt,
    waitingOwner: ownerAskOpenOf(ctx, job),
    quotaBlocked: actor !== null && queued > 0 && quotaBlockedFor(ctx, job, actor, now),
    actorOnDuty: actor === null || isOnDutyNow(ctx, actor),
    actorQueued: queued > 0, actorRunning: running > 0,
    overdueNotifiedFor: notice.overdueNotifiedFor,
    // 空转要读审计记录，只在前面的排除都过了才算。
    spinRun: () => (actor === null ? 0 : spinRunOf(ctx, job.id, actor, shared.events, notice.stallNotifiedAt)),
  };
  const verdict = stallOf(input);
  if (verdict.kind === null) return { ...verdict, action: 'none' };
  // 通知被挡住的两个原因（P76r3 R1：乙；前置：24 小时内通知过、之后没有新记录）。
  const noticeBlocked = hasAnyOpenJobItem(ctx, job.id) || !mayNotify(notice, lastProgressAt, now);
  // 四、处理。停摆的重新唤醒不受 24 小时通知间隔限制（R4）：最需要推一把的正是已经逾期的事。
  // P84（K3）：判出逾期、但通知被挡住时，接着按停摆的条件再看一次（把这个交付时间当作已通知过），该重新唤醒的照做；
  // 重新唤醒之后满 1 小时仍没有记录时要不要通知，仍受乙和 24 小时间隔的限制（下面的 held）。
  if (verdict.kind === 'overdue' && noticeBlocked) {
    const again = stallOf({ ...input, overdueNotifiedFor: job.dueAt });
    if (again.kind === 'idle') {
      const stepped = idleStep(ctx, job, actor!, notice.rewakeAt, again, now);
      if (stepped !== null) return stepped;
    }
    return { ...verdict, action: 'held' };
  }
  if (verdict.kind === 'idle') {
    const stepped = idleStep(ctx, job, actor!, notice.rewakeAt, verdict, now);
    if (stepped !== null) return stepped;
  }
  // 乙成立或前置不满足时什么都不做；逾期因此没通知成时不写 overdueNotifiedFor，等条目了结后再判。
  if (noticeBlocked) return { ...verdict, action: 'held' };
  return { ...verdict, action: reportStall(ctx, job, verdict.kind, now, { actorId: actor! }) ? 'notified' : 'none' };
}

/**
 * 停摆的重新唤醒一步：还没有重新唤醒过就重新唤醒一次；重新唤醒之后不满 1 小时仍在等；
 * 满 1 小时仍没有记录（有了记录时 rewakeAt 已清空）返回 null，由调用方进入通知的判断。
 */
function idleStep(ctx: HubContext, job: Job, actor: string, rewakeAt: number | null, verdict: StallVerdict, now: number): StallOutcome | null {
  if (rewakeAt === null) return { ...verdict, action: rewake(ctx, job, actor, now) ? 'rewoke' : 'none' };
  if (now - rewakeAt < D.STALL_AFTER_REWAKE_MS) return { ...verdict, action: 'waiting' };
  return null;
}

/**
 * 撤回这件事开着的「没有进展」条目，并清空条目编号（P76r3，R11）：先重读这件事，只在编号仍等于被撤回的那一条时才清空。
 * 返回重读之后的这件事（没有记录时返回原值）。
 */
function withdrawStallItemsForJob(ctx: HubContext, job: Job, now: number, why: string): Job {
  const withdrawn = withdrawStallItems(ctx, job.id, now, why);
  let cleared = false;
  for (const itemId of withdrawn) {
    const fresh = ctx.store.table('jobs').get(job.id);
    if (fresh !== null && fresh.inboxId === itemId) {
      ctx.store.table('jobs').patch(job.id, { inboxId: null, updatedAt: now });
      cleared = true;
    }
  }
  return cleared ? ctx.store.table('jobs').get(job.id) ?? job : job;
}

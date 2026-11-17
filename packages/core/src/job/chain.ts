/**
 * 执行链的统一入队（P74c，方案 7.2）：派活、改派、回答、转交、退回、续排、兜底、恢复在岗……
 * 凡是「叫某位员工去做某件事的某一步」，都只走这里的 enqueueJobWake，不再各自拼候选。
 *
 * 为什么要统一：
 * - 候选必须带 jobId、事项键 jobwake:<jobId>:<botId>，闸门才会按「执行链唤醒」处理（越过冷却、最短思考间隔、自主预算，
 *   改受每件事的回合上限约束），回复才会落回这件事的主题；各处自己拼很容易漏掉其中一项；
 * - 入队按 directed 处理（指名叫人，不看思考门槛），返回值原样交还调用方：不入队（员工此刻不在岗、感知被去重等）
 *   就不能对模型说「已……」；
 * - 来源只用现有的两种：续排和兜底用 next_think，其余用 peer_message。不新增唤醒来源，
 *   否则旧版本读不出队列（方案 7.2）。
 *
 * 本文件还放了「这件事此刻在等谁」（expectedActorOf），兜底巡检和进度行的延迟说明共用这一份口径。
 */
import type { HubContext } from '../engine/context.js';
import { buildCandidate } from '../appraisal/think.js';
import { botIsArchived } from '../model/bot.js';
import { ON_TEAM_LIFECYCLES } from '../model/enums.js';
import type { Job } from '../model/job.js';
import type { QueueEntry } from '../model/wake.js';
import { recordPeerMessage } from '../perception/sources.js';
import { enqueue } from '../scheduler/queue.js';
import { confirmWaitNo } from './confirm-wait.js';

/** 叫醒的原因（对应方案 6.5 表里「员工被叫去做这件事」的全部路径）。 */
export const JOB_WAKE_WHYS = ['assigned', 'reassigned', 'asked', 'answered', 'forwarded', 'returned', 'to_review', 'resumed', 'continue', 'idle', 'escalate', 'launch',
  // P74r16b：参与者被中心停用，叫总管来处理（换人或向主人说明）。
  'suspended',
  // P74r18b：中心代为运行的出站动作（含发布命令）有了结果，叫提交它的员工。
  'outbox_result'] as const;
export type JobWakeWhy = (typeof JOB_WAKE_WHYS)[number];

export interface JobWakeInput {
  job: Job;
  botId: string;
  why: JobWakeWhy;
  /** 对应的事件 id；没有时由中心生成「<jobId>:<why>:<序号>」，保证每次叫醒的感知互不相同。 */
  eventId: string | null;
  /** 给模型看的摘要。 */
  summary: string;
  /** 给主人看的短句；一般不用写，由 why 决定。恢复在岗等个别场景沿用原来的说法时才覆盖。 */
  ownerSummary?: string;
}

export interface JobWakeResult {
  /** 入队成功时的候选；员工此刻不在岗、感知被去重、被拦下时为 null。 */
  entry: QueueEntry | null;
  /** 把队列、员工状态、这次的感知恢复到入队前（派活等「全部成功才算数」的流程在中途失败时调用）。 */
  undo: () => void;
}

/** 员工此刻是否在岗：生命周期在岗且没有归档。 */
export function isOnDutyNow(ctx: HubContext, botId: string): boolean {
  const bot = ctx.store.table('bots').get(botId);
  return bot !== null && (ON_TEAM_LIFECYCLES as readonly string[]).includes(bot.lifecycle) && !botIsArchived(bot);
}

/**
 * 这件事的总管、执行者、核对人里此刻不在岗的名单，以及其中已归档的（P74r17）。
 * 主题进度行（api/job-topic-views.ts）和总管唤醒包里「你手上的事」一览（wake/job-section-chief.ts）共用，两处写「在等谁」的口径才一致。
 * 已归档：生命周期是 retired，或有归档时间（与员工状态投影 staffStatus 一致）。
 */
export function offDutyOfJob(ctx: HubContext, job: Pick<Job, 'chiefId' | 'executorId' | 'reviewerId'>): { offDuty: Set<string>; retired: Set<string> } {
  const ids = [job.chiefId, job.executorId, ...(job.reviewerId === null ? [] : [job.reviewerId])];
  const offDuty = new Set(ids.filter(id => !isOnDutyNow(ctx, id)));
  const retired = new Set([...offDuty].filter(id => {
    const bot = ctx.store.table('bots').get(id);
    return bot !== null && (bot.lifecycle === 'retired' || botIsArchived(bot));
  }));
  return { offDuty, retired };
}

/** 这件事的标题（沿用约定的标题）。 */
export function jobTitleOf(ctx: HubContext, job: Pick<Job, 'agreementId'>): string {
  return ctx.store.table('agreements').get(job.agreementId)?.title ?? '这件事';
}

/** 给主人看的短句（任务卡 3 节；不含工具名、机器人 id、内部编号）。 */
export function jobWakeOwnerSummary(ctx: HubContext, job: Job, why: JobWakeWhy): string {
  switch (why) {
    case 'assigned': case 'reassigned': return '总管交来一件事，等待开工';
    case 'asked': {
      const asker = job.openAsk === null ? null : ctx.store.table('bots').get(job.openAsk.fromId)?.name ?? null;
      return `${asker ?? '执行者'}问了一个问题，等待回答`;
    }
    case 'answered': return '总管回答了问题，等待继续';
    case 'forwarded': return '总管转来材料，等待继续';
    case 'returned': return '核对退回，等待返工';
    case 'to_review': return '等待核对';
    case 'resumed': return '约定已确认，等待继续';
    case 'continue': case 'idle': return `继续做「${jobTitleOf(ctx, job)}」`;
    case 'escalate': return '等待写说明';
    case 'launch': return '准备发布';
    case 'outbox_result': return '中心运行了你提交的动作，有了结果';
    case 'suspended': {
      // P74r16c 第 3 节：写「{名字}已被中心停用」。正常路径由 job/suspended.ts 显式传入；这里兜底取这件事里不在岗的那一位。
      const off = [job.executorId, job.reviewerId].find((id): id is string => id !== null && !isOnDutyNow(ctx, id)) ?? null;
      return `${off === null ? '员工' : ctx.store.table('bots').get(off)?.name ?? '员工'}已被中心停用`;
    }
  }
}

/** 没有指定事件 id 时生成唯一的感知标识：同一员工、同一件事、同一原因，序号依次加一，避开去重窗口。 */
function generatedEventId(ctx: HubContext, job: Job, botId: string, why: JobWakeWhy): string {
  const prefix = `${job.id}:${why}:`;
  let seq = 1;
  while (ctx.store.table('percepts').count(row => row.botId === botId && row.location === `${prefix}${seq}`) > 0) seq += 1;
  return `${prefix}${seq}`;
}

/**
 * 排一次执行链唤醒，并返回「撤销」闭包。入队会改动三样东西：队列候选（可能与已有候选合并）、
 * 员工的活动状态（改成「排队中」）、这次新写的一条感知；撤销时原样放回，「队列不变」才成立。
 * 员工此刻不在岗时不入队（entry 为 null），由调用方当作失败处理。
 */
export function enqueueJobWakeUndoable(ctx: HubContext, input: JobWakeInput): JobWakeResult {
  const { job, botId, why } = input;
  const queueBefore = ctx.store.table('queue').list(row => row.botId === botId);
  const botBefore = ctx.store.table('bots').get(botId);
  const undo = (percept: string | null) => (): void => {
    for (const entry of ctx.store.table('queue').list(row => row.botId === botId)) ctx.store.table('queue').remove(entry.id);
    for (const entry of queueBefore) ctx.store.table('queue').put(entry);
    if (botBefore) ctx.store.table('bots').put(botBefore);
    if (percept !== null) ctx.store.table('percepts').remove(percept);
  };
  if (!isOnDutyNow(ctx, botId)) return { entry: null, undo: undo(null) };
  const now = ctx.clock.now();
  const percept = recordPeerMessage(ctx, { botId, id: input.eventId ?? generatedEventId(ctx, job, botId, why), summary: input.summary, at: now });
  if (percept === null) return { entry: null, undo: undo(null) };
  const kind = why === 'continue' || why === 'idle' ? 'next_think' : 'peer_message';
  const candidate = buildCandidate(ctx, {
    botId, kind, evidence: [percept.id], summary: percept.summary, jobId: job.id,
    // 续排和兜底是中心自己的安排，分值取「下次思考」的固定分；其余沿用感知的显著性。
    score: kind === 'next_think' ? ctx.settings.c02.nextThinkScore : percept.salience,
    ...(kind === 'peer_message' ? { source: percept.source, perceptKind: percept.kind } : {}),
    subjectKey: `jobwake:${job.id}:${botId}`,
    ownerSummary: input.ownerSummary ?? jobWakeOwnerSummary(ctx, job, why),
  });
  // directed：指名叫人，不看思考门槛（门槛高于交接类感知的显著性上限，不放行就会被悄悄丢掉）。
  const entry = enqueue(ctx, candidate, { directed: true });
  // 这条感知的候选已经由这里建好；标记「已评估」，中心每次处理完命令后做的「感知评估」就不会再按它另建一条普通候选
  // （另建的那条没有 jobId，会和这条并排排队，同一次叫醒变成两个回合）。
  ctx.store.table('percepts').patch(percept.id, { evaluatedAt: now, ...(entry === null ? { discardedAt: now } : {}) });
  return { entry, undo: undo(percept.id) };
}

/** 统一入队：返回入队的候选；没有入队返回 null，调用方据此决定工具怎么回话。 */
export function enqueueJobWake(ctx: HubContext, input: JobWakeInput): QueueEntry | null {
  return enqueueJobWakeUndoable(ctx, input).entry;
}

/**
 * 这件事此刻在等谁（没有人在等时为 null）。兜底巡检和进度行共用：
 * - 有未回答的提问：总管；
 * - 待开工、执行中、返工中：执行者；核对中：核对人（没有核对人时是总管）；
 * - 受阻：执行者做不下去、核对三轮不过且还没向主人说明：总管；其余受阻（回合上限、先停下、参与者停用）在等主人或员工恢复，不排人。
 */
export function expectedActorOf(job: Job): string | null {
  // P74r2b：这件事此刻在等主人确认约定的新版本（提问已转成新版本，或执行者已做完照常的部分）：没有人要叫，
  // 兜底巡检不叫任何人，也就不会因为「叫了两次没有进展」转受阻、出「停住了」。
  // 提问已转成新版本的，不论状态都不叫；执行者在等确认的，只管执行者的三种状态（别人有提问时仍是总管）。
  if (confirmWaitNo(job) !== null) return null;
  if (job.openAsk !== null && (job.state === 'ready' || job.state === 'doing' || job.state === 'rework' || job.state === 'checking')) return job.chiefId;
  switch (job.state) {
    case 'ready': case 'doing': case 'rework': return job.executorId;
    case 'checking': return job.reviewerId ?? job.chiefId;
    case 'blocked':
      // P74r4a：约定有新版本在等主人确认（pause 有值）时，总管既不能说明也没有别的可做，不叫；确认或撤销之后由中心叫（escalation-expiry.ts）。
      return job.blocked !== null && (job.blocked.kind === 'executor' || job.blocked.kind === 'review_limit') && job.inboxId === null && job.pause === null ? job.chiefId : null;
    default: return null;
  }
}

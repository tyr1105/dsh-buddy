/**
 * 「没有进展」条目与「还在等你」提醒里给主人看的句子（P76g，方案 7.6、7.7，派活说明第一节的书面写法）。
 *
 * 为什么单独一个文件：条目的建立（stall.ts）、24 小时提醒（wait-remind.ts）都要写「已用 x / y 回合」「交付时间」「{HH:mm}」，
 * 句子集中在这里，改字只改一处，测试也按这里的函数逐句对。
 * 给主人看的文字不含内部编号、工具名、英文步骤名；时刻按设置里的时区写，不在同一天的写「{M}月{D}日 {HH:mm}」。
 * 只读存储，不写任何东西。
 */
import { dueTextOf, jobProgressView, waitingOnOf } from '../api/job-views.js';
import type { HubContext } from '../engine/context.js';
import { JOB_STATE_LABELS, type Job } from '../model/job.js';
import type { StallKind } from '../model/budget.js';
import { localParts } from '../util/time.js';
import { offDutyOfJob } from './chain.js';
import { latestEstimate } from './estimate.js';
import { usageRowOf, usageTotals } from './usage.js';

const pad = (value: number): string => String(value).padStart(2, '0');

/** 员工 id 对应名字（找不到的由调用方给默认写法）。 */
export function botNamesOf(ctx: HubContext): Record<string, string> {
  return Object.fromEntries(ctx.store.table('bots').list().map(bot => [bot.id, bot.name]));
}

/** 时刻：与 now 在同一天写「HH:mm」，不在同一天写「{M}月{D}日 {HH:mm}」。 */
export function clockText(ctx: HubContext, at: number, now: number): string {
  const tz = ctx.settings.timezone;
  const p = localParts(at, tz);
  const today = localParts(now, tz);
  const time = `${pad(p.hour)}:${pad(p.minute)}`;
  return p.year === today.year && p.month === today.month && p.day === today.day ? time : `${p.month}月${p.day}日 ${time}`;
}

/** 这件事现在停在哪一步（进度行当前步的标签：对齐、执行、核对、你验收、发布）。 */
export function stepLabelOf(ctx: HubContext, job: Job, now: number): string {
  const view = jobProgressView({ agreementState: 'locked', agreementVersionNo: 1, job, names: botNamesOf(ctx), delayNote: null, now, timezone: ctx.settings.timezone });
  return view?.steps.find(step => step.state === 'current' || step.state === 'stuck')?.label ?? '执行';
}

/** 预期的人的名字；总管写「总管」。 */
export function actorNameOf(ctx: HubContext, job: Job, actorId: string): string {
  return actorId === job.chiefId ? '总管' : ctx.store.table('bots').get(actorId)?.name ?? '负责的人';
}

/**
 * 消耗行：有预计「已用 {used} / {total} 回合，交付时间 {dueText}。」；没有预计「已用 {used} 回合，交付时间 {dueText}。」。
 * used、total 含对齐，取分步记账与预计里的数（与进度行同一口径）。
 * withDue 为假（逾期时）或这件事没有交付时间时，去掉「，交付时间 …」。
 */
export function costLineText(ctx: HubContext, job: Job, now: number, withDue: boolean): string {
  const usage = ctx.store.table('jobUsage').get(job.id) ?? usageRowOf(ctx, job, now);
  const used = usageTotals(usage).turns;
  const estimate = latestEstimate(ctx, job.agreementId);
  const head = estimate === null ? `已用 ${used} 回合` : `已用 ${used} / ${estimate.total} 回合`;
  return `${head}${withDue && job.dueAt !== null ? `，交付时间 ${dueTextOf(job.dueAt, ctx.settings.timezone)}` : ''}。`;
}

/** 条目正文要用的事实。 */
export interface StallBodyInput {
  kind: StallKind;
  /** 预期的人（没有人在等时取总管）。 */
  actorId: string;
  /** 最近一次记录的时间。 */
  lastProgressAt: number;
  /** 重新唤醒的时间（只有停摆用）。 */
  rewakeAt: number | null;
  /** 连续几个回合没有新文件或新证据（只有空转用）。 */
  spinRun: number;
}

/** 条目正文，逐行（调用方用换行连接）。 */
export function stallBodyLines(ctx: HubContext, job: Job, input: StallBodyInput, now: number): string[] {
  const name = actorNameOf(ctx, job, input.actorId);
  const step = stepLabelOf(ctx, job, now);
  if (input.kind === 'idle') {
    const waited = waitedText(now - input.lastProgressAt);
    const since = clockText(ctx, input.lastProgressAt, now);
    const woke = clockText(ctx, input.rewakeAt ?? now, now);
    return [
      // P76r3（R10 第 4 点）：时长后面直接接「没有进展」，与「在办的事」里的写法一致（原来多一个空格）。
      `已 ${waited}没有进展，停在${step}这一步，在等${name}。`,
      `${since} 起没有任何记录；${woke} 已重新唤醒过${name}一次，仍没有记录。`,
      costLineText(ctx, job, now, true),
    ];
  }
  if (input.kind === 'spin') {
    return [`${name}在${step}这一步连续 ${input.spinRun} 个回合没有新文件或新证据。`, costLineText(ctx, job, now, true)];
  }
  // 逾期：写明过了交付时间、现在的状态和在等谁；消耗行不再写交付时间。
  const names = botNamesOf(ctx);
  const { offDuty, retired } = offDutyOfJob(ctx, job);
  const waiting = waitingOnOf(job, names, offDuty, retired);
  const due = dueTextOf(job.dueAt, ctx.settings.timezone);
  return [`已过交付时间（${due}），现在${JOB_STATE_LABELS[job.state]}${waiting === null ? '' : `，在等${waiting}`}。`, costLineText(ctx, job, now, false)];
}

/** 把一段时间说成给人看的话：不足 1 小时写分钟，不足 2 天写小时，其余写天。 */
export function waitedText(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} 小时` : `${Math.round(hours / 24)} 天`;
}

/** 总管私聊的末行（派活说明第一节，逐字）。 */
export function stallChatClosing(title: string): string {
  return `之后 24 小时内，不会再因为${title}没有进展通知你；有新进展之后重新计时。`;
}

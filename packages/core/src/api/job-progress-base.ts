/**
 * 进度行的公共输入整理（P76i 从 job-topic-views.ts 拆出）。
 *
 * 为什么拆出来：主题的进度行（job-topic-views.ts）和「在办的事」每一行（active-jobs-views.ts）都要用同一个
 * jobProgressView 取「状态词、在等谁、第几轮、交付时间」，口径必须是同一份，不能各写一套。
 * 如果「在办的事」直接引用 job-topic-views.ts，而总管左栏一句（chiefJobLineFor，也在 job-topic-views.ts）又要引用
 * 「在办的事」，两个文件会互相引用；所以把共用的输入整理放在这个没有反向依赖的文件里。
 * 本文件只读存储，不写任何东西。
 */
import type { HubContext } from '../engine/context.js';
import type { Agreement } from '../model/agreement.js';
import type { Job } from '../model/job.js';
import { offDutyOfJob } from '../job/chain.js';
import { launchWaitOf } from '../job/launch-result.js';
import { jobProgressView } from './job-views.js';
import type { JobProgressView } from './types.js';

/** id → 名字；主人固定写「你」。已删除的员工查不到，由纯函数写「已删除的员工」。 */
export function nameTable(ctx: HubContext): Record<string, string> {
  const names: Record<string, string> = { owner: '你' };
  for (const bot of ctx.store.table('bots').list()) names[bot.id] = bot.name;
  return names;
}

/** 约定当前版本号：已固定取固定版，否则取最新版。 */
export function currentVersionNo(agreement: Agreement): number {
  const locked = agreement.state === 'locked' ? agreement.versions.find(version => version.state === 'locked') : undefined;
  return (locked ?? agreement.versions[agreement.versions.length - 1]!).no;
}

/**
 * 一件事（或还没有这件事的约定）的进度行基础视图。
 * agreement 为 null（约定记录已不存在）时按「已固定、第 1 版」处理，保证旧数据也能算出状态词与在等谁。
 * delayNote 由调用方给：主题的进度行传 jobDelayNote 的结果；「在办的事」不用它，传 null（省掉一次闸门重放）。
 * 约定已撤下且没有这件事时返回 null。
 */
export function progressBaseOf(ctx: HubContext, agreement: Agreement | null, job: Job | null, delayNote: string | null): JobProgressView | null {
  // P74r16b：参与者和总管此刻谁不在岗（停用、暂停、退役）：「在等谁」据此写「{名字}（已停用）」或「你」。
  // P74r17（低-5）：其中已归档的另列一份，「在等谁」据此写「（已归档）」而不是「（已停用）」。
  const { offDuty, retired } = job === null ? { offDuty: new Set<string>(), retired: new Set<string>() } : offDutyOfJob(ctx, job);
  return jobProgressView({
    agreementState: agreement?.state ?? 'locked', agreementVersionNo: agreement === null ? 1 : currentVersionNo(agreement),
    job, names: nameTable(ctx), delayNote,
    now: ctx.clock.now(), timezone: ctx.settings.timezone, offDuty, retired,
    ...(job === null ? {} : { launchWait: launchWaitOf(ctx, job) }),
  });
}

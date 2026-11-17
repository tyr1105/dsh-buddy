/**
 * 员工在一件事里被中心自动停用之后的衔接（P74r16b 第 1 节）。
 *
 * 为什么需要：原来员工被停用时，这件事只是转成「受阻」，总管只收到一条没有这件事编号的普通团队信号，
 * 会被「最短思考间隔」拦住，总管节奏慢时要等一小时；主人面前只有一条只有「知道了」的告警。结果是事情停着，没有人在做。
 * 本文件管三件事：
 * 1. 停用当时：对每件这样的事，给这件事的总管排一条执行链唤醒（带这件事的编号，越过最短思考间隔）；
 * 2. 恢复在岗时：把队列里因他被停用而给总管排的、还没有放行的候选移出（已经放行、正在跑的不处理）；
 * 3. 给主人看的告警条目的标题与正文（正文里写明每件事停在哪一步、已告诉总管）。
 * 主人手动停用不走这里（那是主人自己做的决定，不用叫醒总管）。
 */
import type { HubContext } from '../engine/context.js';
import type { Bot } from '../model/bot.js';
import type { Job } from '../model/job.js';
import { writeOutreachAudit } from '../outreach/audit.js';
import { removeEntry } from '../scheduler/queue.js';
import { TEAM_SIGNAL_SUBJECT_PREFIX } from '../scheduler/on-demand.js';
import { newId } from '../util/ids.js';
import { closeSentence } from '../util/sentence.js';
import { enqueueJobWake, isOnDutyNow, jobTitleOf } from './chain.js';
import { stuckStepName } from './participants.js';

/** 告警条目正文里最多逐件列出几件事。 */
export const SUSPEND_ALERT_JOBS_MAX = 3;

/**
 * 事实一行（给模型看，逐字固定）：唤醒摘要和唤醒包里这件事的那一段共用。
 * P74r16c：原因另起一小句、不再套括号（越界停用的原因本身带括号，原来的写法会套两层）。
 */
export function suspendedFactLine(name: string, reason: string, step: string): string {
  return `${name}已被中心停用，原因：${reason}。这件事停在${step}。`;
}

/** 给总管排的执行链唤醒的摘要（给模型看，逐字固定）：「{标题}」：加上事实一行。 */
export function suspendedWakeSummary(title: string, name: string, reason: string, step: string): string {
  return `「${title}」：${suspendedFactLine(name, reason, step)}`;
}

/** 给主人看的叫醒原因（逐字固定，P74r16c 第 3 节）。 */
export function suspendedOwnerSummary(name: string): string {
  return `${name}已被中心停用`;
}

/** 告警条目的标题（给主人看，逐字固定）。 */
export function suspendedAlertTitle(name: string): string {
  return `${name}已被停用`;
}

/**
 * 告警条目正文里每件事的一句（逐字固定）。
 * P74r17：按这件事的总管此刻是否在岗分两句。不在岗时中心没有给总管排唤醒（见 wakeChiefsOfSuspended），不能写「已告诉总管」，
 * 否则与进度行「在等：你」互相矛盾；改写成需要主人处理。
 */
function suspendedJobLine(title: string, step: string, chiefOnDuty: boolean): string {
  return chiefOnDuty ? `「${title}」已停在${step}，已告诉总管。` : `「${title}」已停在${step}，总管此刻不在岗，需要你处理。`;
}

/** 告警条目的正文：先写停用和原因；他参与着没做完的事时，每件事再接一句，超过 3 件的合并成一句。 */
export function suspendedAlertText(ctx: HubContext, bot: Pick<Bot, 'name'>, reason: string, jobs: readonly Job[]): string {
  const head = closeSentence(`中心停用了${bot.name}：${reason}`);
  const lines = jobs.slice(0, SUSPEND_ALERT_JOBS_MAX).map(job => suspendedJobLine(jobTitleOf(ctx, job), stuckStepName(ctx, job),
    // 与给总管排唤醒时决定排不排的判断是同一个函数（enqueueJobWakeUndoable 里的 isOnDutyNow）。
    isOnDutyNow(ctx, job.chiefId)));
  const more = jobs.length > SUSPEND_ALERT_JOBS_MAX ? [`另有 ${jobs.length - SUSPEND_ALERT_JOBS_MAX} 件事也已停住。`] : [];
  return [head, ...lines, ...more].join('');
}

/**
 * 团队信号的去重键（peer/team.ts 的 checkTeamSignals 用同一个算法）：
 * 这次停用已经给总管排过执行链唤醒的，就把对应的普通团队信号记为已处理，不再另排一条。
 */
function teamSignalKey(ctx: HubContext, chiefId: string, botId: string): string {
  const now = ctx.clock.now();
  const event = ctx.store.log('audit').recent(1, row => row.action === 'quarantine_event' && row.detail === botId && row.at <= now)[0];
  const bot = ctx.store.table('bots').get(botId);
  return `${chiefId}:quarantined:${botId}:${event?.id ?? bot?.updatedAt}`;
}

/**
 * 员工被中心停用、他参与的事刚转受阻之后：对每件事给这件事的总管排一条执行链唤醒。
 * 返回实际排上的条数。总管此刻不在岗、感知被去重等没有排上的，只记日志，普通团队信号照旧作为兜底。
 */
export function wakeChiefsOfSuspended(ctx: HubContext, bot: Bot, reason: string, jobs: readonly Job[]): number {
  let queued = 0;
  for (const job of jobs) {
    try {
      const entry = enqueueJobWake(ctx, { job, botId: job.chiefId, why: 'suspended', eventId: null,
        summary: suspendedWakeSummary(jobTitleOf(ctx, job), bot.name, reason, stuckStepName(ctx, job)),
        ownerSummary: suspendedOwnerSummary(bot.name) });
      if (entry === null) { ctx.logger.warn('员工停用后没有给总管排上唤醒', { jobId: job.id, chiefId: job.chiefId }); continue; }
      queued += 1;
      // 这位总管已经因这次停用被叫醒，普通团队信号不再另排（checkTeamSignals 按这条审计去重）。
      const key = teamSignalKey(ctx, job.chiefId, bot.id);
      if (!ctx.store.log('audit').all().some(row => row.action === 'chief_signal' && row.detail === key)) {
        ctx.store.log('audit').append({ id: newId('au', ctx.rng), at: ctx.clock.now(), actor: job.chiefId, action: 'chief_signal', detail: key });
      }
    } catch (error) {
      ctx.logger.warn('员工停用后给总管排唤醒失败', { jobId: job.id, error: String(error) });
    }
  }
  return queued;
}

/** 这条队列候选是不是「这位员工被停用时给这件事的总管排的执行链唤醒」：证据里的感知都是这件事、写着这位员工被停用的那条。 */
function isSuspendWake(ctx: HubContext, jobId: string, botName: string, evidence: readonly string[]): boolean {
  if (evidence.length === 0) return false;
  return evidence.every(id => {
    const percept = ctx.store.table('percepts').get(id);
    return percept !== null && percept.location !== null && percept.location.startsWith(`${jobId}:suspended:`) && percept.summary.includes(`${botName}已被中心停用，原因：`);
  });
}

/**
 * P74r17（疑点一）：这个回合是不是「因这件事的某位参与者被中心停用而叫醒总管」的回合；是的话返回那位参与者（执行者或核对人）。
 * 从唤醒的证据认出来：证据里的感知全是这件事的停用感知（位置以「{jobId}:suspended:」开头），并且摘要写着这位参与者的名字。
 * 不是这种回合（主人发话、别的原因叫醒）返回 null。
 */
export function suspendedParticipantOfWake(ctx: HubContext, wake: { reason: { evidence: readonly string[] } }, job: Pick<Job, 'id' | 'executorId' | 'reviewerId'>): Bot | null {
  const evidence = wake.reason.evidence;
  if (evidence.length === 0) return null;
  for (const id of [job.executorId, job.reviewerId]) {
    const bot = id === null ? null : ctx.store.table('bots').get(id);
    if (bot !== null && isSuspendWake(ctx, job.id, bot.name, evidence)) return bot;
  }
  return null;
}

/**
 * 员工恢复在岗时：队列里因他被停用而给总管排的、还没有放行的候选移出，记审计。
 * 两类：这位员工参与的事的停用唤醒（执行链候选），以及关于他的普通团队信号。已经放行、正在跑的回合不处理。
 * 返回移出的条数。
 */
export function removeStaleSuspendWakes(ctx: HubContext, bot: Pick<Bot, 'id' | 'name'>): number {
  const signalPrefix = `${TEAM_SIGNAL_SUBJECT_PREFIX}quarantined:${bot.id}:`;
  let removed = 0;
  for (const entry of ctx.store.table('queue').list()) {
    const stale = (entry.jobId != null && isSuspendWake(ctx, entry.jobId, bot.name, entry.reason.evidence)
      && ctx.store.table('jobs').get(entry.jobId)?.chiefId === entry.botId)
      || entry.subjectKey.startsWith(signalPrefix);
    if (!stale) continue;
    removeEntry(ctx, entry.id);
    removed += 1;
    writeOutreachAudit(ctx, 'suspend_wake_removed', { botId: entry.botId, reinstatedBotId: bot.id, jobId: entry.jobId ?? null, entryId: entry.id }, 'hub');
  }
  return removed;
}

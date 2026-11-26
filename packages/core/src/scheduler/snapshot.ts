/** 调度快照一次收齐可观察状态；纯闸门只读快照，便于逐条重放为何被拦。 */
import type { HubContext } from '../engine/context.js';
import type { Bot, QuotaState, WakeTicket } from '../model/index.js';
import type { Job } from '../model/job.js';
import { inLaunchPhase, launchLinkOpen, launchTurnsLeft } from '../job/launch-turns.js';
import { ownerAskOpenOf } from '../job/owner-ask.js';
import { getQuotaState } from '../quota/window.js';
import { getQuotaPlan } from '../quota/plan.js';
import { selfWorkUsageToday } from '../quota/usage.js';
import { parseSkillKey, skillRunOfKey } from '../skill/keys.js';
import { busyWithJob } from '../skill/tidy-sources.js';
import { startOfLocalDay } from '../util/time.js';
import { laneOf, usesLanes } from './lanes.js';
/**
 * P74c：候选属于哪件事时，闸门需要知道的这件事的事实（只读快照）。
 * participants 是执行者、核对人（如有）和总管；turnsLeft 是还剩几个执行链回合；
 * ownerAskOpen 表示「待你处理」里这件事自己有没有一条还开着的条目（subjectKey 以 job:<jobId>: 开头）。
 */
export interface JobGateInfo {
  state: Job['state']; launchState: Job['launch']['state']; chiefId: string;
  participants: string[]; turnsLeft: number; ownerAskOpen: boolean;
  /**
   * P74e（B2）：这件事的约定正在等主人确认（执行中重新确认）；reviewerId 是有名有姓的核对人（总管自己核对时为 null）。
   * 两项都可以省略（旧的手写快照不带）：省略等于「没有在等确认」。
   */
  reopenPending?: boolean; reviewerId?: string | null;
  /** P74r18b：发布命令已成功运行、等执行者补记网址（或直接交账）的那一次叫醒要放行。可以省略（旧的手写快照不带）：省略等于否。 */
  launchLinkOpen?: boolean;
}
export interface GateSnapshot {
  bot: Bot | null; running: boolean; runningCount: number; ownerActiveAt: number | null;
  lastDispatchAt: number | null; startedAt: number; quota: QuotaState;
  /** P76c：这位员工本地当天自己发起的回合数（selfWorkUsageToday）；取代原来的 todayTurns、todayTokens、windowTurns 三项。 */
  selfTurnsToday: number;
  openQuestionSubjects: Set<string>; openOwnerAskCount: number; openOwnerAskUntil: number | null;
  subjectWakeAt: Map<string, number>; retryAt: number | null; authBlocked: boolean;
  ownerEvidenceIds?: Set<string>;
  /** 候选带 jobId 时这件事的事实；候选不带 jobId、或找不到这件事时为 null。旧的手写快照可以不带这一项。 */
  job?: JobGateInfo | null;
  /**
   * P75g：技能类候选（事项键 retro:/skillcheck:/tidy:）所属 skillRuns 行的事实。
   * 调用方在 buildSnapshot 的第五个参数给事项键时才有值；旧的手写快照可以不带这一项。
   */
  skillRun?: SkillRunGateInfo | null;
  /** P75g：全队今天（本地日）技能类回合数（含 learn: 的教学回合）。 */
  teamSkillTurnsToday?: number;
  /**
   * P76d：红灯的种类。staff_full 是员工份额用完（只拦员工发起的回合），exhausted 是真实额度用完（全停，等探针）；灯不是红色时为 null。
   * 旧的手写快照可以不带这一项：灯是红色而没有这一项，按真实额度用完处理（与升级前一致，全拦）。
   */
  redKind?: 'staff_full' | 'exhausted' | null;
  /** P76d：「我接下来 N 小时要用」到什么时候；没有为 null。可以省略（等于没有）。 */
  ownerHoldUntil?: number | null;
  /** P76d：「用我的额度」放行的事（本窗口有效）。可以省略（等于没有）。 */
  borrowJobIds?: string[];
  /**
   * W1b：候选所在的线（总管按项目分线，见 scheduler/lanes.ts）；不分线的员工是主线。可以省略（旧的手写快照不带）。
   * 分线时 running、subjectWakeAt、selfTurnsToday、等你回答几项都只看同一条线。
   */
  lane?: string;
  /** W1b：分线时这条线最近一次思考的时刻（最短间隔按它算）；不分线的员工不带，闸门照旧用 bot.lastThinkAt。 */
  laneLastThinkAt?: number | null;
}

/**
 * P75g：一次复盘、核对或整理给闸门看的事实：还剩几个回合、每位参与者的状态、这件事的发布状态（派活说明第二节第 5 条）。
 */
export interface SkillRunGateInfo {
  id: string;
  kind: 'retro' | 'learn' | 'tidy';
  jobId: string | null;
  turnsLeft: number;
  /** 参与者状态：botId → state。 */
  participants: Record<string, 'queued' | 'running' | 'done' | 'skipped' | 'expired' | 'capped'>;
  /** 这件事现在是否在发布环节（已完成且发布准备或发布审批中）：复盘等它结束再放行（派活说明第二节第 5 条）。 */
  launchBusy: boolean;
  /**
   * P75i：每周整理专用——这位员工此刻是不是某件执行中、核对中、返工中的事的执行者或核对人（任务卡 5.2）：
   * 整理候选遇到这种情形拦下（不丢弃），原因 concurrency，恢复时刻 now + TIDY_RETRY_MS。非整理记录恒为假。
   * 可省略：旧的手写快照不带，省略等于假。
   */
  tidyBusy?: boolean;
}

/** 技能类回合给闸门看的事实；subjectKey 不是技能类键、或找不到记录时为 null。学习（learn:）的记录也在这里带出。 */
function skillRunGateInfo(ctx: HubContext, subjectKey: string | null | undefined, botId: string): SkillRunGateInfo | null {
  const parsed = parseSkillKey(subjectKey);
  if (parsed === null) return null;
  // 每周整理的键里放的是周一日期，不是记录编号：按（周一日期、员工）找记录。
  const run = skillRunOfKey(ctx, subjectKey);
  if (run === null) return null;
  const job = run.jobId === null ? null : ctx.store.table('jobs').get(run.jobId);
  return {
    id: run.id, kind: run.kind, jobId: run.jobId, turnsLeft: run.turnCap - run.turnsUsed,
    participants: Object.fromEntries(run.participants.map(row => [row.botId, row.state])),
    // 发布准备的回合只有执行者在做（P74g），所以只有执行者自己的复盘要等；评审员、总管不受这件事的发布影响。
    launchBusy: job !== null && botId === job.executorId && inLaunchPhase(job),
    tidyBusy: parsed.kind === 'tidy' && busyWithJob(ctx, botId),
  };
}

/** 全队今天（本地日）技能类回合数：今天开始的唤醒里事项键是技能类的，加上教学回合（learn:）。 */
function teamSkillTurnsToday(ctx: HubContext, now: number): number {
  const from = startOfLocalDay(now, ctx.settings.timezone);
  return ctx.store.table('wakes').list(wake => wake.startedAt >= from)
    // 学习（learn:）的键现在由 parseSkillKey 认得；旧写法（变体 teach、键 learn: 开头）仍然算，保持原有口径不变。
    .filter(wake => {
      const key = wake.subjectKey ?? null;
      return parseSkillKey(key) !== null || (wake.variant === 'teach' && typeof key === 'string' && key.startsWith('learn:'));
    }).length;
}

/** 这件事给闸门看的事实；jobId 为空或这件事不存在时为 null。 */
function jobGateInfo(ctx: HubContext, jobId: string | undefined): JobGateInfo | null {
  if (!jobId) return null;
  const job = ctx.store.table('jobs').get(jobId);
  if (!job) return null;
  return { state: job.state, launchState: job.launch.state, chiefId: job.chiefId,
    participants: [...new Set([job.executorId, ...(job.reviewerId === null ? [] : [job.reviewerId]), job.chiefId])],
    // P74g 复核后：已验收、在发布环节的事不受这件事的回合上限约束，改受发布这一步自己的上限（job/launch-turns.ts）。
    turnsLeft: inLaunchPhase(job) || launchLinkOpen(job) ? launchTurnsLeft(ctx, job) : job.turnCap - job.turnsUsed,
    launchLinkOpen: launchLinkOpen(job),
    // P76f：「将超出预计」的提问开着时这件事不停（预计之内的部分照常在做；做不下去、核对三轮不过时总管也照常被叫），
    // 所以只有这件事因预算线受阻时，预计消耗条目（job:<id>:cap:）才算作「在等你」。
    // P76g：「没有进展」条目对进行中的事（待开工、执行中、核对中、返工中）只是通知：逾期时这件事还在做，不能因为通知了你就让它停下；
    // 只有这件事已经受阻（在等总管）时才算「在等你」，与原来一致。
    // P76r3（R1）：这段口径挪到 job/owner-ask.ts 一处，停滞判断与这里共用同一份。
    ownerAskOpen: ownerAskOpenOf(ctx, job),
    reopenPending: ctx.store.table('agreements').get(job.agreementId)?.state === 'pending', reviewerId: job.reviewerId };
}

/** W1b：这条线最近一次思考的时刻：这条线上真正投递过的回合里最晚的结束时刻（还没结束的按开始时刻）；没有为 null。 */
function laneLastThinkAt(wakes: readonly WakeTicket[], botId: string, inLane: (wake: WakeTicket) => boolean): number | null {
  let latest: number | null = null;
  for (const wake of wakes) {
    if (wake.botId !== botId || wake.dispatchedAt == null || !inLane(wake)) continue;
    const at = wake.endedAt ?? wake.startedAt;
    if (latest === null || at > latest) latest = at;
  }
  return latest;
}

/** 老版本没有事项键的唤醒单，从证据恢复已知键；无法还原时只使用稳定来源键。 */
function subjectsForWake(ctx: HubContext, wake: WakeTicket): string[] {
  const keys = new Set<string>();
  if (wake.subjectKey) keys.add(wake.subjectKey);
  for (const id of wake.reason.evidence) {
    const percept = ctx.store.table('percepts').get(id);
    if (percept) keys.add(percept.watchId ? `watch:${percept.watchId}` : `src:${percept.source}:${percept.kind}`);
    const agenda = ctx.store.table('agenda').get(id);
    if (agenda && wake.reason.kind === 'agenda_due') keys.add(`agenda:${id}`);
    const inbox = ctx.store.table('inbox').get(id);
    if (inbox) keys.add(inbox.subjectKey);
  }
  if (!keys.size) keys.add(`src:system:${wake.reason.kind}`);
  return [...keys];
}
/** 汇总运行、预算和事项冷却事实，给闸门提供同一时刻的判断依据。subjectKey 供技能类候选带出所属记录（P75g）。 */
export function buildSnapshot(ctx: HubContext, botId: string, now: number, jobId?: string | null, subjectKey?: string | null, topicId?: string | null): GateSnapshot {
  const wakes = ctx.store.table('wakes').list();
  const bot = ctx.store.table('bots').get(botId);
  // W1b：总管按（总管、项目）分线；其他员工只有主线，下面的 inLane 对他们恒为真，结果与原来一字不差。
  const lanes = usesLanes(bot);
  const lane = laneOf(ctx, bot, { topicId: topicId ?? null, jobId: jobId ?? null });
  const inLane = (fields: { topicId?: string | null; jobId?: string | null }): boolean => !lanes || laneOf(ctx, bot, fields) === lane;
  // delivering 同样占位，避免异步投递尚未落 running 时重复选择。
  const running = wakes.filter(w => w.status === 'running' || w.status === 'delivering' || (w.status === 'committed' && w.endedAt === null));
  const subjectWakeAt = new Map<string, number>();
  for (const wake of wakes.filter(w => w.botId === botId && w.startedAt <= now && w.status !== 'delivering' && inLane(w))) {
    // 无会话的 error 是投递失败，没有真正唤醒，不施加六小时冷却。
    if (wake.dispatchedAt === null || (wake.dispatchedAt === undefined && wake.status === 'error' && wake.sessionId === null)) continue;
    for (const key of subjectsForWake(ctx, wake)) subjectWakeAt.set(key, Math.max(subjectWakeAt.get(key) ?? -Infinity, wake.startedAt));
  }
  const selfTurnsToday = selfWorkUsageToday(ctx, botId, now, undefined, lanes ? inLane : undefined).turns;
  // P76d：额度的三项事实（红灯种类、你自己要用的截止时刻、「用我的额度」放行的事）都读额度记录。
  const quota = getQuotaState(ctx, now);
  const plan = getQuotaPlan(ctx, now);
  // P76r2（R5）：红灯的种类按额度记录判断，不再按当前设置重算反推：记录里有真实额度用完的标记（exhausted），或探针在途，才是真实额度用完；
  // 否则是员工份额用完。以前「重算不是员工份额用完就当成真实额度用完」，主人改了份额比例之后，员工份额的红灯会被误当成真实额度用完。
  const redKind = quota.light !== 'red' ? null
    : plan.exhausted !== null || quota.probeAllowed || quota.probeInFlight === true ? 'exhausted' : 'staff_full';
  // F07：提问和审批是「有人在等你回复」；提议与告警只是告知，不冻结自唤醒。
  // 已过期但还没来得及关掉的卡片不参与判断，避免把一分钟的时间缝算成还在等。
  const ownerAsks = ctx.store.table('inbox').list(i => i.botId === botId && i.status === 'open'
    && (i.type === 'question' || i.type === 'approval') && (i.expiresAt === null || i.expiresAt > now) && inLane({ topicId: i.topicId ?? null }));
  // 最短间隔：这条线没想过就不挡；想过时取它与 bot.lastThinkAt 的较早者——上一次思考就在这条线上时两者一致，结果与原来相同。
  const laneThink = lanes && bot?.lastThinkAt != null ? laneLastThinkAt(wakes, botId, inLane) : null;
  const laneFacts = lanes ? { lane, laneLastThinkAt: laneThink === null || bot?.lastThinkAt == null ? null : Math.min(bot.lastThinkAt, laneThink) } : {};
  return { bot, running: running.some(w => w.botId === botId && inLane(w)), runningCount: running.length, ...laneFacts,
    ownerActiveAt: ctx.runtime.ownerActiveAt, lastDispatchAt: ctx.runtime.lastDispatchAt, startedAt: ctx.runtime.startedAt,
    quota, selfTurnsToday, redKind, ownerHoldUntil: plan.ownerHoldUntil, borrowJobIds: plan.borrowJobIds,
    openQuestionSubjects: new Set(ctx.store.table('inbox').list(i => i.botId === botId && i.type === 'question' && i.status === 'open').map(i => i.subjectKey)),
    openOwnerAskCount: ownerAsks.length,
    openOwnerAskUntil: ownerAsks.length === 0 ? null
      : ownerAsks.some(i => i.expiresAt === null) ? null : Math.min(...ownerAsks.map(i => i.expiresAt!)),
    ownerEvidenceIds: new Set([
      ...ctx.store.table('percepts').list(p => p.botId === botId
        && ((p.source === 'owner' && p.kind === 'owner_message') || (p.source === 'inbox' && p.kind === 'inbox_reply'))).map(p => p.id),
      ...ctx.store.table('inbox').list(i => i.botId === botId && i.status === 'answered').map(i => i.id),
    ]),
    subjectWakeAt, retryAt: bot?.retryAt ?? null, job: jobGateInfo(ctx, jobId ?? undefined),
    skillRun: skillRunGateInfo(ctx, subjectKey ?? null, botId), teamSkillTurnsToday: teamSkillTurnsToday(ctx, now),
    authBlocked: ctx.store.table('alerts').list(a => a.code === 'auth' && a.status === 'open').length > 0 };
}

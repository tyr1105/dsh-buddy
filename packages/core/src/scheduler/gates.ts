/** 九道闸按规格顺序执行：紧急只越过冷却与节奏，预算和额度始终保留最终保护。 */
import type { QueueEntry, Settings } from '../model/index.js';
import type { SuppressedBy } from '../appraisal/log.js';
import type { GateSnapshot } from './snapshot.js';
import { SKILL_DEFAULTS } from '../config/defaults.js';
import { effectivePaceMinMs } from './pacing.js';
import { nextLocalTime } from '../util/time.js';
import { onDemandBlocks } from './on-demand.js';
import { isLearnWork, isSkillWork } from '../skill/keys.js';
import { isSelfWork } from '../quota/usage.js';
export { buildSnapshot } from './snapshot.js';
export type { GateSnapshot } from './snapshot.js';
export type GateResult = { pass: true } | { pass: false; by: SuppressedBy; until: number | null; drop: boolean };
const blocked = (by: SuppressedBy, until: number | null = null, drop = false): GateResult => ({ pass: false, by, until, drop });

/** 按规格顺序执行九道放行检查，返回首个拦截原因和恢复时刻供审计。 */
export function evaluateGates(entry: QueueEntry, snapshot: GateSnapshot, now: number, settings: Settings): GateResult {
  const s = snapshot;
  const bot = s.bot;
  // P74c：候选带 jobId 就是「执行链唤醒」（一件已约定的事的某一步）。下面凡是写着「执行链」的分支只对它生效，其余候选一字不变。
  const chain = typeof entry.jobId === 'string' && entry.jobId !== '';
  const job = chain ? s.job ?? null : null;
  if (chain) {
    // 0：这件事已经不需要这次唤醒（找不到、已完成且不在发布准备、已停止、在等主人验收），或这位员工已不是参与者：直接丢弃，原因 job_inactive。
    // 再加一条：受阻期间只有总管有事可做（做不下去的说明、三轮不过的说明），别的员工的旧候选没有意义，同样丢弃。
    // 丢弃不会悄悄发生：select.ts 记评估日志，这件事的状态与进度行本来就写着真实情况（已完成、已停止、等你验收、受阻……）。
    if (job === null
      // P74r18b：发布状态是「发布没有成功」（failed）时执行者还要被叫醒改正或交账；命令成功后补记网址的那一次叫醒（launchLinkOpen）同样放行。
      || (job.state === 'done' && job.launchState !== 'preparing' && job.launchState !== 'approval' && job.launchState !== 'failed' && job.launchLinkOpen !== true)
      || job.state === 'stopped' || job.state === 'awaiting_owner'
      || !bot || !job.participants.includes(bot.id)
      || (job.state === 'blocked' && bot.id !== job.chiefId)) return blocked('job_inactive', null, true);
  }
  // P75g：技能类回合（复盘、技能核对、整理，事项键 retro:/skillcheck:/tidy:）自己的三道闸。
  // 只对技能类候选生效，其余候选一字不变；对应记录的事实由快照的 skillRun 带出（select、deadman 调 buildSnapshot 时传事项键）。
  const skill = isSkillWork(entry.reason.kind, entry.subjectKey);
  // P75i：学习回合（种类 teach、事项键 learn:）是主人发起的回合：同样要有所属记录、没过期、回合没用完（下面三道），
  // 但不是技能类的「全队每天回合上限」「橙灯等待」「越过冷却」那一套——这些由它自己的 ownerInitiated 决定（放行、不计自主预算）。
  const learn = isLearnWork(entry.reason.kind, entry.subjectKey);
  const skillRun = skill || learn ? s.skillRun ?? null : null;
  if (skill || learn) {
    const state = skillRun?.participants[entry.botId];
    // 1：找不到所属记录，或这位参与者已不是 queued（做完、跳过、放弃或进行中）：丢弃，原因 skill_stale；
    // 参与者状态保持原样（这条候选本来就不该还在队列里）。P75r5b：与下面「真的等了 7 天」分开用原因码，
    // 否则「状态没收回来」会被记成「等待超过 7 天」（审查 H1）。
    if (skillRun === null || state === undefined || state !== 'queued') return blocked('skill_stale', null, true);
    // 2：候选等了 WORK_EXPIRE_MS（7 天）仍没轮到：丢弃，原因 skill_expired；参与者改 expired 由丢弃处理处写（select.ts 的 settleDroppedSkillEntry）。
    // 每周整理的候选不沿用这一条（P75i 派活说明第一节第 4 条）：当天 TIDY_LAST_HOUR 点之后还没做成的由 sweepSkillRuns 记 busy_all_day。
    if (skillRun.kind !== 'tidy' && entry.enqueuedAt < now - SKILL_DEFAULTS.WORK_EXPIRE_MS) return blocked('skill_expired', null, true);
    // 3：这次复盘的回合用完：丢弃，原因 skill_cap；参与者改 capped 同样在丢弃处理处写。
    if (skillRun.turnsLeft <= 0) return blocked('skill_cap', null, true);
    // 派活说明第二节第 5 条：验收之后可能有对外发布（执行者带 jobId 的回合在准备发布）；复盘的候选与它是同一位员工，
    // 照「有在办的事时等待」的口径，发布准备进行中时等它结束再放行（发布了、主人暂不发布、中心结束都算结束）。
    if (skillRun.launchBusy) return blocked('concurrency');
    // P75i（任务卡 5.2）：每周整理遇到这位员工有执行中、核对中、返工中的事时拦下（不丢弃），每小时（TIDY_RETRY_MS）再看一次。
    if (skillRun.tidyBusy === true) return blocked('concurrency', now + SKILL_DEFAULTS.TIDY_RETRY_MS);
  }
  // 1–3：先处理生命周期、同机器人互斥和正在等主人回答的同一事项。
  if (!bot || !['active', 'probation'].includes(bot.lifecycle)) return blocked('paused', null, true);
  // P73r1（R5）：听吩咐的员工不接受自主来源的候选。升级前已在队列里的旧候选、运行中被改成听吩咐之后的旧候选，
  // 都在这里丢弃（P73r2：用专门的「on_demand」拦截原因，评估日志写「听吩咐」；drop 为真时调度会把它移出队列）。
  if (onDemandBlocks(bot, entry.reason.kind, entry.subjectKey)) return blocked('on_demand', null, true);
  if (s.running) return blocked('concurrency');
  const hasOwnerInput = entry.ownerInitiated || ['owner_message', 'inbox_reply'].includes(entry.reason.kind)
    || entry.reason.evidence.some(id => s.ownerEvidenceIds?.has(id));
  if (chain) {
    // 执行链的「等主人」：只在同一件事自己有「待你处理」条目开着时才拦（保留候选，答复后接着做）。
    // 这个员工名下别的「等你回答」条目（别的事、自己的提问）不该挡住这件已约定的事，
    // 否则总管手上只要有任何一条提问开着，这件事的所有唤醒都会被挡住，而且没有任何东西会让它恢复（第二块遗留）。
    if (job!.ownerAskOpen && !hasOwnerInput) return blocked('waiting_owner');
    // P74e（B2）：约定正在等主人确认（执行中的事重新确认）时，核对环节暂停：核对通过会让主人面前同时有两个入口
    // （约定确认和验收），而且被改动涉及的部分按旧版本核对没有意义。候选保留，确认之后照常放行
    // （确认改了「怎样算做完」的，这件事转返工，核对人的候选另被丢弃）。执行者照常做、总管照常回答，不受影响。
    if (job!.reopenPending === true && job!.state === 'checking' && job!.reviewerId != null && bot.id === job!.reviewerId && !hasOwnerInput) {
      return blocked('waiting_owner');
    }
  } else {
    if (s.openQuestionSubjects.has(entry.subjectKey) && !hasOwnerInput) return blocked('waiting_owner_same_subject', null, true);
    // F07：提问或审批还在等主人时，这个机器人先不自己找新事做；候选保留，答复后可以接着判断。
    // 紧急、主人消息、审批结果仍放行，否则会连「去回答主人」都被自己的等待挡住。
    // 复盘回合是只读的（不改中心状态、不能单推或找人），不会打扰主人，也允许在等待期间继续整理经验。
    // P76r1：这道闸门只拦「员工自己发起」的候选（口径见 quota/usage.ts 的 isSelfWork）：总管为主人派出的、主人决定之后的接续、
    // 团队信号、发给总管的同伴消息、重试主人发起的回合，都是别人或主人交代的事，不该被自己开着的提问无限期挡住。
    if (s.openOwnerAskCount > 0 && !hasOwnerInput && !entry.urgent
      && entry.reason.kind !== 'approval_decided' && entry.variant !== 'reflection' && isSelfWork(entry, bot.role)) {
      return blocked('waiting_owner', s.openOwnerAskUntil);
    }
  }
  // 4–5：紧急与审批可越过节奏；主人主动发起也不用等最短间隔。
  const previous = s.subjectWakeAt.get(entry.subjectKey);
  // P72l：chiefDispatch（总管在主人发起的回合里派出的活）只豁免这两道闸，其余闸门照常。
  // P74c：执行链唤醒同样越过这两道闸（主人已经确认过的事，员工不该再等「最短思考间隔」）；两种来源合并成一个变量。
  const exempt = entry.chiefDispatch === true || chain;
  // P75g：技能类回合同样越过冷却与最短间隔。单独一个变量（paceExempt），不复用 exempt：
  // exempt 也决定第 7 步的橙灯放行，而技能类回合不是主人发起、不是主人确认过的事，橙灯不放行（方案第 9 节）。
  const paceExempt = exempt || skill;
  if (previous !== undefined && now < previous + settings.subjectCooldownMs && !entry.urgent && !entry.ownerInitiated && !paceExempt && !['owner_message', 'approval_decided'].includes(entry.reason.kind)) {
    return blocked('cooldown', previous + settings.subjectCooldownMs);
  }
  if (!entry.urgent && !entry.ownerInitiated && !paceExempt && entry.reason.kind !== 'approval_decided' && bot.lastThinkAt !== null) {
    const until = bot.lastThinkAt + effectivePaceMinMs(bot, settings, s.quota.light);
    if (now < until) return blocked('pace_min', until);
  }
  // 6：员工自己发起的工作只剩一条上限：每位每天最多 botDailyTurnBudget 个回合（只数员工自己发起的回合，口径见 quota/usage.ts 的 isSelfWork）。
  // P76c：删去每日思考上限、每日 token、每窗口回合、试岗减半四项判断（bot_budget 这个拦截原因不再产生，枚举保留以读旧日志）。
  // 分三类处理：
  // 1. 不是员工自己发起的，不查每日上限：
  //    - 执行链唤醒（P74c）：一件已约定的事做到一半被每日上限拦到第二天，主人会看到事情「莫名其妙停了一天」；
  //      靠「每件事的回合上限」兜住消耗，剩余回合用完就丢弃（job_cap），中心停下这件事并问主人（job/sweep.ts）。
  //    - 总管为你派出的活（chiefDispatch，P76c 并入）：它是你交代的事，不是员工自己开工的回合，不占员工自己的名额。
  //    - 你发起的（ownerInitiated）：一直不受每日上限限制。
  // 2. 技能类回合（P75g）：同样不计员工自己发起的名额（方案第 16 节第 3 项），改受「全队今天技能类回合数」约束；
  //    到上限的候选保留到次日 00:00（不丢弃），原因 skill_daily_cap。
  // 3. 其余（员工自己发起的）：今天自己发起的回合数达到上限，候选保留到次日 00:00，原因 daily_cap。
  // 红灯、鉴权、启动静默、全局间隔、并发上限、重试退避仍照旧（下面第 7 至 9 步；橙灯对执行链放行，理由见第 7 步的注释），它们保护的是全局而不是某个员工。
  if (skill) {
    const tomorrow = nextLocalTime('00:00', now, settings.timezone);
    if ((s.teamSkillTurnsToday ?? 0) >= SKILL_DEFAULTS.TEAM_DAILY_TURNS) return blocked('skill_daily_cap', tomorrow);
  } else if (!entry.ownerInitiated && chain) {
    if (job!.turnsLeft <= 0) return blocked('job_cap', null, true);
  } else if (isSelfWork(entry, bot.role)) {
    // P76r1：是不是「员工自己发起」只问 isSelfWork 一处（你发起的、总管派出的、主人决定之后的接续、团队信号、发给总管的同伴消息等都不是）。
    const tomorrow = nextLocalTime('00:00', now, settings.timezone);
    if (s.selfTurnsToday >= settings.botDailyTurnBudget) return blocked('daily_cap', tomorrow);
  }
  // 7：额度（P76d 改写这一步，其余不动）。顺序：鉴权 -> 真实额度用完 -> 你自己要用 -> 员工份额用完 -> 橙灯。
  // 「你发起的」= 唤醒单 ownerInitiated，或属于主题对话（topicId 不为空），与记账口径一致（quota/plan.ts 的 isOwnerSide）。
  const ownerSide = entry.ownerInitiated === true || (typeof entry.topicId === 'string' && entry.topicId !== '');
  // 鉴权失败：直到人工确认，全部拦下（现状）。
  if (s.authBlocked) return blocked('quota');
  // 真实额度用完（红灯 exhausted，旧的手写快照没有 redKind 时红灯也按它处理）：谁都用不了，包括你发起的——发出去也会报错。
  // 只有已授予的一次探针可进入后续闸门；恢复时刻是 redUntil（现状）。
  if (s.quota.light === 'red' && s.redKind !== 'staff_full' && !s.quota.probeAllowed) return blocked('quota', s.quota.redUntil);
  // 你自己要用（「我接下来 N 小时要用」，设计稿场景 E）：这段时间员工不开新回合，只有你发起的放行；
  // 执行链、总管派活、复盘类、员工自己发起的一律等到 ownerHoldUntil。正在做的回合不受影响（闸门只管开新回合）。
  if (s.ownerHoldUntil != null && now < s.ownerHoldUntil && !ownerSide) return blocked('quota', s.ownerHoldUntil);
  // 员工份额用完（红灯 staff_full）：你发起的从来不受员工份额约束，放行（设计稿 E「员工最多用七成」：员工不碰你留出的部分）；
  // 执行链和总管派活不放行，只有「用我的额度」放行过的那件事（borrowJobIds，本窗口有效，且只对带 jobId 的执行链候选）例外；
  // 复盘类、员工自己发起的等到本窗口结束（redUntil 就是窗口结束时刻）。
  if (s.quota.light === 'red' && s.redKind === 'staff_full' && !ownerSide && !(chain && (s.borrowJobIds ?? []).includes(entry.jobId!))) {
    return blocked('quota', s.quota.redUntil);
  }
  // P73r5 + P74 合并裁定：橙灯时，主人确认过的事与主人发起的唤醒同样放行：
  // 带 chiefDispatch 的候选（P73r5）和执行链候选（带 jobId，P74c）。真实额度用完与鉴权失败上面已拦住所有候选，包括这两类。
  // 这里的 exempt 就是第 4–5 步算好的「chiefDispatch 或执行链」。技能类、员工自己发起的在橙灯等待到本窗口结束（紧急的放行，现状）。
  // P76r1：橙灯的「主人这一侧」与上面两种情形用同一个判断（ownerSide：你发起的，或带主题编号），主题里的候选不再在橙灯时被拦。
  if (s.quota.light === 'orange' && !entry.urgent && !ownerSide && !exempt) return blocked('quota', s.quota.windowStartAt + settings.quotaWindowMs);
  // 8：主人主动发起豁免启动静默与全局间隔，但不豁免并发。
  if (!entry.ownerInitiated && now < s.startedAt + settings.startupQuietMs) return blocked('startup_quiet', s.startedAt + settings.startupQuietMs);
  if (!entry.ownerInitiated && s.lastDispatchAt !== null && now < s.lastDispatchAt + settings.dispatchGapMs) return blocked('dispatch_gap', s.lastDispatchAt + settings.dispatchGapMs);
  const ownerPresent = s.ownerActiveAt !== null && s.ownerActiveAt <= now && now - s.ownerActiveAt < settings.ownerAwayAfterMs;
  if (s.runningCount >= (ownerPresent ? settings.ownerActiveConcurrentThinks : settings.maxConcurrentThinks)) return blocked('concurrency');
  // 9：notBefore 也是明确的最早执行时间，不允许高优先级绕过未到时的重排。
  const retryAt = Math.max(s.retryAt ?? now, entry.notBefore);
  if (retryAt > now) return blocked('retry_backoff', retryAt);
  return { pass: true };
}

/** 回合用量按唤醒单幂等记账；个人预算排除主人发起，全局额度仍记录真实机器人消耗。 */
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import { z } from 'zod';
import type { HubContext } from '../engine/context.js';
import { parseInput } from '../engine/validation.js';
import type { LedgerEntry } from '../model/operations.js';
import type { WakeTicket } from '../model/wake.js';
import { count, nonempty } from '../model/primitives.js';
import { newId } from '../util/ids.js';
import { startOfLocalDay } from '../util/time.js';
import { isSkillWork } from '../skill/keys.js';
import { isTeamSignal } from '../scheduler/on-demand.js';
import { addJobTurnTokens } from '../job/usage.js';
import { addOwnerTurnTokens } from '../job/owner-turns.js';
import type { WakeKind } from '../model/enums.js';
import { auditCapacityChange, getQuotaPlan, isOwnerSide, raiseCapacityToUsage, savePlan, windowHadError } from './plan.js';
import { beginQuotaWindow, recomputeLightAndSave, rollWindow } from './window.js';

const UsageInputSchema = z.strictObject({ botId: nonempty, wakeId: nonempty, tokens: count.nullable(), steps: count, packetBytes: count });
export type UsageInput = z.infer<typeof UsageInputSchema>;

/** 可能后开始的回合先结束；起窗必须找最早真实开始且尚未记账的回合，不能按结束顺序猜测。 */
function firstWindowStart(ctx: HubContext, now: number): number {
  const settled = new Set(ctx.store.log('ledger').all().filter(entry => entry.kind === 'turn').map(entry => entry.wakeId));
  const starts = ctx.store.table('wakes').list(wake => !settled.has(wake.id) && wake.startedAt <= now
    && wake.dispatchedAt !== null && (wake.dispatchedAt === undefined || wake.dispatchedAt <= now)
    // 老记录没有 dispatchedAt 时，running 或已完成回合可作为投递事实；投递中或 error 则不猜测。
    && (wake.dispatchedAt !== undefined || !['delivering', 'error'].includes(wake.status)))
    .map(wake => wake.startedAt);
  return starts.length === 0 ? now : Math.min(...starts);
}

/** 不能拿到 token 时才估算；向上取整，避免小数记账低估资源。 */
export function recordUsage(ctx: HubContext, input: UsageInput): LedgerEntry {
  const value = parseInput(UsageInputSchema, input, '用量');
  const duplicate = ctx.store.log('ledger').all().find(entry => entry.kind === 'turn' && entry.wakeId === value.wakeId);
  if (duplicate) {
    if (duplicate.who !== value.botId) throw new Error('wakeId 已有的账项与 botId 不一致');
    return duplicate;
  }
  const wake = ctx.store.table('wakes').get(value.wakeId);
  if (wake && wake.botId !== value.botId) throw new Error('wakeId 对应的机器人与 botId 不一致');
  const now = ctx.clock.now();
  const tokenBase = value.tokens ?? value.packetBytes / ctx.settings.estimatedBytesPerToken + value.steps * ctx.settings.estimatedTokensPerStep;
  const entry: LedgerEntry = { id: newId('le', ctx.rng), who: value.botId, wakeId: value.wakeId,
    tokens: Math.ceil(tokenBase * ctx.settings.tokenAccountingMultiplier), kind: 'turn', at: now,
    tokenSource: value.tokens === null ? 'estimate' : 'host', tokenBase,
    accountingMultiplier: ctx.settings.tokenAccountingMultiplier,
    ...(wake ? { ownerInitiated: wake.ownerInitiated } : {}) };
  const existed = ctx.store.table('quota').get('quota');
  const rolled = existed ? rollWindow(ctx, now) : null;
  const state = !rolled || rolled.windowPending ? beginQuotaWindow(ctx, firstWindowStart(ctx, now)) : rolled;
  // P63：主题回合只记账本（成本表能看到），不占窗口的自我保护上限：窗口上限连私聊都算，
  // 到顶全队暂停，一次讨论就能用光。单次成本靠发言上限兜住，服务商真报额度错误时仍会亮红灯。
  if (!wake?.topicId) {
    state.botTurns += 1;
    state.botTokens += entry.tokens;
  }
  // P76d：按「实测 token（tokenBase，向上取整，不用记账值）」分两类累加进额度记录：
  // 主人一侧（你发起的、主题回合）进 ownerTokens、ownerTurns，其余（执行链、总管派活、复盘类、员工自己发起）进 staffTokens、staffTurns。
  // 找不到唤醒单（已清理）时按员工一侧记：宁可员工份额少一点，不让员工挤占你留出的部分。
  const base = Math.ceil(tokenBase);
  const ownerSide = wake ? isOwnerSide(wake) : false;
  let plan = getQuotaPlan(ctx, now);
  plan = ownerSide
    ? { ...plan, ownerTokens: plan.ownerTokens + base, ownerTurns: plan.ownerTurns + 1, updatedAt: now }
    : { ...plan, staffTokens: plan.staffTokens + base, staffTurns: plan.staffTurns + 1, updatedAt: now };
  // 回升规则一：本窗口插件看得到的用量超过了估计容量（而没有报错）：容量提高到这个用量，每次记一条审计。
  // 这个窗口已经有真实额度报错时不回升：报错那一刻校准出的容量才是依据，之后收尾的回合不能把它再抬高。
  const raised = windowHadError(plan, state.windowStartAt) ? null : raiseCapacityToUsage(plan);
  if (raised !== null) {
    auditCapacityChange(ctx, now, plan.capacityTokens, raised, '记账：本窗口插件看到的用量超过估计容量，没有额度报错');
    plan = { ...plan, capacityTokens: raised };
  }
  // 灯按员工份额已用比例重算；员工份额用完时恢复时刻是本窗口结束（真实额度用完的红灯由 onQuotaError 管，这里不改它的恢复时刻）。
  // P76r3（R8）：这一段改为调用 quota/window.ts 的 recomputeLightAndSave，删去内联的重复逻辑。
  // 差别在「由红转不红」：容量回升（回升规则一）使份额比例落回橙或黄时，因额度休息的员工要恢复在岗，
  // 内联的那一份只处理「转红」，员工会一直显示休息而闸门其实已放行。写入顺序不变：先账本、再额度记录，最后重算灯。
  ctx.store.log('ledger').append(entry);
  savePlan(ctx, plan);
  ctx.store.table('quota').put(state);
  // P76e：这张唤醒单属于一件事时，把实测 token（tokenBase 向上取整）补进这件事的分步记账；出错只记日志（函数内部处理）。
  addJobTurnTokens(ctx, wake, tokenBase, now);
  // P87：你发起的总管回合记在「你发起」一栏里的，同样补 token（只有你发起的唤醒单才可能在那一栏里）。
  if (wake?.ownerInitiated) addOwnerTurnTokens(ctx, wake.id, tokenBase, now);
  recomputeLightAndSave(ctx, now);
  ctx.emit(HUB_EVENT_SCOPES.overview, value.botId);
  ctx.emit(HUB_EVENT_SCOPES.bot, value.botId);
  return entry;
}

/** 主人直接发起的回合仍留在账本，但不压缩机器人自发工作的日预算。 */
function automatedUsage(ctx: HubContext, botId: string, from: number, now: number): LedgerEntry[] {
  return ctx.store.log('ledger').since(from, entry => entry.who === botId && entry.at <= now)
    .filter(entry => entry.wakeId === null || !ctx.store.table('wakes').get(entry.wakeId)?.ownerInitiated);
}

/**
 * 按本地当天汇总自主回合与 token，排除主人发起回合。
 * P76c 起：回合数的口径（闸门、疲劳、内驱、隔离、视图）全部改用 selfWorkUsageToday；
 * 这里只剩 token 汇总一处使用（员工卡上的今日 token），回合数仍随结果返回但不再作为任何限额的依据。
 * 原先给隔离线用的两个选项（排除一件事里的回合、排除技能类回合）已随隔离线改口径而删除。
 */
export function botUsageToday(ctx: HubContext, botId: string, now: number): { turns: number; tokens: number } {
  const entries = automatedUsage(ctx, botId, startOfLocalDay(now, ctx.settings.timezone), now);
  return { turns: entries.filter(entry => entry.kind === 'turn').length, tokens: entries.reduce((sum, entry) => sum + entry.tokens, 0) };
}

/**
 * 判断「是不是员工自己发起」所需的字段：队列候选（QueueEntry）和唤醒单（WakeTicket）都有这些字段，所以同一个函数两边通用。
 * 候选上没有的字段（ownerDirect 只在唤醒单上）可以省略；这位员工是不是总管由调用处另给（第二个参数）。
 */
export interface SelfWorkFacts {
  reason: { kind: WakeKind };
  subjectKey?: string | undefined;
  ownerInitiated?: boolean | undefined;
  ownerDirect?: boolean | undefined;
  ownerDecided?: boolean | undefined;
  retryOfSelfWork?: boolean | undefined;
  jobId?: string | null | undefined;
  chiefDispatch?: boolean | undefined;
  variant?: string | undefined;
  topicId?: string | null | undefined;
}

/**
 * 是不是「员工自己发起的工作」：没有人交代、也不是在响应主人或中心的要求，员工自己开工的回合（P76 方案第 0 节、7.3 节；P76r1 把口径收成一处）。
 * 全项目只有这一个定义，对队列候选和唤醒单都适用：闸门第 3 步（等主人）、第 6 步（每天上限）、selfWorkUsageToday（数名额）、
 * 两条停用线（连续不交账、用量）、疲劳、内驱、视图全部引用它；规则只在这里写，别处不得另写一份。
 * 下面这些情形任何一条成立，都是别的口径管着的回合，不算自己发起的（botRole 是这位员工的角色，只用于总管的两条）：
 *  1 你发起的（ownerInitiated）；2 你在宿主会话里直接聊的（ownerDirect）；3 唤醒原因是你的消息（owner_message）；
 *  4 属于一件事（jobId）；5 总管为你派出（chiefDispatch）；6 技能类（复盘、核对、整理，有自己的上限）；7 教学变体；8 主题回合（topicId）；
 *  9（P76r1）你亲手批准或拒绝之后的接续回合：唤醒原因是审批结果（或它的重试），并且候选或唤醒单带 ownerDecided；
 *    审批被中心按到期处理的不带这个标记，仍算自己发起的；
 *  10（P76r1）总管收到中心发来的团队异常信号（员工卡住、被停用、交接超时）：系统在通知管理者，不是总管自己要动；
 *  11（P76r1）总管收到同伴消息：员工向管理者报告，总管必须能接。普通员工收到的同伴消息仍算自己发起的。
 * 重试沿用原回合的归属：重试候选建立时把原回合的「你发起」「总管派出」「主题」「事」「你作出决定」标记一并带过来，
 * 所以同一套规则对重试同样适用；「重试不另占名额」是数名额时的规则，写在 selfWorkUsageToday。
 */
export function isSelfWork(unit: SelfWorkFacts, botRole?: string): boolean {
  // P76r1 小修：重试沿用原回合「是不是自己发起」的结论（建重试时按原回合的 isSelfWork 记下，true 和 false 都带；
  // 原回合本身是重试时，它带的就是更早那次的结论，所以重试的重试自然沿用）。没有这一项（旧数据）时照下面的常规规则判断。
  if (unit.reason.kind === 'retry' && unit.retryOfSelfWork !== undefined) return unit.retryOfSelfWork;
  if (unit.ownerInitiated === true) return false;
  // P76c：在宿主会话里主人直聊触发的回合、以及唤醒原因是主人消息的回合，都是主人发起的，不是员工自己发起的。
  if (unit.ownerDirect === true) return false;
  if (unit.reason.kind === 'owner_message') return false;
  if (typeof unit.jobId === 'string' && unit.jobId !== '') return false;
  if (unit.chiefDispatch === true) return false;
  if (isSkillWork(unit.reason.kind, unit.subjectKey)) return false;
  if (unit.variant === 'teach') return false;
  if (typeof unit.topicId === 'string' && unit.topicId !== '') return false;
  // P76r1：主人作出决定之后的接续回合（审批结果；它的重试沿用同一个标记）。
  if (unit.ownerDecided === true && (unit.reason.kind === 'approval_decided' || unit.reason.kind === 'retry')) return false;
  // P76r1：团队异常信号只会发给总管；同伴消息发给总管时，总管不是自己开工。
  if (isTeamSignal(unit.reason.kind, unit.subjectKey)) return false;
  if (botRole === 'chief' && unit.reason.kind === 'peer_message') return false;
  return true;
}

/** 这张唤醒单是否真正投递过（投递判断与 firstWindowStart 相同：dispatchedAt 为 null 的投递失败或投递前被打断不算；老记录没有 dispatchedAt 时，投递中或出错的不猜测）。 */
function wasDelivered(wake: WakeTicket, now: number): boolean {
  return wake.dispatchedAt !== null && (wake.dispatchedAt === undefined || wake.dispatchedAt <= now)
    && (wake.dispatchedAt !== undefined || !['delivering', 'error'].includes(wake.status));
}

/**
 * 这位员工本地当天已经做了几个「自己发起的」回合（只数回合，不数 token）。
 * 只数 startedAt 不晚于 now 且已真正投递的唤醒单（投递判断与 firstWindowStart 相同：dispatchedAt 为 null 的投递失败不算；
 * 老记录没有 dispatchedAt 时，投递中或出错的不猜测）。P76c 起闸门、疲劳、内驱、隔离、视图都用它。
 * after（可省略）：只数开始时刻晚于它的回合；隔离线传「主人上次恢复员工在岗的时刻」，恢复之前的回合不再算，
 * 否则主人刚恢复，员工会因为当天恢复之前的回合立刻又被停用。
 * P76r1：唤醒原因是重试的唤醒单不另数（原回合已经数过一次，所以自己发起的回合超时后重试只占 1 个名额）。
 * 例外：重试对应的原回合没有真正投递过（投递失败、投递前被打断）、或找不到原唤醒单时，这个重试就是第一个真正开始的回合，照数，
 * 否则这样的回合一个名额都不占。
 */
export function selfWorkUsageToday(ctx: HubContext, botId: string, now: number, after?: number): { turns: number } {
  const dayStart = startOfLocalDay(now, ctx.settings.timezone);
  const role = ctx.store.table('bots').get(botId)?.role;
  const wakes = ctx.store.table('wakes');
  const turns = wakes.count(wake => wake.botId === botId
    && wake.startedAt >= dayStart && wake.startedAt <= now
    && (after === undefined || wake.startedAt > after)
    && wasDelivered(wake, now)
    && isSelfWork(wake, role)
    // 重试的原回合是证据里的第一个唤醒单编号；它真正投递过，这个重试就不另占名额。
    && !(wake.reason.kind === 'retry' && wasDeliveredById(wakes.get(wake.reason.evidence[0] ?? ''), now)));
  return { turns };
}

/** 原唤醒单存在并且真正投递过。 */
function wasDeliveredById(original: WakeTicket | null, now: number): boolean {
  return original !== null && wasDelivered(original, now);
}

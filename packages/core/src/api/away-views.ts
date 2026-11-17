/**
 * 离开期间摘要的文字（P76i，方案 7.9）：你超过 8 小时没打开，再打开时在总管私聊顶部看到的一段「这段时间发生了什么」。
 *
 * 为什么是纯函数：文字完全由记录拼出，不调用模型、不落消息、不推送；输入里显式带时间段、每件事这段时间里的事件和回合、
 * 当前状态，所以每种情形都能逐字写单测。从存储里取这些输入的代码在 away-input.ts，读写 ownerPresence 的在 outreach/presence.ts。
 *
 * 文字（逐字，每个元素是一行）：
 *   首行  你离开的 {时长}里（{开始} 到 {结束}）
 *   每件这段时间里有回合或有事件的事一行  {标题}：{一句}。用了 {n} 回合。
 *   这段时间没有回合、没有事件、但现在在等你的事  {标题}：仍在等你{事项}。（不写「用了」）
 *   末行  共用 {n} 回合，约 {x} token。{通知句}
 *   一件事都没有（第二类一行都没有）  整个只有一行「这段时间没有变化。」
 * {一句} 取这段时间里最后一个「重要事件」；对照表见 sentenceOf。
 */
import type { JobEventKind } from '../model/job.js';
import { waitedText } from '../job/stall.js';
import { localDateKey, localParts, startOfLocalDay } from '../util/time.js';
import { formatTokenCount } from '../util/token-format.js';

/** 这段时间里一件事的一个事件（只带摘要要用的几项）。 */
export interface AwayEvent { kind: JobEventKind; at: number; actor: string; to: string[]; data: Record<string, unknown> }

/** 这段时间里一件事的输入。 */
export interface AwayJobInput {
  title: string;
  /** 这段时间开始的回合数与实测 token（一件事的用量行里开始时间在时间段内的回合）。 */
  turns: number; tokens: number;
  /** 这段时间里最后一个回合开始的时间；没有回合为 null（排序用）。 */
  lastTurnAt: number | null;
  /** 这段时间里的事件，按时间从旧到新。 */
  events: AwayEvent[];
  /** 当前状态词与在等谁（与进度行同一口径）；没有人在等为 null。 */
  stateLabel: string; waitingOn: string | null;
  /** 现在是不是真的停下在等你（P76r3 的甲），以及在等你的简短事项（验收、选一个办法……）。已收尾的事恒为 false。 */
  waitingOwner: boolean; waitItem: string | null;
  /** 这件事有没有开着的 job: 条目（P76r3 的乙），以及只有乙成立时那一条的事项；没有为 false、null。 */
  hasOpenItem: boolean; noticeItem: string | null;
  /** 在等你已经等了多久（毫秒），排序用。 */
  waitedMs: number;
}

export interface AwayInput {
  from: number; to: number; now: number; timezone: string;
  /** 员工 id → 名字（事件里的执行者、提问人从这里取名字）。 */
  names: Record<string, string>;
  jobs: AwayJobInput[];
  /** 这段时间通知队列里已发出的行数。 */
  sentCount: number;
}

export interface AwaySummary { lines: string[]; totalTurns: number; totalTokens: number }

/** 不当作「重要事件」的事件：它们只是过程，不改变「这件事现在怎样」。submitted 另用来判断「已改好」。 */
const NEUTRAL_KINDS: ReadonlySet<JobEventKind> = new Set<JobEventKind>([
  'assigned', 'reassigned', 'forwarded', 'resumed', 'launch_requested', 'trial_reported', 'cap_answered', 'option_chosen', 'submitted', 'paused',
]);

const pad = (value: number): string => String(value).padStart(2, '0');

/** 「今天 09:05」「昨天 19:10」「11月9日 19:10」：与 now 同一天写今天，前一天写昨天，更早写月日。 */
export function awayTimeText(at: number, now: number, timezone: string): string {
  const p = localParts(at, timezone);
  const clock = `${pad(p.hour)}:${pad(p.minute)}`;
  const key = localDateKey(at, timezone);
  if (key === localDateKey(now, timezone)) return `今天 ${clock}`;
  if (key === localDateKey(startOfLocalDay(now, timezone) - 1, timezone)) return `昨天 ${clock}`;
  return `${p.month}月${p.day}日 ${clock}`;
}

/** 数字字段（事件里的 data 是未知类型，取不到按 fallback）。 */
function numberOf(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * 这件事在这段时间里的「一句」：取最后一个重要事件（不在 NEUTRAL_KINDS 里的），对照表：
 *   delivered → 已交付，在等你验收
 *   reviewed（不通过：fail、limit）→ 核对第 {r} 轮退回 {k} 条；其后若有交回（submitted）再接「，{执行者}已改好，在等第 {r+1} 轮核对」（只对 fail）
 *   reviewed（通过）→ 核对通过
 *   asked → {名字}问了 {k} 个问题，在等{回答的人}；answered → {名字}问了 {k} 个问题，总管已回答
 *   owner_accepted → 已完成
 *   launched → 已发布；launch_failed → 发布没有成功；launch_declined（主人暂不发布或中心结束发布）→ 没有发布
 *   其余（没有重要事件，或最后一个重要事件是 escalated、executor_blocked、turn_cap、stopped、participant_off、owner_returned）
 *     → {状态词}，在等{谁}（没有人在等时只写状态词）
 */
export function sentenceOf(job: AwayJobInput, names: Record<string, string>): string {
  const significant = job.events.filter(event => !NEUTRAL_KINDS.has(event.kind));
  const last = significant[significant.length - 1];
  // P76r3（R9）：这件事现在有开着的条目时优先写「在等你{事项}」（甲）或「另有一条在等你{事项}」（只有乙），
  // 不再退回到看不出等你做什么的「{状态词}，在等{谁}」。
  const fallback = job.hasOpenItem && job.waitingOwner && job.waitItem !== null
    ? `${job.stateLabel}，在等你${job.waitItem}`
    : job.hasOpenItem && job.noticeItem !== null
      ? `${job.stateLabel}，另有一条在等你${job.noticeItem}`
      : `${job.stateLabel}${job.waitingOn === null ? '' : `，在等${job.waitingOn}`}`;
  if (last === undefined) return fallback;
  switch (last.kind) {
    case 'delivered': return '已交付，在等你验收';
    case 'reviewed': {
      if (last.data.result === 'pass') return '核对通过';
      const round = numberOf(last.data.round, 1);
      const unmet = Array.isArray(last.data.unmet) ? last.data.unmet.length : 1;
      const head = `核对第 ${round} 轮退回 ${unmet} 条`;
      // 退回之后执行者又交回了：写「已改好」，在等下一轮核对。第 3 轮仍不过（limit）不会有这一句。
      const resubmitted = last.data.result === 'fail' ? job.events.filter(event => event.kind === 'submitted' && event.at >= last.at).pop() : undefined;
      return resubmitted === undefined ? head : `${head}，${names[resubmitted.actor] ?? '执行者'}已改好，在等第 ${round + 1} 轮核对`;
    }
    case 'asked': case 'answered': {
      const askedCount = Math.max(1, job.events.filter(event => event.kind === 'asked').length);
      // 提问人：asked 事件的发出者；answered 事件的接收者就是提问人。
      const asker = last.kind === 'asked' ? last.actor : last.to[0] ?? '';
      const name = names[asker] ?? '员工';
      return last.kind === 'answered' ? `${name}问了 ${askedCount} 个问题，总管已回答`
        : `${name}问了 ${askedCount} 个问题，在等${job.waitingOn ?? '总管'}`;
    }
    case 'owner_accepted': return '已完成';
    case 'launched': return '已发布';
    case 'launch_failed': return '发布没有成功';
    case 'launch_declined': return '没有发布';
    default: return fallback;
  }
}

/** 一件事这段时间里最近一次动静的时间（排序用：最近的排前面）。 */
function lastActivityOf(job: AwayJobInput): number {
  return Math.max(job.lastTurnAt ?? 0, job.events[job.events.length - 1]?.at ?? 0);
}

/** 拼出摘要。 */
export function buildAwaySummary(input: AwayInput): AwaySummary {
  const active = input.jobs.filter(job => job.turns > 0 || job.events.length > 0)
    .sort((a, b) => lastActivityOf(b) - lastActivityOf(a));
  // P76r3（R6、R9）：只是有一条通知类条目开着（乙）的也算「仍在等你」，用那条条目的事项写；
  // 但「一句」里是否写「在等你」仍只看甲（见 sentenceOf）。
  const waiting = input.jobs.filter(job => job.turns === 0 && job.events.length === 0 && (job.waitingOwner || job.hasOpenItem))
    .sort((a, b) => b.waitedMs - a.waitedMs);
  if (active.length === 0 && waiting.length === 0) return { lines: ['这段时间没有变化。'], totalTurns: 0, totalTokens: 0 };

  const totalTurns = active.reduce((sum, job) => sum + job.turns, 0);
  const totalTokens = active.reduce((sum, job) => sum + job.tokens, 0);
  const lines = [
    `你离开的 ${waitedText(input.to - input.from)}里（${awayTimeText(input.from, input.now, input.timezone)} 到 ${awayTimeText(input.to, input.now, input.timezone)}）`,
    ...active.map(job => `${job.title}：${sentenceOf(job, input.names)}。用了 ${job.turns} 回合。`),
    ...waiting.map(job => `${job.title}：仍在等你${job.waitItem ?? job.noticeItem ?? '决定怎样继续'}。`),
    `共用 ${totalTurns} 回合，约 ${formatTokenCount(totalTokens)} token。${input.sentCount === 0 ? '没有通知过你。' : `通知过你 ${input.sentCount} 次。`}`,
  ];
  return { lines, totalTurns, totalTokens };
}

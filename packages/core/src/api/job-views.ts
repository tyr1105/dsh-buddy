/**
 * 「一件事」的三个纯视图（P74a）：进度行、主题楼层与往来折叠、侧栏一行与项目页的一件事行。
 *
 * 为什么是纯函数：这些文字完全由记录决定，不调用模型、不读存储、不读时钟（时间由调用方显式传入），
 * 所以可以逐种状态写单测，插件界面和中心生成的文字也不会各说各话。
 * 读存储并把它们接到现有视图上的代码在 job-topic-views.ts。
 */
import { JOB_DEFAULTS as D } from '../config/defaults.js';
import {
  ALIGNING_LABEL, JOB_STATE_LABELS, JOB_STATE_TONES, type Job, type JobState,
} from '../model/job.js';
import type { ThreadMessage } from '../model/outreach.js';
import { localParts } from '../util/time.js';
import { confirmWaitNo } from '../job/confirm-wait.js';
import type { JobProgressView, ProjectJobRow, TopicFloorsView } from './types.js';
import type { MemoryNoteView } from './memory-views.js';

// ---------------------------------------------------------------------------
// 共用小工具
// ---------------------------------------------------------------------------

const pad = (value: number): string => String(value).padStart(2, '0');

/** 「11月17日 18:00 前」；没有交付时间写「未约定」。 */
export function dueTextOf(dueAt: number | null, timezone: string): string {
  if (dueAt === null) return '未约定';
  const p = localParts(dueAt, timezone);
  return `${p.month}月${p.day}日 ${pad(p.hour)}:${pad(p.minute)} 前`;
}

// ---------------------------------------------------------------------------
// 一、进度行
// ---------------------------------------------------------------------------

export interface JobProgressInput {
  agreementState: 'pending' | 'locked' | 'withdrawn';
  agreementVersionNo: number;
  job: Job | null;
  /** 员工 id → 名字。 */
  names: Record<string, string>;
  /** 本件事执行链候选被拦住的说明（P74c 接上，本卡一律传 null）。 */
  delayNote: string | null;
  now: number;
  timezone: string;
  /** P74r16b：此刻不在岗（停用、暂停、退役）的员工编号；缺省表示都在岗。写「在等谁」时用。 */
  offDuty?: ReadonlySet<string>;
  /** P74r17：offDuty 里已归档（退役）的员工编号；「在等谁」对他们写「（已归档）」，其余不在岗的仍写「（已停用）」。 */
  retired?: ReadonlySet<string>;
  /** P74r18b：发布这一步的等待情况（读存储得出，见 job/launch-result.ts 的 launchWaitOf）；缺省按「在等你」写。 */
  launchWait?: LaunchWait;
}

/** 发布这一步此刻在等谁的两个事实：命令正在由中心运行（已批准、没运行完）；执行者有带这件事的唤醒在排队或在跑。 */
export interface LaunchWait { running?: boolean; executorWaking?: boolean }

type StepLabel = JobProgressView['steps'][number]['label'];
type StepState = JobProgressView['steps'][number]['state'];

/** 按「当前停在第几步」生成各步状态：之前的 done，当前的 current（或 stuck），之后的 todo。 */
function stepsAt(labels: StepLabel[], current: number, stuck: boolean): JobProgressView['steps'] {
  return labels.map((label, index): { label: StepLabel; state: StepState } => ({
    label,
    state: index < current ? 'done' : index === current ? (stuck ? 'stuck' : 'current') : 'todo',
  }));
}

/** 受阻时停在哪一步：核对阶段（checking）停在「核对」，其余（待开工、执行、返工）停在「执行」。 */
function stepOfResume(resumeTo: Job['state']): number {
  return resumeTo === 'checking' ? 2 : 1;
}

/**
 * 已停止的事停在哪一步：存储里没有记下停止前的状态，所以按已有记录推断——
 * 交付过则停在「你验收」；还没开工停在「执行」；退回返工中（有待改条目）停在「执行」；其余已交回过的停在「核对」。
 */
function stepOfStopped(job: Job): number {
  if (job.deliveredAt !== null) return 3;
  if (job.startedAt === null) return 1;
  return job.round > 0 && job.unmet.length === 0 ? 2 : 1;
}

/** 没有人不在岗（缺省）。 */
const NO_ONE: ReadonlySet<string> = new Set();

/** 在等谁：见方案 3.2 的表；受阻时按原因分你与总管。offDuty 是此刻不在岗（停用、暂停、退役）的员工编号。 */
export function waitingOnOf(job: Job, names: Record<string, string>, offDuty: ReadonlySet<string> = NO_ONE, retired: ReadonlySet<string> = NO_ONE, launchWait: LaunchWait = {}): string | null {
  const executor = names[job.executorId] ?? '执行者';
  // P74r2b：提问已转成约定新版本、或执行者已做完照常的部分在等确认：在等主人（具体是第几版见延迟说明）。
  if (confirmWaitNo(job) !== null) return '你';
  switch (job.state) {
    case 'ready': case 'rework': return executor;
    case 'doing': return job.openAsk !== null ? '总管' : executor;
    case 'checking': return job.reviewerId === null ? '总管' : names[job.reviewerId] ?? '评审员';
    case 'awaiting_owner': return '你';
    case 'blocked': {
      const kind = job.blocked!.kind;
      // P74r16b：参与者被停用而受阻：在等的是被停用的这位员工（写「{名字}（已停用）」）；这时总管自己也不在岗，就只能等主人，写「你」。
      if (kind === 'participant_off') {
        const off = [job.executorId, job.reviewerId].find((id): id is string => id !== null && offDuty.has(id));
        // P74r17（低-5）：已归档的写「（已归档）」，其余不在岗的（停用、暂停）仍写「（已停用）」。
        if (off !== undefined) return offDuty.has(job.chiefId) ? '你' : `${names[off] ?? '员工'}${retired.has(off) ? '（已归档）' : '（已停用）'}`;
      }
      return kind === 'review_limit' || kind === 'turn_cap' || kind === 'owner_hold' ? '你' : '总管';
    }
    case 'done':
      if (job.launch.state === 'preparing') return executor;
      // P74r18b：发布审批已批准、命令还没运行完：在等中心，不再写「你」。
      if (job.launch.state === 'approval') return launchWait.running === true ? '中心运行发布命令' : '你';
      // 发布没有成功：执行者有带这件事的唤醒在排队或在跑，在等他；否则在等你。
      if (job.launch.state === 'failed') return launchWait.executorWaking === true ? executor : '你';
      return null;
    case 'stopped': return null;
  }
}

/** 进度行：完全由状态生成，不调用模型。约定已撤下（withdrawn）时没有进度行，返回 null。 */
export function jobProgressView(input: JobProgressInput): JobProgressView | null {
  const { agreementState, job, names, delayNote, timezone } = input;
  if (agreementState === 'withdrawn') return null;
  const base: StepLabel[] = ['对齐', '执行', '核对', '你验收'];

  // 1. 还没有这件事：约定待确认写「对齐中」（在等你），已固定但还没派活写「待开工」（在等总管）。
  if (job === null) {
    const aligning = agreementState === 'pending';
    return {
      steps: stepsAt(base, aligning ? 0 : 1, false),
      stateLabel: aligning ? ALIGNING_LABEL : JOB_STATE_LABELS.ready,
      stateTone: aligning ? 'you' : 'run',
      roundText: null, waitingOn: aligning ? '你' : '总管', delayNote,
      dueText: dueTextOf(null, timezone), pausedText: null,
    };
  }

  // 2. 有这件事：有发布步骤时五步，否则四步（裁定 17）。
  const labels: StepLabel[] = job.launchStep ? [...base, '发布'] : base;
  let steps: JobProgressView['steps'];
  let note = delayNote;
  // P74r13：状态小标签。界面把 delayNote 用括号接在「在等：{waitingOn}」后面显示，「暂不发布」时没有人在等（waitingOn 为空），
  // delayNote 没有地方显示，进度行上看不到「你暂不发布」。所以这时把这句话也写进状态小标签（界面一定显示「现在：{状态小标签}」），
  // 状态仍是已完成。delayNote 保持不变。
  let stateLabel: string = JOB_STATE_LABELS[job.state];
  switch (job.state) {
    case 'ready': case 'doing': case 'rework': steps = stepsAt(labels, 1, false); break;
    case 'checking': steps = stepsAt(labels, 2, false); break;
    case 'awaiting_owner': steps = stepsAt(labels, 3, false); break;
    case 'blocked': steps = stepsAt(labels, stepOfResume(job.blocked!.resumeTo), true); break;
    case 'stopped': steps = stepsAt(labels, stepOfStopped(job), true); break;
    case 'done':
      if (!job.launchStep || job.launch.state === 'done') steps = stepsAt(labels, labels.length, false);
      else if (job.launch.state === 'declined') {
        // 暂不发布：前四步完成，发布一步保持未到，并写明原因。
        // P74r7：主人自己点的写「你暂不发布」（旧数据没有 endedBy，按主人点的处理）；中心结束的写「没有发布」（主人没有做过这个决定）。
        steps = stepsAt(labels, labels.length, false).map(step => step.label === '发布' ? { ...step, state: 'todo' as const } : step);
        note = job.launch.endedBy === 'hub' ? '没有发布' : '你暂不发布';
        stateLabel = `${JOB_STATE_LABELS.done}（${note}）`;
      } else if (job.launch.state === 'failed') {
        // P74r18b：发布没有成功：前四步完成，发布一步不标为完成；状态小标签写明（界面一定显示「现在：{状态小标签}」）。
        steps = stepsAt(labels, labels.length, false).map(step => step.label === '发布' ? { ...step, state: 'todo' as const } : step);
        stateLabel = `${JOB_STATE_LABELS.done}（发布没有成功）`;
      } else steps = stepsAt(labels, 4, false); // none、preparing、approval：发布为当前
      break;
  }
  const checkingRound = job.state === 'checking' ? job.round : job.state === 'rework' ? Math.max(1, job.round) : null;
  return {
    steps,
    stateLabel,
    stateTone: JOB_STATE_TONES[job.state],
    roundText: checkingRound === null ? null : `第 ${checkingRound} 轮，共 ${D.REVIEW_ROUNDS_MAX} 轮`,
    waitingOn: waitingOnOf(job, names, input.offDuty, input.retired, input.launchWait),
    delayNote: note,
    dueText: dueTextOf(job.dueAt, timezone),
    pausedText: job.pause !== null && job.pause.paused.length > 0 ? `暂停：${job.pause.paused.join('、')}` : null,
  };
}

// ---------------------------------------------------------------------------
// 二、主题楼层与往来折叠
// ---------------------------------------------------------------------------

export interface TopicFloorsInput {
  /** 主题线程的消息，按时间升序。 */
  messages: ThreadMessage[];
  /** id → 名字，owner 对应「你」；hub 不放进名字表。 */
  names: Record<string, string>;
  /** 事件 id（jev_…）→ 发出者与接收者，工作往来的箭头据此写。 */
  events: Record<string, { actor: string; to: string[] }>;
  /** 交账 id → 发出者员工 id。 */
  commitSenders: Record<string, string>;
  /** 总管的员工 id：交账箭头「员工 → 总管」靠它判断发出者是不是总管。 */
  chiefId: string | null;
  timezone: string;
  /** 卡片消息的标题；P74d 会替换成准确的标题函数。缺省时交回卡写「交回卡」、核对卡写「核对卡」。 */
  cardTitleOf?: (message: ThreadMessage) => string;
  /** P74g 后：卡片消息（交回卡、核对卡）的接收者名字；缺省时卡片没有接收者。 */
  cardRecipientsOf?: (message: ThreadMessage) => string[];
  /** P75c：挂在某条消息下面的「已记住」；缺省或返回空时楼层不带 memoryNotes。 */
  memoryNotesOf?: (message: ThreadMessage) => MemoryNoteView[] | undefined;
}

/** 缺省的卡片标题：本卡只认交回卡和核对卡。 */
function defaultCardTitle(message: ThreadMessage): string {
  return message.refId?.startsWith('submission:') ? '交回卡' : message.refId?.startsWith('review:') ? '核对卡' : '';
}

/** 工作往来：work 消息，或交回卡、核对卡、复盘卡、核对技能卡；其余（主人的话、交付卡、回执、约定类旁白）是楼层。 */
function isWork(message: ThreadMessage): boolean {
  if (message.kind === 'work') return true;
  if (message.kind !== 'job_card') return false;
  if (message.refId?.startsWith('submission:') === true || message.refId?.startsWith('review:') === true) return true;
  // P75g：复盘卡（retro:）与技能核对卡（skillcheck:）也是员工之间的工作往来，进折叠组。
  return message.refId?.startsWith('retro:') === true || message.refId?.startsWith('skillcheck:') === true;
}

/** P75g：复盘类消息：复盘卡、核对卡的 job_card，或复盘小结的 work 消息（refId 以 retro-summary: 开头）。 */
export function isRetroMessage(message: ThreadMessage): boolean {
  if (message.kind === 'job_card') return message.refId?.startsWith('retro:') === true || message.refId?.startsWith('skillcheck:') === true;
  if (message.kind === 'work') return message.refId?.startsWith('retro-summary:') === true;
  return false;
}

/** 第一句：到第一个「。」「！」「？」或换行为止（含句末标点），最长 60 字，超出加「…」。 */
function firstSentence(text: string): string {
  const trimmed = text.trim();
  const chars = [...trimmed];
  const end = chars.findIndex(char => '。！？\n'.includes(char));
  const sentence = end === -1 ? chars : chars.slice(0, '\n' === chars[end] ? end : end + 1);
  return sentence.length > 60 ? `${sentence.slice(0, 60).join('')}…` : sentence.join('').trim();
}

/** 日期范围：同一天「M月D日」，跨天「M月D日至D日」，跨月（或跨年）「M月D日至M月D日」。 */
function rangeTextOf(from: number, to: number, timezone: string): string {
  const a = localParts(from, timezone);
  const b = localParts(to, timezone);
  if (a.year === b.year && a.month === b.month) {
    return a.day === b.day ? `${a.month}月${a.day}日` : `${a.month}月${a.day}日至${b.day}日`;
  }
  return `${a.month}月${a.day}日至${b.month}月${b.day}日`;
}

/** 主题楼层：连续的工作往来收成一组（默认收起），其余是楼层。 */
export function topicFloorsView(input: TopicFloorsInput): TopicFloorsView {
  const { messages, names, events, commitSenders, chiefId, timezone } = input;
  const cardTitleOf = input.cardTitleOf ?? defaultCardTitle;
  const nameOf = (id: string): string | null => id === 'hub' ? null : names[id] ?? (id === 'owner' ? '你' : '已删除的员工');
  const fromNameOf = (message: ThreadMessage): string => nameOf(message.from) ?? 'Agent 中心';

  /** 这条往来发给谁：事件 → 事件的接收者；交账 → 员工发出则为总管；其他为空。 */
  const toNamesOf = (message: ThreadMessage): string[] => {
    const ref = message.refId;
    if (message.kind === 'job_card') return input.cardRecipientsOf?.(message) ?? [];
    if (ref === null || message.kind !== 'work') return [];
    if (ref.startsWith('jev_')) {
      const event = events[ref];
      return event ? event.to.flatMap(id => { const name = nameOf(id); return name === null ? [] : [name]; }) : [];
    }
    const sender = commitSenders[ref];
    if (sender === undefined) return [];
    return sender === chiefId ? [] : ['总管'];
  };

  const items: TopicFloorsView['items'] = [];
  let group: ThreadMessage[] = [];
  /** 把攒着的连续往来收成一个折叠组。 */
  const flush = (): void => {
    if (group.length === 0) return;
    const participants: string[] = [];
    for (const message of group) {
      if (message.from === 'hub' || message.from === 'owner') continue; // 中心提示不算参与者
      const name = nameOf(message.from)!;
      if (!participants.includes(name)) participants.push(name);
    }
    const last = group[group.length - 1]!;
    const lastText = last.kind === 'job_card' ? cardTitleOf(last) : last.text;
    // P75g：一个折叠组的消息全部属于复盘类（复盘卡、核对卡、复盘小结）时，组标题写「复盘」；其他组没有这个字段。
    const allRetro = group.every(message => isRetroMessage(message));
    items.push({
      kind: 'fold', id: group[0]!.id, count: group.length, participants,
      rangeText: rangeTextOf(group[0]!.createdAt, last.createdAt, timezone),
      latest: firstSentence(lastText),
      messages: group.map(message => ({ message, fromName: fromNameOf(message), toNames: toNamesOf(message) })),
      ...(allRetro ? { label: '复盘' as const } : {}),
    });
    group = [];
  };
  for (const message of messages) {
    if (isWork(message)) group.push(message);
    else {
      flush();
      const notes = input.memoryNotesOf?.(message);
      items.push({ kind: 'floor', message, ...(notes !== undefined && notes.length > 0 ? { memoryNotes: notes } : {}) });
    }
  }
  flush();

  const total = messages.length;
  const work = messages.filter(isWork).length;
  return {
    countText: work === 0 ? `共 ${total} 条记录` : `共 ${total} 条记录：给你的 ${total - work} 条，员工之间的往来 ${work} 条（已收起）`,
    items,
  };
}

// ---------------------------------------------------------------------------
// 三、侧栏一行与项目页的一件事行
// ---------------------------------------------------------------------------

/**
 * 总管左栏一句的一行输入。
 * - 新写法（P76i）：「在办的事」的一行，只要 waitingOwner（这一行现在是不是在等你）；
 * - 旧写法：{ job, title }。旧调用（以及插件里的示例数据）只给了一件事的记录，没有「在等你」的信息，
 *   所以按「不在等你」算，已完成、已停止的不算在办。保留它是为了不改动既有调用，新代码一律传新写法。
 */
export type ChiefLineRow = { waitingOwner: boolean } | { job: Job; title: string };

/**
 * 总管员工行上的一句（P76i 改写）：没有在办的事为 null（沿用现有角色行）；
 * 否则 m 为在等你的件数：m 为 0 写「{n} 件在办」，否则写「{n} 件在办，{m} 件等你」。只有一件时也这样写。
 * 在办的口径（没收尾的事加待确认的约定）由调用方在「在办的事」里已经定好，这里只数。
 */
export function chiefJobLine(rows: readonly ChiefLineRow[], _now?: number): string | null {
  const active = rows.filter(row => 'waitingOwner' in row || (row.job.state !== 'done' && row.job.state !== 'stopped'));
  if (active.length === 0) return null;
  const waiting = active.filter(row => 'waitingOwner' in row && row.waitingOwner).length;
  return waiting === 0 ? `${active.length} 件在办` : `${active.length} 件在办，${waiting} 件等你`;
}

/** 排序档位：受阻、待你验收在前；已完成、已停止在最后；其余居中。 */
function rankOf(state: JobState): number {
  if (state === 'blocked' || state === 'awaiting_owner') return 0;
  return state === 'done' || state === 'stopped' ? 2 : 1;
}

/** 项目页的一件事行；timezone 用来写交付时间（任务卡未列出这个参数，见 docs/questions.md）。 */
export function projectJobRows(rows: { job: Job; title: string; executorName: string }[], timezone: string): ProjectJobRow[] {
  return [...rows]
    .sort((a, b) => rankOf(a.job.state) - rankOf(b.job.state) || b.job.updatedAt - a.job.updatedAt || a.job.id.localeCompare(b.job.id))
    .map(({ job, title, executorName }) => ({
      jobId: job.id, topicId: job.topicId, title, executorName,
      stateLabel: JOB_STATE_LABELS[job.state], stateTone: JOB_STATE_TONES[job.state],
      dueText: dueTextOf(job.dueAt, timezone),
    }));
}

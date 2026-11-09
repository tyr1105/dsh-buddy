/**
 * 项目任务状态机（纯函数，v2 计划 3.4 验收流程）。
 *
 * 为什么单独一个文件：任务能不能流转是规则，不应该和写存储、写审计混在一起。
 * 这里不读时钟、不读文件、不碰存储，同样的输入永远得到同样的输出，全部可单测。
 *
 * 规则（与 v2 计划 3.4「验收流程」逐条对应）：
 * - 执行者侧只能：todo→doing（开始）、doing→blocked（受阻）、blocked→doing（恢复）、
 *   doing→done_pending_check（交账，执行者说完成只到待验收）；
 * - done_pending_check 只能由主人的验收动作离开：accept→accepted、reject→rejected；
 * - 驳回必须填理由；驳回结论记审计后由服务层把任务落回 doing（rejected→doing 是内部回流）；
 * - accepted 是终态，不能再改（归档项目也不能改任务，那一条在服务层拦）。
 */
import type { TaskStatus } from '../model/project.js';
import { TASK_STATUS_LABELS } from '../model/project.js';

/** 驳回理由长度上限；服务层 zod 入参与状态机判定共用这一个数。 */
export const TASK_REJECT_REASON_MAX = 500;

/** 转移判定的附加信息：驳回时必须带理由。 */
export interface TransitionOptions {
  rejectReason?: string | null;
}

/** 结果对象：成功无正文，失败带一条说清哪一步不对的中文原因。 */
export type TransitionResult = { ok: true } | { ok: false; error: string };

/**
 * 全部合法转移（含 rejected→doing 内部回流）。
 * 注意 done_pending_check→rejected 还要求理由非空，合法性见 explainTransition。
 */
export const LEGAL_TASK_TRANSITIONS: ReadonlyArray<{ from: TaskStatus; to: TaskStatus }> = [
  { from: 'todo', to: 'doing' },
  { from: 'doing', to: 'blocked' },
  { from: 'blocked', to: 'doing' },
  { from: 'doing', to: 'done_pending_check' },
  { from: 'done_pending_check', to: 'accepted' },
  { from: 'done_pending_check', to: 'rejected' },
  { from: 'rejected', to: 'doing' },
];

/** 语义动作名，供服务层把命令意图映射成目标状态，避免调用方裸写状态字符串。 */
export type TaskAction = 'start' | 'block' | 'resume' | 'report_done' | 'accept' | 'reject' | 'rework';

/** 动作中文名，用于非法调用时的中文报错。 */
export const TASK_ACTION_LABELS: Record<TaskAction, string> = {
  start: '开始任务',
  block: '标记受阻',
  resume: '恢复任务',
  report_done: '交账待验收',
  accept: '验收通过',
  reject: '驳回',
  rework: '驳回后回流进行中',
};

const ACTION_TARGET: Record<TaskAction, { from: TaskStatus; to: TaskStatus }> = {
  start: { from: 'todo', to: 'doing' },
  block: { from: 'doing', to: 'blocked' },
  resume: { from: 'blocked', to: 'doing' },
  report_done: { from: 'doing', to: 'done_pending_check' },
  accept: { from: 'done_pending_check', to: 'accepted' },
  reject: { from: 'done_pending_check', to: 'rejected' },
  // 服务层专用：驳回结论落审计后，把任务从瞬时驳回结论回流到进行中。
  rework: { from: 'rejected', to: 'doing' },
};

/** 转移是否合法；只需要布尔口径的调用方（界面按钮置灰）用它。 */
export function canTransition(from: TaskStatus, to: TaskStatus, options: TransitionOptions = {}): boolean {
  return explainTransition(from, to, options) === null;
}

/**
 * 判定一次转移是否允许；返回 null 表示允许，否则返回一条中文原因。
 * 每个非法转移都给具体原因，而不是笼统的「状态不允许」，方便主人和队友知道差在哪一步。
 */
export function explainTransition(from: TaskStatus, to: TaskStatus, options: TransitionOptions = {}): string | null {
  if (from === to) {
    return `任务已经是「${TASK_STATUS_LABELS[from]}」状态，不能重复转移`;
  }
  // accepted 终态：任何出口都拒绝。
  if (from === 'accepted') {
    return `任务已通过验收（${TASK_STATUS_LABELS.accepted}），是终态，不能再改状态`;
  }
  const label = TASK_STATUS_LABELS[to];
  switch (from) {
    case 'todo':
      if (to === 'doing') break;
      return `待办任务要先开始（todo→doing），不能直接转到「${label}」`;
    case 'blocked':
      if (to === 'doing') break;
      return `受阻任务要先恢复为进行中（blocked→doing），不能直接转到「${label}」`;
    case 'doing':
      if (to === 'blocked' || to === 'done_pending_check') break;
      if (to === 'todo') return '进行中的任务不能退回待办，如确认不做请由主人在项目页处理';
      if (to === 'accepted') return '任务必须先交账到待验收，再由主人验收通过，不能直接标记已通过';
      return `进行中的任务只能标记受阻或交账待验收，不能转到「${label}」`;
    case 'done_pending_check':
      if (to === 'accepted' || to === 'rejected') break;
      return `待验收任务只能由主人通过（→已通过）或驳回（→已驳回），不能转到「${label}」`;
    case 'rejected':
      if (to === 'doing') break;
      return `已驳回的任务只能回到进行中（rejected→doing）继续修改，不能转到「${label}」`;
    default:
      return `不认识的任务状态：${from satisfies never}`;
  }
  // 驳回是唯一带附加条件的合法边：理由必填且有长度上限，防止「无理由驳回」。
  if (to === 'rejected') {
    const reason = (options.rejectReason ?? '').trim();
    if (reason.length === 0) return '驳回必须填写理由（1–500 字），说明哪里不行、要怎么改';
    if (reason.length > TASK_REJECT_REASON_MAX) return `驳回理由不能超过 ${TASK_REJECT_REASON_MAX} 字，当前 ${reason.length} 字`;
  }
  return null;
}

/** 对象形式的判定，便于调用方在错误时直接拿 error 文案。 */
export function checkTransition(from: TaskStatus, to: TaskStatus, options: TransitionOptions = {}): TransitionResult {
  const error = explainTransition(from, to, options);
  return error === null ? { ok: true } : { ok: false, error };
}

/**
 * 按下一个语义动作求目标状态；动作在当前状态下不合法时抛中文错误。
 * reject 的理由在动作这一层就校验，服务层不允许绕过状态机直接 patch 状态字段。
 */
export function nextStatus(from: TaskStatus, action: TaskAction, options: TransitionOptions = {}): TaskStatus {
  const edge = ACTION_TARGET[action];
  // accepted 是终态：任何动作都先给终态原因，而不是笼统的「动作起点不对」，与服务层「终态不可改」口径一致。
  if (from === 'accepted') {
    throw new Error(`任务已通过验收（${TASK_STATUS_LABELS.accepted}），是终态，不能再改状态`);
  }
  // 动作的起点必须与任务当前状态一致（例如「标记受阻」只能发生在进行中）。
  if (edge.from !== from) {
    throw new Error(`任务当前是「${TASK_STATUS_LABELS[from]}」，「${TASK_ACTION_LABELS[action]}」只能从「${TASK_STATUS_LABELS[edge.from]}」发起`);
  }
  const error = explainTransition(from, edge.to, options);
  if (error !== null) throw new Error(error);
  return edge.to;
}

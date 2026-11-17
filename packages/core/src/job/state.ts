/**
 * 一件事的状态机（P74a，纯函数）。
 *
 * 为什么单独成文件：状态怎样流转是整个「派活、把关、交付」的骨架，所有入口（工具、界面按钮、定时兜底）
 * 都必须走同一个函数，才不会出现「某条路径能绕过核对直接完成」的情况（方案 6.5）。
 * 本文件不读存储、不读时钟：时间由调用方显式传入 now；不合法的动作抛出中文错误，
 * 说清当前状态和这个动作只能从哪些状态发起。「已完成」只能由主人验收（owner_accept）产生。
 */
import { JOB_DEFAULTS as D } from '../config/defaults.js';
import { JOB_STATE_LABELS, type Job, type JobBlockKind, type JobState, type JobUnmet } from '../model/job.js';

/** 动作清单：带参数的动作把参数放在同一个对象里，调用方不用另外传。 */
export type JobAction =
  | { type: 'start' }
  | { type: 'submit' }
  | { type: 'review_pass' }
  | { type: 'review_fail'; unmet: JobUnmet[] }
  | { type: 'review_limit'; no: number | null; text: string }
  | { type: 'owner_accept' }
  | { type: 'owner_return'; unmet: JobUnmet[] }
  | { type: 'block'; kind: Extract<JobBlockKind, 'executor' | 'turn_cap' | 'participant_off'>; no: number | null; text: string }
  | { type: 'unblock' }
  | { type: 'hold' }
  | { type: 'option_recheck' }
  | { type: 'option_deliver' }
  // P74r6：离开三轮不过（或由它转成的暂停）的受阻、回到执行者或核对人手里：一律进入新的一个阶段（阶段加 1）。
  // to 为 rework：返工中、轮数归零、写入待改条目；to 为 checking：核对中、第 1 轮。所有出口共用这一个动作。
  | { type: 'review_limit_exit'; to: 'rework'; unmet: JobUnmet[] }
  | { type: 'review_limit_exit'; to: 'checking' }
  // P74e：主人确认的新版约定改了「怎样算做完」，已交回或已交付的内容是按旧版本做的，只把改到的条目退回返工（新阶段，轮数归零）。
  | { type: 'version_rework'; unmet: JobUnmet[] }
  | { type: 'stop' };
export type JobActionType = JobAction['type'];

/** 动作的中文名，错误信息里用。 */
export const JOB_ACTION_LABELS: Record<JobActionType, string> = {
  start: '开工', submit: '交回', review_pass: '核对通过', review_fail: '核对退回', review_limit: '三轮不过',
  owner_accept: '验收通过', owner_return: '指出不符', block: '标记受阻', unblock: '解除受阻', hold: '暂停',
  option_recheck: '选办法后重新核对', option_deliver: '选办法后直接交付', review_limit_exit: '三轮不过后进入新阶段',
  version_rework: '新版约定返工', stop: '停止',
};

/** 每个动作允许的起点状态。 */
const FROM: Record<JobActionType, readonly JobState[]> = {
  start: ['ready'],
  submit: ['doing', 'rework'],
  review_pass: ['checking'],
  review_fail: ['checking'],
  review_limit: ['checking'],
  owner_accept: ['awaiting_owner'],
  owner_return: ['awaiting_owner'],
  block: ['ready', 'doing', 'checking', 'rework'],
  unblock: ['blocked'],
  hold: ['blocked'],
  option_recheck: ['blocked'],
  option_deliver: ['blocked'],
  review_limit_exit: ['blocked'],
  version_rework: ['checking', 'awaiting_owner'],
  stop: ['ready', 'doing', 'checking', 'rework', 'awaiting_owner', 'blocked'],
};

/** 允许受阻的原因：核对三轮不过由 review_limit 产生，owner_hold 由 hold 产生，都不能直接 block。 */
const BLOCKABLE_KINDS: readonly JobBlockKind[] = ['executor', 'turn_cap', 'participant_off'];

/** 状态机主函数：返回新的一件事（不改入参）；updatedAt 一律更新为 now。 */
export function applyJobAction(job: Job, action: JobAction, now: number): Job {
  // 终态：done、stopped 不接受任何动作。
  if (job.state === 'done' || job.state === 'stopped') {
    // 状态词本身已带「已」（已完成、已停止），不再重复加。
    throw new Error(`这件事${JOB_STATE_LABELS[job.state]}，不能再改状态`);
  }
  const allowed = FROM[action.type];
  if (!allowed.includes(job.state)) {
    throw new Error(`这件事当前是「${JOB_STATE_LABELS[job.state]}」，「${JOB_ACTION_LABELS[action.type]}」只能从「${allowed.map(state => JOB_STATE_LABELS[state]).join('、')}」发起`);
  }
  const base: Job = { ...job, updatedAt: now };
  switch (action.type) {
    case 'start':
      return { ...base, state: 'doing', startedAt: now };
    case 'submit':
      // 本阶段的轮数用满后不能再交回：应当已经走了三轮不过。
      if (job.round >= D.REVIEW_ROUNDS_MAX) throw new Error(`本阶段已经交回 ${job.round} 轮，达到上限 ${D.REVIEW_ROUNDS_MAX} 轮，不能再交回`);
      return { ...base, state: 'checking', round: job.round + 1, unmet: [] };
    case 'review_pass':
      return { ...base, state: 'awaiting_owner', deliveredAt: now };
    case 'review_fail':
      if (job.round >= D.REVIEW_ROUNDS_MAX) throw new Error(`本阶段已经是第 ${job.round} 轮（上限 ${D.REVIEW_ROUNDS_MAX} 轮），不符只能走「三轮不过」`);
      if (action.unmet.length === 0) throw new Error('核对退回必须写明至少一条不符的条目');
      return { ...base, state: 'rework', unmet: action.unmet.map(item => ({ ...item })) };
    case 'review_limit':
      if (job.round < D.REVIEW_ROUNDS_MAX) throw new Error(`本阶段才交回 ${job.round} 轮（上限 ${D.REVIEW_ROUNDS_MAX} 轮），不符应当退回返工，不能算三轮不过`);
      return { ...base, state: 'blocked',
        blocked: { kind: 'review_limit', no: action.no, text: action.text, since: now, resumeTo: 'rework' } };
    case 'owner_accept':
      return { ...base, state: 'done', acceptedAt: now };
    case 'owner_return':
      if (action.unmet.length === 0) throw new Error('指出不符必须写明至少一条不符的条目');
      return { ...base, state: 'rework', stage: job.stage + 1, round: 0, unmet: action.unmet.map(item => ({ ...item })) };
    case 'block':
      if (!BLOCKABLE_KINDS.includes(action.kind)) throw new Error(`受阻原因「${action.kind}」不能直接标记，只能是 ${BLOCKABLE_KINDS.join('、')}`);
      return { ...base, state: 'blocked',
        blocked: { kind: action.kind, no: action.no, text: action.text, since: now, resumeTo: job.state as 'ready' | 'doing' | 'checking' | 'rework' } };
    case 'unblock':
      // P74r6：三轮不过的受阻回不到「本阶段第 3 轮」的返工中（交回会被拒、只能停止）：只能走 review_limit_exit 进入新阶段。
      if (job.blocked!.kind === 'review_limit') throw new Error('核对三轮不过的受阻不能直接解除，要进入新的一个阶段（review_limit_exit）');
      return { ...base, state: job.blocked!.resumeTo, blocked: null };
    case 'review_limit_exit':
      if (action.to === 'rework' && action.unmet.length === 0) throw new Error('进入新阶段返工必须写明至少一条要改的条目');
      return { ...base, state: action.to, stage: job.stage + 1, round: action.to === 'rework' ? 0 : 1, blocked: null,
        unmet: action.to === 'rework' ? action.unmet.map(item => ({ ...item })) : [] };
    case 'hold':
      // 「先停下」只对回合用到上限的受阻有意义：其他受阻原因本来就在等人处理。
      if (job.blocked!.kind !== 'turn_cap') throw new Error('只有「回合用到上限」的受阻才能选择暂停');
      return { ...base, blocked: { ...job.blocked!, kind: 'owner_hold' } };
    // 说明：review_limit_exit 的待改条目由 job/review-limit-exit.ts 从最近一次核对里取。
    case 'option_recheck':
      return { ...base, state: 'checking', stage: job.stage + 1, round: 1, blocked: null };
    case 'option_deliver':
      return { ...base, state: 'awaiting_owner', stage: job.stage + 1, round: 1, deliveredAt: now, blocked: null };
    case 'version_rework':
      if (action.unmet.length === 0) throw new Error('新版约定返工必须写明至少一条被改到的条目');
      // 附带变化同 owner_return：阶段加 1、轮数归零、写入待改条目。
      return { ...base, state: 'rework', stage: job.stage + 1, round: 0, unmet: action.unmet.map(item => ({ ...item })) };
    case 'stop':
      return { ...base, state: 'stopped', stoppedAt: now, blocked: null };
  }
}

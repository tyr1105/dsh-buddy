/**
 * 约定固定了新版本之后，按这件事「实际所处的环节」处理被改到的条目（P74r3，H2，纯函数）。
 *
 * 为什么需要：约定固定后的收尾原来只看这件事当时的状态。受阻时（例如核对中评审员停用），这件事实际所处的环节
 * 是「解除受阻后要回到的状态」（blocked.resumeTo）；收尾什么都没做却记下「已处理到这一版」，评审员恢复在岗之后，
 * 这件事按旧交回核对通过，被改写的条目从没重做。
 *
 * 做法：实际所处的环节 = 不受阻时取当前状态，受阻时取 resumeTo。
 * - 实际在核对中（或待你验收），有新增或改写的条目：不受阻时退回返工（原有动作 version_rework）；
 *   受阻时把 resumeTo 改成返工中并写好待改清单，仍然受阻、受阻原因不变，解除之后进入返工，叫醒的是执行者；
 * - 实际在返工中：把新增、改写的条目并入待改清单；
 * - 实际在待开工、执行中：不用处理（第一轮本来就要全部交回）。
 * 只有删去的情形不在这里：核对中由 agreement-hooks 重排最近一次交回（见 item-remap.ts），受阻时也现在就重排。
 *
 * P74f 处理「待你验收」和它新增的解除受阻路径时，直接调用本文件的 effectiveStateOf 和 reworkForVersion，不要另写一套。
 * 本文件不读存储、不碰时钟：时间由调用方传入。
 */
import type { Job, JobState, JobUnmet } from '../model/job.js';
import { applyJobAction } from './state.js';

/** 这件事实际所处的环节：不受阻就是当前状态；受阻时是解除受阻后要回到的状态。 */
export function effectiveStateOf(job: Pick<Job, 'state' | 'blocked'>): JobState {
  return job.state === 'blocked' && job.blocked !== null ? job.blocked.resumeTo : job.state;
}

/**
 * 卡在核对环节：受阻原因是「执行者」，且核对人没有动静（解除受阻要换核对人）。
 * 解除后要回到核对中，或虽然改成了返工中、但卡住的仍是核对人（stalledAtReview），都算。
 */
export function reviewStalled(job: Pick<Job, 'state' | 'blocked'>): boolean {
  return job.state === 'blocked' && job.blocked !== null && job.blocked.kind === 'executor'
    && (job.blocked.resumeTo === 'checking' || job.blocked.stalledAtReview === true);
}

/** 处理的结果：job 是改完的一件事；how 说明做了什么。 */
export interface VersionRework {
  job: Job;
  /**
   * now：现在就退回返工了（执行者该被叫醒）；
   * after_unblock：受阻，已把解除后要回到的状态改成返工中，解除之后才返工（现在不叫任何人）；
   * merged：已在返工中（或受阻后要回到返工中），待改条目并入了清单；
   * none：这个环节不用处理。
   */
  how: 'now' | 'after_unblock' | 'merged' | 'none';
}

/**
 * 把「新版本里新增或改写的条目」（unmetNew，每条写明新序号和改成什么）按实际所处的环节处理，返回改完的一件事。
 * 不含收尾里的其他字段（暂停、已处理到第几版等由调用方写）；unmetNew 为空时什么都不做。
 */
export function reworkForVersion(job: Job, unmetNew: JobUnmet[], now: number): VersionRework {
  if (unmetNew.length === 0) return { job, how: 'none' };
  const nos = unmetNew.map(item => item.no);
  // 返工中（含受阻后要回到返工中）：同序号的换成新的说明，其余沿用，按序号排。
  const mergeInto = (base: Job): Job => ({ ...base, unmet: [...base.unmet.filter(item => !nos.includes(item.no)), ...unmetNew].sort((a, b) => a.no - b.no) });
  const stage = effectiveStateOf(job);
  if (job.state === 'blocked' && job.blocked !== null) {
    if (stage === 'checking') {
      // 受阻、解除后回核对中：改成解除后回返工中，阶段加 1、轮数归零（与不受阻时的 version_rework 一致），仍然受阻。
      const stalled = job.blocked.kind === 'executor' ? { stalledAtReview: true } : {};
      return { how: 'after_unblock', job: { ...job, updatedAt: now, stage: job.stage + 1, round: 0, unmet: unmetNew.map(item => ({ ...item })),
        blocked: { ...job.blocked, resumeTo: 'rework', ...stalled } } };
    }
    if (stage === 'rework') return { how: 'merged', job: mergeInto(job) };
    return { job, how: 'none' };
  }
  if (job.state === 'checking' || job.state === 'awaiting_owner') return { how: 'now', job: applyJobAction(job, { type: 'version_rework', unmet: unmetNew }, now) };
  if (job.state === 'rework') return { how: 'merged', job: mergeInto(job) };
  return { job, how: 'none' };
}

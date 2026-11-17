/**
 * 一件事的余下份额（P76f，方案 7.5）：按这件事此刻的状态，算出「还要用几个回合」，和已用的相加得到预计总数。
 *
 * 为什么要算：预算线（Job.turnCap）是预计总数减去对齐已用的回合。照计划进行时，已用加余下正好等于预算线；
 * 只有某一步用超了（执行多用、返工用掉了预留、核对多轮、总管多回答问题），已用加余下才会大于预算线。
 * 大于的那一刻就问主人一次（budget-ask.ts），不必等到真的用完才停。
 *
 * 余下份额按状态取（方案 7.5 的表）：
 * - 待开工、执行中且待改清单为空：max(1, 预计执行 - 已用执行) + 1（核对）+ 剩余返工预留 + 剩余总管预留；
 * - 核对中：1（核对）+ 剩余返工预留 + 剩余总管预留；
 * - 返工中，或执行中且待改清单不为空：1（返工）+ 1（再核对）+ max(0, 剩余返工预留 - 2) + 剩余总管预留；
 * - 待你验收：剩余返工预留 + 剩余总管预留；
 * - 受阻、已完成、已停止：不算（返回 null）。
 * 剩余返工预留 = max(0, 预计返工 - 已用返工)；剩余总管预留 = max(0, 预计总管 - 已用总管)。
 *
 * 纯函数：输入这件事、它的用量行、当前生效的预计，不读存储、不读时钟。
 */
import type { EstimateVersion, JobUsage } from '../model/budget.js';
import type { Job } from '../model/job.js';
import { inLaunchPhase } from './launch-turns.js';

/** projectJob 的结果。 */
export interface BudgetProjection {
  /** 执行链已用的回合数（执行、核对、返工、总管四步，不含对齐、不含发布）。 */
  used: number;
  /** 照这件事此刻的状态，还要用几个回合。 */
  remaining: number;
  /** 预计总共要用几个回合（不含对齐、不含发布）：已用加余下。 */
  projected: number;
  /** 预算线。 */
  cap: number;
  /** 超出预计的原因（按顺序，成立的才列），给主人看的短句。 */
  reasons: string[];
}

/** 执行链四步已用的回合数合计（不含对齐、不含发布）。 */
export function usedTurnsOf(usage: Pick<JobUsage, 'steps'>): number {
  const { exec, review, rework, chief } = usage.steps;
  return exec.turns + review.turns + rework.turns + chief.turns;
}

/**
 * 超出预计的原因，按顺序列出成立的（给主人看，不含内部名称）：
 * 执行多用、返工超出预留、核对轮数超出预计、总管回答问题多用；P76r3（R7）再加两种「正好用满预计但还没有结果」：
 * 执行已用满预计、这件事仍在执行中且没有待改的条目；核对已用满预计、这件事仍在核对中；
 * P84（K7）再加一种：返工中，或执行中且待改清单不为空，还没有交回。
 * token 不在这里，数量写法由调用方决定。job 省略时只算原来的四种。
 */
export function overrunReasons(usage: Pick<JobUsage, 'steps'>, estimate: Pick<EstimateVersion, 'steps'>,
  job?: Pick<Job, 'state' | 'unmet'>): string[] {
  const reasons: string[] = [];
  const used = usage.steps;
  if (used.exec.turns > estimate.steps.exec) reasons.push(`执行多用 ${used.exec.turns - estimate.steps.exec} 回合`);
  if (used.rework.turns > estimate.steps.rework) reasons.push(`返工 ${used.rework.turns} 次，超出返工预留`);
  if (used.review.turns > estimate.steps.review) reasons.push(`核对 ${used.review.turns} 轮`);
  if (used.chief.turns > estimate.steps.chief) reasons.push(`总管回答问题多用 ${used.chief.turns - estimate.steps.chief} 回合`);
  if (job !== undefined) {
    // 正好用满执行、还在做、没有待改的条目：接着做就是超出，原因按事实写，不写「已用到预计的回合数」。
    if (job.state === 'doing' && job.unmet.length === 0 && used.exec.turns === estimate.steps.exec) {
      reasons.push(`执行已用满预计的 ${estimate.steps.exec} 回合，还没有交回`);
    }
    if (job.state === 'checking' && used.review.turns === estimate.steps.review) {
      reasons.push(`核对已用满预计的 ${estimate.steps.review} 回合，还没有结论`);
    }
    // P84（K7）：返工中，或执行中且待改清单不为空，还没有交回：余下份额按「返工加再核对」算，原因按事实写（句式与上面两句一致）。
    // 主会话裁定：返工已用 0 回合时不写（读起来别扭），落到兜底句。
    if ((job.state === 'rework' || (job.state === 'doing' && job.unmet.length > 0)) && used.rework.turns >= 1) {
      reasons.push(`返工已用 ${used.rework.turns} 回合，还没有交回`);
    }
  }
  return reasons;
}

/** 这件事此刻还要用几个回合；不算的状态（受阻、已完成、已停止、发布环节）返回 null。 */
function remainingOf(job: Job, usage: Pick<JobUsage, 'steps'>, estimate: Pick<EstimateVersion, 'steps'>): number | null {
  const leftRework = Math.max(0, estimate.steps.rework - usage.steps.rework.turns);
  const leftChief = Math.max(0, estimate.steps.chief - usage.steps.chief.turns);
  switch (job.state) {
    case 'ready':
      return Math.max(1, estimate.steps.exec - usage.steps.exec.turns) + 1 + leftRework + leftChief;
    case 'doing':
      // 待改清单不为空：执行者正在改返工的条目，按返工算。
      if (job.unmet.length > 0) return 1 + 1 + Math.max(0, leftRework - 2) + leftChief;
      return Math.max(1, estimate.steps.exec - usage.steps.exec.turns) + 1 + leftRework + leftChief;
    case 'checking':
      return 1 + leftRework + leftChief;
    case 'rework':
      return 1 + 1 + Math.max(0, leftRework - 2) + leftChief;
    case 'awaiting_owner':
      return leftRework + leftChief;
    default:
      return null;
  }
}

/**
 * 算这件事的余下份额与预计总数。
 * 没有预计（旧数据）、这件事不在会消耗执行链回合的状态、已验收进入发布环节，一律返回 null：旧数据不问，发布有自己的回合上限。
 */
export function projectJob(job: Job, usage: Pick<JobUsage, 'steps'>, estimate: EstimateVersion | null): BudgetProjection | null {
  if (estimate === null) return null;
  // 已验收、在发布环节：发布这一步有自己的回合上限，不问预计消耗。
  if (inLaunchPhase(job)) return null;
  const remaining = remainingOf(job, usage, estimate);
  if (remaining === null) return null;
  const used = usedTurnsOf(usage);
  return { used, remaining, projected: used + remaining, cap: job.turnCap, reasons: overrunReasons(usage, estimate, job) };
}

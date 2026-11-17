/**
 * 一件事的预计消耗（P76e，第五块）：约定每提交一版、第一次固定时，由中心按规则算出，不调用模型。
 *
 * 规则（方案 7.4）：
 * - 同类记录（同一类别、已验收、已定稿）不少于 HISTORY_MIN 件：执行、核对、返工、总管各取同类记录里该步回合数的中位数；
 *   否则用默认份额（执行 3、核对 1、返工预留 3、总管 1）。
 * - 总数 = 对齐已用 + 执行 + 核对 + 返工 + 总管（发布另计，不在其中）。
 * - token 区间：每一步每个回合的实测 token 样本不少于 TOKEN_SAMPLE_MIN 个时取最小、最大，否则用默认区间；
 *   对齐用的是已经发生的实测数，不是预计。
 *
 * 结果只存旁表 jobEstimates（每个约定版本一项），不改约定的结构。
 * estimateJob 是纯函数（输入显式给出）；estimateFor 读存储凑输入、写表；latestEstimate、displayEstimate 是读取。
 */
import { BUDGET_DEFAULTS as D } from '../config/defaults.js';
import type { HubContext } from '../engine/context.js';
import { launchOf, type Agreement, type AgreementVersion } from '../model/agreement.js';
import { JobEstimateSchema, type EstimateVersion, type JobEstimate, type JobUsage, type UsageStep } from '../model/budget.js';
import { agreementCategory } from '../project/agreement-category.js';
import { jobOfAgreement, isJobClosed } from './store.js';
import { alignmentOf } from './usage.js';

type EstimateReason = EstimateVersion['reason'];

/** estimateJob 的输入。 */
export interface EstimateInput {
  /** 这件事有没有单独的核对人（没有时由总管核对）。只影响给主人看的文字，不改数字：每轮核对都是 REVIEW_PER_ROUND 回合。 */
  hasReviewer: boolean;
  /** 约定有没有对外发布这一步。发布另计，不改数字。 */
  hasLaunch: boolean;
  /** 对齐已用的回合数和实测 token。 */
  align: { turns: number; tokens: number };
  /** 同类记录：已定稿、同类别、已验收，按验收时间倒序，最多 HISTORY_TAKE 件；由调用方筛选。 */
  history: JobUsage[];
  /** 同类别已定稿记录里各步每个回合的实测 token。 */
  turnSamples: Partial<Record<UsageStep, number[]>>;
  /** 这一项属于约定第几版、为什么算、什么时候算（写进结果）。 */
  versionNo: number;
  reason: EstimateReason;
  createdAt: number;
}

/** 中位数：偶数个取中间两数的平均；没有数据时为 0。 */
export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** 预计里参与 token 区间的四步。 */
const ESTIMATED_STEPS = ['exec', 'review', 'rework', 'chief'] as const;

/** 算一项预计（纯函数）。 */
export function estimateJob(input: EstimateInput): EstimateVersion {
  const useHistory = input.history.length >= D.HISTORY_MIN;
  const steps = useHistory ? {
    align: input.align.turns,
    exec: Math.max(1, Math.ceil(median(input.history.map(row => row.steps.exec.turns)))),
    review: Math.max(1, Math.ceil(median(input.history.map(row => row.steps.review.turns)))),
    // 返工预留：中位数加 1，最少 1，不超过默认的预留（往大了估没有意义，用不上的本来就不消耗）。
    rework: Math.max(1, Math.min(D.REWORK_RESERVE_DEFAULT, Math.ceil(median(input.history.map(row => row.steps.rework.turns))) + 1)),
    chief: Math.ceil(median(input.history.map(row => row.steps.chief.turns))),
  } : {
    align: input.align.turns, exec: D.EXEC_DEFAULT, review: D.REVIEW_PER_ROUND, rework: D.REWORK_RESERVE_DEFAULT, chief: D.CHIEF_RESERVE_DEFAULT,
  };
  let tokenLow = input.align.tokens;
  let tokenHigh = input.align.tokens;
  for (const step of ESTIMATED_STEPS) {
    const samples = input.turnSamples[step] ?? [];
    const [lo, hi] = samples.length >= D.TOKEN_SAMPLE_MIN ? [Math.min(...samples), Math.max(...samples)] : D.TOKENS_PER_TURN_DEFAULT[step];
    tokenLow += steps[step] * lo;
    tokenHigh += steps[step] * hi;
  }
  return {
    versionNo: input.versionNo, total: steps.align + steps.exec + steps.review + steps.rework + steps.chief, steps,
    tokenLow, tokenHigh, basis: useHistory ? 'history' : 'default', historyCount: useHistory ? input.history.length : 0,
    reason: input.reason, createdAt: input.createdAt,
  };
}

/**
 * 同类记录：同一类别、已定稿、这件事确实验收通过（停止的不算）；按验收时间倒序取最近 HISTORY_TAKE 件。
 * 各步每个回合的实测 token 样本取自这几件里已经记过账的回合（对齐与发布不参与预计）。
 */
export function historyFor(ctx: HubContext, category: string): { history: JobUsage[]; turnSamples: Partial<Record<UsageStep, number[]>> } {
  const accepted = new Map<string, number>();
  const rows = ctx.store.table('jobUsage').list(row => {
    if (row.finalizedAt === null || row.category !== category) return false;
    const job = ctx.store.table('jobs').get(row.id);
    if (job === null || job.state !== 'done' || job.acceptedAt === null) return false;
    accepted.set(row.id, job.acceptedAt);
    return true;
  }).sort((a, b) => accepted.get(b.id)! - accepted.get(a.id)!).slice(0, D.HISTORY_TAKE);
  const turnSamples: Partial<Record<UsageStep, number[]>> = {};
  for (const row of rows) {
    for (const turn of row.turns) {
      if (turn.endedAt === null) continue;
      (turnSamples[turn.step] ??= []).push(turn.tokens);
    }
  }
  return { history: rows, turnSamples };
}

/**
 * 给约定的某一版算预计并写进旁表（draft：提交新版本；lock：第一次固定）。
 * 同一版已有 draft 项时，lock 替换它；其余追加（同一版同一原因再算一次时替换，不重复）。出错由调用方接住记日志。
 * 对齐已用按约定当前全部版本的唤醒单现算（alignmentOf），所以 draft 里的对齐已包含这一版自己的那一回合。
 */
export function estimateFor(ctx: HubContext, agreementId: string, versionNo: number, reason: EstimateReason): EstimateVersion {
  const agreement = ctx.store.table('agreements').get(agreementId);
  if (agreement === null) throw new Error('预计消耗：没有这份约定');
  const version = agreement.versions.find(row => row.no === versionNo);
  if (version === undefined) throw new Error(`预计消耗：约定没有第 ${versionNo} 版`);
  const { history, turnSamples } = historyFor(ctx, agreementCategory(ctx, agreementId));
  const job = jobOfAgreement(ctx, agreementId);
  const next = estimateJob({
    hasReviewer: job !== null && job.reviewerId !== null, hasLaunch: launchOf(version.content) !== null,
    align: alignmentOf(ctx, agreement), history, turnSamples, versionNo, reason, createdAt: ctx.clock.now(),
  });
  const existing = ctx.store.table('jobEstimates').get(agreementId);
  const versions = existing?.versions ?? [];
  // lock 替换同一版的 draft；同一版同一原因已有一项时也替换；其余追加。
  const at = versions.findIndex(row => row.versionNo === versionNo && (row.reason === reason || (reason === 'lock' && row.reason === 'draft')));
  const merged = at === -1 ? [...versions, next] : versions.map((row, index) => index === at ? next : row);
  ctx.store.table('jobEstimates').put(JobEstimateSchema.parse({ id: agreementId, versions: merged } satisfies JobEstimate));
  return next;
}

/**
 * 追加一项预计（P76f：你追加回合、缩小范围的新版本固定时）：只追加，已有的项不动。
 * 返回撤销函数（把这份约定的预计原样写回；原来没有记录时删去），答复条目的「带备份的一次写入」用它。
 */
export function appendEstimateVersion(ctx: HubContext, agreementId: string, version: EstimateVersion): () => void {
  const before = ctx.store.table('jobEstimates').get(agreementId);
  ctx.store.table('jobEstimates').put(JobEstimateSchema.parse({ id: agreementId, versions: [...(before?.versions ?? []), version] } satisfies JobEstimate));
  return () => {
    if (before === null) ctx.store.table('jobEstimates').remove(agreementId);
    else ctx.store.table('jobEstimates').put(before);
  };
}

/** 这份约定最新的非 draft 预计（锁定、追加、缩小范围算出的）：派活的预算线和回执读它；没有为 null。 */
export function latestEstimate(ctx: HubContext, agreementId: string): EstimateVersion | null {
  const rows = (ctx.store.table('jobEstimates').get(agreementId)?.versions ?? []).filter(row => row.reason !== 'draft');
  if (rows.length === 0) return null;
  return rows.reduce((best, row) => (row.versionNo > best.versionNo || (row.versionNo === best.versionNo && row.createdAt >= best.createdAt) ? row : best));
}

/**
 * 约定卡和进度行显示的那一项：待确认的版本取这一版的 draft；已固定的版本取这一版的非 draft 项，
 * 没有（这份约定已经有这件事、重新固定时按规则不重算）时取最新的非 draft 项，都没有为 null。
 * P76r3（R5）：这份约定已有进行中的事时，提交新版本不写 draft（见 project/agreements.ts），卡片改为显示
 * 当前生效的那一项（latestEstimate）——新版本还没生效，那一版的数字与这件事的已用、预算线无关。
 * 没有进行中的事（对齐中）时照旧显示这一版的 draft。
 */
export function displayEstimate(ctx: HubContext, agreement: Pick<Agreement, 'id'>, version: Pick<AgreementVersion, 'no' | 'state'>): EstimateVersion | null {
  const versions = ctx.store.table('jobEstimates').get(agreement.id)?.versions ?? [];
  if (version.state === 'pending') {
    const job = jobOfAgreement(ctx, agreement.id);
    if (job !== null && !isJobClosed(job)) return latestEstimate(ctx, agreement.id);
    return versions.find(row => row.versionNo === version.no && row.reason === 'draft') ?? null;
  }
  return versions.filter(row => row.versionNo === version.no && row.reason !== 'draft').pop() ?? latestEstimate(ctx, agreement.id);
}

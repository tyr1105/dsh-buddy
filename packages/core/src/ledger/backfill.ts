/**
 * 旧档回填（纯函数）：把 v1 时代留下的唤醒单与交账复制成账本行。
 *
 * 为什么需要回填：升级后主人打开机器人详情，如果最近三十天的唤醒全是空白，
 * 会以为账本坏了。源表（wakes、commits、appraisals）还没有被清理，正好能复制一份。
 * 回填是复制不是搬迁：原表一个字段都不改，因此即使回填出错，旧版本仍能正常读取。
 *
 * 为什么必须标 partial：回填没有动作流水，证据也可能已被清理。与其假装完整，
 * 不如明确告诉主人「这段没有记录」，界面才能显示「回填」徽标。
 */
import type { AppraisalLog, Commit, WakeTicket } from '../model/index.js';
import type { LedgerMissingPart, WakeLedgerEntry } from '../model/wake-ledger.js';
import { V2_DEFAULTS } from '../config/defaults.js';
import { decisionFromCommit, triggerFromWake } from './entry.js';
import { snapshotEvidence, type EvidenceCandidate } from './evidence.js';

/** 评估日志与唤醒单的开始时间最多相差五分钟；再远就可能是另一次判断。 */
const APPRAISAL_MATCH_WINDOW_MS = 5 * 60_000;

/**
 * 找最接近本次唤醒的「已唤醒」评估记录。
 * 只认同一个机器人、decision=woke、且时间在 startedAt 前后五分钟内的记录；
 * 找不到就返回 null，调用方继续使用唤醒单自带的分数与门槛。
 */
export function matchWokeAppraisal(
  appraisals: readonly AppraisalLog[],
  wake: WakeTicket,
): AppraisalLog | null {
  let best: AppraisalLog | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const appraisal of appraisals) {
    if (appraisal.botId !== wake.botId || appraisal.decision !== 'woke') continue;
    const distance = Math.abs(appraisal.at - wake.startedAt);
    if (distance > APPRAISAL_MATCH_WINDOW_MS) continue;
    // 同一时刻的重复评估取后写入的那条；顺序稳定，测试可复现。
    if (distance <= bestDistance) {
      best = appraisal;
      bestDistance = distance;
    }
  }
  return best;
}

export interface BackfillInput {
  /** 账本行 id，由服务层用注入随机源生成。 */
  id: string;
  wake: WakeTicket;
  /** 交账记录；唤醒单没有 commitId 或交账已被清理时为空。 */
  commit: Commit | null;
  /** 候选评估日志；服务层按时间窗口预筛，纯函数只负责匹配。 */
  appraisals: readonly AppraisalLog[];
  /** 证据候选池；服务层按机器人归属整理。 */
  candidates: readonly EvidenceCandidate[];
}

/** 合并缺失段并去重，保持稳定顺序。 */
function uniqueMissing(parts: readonly LedgerMissingPart[]): LedgerMissingPart[] {
  const out: LedgerMissingPart[] = [];
  for (const part of parts) if (!out.includes(part)) out.push(part);
  return out;
}

/**
 * 生成一条回填行；不值得回填时返回 null。
 * 跳过规则：没有 endedAt 的投递中记录、以及 status=delivering 的旧记录，
 * 都可能仍在进行，不能提前写成历史。
 */
export function buildBackfillEntry(input: BackfillInput): WakeLedgerEntry | null {
  const { wake, commit } = input;
  if (wake.endedAt === null || wake.status === 'delivering') return null;
  const evidence = snapshotEvidence(
    wake.reason.evidence,
    input.candidates,
    V2_DEFAULTS.LEDGER_EVIDENCE_MAX,
    V2_DEFAULTS.LEDGER_DETAIL_MAX_CHARS,
  );
  // 触发段默认复制唤醒单；能在评估日志里找到同一决策时，用当时的分数、门槛和解释补齐。
  const baseTrigger = triggerFromWake(wake);
  const appraisal = matchWokeAppraisal(input.appraisals, wake);
  const trigger = appraisal
    ? { ...baseTrigger, score: appraisal.score, threshold: appraisal.threshold, summary: appraisal.text }
    : baseTrigger;
  const missing: LedgerMissingPart[] = ['actions'];
  // 只要有证据 id 解析不到就标 evidence：回填时的「未知」占位不能当作已还原。
  if (evidence.missingIds.length > 0) missing.push('evidence');
  if (!commit) missing.push('commit', 'result');
  return {
    id: input.id,
    wakeId: wake.id,
    botId: wake.botId,
    sessionId: wake.sessionId,
    variant: wake.variant,
    status: wake.status,
    source: 'backfill',
    // 回填永远不声称完整：没有动作流水，证据也可能已经不在了。
    completeness: 'partial',
    missing: uniqueMissing(missing),
    // 用真实开始/结束时间，历史顺序才不会因为回填而错位。
    openedAt: wake.startedAt,
    sealedAt: wake.endedAt,
    trigger,
    evidence: { items: evidence.items },
    decision: commit ? decisionFromCommit(commit) : null,
    actions: { items: [] },
    result: commit
      ? { verification: commit.verification, worldChanges: [], refs: [], summary: commit.summary }
      : { verification: null, worldChanges: [], refs: [], summary: null },
    steps: wake.steps,
    tokens: wake.tokens,
    truncated: false,
    bytes: 0,
  };
}

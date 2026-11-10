/**
 * 账本开账与封存（纯函数）：输入唤醒单、交账和显式时间，输出完整账本行。
 *
 * 为什么封存逻辑集中在这里：交账可能在回合结束前发生，也可能由中心合成未交账；
 * 只有「唤醒终态 + 交账结果」同时确定时才能封存。把规则写成纯函数，测试可以
 * 直接覆盖已交账、未交账、失败、取消、超时和合成交账，不依赖宿主。
 */
import type { Commit, WakeTicket } from '../model/index.js';
import type {
  LedgerAction, LedgerDecision, LedgerMissingPart, LedgerTrigger, WakeLedgerEntry,
} from '../model/wake-ledger.js';
import type { EvidenceSnapshot } from './evidence.js';

/** 开账输入：id 由服务层用注入随机源生成，纯函数不产生随机值。 */
export interface OpenLedgerInput {
  id: string;
  wake: WakeTicket;
  /** 从入队到投递成功等待了多久；不知道时为空。 */
  queueWaitMs: number | null;
  evidence: EvidenceSnapshot;
  now: number;
}

/** 由唤醒单复制触发段；理由缺失的段落用明确占位，不假装有内容。 */
export function triggerFromWake(wake: WakeTicket): LedgerTrigger {
  return {
    kind: wake.reason.kind,
    score: wake.reason.score,
    threshold: wake.reason.threshold,
    summary: wake.reason.summary,
    ownerSummary: wake.reason.ownerSummary ?? null,
    ownerInitiated: wake.ownerInitiated,
    subjectKey: wake.subjectKey ?? null,
    // P63：只有主题回合才带这一项；账本比唤醒单活得久，办公室动线要靠它还原项目名和主题名。
    ...(wake.topicId ? { topicId: wake.topicId } : {}),
    queueWaitMs: null,
    evidenceRefs: wake.reason.evidence.slice(0, 20),
  };
}

/** 由交账复制决定段；只复制事实，不在这里生成新结论。 */
export function decisionFromCommit(commit: Commit): LedgerDecision {
  return {
    outcome: commit.outcome,
    summary: commit.summary,
    blocker: commit.blocker,
    nextThink: commit.nextThink,
    ownerQuestion: commit.ownerQuestion?.text ?? null,
    report: commit.report,
    importance: commit.importance,
  };
}

/** 结果段的默认空值；封存时由交账填充。 */
function emptyResult(): WakeLedgerEntry['result'] {
  return { verification: null, worldChanges: [], refs: [], summary: null };
}

/**
 * 开账：投递成功后立即调用。
 * 此时还没有交账和动作，missing 只标已经能确定缺失的段落：
 * - 有证据 id 解析不到 → evidence（哪怕保留了「未知」占位，也不能算完整）
 * 动作段先空着，封存时如果仍为空才标 actions，避免开账行看起来「缺动作」。
 */
export function buildOpenLedger(input: OpenLedgerInput): WakeLedgerEntry {
  const { wake } = input;
  const trigger = { ...triggerFromWake(wake), queueWaitMs: input.queueWaitMs };
  const missing: LedgerMissingPart[] = [];
  if (input.evidence.missingIds.length > 0) missing.push('evidence');
  return {
    id: input.id,
    wakeId: wake.id,
    botId: wake.botId,
    sessionId: wake.sessionId,
    variant: wake.variant,
    // 投递成功后的运行态就是 running；若调用方更早调用，也统一记 running。
    status: wake.status === 'delivering' ? 'running' : wake.status,
    source: 'live',
    completeness: missing.length > 0 ? 'partial' : 'full',
    missing,
    openedAt: input.now,
    sealedAt: null,
    trigger,
    evidence: { items: input.evidence.items },
    decision: null,
    actions: { items: [] },
    result: emptyResult(),
    steps: wake.steps,
    tokens: wake.tokens,
    truncated: false,
    bytes: 0,
  };
}

/** 合并缺失段并去重，保证 missing 不重复、顺序稳定。 */
function mergeMissing(current: readonly LedgerMissingPart[], extra: readonly LedgerMissingPart[]): LedgerMissingPart[] {
  const out = [...current];
  for (const part of extra) if (!out.includes(part)) out.push(part);
  return out;
}

/** 从动作引用和交账证据里收集可下钻引用，去重后最多 20 个。 */
function refsFrom(actions: readonly LedgerAction[], commit: Commit | null): string[] {
  const refs: string[] = [];
  for (const action of actions) if (action.refId && !refs.includes(action.refId)) refs.push(action.refId);
  if (commit) for (const id of commit.evidence) if (!refs.includes(id)) refs.push(id);
  return refs.slice(0, 20);
}

/**
 * 封存：幂等。已经封存的行原样返回，保证「封存后不可改」。
 *
 * 合成交账不算真实交账：中心替未交账回合写的那条 no_change 只是记账手段，
 * 不能出现在 decision 里冒充机器人做过判断（验收场景 B）。
 */
export function sealLedger(input: {
  entry: WakeLedgerEntry;
  wake: WakeTicket;
  commit: Commit | null;
  now: number;
}): WakeLedgerEntry {
  const { entry, wake, now } = input;
  if (entry.sealedAt !== null) return entry;
  const commit = wake.syntheticCommit === true ? null : input.commit;
  const missing = mergeMissing(entry.missing, []);
  if (entry.evidence.items.length === 0) missing.push('evidence');
  if (entry.actions.items.length === 0) missing.push('actions');
  if (!commit) missing.push('commit', 'result');
  const unique = mergeMissing([], missing);
  return {
    ...entry,
    status: wake.status,
    sealedAt: now,
    completeness: unique.length > 0 ? 'partial' : 'full',
    missing: unique,
    decision: commit ? decisionFromCommit(commit) : null,
    result: commit ? {
      verification: commit.verification,
      worldChanges: commit.worldChanges,
      refs: refsFrom(entry.actions.items, commit),
      summary: commit.summary,
    } : emptyResult(),
    steps: wake.steps,
    tokens: wake.tokens,
  };
}

/**
 * 唤醒单本身已丢失时的封存：只能按「中心重启，未收到回合终态」记 error。
 * 动作可能已经留下，保留；交账和结果一定无法确认。
 */
export function sealMissingWake(entry: WakeLedgerEntry, now: number): WakeLedgerEntry {
  if (entry.sealedAt !== null) return entry;
  const missing = mergeMissing(entry.missing, ['commit', 'result']);
  if (entry.actions.items.length === 0) missing.push('actions');
  if (entry.evidence.items.length === 0) missing.push('evidence');
  return {
    ...entry,
    status: 'error',
    sealedAt: now,
    completeness: 'partial',
    missing,
    decision: null,
    result: emptyResult(),
  };
}

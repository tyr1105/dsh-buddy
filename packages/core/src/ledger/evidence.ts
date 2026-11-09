/**
 * 证据快照（纯函数）：把唤醒理由里的证据 id 变成可读、可追溯的摘要。
 *
 * 为什么要快照：感知只保留 14 天，账本保留 90 天。如果不快照，主人两周后再看
 * 「为什么醒」只能看到一串已删除的 id。快照只存摘要和原始 id，不存完整正文；
 * 找不到的记录明确写「已清理，无法回溯」，绝不编造。
 */
import type { LedgerEvidenceItem, LedgerEvidenceKind, LedgerTrust } from '../model/wake-ledger.js';

/** 调用方从各表整理出的候选证据；归属过滤在整理时完成，纯函数不再碰存储。 */
export interface EvidenceCandidate {
  kind: Exclude<LedgerEvidenceKind, 'unknown'>;
  refId: string;
  summary: string;
  occurredAt: number | null;
  trust: LedgerTrust;
}

export interface EvidenceSnapshot {
  items: LedgerEvidenceItem[];
  /** 找不到的 id；写进账本 missing 的 evidence 段。 */
  missingIds: string[];
}

/** 截断到指定字符数（按完整字符，不切断中文）；超出时末尾用省略号。 */
export function clipLedgerText(value: string, maxChars: number): string {
  const chars = [...value.replace(/\r?\n/g, ' / ')];
  if (chars.length <= maxChars) return value.replace(/\r?\n/g, ' / ');
  if (maxChars <= 0) return '';
  return `${chars.slice(0, Math.max(0, maxChars - 1)).join('')}…`;
}

/**
 * 按证据 id 顺序生成快照，最多 max 条。
 * 同一个 id 只保留第一次命中；找不到的记 unknown 并放进 missingIds。
 */
export function snapshotEvidence(
  ids: readonly string[],
  candidates: readonly EvidenceCandidate[],
  max: number,
  detailMaxChars: number,
): EvidenceSnapshot {
  const byId = new Map<string, EvidenceCandidate>();
  for (const candidate of candidates) {
    if (!byId.has(candidate.refId)) byId.set(candidate.refId, candidate);
  }
  const items: LedgerEvidenceItem[] = [];
  const missingIds: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const candidate = byId.get(id);
    if (!candidate) {
      missingIds.push(id);
      if (items.length < max) {
        items.push({ kind: 'unknown', refId: id, summary: '已清理，无法回溯', occurredAt: null, trust: 'unknown' });
      }
      continue;
    }
    if (items.length >= max) continue;
    items.push({
      kind: candidate.kind,
      refId: candidate.refId,
      summary: clipLedgerText(candidate.summary, detailMaxChars),
      occurredAt: candidate.occurredAt,
      trust: candidate.trust,
    });
  }
  return { items, missingIds };
}

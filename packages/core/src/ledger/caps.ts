/**
 * 账本行截断（纯函数）：保证单行不超过硬上限，同时保留最先发生的事实。
 *
 * 为什么需要：一次唤醒可能产生很多动作或很长的交账。账本不负责存档完整输出，
 * 只负责指路；超过 16 KiB 时宁可少记细节并标「已截断」，也不让一行撑爆存储
 * 或拖慢界面。截断规则固定、可测试：先截字段长度，仍超限先把较长的返回文字从最早的动作开始截回 160 字，
 * 还不够才从尾部丢动作、证据、世界变化和引用。
 */
import { V2_DEFAULTS } from '../config/defaults.js';
import { WakeLedgerEntrySchema, type WakeLedgerEntry } from '../model/wake-ledger.js';
import { clipLedgerText } from './evidence.js';

export interface CappedLedger {
  entry: WakeLedgerEntry;
  /** 最终写入的 UTF-8 字节数。 */
  bytes: number;
  /** 是否发生过任何截断。 */
  truncated: boolean;
}

/** 这条动作的返回文字能不能用放宽后的上限：只有名字以 hub_ 开头的 DSH 工具（中心自己的工具）。 */
export function hasLongDetail(action: Pick<WakeLedgerEntry['actions']['items'][number], 'kind' | 'name'>): boolean {
  return action.kind === 'dsh_tool' && action.name.startsWith('hub_');
}

/** 实际存储大小：按 UTF-8 字节，和落盘文件一致。 */
function measure(entry: WakeLedgerEntry): number {
  return Buffer.byteLength(JSON.stringify(entry), 'utf8');
}

/** 把 bytes 字段自身也算进去，迭代几次让数字稳定。 */
function withMeasuredBytes(entry: WakeLedgerEntry): number {
  let size = measure({ ...entry, bytes: 0 });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const next = measure({ ...entry, bytes: size });
    if (next === size) return size;
    size = next;
  }
  return size;
}

/**
 * 截断到 maxBytes 以内。
 * detailMaxChars 控制单条摘要长度，默认 160；必填摘要至少保留一个字符（省略号）。
 */
export function capLedgerEntry(
  raw: WakeLedgerEntry,
  maxBytes: number = V2_DEFAULTS.LEDGER_ROW_MAX_BYTES,
  detailMaxChars: number = V2_DEFAULTS.LEDGER_DETAIL_MAX_CHARS,
): CappedLedger {
  const entry = structuredClone(raw);
  let truncated = false;
  const clip = (value: string): string => {
    const next = clipLedgerText(value, detailMaxChars);
    if (next !== value) truncated = true;
    return next;
  };
  const clipRequired = (value: string): string => clip(value) || '…';

  // 第一层：限制条数和单条摘要长度。数组顺序保留，丢的是尾部（更新的事实）。
  if (entry.trigger.evidenceRefs.length > 20) { entry.trigger.evidenceRefs = entry.trigger.evidenceRefs.slice(0, 20); truncated = true; }
  entry.trigger.summary = clipRequired(entry.trigger.summary);
  if (entry.trigger.ownerSummary !== null) entry.trigger.ownerSummary = clip(entry.trigger.ownerSummary);
  if (entry.evidence.items.length > V2_DEFAULTS.LEDGER_EVIDENCE_MAX) {
    entry.evidence.items = entry.evidence.items.slice(0, V2_DEFAULTS.LEDGER_EVIDENCE_MAX);
    truncated = true;
  }
  entry.evidence.items = entry.evidence.items.map(item => ({ ...item, summary: clip(item.summary) }));
  if (entry.actions.items.length > V2_DEFAULTS.LEDGER_ACTION_MAX) {
    entry.actions.items = entry.actions.items.slice(0, V2_DEFAULTS.LEDGER_ACTION_MAX);
    truncated = true;
  }
  // P74r16a、P74r16c：只有中心自己的工具（名字以 hub_ 开头，返回文字里有中心的提示，核对时要看全）的返回文字
  // 用更长的上限（800 字）；其余动作和其余工具的摘要仍是 detailMaxChars（160 字）。
  entry.actions.items = entry.actions.items.map(action => {
    if (!hasLongDetail(action)) return { ...action, detail: clip(action.detail) };
    const next = clipLedgerText(action.detail, V2_DEFAULTS.LEDGER_TOOL_RESULT_MAX_CHARS);
    if (next !== action.detail) truncated = true;
    return { ...action, detail: next };
  });
  if (entry.decision) {
    entry.decision = {
      ...entry.decision,
      summary: clip(entry.decision.summary),
      blocker: entry.decision.blocker === null ? null : clip(entry.decision.blocker),
      ownerQuestion: entry.decision.ownerQuestion === null ? null : clip(entry.decision.ownerQuestion),
      report: entry.decision.report === null ? null : clip(entry.decision.report),
    };
  }
  if (entry.result.summary !== null) entry.result.summary = clip(entry.result.summary);
  if (entry.result.worldChanges.length > 10) {
    entry.result.worldChanges = entry.result.worldChanges.slice(0, 10);
    truncated = true;
  }
  entry.result.worldChanges = entry.result.worldChanges.map(change => ({
    ...change, what: clipRequired(change.what), where: clip(change.where),
  }));
  if (entry.result.refs.length > 20) { entry.result.refs = entry.result.refs.slice(0, 20); truncated = true; }

  // 第二层（P74r16c 起分两步）：
  // 第一步：仍超限时，先把这一行里超过 detailMaxChars 的返回文字逐条截回 detailMaxChars，
  // 从最早的动作开始，截到不超限为止（长文字只是细节，动作本身——尤其最新的动作——比它重要）。
  let bytes = withMeasuredBytes(entry);
  for (let index = 0; index < entry.actions.items.length && bytes > maxBytes; index += 1) {
    const action = entry.actions.items[index]!;
    if ([...action.detail].length <= detailMaxChars) continue;
    entry.actions.items[index] = { ...action, detail: clipLedgerText(action.detail, detailMaxChars) };
    truncated = true;
    bytes = withMeasuredBytes(entry);
  }
  // 第二步：仍然超限，才从尾部丢整条，直到能装下或只剩不可再删的骨架。
  while (bytes > maxBytes) {
    if (entry.actions.items.length > 0) entry.actions.items.pop();
    else if (entry.evidence.items.length > 0) entry.evidence.items.pop();
    else if (entry.result.worldChanges.length > 0) entry.result.worldChanges.pop();
    else if (entry.result.refs.length > 0) entry.result.refs.pop();
    else break;
    truncated = true;
    bytes = withMeasuredBytes(entry);
  }
  // 第三层：极端情况下压缩交账与触发段文字，保证最后一行一定能落盘。
  if (bytes > maxBytes && entry.decision) {
    entry.decision = { ...entry.decision, summary: '', blocker: null, ownerQuestion: null, report: null };
    truncated = true;
    bytes = withMeasuredBytes(entry);
  }
  if (bytes > maxBytes) {
    entry.trigger = { ...entry.trigger, summary: '…', ownerSummary: null };
    entry.result.summary = null;
    truncated = true;
    bytes = withMeasuredBytes(entry);
  }
  // 先把最终 truncated 标记写进记录，再测量字节数：字段值本身也占字节，
  // 否则会出现「记下的 bytes 与实际落盘 JSON 差一位」的问题。
  entry.truncated = entry.truncated || truncated;
  const finalBytes = withMeasuredBytes(entry);
  const capped = { ...entry, bytes: finalBytes };
  // 最后用 schema 自检：截断不能把记录变成非法数据。
  const parsed = WakeLedgerEntrySchema.parse(capped);
  return { entry: parsed, bytes: parsed.bytes, truncated: parsed.truncated };
}

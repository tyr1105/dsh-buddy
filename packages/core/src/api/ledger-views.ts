/**
 * 账本视图：把账本行翻译成界面可直接渲染的摘要与详情。
 *
 * 为什么单独成文件：账本要同时服务「机器人详情右栏的一次唤醒」和未来账本导航，
 * 但第一期只做读法。视图层只读存储、不写审计，标签统一在这里翻译，
 * 界面不需要知道枚举取值，也不会各自拼装出不一致的中文。
 */
import { z } from 'zod';
import type { HubContext } from '../engine/context.js';
import type { WakeLedgerEntry } from '../model/wake-ledger.js';
import {
  LEDGER_ACTION_KIND_LABELS, LEDGER_ACTION_SOURCE_LABELS, LEDGER_COMPLETENESS_LABELS,
  LEDGER_EVIDENCE_KIND_LABELS, LEDGER_MISSING_LABELS, LEDGER_SOURCE_LABELS, LEDGER_TRUST_LABELS,
} from '../model/wake-ledger.js';
import { OUTCOME_LABELS, VARIANT_LABELS, VERIFICATION_LEVEL_LABELS, VISIBILITY_LABELS, WAKE_KIND_LABELS, WAKE_STATUS_LABELS } from '../model/enums.js';
import { V2_DEFAULTS } from '../config/defaults.js';
import { input, shortTime } from './common.js';
import type { WakeLedgerRow, WakeLedgerView } from './types.js';

/** 把一行账本翻译成列表摘要；botName 缺失时给出明确占位，不显示空白。 */
function rowOf(ctx: HubContext, entry: WakeLedgerEntry): WakeLedgerRow {
  const bot = ctx.store.table('bots').get(entry.botId);
  return {
    id: entry.id,
    wakeId: entry.wakeId,
    botId: entry.botId,
    botName: bot?.name ?? '已删除的机器人',
    botColor: bot?.color ?? '#8a8a8a',
    variant: entry.variant,
    variantLabel: VARIANT_LABELS[entry.variant],
    status: entry.status,
    statusLabel: WAKE_STATUS_LABELS[entry.status],
    source: entry.source,
    sourceLabel: LEDGER_SOURCE_LABELS[entry.source],
    completeness: entry.completeness,
    completenessLabel: LEDGER_COMPLETENESS_LABELS[entry.completeness],
    triggerKind: entry.trigger.kind,
    triggerKindLabel: WAKE_KIND_LABELS[entry.trigger.kind],
    // 给主人看的理由优先用 ownerSummary；执行指令只留在 summary 里。
    triggerText: entry.trigger.ownerSummary ?? entry.trigger.summary,
    triggerScore: entry.trigger.score,
    triggerThreshold: entry.trigger.threshold,
    outcome: entry.decision?.outcome ?? null,
    outcomeLabel: entry.decision?.outcome ? OUTCOME_LABELS[entry.decision.outcome] : null,
    summary: entry.decision?.summary ?? entry.result.summary,
    openedAt: entry.openedAt,
    openedText: shortTime(ctx, entry.openedAt)!,
    sealedAt: entry.sealedAt,
    sealedText: shortTime(ctx, entry.sealedAt),
    steps: entry.steps,
    tokens: entry.tokens,
    actionCount: entry.actions.items.length,
    evidenceCount: entry.evidence.items.length,
    truncated: entry.truncated,
    hasMissing: entry.missing.length > 0,
    missingLabels: entry.missing.map(part => LEDGER_MISSING_LABELS[part]),
  };
}

/** 按机器人列出最近账本摘要；按封存时间倒序，未封存的排在最前并用开账时间参与比较。 */
export function wakeLedgerList(ctx: HubContext, botId: string, limit?: number, before?: number): WakeLedgerRow[] {
  const id = input(z.string().trim().min(1, 'botId 不能为空'), botId, 'botId');
  const size = limit === undefined
    ? V2_DEFAULTS.LEDGER_LIST_DEFAULT_LIMIT
    : input(z.number().int('limit 必须是整数').min(1, 'limit 至少为 1').max(100, 'limit 最多为 100'), limit, 'limit');
  const cursor = before === undefined ? null
    : input(z.number().int('before 必须是整数毫秒').nonnegative('before 不能为负数'), before, 'before');
  const timeOf = (entry: WakeLedgerEntry): number => entry.sealedAt ?? entry.openedAt;
  return ctx.store.table('wakeLedger').list(entry => entry.botId === id && (cursor === null || timeOf(entry) < cursor))
    .sort((a, b) => timeOf(b) - timeOf(a))
    .slice(0, size)
    .map(entry => rowOf(ctx, entry));
}

/** 读取一次唤醒的完整账本；只接受唤醒单 id，找不到返回 null。 */
export function wakeLedgerDetail(ctx: HubContext, wakeId: string): WakeLedgerView | null {
  const id = input(z.string().trim().min(1, 'wakeId 不能为空'), wakeId, 'wakeId');
  const entry = ctx.store.table('wakeLedger').list(row => row.wakeId === id)[0];
  if (!entry) return null;
  // 原文从保留期内的原交账读取，不能用当前性格重新压缩历史，也不改写封存账本。
  const originalCommit = entry.decision === null ? null
    : ctx.store.table('commits').list(commit => commit.wakeId === id && commit.botId === entry.botId)[0];
  return {
    entry,
    fullReport: originalCommit?.report ?? null,
    row: rowOf(ctx, entry),
    evidence: entry.evidence.items.map(item => ({
      ...item,
      kindLabel: LEDGER_EVIDENCE_KIND_LABELS[item.kind],
      trustLabel: LEDGER_TRUST_LABELS[item.trust],
      occurredText: shortTime(ctx, item.occurredAt),
    })),
    actions: entry.actions.items.map(action => ({
      ...action,
      kindLabel: LEDGER_ACTION_KIND_LABELS[action.kind],
      outcomeLabel: action.outcome === 'ok' ? '成功' : '失败',
      sourceLabel: LEDGER_ACTION_SOURCE_LABELS[action.source],
    })),
    verificationLabel: entry.result.verification ? VERIFICATION_LEVEL_LABELS[entry.result.verification.level] : null,
    resultCheck: ctx.store.table('resultChecks').list(check => check.wakeId === id)[0] ?? null,
    // 世界变化是机器人自述，界面要和 observed 动作分开显示。
    worldChanges: entry.result.worldChanges.map(change => ({
      ...change, visibilityLabel: VISIBILITY_LABELS[change.whoCanSee],
    })),
    missingLabels: entry.missing.map(part => LEDGER_MISSING_LABELS[part]),
  };
}

/**
 * 唤醒账本：一次真实唤醒从「为什么醒」到「最后交了什么」的策展记录。
 *
 * 为什么不把账本字段塞进 WakeTicket：唤醒单是运行态，投递失败会被删改、保留 30 天；
 * 账本要求封存后不可改、保留 90 天，而且旧版本用 strictObject 解析 wakes.json，
 * 往里加字段会让降级直接读不出唤醒记录。所以账本独立成表，只用 wakeId 关联，
 * 现有实体一个字段都不加。
 *
 * 记录纪律（与 docs/plan/v2-transformation.md 3.1 一致）：
 * - 事实不可变：开账后只追加动作，封存一次，封存后不再改。
 * - 观察与自述分开：hub_* 工具、出站提交是 observed；交账里的 worldChanges 是 declared。
 * - 不存完整唤醒包与完整工具输出，只留摘要（默认每条 160 字）。
 */
import { z } from 'zod';
import * as e from './enums.js';
import { NextThinkSchema } from './wake.js';
import { bool, count, finite, nonempty, ratio, recordId, text, timestamp } from './primitives.js';

// 账本来源：实时记录，或从旧唤醒单回填。界面必须显示「回填」，不能假装是实时观察。
export const LEDGER_SOURCES = ['live', 'backfill'] as const;
export const LedgerSourceSchema = z.enum(LEDGER_SOURCES, { error: '请选择有效的账本来源' });
export type LedgerSource = z.infer<typeof LedgerSourceSchema>;
export const LEDGER_SOURCE_LABELS: Record<LedgerSource, string> = { live: '实时', backfill: '回填' };

// 完整度：宿主能力不足或旧档回填时只能是 partial，不能假装完整。
export const LEDGER_COMPLETENESS = ['full', 'partial'] as const;
export const LedgerCompletenessSchema = z.enum(LEDGER_COMPLETENESS, { error: '请选择有效的完整度' });
export type LedgerCompleteness = z.infer<typeof LedgerCompletenessSchema>;
export const LEDGER_COMPLETENESS_LABELS: Record<LedgerCompleteness, string> = { full: '完整', partial: '不完整' };

// 缺了哪几段，界面据此逐项说明「这段没有记录」，而不是显示空白让人猜。
export const LEDGER_MISSING_PARTS = ['trigger', 'evidence', 'actions', 'commit', 'result'] as const;
export const LedgerMissingPartSchema = z.enum(LEDGER_MISSING_PARTS, { error: '请选择有效的缺失字段' });
export type LedgerMissingPart = z.infer<typeof LedgerMissingPartSchema>;
export const LEDGER_MISSING_LABELS: Record<LedgerMissingPart, string> = {
  trigger: '触发理由', evidence: '证据', actions: '动作', commit: '交账', result: '结果',
};

// 证据类型与唤醒包取证据的顺序保持一致，便于两边对照。
export const LEDGER_EVIDENCE_KINDS = ['percept', 'thread', 'agenda', 'aspiration', 'goal', 'watch', 'inbox', 'approval', 'downtime', 'unknown'] as const;
export const LedgerEvidenceKindSchema = z.enum(LEDGER_EVIDENCE_KINDS, { error: '请选择有效的证据类型' });
export type LedgerEvidenceKind = z.infer<typeof LedgerEvidenceKindSchema>;
export const LEDGER_EVIDENCE_KIND_LABELS: Record<LedgerEvidenceKind, string> = {
  percept: '感知', thread: '线程', agenda: '议程', aspiration: '志向', goal: '目标',
  watch: '关注项', inbox: '收件箱', approval: '审批', downtime: '停机', unknown: '未知',
};

// 证据可信度：外部来源标 untrusted，提醒主人这段内容不能当指令。
export const LEDGER_TRUST_LEVELS = ['trusted', 'untrusted', 'unknown'] as const;
export const LedgerTrustSchema = z.enum(LEDGER_TRUST_LEVELS, { error: '请选择有效的可信度' });
export type LedgerTrust = z.infer<typeof LedgerTrustSchema>;
export const LEDGER_TRUST_LABELS: Record<LedgerTrust, string> = { trusted: '可信', untrusted: '外部内容', unknown: '未知' };

// 动作类型：第一期只记录中心 hub_* 工具与出站提交；dsh_tool 留给第二期。
export const LEDGER_ACTION_KINDS = ['hub_tool', 'outbox', 'host_command', 'dsh_tool'] as const;
export const LedgerActionKindSchema = z.enum(LEDGER_ACTION_KINDS, { error: '请选择有效的动作类型' });
export type LedgerActionKind = z.infer<typeof LedgerActionKindSchema>;
export const LEDGER_ACTION_KIND_LABELS: Record<LedgerActionKind, string> = {
  hub_tool: '中心工具', outbox: '出站提交', host_command: '宿主命令', dsh_tool: 'DSH 工具',
};

// 观察与自述必须分开：observed 是中心实际看到的，declared 是机器人自己说的。
export const LEDGER_ACTION_SOURCES = ['observed', 'declared'] as const;
export const LedgerActionSourceSchema = z.enum(LEDGER_ACTION_SOURCES, { error: '请选择有效的动作来源' });
export type LedgerActionSource = z.infer<typeof LedgerActionSourceSchema>;
export const LEDGER_ACTION_SOURCE_LABELS: Record<LedgerActionSource, string> = { observed: '中心观察到', declared: '机器人自述' };

// 动作执行结果只有一个布尔语义：成功或失败。
export const LEDGER_ACTION_OUTCOMES = ['ok', 'error'] as const;
export const LedgerActionOutcomeSchema = z.enum(LEDGER_ACTION_OUTCOMES, { error: '请选择有效的动作结果' });
export type LedgerActionOutcome = z.infer<typeof LedgerActionOutcomeSchema>;

/** 触发段：当时为什么醒、分数和门槛、给主人看的理由。 */
export const LedgerTriggerSchema = z.strictObject({
  kind: e.WakeKindSchema, // 唤醒类别
  score: ratio, // 当时思考分
  threshold: finite, // 当时门槛，可超过 1
  summary: nonempty, // 给机器人看的理由摘要
  ownerSummary: text.nullable(), // 给主人看的事实摘要；旧记录可能没有
  ownerInitiated: bool, // 是否由主人发起
  subjectKey: text.nullable(), // 同一事项的稳定标识
  topicId: recordId('ptp').nullable().optional(), // P63：属于哪个项目主题；唤醒单先过期时靠它还原项目名和主题名
  queueWaitMs: count.nullable(), // 从入队到投递等待了多久
  evidenceRefs: z.array(nonempty).max(20), // 原始证据 id，最多 20 个
});
export type LedgerTrigger = z.infer<typeof LedgerTriggerSchema>;

/** 证据快照：感知清理后仍能解释当时手里有什么。 */
export const LedgerEvidenceItemSchema = z.strictObject({
  kind: LedgerEvidenceKindSchema, // 证据来自哪张表
  refId: nonempty, // 原始记录 id
  summary: text, // 摘要，默认截断到 160 字
  occurredAt: timestamp.nullable(), // 证据发生时间；查不到时为空
  trust: LedgerTrustSchema, // 可信度
});
export type LedgerEvidenceItem = z.infer<typeof LedgerEvidenceItemSchema>;

/** 决定段：交账事实的副本；没有真实交账时整段为空。 */
export const LedgerDecisionSchema = z.strictObject({
  outcome: e.OutcomeSchema.nullable(), // 做了什么或没做什么
  summary: text, // 交账摘要
  blocker: text.nullable(), // 受阻原因
  nextThink: NextThinkSchema.nullable(), // 下次什么时候再想
  ownerQuestion: text.nullable(), // 需要主人回答的问题
  report: text.nullable(), // 主动汇报内容
  importance: finite.int('重要度必须是整数').min(1, '重要度至少为 1').max(10, '重要度最多为 10').nullable(),
});
export type LedgerDecision = z.infer<typeof LedgerDecisionSchema>;

/** 动作段：按发生顺序追加；封存后不再改。 */
export const LedgerActionSchema = z.strictObject({
  kind: LedgerActionKindSchema, // 哪一类动作
  name: nonempty, // 工具名或动作名
  target: text.nullable(), // 操作对象：文件、频道、命令等
  outcome: LedgerActionOutcomeSchema, // 成功或失败
  source: LedgerActionSourceSchema, // 观察到的还是机器人自述的
  refId: text.nullable(), // 可下钻的记录 id（出站单、审批单等）
  detail: text, // 摘要，不存完整输出
  durationMs: count.nullable(), // 耗时；不知道时为空
});
export type LedgerAction = z.infer<typeof LedgerActionSchema>;

/** 结果段：验证层级、声明的世界变化与可下钻引用。 */
export const LedgerResultSchema = z.strictObject({
  verification: z.strictObject({
    level: e.VerificationLevelSchema, // 验证到什么程度
    notCovered: text, // 没覆盖什么
  }).nullable(),
  worldChanges: z.array(z.strictObject({
    what: nonempty, // 具体改变了什么
    whoCanSee: e.VisibilitySchema, // 谁能看见
    where: text, // 变化发生的位置
  })).max(10),
  refs: z.array(nonempty).max(20), // 产物、出站单、审批单等引用
  summary: text.nullable(), // 结果一句话
});
export type LedgerResult = z.infer<typeof LedgerResultSchema>;

/**
 * 一条完整账本记录。
 * 状态仍用现有 WakeStatus：未封存时是 running；投递失败直接封存为 error。
 * 这里不新增「open」状态，避免和唤醒单的状态机各说各话。
 */
export const WakeLedgerEntrySchema = z.strictObject({
  id: recordId('wl'), // 账本行 id，前缀 wl_
  wakeId: nonempty, // 与唤醒单 1:1；回填幂等键
  botId: nonempty, // 归属机器人
  sessionId: nonempty.nullable(), // 宿主会话；投递失败时可能为空
  variant: e.VariantSchema, // 本次是常规、轻复查、复盘等
  status: e.WakeStatusSchema, // 终态；未封存时为 running
  source: LedgerSourceSchema, // 实时或回填
  completeness: LedgerCompletenessSchema, // 完整或部分
  missing: z.array(LedgerMissingPartSchema).max(5), // 缺了哪几段
  openedAt: timestamp, // 开账时间
  sealedAt: timestamp.nullable(), // 封存时间；保留期按它计算
  trigger: LedgerTriggerSchema, // 触发段
  evidence: z.strictObject({
    items: z.array(LedgerEvidenceItemSchema).max(10), // 最多 10 条，与 V2_DEFAULTS.LEDGER_EVIDENCE_MAX 一致
  }),
  decision: LedgerDecisionSchema.nullable(), // 没有真实交账时为空
  actions: z.strictObject({
    items: z.array(LedgerActionSchema).max(30), // 最多 30 条，与 V2_DEFAULTS.LEDGER_ACTION_MAX 一致
  }),
  result: LedgerResultSchema, // 结果段
  steps: count, // 回合步数
  tokens: count, // token 用量
  truncated: bool, // 是否因为字节上限被截断
  bytes: count, // 实际存储大小，由 capLedgerEntry 计算
});
export type WakeLedgerEntry = z.infer<typeof WakeLedgerEntrySchema>;

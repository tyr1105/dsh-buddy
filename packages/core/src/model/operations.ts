/** 运维与解释性日志：保存额度、停机、告警和决策证据，供界面与仿真直接核对。 */
import { z } from 'zod';
import * as e from './enums.js';
import { bool, count, finite, nonempty, ratio, recordId, text, timestamp } from './primitives.js';

/** 校验用量归属和计量类型，为额度窗口提供原始账目。 */
export const LedgerEntrySchema = z.strictObject({
  id: recordId('le'), // 记录的唯一标识；前缀区分记录类型
  who: nonempty, // 用量归属的机器人 id 或 owner
  wakeId: nonempty.nullable(), // 所属唤醒单 id
  tokens: count, // token 用量
  kind: e.LedgerKindSchema, // 回合、上下文压缩或其他用量
  at: timestamp, // 发生时间（Unix 毫秒）
  tokenSource: z.enum(['host', 'estimate']).optional(), // 缺省表示旧记录来源未知，不猜测
  tokenBase: z.number().finite().nonnegative().optional(), // 宿主原数或估算基数，不含记账保护倍率
  accountingMultiplier: z.number().finite().positive().optional(), // 保存当时倍率，设置变化不重算历史
  ownerInitiated: bool.optional(), // 记录当时发起者，唤醒单清理后仍能核对成本
});
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;
/** 校验额度窗口单例，保持预算、额度灯与恢复探针一致。 */
export const QuotaStateSchema = z.strictObject({
  id: z.literal('quota', { error: '额度单例 id 必须为 quota' }), // 固定为 quota 的额度单例标识
  windowStartAt: timestamp, // 当前额度窗口开始时间
  botTurns: count, // 本窗口全体机器人的回合数
  botTokens: count, // 本窗口全体机器人的 token 用量
  turnLimit: count, // 本窗口机器人可用回合上限
  tokenLimit: count.nullable(), // 本窗口 token 上限；尚未校准时为空
  light: e.QuotaLightSchema, // 额度灯：绿、黄、橙或红
  redUntil: timestamp.nullable(), // 红灯预计解除时间
  probeAllowed: bool, // 窗口恢复后是否允许一次探针回合
  probeInFlight: bool.optional(), // 明确区分已投递探针与没有探针的红灯
  probeWakeId: nonempty.nullable().optional(), // 本次探针绑定的唤醒单；重启不从旧审计猜测身份
  windowPending: bool.optional(), // 过期后等待下一回合开始，空闲 tick 不推进起点
  calibratedAt: timestamp.optional(), // 只在第一次真实额度报错校准
  lastError: text.nullable(), // 最近一次额度错误说明
  lastErrorAt: timestamp.nullable(), // 最近一次额度错误时间
});
export type QuotaState = z.infer<typeof QuotaStateSchema>;
/** 校验可合并告警，保存首次、最近出现和恢复状态。 */
export const AlertSchema = z.strictObject({
  id: recordId('al'), // 记录的唯一标识；前缀区分记录类型
  episodeId: recordId('al').optional(), // 同一轮故障跨合并窗口沿用身份；旧档缺省时从原记录 id 起算
  botId: nonempty.nullable(), // 相关机器人 id；全体告警为空
  code: nonempty, // 用于合并同类告警的稳定代码
  text: nonempty, // 正文
  level: e.PrioritySchema, // P0 紧急、P1 重要、P2 一般
  count, // 此告警累计出现次数
  firstAt: timestamp, // 第一次出现时间
  lastAt: timestamp, // 最近一次出现时间
  status: e.AlertStatusSchema, // 告警尚未恢复或已经恢复
});
export type Alert = z.infer<typeof AlertSchema>;
/** 校验有效停机区间，为恢复补课提供明确边界。 */
export const DowntimeSchema = z.strictObject({
  id: recordId('d'), // 记录的唯一标识；前缀区分记录类型
  from: timestamp, // 停机区间开始时间
  to: timestamp, // 停机区间结束时间
  kind: e.DowntimeKindSchema, // 宿主关闭或电脑睡眠
  handled: bool, // 是否已完成停机补课处理
}).refine(value => value.to >= value.from, { path: ['to'], message: '结束时间不能早于开始时间' });
export type Downtime = z.infer<typeof DowntimeSchema>;
/** 校验为什么醒或没醒的解释，支持界面与仿真核对。 */
export const AppraisalLogSchema = z.strictObject({
  id: recordId('ev'), // 记录的唯一标识；前缀区分记录类型
  botId: nonempty, // 所属机器人 id
  at: timestamp, // 发生时间（Unix 毫秒）
  perceptIds: z.array(nonempty), // 本次评估涉及的感知 id
  score: ratio, // 本次候选的思考分，范围 0–1
  threshold: finite, // 本次唤醒门槛，可随疲劳和设置超过 1
  decision: e.AppraisalDecisionSchema, // 唤醒、排队、入堆、仅记录或拦截的结果
  suppressedBy: e.SuppressionReasonSchema.nullable(), // 阻止唤醒的具体闸门；未被拦截时为空
  until: timestamp.nullable().optional(), // 中心有意延后的截止时间；旧日志无此字段仍可读取
  text: nonempty, // 界面直接显示的一句中文评估解释
});
export type AppraisalLog = z.infer<typeof AppraisalLogSchema>;
/** 校验操作审计事实，保留谁在何时做了什么。 */
export const AuditEntrySchema = z.strictObject({
  id: recordId('au'), // 记录的唯一标识；前缀区分记录类型
  at: timestamp, // 发生时间（Unix 毫秒）
  actor: nonempty, // 操作者：主人、中心或机器人 id
  action: nonempty, // 审计动作名
  detail: text, // 可供主人审阅的详细说明
});
export type AuditEntry = z.infer<typeof AuditEntrySchema>;

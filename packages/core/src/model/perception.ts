/** 关注项、感知和内驱快照：分数限制在 0–1，所有事件时间显式存储，便于重放。 */
import { z } from 'zod';
import * as e from './enums.js';
import { bool, byteText, clockTime, count, dateKey, nonempty, positive, ratio, recordId, text, timestamp } from './primitives.js';

/** 星期输入与存档共用同一约束；overwrite 保留数组类型，导出的工具 Schema 仍能描述完整限制。 */
export const ExpectationWeekdaysSchema = z.array(z.number({ error: '星期必须是 1–7 的整数' })
  .int('星期必须是整数').min(1, '星期不能小于 1').max(7, '星期不能大于 7'), { error: '检查日必须是星期数组或 null' })
  .min(1, '检查日数组不能为空')
  .overwrite(days => [...new Set(days)].sort((a, b) => a - b))
  .nullable()
  .describe('只在这些日子检查：1=周一…7=周日；省略表示每天；工作日写 [1,2,3,4,5]');

/** 有检查日限制时必须能在当天到期；四个入口复用同一提示，避免把每日一份误配为跨天间隔。 */
export function validateExpectationInterval(value: { everyMs?: number | null; weekdays?: number[] | null }, ctx: z.RefinementCtx): void {
  if (value.everyMs == null || value.weekdays == null) return;
  if (value.everyMs >= 24 * 60 * 60 * 1000) ctx.addIssue({ code: 'custom', path: ['everyMs'],
    message: 'weekdays 不为空时 everyMs 必须小于 24 小时；每个检查日一份请用 byLocalTime（例如每天 08:20 前）' });
}

/** 同次检查最多有间隔与钟点两种期限；去重排序后仍保存每个真实日期，不能丢掉其中一项。 */
export const ExpectationDueTimesSchema = z.array(timestamp).min(1, '落空期限至少一项').max(2, '落空期限最多两项')
  .overwrite(times => [...new Set(times)].sort((a, b) => a - b));

/** 校验应该发生的事情，使期望落空能够独立触发感知。 */
export const ExpectationSchema = z.strictObject({
  text: nonempty, // 正文
  everyMs: positive.nullable(), // 预期事件发生的间隔（毫秒）；非间隔预期为空
  byLocalTime: clockTime.nullable(), // 每天应满足预期的本地 HH:mm 时刻
  weekdays: ExpectationWeekdaysSchema.default(null), // 缺省旧记录按每天处理，写回时补齐 null
  effectiveAt: timestamp.optional(), // 最近设置或转为 active 的较晚时刻；缺字段旧档按关注项 createdAt
  lastSatisfiedAt: timestamp.nullable(), // 最近满足预期的时间
  lastMissedAt: timestamp.nullable(), // 最近一次记录期望落空的时间，避免重复上报
  lastMissedDueAt: timestamp.optional(), // 最近落空对应的到期点；旧档缺省时仍按发现时间解释
  lastMissedDueAts: ExpectationDueTimesSchema.optional(), // 双期限同次落空时保留全部期限，旧单值字段仍兼容
}).superRefine(validateExpectationInterval);
export type Expectation = z.infer<typeof ExpectationSchema>;

/** 校验关注目标及最近快照，为感知执行器提供稳定输入。 */
export const WatchSchema = z.strictObject({
  id: recordId('wt'), // 记录的唯一标识；前缀区分记录类型
  botId: nonempty, // 所属机器人 id
  kind: e.WatchKindSchema, // 记录的业务类别
  target: nonempty, // 关注目标：路径、URL、脚本命令或会话标题关键词
  filter: text.nullable(), // 关键词或 /正则/；命中时提高相关度
  intervalMs: positive.nullable(), // 轮询间隔（毫秒）；事件驱动的关注项为空
  expectation: ExpectationSchema.nullable(), // 期望发生的事情；没有期望时为空
  relevance: ratio, // 与机器人目标的相关度，范围 0–1
  createdBy: e.WatchCreatedBySchema, // 关注项由主人、机器人或中心创建
  status: e.WatchStatusSchema, // 有效、提议中、暂停或过期
  expiresAt: timestamp.nullable(), // 到期时间；无到期约束时可为空
  lastCheckedAt: timestamp.nullable(), // 最近检查关注目标的时间
  lastFingerprint: text.nullable(), // 最近一次检查结果的指纹，用于发现变化
  lastValue: byteText(4096).nullable(), // 最近一次检查的正文快照，最多 4 KB，用于比较差异
  why: nonempty, // 创建或执行的理由
  createdAt: timestamp, // 创建时间（Unix 毫秒）
  updatedAt: timestamp, // 最近修改时间（Unix 毫秒）
});
export type Watch = z.infer<typeof WatchSchema>;

/** 校验标准化感知及评分，确保不同来源能够统一评估。 */
export const PerceptSchema = z.strictObject({
  id: recordId('p'), // 记录的唯一标识；前缀区分记录类型
  botId: nonempty, // 所属机器人 id
  watchId: nonempty.nullable(), // 来源关注项 id；直接事件为空
  source: e.PerceptSourceSchema, // 记录来源
  kind: nonempty, // 变化、期望落空、消息或系统事件的细分类别
  summary: text.max(500, '感知摘要不能超过 500 字'), // 感知摘要，最多 500 字
  location: text.nullable(), // 原文位置：路径、URL 或会话 id
  fingerprint: text.regex(/^[a-f0-9]{16}$/, '指纹必须是 16 位小写十六进制字符'), // 去重指纹，SHA-1 的前 16 位十六进制字符
  relevance: ratio, // 与机器人目标的相关度，范围 0–1
  novelty: ratio, // 新颖程度，范围 0–1
  magnitude: ratio, // 变化幅度，范围 0–1
  importance: ratio, // 该变化的重要程度，范围 0–1
  urgency: ratio, // 紧迫程度，范围 0–1
  anomaly: bool, // 是否发生异常；异常会增加显著性
  salience: ratio, // 按第 6.2 节公式计算的显著性
  untrusted: bool, // 外部内容为 true，放入唤醒包时必须围栏隔离
  tier: e.PerceptTierSchema, // 紧急、候选、待处理堆或仅记录的分档
  deferredByOwner: bool.optional(), // 主人打断后留待下一次唤醒带上，不独立触发重试
  consumedByWake: nonempty.nullable(), // 已消费这条感知的唤醒单 id
  evaluatedAt: timestamp.optional(), // 候选评估已完成的时间；持久化后重启不再重放旧感知
  discardedAt: timestamp.optional(), // 等主人同一事项等明确丢弃的时间；不伪造唤醒单 id
  dueAt: timestamp.optional(), // 期望落空的真实到期点；createdAt 继续保留发现时间供调度使用
  dueAts: ExpectationDueTimesSchema.optional(), // 同一次发现的全部到期点，避免跨日双期限只留下最早一项
  createdAt: timestamp, // 创建时间（Unix 毫秒）
});
export type Percept = z.infer<typeof PerceptSchema>;

/** 校验内驱快照和每日触发状态，防止无变化时反复唤醒。 */
export const DriveStateSchema = z.strictObject({
  id: recordId('b'), // 内驱快照 id，必须等于所属 botId
  botId: nonempty, // 所属机器人 id
  stagnation: ratio, // 目标停滞产生的内驱强度
  obligation: ratio, // 承诺临近或逾期产生的内驱强度
  waiting: ratio, // 等待主人或同伴产生的内驱强度
  frustration: ratio, // 连续受阻产生的内驱强度
  fatigue: ratio, // 用量和连续思考形成的疲劳程度
  firedToday: count, // 今天由内驱触发的次数
  firedDay: dateKey, // 内驱次数所属的本地日期 YYYY-MM-DD
  snoozedUntil: z.record(nonempty, timestamp), // 各内驱暂停触发到什么时间
  updatedAt: timestamp, // 最近修改时间（Unix 毫秒）
}).refine(value => value.id === value.botId, { path: ['id'], message: '内驱 id 必须等于 botId' });
export type DriveState = z.infer<typeof DriveStateSchema>;

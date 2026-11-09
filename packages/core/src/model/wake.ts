/** 唤醒与交账的持久化模型：记录原因和结果；工具输入的上下文校验在 C03 实现。 */
import { z } from 'zod';
import * as e from './enums.js';
import { bool, count, finite, nonempty, positive, ratio, recordId, text, timestamp } from './primitives.js';

/** 校验唤醒分数、门槛和证据，使每次思考都有可追溯理由。 */
export const WakeReasonSchema = z.strictObject({
  kind: e.WakeKindSchema, // 记录的业务类别
  score: ratio, // 本次候选的思考分，范围 0–1
  threshold: finite, // 本次唤醒门槛，可随疲劳和设置超过 1
  summary: nonempty, // 给机器人阅读的简明摘要
  ownerSummary: nonempty.optional(), // 给主人看的事实摘要；执行指令只留在 summary
  evidence: z.array(nonempty), // 支持判断的感知、议程、收件箱或审批 id
});
export type WakeReason = z.infer<typeof WakeReasonSchema>;
/** 校验候选排队信息，让时序、优先级和同事项去重保持一致。 */
export const QueueEntrySchema = z.strictObject({
  id: recordId('q'), // 记录的唯一标识；前缀区分记录类型
  botId: nonempty, // 所属机器人 id
  variant: e.VariantSchema, // 常规、轻复查、复盘、补课、试跑或教学回合
  reason: WakeReasonSchema, // 为什么需要思考，包含分数、门槛和证据
  priority: finite, // 按第 6.6 节计算的调度优先级，数值越大越先放行
  urgent: bool, // 是否紧急；可越过最短节奏但不能越过预算
  ownerInitiated: bool, // 是否由主人亲自发起
  subjectKey: nonempty, // 同一事项的稳定标识，用于冷却与等待主人去重
  notBefore: timestamp, // 不早于此时间放行
  enqueuedAt: timestamp, // 进入队列的时间
});
export type QueueEntry = z.infer<typeof QueueEntrySchema>;
/** 校验一次唤醒从投递到结束的事实，支持幂等交账和故障核对。 */
export const WakeTicketSchema = z.strictObject({
  id: recordId('w'), // 唤醒单 id，前缀 w_；兼作幂等 requestId
  botId: nonempty, // 所属机器人 id
  sessionId: nonempty.nullable(), // 宿主会话 id；空值表示尚未绑定会话
  variant: e.VariantSchema, // 常规、轻复查、复盘、补课、试跑或教学回合
  reason: WakeReasonSchema, // 为什么需要思考，包含分数、门槛和证据
  subjectKey: nonempty.optional(), // C02：精确保留本次事项键；旧唤醒单兼容缺省，读取时从证据恢复。
  dispatchedAt: timestamp.nullable().optional(), // null 明确表示尚未成功投递；缺省兼容旧记录。C04 投递成功时写入真实时刻。
  ownerDirect: bool.optional(), // 是否由已有宿主会话中的主人直聊触发；缺省兼容旧记录
  tokensKnown: bool.optional(), // 宿主是否已经提供实际 token 用量，缺省兼容旧记录
  awaitingApprovalAt: timestamp.nullable().optional(), // 宿主审批框出现时间，用于超时取消
  syntheticCommit: bool.optional(), // 是否由中心为未交账回合合成的记录，缺省兼容旧记录
  ownerInitiated: bool, // 是否由主人亲自发起
  packetBytes: count, // 本次唤醒包的 UTF-8 字节数
  canceledBy: z.literal('owner').optional(), // 主人打断的持久化原因；旧记录可缺省
  status: e.WakeStatusSchema, // 投递中、运行中、已交账、未交账、出错、取消或超时
  startedAt: timestamp, // 回合开始时间
  lastEventAt: timestamp, // 最近收到宿主回合事件的时间
  endedAt: timestamp.nullable(), // 宿主实际结束时间；尚未结束时为空
  steps: count, // 已执行的步骤数
  tokens: count, // token 用量
  steeredAt: timestamp.nullable(), // 中心发出收口提醒的时间
  commitId: nonempty.nullable(), // 本回合交账 id；尚未交账时为空
  error: text.nullable(), // 回合错误说明
});
export type WakeTicket = z.infer<typeof WakeTicketSchema>;

// 这里只验证持久化字段；模式与参数对应、主人唤醒必须 reply 等输入规则属于 C03。
/** 校验持久化的下一次思考提议；模式参数的关联校验由交账入口负责。 */
export const NextThinkSchema = z.strictObject({
  mode: e.NextThinkModeSchema, // 下次思考的安排方式
  at: nonempty.optional(), // 指定的 ISO 时间或上海时间 YYYY-MM-DD HH:mm
  afterMinutes: positive.optional(), // 等待多少分钟后再想
  onEvent: nonempty.optional(), // 等待的关注项 id 或事件关键词
  reason: nonempty.max(200, '下次思考理由不能超过 200 字'), // 机器人说明下次为何还值得思考，最多 200 字
});
export type NextThink = z.infer<typeof NextThinkSchema>;
/** 校验交账事实、证据与后续安排，便于日志和主人线程统一消费。 */
export const CommitSchema = z.strictObject({
  id: recordId('c'), // 记录的唯一标识；前缀区分记录类型
  wakeId: nonempty, // 所属唤醒单 id
  botId: nonempty, // 所属机器人 id
  outcome: e.OutcomeSchema, // 无变化、有进展、已完成、受阻或需要主人
  summary: nonempty.max(500, '交账摘要不能超过 500 字'), // 本次交账摘要，最多 500 字
  worldChanges: z.array(z.strictObject({
    what: nonempty, // 具体改变了什么
    whoCanSee: e.VisibilitySchema, // 变化对自己、主人或他人可见
    where: text, // 变化发生的位置
  })), // 本回合对真实世界造成的变化
  evidence: z.array(text), // 支持判断的感知、议程、收件箱或审批 id
  verification: z.strictObject({
    level: e.VerificationLevelSchema, // 验证层级：程序、机器人、端到端或未验证
    notCovered: text, // 尚未验证的范围
  }), // 已完成的验证层级与尚未覆盖的范围
  blocker: text.nullable(), // 受阻原因；outcome 为 blocked 时工具入口要求填写
  nextThink: NextThinkSchema, // 机器人提出的下一次思考安排
  ownerQuestion: z.strictObject({
    text: nonempty, // 正文
    options: z.array(nonempty), // 提供给主人选择的答案
    defaultOption: nonempty, // 主人未及时回复时采用的默认答案
    whyNeeded: nonempty, // 为什么必须向主人提问
  }).nullable(), // 需要主人回答的问题；无需提问时为空
  reply: text.nullable(), // 给主人消息的直接回复，写入对话线程
  report: text.nullable(), // 机器人主动汇报的内容，写入线程并按重要度决定单推
  importance: finite.int('重要度必须是整数').min(1, '重要度至少为 1').max(10, '重要度最多为 10'), // 主动汇报的重要度，整数 1–10
  proposals: z.array(z.strictObject({
    title: nonempty, // 供主人和机器人识别的标题
    detail: nonempty, // 可供主人审阅的详细说明
    value: ratio, // 预估价值，范围 0–1
    confidence: ratio, // 可行性置信度，范围 0–1
  })), // 机器人提出的改进建议
  createdAt: timestamp, // 创建时间（Unix 毫秒）
});
export type Commit = z.infer<typeof CommitSchema>;

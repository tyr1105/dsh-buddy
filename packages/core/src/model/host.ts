/** 宿主适配契约：core 只认识这些消息和接口，不引用任何 DSH 包；宿主事件须先校验。 */
import { z } from 'zod';
import { ExternalSessionEventTypeSchema, VariantSchema } from './enums.js';
import type { Priority } from './enums.js';
import { count, nonempty, text, timestamp } from './primitives.js';
import type { ModelChoice } from './primitives.js';

// 来源固定标记为机器人中心，宿主据此识别自动投递而非主人亲自发言。
export const MESSAGE_SOURCE_KINDS = ['agent-hub'] as const;
export const MESSAGE_SOURCE_KIND_LABELS = { 'agent-hub': '机器人中心' } as const;
/** 校验投递来源标记，关联机器人、唤醒单和回合模式。 */
export const MessageSourceSchema = z.strictObject({
  kind: z.enum(MESSAGE_SOURCE_KINDS, { error: '消息来源必须是 agent-hub' }), // 固定来源 agent-hub
  wakeId: nonempty, // 本次唤醒单 id，同时作为投递幂等标识
  botId: nonempty, // 接收投递的机器人 id
  variant: VariantSchema, // 本回合的工作模式
});
export type MessageSource = z.infer<typeof MessageSourceSchema>;

// 所有回合事件都携带宿主会话与真实发生时间，core 无需读取当前系统时钟。
const eventBase = {
  sessionId: nonempty, // 事件所属的宿主会话 id
  at: timestamp, // 事件发生时间（Unix 毫秒）
};
/** 按事件类型校验专属字段，避免缺步骤数或错误正文的事件进入回合守卫。 */
export const TurnEventSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('started'), // 宿主开始运行回合
    ...eventBase,
  }),
  z.strictObject({
    type: z.literal('step'), // 宿主完成了新的执行步骤
    ...eventBase,
    steps: count, // 当前累计执行步数
    tokens: count.nullable(), // 当前实际 token 用量；宿主未知时为 null
  }),
  z.strictObject({
    type: z.literal('tool_call'), // 一次 DSH 工具调用有了结果，用于账本过程下钻
    ...eventBase,
    name: nonempty, // 工具名，例如 read_file / write_file
    callId: text, // 宿主调用 id，用于和 tool/result 配对；拿不到时为空
    args: z.unknown().optional(), // 宿主提供的参数；只用于生成摘要，不原样落盘
    isError: z.boolean(), // 宿主标记的工具结果是否失败
    resultText: text, // 工具结果摘要；宿主未提供结果时为空
  }),
  z.strictObject({
    type: z.literal('ended'), // 宿主回合已实际结束
    ...eventBase,
    finalText: text, // 宿主最后一段回复正文
    tokens: count.nullable(), // 本回合实际 token 总量；宿主未知时为 null
  }),
  z.strictObject({
    type: z.literal('interrupted'), // 主人主动打断，不记作未交账或错误
    ...eventBase,
    by: z.literal('owner', { error: '打断来源必须是 owner（主人）' }),
  }),
  z.strictObject({
    type: z.literal('error'), // 宿主回合发生错误
    ...eventBase,
    errorText: nonempty, // 可用于错误分类与告警的原始错误说明
  }),
  z.strictObject({
    type: z.literal('awaiting_approval'), // 宿主自己的审批框正在等待
    ...eventBase,
    tool: nonempty, // 被宿主审批阻塞的工具名
    summary: text, // 待审批动作的说明
  }),
  z.strictObject({
    type: z.literal('owner_direct'), // 主人在已有机器人会话中直接发言
    ...eventBase,
    text, // 主人的原始输入
  }),
], { error: '回合事件类型或内容无效' });
export type TurnEvent = z.infer<typeof TurnEventSchema>;
/** 校验其他会话的完成或出错事件，供 session 关注项生成感知。 */
export const ExternalSessionEventSchema = z.strictObject({
  type: ExternalSessionEventTypeSchema, // 会话完成或出错
  sessionId: nonempty, // 外部宿主会话 id
  title: text, // 外部会话标题，用于关注项关键词匹配
  at: timestamp, // 事件发生时间（Unix 毫秒）
  summary: text, // 完成结果或错误的简要说明
});
export type ExternalSessionEvent = z.infer<typeof ExternalSessionEventSchema>;
/** 校验工具守卫的决定，拒绝时必须给模型可理解的理由。 */
export const GuardDecisionSchema = z.discriminatedUnion('allow', [
  z.strictObject({
    allow: z.literal(true), // 明确允许本次工具执行
  }),
  z.strictObject({
    allow: z.literal(false), // 明确拒绝本次工具执行
    message: nonempty, // 拒绝理由及下一步应如何处理
  }),
], { error: '守卫结果必须明确允许或拒绝，拒绝时需说明原因' });
export type GuardDecision = z.infer<typeof GuardDecisionSchema>;

/** 宿主注入的能力边界；core 通过此接口管理会话和通知，不依赖具体 DSH 实现。
 * 每个方法（含通知、取消、摘要查询）必须在 120 秒内返回或抛错，由宿主实现中止/超时。
 * 返回仅表示已受理，不等待整个模型回合结束；core 的后续 tick 保护不能替代宿主超时。
 */
export interface HostPort {
  /** 创建独立机器人会话并投递首条消息，返回宿主分配的身份供后续关联。 */
  createSession(input: {
    botId: string; // 会话所属机器人 id
    title: string; // 宿主会话标题
    cwd: string; // 会话工作目录
    rolePresetId: string; // 宿主角色预设 id
    permissionPresetId: string; // 宿主权限预设 id
    model: ModelChoice; // 指定模型或跟随宿主默认
    firstMessage: string; // 首次唤醒包正文
    source: MessageSource; // 中心投递来源，供宿主追踪与去重
  }): Promise<{
    sessionId: string; // 宿主新建的会话 id
  }>;
  /** 向已有会话投递唤醒包，保持机器人同一线程的上下文连续。 */
  deliver(sessionId: string, text: string, source: MessageSource): Promise<void>;
  /** 对运行中的回合补充指令，用于资源到限时提醒收口。 */
  steer(sessionId: string, text: string): Promise<void>;
  /** 取消超时或失控回合，使中心能够释放执行资源。 */
  cancel(sessionId: string): Promise<void>;
  /** 查询宿主会话真实状态，为会话轮换和回合恢复提供依据。 */
  sessionInfo(sessionId: string): Promise<{
    exists: boolean; // 会话是否仍存在
    running: boolean; // 会话是否正在运行回合
    contextRatio: number | null; // 上下文占用比例；宿主无法提供时为空
  }>;
  /** 列出最近会话供主人选择教学来源，数量由调用方限制。 */
  listRecentSessions(limit: number): Promise<Array<{
    sessionId: string; // 可供教学读取的宿主会话 id
    title: string; // 会话标题
    updatedAt: number; // 最近活动时间（Unix 毫秒）
  }>>;
  /** 读取有长度上限的会话摘要，供机器人从主人示范中提炼套路。 */
  readSessionDigest(sessionId: string, maxChars: number): Promise<string>;
  /** 通过宿主通知主人；免打扰和单推预算由 core 在调用前判定。 */
  notify(n: {
    title: string; // 通知标题
    body: string; // 通知正文
    level: Priority; // 紧急程度，P0 为紧急事件
    botId: string | null; // 相关机器人 id；全体通知为空
  }): Promise<void>;
}

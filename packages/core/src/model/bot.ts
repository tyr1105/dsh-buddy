/** 机器人档案与目标：只描述可存储事实，调度和生命周期推进留给后续任务。 */
import { z } from 'zod';
import * as e from './enums.js';
import { bool, count, nonempty, positive, ratio, recordId, text, timestamp, ModelChoiceSchema } from './primitives.js';

/** 校验机器人档案与运行状态，避免调度读取不完整的身份记录。 */
export const BotSchema = z.strictObject({
  id: recordId('b'), // 机器人 id，前缀 b_
  name: nonempty.max(20, '名字不能超过 20 字'), // 给主人显示的名称
  role: e.RoleSchema, // 执行风格：总管、调研、执行、盯守或建议
  persona: text.max(300, '性格说明不能超过 300 字'), // 性格与说话风格，最多 300 字，写入机器人身份文件
  color: nonempty, // 头像底色
  lifecycle: e.LifecycleSchema, // 草稿、试岗、在岗、暂停、隔离或退役状态
  pausedFrom: z.enum(['probation', 'active']).nullable().optional(), // 暂停前的资格；旧档案可缺省，恢复时保守按试岗截止推断
  activity: e.ActivitySchema, // 当前正在做什么
  activityText: text, // 界面直接显示的一句话状态
  autonomy: e.AutonomySchema, // 主人授予的自主等级 L0–L3
  pace: e.PaceProfileSchema, // 积极、正常或安静的节奏档
  model: ModelChoiceSchema, // 模型选择；空值表示跟随宿主默认模型
  homeDir: nonempty, // 机器人家目录 <root>/bots/<id>
  sessionId: nonempty.nullable(), // 宿主会话 id；空值表示尚未绑定会话
  sessionStartedAt: timestamp.nullable(), // 当前宿主会话开始时间（Unix 毫秒）
  // P74r10：当前会话建立时交给宿主的模型（取值范围同 model，null 表示当时跟随宿主默认）。
  // 缺省表示不知道（升级前建的会话）；与 model 不一致时下一次叫醒重建会话，见 memory/rotation.ts。
  sessionModel: ModelChoiceSchema.optional(),
  createdAt: timestamp, // 创建时间（Unix 毫秒）
  probationStartedAt: timestamp.optional(), // 实际开始试岗的时间；旧档案缺省时兼容使用创建时间
  probationEndsAt: timestamp.nullable(), // 试岗结束时间；空值表示不在试岗
  noChangeStreak: count, // 连续无变化的回合数，用于逐次退避
  lastThinkAt: timestamp.nullable(), // 最近一次思考时间；尚未思考时为空
  nextThinkAt: timestamp.nullable(), // 下一次思考时间；等待事件时可为空
  nextThinkReason: text.nullable(), // 安排下一次思考的理由
  nextThinkBy: e.NextThinkBySchema.nullable(), // 下一次思考由机器人还是中心提出
  nextThinkMode: e.NextThinkModeSchema.nullable(), // 指定时刻、稍后、等事件或自动安排
  lightCheckAt: timestamp.nullable(), // 最久思考间隔到期后轻复查的时间
  expectedBy: timestamp.nullable(), // 死人开关的预期活动截止时间
  consecutiveErrors: count, // 连续回合出错次数
  consecutiveNoCommit: count, // 连续没有交账的回合数
  violations: count, // 累计越界尝试次数
  retryAt: timestamp.nullable(), // 出错后允许重新排队的时间
  quarantineReason: text.nullable(), // 隔离原因；未隔离时为空
  releasedAt: timestamp.optional(), // 主人解除隔离的边界，旧故障与旧超量不重新累计
  quotaRest: z.strictObject({ activity: z.enum(['watching', 'queued']), activityText: text }).nullable().optional(), // 额度休息前的展示状态
  workDataAllowed: bool.default(false), // 是否允许接触工作数据，默认关闭
  presetSkillIds: z.array(nonempty).default([]), // P40 主人勾选的预置 skill id；空数组即未启用，行为与过去完全一致
  // P55 配置精简：以下字段旧档案都没有，读取时按默认值补齐，老队友行为不变。
  dshSkillNames: z.array(nonempty).default([]), // 主人从 DSH 技能目录里选的技能名
  temperament: e.TemperamentSchema.nullable().default(null), // 性格选择题；旧档案为空，身份文件沿用 persona 原文
  speechStyle: e.SpeechStyleSchema.nullable().default(null), // 说话风格选择题
  brief: text.max(1000, '员工说明不能超过 1000 字').default(''), // 员工说明：主人对这位队友的其他要求都写在这里
  onDemand: bool.default(false), // 听吩咐：只在被点名或派活时行动，见 scheduler/on-demand.ts
  // P48 归档：只在退役后可写；旧档案没有这个字段时按「未归档」读取，零迁移。
  archivedAt: timestamp.nullable().optional(),
  updatedAt: timestamp, // 最近修改时间（Unix 毫秒）
});
export type Bot = z.infer<typeof BotSchema>;

/**
 * 名册状态口径（P48）：活跃、退役、归档三者互斥，草稿/暂停/隔离归为非活跃。
 * - active：在岗或试岗，会接活、会被唤醒；
 * - retired：已退役，不唤醒，但仍留在左栏名单里；
 * - archived：已归档，不在名单显示，只出现在「已归档」折叠区；
 * - inactive：草稿、暂停、隔离，仍在名单里，但不接活。
 * 归档标记优先：只要 archivedAt 有值就视为归档，不受 lifecycle 影响。
 */
// P73a：'retired' 保留为类型成员以兼容旧调用方，但退役与归档已合并，botRosterState 不再产生它。
export type BotRosterState = 'active' | 'retired' | 'archived' | 'inactive';

/** 是否已归档；旧档案缺字段时返回 false，读取不报错。 */
export function botIsArchived(bot: Pick<Bot, 'archivedAt'>): boolean {
  return bot.archivedAt != null;
}

/**
 * P73a 员工状态投影（纯函数）：把存储用的六种 lifecycle 合并显示为在岗、停用、归档三种。
 * 为什么只做投影不改存储：调度、权限、额度等约 50 处判断仍按 lifecycle 读取，改存储风险大；
 * 投影让主人看到的状态简单，旧版本插件也仍能读懂数据。
 * - draft、probation、active -> 在岗；
 * - paused -> 停用（原因：你停用的）；quarantined -> 停用（原因：系统因连续出错停用）；
 * - retired -> 归档；archivedAt 有值而 lifecycle 不是 retired 的旧数据（防御）也按归档。
 */
export function staffStatus(bot: Pick<Bot, 'lifecycle' | 'archivedAt' | 'quarantineReason'>):
  { status: e.StaffStatus; label: string; reason: string | null } {
  let status: e.StaffStatus;
  let reason: string | null = null;
  if (bot.lifecycle === 'retired' || botIsArchived(bot)) status = 'archived';
  else if (bot.lifecycle === 'paused') { status = 'suspended'; reason = '你停用的'; }
  else if (bot.lifecycle === 'quarantined') { status = 'suspended'; reason = `连续出错，系统已停用：${bot.quarantineReason ?? '安全保护'}`; }
  else status = 'on_duty';
  return { status, label: e.STAFF_STATUS_LABELS[status], reason };
}

/** 名册状态：基于员工状态投影；在岗为 active，停用为 inactive，归档为 archived。 */
export function botRosterState(bot: Pick<Bot, 'lifecycle' | 'archivedAt'> & { quarantineReason?: string | null }): BotRosterState {
  const { status } = staffStatus({ quarantineReason: null, ...bot });
  if (status === 'archived') return 'archived';
  // 草稿虽然显示为在岗，但从未上岗、不接活；既有测试（p48）要求它仍是 inactive，保持不变。现有代码不再产生草稿。
  if (bot.lifecycle === 'draft') return 'inactive';
  if (status === 'suspended') return 'inactive';
  return 'active';
}

/** 校验长期志向及批准状态，保留目标的共同方向。 */
export const AspirationSchema = z.strictObject({
  id: recordId('asp'), // 记录的唯一标识；前缀区分记录类型
  botId: nonempty, // 所属机器人 id
  text: nonempty, // 长期志向内容
  status: e.AspirationStatusSchema, // 志向有效或已归档
  createdBy: e.CreatedBySchema, // 创建者：主人或机器人
  approved: bool, // 志向是否已经主人批准
  createdAt: timestamp, // 创建时间（Unix 毫秒）
});
export type Aspiration = z.infer<typeof AspirationSchema>;

/** 校验目标与完成标准，使进展和验收有据可查。 */
export const GoalSchema = z.strictObject({
  id: recordId('g'), // 记录的唯一标识；前缀区分记录类型
  botId: nonempty, // 所属机器人 id
  aspirationId: nonempty, // 所属长期志向 id
  title: nonempty, // 供主人和机器人识别的标题
  doneWhen: nonempty, // 可验证的完成标准
  period: e.GoalPeriodSchema, // 日、周、月或一次性目标周期
  periodEndsAt: timestamp.nullable(), // 本周期结束时间；一次性目标可为空
  importance: ratio, // 目标重要度，范围 0–1，默认值见 defaults.ts
  patienceMs: positive, // 没有进展时愿意等待的时长（毫秒）
  status: e.GoalStatusSchema, // 进行中、待验收、完成、放弃、受阻或提议中
  verification: e.GoalVerificationSchema, // 完成标准由规则还是主人验收
  lastProgressAt: timestamp, // 最近一次取得进展的时间
  createdBy: e.CreatedBySchema, // 创建者：主人或机器人
  createdAt: timestamp, // 创建时间（Unix 毫秒）
  updatedAt: timestamp, // 最近修改时间（Unix 毫秒）
});
export type Goal = z.infer<typeof GoalSchema>;

/** 校验议程的触发方式和放弃条件，让未来安排可以执行与关闭。 */
export const AgendaItemSchema = z.strictObject({
  id: recordId('a'), // 记录的唯一标识；前缀区分记录类型
  botId: nonempty, // 所属机器人 id
  kind: e.AgendaKindSchema, // 任务、跟进、条件触发、承诺或复查
  title: nonempty, // 供主人和机器人识别的标题
  goalId: nonempty.nullable(), // 关联目标 id；独立事项为空
  dueAt: timestamp.nullable(), // 真实到期时间；没有时间约定时为空
  onEvent: nonempty.nullable(), // 等待的关注项 id 或事件关键词
  abandonWhen: nonempty, // 放弃这件事的条件，必须明确写出
  priority: e.AgendaPrioritySchema, // 议程优先级，1 最高、5 最低
  toOwner: bool, // 是否是对主人的承诺，到期时更紧急
  source: e.AgendaSourceSchema, // 议程由主人、机器人、同伴或中心创建
  status: e.AgendaStatusSchema, // 待办、完成或放弃
  note: text.nullable(), // 处理时补充的说明
  createdAt: timestamp, // 创建时间（Unix 毫秒）
  updatedAt: timestamp, // 最近修改时间（Unix 毫秒）
});
export type AgendaItem = z.infer<typeof AgendaItemSchema>;

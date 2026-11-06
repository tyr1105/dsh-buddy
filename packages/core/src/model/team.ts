/** 团队协作与经验记录：套路、同伴邮件、交接、资源认领和规矩均保留独立身份。 */
import { z } from 'zod';
import * as e from './enums.js';
import { bool, count, nonempty, recordId, text, timestamp } from './primitives.js';

/** 校验可复用套路及学习来源，支持修订和使用记录。 */
export const RoutineSchema = z.strictObject({
  id: recordId('r'), // 记录的唯一标识；前缀区分记录类型
  botId: nonempty, // 所属机器人 id
  name: nonempty, // 给主人显示的名称
  slug: nonempty, // 稳定文件名片段，用于定位套路文件
  whenToUse: nonempty, // 适合使用此套路的场景
  steps: z.array(nonempty), // 按顺序执行的步骤清单
  learnedFrom: nonempty.nullable(), // 用于教学的原宿主会话 id
  runs: count, // 套路使用次数
  lastRunAt: timestamp.nullable(), // 最近使用套路的时间
  createdAt: timestamp, // 创建时间（Unix 毫秒）
  updatedAt: timestamp, // 最近修改时间（Unix 毫秒）
});
export type Routine = z.infer<typeof RoutineSchema>;
/** 校验同伴邮件，保留方向与交接关联。 */
export const MailSchema = z.strictObject({
  id: recordId('ml'), // 记录的唯一标识；前缀区分记录类型
  from: nonempty, // 发送机器人 id
  to: nonempty, // 接收机器人 id
  text, // 正文
  handoffId: nonempty.nullable(), // 关联交接单 id；普通邮件为空
  createdAt: timestamp, // 创建时间（Unix 毫秒）
  readAt: timestamp.nullable(), // 主人或收件方读取时间；未读时为空
});
export type Mail = z.infer<typeof MailSchema>;
/** 校验交接任务、文件与状态，使发起方能够跟踪接收和完成。 */
export const HandoffSchema = z.strictObject({
  id: recordId('h'), // 记录的唯一标识；前缀区分记录类型
  from: nonempty, // 交接发起机器人 id
  to: nonempty, // 接收机器人 id
  task: nonempty, // 需要交给同伴完成的任务说明
  files: z.array(nonempty), // 交接的文件路径列表
  status: e.HandoffStatusSchema, // 待接收、已接收、完成、拒绝或过期
  agendaId: nonempty.nullable(), // 接收后关联的议程项 id
  createdAt: timestamp, // 创建时间（Unix 毫秒）
  updatedAt: timestamp, // 最近修改时间（Unix 毫秒）
});
export type Handoff = z.infer<typeof HandoffSchema>;
/** 校验资源认领人与到期时间，支持互斥和自动释放。 */
export const ClaimSchema = z.strictObject({
  id: recordId('cl'), // 记录的唯一标识；前缀区分记录类型
  resource: nonempty, // 被认领的资源键，同一资源不能同时被多人持有
  botId: nonempty, // 所属机器人 id
  why: nonempty, // 创建或执行的理由
  expiresAt: timestamp, // 到期时间；无到期约束时可为空
  createdAt: timestamp, // 创建时间（Unix 毫秒）
});
export type Claim = z.infer<typeof ClaimSchema>;
/** 校验规矩作用范围与来源，区分生效要求和待审教训。 */
export const RuleSchema = z.strictObject({
  id: recordId('ru'), // 记录的唯一标识；前缀区分记录类型
  scope: nonempty, // global 表示全体规矩，否则是适用的机器人 id
  text: nonempty, // 正文
  redLine: bool, // 是否为不能越过的红线
  source: e.RuleSourceSchema, // 规矩来自主人要求或机器人教训
  status: e.RuleStatusSchema, // 有效、提议中或归档
  createdAt: timestamp, // 创建时间（Unix 毫秒）
});
export type Rule = z.infer<typeof RuleSchema>;

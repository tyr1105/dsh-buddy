/**
 * 通知队列（P76b，第五块）：表 pushQueue，每一行是一条待发或已处理的系统通知。
 *
 * 为什么要有队列：免打扰时段产生的通知要到点补发，同一时段的多条通知要合并成一条，这两件事都要「先存下来再发」。
 * 只有四类事会推送系统通知：要你确认的约定改动（agreement）；花钱、对外发布、不可撤销的动作（approval）；
 * 三轮核对不过或做不下去（escalation）；长时间没有进展（stall）。另有 system 一类给鉴权失败这类系统告警用。
 *
 * 保留期：已发出或已合并的行保留 30 天（NOTIFY_DEFAULTS.QUEUE_RETENTION_MS），由 P76h 的读写函数自己清理；
 * 不放进 RETENTION_MS_BY_COLLECTION（那是 Settings 里的 strictObject，加键会让旧版本读不出设置）。
 * 本文件只定义结构与校验。
 */
import { z } from 'zod';
import { nonempty, recordId, text, timestamp } from './primitives.js';

/** 通知的类别。 */
export const PUSH_CATEGORIES = ['agreement', 'approval', 'escalation', 'stall', 'system'] as const;
/** 一行的状态：等待发送、已发出、已合并进另一条、已丢弃。 */
export const PUSH_STATES = ['waiting', 'sent', 'merged', 'dropped'] as const;

/** 通知队列的一行（表 pushQueue）。 */
export const PushQueueRowSchema = z.strictObject({
  id: recordId('pq'),
  category: z.enum(PUSH_CATEGORIES, { error: '通知类别必须是 agreement、approval、escalation、stall、system 之一' }),
  title: nonempty, // 通知标题
  body: text, // 通知正文，可以为空
  subjectKey: nonempty, // 事项键，同一事项的通知据此去重、合并
  botId: nonempty.nullable(), // 相关员工；与员工无关为 null
  createdAt: timestamp, // 产生时间
  sendAfter: timestamp, // 不早于此时间发出（免打扰期间推到时段结束）
  state: z.enum(PUSH_STATES, { error: '通知状态必须是 waiting、sent、merged、dropped 之一' }),
  sentAt: timestamp.nullable(), // 实际发出时间；没发出为 null
  mergedInto: recordId('pq').nullable(), // 被合并进哪一行；没有为 null
  // 由「待你处理」条目建立触发的行记下条目编号：发出前据此核对条目是否还开着；直接调用 notifyOwner 的行没有这个字段。
  inboxId: nonempty.optional(),
});
export type PushQueueRow = z.infer<typeof PushQueueRowSchema>;

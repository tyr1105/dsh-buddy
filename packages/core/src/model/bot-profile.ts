/**
 * 队友性格档案：MBTI 等性格信息放在独立表里，按 botId 与机器人 1:1 关联。
 * 为什么不加进 Bot：旧版本用 strictObject 解析 bots.json，Bot 上多出的新字段会让旧版本整体读不出队友。
 * 独立表在新版本里读写，旧版本不认识这个文件会直接忽略，降级最安全。
 */
import { z } from 'zod';
import { MbtiTypeSchema } from './enums.js';
import { nonempty, timestamp } from './primitives.js';

/** 一条性格档案；id 与 botId 相同，保证 1:1 且重复写入天然幂等。 */
export const BotProfileSchema = z.strictObject({
  id: nonempty, // 档案 id，等于 botId
  botId: nonempty, // 关联的机器人
  mbti: MbtiTypeSchema.nullable(), // 16 型之一；null 表示主人明确未设置
  updatedAt: timestamp, // 最近修改时间（Unix 毫秒）
});
export type BotProfile = z.infer<typeof BotProfileSchema>;

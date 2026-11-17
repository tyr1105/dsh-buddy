/**
 * 主人上次打开（P76b，第五块）：表 ownerPresence，只有一行，id 固定为 owner。
 *
 * 用途：「离开期间摘要」。你超过 8 小时没打开 DSH Buddy，再打开时在总管私聊顶部显示一段按记录拼出的文字。
 * 中心自己看不到你有没有在看界面，所以由界面定期上报「最近一次打开」，写进 lastSeenAt；
 * away 存的是最近一次离开期间的摘要内容与是否已通知、是否已被你关掉。
 *
 * 与内存里的 ctx.runtime.ownerActiveAt 不同：那一项只在你发消息、确认约定时更新，只在内存里，用于并发上限，保留不动。
 * 本文件只定义结构与校验。
 */
import { z } from 'zod';
import { bool, count, text, timestamp } from './primitives.js';

/** 主人上次打开记录（表 ownerPresence，一行 id 为 owner）。 */
export const OwnerPresenceSchema = z.strictObject({
  id: z.literal('owner', { error: '主人上次打开记录的 id 必须为 owner' }),
  lastSeenAt: timestamp.nullable(), // 界面最近一次上报的时间；从没上报过为 null
  // 最近一次离开期间的摘要；没有为 null
  away: z.strictObject({
    from: timestamp, // 离开起点
    to: timestamp, // 离开终点（再次打开的时间）
    lines: z.array(text), // 摘要的各行文字
    totalTurns: count, // 离开期间员工共做了几个回合
    totalTokens: count, // 离开期间共用了多少实测 token
    notified: bool, // 是否已经推送过通知
    dismissedAt: timestamp.nullable(), // 你关掉摘要的时间；没关为 null
  }).nullable(),
  updatedAt: timestamp,
});
export type OwnerPresence = z.infer<typeof OwnerPresenceSchema>;

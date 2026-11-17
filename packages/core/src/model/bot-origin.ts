/**
 * 员工来历（P73c）：一位员工从哪里来、什么时候入职、入职前被主人改过什么。
 *
 * 为什么单独建表而不是给 Bot 加字段：BotSchema 是 strictObject，旧版本读到 Bot 上多出的字段
 * 会整体读不出员工（同 bot-profile.ts 的做法）；独立的新表旧版本直接忽略，降级最安全。
 *
 * 旧员工没有来历记录：读取时按 legacy 处理（joinedAt 取创建时间），不补写、不迁移。
 * 「报到」按 joinedAt 判断是不是今天入职；legacy 一律不报到，避免升级当天所有人都显示报到。
 */
import { z } from 'zod';
import { MbtiTypeSchema } from './enums.js';
import { nonempty, recordId, timestamp } from './primitives.js';
import type { Store } from '../store/interfaces.js';

/** 来历类型：初始组队、按需加人、从模板库添加、自己从头配置、自动建的总管、旧员工。 */
export const BOT_ORIGIN_SOURCES = ['team_initial', 'team_addition', 'library', 'custom', 'auto_chief', 'legacy'] as const;
export const BotOriginSourceSchema = z.enum(BOT_ORIGIN_SOURCES, { error: '来历类型不正确' });
export type BotOriginSource = z.infer<typeof BotOriginSourceSchema>;

export const BotOriginSchema = z.strictObject({
  id: recordId('b'), // 等于 botId，保证一位员工一条记录，重复写入天然幂等
  botId: recordId('b'),
  templateId: nonempty.nullable(), // 自己从头配置的为 null
  source: BotOriginSourceSchema,
  proposalId: recordId('tpr').nullable(),
  joinedAt: timestamp, // 入职时间；「报到」按它判断是不是今天
  renamedFrom: nonempty.nullable(), // 组队卡里改过名时的建议名
  mbtiSuggested: MbtiTypeSchema.nullable(), // 组队卡里改过性格时的建议值
  modelTierSuggested: z.enum(['standard', 'light']).nullable(), // 组队卡里改过模型档位时的建议值
}).superRefine((origin, ctx) => {
  if (origin.id !== origin.botId) ctx.addIssue({ code: 'custom', path: ['id'], message: 'id 必须等于 botId' });
});
export type BotOrigin = z.infer<typeof BotOriginSchema>;

/**
 * 读一位员工的来历；没有记录时返回 legacy 默认值，不写表。
 * 员工本身不存在时 joinedAt 取 0（调用方不应走到这里）。
 */
export function originOf(ctx: { store: Pick<Store, 'table'> }, botId: string): BotOrigin {
  const stored = ctx.store.table('botOrigins').get(botId);
  if (stored) return stored;
  const bot = ctx.store.table('bots').get(botId);
  return {
    id: botId, botId, templateId: null, source: 'legacy', proposalId: null,
    joinedAt: bot?.createdAt ?? 0, renamedFrom: null, mbtiSuggested: null, modelTierSuggested: null,
  };
}

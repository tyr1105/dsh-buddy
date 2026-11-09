/**
 * 队友性格档案的读写与旧数据迁移。
 * MBTI 不进 Bot 本体：旧版本用 strictObject 解析 bots.json，多出的字段会让它整体读不出队友。
 * 这里是唯一读写入口，唤醒包、API 和迁移都从同一处取，避免两套口径。
 */
import type { HubContext } from '../engine/context.js';
import type { Bot, BotProfile, MbtiType } from '../model/index.js';
import { MbtiTypeSchema } from '../model/enums.js';

/** 读取某位队友的 MBTI；没有档案行或档案里是 null 都表示未设置。 */
export function botMbti(ctx: HubContext, botId: string): MbtiType | null {
  // 表加载兼容旧记录；脏值不能被字符串前缀猜成某种性格，也不能让后续候选报错。
  const result = MbtiTypeSchema.safeParse(ctx.store.table('botProfiles').get(botId)?.mbti ?? null);
  return result.success ? result.data : null;
}

/** 保存 MBTI：id 固定等于 botId，重复保存天然幂等，不产生第二条档案。 */
export function saveBotMbti(ctx: HubContext, botId: string, mbti: MbtiType | null): BotProfile {
  const row: BotProfile = { id: botId, botId, mbti, updatedAt: ctx.clock.now() };
  ctx.store.table('botProfiles').put(row);
  return row;
}

/**
 * 把早期版本误写进 Bot 本体的 mbti 搬到 botProfiles，并从 bots 记录里剥掉。
 * 幂等：第二次运行找不到 mbti 字段就直接返回；档案已存在时不覆盖主人后来的选择。
 * 返回值是本次迁移的机器人数，便于日志与测试。
 */
export function migrateBotMbti(ctx: HubContext): number {
  const bots = ctx.store.table('bots');
  const profiles = ctx.store.table('botProfiles');
  let migrated = 0;
  for (const bot of bots.list()) {
    const legacy = bot as unknown as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(legacy, 'mbti')) continue;
    const parsed = MbtiTypeSchema.safeParse(legacy.mbti);
    if (profiles.get(bot.id) === null && parsed.success) {
      profiles.put({ id: bot.id, botId: bot.id, mbti: parsed.data, updatedAt: ctx.clock.now() });
    }
    // 无论值是否合法都从 Bot 记录里移除：旧版本读到未知字段会整表解析失败。
    const cleaned: Record<string, unknown> = { ...legacy };
    delete cleaned.mbti;
    bots.put(cleaned as unknown as Bot);
    migrated += 1;
  }
  return migrated;
}

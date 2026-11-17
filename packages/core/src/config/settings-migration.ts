/**
 * P76b：启动时的一次性设置迁移（P76-plan 7.10.3）。
 *
 * 为什么要迁移：设置是整份存进表里的，主人保存过一次设置之后，表里留着旧默认值，新默认值对他不生效。
 * 本迁移只处理两种情况：存档里的值严格等于旧默认值（说明主人没改过）时换成新默认值；
 * 主人改过的值一律保留，唯一例外是「员工自己发起的工作」每天回合数大于界面上限（10）时收到 10。
 * 被取消的设置字段（日报时间、每日推送条数等）值留在存档里不动，不删字段（Settings 是 strictObject，删了旧版本读不出）。
 *
 * 做一次：迁移表里的 p76-settings 一行记录状态，done 之后不再做，主人以后把值改回旧值也不会再被改。
 * 宿主传入的设置（deps.settings）不迁移，宿主明确传的值优先（与 resolveStartupSettings 的现状一致）。
 *
 * 分两部分：migrateSettingsP76 是纯函数（只算不写），runSettingsMigrationP76 负责读写迁移表、设置表和审计。
 */
import type { HubContext } from '../engine/context.js';
import { writeOutreachAudit } from '../outreach/audit.js';
import { BUDGET_DEFAULTS, P76_SETTINGS_REPLACEMENTS, resolveSettings, resolveStartupSettings } from './defaults.js';
import type { Settings } from '../model/settings.js';

/** 迁移表里这一行的 id。 */
export const P76_MIGRATION_ID = 'p76-settings';

/** 一项被换掉的设置：路径（用点连接）、旧值、新值。 */
export interface SettingChange { path: string; from: unknown; to: unknown }

/** 是不是普通对象（排除数组和 null）。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 纯函数：对已持久化的原始设置算出迁移后的样子，并列出换掉了哪几项。
 * 输入为 undefined 或不是对象时原样返回、changed 为空；不修改输入对象（先深拷贝）。
 */
export function migrateSettingsP76(persisted: unknown): { next: unknown; changed: SettingChange[] } {
  if (!isPlainObject(persisted)) return { next: persisted, changed: [] };
  const next = structuredClone(persisted);
  const changed: SettingChange[] = [];
  // 第一类：沿路径取值，严格等于旧默认值才换成新默认值；路径中间缺了或不是对象就跳过。
  for (const rule of P76_SETTINGS_REPLACEMENTS) {
    const path: readonly string[] = rule.path;
    let holder: unknown = next;
    for (const key of path.slice(0, -1)) holder = isPlainObject(holder) ? holder[key] : undefined;
    const last = path[path.length - 1]!;
    if (!isPlainObject(holder) || holder[last] !== rule.from) continue;
    holder[last] = rule.to;
    changed.push({ path: path.join('.'), from: rule.from, to: rule.to });
  }
  // 第二类：主人保留的每日回合数大于新界面上限时收到上限。
  const budget = next.botDailyTurnBudget;
  if (typeof budget === 'number' && budget > BUDGET_DEFAULTS.SELF_WORK_UI_MAX) {
    next.botDailyTurnBudget = BUDGET_DEFAULTS.SELF_WORK_UI_MAX;
    changed.push({ path: 'botDailyTurnBudget', from: budget, to: BUDGET_DEFAULTS.SELF_WORK_UI_MAX });
  }
  return { next, changed };
}

/** 写迁移行：attempts 每尝试一次加一；written、steps 本迁移不用，写空对象。 */
function putMigrationRow(ctx: HubContext, state: 'done' | 'failed', attempts: number, error: string | null): void {
  ctx.store.table('migrations').put({ id: P76_MIGRATION_ID, state, attempts, written: {}, steps: {}, error, updatedAt: ctx.clock.now() });
}

/**
 * 启动时调用一次：读到的设置经迁移后写回设置表，并让 ctx.settings 与之同步。
 * hostSettings 是宿主传入的设置，只用来重算 ctx.settings（宿主优先），自己不迁移。
 * 迁移行已是 done 时什么都不做；校验不过时不写设置、迁移行记 failed 与原因，下次启动重试。
 */
export async function runSettingsMigrationP76(ctx: HubContext, persisted: unknown, hostSettings?: unknown): Promise<void> {
  const existing = ctx.store.table('migrations').get(P76_MIGRATION_ID);
  if (existing?.state === 'done') return;
  const attempts = (existing?.attempts ?? 0) + 1;
  // 新装：存储里没有设置，没有旧值可换，只记「已做过」。
  if (!isPlainObject(persisted)) {
    putMigrationRow(ctx, 'done', attempts, null);
    return;
  }
  const { next, changed } = migrateSettingsP76(persisted);
  if (changed.length > 0) {
    // 先校验再写：迁移后的对象不合格就整次不做，下次启动重试，绝不写入一份读不出来的设置。
    try {
      resolveSettings(next);
    } catch (error) {
      const reason = error instanceof Error && error.message !== '' ? error.message : '迁移后的设置校验不通过';
      ctx.logger.warn('P76 设置迁移：迁移后的设置校验不通过，没有写入，下次启动重试', { error: reason });
      putMigrationRow(ctx, 'failed', attempts, reason);
      return;
    }
    ctx.store.table('settings').put(next as Settings);
    ctx.settings = resolveStartupSettings(next, hostSettings);
    writeOutreachAudit(ctx, 'settings_migrated_p76', changed);
  }
  putMigrationRow(ctx, 'done', attempts, null);
}

/**
 * 名册读取（P73c）：组队服务共用的几个读存储的小函数。
 *
 * 为什么单独一个文件：自动建总管、三问、组队卡、卡内修改、入职、模板库添加都要问
 * 「现在在册几位」「哪些模板已经有人」「当前模型档位」，口径必须是同一份，不能各写一遍。
 * 「在册」= 未归档的员工（含总管、含停用），与 createBot 的数量口径一致。
 * 本文件不写任何东西。
 */
import type { HubContext } from '../engine/context.js';
import { staffStatus, type Bot } from '../model/bot.js';
import { readModelCatalog, type HubModelOption } from '../api/models.js';
import { isTemplateAdded, type BotTemplate } from './templates.js';
import { modelTiers, type ModelTiers } from './model-tiers.js';
import type { TeamRosterRow } from './rules.js';

/** 未归档的员工（含总管、含停用）。 */
export function liveBots(ctx: HubContext): Bot[] {
  return ctx.store.table('bots').list(bot => staffStatus(bot).status !== 'archived');
}

/** 未归档的总管；没有返回 null。 */
export function liveChief(ctx: HubContext): Bot | null {
  return liveBots(ctx).find(bot => bot.role === 'chief') ?? null;
}

/** 全名册（含已归档）：名字要全名册唯一，所以已归档的也要列入；templateId 取来历里的，没有为 null。 */
export function teamRoster(ctx: HubContext): TeamRosterRow[] {
  return ctx.store.table('bots').list().map(bot => ({
    name: bot.name,
    templateId: ctx.store.table('botOrigins').get(bot.id)?.templateId ?? null,
    archived: staffStatus(bot).status === 'archived',
  }));
}

/**
 * 某个模板是否已有在册员工：来历里的模板相同；没有来历模板（旧员工、自己配置的）时按名字规则判断。
 * 与 recommendInitialTeam 的「已在册」是同一口径。
 */
export function rosterHasTemplate(roster: readonly TeamRosterRow[], template: Pick<BotTemplate, 'id' | 'name'>): boolean {
  return roster.some(row => !row.archived && (row.templateId === null
    ? isTemplateAdded(template, [row])
    : row.templateId === template.id));
}

/**
 * 某个模板在册（未归档）员工有哪几位：来历里的模板相同；没有来历模板的旧员工按名字规则判断。
 * 组队工具和唤醒包「组队」段共用：要回答「这个模板已经有人了吗，是谁」。
 */
export function templateHolders(ctx: HubContext, template: Pick<BotTemplate, 'id' | 'name'>): Bot[] {
  // 总管不算任何一个可推荐模板的持有者（它的名字即使叫「研究员」，也不能顶替研究员）。
  return liveBots(ctx).filter(bot => bot.role !== 'chief').filter(bot => {
    const templateId = ctx.store.table('botOrigins').get(bot.id)?.templateId ?? null;
    return templateId === null
      ? isTemplateAdded(template, [{ name: bot.name, archived: false }])
      : templateId === template.id;
  });
}

/** 这位员工现在是否在岗（在岗员工可以直接接活；停用的不行）。 */
export function isOnDuty(bot: Bot): boolean {
  return staffStatus(bot).status === 'on_duty';
}

/** 最近一次算出的档位：视图是同步函数，读不了异步的模型目录，所以每次重新算档位时顺手存一份给视图用。 */
const tierCache = new WeakMap<HubContext, ModelTiers>();

/** 当前模型档位：读不到目录时按 null 处理（轻档不可用），不让组队因为目录故障而失败。算出后缓存给视图。 */
export async function currentTiers(ctx: HubContext): Promise<ModelTiers> {
  let catalog: HubModelOption[] | null = null;
  try { catalog = await readModelCatalog(ctx); } catch (error) { ctx.logger.warn('组队：模型目录读取失败，轻档按不可用处理', { error: String(error) }); }
  const tiers = modelTiers(catalog, ctx.settings.defaultModel);
  tierCache.set(ctx, tiers);
  return tiers;
}

/** 视图用：最近一次算出的档位；还没算过时按「轻档不可用」处理。 */
export function cachedTiers(ctx: HubContext): ModelTiers {
  return tierCache.get(ctx) ?? modelTiers(null, ctx.settings.defaultModel);
}

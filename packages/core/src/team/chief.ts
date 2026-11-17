/**
 * 自动建总管（P73c，方案 4.1）：中心启动时，名册里没有未归档的总管，就用「项目经理」模板建一位。
 *
 * 为什么自动建：第一次打开只有总管，由总管先开口问三个问题；主人不用先去模板库找「项目经理」。
 * 总管设为「听吩咐」（裁定 4）：自己不会因为内驱、定期自查而醒来，初始化期间不消耗模型额度。
 * 整个过程不调用模型、不排任何唤醒、不落线程消息。
 */
import type { HubContext } from '../engine/context.js';
import type { Bot } from '../model/bot.js';
import { closeAlert, raiseAlert } from '../health/alerts.js';
import { freeTemplateName, templateById } from './templates.js';
import { liveBots, liveChief } from './roster.js';

/** 「没有总管」告警的代码：同一个代码同时只开一条。 */
export const NO_CHIEF_ALERT_CODE = 'team:no_chief';
/** 自动建的总管默认叫这个名字；被占用时加序号。 */
export const CHIEF_DEFAULT_NAME = '总管';
/**
 * 自动建的总管的运行设置：听吩咐（不因内驱、定期自查而自己醒来）、L1、安静节奏。
 * 抽成常量是为了让测试夹具引用同一份取值，不再另抄一份而与真实总管走样（P74r2a）。
 */
export const CHIEF_AUTO_SETTINGS = { onDemand: true, autonomy: 'L1', pace: 'quiet' } as const;
/** 自动建的总管用的模板编号与来历（测试夹具同样引用这里）。 */
export const CHIEF_AUTO_TEMPLATE_ID = 'project-manager';
export const CHIEF_AUTO_SOURCE = 'auto_chief';

/**
 * 保证名册里有一位未归档的总管。返回新建的总管；已有或没建成返回 null。
 * - 已有：什么都不做（顺手关掉旧的「没有总管」告警）；
 * - 在册已满：不建，开一条告警，文字说清怎么办；
 * - 否则建：模板配置、听吩咐、L1、安静节奏、模型取设置里的默认模型，来历 auto_chief。
 */
export async function ensureChief(ctx: HubContext): Promise<Bot | null> {
  if (liveChief(ctx) !== null) {
    closeAlert(ctx, NO_CHIEF_ALERT_CODE, null);
    return null;
  }
  const max = ctx.settings.maxBots;
  if (liveBots(ctx).length >= max) {
    // 同一告警码只开一次：已经有开着的就不再写。
    const open = ctx.store.table('alerts').count(alert => alert.code === NO_CHIEF_ALERT_CODE && alert.botId === null && alert.status === 'open');
    if (open === 0) {
      raiseAlert(ctx, { code: NO_CHIEF_ALERT_CODE, botId: null, level: 'P1', immediate: true,
        text: `在册已满 ${max} 位，没有总管。请先归档一位员工，中心会自动补建总管。` });
    }
    return null;
  }
  // 动态导入：避免 team 目录与 api/bots.ts 之间的循环引用（原因见 hire.ts）。
  const { createBotInternal } = await import('../api/bots.js');
  const template = templateById(CHIEF_AUTO_TEMPLATE_ID);
  if (template === undefined) throw new Error('模板「项目经理」不存在，无法自动建总管');
  // 名字要全名册唯一（含已归档的）。
  const name = freeTemplateName(CHIEF_DEFAULT_NAME, ctx.store.table('bots').list().map(bot => bot.name));
  const chief = await createBotInternal(ctx, {
    name, role: 'chief', mbti: template.mbti, brief: template.brief, aspirations: [...template.aspirations],
    presetSkillIds: [...template.presetSkillIds], temperament: template.temperament, speechStyle: template.speechStyle,
    ...CHIEF_AUTO_SETTINGS, model: ctx.settings.defaultModel,
  }, { source: CHIEF_AUTO_SOURCE, templateId: template.id, proposalId: null, renamedFrom: null, mbtiSuggested: null, modelTierSuggested: null },
  { color: template.color });
  closeAlert(ctx, NO_CHIEF_ALERT_CODE, null);
  return chief;
}

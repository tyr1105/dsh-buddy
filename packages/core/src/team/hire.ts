/**
 * 入职（P73c，方案 4.6 第 2 至 4 步）：把组队卡里保留的候选逐位变成员工。初始组队卡和按需加人（P73d）共用。
 *
 * 顺序：先整体预检（任何写入之前），全部通过才逐位创建。
 * - 预检不通过：抛错，错误说清「第几位、名字、哪一项」，什么都不写；
 * - 某一位创建时出意外（例如家目录写不进）：这一位记为失败，已入职的保留，继续下一位，不回滚。
 *
 * 本函数只管创建员工和写来历，不改组队卡本身：组队卡处于待确认时不允许带结果，
 * 所以结果（hired、failed、not_hired）交给调用方在转为已确认时一并写入。不调用模型，不排任何唤醒。
 */
import type { HubContext } from '../engine/context.js';
import type { Bot } from '../model/bot.js';
import type { TeamCandidate, TeamOutcome, TeamProposal } from '../model/team-proposal.js';
import { tierToModel } from './model-tiers.js';
import { currentTiers, liveBots, rosterHasTemplate, teamRoster } from './roster.js';
import { templateById } from './templates.js';

export interface HireResult {
  /** 成功入职的员工，按卡上的顺序。 */
  hired: Bot[];
  /** 入职失败的候选和中文原因。 */
  failed: { name: string; error: string }[];
  /** 每位候选的结果（key 为候选编号）：保留的是 hired 或 failed，不要的是 not_hired。 */
  outcomes: Record<string, TeamOutcome>;
}

/** 预检：全部保留的候选都能入职才放行；任一不通过就抛错（此时什么都没写）。 */
function preflight(ctx: HubContext, proposal: TeamProposal): void {
  const roster = teamRoster(ctx);
  const kept = proposal.candidates.filter(candidate => !candidate.removed);
  const fail = (candidate: TeamCandidate, reason: string): never => {
    const position = proposal.candidates.indexOf(candidate) + 1;
    throw new Error(`第 ${position} 位「${candidate.name}」${reason}`);
  };
  for (const candidate of kept) {
    const template = templateById(candidate.templateId);
    if (template === undefined) fail(candidate, '：模板已不存在，请换一位');
    if (ctx.store.table('bots').count(row => row.name === candidate.name) > 0) fail(candidate, '：已有同名员工（含已归档的），请改名');
    if (template!.uniquePerTeam && rosterHasTemplate(roster, template!)) fail(candidate, `：${template!.name}全队一位，已有`);
  }
  const live = liveBots(ctx).length;
  if (live + kept.length > ctx.settings.maxBots) {
    throw new Error(`在册 ${live} 位，再入职 ${kept.length} 位会超过上限 ${ctx.settings.maxBots} 位，请先归档一位员工，或去掉几位`);
  }
}

/** 逐位入职。预检不通过抛错；创建中途失败的候选记 failed，不影响其他人。 */
export async function hireCandidates(ctx: HubContext, proposal: TeamProposal): Promise<HireResult> {
  preflight(ctx, proposal);
  // 动态导入：api/bots.ts 沿着 schemas、工具、收件箱一路会再引回本目录，静态导入会形成循环，
  // 让个别模块在初始化时拿到还没定义好的对象。
  const { createBotInternal } = await import('../api/bots.js');
  const tiers = await currentTiers(ctx);
  const result: HireResult = { hired: [], failed: [], outcomes: {} };
  for (const candidate of proposal.candidates) {
    if (candidate.removed) {
      result.outcomes[candidate.key] = { kind: 'not_hired' };
      continue;
    }
    const template = templateById(candidate.templateId)!;
    try {
      // 档位换成具体模型；轻档不可用时按标准档处理，不报错。
      const model = tierToModel(candidate.modelTier, tiers);
      const bot = await createBotInternal(ctx, {
        name: candidate.name, role: template.role, mbti: candidate.mbti, brief: candidate.brief ?? template.brief,
        presetSkillIds: [...template.presetSkillIds], aspirations: [...template.aspirations],
        temperament: template.temperament, speechStyle: template.speechStyle, model,
      }, {
        source: proposal.kind === 'initial' ? 'team_initial' : 'team_addition',
        templateId: candidate.templateId, proposalId: proposal.id,
        // 改过的才记建议值：来历里能看出主人在卡上动了什么。
        renamedFrom: candidate.name !== candidate.suggested.name ? candidate.suggested.name : null,
        mbtiSuggested: candidate.mbti !== candidate.suggested.mbti ? candidate.suggested.mbti : null,
        modelTierSuggested: candidate.modelTier !== candidate.suggested.modelTier ? candidate.suggested.modelTier : null,
      }, { color: template.color });
      result.hired.push(bot);
      result.outcomes[candidate.key] = { kind: 'hired', botId: bot.id };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const reason = /[㐀-鿿]/.test(message) ? message : `创建失败：${message}`;
      result.failed.push({ name: candidate.name, error: reason });
      result.outcomes[candidate.key] = { kind: 'failed', error: reason };
      ctx.logger.warn('组队入职：一位候选创建失败', { name: candidate.name, error: message });
    }
  }
  return result;
}

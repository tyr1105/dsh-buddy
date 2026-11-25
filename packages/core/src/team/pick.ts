/**
 * 总管按项目挑人（W11）：三问答完后，不再直接查规则表，而是叫醒总管跑一个回合，
 * 让它看主人的原话、项目背景和模板清单，从模板里挑 1 到 3 位、每位写一句理由。
 *
 * 为什么这样分工：挑谁要看项目，这一步交给模型；挑中之后的人设、守则、性格、档位仍取模板，
 * 人数上限、不重复岗位、轻档不可用换标准档这些硬规矩仍由这里的代码把关，总管绕不过去。
 *
 * 请总管挑人、超时兜底在 pick-request.ts（要排队，引用调度；放这里会让工具层引回调度，形成循环引用）。
 * 兜底：总管的回合没能排上、结束时没有出卡、或超过 PICK_TIMEOUT_MS 还没出卡，
 * 就按规则表出默认推荐（createInitialProposal 的 fallback），卡上写明总管没有参与。
 *
 * 这一回合由主人答第三问发起（ownerInitiated），每个团队只有这一次；不定时、不往外推送。
 */
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import { TEAM_DEFAULTS as D } from '../config/defaults.js';
import type { HubContext } from '../engine/context.js';
import { TeamProposalSchema, type TeamCandidate, type TeamModelTier, type TeamProposal } from '../model/team-proposal.js';
import type { MbtiType } from '../model/enums.js';
import { PRESET_SKILLS } from '../config/preset-skills.js';
import type { WakeTicket } from '../model/wake.js';
import { writeOutreachAudit } from '../outreach/audit.js';
import { newId } from '../util/ids.js';
import { assertChiefOwnerTurn, assertTemplateFree, resolveTemplate, tierFor } from './addition.js';
import { pendingOwnerConfirmOf } from './owner-confirm.js';
import { alternatesFor } from './rules.js';
import { currentTiers, liveBots, teamRoster } from './roster.js';
import { CHIEF_WAITING_TEXT, saveSetup, setChiefActivityText } from './setup-state.js';
import { freeTemplateName } from './templates.js';

import { awaitingPickOf } from './pick-key.js';

export { awaitingPickOf, isAwaitingPick, isPickTurn, pickSubjectKey, PICK_SUBJECT_PREFIX } from './pick-key.js';

/** 工具成功后的回执（给总管看）。 */
export const PICK_DONE_TEXT = '组队卡已记下，交账后发给主人。用一两句话告诉主人你挑了谁、各做什么；确认前不会入职。';

/** 总管挑人时给的一位：模板、在这个项目里做什么，以及可选的按项目调整。 */
export interface InitialPickArg {
  template: string;
  work: string;
  name?: string;
  brief?: string;
  mbti?: MbtiType;
  modelTier?: TeamModelTier;
  skills?: string[];
}

/** 技能编号或名字换成编号；找不到的报错并列出可选的。 */
function resolveSkills(refs: readonly string[]): string[] {
  const ids: string[] = [];
  for (const ref of refs) {
    const key = ref.trim();
    const skill = PRESET_SKILLS.find(item => item.id === key || item.name === key);
    if (skill === undefined) throw new Error(`skills：没有叫「${key}」的技能。可选：${PRESET_SKILLS.map(item => item.id).join('、')}`);
    if (!ids.includes(skill.id)) ids.push(skill.id);
  }
  return ids;
}

/**
 * 工具 hub_team_propose 的 initial 模式：总管为正在等挑人的三问出初始组队卡。
 * 全部校验在写入之前做完：调用者是总管、回合由主人发起、确实在等挑人、人数 1 到上限、
 * 模板存在且不是总管、同一张卡不重复、不与在册员工冲突、名字不重、技能存在。
 * 总管可以按项目调整名字、员工说明、性格、模型档位、技能；执行风格、红线、全队一位这些仍取模板，改不了。
 * 轻档不可用时一律换成标准档。卡片和挑人回合的回复一起，在交账后发出（postTeamCardsOfWake）。
 */
export async function runInitialPick(ctx: HubContext, botId: string, wake: WakeTicket, picks: readonly InitialPickArg[] | undefined): Promise<string> {
  assertChiefOwnerTurn(ctx, botId, wake);
  const tiers = await currentTiers(ctx);
  const setup = awaitingPickOf(ctx, botId);
  if (setup === null) throw new Error('现在没有等你挑人的初始组队：initial 只在主人答完组队三问之后用一次；按需加人请用 propose');
  if (picks === undefined || picks.length === 0) throw new Error('candidates：至少挑 1 位');
  const room = Math.max(0, ctx.settings.maxBots - liveBots(ctx).length);
  const limit = Math.min(D.INITIAL_MAX, room);
  if (limit === 0) throw new Error(`在册已满 ${ctx.settings.maxBots} 位，不能再推荐`);
  if (picks.length > limit) throw new Error(`candidates：最多挑 ${limit} 位（初始团队最多 ${D.INITIAL_MAX} 位，且不超过在册上限 ${ctx.settings.maxBots} 位）`);
  const pending = pendingOwnerConfirmOf(ctx, botId);
  if (pending !== null) throw new Error('主人面前已有一张待确认的卡，等它处理完再出组队卡');
  const templates = picks.map((pick, index) => {
    const template = resolveTemplate(pick.template);
    if (picks.slice(0, index).some(other => resolveTemplate(other.template).id === template.id)) {
      throw new Error(`candidates：「${template.name}」挑了两次，同一个模板只挑一次`);
    }
    assertTemplateFree(ctx, template);
    return template;
  });

  const taken = teamRoster(ctx).map(row => row.name);
  const candidates: TeamCandidate[] = templates.map((template, index) => {
    const pick = picks[index]!;
    let name: string;
    if (pick.name !== undefined) {
      name = pick.name.trim();
      if (name === '总管' || taken.includes(name)) throw new Error(`candidates.name：「${name}」已经有人用了，换一个名字`);
    } else {
      name = freeTemplateName(template.name, taken);
    }
    taken.push(name);
    const wantedTier = pick.modelTier ?? tierFor(template, tiers.lightAvailable);
    const modelTier = wantedTier === 'light' && !tiers.lightAvailable ? 'standard' : wantedTier;
    const mbti = pick.mbti ?? template.mbti;
    const brief = pick.brief === undefined || pick.brief.trim() === template.brief ? null : pick.brief.trim();
    const skills = pick.skills === undefined ? null : resolveSkills(pick.skills);
    const sameSkills = skills !== null && skills.length === template.presetSkillIds.length
      && skills.every(id => template.presetSkillIds.includes(id));
    return {
      key: (['c1', 'c2', 'c3'] as const)[index]!, templateId: template.id,
      suggested: { templateId: template.id, name, mbti, modelTier, ...(brief !== null ? { brief } : {}) },
      name, mbti, modelTier, removed: false, brief,
      alternates: alternatesFor(template.id).map(item => ({ templateId: item.templateId, mbti: item.mbti, label: item.label })),
      swappedFrom: null, outcome: null, work: pick.work.trim(), skills: sameSkills ? null : skills,
    };
  });
  const now = ctx.clock.now();
  const proposal: TeamProposal = TeamProposalSchema.parse({
    id: newId('tpr', ctx.rng), chiefId: botId, kind: 'initial', state: 'pending', rev: 1,
    agreementId: null, needReason: null, residentReason: null, candidates, cardMessageId: null, inboxId: null,
    sourceMessageId: null, wakeId: wake.id, decidedAt: null, decidedVia: null, rosterAfter: null,
    pickedBy: 'chief', createdAt: now, updatedAt: now,
  });
  ctx.store.table('teamProposals').put(proposal);
  saveSetup(ctx, setup, { state: 'proposed', proposalId: proposal.id });
  writeOutreachAudit(ctx, 'team_pick', { proposalId: proposal.id, setupId: setup.id, templateIds: templates.map(t => t.id) }, botId);
  setChiefActivityText(ctx, botId, CHIEF_WAITING_TEXT);
  ctx.emit(HUB_EVENT_SCOPES.bot, botId);
  return PICK_DONE_TEXT;
}

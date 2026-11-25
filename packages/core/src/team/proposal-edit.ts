/**
 * 组队卡内就地修改（P73c，方案 4.4）：改名、换一位、不要这位、改性格、改模型、恢复建议值。
 *
 * 全部是确定的数据改动，由中心直接写表：不调用模型、不排唤醒、不落线程消息。
 * 每次成功修改 rev 加 1，命令带的 rev 不等于当前值就拒绝（防止主人对着旧内容操作）；
 * 卡片不是待确认状态时一律拒绝。「待你处理」条目的正文和按钮文字就地同步，条目始终只有一条。
 * 错误信息全部中文，说清是哪一项不对。
 */
import { z } from 'zod';
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import type { HubContext } from '../engine/context.js';
import { parseInput } from '../engine/validation.js';
import { MbtiTypeSchema } from '../model/enums.js';
import { recordId } from '../model/primitives.js';
import { ModelTierSchema, type TeamCandidate, type TeamModelTier, type TeamProposal } from '../model/team-proposal.js';
import { TEAM_DEFAULTS as D } from '../config/defaults.js';
import { emitInboxChange } from '../outreach/inbox.js';
import { saveProposal, syncTeamInboxItem } from './cards.js';
import { alternatesFor, INITIAL_TEAM_TABLE } from './rules.js';
import { currentTiers, rosterHasTemplate, teamRoster } from './roster.js';
import { freeTemplateName, templateById } from './templates.js';

export const TEAM_EDIT_ACTIONS = ['rename', 'set_mbti', 'set_model', 'restore_mbti', 'restore_model', 'swap', 'remove', 'unremove'] as const;

const EditInputSchema = z.strictObject({
  proposalId: recordId('tpr'),
  rev: z.number({ error: '必须是整数' }).int('必须是整数').min(1, '修订号从 1 起'),
  key: z.enum(['c1', 'c2', 'c3'], { error: 'key：候选编号必须是 c1、c2、c3 之一' }),
  action: z.enum(TEAM_EDIT_ACTIONS, { error: 'action：不是可用的修改动作' }),
  value: z.union([z.string(), z.number()]).optional(),
});

/** 规则表里这个模板的默认档位（取表里第一次出现的建议档位）；表里没有的取标准档。 */
export function defaultTierFor(templateId: string): TeamModelTier {
  for (const seeds of Object.values(INITIAL_TEAM_TABLE)) {
    const seed = seeds.find(item => item.templateId === templateId);
    if (seed !== undefined) return seed.modelTier;
  }
  return 'standard';
}

/** 取字符串值：去首尾空白，必须有内容。 */
function stringValue(value: string | number | undefined, label: string): string {
  if (typeof value !== 'string') throw new Error(`value：${label}必须是文字`);
  return value.trim();
}

/**
 * 改一位候选。返回修改后的组队卡。
 * 任何一项不通过都直接抛错，此时什么都没写。
 */
export async function editTeamCandidate(ctx: HubContext, raw: unknown): Promise<TeamProposal> {
  const input = parseInput(EditInputSchema, raw, '组队卡修改');
  const proposal = ctx.store.table('teamProposals').get(input.proposalId);
  if (!proposal) throw new Error('proposalId：组队卡不存在');
  if (proposal.state !== 'pending') throw new Error('这张组队卡已经处理过，不能再修改');
  if (input.rev !== proposal.rev) throw new Error('卡片已更新，请在最新内容上操作');
  const candidate = proposal.candidates.find(item => item.key === input.key);
  if (!candidate) throw new Error('key：这张卡上没有这位候选');
  // 被去掉的候选只允许撤销。
  if (candidate.removed && input.action !== 'unremove') throw new Error('这位已经被去掉，请先撤销再修改');

  const next = await applyAction(ctx, proposal, candidate, input.action, input.value);
  const candidates = proposal.candidates.map(item => item.key === candidate.key ? next : item);
  let saved = saveProposal(ctx, proposal, { candidates, rev: proposal.rev + 1 });
  saved = syncTeamInboxItem(ctx, saved);
  ctx.emit(HUB_EVENT_SCOPES.thread, saved.chiefId);
  emitInboxChange(ctx, { botId: saved.chiefId });
  return saved;
}

/** 按动作算出这位候选的新样子；校验不通过抛错。 */
async function applyAction(
  ctx: HubContext, proposal: TeamProposal, candidate: TeamCandidate,
  action: (typeof TEAM_EDIT_ACTIONS)[number], value: string | number | undefined,
): Promise<TeamCandidate> {
  switch (action) {
    case 'rename': {
      const name = stringValue(value, '名字');
      const length = [...name].length;
      if (length < 1 || length > D.NAME_MAX_CHARS) throw new Error(`名字：必须是 1 到 ${D.NAME_MAX_CHARS} 字`);
      const taken = ctx.store.table('bots').count(row => row.name === name) > 0
        || proposal.candidates.some(other => other.key !== candidate.key && other.name === name);
      if (taken) throw new Error('名字：已有同名员工（含已归档的）或卡上已有同名的人，请换一个名字');
      return { ...candidate, name };
    }
    case 'set_mbti': {
      const parsed = MbtiTypeSchema.safeParse(value);
      if (!parsed.success) throw new Error('性格：必须是 16 型之一');
      return { ...candidate, mbti: parsed.data };
    }
    case 'set_model': {
      const parsed = ModelTierSchema.safeParse(value);
      if (!parsed.success) throw new Error('模型：必须是标准档或轻档');
      if (parsed.data === 'light' && !(await currentTiers(ctx)).lightAvailable) {
        throw new Error('轻档不可用：模型目录里没有可用的轻量模型');
      }
      return { ...candidate, modelTier: parsed.data };
    }
    case 'restore_mbti': return { ...candidate, mbti: candidate.suggested.mbti };
    case 'restore_model': return { ...candidate, modelTier: candidate.suggested.modelTier };
    case 'swap': return swapCandidate(ctx, proposal, candidate, value);
    case 'remove':
      if (proposal.kind === 'addition') throw new Error('这张卡上不能去掉这位员工；不新增请回复「不新增」');
      return { ...candidate, removed: true };
    case 'unremove':
      if (!candidate.removed) throw new Error('这位没有被去掉，不需要撤销');
      return { ...candidate, removed: false };
  }
}

/**
 * 换一位：换成事先算好的备选（序号 0 或 1）。
 * 换后模板、名字、性格、档位都取备选的值，「建议值」一并换成这组新值；
 * 第一次换人时记下原模板（来历用）；备选按新模板重算。
 * 目标模板已在册、或卡上别的候选已经是它，拒绝并说明（换性格即模板不变的备选不受限）。
 */
async function swapCandidate(ctx: HubContext, proposal: TeamProposal, candidate: TeamCandidate, value: string | number | undefined): Promise<TeamCandidate> {
  if (value !== 0 && value !== 1) throw new Error('value：备选序号必须是 0 或 1');
  const alternate = candidate.alternates[value];
  if (alternate === undefined) throw new Error('value：没有这个备选');
  const template = templateById(alternate.templateId);
  if (template === undefined) throw new Error('这个备选的模板已不存在');
  const sameTemplate = alternate.templateId === candidate.templateId;
  if (!sameTemplate) {
    if (rosterHasTemplate(teamRoster(ctx), template)) {
      throw new Error(template.uniquePerTeam ? `「${template.name}」全队一位，已有，不能换到这一位` : `「${template.name}」已经在册，不能换到这一位`);
    }
    if (proposal.candidates.some(other => other.key !== candidate.key && other.templateId === template.id)) {
      throw new Error(`这张卡上已经有「${template.name}」，不能再换到这一位`);
    }
  }
  const takenNames = [...ctx.store.table('bots').list().map(row => row.name),
    ...proposal.candidates.filter(other => other.key !== candidate.key).map(other => other.name)];
  const name = freeTemplateName(template.name, takenNames);
  const wanted = defaultTierFor(template.id);
  const modelTier: TeamModelTier = wanted === 'light' && !(await currentTiers(ctx)).lightAvailable ? 'standard' : wanted;
  return {
    ...candidate,
    templateId: template.id, name, mbti: alternate.mbti, modelTier,
    suggested: { templateId: template.id, name, mbti: alternate.mbti, modelTier,
      ...(sameTemplate && candidate.suggested.brief != null ? { brief: candidate.suggested.brief } : {}) },
    swappedFrom: sameTemplate ? candidate.swappedFrom : (candidate.swappedFrom ?? candidate.templateId),
    // 换了模板，原来改写的员工说明不再适用；只是换性格时保留。
    brief: sameTemplate ? candidate.brief : null,
    // W11：换了模板，总管为原来那位写的工作和选的技能也不再适用。
    ...(sameTemplate ? {} : { work: null, skills: null }),
    alternates: alternatesFor(template.id).map(item => ({ templateId: item.templateId, mbti: item.mbti, label: item.label })),
  };
}

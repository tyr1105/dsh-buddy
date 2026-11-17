/**
 * 按需加人的服务（P73d，方案 4.8）：总管为已固定的约定推荐一位新员工（propose），
 * 按主人的话修改待确认的组队卡（revise），撤下（withdraw）。工具 hub_team_propose 只做参数解析，规则全在这里。
 *
 * 几条原则（与第一块的约定服务同一做法）：
 * - 全部校验在任何写入之前做完：失败时不写表、不发消息、不耗随机数（取 id 排在校验之后）；
 * - 只有总管能用，且只能在「主人发起」的回合里用（主人发话、确认或回答叫醒的回合）；
 * - 同一条主人消息只能产生一张组队卡；同一条主人消息对同一张卡只能 revise 一次；
 * - 工具调用时只写表，卡片等本回合交账、reply 落楼之后才发（见 team/cards.ts 的 postTeamCardsOfWake，tick 兜底补发）；
 * - 「主人面前只有一张待确认的卡」由 team/owner-confirm.ts 集中判断。
 *
 * 给主人看的文字全部放在 addition-text.ts，不含工具名、机器人 id、内部编号。
 */
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import { TEAM_DEFAULTS as D } from '../config/defaults.js';
import type { HubContext } from '../engine/context.js';
import { TeamProposalSchema, type TeamCandidate, type TeamModelTier, type TeamProposal } from '../model/team-proposal.js';
import type { WakeTicket } from '../model/wake.js';
import { writeOutreachAudit } from '../outreach/audit.js';
import { emitInboxChange } from '../outreach/inbox.js';
import { postThread } from '../outreach/thread.js';
import { ownerMessageOfWake } from '../project/agreements.js';
import { newId } from '../util/ids.js';
import {
  PROPOSE_DONE_TEXT, REVISE_BRIEF_PHRASE, REVISE_DONE_TEXT, WITHDRAW_DONE_TEXT,
  reviseNoteText, reviseTemplatePhrase, withdrawnNoteText,
} from './addition-text.js';
import { suggestArchiveFor } from './archive-suggestion.js';
import { saveProposal, syncTeamInboxItem, withdrawTeamInboxItems } from './cards.js';
import { pendingOwnerConfirmOf, TEAM_PENDING_PROPOSE_ERROR } from './owner-confirm.js';
import { defaultTierFor } from './proposal-edit.js';
import { alternatesFor } from './rules.js';
import { currentTiers, isOnDuty, liveBots, teamRoster, templateHolders } from './roster.js';
import { clearChiefWaitingText, CHIEF_WAITING_TEXT, finishSetupFor, setChiefActivityText } from './setup-state.js';
import { BOT_TEMPLATES, findTemplate, freeTemplateName, type BotTemplate } from './templates.js';
import { withLabel } from '../util/name-label.js';

/** hub_team_propose 解析后的参数（字段含义见工具的参数说明）。 */
export interface TeamProposeArgs {
  mode?: 'propose' | 'revise' | 'withdraw';
  proposalId?: string;
  template?: string;
  agreementId?: string;
  needReason?: string;
  residentReason?: string;
  name?: string;
  brief?: string;
  reason?: string;
}

/** 可推荐的模板名：除总管外的全部模板，用顿号连接（报错和唤醒包里是同一份）。 */
export function recommendableTemplateNames(): string {
  return BOT_TEMPLATES.filter(template => template.role !== 'chief').map(template => template.name).join('、');
}

/**
 * 通用校验：调用者是总管，回合由主人发起。返回总管的 id。
 * 等级（L1）和复盘回合禁止由工具框架负责，这里只管这两条。
 */
function assertChiefOwnerTurn(ctx: HubContext, botId: string, wake: WakeTicket): void {
  const bot = ctx.store.table('bots').get(botId);
  if (!bot || bot.role !== 'chief') throw new Error('只有总管能推荐新员工');
  if (wake.ownerInitiated !== true) throw new Error('组队卡只能在主人发话、确认或回答叫醒的回合里提出或修改');
}

/** 找模板并做模板自身的校验（第 4 条）：找得到、不是总管类。 */
function resolveTemplate(ref: string): BotTemplate {
  const template = findTemplate(ref);
  if (template === null) throw new Error(`template：没有叫「${ref.trim()}」的模板。可推荐的模板：${recommendableTemplateNames()}`);
  if (template.role === 'chief') throw new Error('template：总管全队只能有一位');
  return template;
}

/** 模板与名册的冲突（第 6、7 条）：全队一位且已有；同一模板已有在岗员工。 */
function assertTemplateFree(ctx: HubContext, template: BotTemplate): void {
  const holders = templateHolders(ctx, template);
  if (template.uniquePerTeam && holders.length > 0) {
    const onDuty = holders.find(isOnDuty);
    throw new Error(onDuty !== undefined
      ? `template：${template.name}全队一位，已有${onDuty.name}，直接安排他`
      : `template：${template.name}全队一位，已有${holders[0]!.name}（已停用，请主人在员工卡片里恢复），不能再推荐`);
  }
  const onDuty = holders.find(isOnDuty);
  if (onDuty !== undefined) throw new Error(`template：在岗员工里已有${withLabel(template.name, onDuty.name)}，直接安排他`);
}

/** 在册已满时的拒绝文字：含建议归档谁、为什么（来自 suggestArchive）；没有合适的人时请主人自己决定。 */
function fullRosterError(ctx: HubContext): string {
  const pick = suggestArchiveFor(ctx);
  const advice = pick === null ? '请用一句话请主人决定归档哪一位' : `请用一句话建议主人先归档一位：建议归档${pick.name}，${pick.reasonText}`;
  return `在册已满 ${ctx.settings.maxBots} 位，不能推荐新员工。${advice}；归档在这位员工的卡片里操作。`;
}

/** 候选的建议档位：模板的默认档位；轻档不可用时取标准档。 */
function tierFor(template: BotTemplate, lightAvailable: boolean): TeamModelTier {
  const wanted = defaultTierFor(template.id);
  return wanted === 'light' && !lightAvailable ? 'standard' : wanted;
}

// ---------------------------------------------------------------------------
// propose
// ---------------------------------------------------------------------------

async function propose(ctx: HubContext, botId: string, wake: WakeTicket, args: TeamProposeArgs): Promise<string> {
  // 模型目录是异步读的：先读好，后面的校验和写入就是同步的，中间不会被别的调用插进来。
  const tiers = await currentTiers(ctx);
  // 1. 必填项一次列全。
  const missing = (['template', 'agreementId', 'needReason', 'residentReason'] as const).filter(key => args[key] === undefined);
  if (missing.length > 0) throw new Error(`缺少必填项：${missing.join('、')}（mode 为 propose 时都要填写）`);
  // 2. 约定：存在、是你的、已固定。
  const agreement = ctx.store.table('agreements').get(args.agreementId!);
  if (!agreement || agreement.botId !== botId || agreement.state !== 'locked') throw new Error('agreementId：只能为你名下已固定的约定加人');
  // 3. 互斥：主人面前只能有一张待确认的卡。
  const pending = pendingOwnerConfirmOf(ctx, botId);
  if (pending?.kind === 'agreement') throw new Error(`约定「${pending.agreement.title}」还在等主人确认，确认前不能推荐新员工`);
  if (pending?.kind === 'team') throw new Error(TEAM_PENDING_PROPOSE_ERROR);
  // 4. 模板。
  const template = resolveTemplate(args.template!);
  // 5. 在册已满。
  if (liveBots(ctx).length >= ctx.settings.maxBots) throw new Error(fullRosterError(ctx));
  // 6、7. 全队一位已有；同模板已有在岗员工。
  assertTemplateFree(ctx, template);
  // 8. 同一条主人消息只能产生一张组队卡（消息取不到时按唤醒单去重）。
  const message = ownerMessageOfWake(ctx, wake);
  const dup = ctx.store.table('teamProposals').list(row => row.chiefId === botId && row.kind === 'addition'
    && ((message !== null && row.sourceMessageId === message.id) || row.wakeId === wake.id))[0];
  if (dup !== undefined) throw new Error('主人的这句话已经出过一张组队卡了，同一句话只出一张');

  // 9. 建组队卡：一位候选，名字、性格、档位取模板建议值。
  const name = freeTemplateName(template.name, teamRoster(ctx).map(row => row.name));
  const mbti = template.mbti;
  const modelTier = tierFor(template, tiers.lightAvailable);
  const candidate: TeamCandidate = {
    key: 'c1', templateId: template.id,
    suggested: { templateId: template.id, name, mbti, modelTier },
    name, mbti, modelTier, removed: false, brief: null,
    alternates: alternatesFor(template.id).map(item => ({ templateId: item.templateId, mbti: item.mbti, label: item.label })),
    swappedFrom: null, outcome: null,
  };
  const now = ctx.clock.now();
  const proposal = TeamProposalSchema.parse({
    id: newId('tpr', ctx.rng), chiefId: botId, kind: 'addition', state: 'pending', rev: 1,
    agreementId: agreement.id, needReason: args.needReason!, residentReason: args.residentReason!,
    candidates: [candidate], cardMessageId: null, inboxId: null,
    sourceMessageId: message?.id ?? null, wakeId: wake.id,
    decidedAt: null, decidedVia: null, rosterAfter: null, createdAt: now, updatedAt: now,
  });
  ctx.store.table('teamProposals').put(proposal);
  writeOutreachAudit(ctx, 'team_propose', { proposalId: proposal.id, agreementId: agreement.id, templateId: template.id, name }, botId);
  setChiefActivityText(ctx, botId, CHIEF_WAITING_TEXT);
  ctx.emit(HUB_EVENT_SCOPES.bot, botId);
  return PROPOSE_DONE_TEXT;
}

// ---------------------------------------------------------------------------
// revise / withdraw
// ---------------------------------------------------------------------------

/** 取调用者自己名下待确认的组队卡（revise、withdraw 共用）。 */
function ownPendingProposal(ctx: HubContext, botId: string, proposalId: string | undefined): TeamProposal {
  if (proposalId === undefined) throw new Error('proposalId：revise 和 withdraw 必须填写组队卡编号（唤醒包「组队」段里有）');
  const proposal = ctx.store.table('teamProposals').get(proposalId);
  if (!proposal || proposal.chiefId !== botId || proposal.state !== 'pending') throw new Error('proposalId：只能修改或撤下你名下待确认的组队卡');
  return proposal;
}

/** 这条主人消息是否已经修改过这张卡（记在审计里，不改组队卡的存储结构）。 */
function alreadyRevisedBy(ctx: HubContext, proposalId: string, messageId: string): boolean {
  return ctx.store.log('audit').all().some(row => {
    if (row.action !== 'team_revise') return false;
    try {
      const detail = JSON.parse(row.detail) as { proposalId?: string; messageId?: string };
      return detail.proposalId === proposalId && detail.messageId === messageId;
    } catch { return false; }
  });
}

/** 按名字找卡上的候选；省略名字时卡上必须只有一位没被去掉的。 */
function pickCandidate(proposal: TeamProposal, name: string | undefined): TeamCandidate {
  if (name === undefined) {
    const kept = proposal.candidates.filter(candidate => !candidate.removed);
    if (kept.length !== 1) throw new Error('name：卡上有几位，请写明改哪一位');
    return kept[0]!;
  }
  const found = proposal.candidates.find(candidate => candidate.name === name.trim());
  if (found === undefined) throw new Error(`name：卡上没有叫「${name.trim()}」的人。卡上的名字：${proposal.candidates.map(candidate => candidate.name).join('、')}`);
  if (found.removed) throw new Error(`name：「${found.name}」已被主人去掉，不能修改`);
  return found;
}

/** 换模板：效果与卡内「换一位」相同（建议值同步、记录原模板），目标是任意可推荐的模板。 */
function swapToTemplate(ctx: HubContext, proposal: TeamProposal, candidate: TeamCandidate, template: BotTemplate, lightAvailable: boolean): TeamCandidate {
  if (template.id === candidate.templateId) throw new Error(`template：卡上这位已经是「${template.name}」`);
  assertTemplateFree(ctx, template);
  if (proposal.candidates.some(other => other.key !== candidate.key && other.templateId === template.id)) {
    throw new Error(`template：这张卡上已经有「${template.name}」`);
  }
  const taken = [...ctx.store.table('bots').list().map(row => row.name),
    ...proposal.candidates.filter(other => other.key !== candidate.key).map(other => other.name)];
  const name = freeTemplateName(template.name, taken);
  const modelTier = tierFor(template, lightAvailable);
  return {
    ...candidate, templateId: template.id, name, mbti: template.mbti, modelTier,
    suggested: { templateId: template.id, name, mbti: template.mbti, modelTier },
    swappedFrom: candidate.swappedFrom ?? candidate.templateId,
    // 换了模板，原来改写的员工说明不再适用。
    brief: null,
    alternates: alternatesFor(template.id).map(item => ({ templateId: item.templateId, mbti: item.mbti, label: item.label })),
  };
}

async function revise(ctx: HubContext, botId: string, wake: WakeTicket, args: TeamProposeArgs): Promise<string> {
  const tiers = await currentTiers(ctx);
  const proposal = ownPendingProposal(ctx, botId, args.proposalId);
  const message = ownerMessageOfWake(ctx, wake);
  if (message === null) throw new Error('组队卡只能根据主人的话修改：这一回合不是主人发消息叫醒的');
  if (alreadyRevisedBy(ctx, proposal.id, message.id)) throw new Error('主人的这句话已经改过这张组队卡了，同一句话只改一次');
  if (args.template === undefined && args.brief === undefined) throw new Error('template：与 brief：至少给一项（换模板，或给出完整的员工说明）');
  const candidate = pickCandidate(proposal, args.name);
  // 员工说明整段替换：先校验，空白拒绝（长度由参数层和卡片校验把关）。
  if (args.brief !== undefined && args.brief.trim() === '') throw new Error('brief：员工说明不能是空白');
  if (args.brief !== undefined && [...args.brief.trim()].length > D.BRIEF_MAX_CHARS) throw new Error(`brief：员工说明不能超过 ${D.BRIEF_MAX_CHARS} 字`);

  let next: TeamCandidate = candidate;
  const changes: string[] = [];
  if (args.brief !== undefined) changes.push(REVISE_BRIEF_PHRASE);
  if (args.template !== undefined) {
    const template = resolveTemplate(args.template);
    next = swapToTemplate(ctx, proposal, candidate, template, tiers.lightAvailable);
    changes.push(reviseTemplatePhrase(template.name));
  }
  // 员工说明与换模板同时给出时，以这次给出的说明为准（换模板会清空旧说明，这里再写入新的）。
  if (args.brief !== undefined) next = { ...next, brief: args.brief.trim() };
  // 只改指定那一位，其他候选原样保留。
  const candidates = proposal.candidates.map(item => item.key === candidate.key ? next : item);
  let saved = saveProposal(ctx, proposal, { candidates, rev: proposal.rev + 1 });
  saved = syncTeamInboxItem(ctx, saved);
  // 旁白写「卡上这位原来的名字」：换模板后名字会变，主人看旁白要能对上刚才卡上的那位。
  postThread(ctx, { thread: saved.chiefId, from: 'hub', kind: 'system', text: reviseNoteText(candidate.name, changes), refId: saved.id });
  writeOutreachAudit(ctx, 'team_revise', { proposalId: saved.id, messageId: message.id, rev: saved.rev, changes }, botId);
  ctx.emit(HUB_EVENT_SCOPES.thread, saved.chiefId);
  emitInboxChange(ctx, { botId: saved.chiefId });
  return REVISE_DONE_TEXT;
}

function withdraw(ctx: HubContext, botId: string, args: TeamProposeArgs): string {
  const proposal = ownPendingProposal(ctx, botId, args.proposalId);
  if (args.reason === undefined) throw new Error('reason：withdraw 时必须填写撤下的原因');
  const saved = saveProposal(ctx, proposal, {
    state: 'withdrawn', decidedAt: ctx.clock.now(), decidedVia: 'chief',
    candidates: proposal.candidates.map(candidate => ({ ...candidate, outcome: { kind: 'not_hired' as const } })),
  });
  withdrawTeamInboxItems(ctx, saved.id, '总管已撤下');
  postThread(ctx, { thread: saved.chiefId, from: 'hub', kind: 'system', text: withdrawnNoteText(args.reason), refId: saved.id });
  if (saved.kind === 'initial') finishSetupFor(ctx, saved.id);
  clearChiefWaitingText(ctx, saved.chiefId);
  writeOutreachAudit(ctx, 'team_withdraw', { proposalId: saved.id, reason: args.reason }, botId);
  ctx.emit(HUB_EVENT_SCOPES.thread, saved.chiefId);
  ctx.emit(HUB_EVENT_SCOPES.bot, saved.chiefId);
  emitInboxChange(ctx, { botId: saved.chiefId });
  return WITHDRAW_DONE_TEXT;
}

/** 工具入口：通用校验后按 mode 分派，返回给模型看的一句话；失败抛中文错误且没有任何写入。 */
export async function runTeamPropose(ctx: HubContext, botId: string, wake: WakeTicket, args: TeamProposeArgs): Promise<string> {
  assertChiefOwnerTurn(ctx, botId, wake);
  switch (args.mode ?? 'propose') {
    case 'revise': return revise(ctx, botId, wake, args);
    case 'withdraw': return withdraw(ctx, botId, args);
    default: return propose(ctx, botId, wake, args);
  }
}

/**
 * 组队卡的生成、确认、拒绝（P73c，方案 4.3、4.6）。
 *
 * 为什么确认和拒绝都集中在这里：确认的入口有两个（卡片按钮、「待你处理」按钮），
 * 拒绝的入口有三个（卡片上全部去掉后确认、打字「不新增」、「待你处理」里「全部不要」），
 * 最后都落到同一个函数，所以无论主人从哪里操作，结果的形状完全一样。
 *
 * 整个过程不调用模型、不排任何唤醒：初始组队卡确认后没有人需要被叫醒。
 * 唯一的例外是「不新增」口令这条主人消息本身：它照常叫醒总管（由 sendOwnerMessage 原路径负责，不在这里）。
 * 卡内修改见 proposal-edit.ts（这里再导出）。
 */
import { HUB_EVENT_SCOPES } from '../api/event-scopes.js';
import type { HubContext } from '../engine/context.js';
import { parseInput } from '../engine/validation.js';
import { recordId } from '../model/primitives.js';
import {
  TeamProposalSchema, teamConfirmLabel, type TeamCandidate, type TeamProposal, type TeamSetup,
} from '../model/team-proposal.js';
import type { Bot } from '../model/bot.js';
import type { InboxItem, ThreadMessage } from '../model/outreach.js';
import { emitInboxChange } from '../outreach/inbox.js';
import { postThread, wakeForOwnerMessage } from '../outreach/thread.js';
import { saveProject } from '../project/service.js';
import { newId } from '../util/ids.js';
import { z } from 'zod';
import { CONFIRM_RECORD_TEXT } from './addition-text.js';
import {
  answerTeamInboxItems, parseTeamSubjectKey, postTeamCard, saveProposal, withdrawTeamInboxItems,
} from './cards.js';
import { hireCandidates } from './hire.js';
import { alternatesFor, INITIAL_CONCLUSION, isDeclinePhrase, recommendInitialTeam } from './rules.js';
import { currentTiers, liveBots, teamRoster } from './roster.js';
import { pendingOwnerConfirmOf } from './owner-confirm.js';
import { CHIEF_IDLE_TEXT, CHIEF_WAITING_TEXT, clearChiefWaitingText, finishSetupFor, saveSetup, setChiefActivityText } from './setup-state.js';

export { editTeamCandidate } from './proposal-edit.js';

/** 初始组队卡确认后总管落的固定句。 */
export const TEAM_READY_TEXT = '团队已就位。你交代的第一件真实的事，就是他们的试用；做完后我会告诉你每位做得怎样。现在可以直接把事情交给我。';
/** 现有员工已能覆盖主人要做的事、不需要发卡时总管落的固定句。 */
export const TEAM_NO_NEED_TEXT = '现有员工已能覆盖这类事。你可以直接把事情交给我。';
/**
 * W11：总管没能按项目挑人、改按规则表给默认推荐时，结论句前面加的一句。
 * 原因只分两种说法，不写内部状态；卡片上另有一行写明这是默认推荐。
 */
export function PICK_FALLBACK_PREFIX(reason: 'timeout' | 'no_card'): string {
  return reason === 'timeout'
    ? '挑人花的时间太久了，我先按默认给你推荐，之后随时可以换。'
    : '这次没能按你的项目挑人，我先按默认给你推荐，之后随时可以换。';
}
/** 拒绝新增时的中心旁白。 */
export const TEAM_DECLINED_TEXT = '你选择不新增员工。';

/** 总管名下待确认的组队卡（至多一张）；没有返回 null。 */
export function pendingTeamProposalOf(ctx: HubContext, chiefId: string): TeamProposal | null {
  return ctx.store.table('teamProposals').list(row => row.state === 'pending' && row.chiefId === chiefId)[0] ?? null;
}

// ---------------------------------------------------------------------------
// 生成初始组队卡
// ---------------------------------------------------------------------------

/**
 * 三问答完后生成初始组队卡（方案 4.3）。
 * 推荐 0 位：不发卡，总管落一句话，三问转 done；否则依次落结论句、卡片消息、「待你处理」条目，三问转 proposed。
 * 幂等：三问已经有组队卡、或不是 asking 状态时什么都不做。返回新卡；没发卡返回 null。
 */
export async function createInitialProposal(ctx: HubContext, setup: TeamSetup, options: { fallback?: 'timeout' | 'no_card' } = {}): Promise<TeamProposal | null> {
  const tiers = await currentTiers(ctx);
  // 等待模型目录期间记录可能已变，重新读一次再判断。
  const fresh = ctx.store.table('teamSetups').get(setup.id);
  if (fresh === null || fresh.proposalId !== null || fresh.state !== 'asking') return null;
  const picks = recommendInitialTeam(fresh.answers.work ?? 'mixed', teamRoster(ctx), tiers, ctx.settings.maxBots);
  if (picks.length === 0) {
    postThread(ctx, { thread: fresh.chiefId, from: fresh.chiefId, kind: 'chat', text: TEAM_NO_NEED_TEXT });
    saveSetup(ctx, fresh, { state: 'done' });
    setChiefActivityText(ctx, fresh.chiefId, CHIEF_IDLE_TEXT);
    return null;
  }
  // P73r3 S3：已有待确认的约定卡（或别的组队卡）时不生成组队卡，免得主人同时面对两张要确认的卡。
  // 三问保持 asking、答案不丢；等约定确认或撤下之后，由 tick 里的兜底检查（sweepTeamSetup）补发。
  if (pendingOwnerConfirmOf(ctx, fresh.chiefId) !== null) return null;
  const now = ctx.clock.now();
  const candidates: TeamCandidate[] = picks.map((pick, index) => ({
    key: (['c1', 'c2', 'c3'] as const)[index]!, templateId: pick.templateId,
    suggested: { templateId: pick.templateId, name: pick.name, mbti: pick.mbti, modelTier: pick.modelTier },
    name: pick.name, mbti: pick.mbti, modelTier: pick.modelTier, removed: false, brief: null,
    alternates: alternatesFor(pick.templateId).map(item => ({ templateId: item.templateId, mbti: item.mbti, label: item.label })),
    swappedFrom: null, outcome: null,
  }));
  const proposal = TeamProposalSchema.parse({
    id: newId('tpr', ctx.rng), chiefId: fresh.chiefId, kind: 'initial', state: 'pending', rev: 1,
    agreementId: null, needReason: null, residentReason: null, candidates, cardMessageId: null, inboxId: null,
    sourceMessageId: null, wakeId: null, decidedAt: null, decidedVia: null, rosterAfter: null,
    ...(options.fallback !== undefined ? { pickedBy: 'default' as const } : {}), createdAt: now, updatedAt: now,
  });
  ctx.store.table('teamProposals').put(proposal);
  // 先把三问转为 proposed 并记下组队卡，再落消息：中途出错也不会重复生成卡。
  saveSetup(ctx, fresh, { state: 'proposed', proposalId: proposal.id });
  // 结论在前、卡片在后。
  const conclusion = INITIAL_CONCLUSION(picks);
  postThread(ctx, { thread: proposal.chiefId, from: proposal.chiefId, kind: 'chat',
    text: options.fallback === undefined ? conclusion : `${PICK_FALLBACK_PREFIX(options.fallback)}${conclusion}` });
  postTeamCard(ctx, proposal);
  setChiefActivityText(ctx, proposal.chiefId, CHIEF_WAITING_TEXT);
  ctx.emit(HUB_EVENT_SCOPES.thread, proposal.chiefId);
  return ctx.store.table('teamProposals').get(proposal.id);
}

// ---------------------------------------------------------------------------
// 拒绝
// ---------------------------------------------------------------------------

/**
 * 拒绝：组队卡转 declined，全部候选记「没有入职」，条目撤回，落中心旁白；
 * 初始组队卡被拒绝时三问转 done，总管状态行恢复。via 记录是从哪条途径拒绝的。
 */
export function declineTeamProposal(ctx: HubContext, proposalId: string, via: 'button' | 'inbox' | 'text' | 'chief'): TeamProposal {
  const proposal = ctx.store.table('teamProposals').get(proposalId);
  if (!proposal) throw new Error('proposalId：组队卡不存在');
  if (proposal.state !== 'pending') throw new Error('这张组队卡已经处理过了');
  const saved = saveProposal(ctx, proposal, {
    state: 'declined', decidedAt: ctx.clock.now(), decidedVia: via,
    candidates: proposal.candidates.map(candidate => ({ ...candidate, outcome: { kind: 'not_hired' as const } })),
  });
  withdrawTeamInboxItems(ctx, proposalId, TEAM_DECLINED_TEXT);
  postThread(ctx, { thread: saved.chiefId, from: 'hub', kind: 'system', text: TEAM_DECLINED_TEXT, refId: saved.id });
  if (saved.kind === 'initial') finishSetupFor(ctx, saved.id);
  clearChiefWaitingText(ctx, saved.chiefId);
  ctx.emit(HUB_EVENT_SCOPES.thread, saved.chiefId);
  ctx.emit(HUB_EVENT_SCOPES.bot, saved.chiefId);
  return saved;
}

/**
 * 主人在总管私聊打了整句「不新增」一类的话：若总管恰好有一张待确认的组队卡、卡片已落楼、且这句话不早于卡片，就拒绝它。
 * 同步函数，任何异常都捕获后记日志并返回 false，绝不能让主人发消息失败。
 * 这条主人消息照常叫醒总管（主人说话即发起），所以这里不管叫醒。
 */
export function declineByText(ctx: HubContext, threadId: string, message: ThreadMessage): boolean {
  try {
    if (!isDeclinePhrase(message.text)) return false;
    const chief = ctx.store.table('bots').get(threadId);
    if (!chief || chief.role !== 'chief') return false;
    const pending = ctx.store.table('teamProposals').list(row => row.state === 'pending' && row.chiefId === threadId);
    if (pending.length !== 1) return false;
    const proposal = pending[0]!;
    if (proposal.cardMessageId === null) return false;
    const card = ctx.store.log('thread').recent(1, row => row.id === proposal.cardMessageId)[0];
    if (!card || card.createdAt > message.createdAt) return false;
    declineTeamProposal(ctx, proposal.id, 'text');
    return true;
  }
  catch (error) {
    ctx.logger.error('按口令拒绝组队卡失败', error);
    return false;
  }
}

// ---------------------------------------------------------------------------
// 确认
// ---------------------------------------------------------------------------

/**
 * 按需加人确认之后的钩子（P73d，方案 4.8 第 5、6 步）：
 * 一、把新员工加入约定所在项目的成员名单（审计里 actor 是总管、detail 带 byTeamProposal），否则他看不到项目文件夹
 *    （P74b 起派活本身也会把执行者加进成员，这里提前加入保证新员工入职后立刻能读项目文件夹，重复加入会被跳过）；
 * 二、中心以主人名义在总管私聊落一条「确认入职」，并用「主人消息叫醒」的同一个函数（与按钮确认约定叫醒总管用的是同一个）
 *    给总管排一次主人发起的唤醒：这次回合里总管用 hub_job_manage 按名字把活派给新员工，享受「总管在主人发起的回合里派活立即生效」的豁免，
 *    新员工 lastThinkAt 为空，也不受最短思考间隔限制。不新增任何豁免。
 * 没有人成功入职时什么都不做（没有可交接的人）。加入项目失败只记日志，不挡住叫醒总管。
 */
export async function afterAdditionConfirmed(ctx: HubContext, proposal: TeamProposal, hired: Bot[]): Promise<void> {
  if (hired.length === 0) return;
  const agreement = proposal.agreementId === null ? null : ctx.store.table('agreements').get(proposal.agreementId);
  const project = agreement === null ? null : ctx.store.table('projects').get(agreement.projectId);
  if (project !== null && project.archivedAt === null) {
    try {
      // saveProject 的 charter 缺省会被清成空串，所以把原值带上；其余字段不传即沿用原值。
      saveProject(ctx, { id: project.id, name: project.name, charter: project.charter, memberBotIds: [...project.memberBotIds, ...hired.map(bot => bot.id)] },
        proposal.chiefId, { byTeamProposal: proposal.id });
    } catch (error) {
      ctx.logger.error(`新员工加入项目失败，组队卡 ${proposal.id}`, error);
    }
  }
  const chief = ctx.store.table('bots').get(proposal.chiefId);
  if (!chief) return;
  const message = postThread(ctx, { thread: proposal.chiefId, from: 'owner', kind: 'chat', text: CONFIRM_RECORD_TEXT, refId: proposal.id });
  ctx.runtime.ownerActiveAt = ctx.clock.now();
  wakeForOwnerMessage(ctx, chief, message);
}

/**
 * 确认组队卡：全部校验在任何写入之前完成（预检不通过则组队卡保持待确认，错误返回给界面）。
 * via 为 button 时 rev 必须与卡片当前一致；inbox 取当前 rev（条目文字按当前卡片生成，主人点的就是当前内容）。
 * 保留 0 位时等同拒绝。不排任何唤醒。
 */
export async function confirmTeamProposal(ctx: HubContext, raw: { proposalId: string; rev: number; via: 'button' | 'inbox' }): Promise<TeamProposal> {
  const proposal = ctx.store.table('teamProposals').get(raw.proposalId);
  if (!proposal) throw new Error('proposalId：组队卡不存在');
  if (proposal.state !== 'pending') throw new Error('这张组队卡已经处理过了');
  if (raw.via === 'button' && raw.rev !== proposal.rev) throw new Error('卡片已更新，请在最新内容上确认');
  if (proposal.candidates.every(candidate => candidate.removed)) return declineTeamProposal(ctx, proposal.id, raw.via);
  const label = teamConfirmLabel(proposal);
  const result = await hireCandidates(ctx, proposal);
  const now = ctx.clock.now();
  const current = ctx.store.table('teamProposals').get(proposal.id) ?? proposal;
  const rosterAfter = liveBots(ctx).length;
  const saved = saveProposal(ctx, current, {
    state: 'confirmed', decidedAt: now, decidedVia: raw.via, rosterAfter,
    candidates: current.candidates.map(candidate => ({ ...candidate, outcome: result.outcomes[candidate.key] ?? { kind: 'not_hired' as const } })),
  });
  answerTeamInboxItems(ctx, saved.id, label);
  // 中心旁白：谁入职了、在册几位；有失败的逐条另说。
  if (result.hired.length > 0) {
    postThread(ctx, { thread: saved.chiefId, from: 'hub', kind: 'system', refId: saved.id,
      text: `${result.hired.map(bot => bot.name).join('、')}已入职，在册 ${rosterAfter} / ${ctx.settings.maxBots} 位。` });
  }
  for (const failure of result.failed) {
    postThread(ctx, { thread: saved.chiefId, from: 'hub', kind: 'system', refId: saved.id, text: `${failure.name}入职失败：${failure.error}` });
  }
  if (saved.kind === 'initial') {
    postThread(ctx, { thread: saved.chiefId, from: saved.chiefId, kind: 'chat', text: TEAM_READY_TEXT });
    finishSetupFor(ctx, saved.id);
  } else {
    clearChiefWaitingText(ctx, saved.chiefId);
    await afterAdditionConfirmed(ctx, saved, result.hired);
  }
  ctx.emit(HUB_EVENT_SCOPES.thread, saved.chiefId);
  emitInboxChange(ctx, { botId: saved.chiefId });
  for (const bot of result.hired) ctx.emit(HUB_EVENT_SCOPES.bot, bot.id);
  ctx.emit(HUB_EVENT_SCOPES.overview);
  ctx.emit(HUB_EVENT_SCOPES.office);
  return saved;
}

/** UiApi 命令的入参：卡片按钮确认，via 固定为 button。 */
const ConfirmCommandSchema = z.strictObject({
  proposalId: recordId('tpr'),
  rev: z.number({ error: '必须是整数' }).int('必须是整数').min(1, '修订号从 1 起'),
});

/** 界面命令：卡片上点确认按钮。 */
export function confirmTeamProposalCommand(ctx: HubContext, raw: unknown): Promise<TeamProposal> {
  const input = parseInput(ConfirmCommandSchema, raw, '确认组队卡');
  return confirmTeamProposal(ctx, { ...input, via: 'button' });
}

/**
 * 「待你处理」里点了确认按钮：只认当前按钮文字（与卡片按钮相同），等同卡片确认。
 * 返回更新后的条目（已回答；「全部不要」走拒绝路径时条目被撤回）。
 */
export async function confirmTeamFromInbox(ctx: HubContext, item: InboxItem, answer: string): Promise<InboxItem> {
  const proposalId = parseTeamSubjectKey(item.subjectKey);
  const proposal = proposalId === null ? null : ctx.store.table('teamProposals').get(proposalId);
  if (!proposal || proposal.state !== 'pending') throw new Error('组队卡已经处理过或不存在，这条事项已失效');
  if (answer.trim() !== teamConfirmLabel(proposal)) throw new Error('卡片已更新，请在最新内容上确认；要修改，请点「查看对话」在卡片上改');
  await confirmTeamProposal(ctx, { proposalId: proposal.id, rev: proposal.rev, via: 'inbox' });
  return ctx.store.table('inbox').get(item.id)!;
}

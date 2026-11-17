/**
 * 总管唤醒包的「组队」段（P73d，方案 5.3、任务卡 6.2）。
 *
 * 为什么要有这一段：总管调用 hub_team_propose 要写模板名、约定编号，调用 hub_job_manage 派活要写约定编号、新员工的名字。
 * 这些信息如果只在工具说明里，模型常常凭想象填写（第一块的教训）；由中心把「现在能填什么」直接写进唤醒包，
 * 模型照抄就能一次调用成功。
 *
 * 约定：
 * - 只给总管，只在完整回合里出现（与约定段同一条件，见 chief-packet.ts 的 wantsChiefSections）；
 * - 可截断，自身上限 TEAM_DEFAULTS.PACKET_MAX_BYTES，不计入原有预算；总管守则不可截断，不受这一段影响；
 * - 这一段是写给模型看的，可以出现工具名和编号；给主人看的文字不在这里；
 * - 只读存储，不写任何东西。
 */
import { TEAM_DEFAULTS as D } from '../config/defaults.js';
import type { HubContext } from '../engine/context.js';
import type { Bot } from '../model/bot.js';
import { MODEL_TIER_LABELS, type TeamProposal } from '../model/team-proposal.js';
import type { QueueEntry } from '../model/wake.js';
import { CONFIRM_RECORD_TEXT } from '../team/addition-text.js';
import { suggestArchiveFor } from '../team/archive-suggestion.js';
import { TEAM_QUESTIONS, isDeclinePhrase } from '../team/rules.js';
import { isOnDuty, liveBots, templateHolders } from '../team/roster.js';
import { BOT_TEMPLATES, templateById } from '../team/templates.js';
import { truncateBytes } from '../util/text.js';
import { withLabel } from '../util/name-label.js';
import { evidenceMessageIds } from './chief-packet.js';

/** 「组队」段的 key 和标题。key 不叫 team：唤醒包里「团队现在」那一段已经占用了这个名字。 */
export const TEAM_SECTION_KEY = 'team-card';
export const TEAM_SECTION_TITLE = '## 组队（中心维护）';

/** 一张组队卡的用途说明：初始团队，或为哪份约定加人。 */
function purposeOf(ctx: HubContext, proposal: TeamProposal): string {
  if (proposal.kind === 'initial') return '初始团队';
  const agreement = proposal.agreementId === null ? null : ctx.store.table('agreements').get(proposal.agreementId);
  return `为约定「${agreement?.title ?? '这件事'}」加人`;
}

/** 第 1 项：刚由主人确认入职（证据里含确认入职那条主人消息）。 */
function justHiredLines(ctx: HubContext, bot: Bot, entry: QueueEntry): string[] {
  const ids = evidenceMessageIds(ctx, entry);
  const lines: string[] = [];
  for (const proposal of ctx.store.table('teamProposals').list(row => row.chiefId === bot.id && row.kind === 'addition' && row.state === 'confirmed')) {
    const confirmed = ctx.store.log('thread').recent(1, row => ids.has(row.id) && row.from === 'owner'
      && row.refId === proposal.id && row.text === CONFIRM_RECORD_TEXT)[0];
    if (confirmed === undefined) continue;
    const agreement = proposal.agreementId === null ? null : ctx.store.table('agreements').get(proposal.agreementId);
    for (const candidate of proposal.candidates) {
      if (candidate.outcome?.kind !== 'hired') continue;
      const hired = ctx.store.table('bots').get(candidate.outcome.botId);
      if (hired === null) continue;
      const templateName = templateById(candidate.templateId)?.name ?? candidate.templateId;
      lines.push(`刚由主人确认：新员工${withLabel(hired.name, templateName)}已入职，为约定「${agreement?.title ?? '这件事'}」而来。现在调用 hub_job_manage，mode 写 assign，agreementId 写 ${agreement?.id ?? '这份约定的编号'}，executor 写${hired.name}，dueAt 写约定里的交付时间。`);
    }
  }
  return lines;
}

/** 第 2 项：刚被主人拒绝（证据里含一条拒绝口令的主人消息，且对应的按需加人卡已是 declined）。 */
function justDeclinedLines(ctx: HubContext, bot: Bot, entry: QueueEntry): string[] {
  const ids = evidenceMessageIds(ctx, entry);
  const declines = ctx.store.log('thread').recent(10, row => ids.has(row.id) && row.from === 'owner' && isDeclinePhrase(row.text));
  if (declines.length === 0) return [];
  const declined = ctx.store.table('teamProposals').list(row => row.chiefId === bot.id && row.kind === 'addition'
    && row.state === 'declined' && row.decidedVia === 'text' && row.decidedAt !== null
    && declines.some(message => row.decidedAt! >= message.createdAt));
  return declined.length === 0 ? [] : ['主人刚选择不新增员工：这件事由你自己完成。'];
}

/** 第 3 项：待确认的组队卡，逐位写出名字、模板、性格、档位。 */
function pendingLines(ctx: HubContext, proposal: TeamProposal | undefined): string[] {
  if (proposal === undefined) return [];
  const people = proposal.candidates.map(candidate => {
    const template = templateById(candidate.templateId);
    const removed = candidate.removed ? '，主人选了不要' : '';
    return `${candidate.name}（${template?.name ?? candidate.templateId}，${candidate.mbti}，${MODEL_TIER_LABELS[candidate.modelTier]}${removed}）`;
  });
  return [`待主人确认：组队卡（proposalId 为 ${proposal.id}，${purposeOf(ctx, proposal)}）：${people.join('、')}。`];
}

/** 第一问的答案换成中文类别。 */
function workText(work: string): string {
  switch (work) {
    case 'software': return '以做软件产品为主';
    case 'research': return '以调研与写作为主';
    case 'watch': return '以盯守为主';
    default: return '三类都有';
  }
}

/** 第 4 项：三问的答案（三问已完成且三项答案齐全才写）。 */
function answerLines(ctx: HubContext): string[] {
  const setup = ctx.store.table('teamSetups').list(row => row.state === 'done')[0];
  if (setup === undefined) return [];
  const { work, hasProject, projectId, notify } = setup.answers;
  if (work === null || hasProject === null || notify === null) return [];
  const projectName = projectId === null ? null : ctx.store.table('projects').get(projectId)?.name ?? null;
  const notifyLabel = TEAM_QUESTIONS[2].options.find(option => option.value === notify)?.label ?? notify;
  return [`主人在组队时说：${workText(work)}；在做的项目：${projectName ?? '暂无'}；希望被打扰的程度：${notifyLabel}。`];
}

/** 在册已满时的一行：不能推荐，并给出建议归档谁。 */
function fullLine(ctx: HubContext): string {
  const pick = suggestArchiveFor(ctx);
  const advice = pick === null ? '请主人决定先归档哪一位' : `建议主人先归档${pick.name}（${pick.reasonText}）`;
  return `在册已满 ${ctx.settings.maxBots} 位，不能推荐；需要新角色时，${advice}。`;
}

/**
 * 第 5 项：可推荐的模板；在册已满时只写一行。
 * 全队一位且已有的、同模板已有在岗员工的，行末写明已有谁、直接安排他；总管模板不列。
 */
function templateLines(ctx: HubContext): string[] {
  if (liveBots(ctx).length >= ctx.settings.maxBots) return [fullLine(ctx)];
  const rows = BOT_TEMPLATES.filter(template => template.role !== 'chief').map(template => {
    const holders = templateHolders(ctx, template);
    const onDuty = holders.filter(isOnDuty);
    let mark = '';
    if (onDuty.length > 0) mark = `（已有${onDuty[0]!.name}，直接安排）`;
    else if (template.uniquePerTeam && holders.length > 0) mark = `（全队一位，已有${holders[0]!.name}，不能再推荐）`;
    return `${template.name}（${template.dutyLabel}）：${template.fitFor}${mark}`;
  });
  return ['可推荐的模板（template 写名字）：', ...rows];
}

/** 「组队」段正文：按顺序拼出，超过上限截断。 */
export function buildTeamBody(ctx: HubContext, bot: Bot, entry: QueueEntry): string {
  const pending = ctx.store.table('teamProposals').list(row => row.chiefId === bot.id && row.state === 'pending')[0];
  const parts = [
    ...justHiredLines(ctx, bot, entry),
    ...justDeclinedLines(ctx, bot, entry),
    ...pendingLines(ctx, pending),
    ...answerLines(ctx),
    ...templateLines(ctx),
  ];
  return truncateBytes(parts.join('\n'), D.PACKET_MAX_BYTES);
}

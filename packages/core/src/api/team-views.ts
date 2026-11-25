/**
 * 三问与组队卡的界面视图（P73c，方案 5.11、7.3）。
 *
 * 为什么是纯函数：视图的文字（标题、状态、来历、在册人数、按钮）全部在这里生成，
 * 输入（记录、模板表、档位、在册人数、当前时间、时区）都显式传入，不读存储、不读时钟，
 * 同样的输入永远得到同样的输出。插件的示例数据也调用这两个函数，不手写视图字段（第一块的教训）。
 * 读存储的包装函数（teamQuestionViewFor、teamCardViewFor）单独放在文件末尾。
 * 同时导出两个视图的 zod schema，供 P73e 的一致性测试校验。
 */
import { z } from 'zod';
import type { HubContext } from '../engine/context.js';
import { mbtiBehaviorLines } from '../model/mbti.js';
import {
  MODEL_TIER_LABELS, TEAM_PROPOSAL_STATE_LABELS, teamConfirmLabel,
  type TeamCandidate, type TeamModelTier, type TeamProposal, type TeamSetup,
} from '../model/team-proposal.js';
import { TEAM_QUESTIONS, type TeamStep } from '../team/rules.js';
import { defaultTierFor } from '../team/proposal-edit.js';
import { cachedTiers, liveBots, rosterHasTemplate, teamRoster } from '../team/roster.js';
import { BOT_TEMPLATES, TURN_TOKEN_RANGE_TEXT, type BotTemplate } from '../team/templates.js';
import { localParts } from '../util/time.js';

// ---------------------------------------------------------------------------
// 视图的 zod schema
// ---------------------------------------------------------------------------

export const TeamQuestionViewSchema = z.strictObject({
  setupId: z.string(),
  step: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  total: z.literal(3),
  question: z.string(),
  note: z.string(),
  options: z.array(z.strictObject({ value: z.string(), label: z.string(), suggested: z.boolean() })),
  answered: z.boolean(),
  chosenLabel: z.string().nullable(),
  current: z.boolean(),
  /** 第二问的「有」需要弹出选择文件夹。 */
  folderPick: z.boolean(),
});
export type TeamQuestionView = z.infer<typeof TeamQuestionViewSchema>;

const TierSchema = z.enum(['standard', 'light']);

export const TeamCandidateViewSchema = z.strictObject({
  key: z.string(),
  avatarText: z.string(),
  name: z.string(),
  templateId: z.string(),
  templateName: z.string(),
  dutyLabel: z.string(),
  uniqueNote: z.string().nullable(),
  fitFor: z.string(),
  /** W11：总管按项目挑人时写的「在这个项目里做什么」；规则表推荐的为 null。 */
  work: z.string().nullable(),
  /** W11：总管按项目调整过、和模板不同的项（员工说明、性格、模型档位、技能），没有为空列表。 */
  adjusted: z.array(z.string()),
  personality: z.strictObject({
    type: z.string(),
    lines: z.array(z.strictObject({ code: z.string(), text: z.string() })),
    suggested: z.string(),
    changed: z.boolean(),
    restoreText: z.string().nullable(),
  }),
  model: z.strictObject({
    tier: TierSchema,
    label: z.string(),
    suggestedLabel: z.string(),
    changed: z.boolean(),
    restoreText: z.string().nullable(),
    options: z.array(z.strictObject({ tier: TierSchema, label: z.string(), available: z.boolean() })),
  }),
  estimateText: z.string(),
  alternates: z.array(z.strictObject({ index: z.number(), label: z.string(), disabled: z.boolean(), reason: z.string().nullable() })),
  removed: z.boolean(),
  briefChanged: z.boolean(),
  canRemove: z.boolean(),
  /** 卡片只读后的来历说明：由「工程师」改名、你选了不要、入职失败等；待确认时为 null。 */
  historyText: z.string().nullable(),
});
export type TeamCandidateView = z.infer<typeof TeamCandidateViewSchema>;

export const TeamCardViewSchema = z.strictObject({
  proposalId: z.string(),
  kind: z.enum(['initial', 'addition']),
  state: z.enum(['pending', 'confirmed', 'declined', 'withdrawn']),
  rev: z.number(),
  title: z.string(),
  stateLabel: z.string(),
  decidedText: z.string().nullable(),
  candidates: z.array(TeamCandidateViewSchema),
  footer: z.strictObject({ rosterText: z.string(), idleText: z.string(), tokenText: z.string() }),
  confirmLabel: z.string(),
  note: z.string().nullable(),
  /** W11：这张初始卡是谁挑的人；总管没能参与、按默认推荐时是一句说明，其余为 null。 */
  sourceNote: z.string().nullable(),
});
export type TeamCardView = z.infer<typeof TeamCardViewSchema>;

// ---------------------------------------------------------------------------
// 三问视图
// ---------------------------------------------------------------------------

/** 这一问当前的答案对应的选项 value；没答返回 null。 */
function answerValue(setup: TeamSetup, step: TeamStep): string | null {
  if (step === 1) return setup.answers.work;
  if (step === 2) return setup.answers.hasProject === null ? null : setup.answers.hasProject ? 'yes' : 'no';
  return setup.answers.notify;
}

/**
 * 一问的视图：已答的标出选中项（界面把按钮置灰），正在问的标 current。
 * now 暂时不用（保留参数是为了与卡片视图同一签名，以后要显示时间时不用改调用方）。
 */
export function teamQuestionView(setup: TeamSetup, step: TeamStep, _now: number): TeamQuestionView {
  const question = TEAM_QUESTIONS[step - 1]!;
  const value = answerValue(setup, step);
  const answered = value !== null;
  return {
    setupId: setup.id, step, total: 3, question: question.question, note: question.note,
    options: question.options.map(option => ({ value: option.value, label: option.label, suggested: option.value === question.suggested })),
    answered,
    chosenLabel: value === null ? null : (question.options.find(option => option.value === value)?.label ?? null),
    current: setup.state === 'asking' && setup.step === step && !answered,
    folderPick: step === 2,
  };
}

// ---------------------------------------------------------------------------
// 组队卡视图
// ---------------------------------------------------------------------------

export interface TeamCardViewInput {
  /** 模板表（用来查模板名、角色、适合做、预计消耗）。 */
  templates: readonly BotTemplate[];
  tiers: { lightAvailable: boolean; lightLabel: string | null };
  /** 现在在册（未归档）几位，含总管。 */
  rosterCount: number;
  maxBots: number;
  now: number;
  timezone: string;
  /** 已有在册员工的模板 id：备选里这些模板置灰。 */
  takenTemplateIds?: readonly string[];
  /** 按需加人的卡标题要带约定标题；初始卡不用。 */
  agreementTitle?: string | null;
}

/** 档位在卡上显示的名字：轻档不可用时标准档写「标准档（跟随默认）」。 */
function tierLabel(tier: TeamModelTier, lightAvailable: boolean): string {
  if (tier === 'light') return MODEL_TIER_LABELS.light;
  return lightAvailable ? MODEL_TIER_LABELS.standard : `${MODEL_TIER_LABELS.standard}（跟随默认）`;
}

/** 「月 日 时:分」，按设置里的时区。 */
function dateText(at: number, timezone: string): string {
  const parts = localParts(at, timezone);
  return `${parts.month}月${parts.day}日 ${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
}

/** 来历文字：多项用「；」连接；被去掉的只写「你选了不要」；入职失败接在最后。待确认时没有。 */
function historyOf(proposal: TeamProposal, candidate: TeamCandidate, templates: readonly BotTemplate[], lightAvailable: boolean): string | null {
  if (proposal.state === 'pending') return null;
  if (candidate.removed) return '你选了不要';
  const nameOf = (id: string): string => templates.find(template => template.id === id)?.name ?? id;
  const parts: string[] = [];
  if (candidate.name !== candidate.suggested.name) parts.push(`由「${candidate.suggested.name}」改名`);
  if (candidate.swappedFrom !== null && candidate.swappedFrom !== candidate.templateId) {
    parts.push(`由「${nameOf(candidate.swappedFrom)}」换为「${nameOf(candidate.templateId)}」`);
  }
  if (candidate.mbti !== candidate.suggested.mbti) parts.push(`性格由建议的「${candidate.suggested.mbti}」改为「${candidate.mbti}」`);
  if (candidate.modelTier !== candidate.suggested.modelTier) {
    parts.push(`模型由建议的「${tierLabel(candidate.suggested.modelTier, lightAvailable)}」改为「${tierLabel(candidate.modelTier, lightAvailable)}」`);
  }
  if (candidate.outcome?.kind === 'failed') parts.push(`入职失败：${candidate.outcome.error}`);
  return parts.length === 0 ? null : parts.join('；');
}

/** W11：总管按项目调整过的项（只看总管给的建议值，主人在卡上改的另有「恢复建议值」）。 */
function adjustedItems(candidate: TeamCandidate, template: BotTemplate | undefined, lightAvailable: boolean): string[] {
  if (template === undefined || candidate.swappedFrom !== null || candidate.work == null) return [];
  const items: string[] = [];
  if ((candidate.suggested.brief ?? null) !== null) items.push('员工说明');
  if (candidate.suggested.mbti !== template.mbti) items.push('性格');
  const wanted = defaultTierFor(template.id);
  const plain = wanted === 'light' && !lightAvailable ? 'standard' : wanted;
  if (candidate.suggested.modelTier !== plain) items.push('模型档位');
  if (candidate.skills != null) items.push('技能');
  return items;
}

/** 一位候选的视图。 */
function candidateView(proposal: TeamProposal, candidate: TeamCandidate, input: TeamCardViewInput): TeamCandidateView {
  const template = input.templates.find(row => row.id === candidate.templateId);
  const light = input.tiers.lightAvailable;
  const pending = proposal.state === 'pending';
  const taken = new Set(input.takenTemplateIds ?? []);
  const mbtiChanged = candidate.mbti !== candidate.suggested.mbti;
  const modelChanged = candidate.modelTier !== candidate.suggested.modelTier;
  const suggestedLabel = tierLabel(candidate.suggested.modelTier, light);
  const tierOptions: TeamCandidateView['model']['options'] = [{ tier: 'standard', label: tierLabel('standard', light), available: true }];
  // 轻档不可用时卡上没有轻档选项；已经选了轻档（目录后来变了）时仍列出并标不可用。
  if (light || candidate.modelTier === 'light') tierOptions.push({ tier: 'light', label: MODEL_TIER_LABELS.light, available: light });
  return {
    key: candidate.key,
    avatarText: [...candidate.name].slice(0, 2).join(''),
    name: candidate.name,
    templateId: candidate.templateId,
    templateName: template?.name ?? candidate.templateId,
    dutyLabel: template?.dutyLabel ?? '',
    uniqueNote: template?.uniquePerTeam === true ? '全队一位' : null,
    fitFor: template?.fitFor ?? '',
    // 换过模板之后，原来写的工作说的是别人，不再显示。
    work: candidate.work != null && candidate.swappedFrom === null ? candidate.work : null,
    adjusted: adjustedItems(candidate, template, light),
    personality: {
      type: candidate.mbti,
      lines: (mbtiBehaviorLines(candidate.mbti) ?? []).map(line => ({ code: line.code, text: line.text })),
      suggested: candidate.suggested.mbti,
      changed: mbtiChanged,
      restoreText: mbtiChanged ? `恢复为建议值 ${candidate.suggested.mbti}` : null,
    },
    model: {
      tier: candidate.modelTier,
      label: tierLabel(candidate.modelTier, light),
      suggestedLabel,
      changed: modelChanged,
      restoreText: modelChanged ? `恢复为建议值 ${suggestedLabel}` : null,
      options: tierOptions,
    },
    estimateText: template?.estimate.text ?? '',
    // 只读之后不再换人，不给备选。
    alternates: !pending ? [] : candidate.alternates.map((alternate, index) => {
      const target = input.templates.find(row => row.id === alternate.templateId);
      const sameTemplate = alternate.templateId === candidate.templateId;
      let reason: string | null = null;
      if (!sameTemplate) {
        if (taken.has(alternate.templateId)) reason = target?.uniquePerTeam === true ? '全队一位，已有' : '已在册';
        else if (proposal.candidates.some(other => other.key !== candidate.key && other.templateId === alternate.templateId)) reason = '卡上已有';
      }
      return { index, label: alternate.label, disabled: reason !== null, reason };
    }),
    removed: candidate.removed,
    // W11：总管按项目调整的说明另在 adjusted 里写，这里只标主人后来让改的。
    briefChanged: candidate.brief !== null && candidate.brief !== (candidate.suggested.brief ?? null),
    canRemove: pending && proposal.kind === 'initial',
    historyText: historyOf(proposal, candidate, input.templates, light),
  };
}

/** W11：默认推荐（总管没有参与挑人）时卡上的说明。 */
export const TEAM_DEFAULT_PICK_NOTE = '这是默认推荐，总管没有参与挑人。';

/** 一张组队卡的完整视图。纯函数：同一输入两次调用结果深相等。 */
export function teamCardView(proposal: TeamProposal, input: TeamCardViewInput): TeamCardView {
  const initial = proposal.kind === 'initial';
  const kept = proposal.candidates.filter(candidate => !candidate.removed).length;
  const decidedText = proposal.decidedAt === null ? null : dateText(proposal.decidedAt, input.timezone);
  const stateLabel = proposal.state === 'confirmed'
    ? `已入职　${decidedText ?? ''}`.trimEnd()
    : TEAM_PROPOSAL_STATE_LABELS[proposal.state];
  const rosterText = proposal.state === 'pending'
    ? `入职后在册 ${input.rosterCount + kept} / ${input.maxBots} 位${initial ? '（含总管）' : ''}`
    : `在册 ${proposal.state === 'confirmed' ? (proposal.rosterAfter ?? input.rosterCount) : input.rosterCount} / ${input.maxBots} 位`;
  return {
    proposalId: proposal.id, kind: proposal.kind, state: proposal.state, rev: proposal.rev,
    title: initial ? '初始团队' : `新员工：${input.agreementTitle ?? ''}`,
    stateLabel, decidedText,
    candidates: proposal.candidates.map(candidate => candidateView(proposal, candidate, input)),
    footer: {
      rosterText,
      idleText: initial ? '平时不接活时不消耗额度' : '入职后常驻；不接活时不消耗额度',
      tokenText: TURN_TOKEN_RANGE_TEXT,
    },
    confirmLabel: teamConfirmLabel(proposal),
    note: proposal.state !== 'pending' ? null : initial
      ? '想调整员工说明或技能，直接在输入框告诉总管，或入职后在员工卡片里修改。想换成模板库里的其他人，也直接在输入框说。'
      : '不新增也可以：回复「不新增」，由总管自己完成，预计多用 1 到 2 个回合。',
    sourceNote: proposal.pickedBy === 'default' ? TEAM_DEFAULT_PICK_NOTE : null,
  };
}

// ---------------------------------------------------------------------------
// 读存储的包装
// ---------------------------------------------------------------------------

/** 一张组队卡当前的视图；卡不存在返回 null。读存储后调用纯函数。 */
export function teamCardViewFor(ctx: HubContext, proposalId: string): TeamCardView | null {
  const proposal = ctx.store.table('teamProposals').get(proposalId);
  if (!proposal) return null;
  const tiers = cachedTiers(ctx);
  const roster = teamRoster(ctx);
  const agreement = proposal.agreementId === null ? null : ctx.store.table('agreements').get(proposal.agreementId);
  return teamCardView(proposal, {
    templates: BOT_TEMPLATES, tiers: { lightAvailable: tiers.lightAvailable, lightLabel: tiers.lightLabel },
    rosterCount: liveBots(ctx).length, maxBots: ctx.settings.maxBots, now: ctx.clock.now(), timezone: ctx.settings.timezone,
    takenTemplateIds: BOT_TEMPLATES.filter(template => rosterHasTemplate(roster, template)).map(template => template.id),
    agreementTitle: agreement?.title ?? null,
  });
}

/** 线程里某条三问消息对应的视图：refId 是三问记录 id，第几问由消息在 questionMessageIds 里的位置决定。 */
export function teamQuestionViewFor(ctx: HubContext, setupId: string | null, messageId: string): TeamQuestionView | null {
  const setup = setupId === null ? null : ctx.store.table('teamSetups').get(setupId);
  if (!setup) return null;
  const index = setup.questionMessageIds.indexOf(messageId);
  if (index < 0) return null;
  return teamQuestionView(setup, (index + 1) as TeamStep, ctx.clock.now());
}

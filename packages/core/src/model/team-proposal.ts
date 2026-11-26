/**
 * 组队模型（P73c）：初始化三问的进度与答案、组队卡（候选员工名单）。
 *
 * 文件名说明：任务卡写的是 model/team.ts，但该文件名已被「套路、同伴消息、交接、认领、规矩」占用，
 * 所以本文件叫 team-proposal.ts（见 docs/questions.md P73c 第 1 条）。
 *
 * 为什么表里存完整状态：组队卡可被主人反复修改（改名、换人、改性格、改模型），
 * 线程日志只存「这里有一张卡」，视图每次按表投影（与约定卡同一做法）。
 * 本文件只定义结构与校验，不读时钟、不读存储、不调用模型。字符数按完整字符计。
 * 错误信息全部中文，并点出出错字段的路径。
 */
import { z } from 'zod';
import { TEAM_DEFAULTS as D } from '../config/defaults.js';
import { MbtiTypeSchema } from './enums.js';
import { nonempty, recordId, text, timestamp } from './primitives.js';

// ---------------------------------------------------------------------------
// 三问
// ---------------------------------------------------------------------------

/** 三问状态：正在问 / 初始组队卡已发出等确认 / 已完成 / 不走三问（已有员工的存档）。 */
export const TEAM_SETUP_STATES = ['asking', 'proposed', 'done', 'skipped'] as const;
export const TeamSetupStateSchema = z.enum(TEAM_SETUP_STATES, { error: '三问状态必须是 asking、proposed、done、skipped 之一' });
export type TeamSetupState = z.infer<typeof TeamSetupStateSchema>;
export const TEAM_SETUP_STATE_LABELS: Record<TeamSetupState, string> = {
  asking: '提问中', proposed: '等你确认', done: '已完成', skipped: '已跳过',
};

export const TeamStepSchema = z.union([z.literal(1), z.literal(2), z.literal(3)], { error: '问题序号必须是 1、2、3 之一' });

/** 三问的答案：未回答的项为 null。 */
export const TeamAnswersSchema = z.strictObject({
  work: z.enum(['software', 'research', 'watch', 'mixed']).nullable(),
  workText: text.refine(value => [...value].length <= D.WORK_TEXT_MAX_CHARS, `不能超过 ${D.WORK_TEXT_MAX_CHARS} 字`).nullable(), // 主人打字回答时的原文
  hasProject: z.boolean({ error: '必须是布尔值' }).nullable(),
  projectId: recordId('prj').nullable(), // 第二问选「有」后建好的项目
  projectFolder: nonempty.nullable(), // 主人选的文件夹绝对路径（只记录路径）
  notify: z.enum(['decisions', 'each_done', 'each_step']).nullable(),
});
export type TeamAnswers = z.infer<typeof TeamAnswersSchema>;

export const TeamSetupSchema = z.strictObject({
  id: recordId('tsu'),
  chiefId: recordId('b'),
  state: TeamSetupStateSchema,
  step: TeamStepSchema, // asking 时是正在问的那一问；其余状态停在最后问到的一问
  answers: TeamAnswersSchema,
  questionMessageIds: z.array(recordId('m')), // 三问各自的消息 id，按问的顺序
  proposalId: recordId('tpr').nullable(),
  // W11：答完第三问、请总管按项目挑人的时间；null 或缺省表示还没请（旧记录没有这一项）。
  pickRequestedAt: timestamp.nullable().optional(),
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type TeamSetup = z.infer<typeof TeamSetupSchema>;

// ---------------------------------------------------------------------------
// 组队卡
// ---------------------------------------------------------------------------

export const TEAM_PROPOSAL_KINDS = ['initial', 'addition'] as const;
export const TeamProposalKindSchema = z.enum(TEAM_PROPOSAL_KINDS, { error: '组队卡类型必须是 initial、addition 之一' });
export type TeamProposalKind = z.infer<typeof TeamProposalKindSchema>;

export const TEAM_PROPOSAL_STATES = ['pending', 'confirmed', 'declined', 'withdrawn'] as const;
export const TeamProposalStateSchema = z.enum(TEAM_PROPOSAL_STATES, { error: '组队卡状态必须是 pending、confirmed、declined、withdrawn 之一' });
export type TeamProposalState = z.infer<typeof TeamProposalStateSchema>;
export const TEAM_PROPOSAL_STATE_LABELS: Record<TeamProposalState, string> = {
  pending: '待你确认', confirmed: '已入职', declined: '你选择不新增', withdrawn: '已撤下',
};

export const MODEL_TIERS = ['standard', 'light'] as const;
export const ModelTierSchema = z.enum(MODEL_TIERS, { error: '模型档位必须是 standard、light 之一' });
export type TeamModelTier = z.infer<typeof ModelTierSchema>;
export const MODEL_TIER_LABELS: Record<TeamModelTier, string> = { standard: '标准档', light: '轻档' };

const nameText = nonempty
  .refine(value => value.trim().length > 0, '不能为空')
  .refine(value => [...value].length <= D.NAME_MAX_CHARS, `不能超过 ${D.NAME_MAX_CHARS} 字`);

/** 候选员工的入职结果：已入职 / 没有入职 / 入职时出错。 */
export const TeamOutcomeSchema = z.union([
  z.strictObject({ kind: z.literal('hired'), botId: recordId('b') }),
  z.strictObject({ kind: z.literal('not_hired') }),
  z.strictObject({ kind: z.literal('failed'), error: text }),
]);
export type TeamOutcome = z.infer<typeof TeamOutcomeSchema>;

export const TeamCandidateSchema = z.strictObject({
  key: z.enum(['c1', 'c2', 'c3'], { error: '候选编号必须是 c1、c2、c3 之一' }),
  templateId: nonempty, // 当前模板（「换一位」后会变）
  // 规则表给出的建议值，生成后不再改（「换一位」时整体换成新模板的建议值）。
  // W11：总管按项目调整过员工说明时，建议值里也记下调整后的说明（「恢复建议值」和区分谁改的都靠它）；规则表推荐和旧记录没有这一项。
  suggested: z.strictObject({ templateId: nonempty, name: nameText, mbti: MbtiTypeSchema, modelTier: ModelTierSchema,
    brief: z.string({ error: '必须是文字' }).nullable().optional() }),
  name: nameText,
  mbti: MbtiTypeSchema,
  modelTier: ModelTierSchema,
  removed: z.boolean({ error: '必须是布尔值' }), // 主人点了「不要这位」
  // 总管按主人的话改写过的员工说明；null 表示用模板原文，1 到 1000 字。
  brief: z.string({ error: '必须是文字' }).refine(value => value.trim().length > 0 && [...value].length <= D.BRIEF_MAX_CHARS,
    `员工说明必须是 1 到 ${D.BRIEF_MAX_CHARS} 字`).nullable(),
  alternates: z.array(z.strictObject({ templateId: nonempty, mbti: MbtiTypeSchema, label: nonempty })).max(2, '备选最多 2 个'),
  swappedFrom: nonempty.nullable(), // 「换一位」之前的模板 id，用于来历
  outcome: TeamOutcomeSchema.nullable(),
  // W11：总管按项目挑人时写的「在这个项目里做什么」；规则表推荐和旧记录没有这一项。
  work: z.string({ error: '必须是文字' }).refine(value => value.trim().length > 0 && [...value].length <= D.PICK_WORK_MAX_CHARS,
    `要做的工作必须是 1 到 ${D.PICK_WORK_MAX_CHARS} 字`).nullable().optional(),
  // W11：总管按项目选的预置技能编号；null 或缺省表示用模板自带的。
  skills: z.array(nonempty).max(12, '技能最多 12 项').nullable().optional(),
});
export type TeamCandidate = z.infer<typeof TeamCandidateSchema>;

const reasonText = nonempty
  .refine(value => [...value].length <= D.REASON_MAX_CHARS, `不能超过 ${D.REASON_MAX_CHARS} 字`);

export const TeamProposalSchema = z.strictObject({
  id: recordId('tpr'),
  chiefId: recordId('b'),
  kind: TeamProposalKindSchema,
  state: TeamProposalStateSchema,
  rev: z.number({ error: '必须是整数' }).int('必须是整数').min(1, '修订号从 1 起'), // 每次修改加 1
  agreementId: recordId('agr').nullable(), // addition 必填：为哪份已固定的约定加人
  needReason: reasonText.nullable(), // addition 必填：这件事为什么需要这个角色
  residentReason: reasonText.nullable(), // addition 必填：为什么值得常驻
  candidates: z.array(TeamCandidateSchema).min(1, '候选至少 1 位').max(D.INITIAL_MAX, `候选最多 ${D.INITIAL_MAX} 位`),
  cardMessageId: nonempty.nullable(),
  inboxId: nonempty.nullable(),
  sourceMessageId: nonempty.nullable(), // addition：叫醒这次提议的主人消息
  wakeId: nonempty.nullable(), // addition：提交这张卡的唤醒单
  decidedAt: timestamp.nullable(),
  decidedVia: z.enum(['button', 'inbox', 'text', 'chief']).nullable(),
  rosterAfter: z.number().int().min(0).nullable(), // 确认时在册人数（含总管）
  // W11：初始组队卡由谁挑的人：chief 是总管按项目挑的，default 是总管没能参与、按规则表给的默认推荐。
  // 旧记录和按需加人的卡没有这一项。
  pickedBy: z.enum(['chief', 'default'], { error: '挑人来源必须是 chief、default 之一' }).optional(),
  createdAt: timestamp,
  updatedAt: timestamp,
}).superRefine((proposal, ctx) => {
  const bad = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', message, path });
  const { candidates } = proposal;
  if (proposal.kind === 'addition') {
    if (candidates.length !== 1) bad(['candidates'], 'addition 类型必须恰好 1 位候选');
    if (proposal.agreementId === null) bad(['agreementId'], 'addition 类型必须写明为哪份约定加人');
    if (proposal.needReason === null) bad(['needReason'], 'addition 类型必须写明为什么需要这个角色');
    if (proposal.residentReason === null) bad(['residentReason'], 'addition 类型必须写明为什么值得常驻');
  } else {
    if (proposal.agreementId !== null) bad(['agreementId'], 'initial 类型不能带约定');
    if (proposal.needReason !== null) bad(['needReason'], 'initial 类型不能带需要理由');
    if (proposal.residentReason !== null) bad(['residentReason'], 'initial 类型不能带常驻理由');
  }
  // 候选编号不重复；候选名字互不相同（不论是否被主人选了不要）。
  const keys = new Set<string>();
  const names = new Set<string>();
  candidates.forEach((candidate, index) => {
    if (keys.has(candidate.key)) bad(['candidates', index, 'key'], `候选编号「${candidate.key}」重复`);
    keys.add(candidate.key);
    const name = candidate.name.trim();
    if (names.has(name)) bad(['candidates', index, 'name'], `候选名字「${name}」重复`);
    names.add(name);
  });
  if (proposal.state === 'pending') {
    if (proposal.decidedAt !== null) bad(['decidedAt'], '待确认的组队卡不能有决定时间');
    candidates.forEach((candidate, index) => {
      if (candidate.outcome !== null) bad(['candidates', index, 'outcome'], '待确认的组队卡，候选的结果必须为空');
    });
  }
  if (proposal.state === 'confirmed') {
    candidates.forEach((candidate, index) => {
      if (candidate.outcome === null) bad(['candidates', index, 'outcome'], '已确认的组队卡，每位候选都必须有结果');
    });
  }
});
export type TeamProposal = z.infer<typeof TeamProposalSchema>;

/**
 * 组队卡上的确认按钮文字（卡片按钮与「待你处理」按钮相同，由这一个函数生成）：
 * initial 为「确认，N 位入职」；全部「不要这位」时为「全部不要」；addition 为「确认入职，接手这件事」。
 */
export function teamConfirmLabel(proposal: Pick<TeamProposal, 'kind' | 'candidates'>): string {
  if (proposal.kind === 'addition') return '确认入职，接手这件事';
  const kept = proposal.candidates.filter(candidate => !candidate.removed).length;
  return kept === 0 ? '全部不要' : `确认，${kept} 位入职`;
}

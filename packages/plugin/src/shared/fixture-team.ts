/**
 * 样例组队数据（P73e，样例数据模式专用）：照设计稿 A1 至 A4、C 造三问和组队卡的样例，
 * 让离线走查和测试能看到：三问卡的已答与正在答、待确认的初始组队卡、确认后只读的卡、按需加人的卡。
 *
 * 做法（第一块的教训）：这个文件只写「记录」（core 的 TeamSetup、TeamProposal），
 * 视图一律调用 core 导出的 teamQuestionView、teamCardView 生成，不手写任何视图字段。
 * 这样 core 改了视图的字段或文字，样例会跟着变，预览和测试都不会悄悄用旧口径。
 * 另有一条一致性测试（test/p73e-fixture-consistency.test.ts）校验样例视图符合 core 的视图 schema。
 *
 * 样例文字不进文案登记表（见 docs/copy/strings.md「不登记」一条）。
 */
import { teamCardView, teamQuestionView, type TeamCardView, type TeamProposal, type TeamQuestionView, type TeamSetup } from '@agent-hub/core'
import { ALTERNATES_TABLE, BOT_TEMPLATES, INITIAL_TEAM_TABLE, type TeamStep } from '@agent-hub/core/team'

/** 样例里的固定时间：2026-11-11 09:05（北京时间）。时间只影响卡片上「已入职　月日 时:分」那一行。 */
export const SAMPLE_TEAM_DECIDED_AT = Date.UTC(2026, 10, 11, 1, 5)
export const SAMPLE_TEAM_TIMEZONE = 'Asia/Shanghai'
/** 样例的档位：轻档可用（设计稿 A3 里评审员建议用轻档）。 */
export const SAMPLE_TEAM_TIERS = { lightAvailable: true, lightLabel: '轻档' } as const
/** 样例里在册上限与 core 的默认值一致。 */
export const SAMPLE_MAX_BOTS = 6

/** 样例记录的固定 id（前缀加 10 位小写字母或数字，与 core 的 recordId 规则一致）。 */
export const SAMPLE_SETUP_ID = 'tsu_sample0001'
export const SAMPLE_INITIAL_PROPOSAL_ID = 'tpr_sampleini1'
export const SAMPLE_CONFIRMED_PROPOSAL_ID = 'tpr_sampledon1'
export const SAMPLE_ADDITION_PROPOSAL_ID = 'tpr_sampleadd1'
const SAMPLE_CHIEF_ID = 'b_zongguan01'
const SAMPLE_AGREEMENT_REF = 'agr_pricingpg1'
/** 样例按需加人卡对应的约定标题（设计稿 C）。 */
export const SAMPLE_ADDITION_AGREEMENT_TITLE = '会员定价页'

/** 样例三问的消息 id：线程里三条 team_question 消息按这个顺序对应第 1 至 3 问。 */
export const SAMPLE_QUESTION_MESSAGE_IDS = ['tq-1', 'tq-2', 'tq-3'] as const

/** 一次造卡需要的现场信息：这几项随场景不同。 */
export interface SampleCardContext {
  /** 现在在册几位（含总管）。 */
  rosterCount: number
  /** 已有在册员工的模板 id：备选里这些模板置灰。 */
  takenTemplateIds?: readonly string[]
  /** 按需加人的卡标题要带约定标题。 */
  agreementTitle?: string | null
}

/** 取模板默认档位：规则表里第一次出现的建议档位；表里没有的取标准档（与 core 同口径，样例用）。 */
export function sampleDefaultTier(templateId: string): 'standard' | 'light' {
  for (const seeds of Object.values(INITIAL_TEAM_TABLE)) {
    const seed = seeds.find(item => item.templateId === templateId)
    if (seed !== undefined) return seed.modelTier
  }
  return 'standard'
}

/** 一位候选的记录：建议值取规则表，备选取 core 的备选表。 */
function candidateRecord(
  key: 'c1' | 'c2' | 'c3', templateId: string, mbti: TeamProposal['candidates'][number]['mbti'],
  tier: 'standard' | 'light', name?: string,
): TeamProposal['candidates'][number] {
  const template = BOT_TEMPLATES.find(item => item.id === templateId)!
  return {
    key, templateId, name: name ?? template.name, mbti, modelTier: tier, removed: false, brief: null,
    suggested: { templateId, name: template.name, mbti, modelTier: tier },
    alternates: (ALTERNATES_TABLE[templateId] ?? []).map(item => ({ templateId: item.templateId, mbti: item.mbti, label: item.label })),
    swappedFrom: null, outcome: null,
  }
}

const AT = SAMPLE_TEAM_DECIDED_AT

/** 三问记录：已答两问（软件、有项目），正在答第三问（设计稿 A2）。 */
export const sampleSetup: TeamSetup = {
  id: SAMPLE_SETUP_ID, chiefId: SAMPLE_CHIEF_ID, state: 'asking', step: 3,
  answers: {
    work: 'software', workText: null, hasProject: true, projectId: 'prj_samplesign',
    projectFolder: '/sample/projects/signup', notify: null,
  },
  questionMessageIds: [...SAMPLE_QUESTION_MESSAGE_IDS], proposalId: null, createdAt: AT - 300_000, updatedAt: AT - 60_000,
}

/** 初始组队卡，待确认（设计稿 A3：设计师的性格已由建议的 ISFJ 改为 ESFJ）。 */
export const sampleInitialProposal: TeamProposal = {
  id: SAMPLE_INITIAL_PROPOSAL_ID, chiefId: SAMPLE_CHIEF_ID, kind: 'initial', state: 'pending', rev: 2,
  agreementId: null, needReason: null, residentReason: null,
  candidates: [
    candidateRecord('c1', 'engineer', 'ISTJ', 'standard'),
    { ...candidateRecord('c2', 'designer', 'ISFJ', 'standard'), mbti: 'ESFJ' },
    candidateRecord('c3', 'reviewer', 'ISTJ', 'light'),
  ],
  cardMessageId: 'tc-initial', inboxId: null, sourceMessageId: null, wakeId: null,
  decidedAt: null, decidedVia: null, rosterAfter: null, createdAt: AT - 120_000, updatedAt: AT - 60_000,
}

/**
 * 已确认的初始组队卡（设计稿 A4）：工程师改名「林舟」，设计师选了不要，评审员由轻档改为标准档。
 * 这张卡是另一次组队的结果，所以与上面那张待确认的卡并存只是为了让走查同时看到两种状态。
 */
export const sampleConfirmedProposal: TeamProposal = {
  id: SAMPLE_CONFIRMED_PROPOSAL_ID, chiefId: SAMPLE_CHIEF_ID, kind: 'initial', state: 'confirmed', rev: 4,
  agreementId: null, needReason: null, residentReason: null,
  candidates: [
    { ...candidateRecord('c1', 'engineer', 'ISTJ', 'standard', '林舟'), outcome: { kind: 'hired', botId: 'b_samplehir1' } },
    { ...candidateRecord('c2', 'designer', 'ISFJ', 'standard'), removed: true, outcome: { kind: 'not_hired' } },
    { ...candidateRecord('c3', 'reviewer', 'ISTJ', 'light'), modelTier: 'standard', outcome: { kind: 'hired', botId: 'b_samplehir2' } },
  ],
  cardMessageId: 'tc-confirmed', inboxId: null, sourceMessageId: null, wakeId: null,
  decidedAt: AT, decidedVia: 'button', rosterAfter: 3, createdAt: AT - 600_000, updatedAt: AT,
}

/** 按需加人的组队卡，待确认（设计稿 C：缺调研角色，推荐一位研究员）。 */
export const sampleAdditionProposal: TeamProposal = {
  id: SAMPLE_ADDITION_PROPOSAL_ID, chiefId: SAMPLE_CHIEF_ID, kind: 'addition', state: 'pending', rev: 1,
  agreementId: SAMPLE_AGREEMENT_REF,
  needReason: '这件事要先查 5 家同类产品的定价，在岗员工里没有调研角色。',
  residentReason: '定价和竞品调研以后还会反复用到。',
  candidates: [candidateRecord('c1', 'researcher', 'INTP', 'standard')],
  cardMessageId: 'tc-addition', inboxId: 'inbox-team-add', sourceMessageId: 'own-sample', wakeId: null,
  decidedAt: null, decidedVia: null, rosterAfter: null, createdAt: AT - 30_000, updatedAt: AT - 30_000,
}

/** 用 core 的视图函数生成一张组队卡的视图。样例里所有组队卡视图都从这里出。 */
export function sampleTeamCardView(proposal: TeamProposal, context: SampleCardContext): TeamCardView {
  return teamCardView(proposal, {
    templates: BOT_TEMPLATES, tiers: { ...SAMPLE_TEAM_TIERS }, rosterCount: context.rosterCount, maxBots: SAMPLE_MAX_BOTS,
    now: AT, timezone: SAMPLE_TEAM_TIMEZONE, takenTemplateIds: context.takenTemplateIds ?? [],
    agreementTitle: context.agreementTitle ?? null,
  })
}

/** 各张样例卡发出时的现场信息：初始卡只有总管在册；按需加人卡发出时已有三位在册（含总管）。 */
export function sampleCardContextFor(proposal: TeamProposal): SampleCardContext {
  if (proposal.kind === 'addition') return { rosterCount: 3, takenTemplateIds: ['engineer', 'reviewer'], agreementTitle: SAMPLE_ADDITION_AGREEMENT_TITLE }
  return { rosterCount: proposal.state === 'confirmed' ? 3 : 1 }
}

/** 一张样例卡当前的视图（按卡上记录的种类选现场信息）。 */
export function sampleViewOfProposal(proposal: TeamProposal): TeamCardView {
  return sampleTeamCardView(proposal, sampleCardContextFor(proposal))
}

/** 三问记录对应的三条问题视图（第 1、2、3 问）。 */
export function sampleQuestionViews(setup: TeamSetup): [TeamQuestionView, TeamQuestionView, TeamQuestionView] {
  const steps: TeamStep[] = [1, 2, 3]
  return steps.map(step => teamQuestionView(setup, step, AT)) as [TeamQuestionView, TeamQuestionView, TeamQuestionView]
}

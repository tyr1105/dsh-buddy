/**
 * 组队规则表（P73b）：三问的问题与选项、打字回答的关键词、推荐名单、备选、结论句、
 * 拒绝口令、满员时的归档建议。全部是常量和纯函数，输入显式传入，不读存储、不调用模型。
 *
 * 为什么写成规则表：组队的推荐、提问、结论句都必须是确定的、可逐行测试的；
 * 想改推荐名单或某句话，只改这里，不用翻服务代码。
 * 文字逐字取自方案 4.1 至 4.3（docs/tasks/P73-plan.md），不要随手改措辞。
 */
import type { MbtiType, Role } from '../model/enums.js';
import { findTemplate, freeTemplateName, isTemplateAdded, templateById } from './templates.js';
import type { ModelTier, ModelTiers } from './model-tiers.js';

// ---------- 三问 ----------

export type TeamStep = 1 | 2 | 3;
export type TeamWork = 'software' | 'research' | 'watch' | 'mixed';
export type TeamProjectAnswer = 'yes' | 'no';
export type TeamNoticeAnswer = 'decisions' | 'each_done' | 'each_step';

export interface TeamQuestion {
  step: TeamStep;
  question: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  /** 建议项的 value；没有建议项为 null。 */
  suggested: string | null;
  /** 问题下面的说明行。 */
  note: string;
}

/** 三问的问题和选项全文（固定，不调用模型）。 */
export const TEAM_QUESTIONS: readonly [TeamQuestion, TeamQuestion, TeamQuestion] = [
  {
    step: 1,
    question: '第一个问题：你主要想让团队做哪类事？',
    options: [
      { value: 'software', label: '做软件产品：网页、小工具、插件' },
      { value: 'research', label: '调研与写作：查资料、写报告、写文案' },
      { value: 'watch', label: '盯守：定时检查网页、日志或任务' },
      { value: 'mixed', label: '以上都有' },
    ],
    suggested: null,
    note: '第 1 问，共 3 问。也可以直接用一句话说说你的项目，总管挑人时会看。',
  },
  {
    step: 2,
    question: '第二个问题：手上有没有已经在做的项目？有的话，我先把它的位置记下来。',
    options: [
      { value: 'yes', label: '有，我选一下项目文件夹' },
      { value: 'no', label: '暂时没有' },
    ],
    suggested: null,
    note: '第 2 问，共 3 问',
  },
  {
    step: 3,
    question: '第三个问题：你希望多久被打扰一次？',
    options: [
      { value: 'decisions', label: '只在需要你拍板时' },
      { value: 'each_done', label: '每件事做完都告诉我' },
      { value: 'each_step', label: '每个关键步骤都告诉我' },
    ],
    suggested: 'decisions',
    note: '第 3 问，共 3 问。答完我就给出推荐。',
  },
];

/** 开场白（固定）。 */
export const TEAM_OPENING_TEXT = '你好，我是总管，你交代的每件事都由我来安排和交回。现在团队里只有我一位。我先问你 3 个问题，再推荐不超过 3 位员工，你确认后他们才会入职。';

/** 「已记下」里引用主人原话时的最大字数，超过截断加省略号。 */
const QUOTE_MAX_CHARS = 30;

function truncateQuote(text: string): string {
  const chars = [...text.trim()];
  return chars.length > QUOTE_MAX_CHARS ? `${chars.slice(0, QUOTE_MAX_CHARS).join('')}…` : chars.join('');
}

/** 「已记下」固定句需要的信息：选项值，以及第二问的项目名、第一问打字未命中时的原话。 */
export interface TeamAnswerInfo {
  value: string;
  /** 第二问选「有」时的项目名。 */
  projectName?: string;
  /** 第一问打字未命中（按「以上都有」处理）时，主人的原话。 */
  typedText?: string;
  /** 打字没有命中任何一类、按默认处理。 */
  fallback?: boolean;
}

/** 总管落的「已记下：…」固定句（逐字照方案 4.2 第 4 条）。 */
export function ackText(step: TeamStep, answer: TeamAnswerInfo): string {
  if (step === 1) {
    if (answer.fallback === true && answer.typedText !== undefined) {
      return `已记下：你的原话「${truncateQuote(answer.typedText)}」，按以上都有处理。`;
    }
    switch (answer.value) {
      case 'software': return '已记下：以做软件产品为主。';
      case 'research': return '已记下：以调研与写作为主。';
      case 'watch': return '已记下：以盯守为主。';
      default: return '已记下：三类都有。';
    }
  }
  if (step === 2) {
    return answer.value === 'yes'
      ? `已记下：项目「${answer.projectName ?? ''}」。`
      : '已记下：暂时没有在做的项目。';
  }
  switch (answer.value) {
    case 'each_done': return '已记下：每件事做完都告诉你。';
    case 'each_step': return '已记下：每个关键步骤都告诉你。';
    default: return '已记下：只在需要你拍板时找你。';
  }
}

// ---------- 打字回答 ----------

export interface TypedAnswer {
  value: string;
  /** 没命中关键词，按默认处理。 */
  fallback?: boolean;
  /** 第二问以 / 开头时的文件夹路径。 */
  folderPath?: string;
}

/** 第一问的关键词表。 */
const WORK_KEYWORDS: ReadonlyArray<{ value: Exclude<TeamWork, 'mixed'>; words: readonly string[] }> = [
  { value: 'software', words: ['网页', '页面', '小工具', '插件', '代码', '程序', '软件', 'app'] },
  { value: 'research', words: ['调研', '资料', '报告', '写作', '文案', '文章'] },
  { value: 'watch', words: ['盯守', '监控', '定时', '日志', '巡检'] },
];

/** 第三问的关键词表。 */
const NOTICE_KEYWORDS: ReadonlyArray<{ value: TeamNoticeAnswer; words: readonly string[] }> = [
  { value: 'decisions', words: ['拍板', '决定', '确认'] },
  { value: 'each_done', words: ['做完', '完成'] },
  { value: 'each_step', words: ['步骤', '每一步', '进度'] },
];

/**
 * 三问进行中，主人在输入框打字时按当前问题匹配。
 * - 第一问：恰好命中一类就用这一类；命中多类或零类按「以上都有」，并标 fallback。
 * - 第二问：以 / 开头按文件夹路径；含「没有」「暂时」或整句为「无」按暂时没有；其余返回 null（要求重答）。
 * - 第三问：命中恰好一类用这一类；其余按建议项并标 fallback。
 */
export function matchTypedAnswer(step: TeamStep, text: string): TypedAnswer | null {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  if (step === 1) {
    const hits = WORK_KEYWORDS.filter(group => group.words.some(word => lower.includes(word)));
    return hits.length === 1 ? { value: hits[0]!.value } : { value: 'mixed', fallback: true };
  }
  if (step === 2) {
    if (trimmed.startsWith('/')) return { value: 'yes', folderPath: trimmed };
    if (trimmed.includes('没有') || trimmed.includes('暂时') || trimmed === '无') return { value: 'no' };
    return null;
  }
  const hits = NOTICE_KEYWORDS.filter(group => group.words.some(word => lower.includes(word)));
  return hits.length === 1 ? { value: hits[0]!.value } : { value: 'decisions', fallback: true };
}

// ---------- 初始推荐名单 ----------

export interface TeamCandidateSeed {
  templateId: string;
  mbti: MbtiType;
  modelTier: ModelTier;
}

/** 方案 4.3 第 1 条：第一问的答案对应的推荐（模板、建议性格、建议档位）。 */
export const INITIAL_TEAM_TABLE: Readonly<Record<TeamWork, readonly TeamCandidateSeed[]>> = {
  software: [
    { templateId: 'engineer', mbti: 'ISTJ', modelTier: 'standard' },
    { templateId: 'designer', mbti: 'ISFJ', modelTier: 'standard' },
    { templateId: 'reviewer', mbti: 'ISTJ', modelTier: 'light' },
  ],
  research: [
    { templateId: 'researcher', mbti: 'INTP', modelTier: 'standard' },
    { templateId: 'reviewer', mbti: 'ISTJ', modelTier: 'light' },
  ],
  watch: [
    { templateId: 'inspector', mbti: 'ISFJ', modelTier: 'standard' },
  ],
  mixed: [
    { templateId: 'engineer', mbti: 'ISTJ', modelTier: 'standard' },
    { templateId: 'researcher', mbti: 'INTP', modelTier: 'standard' },
    { templateId: 'reviewer', mbti: 'ISTJ', modelTier: 'light' },
  ],
};

/** 推荐名单最多几位。 */
export const MAX_INITIAL_CANDIDATES = 3;

/** 名册里算「已有」所需的最小信息。 */
export interface TeamRosterRow {
  name: string;
  /** 来历里的模板标识；旧员工没有来历时为 null，按名字前缀判断。 */
  templateId: string | null;
  archived: boolean;
}

export interface InitialCandidate {
  templateId: string;
  /** 带序号的可用名字（设计师2）。 */
  name: string;
  mbti: MbtiType;
  modelTier: ModelTier;
}

/**
 * 推荐初始名单：不调用模型，按表取。
 * - 跳过已在册的模板、跳过「全队一位」且已有一位的模板；
 * - 长度不超过 3，也不超过「maxBots 减在册人数」；
 * - 名字取模板名，与名册（含已归档）和本次已选的重名时加序号；
 * - 轻档不可用时，建议档位一律改为标准档。
 */
export function recommendInitialTeam(
  work: TeamWork,
  roster: readonly TeamRosterRow[],
  tiers: Pick<ModelTiers, 'lightAvailable'>,
  maxBots: number,
): InitialCandidate[] {
  const live = roster.filter(row => !row.archived);
  const room = Math.max(0, maxBots - live.length);
  const limit = Math.min(MAX_INITIAL_CANDIDATES, room);
  const takenNames = roster.map(row => row.name);
  const out: InitialCandidate[] = [];
  for (const seed of INITIAL_TEAM_TABLE[work]) {
    if (out.length >= limit) break;
    const template = templateById(seed.templateId);
    if (template === undefined) continue;
    // 已在册：来历模板相同，或没有来历时按名字规则。同一条也覆盖「全队一位」已有一位的情况。
    const added = live.some(row => row.templateId === null
      ? isTemplateAdded(template, [row])
      : row.templateId === template.id);
    if (added) continue;
    const name = freeTemplateName(template.name, [...takenNames, ...out.map(item => item.name)]);
    out.push({
      templateId: template.id,
      name,
      mbti: seed.mbti,
      modelTier: seed.modelTier === 'light' && !tiers.lightAvailable ? 'standard' : seed.modelTier,
    });
  }
  return out;
}

// ---------- 备选（「换一位…」） ----------

export interface TeamAlternate {
  templateId: string;
  mbti: MbtiType;
  label: string;
}

/** 方案 4.3 第 2 条：每位推荐最多 2 个备选，事先算好。键是原模板标识。 */
export const ALTERNATES_TABLE: Readonly<Record<string, readonly TeamAlternate[]>> = {
  engineer: [
    { templateId: 'engineer', mbti: 'ESTJ', label: '工程师，换性格 ESTJ：尽早给出初步结果' },
    { templateId: 'product-manager', mbti: 'INTP', label: '产品经理：先把需求写清楚' },
  ],
  designer: [
    { templateId: 'product-manager', mbti: 'INTP', label: '产品经理：先把需求写清楚' },
    { templateId: 'video-planner', mbti: 'ENFP', label: '视频策划：写推广视频脚本' },
  ],
  reviewer: [
    { templateId: 'reviewer', mbti: 'ESTJ', label: '评审员，换性格 ESTJ：尽早给出初步意见' },
  ],
  researcher: [
    { templateId: 'researcher', mbti: 'ISTJ', label: '研究员，换性格 ISTJ：只核对事实，不找替代方案' },
  ],
  inspector: [],
};

/** 某个模板的备选，0 到 2 项。 */
export function alternatesFor(templateId: string): readonly TeamAlternate[] {
  return ALTERNATES_TABLE[templateId] ?? [];
}

// ---------- 结论句 ----------

/**
 * 卡片之前总管落的结论句（固定句式，不调用模型）。
 * 「适合做」的短语取模板的 fitShort；中心生成的固定句不用「招」字（裁定 13）。
 */
export function INITIAL_CONCLUSION(candidates: ReadonlyArray<{ templateId: string }>): string {
  const parts = candidates.map(candidate => {
    const template = templateById(candidate.templateId);
    return template === undefined ? candidate.templateId : `${template.name}${template.fitShort}`;
  });
  return `我建议先安排 ${candidates.length} 位：${parts.join('，')}。他们平时不接活就不消耗额度。请在下方确认；确认前不会入职。`;
}

// ---------- 拒绝口令 ----------

/**
 * 主人说「不新增」一类的话，视为拒绝整张组队卡（裁定 13；P73r3 S6 收窄）。
 * 只认整句完全相同的这六句；「不需要」「不要了」这类泛指的话可能是在回答总管别的问题，不算。清单只在这里维护。
 */
export const DECLINE_PHRASES: readonly string[] = ['不新增', '不招', '不用招', '不加人', '不用加人', '先不加人'];

/** 整句（去掉空白和中英文标点、转小写后）等于拒绝口令之一，且不超过 8 个字。 */
export function isDeclinePhrase(text: string): boolean {
  const cleaned = text.replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
  return [...cleaned].length <= 8 && DECLINE_PHRASES.includes(cleaned);
}

// ---------- 满员时的归档建议 ----------

export interface ArchiveRow {
  botId: string;
  name: string;
  role: Role;
  templateId: string | null;
  /** 最近一次接活（有工作事务）的时间；从未接过为 null。 */
  lastWorkAt: number | null;
  openWorkCount: number;
  lastThinkAt: number | null;
  /** 它是否是某个未归档项目的负责人（负责人不能归档）。P73r2 起必填：调用方不传就过不了类型检查。 */
  ownsProject: boolean;
}

/** 「最近没有接活」的天数界限。 */
export const ARCHIVE_IDLE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 在册满员时建议归档谁（总管不获得归档能力，只给建议，由主人去员工卡片里操作）。
 * 排除总管；排除项目负责人和有进行中或待验收事务的员工（现在不能归档）；
 * 排除「全队一位」且是唯一一位的员工（例如唯一的评审员）。
 * 先找「30 天内没接活」里 lastWorkAt 最早的一位（从未接活视为最早）；
 * 都接过活时（此时候选都没有在办事务），选最近一次思考最早的一位，即最久没有接活的一位。没有可选的返回 null。
 */
export function suggestArchive(rows: readonly ArchiveRow[], now: number): { botId: string; name: string; reasonText: string } | null {
  const eligible = rows.filter(row => {
    if (row.role === 'chief') return false;
    // P73r1（R6.3）：只建议「现在能归档」的员工，否则主人照做会被归档检查拒绝。
    if (row.ownsProject || row.openWorkCount > 0) return false;
    const template = row.templateId === null ? null : (templateById(row.templateId) ?? findTemplate(row.templateId));
    if (template?.uniquePerTeam === true) {
      const sameKind = rows.filter(other => other.templateId === row.templateId).length;
      if (sameKind <= 1) return false;
    }
    return true;
  });
  if (eligible.length === 0) return null;
  const threshold = now - ARCHIVE_IDLE_DAYS * DAY_MS;
  const idle = eligible.filter(row => row.lastWorkAt === null || row.lastWorkAt < threshold);
  if (idle.length > 0) {
    const pick = idle.reduce((best, row) => (row.lastWorkAt ?? -Infinity) < (best.lastWorkAt ?? -Infinity) ? row : best);
    return { botId: pick.botId, name: pick.name, reasonText: '最近 30 天没有接活' };
  }
  const pick = eligible.reduce((best, row) => {
    if (row.openWorkCount !== best.openWorkCount) return row.openWorkCount < best.openWorkCount ? row : best;
    return (row.lastThinkAt ?? -Infinity) < (best.lastThinkAt ?? -Infinity) ? row : best;
  });
  // P73f：候选里没有人有在办事务（上面已排除），所以这里选的是最近一次思考最早的一位；给主人看的话与此一致。
  return { botId: pick.botId, name: pick.name, reasonText: '没有在办的事，最久没有接活' };
}

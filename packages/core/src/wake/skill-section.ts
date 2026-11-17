/**
 * 技能类回合的唤醒包段（P75g 第 6 节）：复盘唤醒的「本轮复盘」段。
 *
 * 做什么：把中心从记录里抄出的出处（src1、src2……）、这位员工现在的技能（自己积累，收起的一行）、
 * 岗位技能的名字和固定的「怎样提交」说明拼成一段。段 key 为 skill、不计入唤醒包原有预算，
 * 自带上限 SKILL_DEFAULTS.PACKET_MAX_BYTES（12 KB，方案第 17 节第 7 项）。
 *
 * 为什么原文要整段带：模型只看得到唤醒包。出处被删掉或截到认不出，它就无从「只能从这些出处学」；
 * 所以压缩逐级做（先截技能句子的正文、再截出处原文，每条出处至少保留标签和前 60 字），
 * 出处的标签和编号（src{k}）与「怎样提交」的调用写法任何时候都不删：宁可略超上限，也不删这几样。
 *
 * 本文件做复盘段（retro、不是 rewrite）；核对段、改写段（P75h）在 skill-check-section.ts，由 buildSkillSections 按事项键组合；
 * 整理的段由 P75i 加。
 */
import { SKILL_DEFAULTS as D } from '../config/defaults.js';
import type { HubContext } from '../engine/context.js';
import type { Bot, SkillSource } from '../model/index.js';
import { byteLength } from '../util/text.js';
import { SOURCE_KIND_LABELS } from '../api/skill-views.js';
import { parseSkillKey } from '../skill/keys.js';
import { jobTitleOf } from '../job/chain.js';
import { jobCategory } from '../project/agreement-category.js';
import { buildCheckSection, buildRewriteSection } from './skill-check-section.js';
import { buildLearnSection } from './skill-learn-section.js';
import { buildTidySection } from './skill-tidy-section.js';
import { FENCE_NOTICE, SKILL_SECTION_KEY, currentSkillLines, currentSkillsData, fenced, packetSourceLabel } from './skill-shared.js';
import type { PacketSection } from './sections.js';

/** 段 key；packet.ts 把它登记进「不计原有预算」的名单（定义在 skill-shared.ts，这里原样转出，旧的引用不变）。 */
export { SKILL_SECTION_KEY };

/** 固定说明（任务卡第 6 节第 5 条，逐字）。 */
export const SKILL_SECTION_INSTRUCTIONS = '怎样提交：调用 hub_skill，mode 写 propose，updates 每项写 skill（已有技能的编号，如 sk1；新建时不填）或 title 与 whenToUse（新建；title 只能用中文、英文字母、数字、空格和「-」「·」「、」，whenToUse 写成一行），sentences 每句写 text 与 sources（上面的 src 编号，至少一个）；同一条技能的多处新增合并成一项。验收结果只作对比，不单独写成技能。没有出处的做法不写。没有可写的，updates 写空数组，note 写一句为什么。最后调用 hub_commit 收尾，reply 写一句。';

/** 出处原文在第二级压缩里至少保留的字数（任务卡第 6 节：每条至少保留标签和原文前 60 字）。 */
const QUOTE_KEEP_CHARS = 60;

/**
 * 出处：第一行是中心生成的「src{k} {种类}｜{标签}：」（编号、标签留在围栏外，压缩时不删），
 * 下面是围栏，里面是出处原文（P75r5b：出处原文可能来自评审员、主人、总管转述，都当资料看）；
 * keep 不为空时原文只留前 keep 字（超出加省略号）。
 */
function sourceLine(k: number, source: SkillSource, keep: number | null): string {
  const chars = [...source.quote];
  const quote = keep !== null && chars.length > keep ? `${chars.slice(0, keep).join('')}…` : source.quote;
  return `src${k} ${SOURCE_KIND_LABELS[source.kind]}｜${packetSourceLabel(source)}：\n${fenced(quote)}`;
}

/** 出处太多时的取舍顺序：主人的纠正、验收结果、评审意见、其余；同类里新的在前。 */
const SOURCE_RANK: Record<string, number> = { owner_correction: 0, acceptance: 1, review: 2 };

/**
 * 技能类唤醒的全部段（P75h）：按事项键分派——
 * - 复盘唤醒（retro:）：这位核对人有等他核对的更新时（评审员的合并唤醒），先列「本轮核对技能更新」段，再列「本轮复盘」段；
 * - 技能核对唤醒（skillcheck:）：只有「本轮核对技能更新」段；
 * - 改写唤醒（retro:…:rewrite）：「改写技能更新」段；
 * - 学习唤醒（learn:，P75i）：「学习」段；
 * - 整理唤醒（tidy:，P75i）：「每周整理：你的技能库」段。
 * 没有内容可列的段不出现。组装出错由调用方（packet.ts）记日志、整体省略。
 * asOf（P75r5b，审查 L3）：这个回合的开始时刻；核对段只列这个时刻之前就在核对中的更新（与 check 认可的范围一致）。
 */
export function buildSkillSections(ctx: HubContext, bot: Bot, subjectKey: string | null | undefined, asOf: number | null = null): PacketSection[] {
  const parsed = parseSkillKey(subjectKey);
  if (parsed === null) return [];
  const sections: PacketSection[] = [];
  if (parsed.kind === 'retro' && parsed.rewrite) {
    const rewrite = buildRewriteSection(ctx, bot, parsed.runId);
    if (rewrite !== null) sections.push(rewrite);
  } else if (parsed.kind === 'skillcheck') {
    const check = buildCheckSection(ctx, bot, parsed.runId, asOf);
    if (check !== null) sections.push(check);
  } else if (parsed.kind === 'retro') {
    const check = buildCheckSection(ctx, bot, parsed.runId, asOf);
    if (check !== null) sections.push(check);
    const retro = buildSkillSection(ctx, bot, subjectKey);
    if (retro !== null) sections.push(retro);
  } else if (parsed.kind === 'learn') {
    const learn = buildLearnSection(ctx, bot, subjectKey);
    if (learn !== null) sections.push(learn);
  } else {
    const tidy = buildTidySection(ctx, bot, subjectKey);
    if (tidy !== null) sections.push(tidy);
  }
  return sections;
}

/**
 * 复盘段（retro、不是 rewrite）；其他技能类键返回 null（核对段、改写段在 skill-check-section.ts，由 buildSkillSections 组合）。
 * 组装出错只记日志、整段省略（与「你手上的事」段同一取舍，见 packet.ts）。
 */
export function buildSkillSection(ctx: HubContext, bot: Bot, subjectKey: string | null | undefined): PacketSection | null {
  const parsed = parseSkillKey(subjectKey);
  if (parsed === null || parsed.kind !== 'retro' || parsed.rewrite) return null;
  const run = ctx.store.table('skillRuns').get(parsed.runId);
  if (run === null) return null;
  const participant = run.participants.find(row => row.botId === bot.id);
  if (participant === undefined) return null;
  const job = run.jobId === null ? null : ctx.store.table('jobs').get(run.jobId);
  const title = job === null ? '这件事' : jobTitleOf(ctx, job);
  const category = run.category ?? (job === null ? null : jobCategory(ctx, job.id));

  // 每条出处一行，src 编号按参与者的 sourceIds 顺序（对照存在记录上，不另存）。
  const sources = participant.sourceIds
    .map(id => ctx.store.table('skillSources').get(id))
    .filter((row): row is SkillSource => row !== null);

  // 自己积累的技能、不常用、岗位技能：学习段（skill-learn-section.ts）用同一份。
  const skills = currentSkillsData(ctx, bot);

  // P75r5b（审查 L4）：出处最多列 RETRO_SOURCES_LISTED_MAX 条。超出时按「主人的纠正、验收结果、评审意见」的顺序取（同类里新的在前），
  // 超出的不列、末尾写一句「另有 n 条出处没有列出。」；编号仍按参与者全部出处的顺序，提交时的校验认这位参与者全部的出处编号。
  // 不超出时保持原来的顺序。
  const numbered = sources.map((source, index) => ({ source, k: index + 1 }));
  const listed = numbered.length <= D.RETRO_SOURCES_LISTED_MAX ? numbered
    : [...numbered].sort((a, b) => (SOURCE_RANK[a.source.kind] ?? 3) - (SOURCE_RANK[b.source.kind] ?? 3) || b.source.createdAt - a.source.createdAt || b.k - a.k)
      .slice(0, D.RETRO_SOURCES_LISTED_MAX);
  const omitted = numbered.length - listed.length;

  /** 按压缩级别拼整段：0 完整；1 技能句子正文省略；2 再加出处原文截到 60 字。 */
  const render = (level: 0 | 1 | 2): string => [
    '这件事已由主人验收。下面是中心从记录里抄出的出处，只能从这些出处学：',
    FENCE_NOTICE,
    ...listed.map(row => sourceLine(row.k, row.source, level === 2 ? QUOTE_KEEP_CHARS : null)),
    ...(omitted > 0 ? [`另有 ${omitted} 条出处没有列出。`] : []),
    ...currentSkillLines(skills, level === 0),
    SKILL_SECTION_INSTRUCTIONS,
  ].join('\n');

  // 逐级压缩（方案第 17 节第 7 项）：放得下就停；到第 2 级仍超出时不再删（出处的标签、编号与调用写法不能删）。
  let body = render(0);
  for (const level of [1, 2] as const) {
    if (byteLength(body) <= D.PACKET_MAX_BYTES) break;
    body = render(level);
  }
  return {
    key: SKILL_SECTION_KEY,
    title: `## 本轮复盘：${title}${category === null ? '' : `（类别：${category}）`}`,
    body,
  };
}

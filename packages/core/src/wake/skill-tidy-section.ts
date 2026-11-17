/**
 * 每周整理唤醒包的段（P75i 第 5.3 节）：这位员工在用的自己积累技能的全文，让他只做「合并重复」。
 *
 * 段标题「## 每周整理：你的技能库」；正文依次是：固定说明（逐字）、每条在用技能「{名称}（第 {n} 版）」和它逐句的
 * 「{k}. {句子}（出处 src1、src2）」、出处表「src{k} {种类}｜{标签}」（不放原文，省篇幅）、调用写法（逐字）。
 *
 * 为什么只给句子和出处的标签、不给出处原文：整理只判断两条技能是不是在说同一类事、合并后的每一句能不能用两条原技能里已有的出处，
 * 不需要重新读原文；原文由核对人核对时再看。
 */
import type { HubContext } from '../engine/context.js';
import type { Bot } from '../model/index.js';
import { SOURCE_KIND_LABELS } from '../api/skill-views.js';
import { skillRunOfKey } from '../skill/keys.js';
import { tidySkillsOf, tidySourceOrder } from '../skill/tidy-sources.js';
import { SKILL_NOTE_HINT } from '../job/owner-text.js';
import { skillRefOf } from '../skill/skill-ref.js';
import { FENCE_NOTICE, SKILL_SECTION_KEY, fenced, packetSourceLabel, skillNameLine } from './skill-shared.js';
import type { PacketSection } from './sections.js';

/** 固定说明（任务卡 5.3，逐字）。 */
export const TIDY_SECTION_INTRO = '只做合并重复：两条技能说的是同一类事、内容重复的，并成一条。不改写措辞，不凭空新增，合并后的每一句只能用两条原技能里已有的出处。发现两条互相矛盾，不要自己裁决，写进 note。';

/** 调用写法（任务卡 5.3，逐字）。 */
export const TIDY_SECTION_HOW = `调用 hub_skill，mode 写 tidy，merges 每项写 from（被并入的技能的编号，如 sk1）、into（保留的技能的编号）、reason（一句话说明为什么重复）、sentences（合并后 into 的全部句子，text 与 sources）；没有可合并的，merges 写空数组。note 写一句发现（没有就写「没有发现相互矛盾的条目」）。${SKILL_NOTE_HINT}`;

/** 整理段：事项键是 tidy:…、这位员工是被整理的员工时才有；没有在用技能时也给（让他写空数组）。 */
export function buildTidySection(ctx: HubContext, bot: Bot, subjectKey: string | null | undefined): PacketSection | null {
  const run = skillRunOfKey(ctx, subjectKey);
  if (run === null || run.kind !== 'tidy' || !run.participants.some(row => row.botId === bot.id && row.role !== 'checker')) return null;
  const skills = tidySkillsOf(ctx, bot.id);
  const order = tidySourceOrder(ctx, run, bot.id);
  const srcOf = (id: string): string => `src${order.indexOf(id) + 1}`;
  const used: string[] = [];
  const lines: string[] = [TIDY_SECTION_INTRO, FENCE_NOTICE];
  for (const { skill, version } of skills) {
    // P75r6（N2）：技能名称是模型写的，放进围栏；围栏外只有技能编号（sk1，合并时 from、into 写它）和版本。
    lines.push(`- ${skillRefOf(ctx, bot.id, skill.id) ?? 'sk?'}（第 ${skill.currentVersionNo} 版）：`, fenced(skillNameLine(skill.title)));
    version.sentences.forEach((sentence, index) => {
      for (const id of sentence.sourceIds) if (!used.includes(id)) used.push(id);
      // P75r5b（审查 M4）：编号与出处编号由中心生成、留在围栏外；句子本身（模型写进技能库的文字）放进围栏。
      lines.push(`${index + 1}.（出处 ${sentence.sourceIds.map(srcOf).join('、')}）`, fenced(sentence.text));
    });
  }
  if (skills.length === 0) lines.push('暂无在用的技能');
  // 出处表按编号从小到大；只列这些技能用到的出处，不放原文。
  const table = used.slice().sort((a, b) => order.indexOf(a) - order.indexOf(b)).map(id => {
    const source = ctx.store.table('skillSources').get(id);
    return source === null ? `${srcOf(id)} 记录里已经找不到` : `${srcOf(id)} ${SOURCE_KIND_LABELS[source.kind]}｜${packetSourceLabel(source)}`;
  });
  if (table.length > 0) lines.push('出处：', ...table);
  lines.push(TIDY_SECTION_HOW);
  return { key: SKILL_SECTION_KEY, title: '## 每周整理：你的技能库', body: lines.join('\n') };
}

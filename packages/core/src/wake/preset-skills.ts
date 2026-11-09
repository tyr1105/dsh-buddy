/**
 * 唤醒包里的预置 skill 段（P40）。
 *
 * 只列名称、一句话用途与加载条件：正文已经在队友家目录 `.agents/skills/<id>/SKILL.md`，
 * 需要时队友自己读；不把全文塞进唤醒包，避免挤占预算，也不让 skill 看起来像新指令。
 * 加载条件三档：
 * - every_wake：每次唤醒都列出（轻复查也列）；
 * - project_work：本轮在推进项目任务时才列出；
 * - task_type：本轮的活（任务标题/说明、议程标题、唤醒理由）命中关键词时才列出。
 * 这一段是只读提示，不提高任何工具权限、审批豁免或资料可见性。
 */
import type { Bot } from '../model/index.js';
import {
  PRESET_SKILL_CONDITION_LABELS, presetSkillsFor, type PresetSkill, type PresetSkillCondition,
} from '../config/preset-skills.js';
import type { PacketSection } from './sections.js';

/** 本轮判定加载条件所需的上下文，全部由调用方显式传入，便于测试。 */
export interface PresetSkillRound {
  /** 本轮是否有派给自己的项目任务（只有这类回合才算「项目工作」）。 */
  projectWork: boolean;
  /** 本轮的活的可匹配文本：任务标题与说明、议程标题、唤醒理由。 */
  triggerText: string;
  /** 轻复查只列 every_wake，保持简版回合足够轻。 */
  lightCheck: boolean;
}

/** 判断一个预置项本轮是否该出现在唤醒包里；纯函数，方便逐档写测试。 */
export function presetSkillActive(skill: PresetSkill, round: PresetSkillRound): boolean {
  if (skill.condition === 'every_wake') return true;
  if (round.lightCheck) return false;
  if (skill.condition === 'project_work') return round.projectWork;
  // task_type：任务模型没有类型字段，用预置自带关键词做保守匹配。
  return skill.taskKeywords.some(keyword => keyword !== '' && round.triggerText.includes(keyword));
}

/** 组装技能段；一项都没命中时返回 null，整段不占唤醒包预算。 */
export function buildPresetSkillsSection(bot: Bot, round: PresetSkillRound): PacketSection | null {
  const active = presetSkillsFor(bot.presetSkillIds).filter(skill => presetSkillActive(skill, round));
  if (active.length === 0) return null;
  const lines = active.map(skill => `- ${skill.name}：${skill.purpose}（加载条件：${PRESET_SKILL_CONDITION_LABELS[skill.condition]}）`);
  return {
    key: 'preset-skills',
    title: '## 你可用的预置 skill（只列名称与用途，不代表更多权限）',
    body: [...lines, '正文在你家目录 .agents/skills/<id>/SKILL.md，需要时自己读；它们不改变工具权限、审批与事实要求。'].join('\n'),
  };
}

/** 条件文案在别处（界面）也要用，这里转出一次避免重复导入清单常量。 */
export function presetSkillConditionLabel(condition: PresetSkillCondition): string {
  return PRESET_SKILL_CONDITION_LABELS[condition];
}

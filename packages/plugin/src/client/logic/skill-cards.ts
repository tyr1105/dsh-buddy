/**
 * 复盘卡与技能核对卡（P75k，设计稿场景 A、B）用到的固定文字与小判断。
 *
 * 卡片内容完全照 core 的视图画：标题、计数一行、每行的出处与去向、底部一句、状态小章、三项检查与结论、
 * 核对人的说明，界面都原样显示，不自己拼。这里只放界面自己的几处固定小标题，以及按 core 给的字面取样式类名。
 * 固定文字登记在 docs/copy/strings.json 的 RTR- 前缀下。
 */
import type { SkillCheckCardView } from '../../shared/views.js'

export const SKILL_CARD_TEXT = {
  /** 核对卡左边一块的小标题：出处原文由插件从记录里原样取出，员工不能改写。 */
  sourceBlock: '出处原文',
  /** 核对卡右边一块的小标题：员工写的更新内容。 */
  contentBlock: '更新内容',
  /** 三项检查那一块的可达名称。 */
  checksLabel: '三项检查',
  /** 复盘卡每行中间的箭头，只作视觉，读屏不读。 */
  arrow: '→',
} as const

/** 一项检查结论的样式类名：符合用成功色，不符用警示色（不只靠颜色，文字「符合」「不符」同时在）。 */
export function verdictClass(verdict: SkillCheckCardView['checks'][number]['verdict']): string {
  return verdict === '符合' ? 'ah-skillcheck-ok' : 'ah-skillcheck-bad'
}

/** 状态小章的样式类名：已写入成功色，未写入警示色，等待改写中性色。 */
export function stateChipClass(state: SkillCheckCardView['stateText']): string {
  if (state === '已写入') return 'ah-skillcheck-ok'
  if (state === '未写入') return 'ah-skillcheck-bad'
  return 'ah-skillcheck-wait'
}

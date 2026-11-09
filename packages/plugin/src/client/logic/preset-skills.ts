/**
 * 预置 skill 的界面纯逻辑（P40）。
 *
 * 界面只拿得到候选清单的 id、名称、用途与加载条件，正文留在 core；
 * 这里负责勾选切换、按三档条件分组、把已选项翻成人话，以及提交前过滤掉已下线的 id。
 * 全部是纯函数，向导与右栏档案共用，也便于单测。
 */
import type { PresetSkillOption } from '../../shared/views.js'

/** 通用项和岗位专属项分开：岗位专属有十几条，选择界面默认收起，不把通用项淹没（P52）。 */
export function splitPresetSkillOptions(options: readonly PresetSkillOption[]): { general: PresetSkillOption[]; role: PresetSkillOption[] } {
  return { general: options.filter(option => option.audience !== 'role'), role: options.filter(option => option.audience === 'role') }
}

/** 勾选/取消一个预置项；取消后保持其余项原有顺序（顺序即主人在清单里的勾选次序）。 */
export function togglePresetSkill(selected: readonly string[], id: string): string[] {
  return selected.includes(id) ? selected.filter(item => item !== id) : [...selected, id]
}

/** 只保留清单里仍存在的 id，避免旧草稿带着已下线的项提交被 core 拒绝。 */
export function knownPresetSkillIds(selected: readonly string[], options: readonly PresetSkillOption[]): string[] {
  const known = new Set(options.map(option => option.id))
  return selected.filter(id => known.has(id))
}

/** 已选名称（按清单顺序），用于只读展示；未知 id 不显示内部 id。 */
export function presetSkillNames(selected: readonly string[], options: readonly PresetSkillOption[]): string[] {
  const picked = new Set(selected)
  return options.filter(option => picked.has(option.id)).map(option => option.name)
}

/** 只读展示的一句话：没选就说未启用，不显示空列表。 */
export function presetSkillSummary(selected: readonly string[], options: readonly PresetSkillOption[]): string {
  const names = presetSkillNames(selected, options)
  return names.length === 0 ? '未启用' : names.join('、')
}

/** 按加载条件分组（保持清单顺序），组标题直接用中文条件说明。 */
export function groupPresetSkillOptions(options: readonly PresetSkillOption[]): Array<{ condition: PresetSkillOption['condition']; label: string; items: PresetSkillOption[] }> {
  const groups: Array<{ condition: PresetSkillOption['condition']; label: string; items: PresetSkillOption[] }> = []
  for (const option of options) {
    const group = groups.find(item => item.condition === option.condition)
    if (group) group.items.push(option)
    else groups.push({ condition: option.condition, label: option.conditionLabel, items: [option] })
  }
  return groups
}

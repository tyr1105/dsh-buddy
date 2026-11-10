/**
 * 岗位技能选择的界面纯逻辑（P40 起步，P55 增加 DSH 技能）。
 *
 * 选择界面有两组：「队友自带」是插件内置的做事方法，「DSH 里的技能」来自主人电脑。
 * 这里负责勾选切换、搜索过滤、把已选项翻成人话，以及提交前过滤掉已下线的项。
 * 全部是纯函数，新建队友与编辑队友共用，也便于单测。
 */
import type { DshSkillOption, PresetSkillOption } from '../../shared/views.js'

/** 自带技能的数量上限，和 core 的校验一致。 */
export const MAX_PRESET_SKILLS = 8
/** DSH 技能的数量上限，和 core 的校验一致。 */
export const MAX_DSH_SKILLS = 20

/** 通用项和岗位专属项分开：岗位专属有十几条，选择界面默认收起，不把通用项淹没（P52）。 */
export function splitPresetSkillOptions(options: readonly PresetSkillOption[]): { general: PresetSkillOption[]; role: PresetSkillOption[] } {
  return { general: options.filter(option => option.audience !== 'role'), role: options.filter(option => option.audience === 'role') }
}

/** 勾选/取消一项；取消后保持其余项原有顺序（顺序即主人的勾选次序）。 */
export function toggleSkill(selected: readonly string[], id: string): string[] {
  return selected.includes(id) ? selected.filter(item => item !== id) : [...selected, id]
}

/** 只保留清单里仍存在的 id，避免旧草稿带着已下线的项提交被 core 拒绝。 */
export function knownPresetSkillIds(selected: readonly string[], options: readonly PresetSkillOption[]): string[] {
  const known = new Set(options.map(option => option.id))
  return selected.filter(id => known.has(id))
}

/**
 * 已选名称（按清单顺序），用于只读展示。
 * DSH 技能可能被主人删掉了，目录里找不到时仍显示它的名字，主人才知道这一项已经失效。
 */
export function selectedSkillNames(
  presetSelected: readonly string[], dshSelected: readonly string[], presetOptions: readonly PresetSkillOption[],
): string[] {
  const picked = new Set(presetSelected)
  return [...presetOptions.filter(option => picked.has(option.id)).map(option => option.name), ...dshSelected]
}

/** 只读展示的一句话：没选就说未选择，不显示空列表。 */
export function skillSummary(
  presetSelected: readonly string[], dshSelected: readonly string[], presetOptions: readonly PresetSkillOption[],
): string {
  const names = selectedSkillNames(presetSelected, dshSelected, presetOptions)
  return names.length === 0 ? '未选择' : names.join('、')
}

/** 搜索：不区分大小写，名字和用途都搜；空关键词不过滤。 */
export function matchesSkillQuery(query: string, ...texts: readonly string[]): boolean {
  const keyword = query.trim().toLowerCase()
  return keyword === '' || texts.some(text => text.toLowerCase().includes(keyword))
}

/**
 * DSH 技能的显示顺序：已选的排最前。
 * 目录可能有上百项，选中的项不排上来，主人很难确认自己选了什么。
 * 选中后已经不在目录里的也要显示，否则主人取消不掉。
 */
export function orderDshSkills(options: readonly DshSkillOption[], selected: readonly string[]): DshSkillOption[] {
  const known = new Set(options.map(option => option.name))
  const missing = selected.filter(name => !known.has(name)).map(name => ({ name, description: '这个技能已经不在 DSH 里了' }))
  const picked = options.filter(option => selected.includes(option.name))
  const rest = options.filter(option => !selected.includes(option.name))
  return [...missing, ...picked, ...rest]
}

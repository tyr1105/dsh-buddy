/**
 * 预置 skill 选择器（P40）：向导与右栏档案共用的多选清单。
 *
 * 按三档加载条件分组，每项显示名称、一句话用途与条件；勾选只改 id 列表，
 * 物化与清理由 core 在保存档案时完成。这里不提供新增/编辑入口：
 * 预置内容随插件版本走，主人只能决定「这个队友用哪几项」。
 * 岗位专属技能（P52）有十几条，放进默认收起的一组，通用项仍然一眼能看完。
 */
import { useState, type ReactNode } from 'react'
import { groupPresetSkillOptions, splitPresetSkillOptions, togglePresetSkill } from '../logic/preset-skills.js'
import type { PresetSkillOption } from '../../shared/views.js'

export function PresetSkillPicker(props: {
  options: readonly PresetSkillOption[]
  selected: readonly string[]
  disabled?: boolean
  onChange: (ids: string[]) => void
}): ReactNode {
  const { general, role } = splitPresetSkillOptions(props.options)
  // 只在第一次渲染时决定：已经选了岗位技能就展开。之后由主人自己开合，勾选时不会突然收起。
  const [roleOpenAtStart] = useState(() => role.some(option => props.selected.includes(option.id)))
  if (props.options.length === 0) return <p className="ah-right-kv">预置 skill 清单还没加载出来。</p>
  const groups = groupPresetSkillOptions(general)

  /** 一行勾选项：通用组和岗位专属组共用同一种样子。 */
  const renderItem = (option: PresetSkillOption): ReactNode => (
    <label key={option.id} className="ah-skill-item">
      <input type="checkbox" checked={props.selected.includes(option.id)} disabled={props.disabled}
        onChange={() => props.onChange(togglePresetSkill(props.selected, option.id))} />
      <span className="ah-skill-text">
        <strong>{option.name}</strong>
        <span className="ah-skill-purpose">{option.purpose}</span>
      </span>
    </label>
  )

  return (
    <div className="ah-skill-picker">
      {groups.map(group => (
        <fieldset key={group.condition} className="ah-skill-group">
          <legend className="ah-skill-group-title">{group.label}</legend>
          {group.items.map(renderItem)}
        </fieldset>
      ))}
      {role.length > 0 ? (
        <details className="ah-skill-role" open={roleOpenAtStart}>
          <summary className="ah-skill-group-title">岗位专属技能（{role.length} 项）</summary>
          <div className="ah-skill-group">{role.map(renderItem)}</div>
        </details>
      ) : null}
      <p className="ah-right-kv">只影响它做事时参考哪份检查清单，不提高工具权限，也不绕过审批。</p>
    </div>
  )
}

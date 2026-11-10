/**
 * 岗位技能选择器（P55）：新建队友表单与队友编辑弹窗共用。
 *
 * 分两组：「队友自带」是插件内置的做事方法，「DSH 里的技能」来自主人电脑。
 * DSH 技能可能上百个，所以有搜索框，列表限高滚动，已选的排在最前面。
 * 选中的技能才会出现在这位队友的技能清单里，其他技能它看不到。
 * 这里只改选择结果，真正生效由 core 和宿主完成。
 */
import { useState, type ReactNode } from 'react'
import {
  MAX_DSH_SKILLS, MAX_PRESET_SKILLS, matchesSkillQuery, orderDshSkills, splitPresetSkillOptions, toggleSkill,
} from '../logic/preset-skills.js'
import type { DshSkillOption, PresetSkillOption } from '../../shared/views.js'

export function SkillPicker(props: {
  presetOptions: readonly PresetSkillOption[]
  dshOptions: readonly DshSkillOption[]
  presetSelected: readonly string[]
  dshSelected: readonly string[]
  disabled?: boolean
  onChange: (next: { presetSkillIds: string[]; dshSkillNames: string[] }) => void
}): ReactNode {
  const [query, setQuery] = useState('')
  const { general, role } = splitPresetSkillOptions(props.presetOptions)
  // 只在第一次渲染时决定：已经选了岗位技能就展开。之后由主人自己开合，勾选时不会突然收起。
  const [roleOpenAtStart] = useState(() => role.some(option => props.presetSelected.includes(option.id)))
  // 打开时已选的排在最前；打开之后新勾的留在原位，否则列表一边勾一边跳，容易点错。
  const [pinnedAtOpen] = useState(() => [...props.dshSelected])

  const presetFull = props.presetSelected.length >= MAX_PRESET_SKILLS
  const dshFull = props.dshSelected.length >= MAX_DSH_SKILLS
  const searching = query.trim() !== ''
  const matchesPreset = (option: PresetSkillOption): boolean => matchesSkillQuery(query, option.name, option.purpose)
  const shownGeneral = general.filter(matchesPreset)
  const shownRole = role.filter(matchesPreset)
  const shownDsh = orderDshSkills(props.dshOptions, pinnedAtOpen)
    .filter(option => matchesSkillQuery(query, option.name, option.description))
  const total = props.presetSelected.length + props.dshSelected.length

  /** 自带技能的一行；到上限后没选的项不能再勾，已选的仍可取消。 */
  const presetItem = (option: PresetSkillOption): ReactNode => {
    const checked = props.presetSelected.includes(option.id)
    return (
      <label key={option.id} className="ah-skill-item">
        <input type="checkbox" checked={checked} disabled={props.disabled || (presetFull && !checked)}
          onChange={() => props.onChange({ presetSkillIds: toggleSkill(props.presetSelected, option.id), dshSkillNames: [...props.dshSelected] })} />
        <span className="ah-skill-text">
          <strong>{option.name}</strong>
          <span className="ah-skill-purpose">{option.purpose}</span>
        </span>
      </label>
    )
  }

  return (
    <div className="ah-skill-picker">
      <input type="search" className="ah-skill-search" aria-label="搜技能" placeholder="搜技能" value={query}
        disabled={props.disabled} onChange={e => setQuery(e.target.value)} />
      {/* 选中数量变化时读屏会念这一行。 */}
      <p className="ah-right-kv" role="status">{total > 0 ? `已选 ${total} 个，队友只看得到选中的技能` : '不选的话，这位队友没有技能可用'}</p>

      {props.presetOptions.length > 0 ? (
        <fieldset className="ah-skill-group">
          <legend className="ah-skill-group-title">队友自带</legend>
          {shownGeneral.map(presetItem)}
          {shownRole.length > 0 ? (
            /* 搜索时强制展开，否则搜到的结果藏在折叠里，看起来像没搜到。 */
            <details className="ah-skill-role" open={searching || roleOpenAtStart}>
              <summary className="ah-skill-group-title">岗位专属（{shownRole.length} 项）</summary>
              <div className="ah-skill-group">{shownRole.map(presetItem)}</div>
            </details>
          ) : null}
        </fieldset>
      ) : null}

      <fieldset className="ah-skill-group">
        <legend className="ah-skill-group-title">DSH 里的技能（{props.dshOptions.length} 个）</legend>
        {props.dshOptions.length === 0 && props.dshSelected.length === 0 ? (
          <p className="ah-right-kv">DSH 里暂时没有可选的技能。</p>
        ) : shownDsh.length === 0 ? (
          <p className="ah-right-kv">没有搜到相关技能。</p>
        ) : (
          <div className="ah-skill-scroll">
            {shownDsh.map(option => {
              const checked = props.dshSelected.includes(option.name)
              return (
                <label key={option.name} className="ah-skill-item">
                  <input type="checkbox" checked={checked} disabled={props.disabled || (dshFull && !checked)}
                    onChange={() => props.onChange({ presetSkillIds: [...props.presetSelected], dshSkillNames: toggleSkill(props.dshSelected, option.name) })} />
                  <span className="ah-skill-text">
                    <strong>{option.name}</strong>
                    <span className="ah-skill-purpose">{option.description}</span>
                  </span>
                </label>
              )
            })}
          </div>
        )}
      </fieldset>
      {presetFull || dshFull ? <p className="ah-right-kv">已到上限：自带最多 {MAX_PRESET_SKILLS} 个，DSH 技能最多 {MAX_DSH_SKILLS} 个。</p> : null}
    </div>
  )
}

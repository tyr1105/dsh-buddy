/**
 * 编辑员工弹窗里的「性格（MBTI）」一项（P73f，设计稿场景 D）。
 *
 * 样子：一个按钮写「ISTJ　改为…」，点开后四个维度各一组二选一（外向或内向、实感或直觉、思考或情感、判断或知觉），
 * 选完立即更新下面的四句话（性格怎样影响做事）；这些改动只改弹窗里的草稿，点「保存」之后才提交给员工。
 * 旧员工没有设置性格时按钮写「未设置　选择…」，四个维度都选完才算有了类型；也可以点「不设置」回到未设置。
 *
 * 为什么单独成文件：弹窗和「自己从头配置」的表单共用；四句话由 core 的总表给出（mbtiBehaviorLines），
 * 这里不写任何性格文字，只管选择和排版。四个维度的拼接规则沿用组队卡的纯函数（logic/team-card.ts）。
 */
import { useState, type ReactNode } from 'react'
import { mbtiBehaviorLines } from '@agent-hub/core/team'
import { MBTI_AXES, mbtiWithAxis } from '../logic/team-card.js'
import { isMbtiType, type MbtiDraft } from '../logic/wizard.js'
import { PersonalityLines } from './PersonalityLines.js'

/** 这一项用到的界面文字，登记在 docs/copy/strings.json（编号前缀 TEAM-）。 */
export const PERSONALITY_FIELD_TEXT = {
  label: '性格（MBTI）',
  /** 已设置：「{类型}　改为…」；未设置：「未设置　选择…」。 */
  openSet: (type: string): string => `${type}　改为…`,
  openUnset: '未设置　选择…',
  hint: '改了之后，上面的四句话随之改变。',
  clear: '不设置',
} as const

export function PersonalityField(props: {
  value: MbtiDraft
  onChange: (value: MbtiDraft) => void
  disabled?: boolean
}): ReactNode {
  const [open, setOpen] = useState(false)
  /** 当前还没有类型时，已经选好的维度（按 E/I、S/N、T/F、J/P 顺序，空串表示还没选）。 */
  const [picks, setPicks] = useState<string[]>(['', '', '', ''])
  const type = props.value
  const lines = mbtiBehaviorLines(type === '' ? null : type)

  /** 某个维度当前选的字母：已有类型取类型里的，否则取还没拼完的草稿里的。 */
  const choiceOf = (axisIndex: 0 | 1 | 2 | 3): string => (type === '' ? picks[axisIndex] ?? '' : [...type][axisIndex] ?? '')

  /** 选了某个维度的某个字母：已有类型就改这一位；还没有类型就先记下，四个都选完再拼成类型。 */
  const pick = (axisIndex: 0 | 1 | 2 | 3, code: string): void => {
    if (type !== '') {
      const next = mbtiWithAxis(type, axisIndex, code)
      if (isMbtiType(next)) props.onChange(next)
      return
    }
    const nextPicks = [...picks]
    nextPicks[axisIndex] = code
    setPicks(nextPicks)
    const joined = nextPicks.join('')
    if (isMbtiType(joined)) props.onChange(joined)
  }

  return (
    <div className="ah-wizard-field ah-personality-field">
      <span className="ah-wizard-label">{PERSONALITY_FIELD_TEXT.label}</span>
      <div className="ah-choice-row">
        <button type="button" className="ah-choice" aria-expanded={open} disabled={props.disabled}
          onClick={() => setOpen(current => !current)}>
          {type === '' ? PERSONALITY_FIELD_TEXT.openUnset : PERSONALITY_FIELD_TEXT.openSet(type)}
        </button>
      </div>
      {open ? (
        <div className="ah-team-editor">
          {MBTI_AXES.map(axis => (
            <div key={axis.index} className="ah-team-axis" role="radiogroup" aria-label={axis.options.map(option => option.name).join('或')}>
              {axis.options.map(option => {
                const checked = choiceOf(axis.index) === option.code
                return (
                  <button key={option.code} type="button" role="radio" aria-checked={checked} disabled={props.disabled}
                    className={`ah-agr-chip${checked ? ' is-selected' : ''}`}
                    onClick={() => { if (!checked) pick(axis.index, option.code) }}>
                    {option.code}　{option.name}
                  </button>
                )
              })}
            </div>
          ))}
          {type !== '' ? (
            <button type="button" className="ah-btn ah-btn-ghost" disabled={props.disabled}
              onClick={() => { setPicks(['', '', '', '']); props.onChange('') }}>{PERSONALITY_FIELD_TEXT.clear}</button>
          ) : null}
        </div>
      ) : null}
      {lines !== null ? <PersonalityLines lines={lines} label={`性格 ${type} 的实际行为`} /> : null}
      <p className="ah-right-kv">{PERSONALITY_FIELD_TEXT.hint}</p>
    </div>
  )
}

/**
 * 队友配置的表单字段（P55）：新建队友和「编辑队友」弹窗用同一份。
 *
 * 主人定下的八项：名字、执行风格、性格、说话风格、MBTI、自主节奏、模型、岗位技能，
 * 其余要求都写进员工说明。这个组件只管显示和收集，校验规则在 logic/wizard.ts。
 *
 * 选择题用按钮加 aria-pressed，键盘和读屏都能用；再点一次已选项可以取消，这两题本来就可以不选。
 */
import type { ReactNode, Ref } from 'react'
import type { DshSkillOption, PresetSkillOption } from '../../shared/views.js'
import { modelSelectOptions } from '../logic/settings.js'
import {
  BRIEF_MAX, MBTI_OPTIONS, RHYTHM_OPTIONS, ROLE_CARDS, SPEECH_STYLE_OPTIONS, TEMPERAMENT_OPTIONS, problemField, rhythmAllowed,
  type BotConfigDraft, type ChoiceOption, type MbtiDraft, type RoleCard,
} from '../logic/wizard.js'
import { SkillPicker } from './skill-picker.js'

/** 旧草稿里的模型序列化安全解析（坏数据当没选）。 */
function safeModel(serialized: string): { provider: string; model: string } | undefined {
  try {
    const value = JSON.parse(serialized) as { provider?: unknown; model?: unknown }
    if (typeof value?.provider === 'string' && typeof value?.model === 'string') return { provider: value.provider, model: value.model }
  } catch { /* 坏草稿当没选 */ }
  return undefined
}

/** 一道单选题：一排小按钮，下面一行说明当前选项的意思。 */
function ChoiceField<T extends string>(props: {
  label: string
  options: ReadonlyArray<ChoiceOption<T>>
  value: T | ''
  disabled?: boolean
  onChange: (value: T | '') => void
}): ReactNode {
  const current = props.options.find(option => option.value === props.value)
  return (
    <div className="ah-wizard-field">
      <span className="ah-wizard-label">{props.label}</span>
      <div className="ah-choice-row" role="group" aria-label={props.label}>
        {props.options.map(option => (
          <button key={option.value} type="button" className="ah-choice" aria-pressed={option.value === props.value} disabled={props.disabled}
            onClick={() => props.onChange(option.value === props.value ? '' : option.value)}>{option.label}</button>
        ))}
      </div>
      {current ? <p className="ah-right-kv">{current.desc}</p> : null}
    </div>
  )
}

export function BotConfigFields(props: {
  draft: BotConfigDraft
  onChange: (partial: Partial<BotConfigDraft>) => void
  modelOptions: ReadonlyArray<{ value: unknown; label: string }>
  modelOptionsError?: string | null
  onRetryModels?: () => void
  presetSkillOptions: readonly PresetSkillOption[]
  dshSkillOptions: readonly DshSkillOption[]
  /** 别的队友已经是总管了：总管全队只能有一个。 */
  chiefTaken: boolean
  disabled?: boolean
  /** 只有用户尝试提交后才传，刚打开表单时不要红字吓人。 */
  problem: string | null
  nameInputRef?: Ref<HTMLInputElement>
  rolesRef?: Ref<HTMLDivElement>
  briefInputRef?: Ref<HTMLTextAreaElement>
  autoFocusName?: boolean
}): ReactNode {
  const { draft, onChange } = props
  const field = problemField(props.problem)
  const nameProblem = field === 'name' ? props.problem : null
  const roleProblem = field === 'role' ? props.problem : null
  const briefProblem = field === 'brief' ? props.problem : null

  /** 切到建议风格时，把不允许的节奏退回「提建议」，不留下一个提交时才报错的组合。 */
  const pickRole = (card: RoleCard): void => {
    onChange({ role: card.role, ...(rhythmAllowed(card.role, draft.rhythm) ? {} : { rhythm: 'advise' as const }) })
  }

  return (
    <div className="ah-config-form">
      <div className="ah-wizard-field">
        <label>名字<input ref={props.nameInputRef} value={draft.name} disabled={props.disabled} autoFocus={props.autoFocusName}
          aria-invalid={nameProblem !== null || undefined} aria-describedby={nameProblem !== null ? 'ah-config-err-name' : undefined}
          onChange={e => onChange({ name: e.target.value })} placeholder="例如：巡检员" /></label>
        {nameProblem ? <p className="ah-settings-error" id="ah-config-err-name" role="alert">{nameProblem}</p> : null}
      </div>

      <div className="ah-wizard-field">
        <span className="ah-wizard-label">执行风格</span>
        <div className="ah-wizard-roles ah-config-roles" ref={props.rolesRef} role="group" aria-label="执行风格">
          {ROLE_CARDS.map(card => {
            const blocked = card.role === 'chief' && props.chiefTaken && draft.role !== 'chief'
            return (
              <button key={card.role} type="button" disabled={blocked || props.disabled} aria-pressed={draft.role === card.role}
                aria-invalid={roleProblem !== null || undefined} aria-describedby={roleProblem !== null ? 'ah-config-err-role' : undefined}
                className={`ah-wizard-role${draft.role === card.role ? ' ah-wizard-role-picked' : ''}${blocked ? ' ah-wizard-role-disabled' : ''}`}
                onClick={() => pickRole(card)}>
                <strong>{card.label}</strong>
                <span>{blocked ? '已有总管' : card.desc}</span>
              </button>
            )
          })}
        </div>
        {roleProblem ? <p className="ah-settings-error" id="ah-config-err-role" role="alert">{roleProblem}</p> : null}
      </div>

      <ChoiceField label="性格" options={TEMPERAMENT_OPTIONS} value={draft.temperament} disabled={props.disabled}
        onChange={value => onChange({ temperament: value })} />
      <ChoiceField label="说话风格" options={SPEECH_STYLE_OPTIONS} value={draft.speechStyle} disabled={props.disabled}
        onChange={value => onChange({ speechStyle: value })} />

      <div className="ah-config-pair">
        <label className="ah-config-select">MBTI
          <select value={draft.mbti} disabled={props.disabled} onChange={e => onChange({ mbti: e.target.value as MbtiDraft })}>
            <option value="">不设置</option>
            {MBTI_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        {/* 下拉直接用视图的模型目录；旧草稿里已下架的模型补一项如实显示。 */}
        <label className="ah-config-select">模型
          <select value={draft.model === '' ? 'null' : draft.model} disabled={props.disabled} onChange={e => onChange({ model: e.target.value === 'null' ? '' : e.target.value })}>
            {modelSelectOptions(draft.model === '' || draft.model === 'null' ? undefined : safeModel(draft.model), props.modelOptions)
              .map((option, i) => (
                <option key={i} value={option.value === null ? 'null' : JSON.stringify(option.value)}>{option.value === null ? '跟随 DSH 默认' : option.label}</option>
              ))}
          </select>
          {props.modelOptionsError ? (
            <span className="ah-right-kv ah-card-error">模型列表读取失败：{props.modelOptionsError}
              {props.onRetryModels ? <> <button type="button" className="ah-btn ah-btn-ghost" onClick={props.onRetryModels}>重试</button></> : null}
            </span>
          ) : null}
        </label>
      </div>

      <div className="ah-wizard-field">
        <span className="ah-wizard-label">自主节奏</span>
        <div className="ah-wizard-roles ah-config-rhythm" role="group" aria-label="自主节奏">
          {RHYTHM_OPTIONS.map(option => {
            const blocked = !rhythmAllowed(draft.role, option.value)
            return (
              <button key={option.value} type="button" disabled={blocked || props.disabled} aria-pressed={draft.rhythm === option.value}
                className={`ah-wizard-role${draft.rhythm === option.value ? ' ah-wizard-role-picked' : ''}${blocked ? ' ah-wizard-role-disabled' : ''}`}
                onClick={() => onChange({ rhythm: option.value })}>
                <strong>{option.label}</strong>
                <span>{option.desc}</span>
              </button>
            )
          })}
        </div>
        <p className="ah-wizard-note">新队友前 7 天动手前都会先问你，满 3 天没有越界可以提前转正。</p>
      </div>

      <div className="ah-wizard-field">
        <span className="ah-wizard-label">岗位技能</span>
        <SkillPicker presetOptions={props.presetSkillOptions} dshOptions={props.dshSkillOptions}
          presetSelected={draft.presetSkillIds} dshSelected={draft.dshSkillNames} disabled={props.disabled}
          onChange={next => onChange(next)} />
      </div>

      <div className="ah-wizard-field">
        <label>员工说明
          <textarea ref={props.briefInputRef} rows={4} value={draft.brief} disabled={props.disabled}
            aria-invalid={briefProblem !== null || undefined} aria-describedby={briefProblem !== null ? 'ah-config-err-brief' : undefined}
            placeholder="这位队友负责什么、怎么算做好、有什么不能做的，都写在这里。"
            onChange={e => onChange({ brief: e.target.value })} />
        </label>
        <p className="ah-right-kv">{[...draft.brief.trim()].length} / {BRIEF_MAX} 字</p>
        {briefProblem ? <p className="ah-settings-error" id="ah-config-err-brief" role="alert">{briefProblem}</p> : null}
      </div>
    </div>
  )
}

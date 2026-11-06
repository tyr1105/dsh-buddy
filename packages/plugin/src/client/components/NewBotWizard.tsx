/**
 * 新建队友向导（顶栏「新建队友」）：中栏分步表单，可返回上一步；
 * 草稿存内存与 localStorage（读写 try/catch）；共 6 步（任务卡 D03 第 1 节）：
 * 名字+角色+颜色 → 性格 → 志向+目标 → 自主等级/节奏/模型 → 起步关注（可跳过）→ 确认上岗。
 */
import { useEffect, useState, type ReactNode } from 'react'
import {
  ASPIRATION_EXAMPLES, AUTONOMY_OPTIONS, COLOR_NAMES, PACE_OPTIONS, PERSONA_EXAMPLES, PRESET_COLORS, ROLE_CARDS,
  buildCreateBotInput, clearDraft, emptyDraft, loadDraft, saveDraft, stepError, wizardSummary,
  type RoleCard, type WatchKindLite, type WizardDraft,
} from '../logic/wizard.js'
import { modelSelectOptions } from '../logic/settings.js'
import type { BotCard } from '../../shared/views.js'

const STEP_TITLES = ['名字与角色', '性格与说话风格', '志向', '自主与节奏', '起步关注', '确认']

const WATCH_KINDS: ReadonlyArray<{ value: WatchKindLite; label: string }> = [
  { value: 'file', label: '文件' }, { value: 'log', label: '日志' }, { value: 'http', label: '网页' },
  { value: 'rss', label: 'RSS' }, { value: 'script', label: '脚本' },
]

/** 旧草稿里的模型序列化安全解析（坏数据当没选）。 */
function safeParse(serialized: string): { provider: string; model: string } | undefined {
  try {
    const value = JSON.parse(serialized) as { provider?: unknown; model?: unknown }
    if (typeof value?.provider === 'string' && typeof value?.model === 'string') return { provider: value.provider, model: value.model }
  } catch { /* 坏草稿当没选 */ }
  return undefined
}

const GOAL_PERIODS: ReadonlyArray<{ value: 'day' | 'week' | 'month' | 'one_off'; label: string }> = [
  { value: 'day', label: '每天' }, { value: 'week', label: '每周' }, { value: 'month', label: '每月' }, { value: 'one_off', label: '一次性' },
]

export function NewBotWizard(props: {
  existingBots: readonly BotCard[]
  modelOptions: ReadonlyArray<{ value: unknown; label: string }>
  /** 模型目录读取失败的原因（D07 第 2 条）：下拉旁显示。 */
  modelOptionsError?: string | null
  /** 执行 createBot + 存颜色；成功返回机器人 id，失败返回错误文案。 */
  onCreate: (input: Record<string, unknown>, color: string) => Promise<{ botId: string } | { error: string }>
  onOpenThread: (botId: string) => void
  onClose: () => void
}): ReactNode {
  const [draft, setDraft] = useState<WizardDraft>(() => loadDraft() ?? emptyDraft())
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  // 草稿每次变化都落一份 localStorage（关掉页面不丢）。
  useEffect(() => { saveDraft(draft) }, [draft])

  const names = props.existingBots.map(b => b.name)
  const hasChief = props.existingBots.some(b => b.role === 'chief')
  const full = props.existingBots.filter(b => b.lifecycle !== 'retired').length >= 6
  const roleLabel = ROLE_CARDS.find(r => r.role === draft.role)?.label ?? ''
  const stepProblem = stepError(draft, names)
  const set = (partial: Partial<WizardDraft>): void => { setDraft({ ...draft, ...partial }); setError(null) }

  const go = (delta: number): void => {
    if (delta > 0 && stepProblem !== null) { setError(stepProblem); return }
    set({ step: Math.min(5, Math.max(0, draft.step + delta)) })
  }

  const submit = async (): Promise<void> => {
    if (submitting) return
    setSubmitting(true)
    try {
      const result = await props.onCreate(buildCreateBotInput(draft), draft.color)
      if ('error' in result) { setError(result.error); return }
      clearDraft()
      props.onOpenThread(result.botId)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="ah-dialog-mask" role="dialog" aria-label="新建队友">
      <div className="ah-dialog ah-dialog-wide ah-wizard">
        <header className="ah-wizard-head">
          <h3>新建队友（第 {draft.step + 1}/6 步：{STEP_TITLES[draft.step]}）</h3>
          <button type="button" className="ah-btn ah-btn-ghost" onClick={props.onClose} disabled={submitting}>关闭</button>
        </header>
        <ol className="ah-wizard-steps" aria-hidden="true">
          {STEP_TITLES.map((title, i) => (
            <li key={title} className={i === draft.step ? 'ah-wizard-step-current' : i < draft.step ? 'ah-wizard-step-done' : ''}>{title}</li>
          ))}
        </ol>

        {full ? (
          <div className="ah-wizard-body">
            <p className="ah-settings-error">已经有 6 个在册队友了，达到上限；先让一位退役，再建新的。</p>
          </div>
        ) : (
          <div className="ah-wizard-body">
            {draft.step === 0 ? (
              <>
                <div className="ah-wizard-field">
                  <label>名字（1–20 字）<input value={draft.name} onChange={e => set({ name: e.target.value })} placeholder="例如：巡检员" /></label>
                  {draft.name.trim() !== '' && stepProblem !== null && stepProblem.startsWith('名字') ? <p className="ah-settings-error">{stepProblem}</p> : null}
                </div>
                <div className="ah-wizard-roles">
                  {ROLE_CARDS.map(card => {
                    const disabled = card.role === 'chief' && hasChief
                    const picked = draft.role === card.role
                    return (
                      <button key={card.role} type="button" disabled={disabled} aria-pressed={picked}
                        className={`ah-wizard-role${picked ? ' ah-wizard-role-picked' : ''}${disabled ? ' ah-wizard-role-disabled' : ''}`}
                        onClick={() => set({ role: card.role })}>
                        {picked ? <span className="ah-wizard-role-check" aria-hidden="true">已选</span> : null}
                        <strong>{card.label}</strong>
                        <span>{card.desc}</span>
                        {disabled ? <span className="ah-right-kv">已有总管，不能再建</span> : null}
                      </button>
                    )
                  })}
                </div>
                <div className="ah-wizard-field">
                  <span className="ah-wizard-label">头像颜色</span>
                  <div className="ah-wizard-colors">
                    {PRESET_COLORS.map(color => (
                      <button key={color} type="button" aria-label={`头像颜色：${COLOR_NAMES[color] ?? color}`}
                        aria-pressed={draft.color === color}
                        className={draft.color === color ? 'ah-wizard-color-picked' : ''}
                        style={{ background: color }} onClick={() => set({ color })} />
                    ))}
                  </div>
                </div>
              </>
            ) : null}

            {draft.step === 1 ? (
              <div className="ah-wizard-field">
                <label>性格与说话风格（≤ 300 字，可不填）<textarea rows={4} value={draft.persona} onChange={e => set({ persona: e.target.value })} /></label>
                <div className="ah-wizard-examples">
                  {draft.role !== '' ? PERSONA_EXAMPLES[draft.role as RoleCard['role']].map(example => (
                    <button key={example} type="button" className="ah-btn ah-btn-ghost" onClick={() => set({ persona: example })}>{example}</button>
                  )) : null}
                </div>
              </div>
            ) : null}

            {draft.step === 2 ? (
              <>
                <div className="ah-wizard-field">
                  <label>志向（一行一条，1–3 条）<textarea rows={3} value={draft.aspirations.join('\n')}
                    onChange={e => set({ aspirations: e.target.value.split(/\r?\n/) })} /></label>
                </div>
                {draft.role !== '' ? (
                  <div className="ah-wizard-examples">
                    {ASPIRATION_EXAMPLES[draft.role as RoleCard['role']].map(example => (
                      <button key={example} type="button" className="ah-btn ah-btn-ghost"
                        onClick={() => {
                          const lines = [...draft.aspirations.map(l => l.trim()).filter(l => l !== ''), example]
                          set({ aspirations: lines.slice(0, 3) })
                        }}>{example}</button>
                    ))}
                  </div>
                ) : null}
                <details className="ah-wizard-optional">
                  <summary>可选：第一个目标</summary>
                  <label>标题<input value={draft.goal?.title ?? ''} onChange={e => set({ goal: { ...(draft.goal ?? { title: '', doneWhen: '', period: 'week' }), title: e.target.value } })} /></label>
                  <label>完成标准<input value={draft.goal?.doneWhen ?? ''} onChange={e => set({ goal: { ...(draft.goal ?? { title: '', doneWhen: '', period: 'week' }), doneWhen: e.target.value } })} /></label>
                  <label>周期
                    <select value={draft.goal?.period ?? 'week'} onChange={e => set({ goal: { ...(draft.goal ?? { title: '', doneWhen: '', period: 'week' }), period: e.target.value as 'day' | 'week' | 'month' | 'one_off' } })}>
                      {GOAL_PERIODS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
                    </select>
                  </label>
                </details>
              </>
            ) : null}

            {draft.step === 3 ? (
              <>
                {/* 三个选择框同高同宽一行对齐（D04 3c-2）；说明放下方、次要文字色、正常字号。 */}
                <div className="ah-wizard-trio">
                  <label>自主等级
                    <select value={draft.autonomy} onChange={e => set({ autonomy: e.target.value as WizardDraft['autonomy'] })}>
                      {AUTONOMY_OPTIONS.map(a => <option key={a.value} value={a.value}>{a.label}</option>)}
                    </select>
                  </label>
                  <label>节奏
                    <select value={draft.pace} onChange={e => set({ pace: e.target.value as WizardDraft['pace'] })}>
                      {PACE_OPTIONS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
                    </select>
                  </label>
                  {/* D07 第 8 条：下拉直接用视图的 modelOptions（含 value 为 null 的
                      「跟随宿主默认模型」那一项）——选它提交 model:null，真正跟随 DSH
                      默认；旧草稿里已下架的模型补一项如实显示（D07 第 7 条）。 */}
                  <label>模型
                    <select value={draft.model === '' ? 'null' : draft.model} onChange={e => set({ model: e.target.value === 'null' ? '' : e.target.value })}>
                      {modelSelectOptions(draft.model === '' || draft.model === 'null' ? undefined : safeParse(draft.model), props.modelOptions)
                        .map((option, i) => (
                          <option key={i} value={option.value === null ? 'null' : JSON.stringify(option.value)}>{option.value === null ? '跟随 DSH 默认' : option.label}</option>
                        ))}
                    </select>
                    {props.modelOptionsError ? <span className="ah-right-kv ah-card-error">模型列表没加载出来：{props.modelOptionsError}</span> : null}
                  </label>
                </div>
                <p className="ah-wizard-note">试岗 7 天内一律按 L1 建议；满 3 天无越界可以提前转正。</p>
              </>
            ) : null}

            {draft.step === 4 ? (
              draft.watch === null ? (
                <div className="ah-wizard-field">
                  <p className="ah-right-kv">可以让它上岗后先自己提议要盯什么；也可以现在就指定一个起步关注。</p>
                  <div className="ah-settings-actions">
                    <button type="button" className="ah-btn" onClick={() => set({ watch: { kind: 'file', target: '', note: '' } })}>指定一个起步关注</button>
                    <button type="button" className="ah-btn ah-btn-ghost" onClick={() => go(1)}>跳过</button>
                  </div>
                </div>
              ) : (
                <div className="ah-wizard-field">
                  <label>类型
                    <select value={draft.watch.kind} onChange={e => set({ watch: { ...draft.watch!, kind: e.target.value as WatchKindLite } })}>
                      {WATCH_KINDS.map(k => <option key={k.value} value={k.value}>{k.label}</option>)}
                    </select>
                  </label>
                  <label>{draft.watch.kind === 'http' || draft.watch.kind === 'rss' ? '网址' : draft.watch.kind === 'script' ? '命令行（只读脚本）' : '完整路径'}
                    <input value={draft.watch.target} onChange={e => set({ watch: { ...draft.watch!, target: e.target.value } })}
                      placeholder={draft.watch.kind === 'http' || draft.watch.kind === 'rss' ? 'https://…' : draft.watch.kind === 'file' || draft.watch.kind === 'log' ? '选择路径：/Users/…/xxx' : 'python3 脚本路径'} />
                  </label>
                  <label>说明（为什么盯它）<input value={draft.watch.note} onChange={e => set({ watch: { ...draft.watch!, note: e.target.value } })} /></label>
                  {stepProblem !== null && stepProblem.startsWith('关注目标') ? <p className="ah-settings-error">{stepProblem}</p> : null}
                  <button type="button" className="ah-btn ah-btn-ghost" onClick={() => set({ watch: null })}>不设起步关注</button>
                </div>
              )
            ) : null}

            {draft.step === 5 ? (
              <div className="ah-wizard-confirm">
                <p className="ah-wizard-restatement">{wizardSummary(draft, roleLabel)}</p>
                <p className="ah-right-kv">它会先试跑：做自我介绍、搭起步的关注与议程，有事会在这个线程里找你。</p>
              </div>
            ) : null}
          </div>
        )}

        {error ? <p className="ah-settings-error" role="alert">{error}</p> : null}
        <footer className="ah-dialog-actions">
          <button type="button" className="ah-btn" onClick={() => go(-1)} disabled={draft.step === 0 || submitting}>上一步</button>
          {draft.step < 5
            ? <button type="button" className="ah-btn ah-btn-primary" onClick={() => go(1)} disabled={full}>下一步</button>
            : <button type="button" className="ah-btn ah-btn-primary" onClick={() => void submit()} disabled={submitting || full}>
              {submitting ? '上岗中…' : '让它上岗'}
            </button>}
        </footer>
      </div>
    </div>
  )
}

/**
 * 新建队友向导（顶栏「新建队友」）：中栏分步表单，可返回上一步；
 * 草稿存内存与 localStorage（读写 try/catch）；共 6 步（任务卡 D03 第 1 节）：
 * 名字+角色+颜色 → 性格 → 志向+目标 → 自主等级/节奏/模型 → 起步关注（可跳过）→ 确认上岗。
 * P52：打开时先看模板库，点一下就能添加；「自己从头配置」进入上面的 6 步。
 * 写到一半的草稿优先，直接回到表单，不让模板库盖住主人没写完的内容。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  ASPIRATION_EXAMPLES, AUTONOMY_OPTIONS, COLOR_NAMES, MBTI_OPTIONS, PACE_OPTIONS, PERSONA_EXAMPLES, PRESET_COLORS, ROLE_CARDS,
  buildCreateBotInput, clearDraft, emptyDraft, loadDraft, saveDraft, stepError, validateFirstTask, wizardSummary,
  type FirstTaskDraft, type MbtiDraft, type RoleCard, type WatchKindLite, type WizardDraft,
} from '../logic/wizard.js'
import { modelSelectOptions } from '../logic/settings.js'
import { knownPresetSkillIds } from '../logic/preset-skills.js'
import { MAX_TEAM_SIZE, draftHasContent, hasLiveChief, liveBots, type BotTemplate } from '../logic/bot-templates.js'
import { templateBatchError, templateBatchNotice, type TemplateBatchResult } from '../logic/wizard-create.js'
import type { BotCard, PresetSkillOption } from '../../shared/views.js'
import { useDialogFocus } from './use-dialog-focus.js'
import { PresetSkillPicker } from './preset-skill-picker.js'
import { BotTemplatePicker } from './bot-template-picker.js'

const STEP_TITLES = ['名字与角色', '性格与说话风格', '志向', '自主与节奏', '起步关注', '确认']

const WATCH_KINDS: ReadonlyArray<{ value: WatchKindLite; label: string }> = [
  { value: 'file', label: '文件' }, { value: 'log', label: '日志' }, { value: 'http', label: '网页' },
  { value: 'rss', label: 'RSS' }, { value: 'script', label: '脚本' },
]

/** 错误文案前缀到字段键的映射：go() 据此一次只点亮一个出错字段（顺序即聚焦优先级）。 */
const FIELD_PREFIX: ReadonlyArray<[string, 'name' | 'role' | 'persona' | 'aspiration' | 'watch']> = [
  ['名字', 'name'], ['角色', 'role'], ['性格与说话风格', 'persona'], ['志向', 'aspiration'], ['关注目标', 'watch'],
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
  /** 可放第一件事的项目（只给未归档项目；P37）。 */
  projects: ReadonlyArray<{ id: string; name: string }>
  modelOptions: ReadonlyArray<{ value: unknown; label: string }>
  /** P40：内置预置 skill 候选；为空时该步骤提示清单未加载。 */
  presetSkillOptions: readonly PresetSkillOption[]
  /** 模型目录读取失败的原因（D07 第 2 条）：下拉旁显示。 */
  modelOptionsError?: string | null
  /** 执行 createBot + 存颜色（+ 可选的第一件事）；失败时把中文原因带回向导。 */
  onCreate: (input: Record<string, unknown>, color: string, firstTask?: FirstTaskDraft) => Promise<{ botId: string; warning?: string } | { error: string }>
  /** P52：从模板库批量添加；每位的失败原因都放在结果里，不靠抛错。 */
  onCreateFromTemplates: (templates: readonly BotTemplate[]) => Promise<TemplateBatchResult>
  /** 成功后打开新队友线程；第二参是不挡创建的提醒（如第一件事没放进项目）。 */
  onOpenThread: (botId: string, warning?: string) => void
  onClose: () => void
}): ReactNode {
  const [draft, setDraft] = useState<WizardDraft>(() => loadDraft() ?? emptyDraft())
  /** P52：先看模板库，还是填表单。有没写完的草稿就直接回表单。 */
  const [mode, setMode] = useState<'templates' | 'custom'>(() => draftHasContent(draft) ? 'custom' : 'templates')
  const [error, setError] = useState<string | null>(null)
  /** 上一次尝试卡在哪一项（名字/角色/性格/志向/关注目标）：错误只在尝试后出现，且一次只指一项。 */
  const [attemptedField, setAttemptedField] = useState<'name' | 'role' | 'persona' | 'aspiration' | 'watch' | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const nameInputRef = useRef<HTMLInputElement | null>(null)
  const rolesRef = useRef<HTMLDivElement | null>(null)
  const personaInputRef = useRef<HTMLTextAreaElement | null>(null)
  const aspirationInputRef = useRef<HTMLTextAreaElement | null>(null)
  const watchInputRef = useRef<HTMLInputElement | null>(null)
  const dialogRef = useDialogFocus(props.onClose, submitting)

  // 草稿每次变化都落一份 localStorage（关掉页面不丢）。
  useEffect(() => { saveDraft(draft) }, [draft])

  // 打开弹窗时的焦点由 useDialogFocus 管；这里只处理从模板库切到表单的那一下，否则焦点会丢。
  const modeMountedRef = useRef(false)
  useEffect(() => {
    if (modeMountedRef.current && mode === 'custom') nameInputRef.current?.focus()
    modeMountedRef.current = true
  }, [mode])

  const names = props.existingBots.map(b => b.name)
  // 退役的总管不占名额，和 core 的校验口径一致。
  const hasChief = hasLiveChief(props.existingBots)
  const full = liveBots(props.existingBots).length >= MAX_TEAM_SIZE
  // 名额满了就不显示模板库，走下面原有的「已达上限」提示。
  const showTemplates = mode === 'templates' && !full
  const roleLabel = ROLE_CARDS.find(r => r.role === draft.role)?.label ?? ''
  const stepProblem = stepError(draft, names)
  const set = (partial: Partial<WizardDraft>): void => { setDraft({ ...draft, ...partial }); setError(null) }

  /** 就地错误：错误说哪一项就显示在哪一项旁边并挂读屏三件套；未映射的通用错误仍走底部行。 */
  const nameProblem = attemptedField === 'name' && draft.step === 0 && stepProblem?.startsWith('名字') === true ? stepProblem : null
  const roleProblem = attemptedField === 'role' && draft.step === 0 && stepProblem?.startsWith('角色') === true ? stepProblem : null
  const personaProblem = attemptedField === 'persona' && draft.step === 1 && stepProblem?.startsWith('性格与说话风格') === true ? stepProblem : null
  const aspirationProblem = attemptedField === 'aspiration' && draft.step === 2 && stepProblem?.startsWith('志向') === true ? stepProblem : null
  // 第 5 步的关注目标错误同样只在「下一步」尝试后出现，避免刚点开表单就红字吓人。
  const watchProblem = attemptedField === 'watch' && draft.step === 4 && stepProblem?.startsWith('关注目标') === true ? stepProblem : null

  const go = (delta: number): void => {
    if (delta > 0 && stepProblem !== null) {
      setError(stepProblem)
      // 一次只指一项：按前缀表点亮对应字段；字段修正后 stepProblem 变 null，错误跟着消失。
      const matched = FIELD_PREFIX.find(([prefix]) => stepProblem.startsWith(prefix))
      setAttemptedField(matched ? matched[1] : null)
      // 光标跟着错误走：说哪项就聚焦哪项，主人不用在一屏里自己找哪里错了。
      if (draft.step === 0) {
        if (stepProblem.startsWith('名字')) nameInputRef.current?.focus()
        else if (stepProblem.startsWith('角色')) rolesRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
      } else if (draft.step === 1 && stepProblem.startsWith('性格与说话风格')) {
        personaInputRef.current?.focus()
      } else if (draft.step === 2 && stepProblem.startsWith('志向')) {
        aspirationInputRef.current?.focus()
      } else if (draft.step === 4 && stepProblem.startsWith('关注目标')) {
        watchInputRef.current?.focus()
      }
      return
    }
    setAttemptedField(null)
    set({ step: Math.min(5, Math.max(0, draft.step + delta)) })
  }

  const submit = async (): Promise<void> => {
    if (submitting) return
    // 第一件事是可选项，但一旦填了就要完整：项目在列表里、标题 1–120 字。
    const firstTask = draft.firstTask
    if (firstTask !== null) {
      const problem = validateFirstTask(firstTask, props.projects.map(p => p.id))
      if (problem !== null) { setError(problem); return }
    }
    setSubmitting(true)
    try {
      const result = await props.onCreate(
        // 旧草稿里可能带着已下线的预置 id：提交前按当前清单过滤，避免 core 校验报错。
        buildCreateBotInput({ ...draft, presetSkillIds: knownPresetSkillIds(draft.presetSkillIds, props.presetSkillOptions) }),
        draft.color,
        firstTask === null ? undefined : { projectId: firstTask.projectId, title: firstTask.title.trim() },
      )
      if ('error' in result) { setError(result.error); return }
      clearDraft()
      props.onOpenThread(result.botId, result.warning)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
  }

  /** P52：一键添加。至少加上一位就打开它的对话；一位都没加上就留在模板库显示原因。 */
  const addFromTemplates = async (templates: readonly BotTemplate[]): Promise<void> => {
    if (submitting) return
    setSubmitting(true)
    setError(null)
    try {
      const result = await props.onCreateFromTemplates(templates)
      const first = result.added[0]
      if (first === undefined) { setError(templateBatchError(result)); return }
      props.onOpenThread(first.botId, templateBatchNotice(result))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
  }

  /** 第 1 步的「返回模板」：草稿留着，再点「自己从头配置」还能接着填。 */
  const backToTemplates = (): void => {
    setError(null)
    setAttemptedField(null)
    setMode('templates')
  }

  return (
    <div className="ah-dialog-mask" ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label="新建队友">
      <div className={`ah-dialog ah-dialog-wide ah-wizard${showTemplates ? ' ah-wizard-picking' : ''}`}>
        {showTemplates ? (
          <BotTemplatePicker existingBots={props.existingBots} presetSkillOptions={props.presetSkillOptions}
            submitting={submitting} error={error} onClose={props.onClose}
            onCustom={() => { setError(null); setMode('custom') }}
            onAdd={templates => void addFromTemplates(templates)} />
        ) : <>
        <header className="ah-wizard-head">
          {/* 弹窗是独立表面（背景已 inert 剪枝），标题从 h2 起，大纲不跳级（WCAG 1.3.1）。 */}
          <h2>新建队友（第 {draft.step + 1}/6 步：{STEP_TITLES[draft.step]}）</h2>
          <button type="button" className="ah-btn ah-btn-ghost" onClick={props.onClose} disabled={submitting}>关闭</button>
        </header>
        <ol className="ah-wizard-steps" aria-label="创建进度">
          {STEP_TITLES.map((title, i) => (
            <li key={title} className={i === draft.step ? 'ah-wizard-step-current' : i < draft.step ? 'ah-wizard-step-done' : ''}><button type="button" disabled={i > draft.step || submitting} aria-current={i === draft.step ? 'step' : undefined} onClick={() => set({ step: i })}>{i + 1} {title}</button></li>
          ))}
        </ol>

        {full ? (
          <div className="ah-wizard-body">
            <p className="ah-settings-error" role="alert">已达 6 位在册队友上限。请先退役一位，再新建。</p>
          </div>
        ) : (
          <div className="ah-wizard-body">
            {draft.step === 0 ? (
              <>
                <div className="ah-wizard-field">
                  <label>名字（1–20 字）<input ref={nameInputRef} value={draft.name}
                    aria-invalid={nameProblem !== null || undefined}
                    aria-describedby={nameProblem !== null ? 'ah-wizard-err-name' : undefined}
                    onChange={e => set({ name: e.target.value })} placeholder="例如：巡检员" /></label>
                  {nameProblem ? <p className="ah-settings-error" id="ah-wizard-err-name" role="alert">{nameProblem}</p> : null}
                </div>
                <div className="ah-wizard-roles" ref={rolesRef}>
                  {ROLE_CARDS.map(card => {
                    const disabled = card.role === 'chief' && hasChief
                    const picked = draft.role === card.role
                    return (
                      <button key={card.role} type="button" disabled={disabled} aria-pressed={picked}
                        aria-invalid={roleProblem !== null || undefined}
                        aria-describedby={roleProblem !== null ? 'ah-wizard-err-role' : undefined}
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
                {roleProblem ? <p className="ah-settings-error" id="ah-wizard-err-role" role="alert">{roleProblem}</p> : null}
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
              <>
                <div className="ah-wizard-field">
                  <label>性格与说话风格（≤ 300 字，可不填）<textarea ref={personaInputRef} rows={4} value={draft.persona}
                    aria-invalid={personaProblem !== null || undefined}
                    aria-describedby={personaProblem !== null ? 'ah-wizard-err-persona' : undefined}
                    onChange={e => set({ persona: e.target.value })} /></label>
                  {personaProblem ? <p className="ah-settings-error" id="ah-wizard-err-persona" role="alert">{personaProblem}</p> : null}
                  <div className="ah-wizard-examples">
                    {draft.role !== '' ? PERSONA_EXAMPLES[draft.role as RoleCard['role']].map(example => (
                      <button key={example} type="button" className="ah-btn ah-btn-ghost" onClick={() => set({ persona: example })}>{example}</button>
                    )) : null}
                  </div>
                </div>
                {/* MBTI 是可跳过的性格选项：只影响模型说话与做事的倾向，
                    不改变权限、审批、额度或唤醒门槛。 */}
                <div className="ah-wizard-field">
                  <label>MBTI（可选，只影响说话和做事的风格）
                    <select value={draft.mbti} onChange={e => set({ mbti: e.target.value as MbtiDraft })}>
                      <option value="">不设置</option>
                      {MBTI_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </select>
                  </label>
                  <p className="ah-right-kv">
                    {draft.mbti === ''
                      ? '不设置也没关系，之后可以在右栏「档案」里补。'
                      : MBTI_OPTIONS.find(option => option.value === draft.mbti)?.desc}
                  </p>
                </div>
              </>
            ) : null}

            {draft.step === 2 ? (
              <>
                <div className="ah-wizard-field">
                  <label>志向（一行一条，1–3 条）<textarea ref={aspirationInputRef} rows={3} value={draft.aspirations.join('\n')}
                    aria-invalid={aspirationProblem !== null || undefined}
                    aria-describedby={aspirationProblem !== null ? 'ah-wizard-err-aspiration' : undefined}
                    onChange={e => set({ aspirations: e.target.value.split(/\r?\n/) })} /></label>
                  {aspirationProblem ? <p className="ah-settings-error" id="ah-wizard-err-aspiration" role="alert">{aspirationProblem}</p> : null}
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
                    {props.modelOptionsError ? <span className="ah-right-kv ah-card-error">模型列表读取失败：{props.modelOptionsError}</span> : null}
                  </label>
                </div>
                <p className="ah-wizard-note">试岗 7 天内一律按 L1 建议；满 3 天无越界可以提前转正。</p>
                {/* P40：预置 skill 是可选项，不选就不加载；三档条件在分组标题上写明。 */}
                <div className="ah-wizard-field">
                  <span className="ah-wizard-label">预置 skill（可选，不选就不加载）</span>
                  <p className="ah-right-kv">从内置清单里挑它做事时要参考的检查清单；内容随插件版本走，不会联网下载。</p>
                  <PresetSkillPicker options={props.presetSkillOptions} selected={draft.presetSkillIds}
                    disabled={submitting} onChange={ids => set({ presetSkillIds: ids })} />
                </div>
              </>
            ) : null}

            {draft.step === 4 ? (
              <>
                {draft.watch === null ? (
                  <div className="ah-wizard-field">
                    <p className="ah-right-kv">可让该队友上岗后自行提议关注项；也可现在指定一个起步关注项。</p>
                    <div className="ah-settings-actions">
                      <button type="button" className="ah-btn" onClick={() => set({ watch: { kind: 'file', target: '', note: '' } })}>指定关注</button>
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
                      <input ref={watchInputRef} value={draft.watch.target}
                        aria-invalid={watchProblem !== null || undefined}
                        aria-describedby={watchProblem !== null ? 'ah-wizard-err-watch' : undefined}
                        onChange={e => set({ watch: { ...draft.watch!, target: e.target.value } })}
                        placeholder={draft.watch.kind === 'http' || draft.watch.kind === 'rss' ? 'https://…' : draft.watch.kind === 'file' || draft.watch.kind === 'log' ? '选择路径：/Users/…/xxx' : 'python3 脚本路径'} />
                    </label>
                    <label>说明（为什么盯它）<input value={draft.watch.note} onChange={e => set({ watch: { ...draft.watch!, note: e.target.value } })} /></label>
                    {watchProblem ? <p className="ah-settings-error" id="ah-wizard-err-watch" role="alert">{watchProblem}</p> : null}
                    <button type="button" className="ah-btn ah-btn-ghost" onClick={() => set({ watch: null })}>不指定</button>
                  </div>
                )}
                {/* 第一件事（P37）：放进项目待领，不指派给新队友——谁领走谁负责。 */}
                <div className="ah-wizard-field">
                  <span className="ah-wizard-label">可选：将第一件事放入项目待领</span>
                  {props.projects.length === 0 ? (
                    <p className="ah-right-kv">暂无可用项目。请先在项目页新建，再派发任务。</p>
                  ) : draft.firstTask === null ? (
                    <>
                      <p className="ah-right-kv">该队友会先看到这件事；也可稍后在项目中派发。</p>
                      <button type="button" className="ah-btn ah-btn-ghost"
                        onClick={() => set({ firstTask: { projectId: props.projects[0]!.id, title: '' } })}>添加任务</button>
                    </>
                  ) : (
                    <>
                      <label>项目
                        <select value={draft.firstTask.projectId}
                          onChange={e => set({ firstTask: { ...draft.firstTask!, projectId: e.target.value } })}>
                          {props.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
                        </select>
                      </label>
                      <label>任务标题（1–120 字）
                        <input value={draft.firstTask.title} maxLength={120} placeholder="例如：整理本周竞品变化"
                          onChange={e => set({ firstTask: { ...draft.firstTask!, title: e.target.value } })} />
                      </label>
                      <p className="ah-right-kv">放入「待领」：暂未指派，新队友上岗后可直接领取。</p>
                      <button type="button" className="ah-btn ah-btn-ghost" onClick={() => set({ firstTask: null })}>不添加</button>
                    </>
                  )}
                </div>
              </>
            ) : null}

            {draft.step === 5 ? (
              <div className="ah-wizard-confirm">
                <p className="ah-wizard-restatement">{wizardSummary(draft, roleLabel)}</p>
                {draft.firstTask !== null && draft.firstTask.title.trim() !== '' ? (
                  <p className="ah-right-kv">
                    第一件事「{draft.firstTask.title.trim()}」将放入「
                    {props.projects.find(project => project.id === draft.firstTask!.projectId)?.name ?? '所选项目'}
                    」的待领清单。
                  </p>
                ) : null}
                <p className="ah-right-kv">创建后先试跑：自我介绍、建立初始关注与议程；有事项时在此线程通知。</p>
              </div>
            ) : null}
          </div>
        )}

        {/* 字段错误已经就地显示，底部不再重复同一句（避免读屏念两遍）；提交失败等通用错误仍放这里。 */}
        {error && error !== nameProblem && error !== roleProblem && error !== personaProblem && error !== aspirationProblem && error !== watchProblem
          ? <p className="ah-settings-error" role="alert">{error}</p> : null}
        <footer className="ah-dialog-actions">
          {/* P52：第 1 步的上一步就是回模板库；名额满时没有模板库可回，保持原来的灰按钮。 */}
          <button type="button" className="ah-btn" onClick={() => { if (draft.step === 0) backToTemplates(); else go(-1) }}
            disabled={(draft.step === 0 && full) || submitting}>{draft.step === 0 && !full ? '返回模板' : '上一步'}</button>
          {draft.step < 5
            ? <button type="button" className="ah-btn ah-btn-primary" onClick={() => go(1)} disabled={full}>下一步</button>
            : <button type="button" className="ah-btn ah-btn-primary" onClick={() => void submit()} disabled={submitting || full}>
              {submitting ? '创建中…' : '创建队友'}
            </button>}
        </footer>
        </>}
      </div>
    </div>
  )
}

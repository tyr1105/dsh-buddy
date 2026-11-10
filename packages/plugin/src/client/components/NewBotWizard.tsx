/**
 * 新建队友弹窗：先看模板库，点一下就能添加（P52）；「自己从头配置」进入一页表单（P55）。
 *
 * 表单只有主人定下的八项，字段在 bot-config-fields.tsx，编辑队友弹窗也用同一份。
 * 草稿存内存与 localStorage（读写 try/catch）。写到一半的草稿优先，
 * 直接回到表单，不让模板库盖住主人没写完的内容。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  buildCreateBotInput, clearDraft, configProblem, emptyDraft, loadDraft, problemField, saveDraft, type BotConfigDraft,
} from '../logic/wizard.js'
import { knownPresetSkillIds } from '../logic/preset-skills.js'
import { MAX_TEAM_SIZE, draftHasContent, hasLiveChief, liveBots, type BotTemplate } from '../logic/bot-templates.js'
import { templateBatchError, templateBatchNotice, type TemplateBatchResult } from '../logic/wizard-create.js'
import type { BotCard, DshSkillOption, PresetSkillOption } from '../../shared/views.js'
import { useDialogFocus } from './use-dialog-focus.js'
import { BotConfigFields } from './bot-config-fields.js'
import { BotTemplatePicker } from './bot-template-picker.js'

export function NewBotWizard(props: {
  existingBots: readonly BotCard[]
  modelOptions: ReadonlyArray<{ value: unknown; label: string }>
  /** 内置技能候选；为空时选择器里不显示「队友自带」这一组。 */
  presetSkillOptions: readonly PresetSkillOption[]
  /** P55：DSH 里的技能；读不到时是空数组。 */
  dshSkillOptions: readonly DshSkillOption[]
  /** 模型目录读取失败的原因：下拉旁显示。 */
  modelOptionsError?: string | null
  /** 执行 createBot；失败时把中文原因带回表单。 */
  onCreate: (input: Record<string, unknown>) => Promise<{ botId: string; warning?: string } | { error: string }>
  /** P52：从模板库批量添加；每位的失败原因都放在结果里，不靠抛错。 */
  onCreateFromTemplates: (templates: readonly BotTemplate[]) => Promise<TemplateBatchResult>
  /** 成功后打开新队友线程；第二参是不挡创建的提醒。 */
  onOpenThread: (botId: string, warning?: string) => void
  onClose: () => void
}): ReactNode {
  const [draft, setDraft] = useState<BotConfigDraft>(() => loadDraft() ?? emptyDraft())
  /** 先看模板库，还是填表单。有没写完的草稿就直接回表单。 */
  const [mode, setMode] = useState<'templates' | 'custom'>(() => draftHasContent(draft) ? 'custom' : 'templates')
  const [error, setError] = useState<string | null>(null)
  /** 点过「创建」才显示字段错误，刚打开表单时不要红字吓人。 */
  const [attempted, setAttempted] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const nameInputRef = useRef<HTMLInputElement | null>(null)
  const rolesRef = useRef<HTMLDivElement | null>(null)
  const briefInputRef = useRef<HTMLTextAreaElement | null>(null)
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
  const full = liveBots(props.existingBots).length >= MAX_TEAM_SIZE
  // 名额满了就不显示模板库，走下面的「已达上限」提示。
  const showTemplates = mode === 'templates' && !full
  const problem = configProblem(draft, names)
  const set = (partial: Partial<BotConfigDraft>): void => { setDraft({ ...draft, ...partial }); setError(null) }

  /** 光标跟着错误走：说哪项就聚焦哪项，主人不用在一页里自己找哪里错了。 */
  const focusProblem = (message: string): void => {
    const field = problemField(message)
    if (field === 'name') nameInputRef.current?.focus()
    else if (field === 'role') rolesRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    else if (field === 'brief') briefInputRef.current?.focus()
  }

  const submit = async (): Promise<void> => {
    if (submitting) return
    setAttempted(true)
    if (problem !== null) { focusProblem(problem); return }
    setSubmitting(true)
    try {
      // 旧草稿里可能带着已下线的技能 id：提交前按当前清单过滤，避免 core 校验报错。
      const result = await props.onCreate(buildCreateBotInput({ ...draft, presetSkillIds: knownPresetSkillIds(draft.presetSkillIds, props.presetSkillOptions) }))
      if ('error' in result) { setError(result.error); return }
      clearDraft()
      props.onOpenThread(result.botId, result.warning)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
  }

  /** 一键添加。至少加上一位就打开它的对话；一位都没加上就留在模板库显示原因。 */
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

  /** 「返回模板」：草稿留着，再点「自己从头配置」还能接着填。 */
  const backToTemplates = (): void => {
    setError(null)
    setAttempted(false)
    setMode('templates')
  }

  return (
    <div className="ah-dialog-mask" ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label="新建队友">
      {/* 模板库和表单用同一个固定高度，切换时弹窗不跳。 */}
      <div className="ah-dialog ah-dialog-wide ah-wizard ah-wizard-picking">
        {showTemplates ? (
          <BotTemplatePicker existingBots={props.existingBots} presetSkillOptions={props.presetSkillOptions}
            submitting={submitting} error={error} onClose={props.onClose}
            onCustom={() => { setError(null); setMode('custom') }}
            onAdd={templates => void addFromTemplates(templates)} />
        ) : <>
          {/* 弹窗是独立表面（背景已 inert 剪枝），标题从 h2 起，大纲不跳级（WCAG 1.3.1）。 */}
          <header className="ah-wizard-head">
            <h2>新建队友</h2>
            <button type="button" className="ah-btn ah-btn-ghost" onClick={props.onClose} disabled={submitting}>关闭</button>
          </header>

          <div className="ah-wizard-body">
            {full ? (
              <p className="ah-settings-error" role="alert">已达 {MAX_TEAM_SIZE} 位在册队友上限。请先退役一位，再新建。</p>
            ) : (
              <BotConfigFields draft={draft} onChange={set} modelOptions={props.modelOptions} modelOptionsError={props.modelOptionsError}
                presetSkillOptions={props.presetSkillOptions} dshSkillOptions={props.dshSkillOptions}
                chiefTaken={hasLiveChief(props.existingBots)} disabled={submitting} problem={attempted ? problem : null}
                nameInputRef={nameInputRef} rolesRef={rolesRef} briefInputRef={briefInputRef} />
            )}
          </div>

          <div className="ah-template-foot">
            {/* 字段错误已经就地显示，这里只放提交失败这类通用错误，避免读屏念两遍。 */}
            {error ? <p className="ah-settings-error" role="alert">{error}</p> : null}
            <p className="ah-wizard-note">加入后先试跑一次，消耗模型额度。</p>
            <footer className="ah-dialog-actions ah-template-actions">
              <button type="button" className="ah-btn" onClick={backToTemplates} disabled={full || submitting}>返回模板</button>
              <button type="button" className="ah-btn ah-btn-primary" onClick={() => void submit()} disabled={submitting || full}>
                {submitting ? '创建中…' : '创建队友'}
              </button>
            </footer>
          </div>
        </>}
      </div>
    </div>
  )
}

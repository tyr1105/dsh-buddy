/**
 * 右栏（可收起，任务卡 D03 第 6 节「机器人详情可编辑」）：
 * 档案（性格、自主等级、节奏、模型）编辑；志向增删改；目标分区抽到 GoalSection
 * （完成待验收显示「验收通过 / 没过」、放弃二次确认）；关注项：提议中的「同意 / 不要」，在用的暂停/恢复；
 * 规矩：新增一条（可勾红线）；生命周期：暂停/恢复/提前转正（试岗满 3 天）/解除停用/退役（二次确认）；
 * 套路可点开查看步骤并编辑（editRoutine）；「为什么醒 / 为什么没醒」一处讲完：
 * 醒了的列最近唤醒（含原因、结果，展开看账本），没醒的列判断理由——
 * 同一次唤醒只出现一次，避免和活动流、两个分区之间重复（F02 最小读法，明细在 WakeLedger.tsx）。
 */
import { useState, type ReactNode } from 'react'
import type { BotView, CommandResult, PresetSkillOption, WakeLedgerView } from '../../shared/views.js'
import { presetSkillSummary } from '../logic/preset-skills.js'
import { openBotSessionWith, OPEN_SESSION_HINTS } from '../logic/thread.js'
import { lifecycleButtons } from '../logic/lifecycle.js'
import { modelSelectOptions } from '../logic/settings.js'
import { MBTI_OPTIONS, type MbtiDraft } from '../logic/wizard.js'
import { hasLiveWake } from '../logic/wakes.js'
import { WakeLedgerSection } from './WakeLedger.js'
import { Section } from './right-section.js'
import { GoalSection } from './goal-section.js'
import { ArtifactSection } from './artifact-section.js'
import { PersonalityBehavior } from './personality-behavior.js'
import { escToCancel, useReturnFocus } from './use-inline-edit-focus.js'
import { useCommandRunner } from './use-command-runner.js'
import { useDrawerFocus } from './use-drawer-focus.js'
import { PresetSkillPicker } from './preset-skill-picker.js'

const AUTONOMY_CHOICES: ReadonlyArray<{ value: 'L0' | 'L1' | 'L2' | 'L3'; label: string }> = [
  { value: 'L0', label: 'L0 只观察' }, { value: 'L1', label: 'L1 建议' }, { value: 'L2', label: 'L2 执行' }, { value: 'L3', label: 'L3 授权执行' },
]
const PACE_CHOICES: ReadonlyArray<{ value: 'active' | 'normal' | 'quiet'; label: string }> = [
  { value: 'active', label: '积极' }, { value: 'normal', label: '适中' }, { value: 'quiet', label: '安静' },
]

/** 各生命周期动作成功后的提示语（doExec 的 okText）。 */
const LIFECYCLE_OK_TEXT: Readonly<Record<'pause' | 'resume' | 'promote' | 'release_quarantine' | 'retire', string>> = {
  pause: '已暂停。变更记录保留，可恢复。',
  resume: '已恢复。下一步：待安排。',
  promote: '已转正。下一步：待安排。',
  release_quarantine: '已解除停用。下一步：待安排。',
  retire: '已退役。数据保留，可恢复。',
}

/**
 * 关注项暂停/恢复的完整入参（D07 第 10 条）：用视图该行已有的 kind/target/why 拼，
 * 只改 status——只发 {id,botId,status} 会被 core 按「关注项无效」拒绝。
 */
function watchStatusInput(botId: string, w: BotView['watches'][number], status: 'active' | 'paused'): Record<string, unknown> {
  return { id: w.id, botId, kind: w.kind, target: w.target, why: w.why ?? '', status }
}

export function RightPanel(props: {
  bot: BotView | null
  modelOptions: ReadonlyArray<{ value: unknown; label: string }>
  /** P40：内置预置 skill 候选清单，用于档案页勾选与只读展示。 */
  presetSkillOptions: readonly PresetSkillOption[]
  /** 模型目录读取失败的原因（D07 第 2 条）：下拉旁显示并给「重试」。 */
  modelOptionsError?: string | null
  onRetrySettings?: () => void
  clientCtx: unknown
  run: (name: string, input: Record<string, unknown>) => Promise<CommandResult>
  onRefresh: () => void
  onTeach: () => void
  onCollapse: () => void
  /** 已缓存的账本详情（按唤醒单 id；null=确实没有账本），右栏展开时才拉。 */
  ledgers: Record<string, WakeLedgerView | null>
  /** 单个账本的加载失败原因（不影响整页连接状态）。 */
  ledgerErrors: Record<string, string>
  onLoadLedger: (wakeId: string) => void
  /** 从办公室桌上产出下钻时指定要展开的账本（F03）；为空时按原有规则。 */
  focusWakeId?: string | null
  /** 从办公室桌上产物下钻时指定要展开的产物头（F08）；右栏自动选中最新一版。 */
  focusArtifactId?: string | null
}): ReactNode {
  const runner = useCommandRunner(props.run)
  // 窄屏抽屉模式下把 Tab 困守在右栏内、关闭后焦点还给「详情」触发钮（U01 第 11 轮）。
  const { panelRef } = useDrawerFocus()
  const [editingProfile, setEditingProfile] = useState(false)
  const [editingAspiration, setEditingAspiration] = useState<string | null>(null)
  const [persona, setPersona] = useState('')
  const [mbti, setMbti] = useState<MbtiDraft>('')
  const [autonomy, setAutonomy] = useState('L1')
  const [pace, setPace] = useState('normal')
  const [model, setModel] = useState('')
  /** P40：档案编辑中的预置 skill 勾选，保存时才随 patch 提交。 */
  const [presetSkillIds, setPresetSkillIds] = useState<string[]>([])
  const [aspirationText, setAspirationText] = useState('')
  const [newAspiration, setNewAspiration] = useState('')
  const [newRule, setNewRule] = useState('')
  const [newRuleRedLine, setNewRuleRedLine] = useState(false)
  const [editingRoutine, setEditingRoutine] = useState<string | null>(null)
  const [routineSteps, setRoutineSteps] = useState('')
  const [confirmRetire, setConfirmRetire] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  // 三处内联编辑各自登记触发按钮：Esc 取消或保存退出后，焦点自动还给触发它的按钮（U01 第 10 轮）。
  const aspirationFocus = useReturnFocus(editingAspiration)
  const profileFocus = useReturnFocus(editingProfile ? 'profile' : null)
  const routineFocus = useReturnFocus(editingRoutine)

  if (!props.bot) {
    return <aside className="ah-right" aria-label="队友详情" ref={panelRef} tabIndex={-1}><div className="ah-empty">从左边选一位队友。这里会显示它是谁、在项目里接什么活、在盯什么，还有每次为什么醒。</div></aside>
  }
  const b = props.bot
  /** 醒了的判断已经由「最近唤醒」完整表达（原因、结果、账本），这里只留没醒的，
      否则同一次唤醒会在右栏出现两遍。 */
  const notWoke = b.appraisals.filter(a => a.decision !== 'woke').slice(0, 8)
  /** 有进行中的唤醒时，把「为什么醒」分区自动展开并打标——主人此刻最关心的是
      「它正在干什么」，不该还得自己去折叠堆里翻（交互审查第 4 轮，抬高上限）。 */
  const liveWake = hasLiveWake(b.wakes)
  const doExec = async (name: string, input: Record<string, unknown>, okText: string): Promise<boolean> => {
    const ok = await runner.exec(name, input, okText)
    if (ok) props.onRefresh()
    return ok
  }
  // 新增项只在成功后清空；服务端拒绝时保留原文，方便修正并重试。
  const addAspiration = async (): Promise<void> => {
    if (!newAspiration.trim()) return
    if (await doExec('upsertAspiration', { botId: b.card.id, text: newAspiration.trim() }, '已加志向')) setNewAspiration('')
  }

  const openSession = (): void => {
    if (!b.profile.sessionId) { setNotice('暂无工作会话。请先派发任务。'); return }
    const result = openBotSessionWith(props.clientCtx, b.profile.sessionId)
    setNotice(OPEN_SESSION_HINTS[result])
  }

  // 提前转正不再按本地时钟估算（D06 第 3 条）：试岗起点与「还差几天」以 core 的
  // 实际记录为准，未满三天时 core 会返回中文错误并显示在下方提示里。

  return (
    <aside className="ah-right" aria-label={`${b.card.name} 的详情`} ref={panelRef} tabIndex={-1} onKeyDown={e => {
      if (e.key !== 'Escape' || runner.busy) return
      // 焦点在输入框 / 下拉 / 文本域里时，Esc 交给控件自己处理（如 select 取消展开），
      // 不收起右栏、不丢正在编辑的档案（交互审查第 4 轮：编辑态可预期、不被误杀）。
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
      e.preventDefault(); e.stopPropagation(); props.onCollapse()
    }}>
      {runner.success && runner.message ? <div className="ah-save-toast" role="status">{runner.message}</div> : null}
      <div className="ah-right-head">
        <h2>{b.card.name}<span className="ah-bot-row-role">{b.card.roleLabel}</span></h2>
        <button type="button" className="ah-btn ah-btn-ghost" disabled={runner.busy} onClick={props.onCollapse} aria-label="收起右栏">收起</button>
      </div>
      <div className="ah-right-scroll">
        <Section title="档案">
          {editingProfile ? (
            <div className="ah-edit-box">
              <label>性格与说话风格<textarea rows={3} disabled={runner.busy} value={persona} autoFocus onChange={e => setPersona(e.target.value)}
                onKeyDown={e => escToCancel(e, () => setEditingProfile(false))} /></label>
              <label>MBTI（只影响表达与做事倾向，不影响权限与审批）
                <select value={mbti} disabled={runner.busy} onChange={e => setMbti(e.target.value as MbtiDraft)}>
                  <option value="">不设置</option>
                  {MBTI_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </label>
              <label>自主等级
                <select value={autonomy} disabled={runner.busy} onChange={e => setAutonomy(e.target.value)}>
                  {AUTONOMY_CHOICES.map(a => <option key={a.value} value={a.value}>{a.label}</option>)}
                </select>
              </label>
              <label>节奏
                <select value={pace} disabled={runner.busy} onChange={e => setPace(e.target.value)}>
                  {PACE_CHOICES.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
                </select>
              </label>
              <label>模型
                <select value={model} disabled={runner.busy} onChange={e => setModel(e.target.value)}>
                  <option value="">跟随 DSH 默认</option>
                  {/* 当前模型已不在宿主目录时补一项如实显示（D07 第 7 条）。 */}
                  {modelSelectOptions(b.profile.model ?? undefined, props.modelOptions.filter(option => option.value !== null))
                    .map((option, i) => <option key={i} value={JSON.stringify(option.value) ?? ''}>{option.label}</option>)}
                </select>
                {props.modelOptionsError ? <span className="ah-right-kv ah-card-error">{props.modelOptionsError}{props.onRetrySettings ? <>　<button type="button" className="ah-btn ah-btn-ghost" onClick={props.onRetrySettings}>重试</button></> : null}</span> : null}
              </label>
              {/* P40：预置 skill 只能由主人在这里勾选，队友没有给自己加的口子。 */}
              <PresetSkillPicker options={props.presetSkillOptions} selected={presetSkillIds} disabled={runner.busy} onChange={setPresetSkillIds} />
              <div className="ah-settings-actions">
                <button type="button" className="ah-btn ah-btn-primary" disabled={runner.busy}
                  onClick={() => { void (async () => {
                    // 模型未改时不重交已下架的旧值，避免目录问题阻挡单独改性格。
                    const currentModel = b.profile.model === null ? '' : JSON.stringify(b.profile.model)
                    // MBTI 未设置时显式提交 null，旧机器人保持未设置，不补默认型。
                    const patch = { persona, mbti: mbti === '' ? null : mbti, autonomy, pace, presetSkillIds, ...(model !== currentModel ? { model: model === '' ? null : JSON.parse(model) } : {}) }
                    if (await doExec('updateBot', { botId: b.card.id, patch }, '已保存。下一步：下次唤醒生效。')) setEditingProfile(false)
                  })().catch(e => runner.setMessage(e instanceof Error ? e.message : '模型选择无效')) }}>保存档案</button>
                <button type="button" className="ah-btn" disabled={runner.busy} onClick={() => setEditingProfile(false)}>取消</button>
              </div>
            </div>
          ) : (
            <>
              <p>{b.profile.persona === '' ? '（暂无性格说明）' : b.profile.persona}</p>
              <p className="ah-right-kv">MBTI：{b.profile.mbtiLabel} · 自主等级：{b.profile.autonomyLabel} · 节奏：{b.profile.paceLabel} · 模型：{b.profile.modelText}</p>
              {/* P40：只读展示已启用的预置 skill；空数组时不占位，与今天的档案完全一致。 */}
              {b.profile.presetSkillIds.length > 0 ? (
                <p className="ah-right-kv">预置 skill：{presetSkillSummary(b.profile.presetSkillIds, props.presetSkillOptions)}</p>
              ) : null}
              <PersonalityBehavior profile={b.profile} />
              <p className="ah-right-kv">{b.profile.createdText} 上岗{b.profile.probationText ? ` · ${b.profile.probationText}` : ''}</p>
              <button type="button" className="ah-btn ah-btn-ghost" ref={profileFocus.registerTrigger('profile')} onClick={() => {
                setPersona(b.profile.persona); setMbti(b.profile.mbti ?? ''); setAutonomy(b.profile.autonomy); setPace(b.profile.pace)
                setPresetSkillIds([...b.profile.presetSkillIds])
                setModel(b.profile.model === null ? '' : JSON.stringify(b.profile.model)); setEditingProfile(true)
              }}>编辑档案</button>
            </>
          )}
        </Section>

        <Section title="志向">
          {/* 只显示一份志向文字（D04 3c-5）：编辑时才出现输入框，避免同一条重复两遍。 */}
          <ul className="ah-edit-list">
            {b.aspirations.map(a => (
              <li key={a.id}>
                {editingAspiration === a.id ? (
                  <span className="ah-edit-ops">
                    <input aria-label="改志向" disabled={runner.busy} value={aspirationText} autoFocus onChange={e => setAspirationText(e.target.value)}
                      onKeyDown={e => escToCancel(e, () => setEditingAspiration(null))} />
                    <button type="button" className="ah-btn" disabled={runner.busy || !aspirationText.trim()} onClick={() => { void (async () => {
                      if (await doExec('upsertAspiration', { id: a.id, botId: b.card.id, text: aspirationText.trim() }, '已改志向')) setEditingAspiration(null)
                    })() }}>保存</button>
                    <button type="button" className="ah-btn ah-btn-ghost" disabled={runner.busy} onClick={() => setEditingAspiration(null)}>取消</button>
                  </span>
                ) : (
                  <span className="ah-edit-row">
                    <span>{a.text}</span>
                    <span className="ah-edit-ops">
                      <button type="button" className="ah-btn ah-btn-ghost" ref={aspirationFocus.registerTrigger(a.id)} onClick={() => { setAspirationText(a.text); setEditingAspiration(a.id) }}>编辑</button>
                      {/* 收起志向要带上原文字（D07 第 10 条）：core 的入参要求 text。 */}
                      <button type="button" className="ah-btn ah-btn-ghost" onClick={() => void doExec('upsertAspiration', { id: a.id, botId: b.card.id, text: a.text, status: 'archived' }, '已收起志向')}>收起</button>
                    </span>
                  </span>
                )}
              </li>
            ))}
          </ul>
          <div className="ah-edit-add">
            {/* placeholder 只是视觉提示，aria-label 才是读屏拿到的稳定名称（WCAG 4.1.2）。 */}
            <input aria-label="加一条志向" value={newAspiration} disabled={runner.busy} placeholder="加一条志向" onChange={e => setNewAspiration(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) { e.preventDefault(); void addAspiration() } }} />
            <button type="button" className="ah-btn" disabled={newAspiration.trim() === '' || runner.busy}
              onClick={() => void addAspiration()}>加一条</button>
          </div>
        </Section>

        {/* key 用队友 id：切换队友时 GoalSection 整体重挂，「确认放弃」态天然重置。
            放弃二次确认的交互在 GoalSection 内部，成功提示语按结果在这里给。 */}
        <GoalSection
          key={b.card.id}
          goals={b.goals}
          busy={runner.busy}
          onCloseGoal={(id, outcome) => doExec('closeGoal', { id, outcome },
            outcome === true ? '已验收。下一步：待安排。' : outcome === 'abandoned' ? '已放弃。下一步：待安排。' : `已驳回。下一步：返工，负责人 ${b.card.name}。`)}
        />

        <ArtifactSection key={`artifacts-${b.card.id}`} artifacts={b.artifacts} run={props.run}
          onRefresh={props.onRefresh} focusArtifactId={props.focusArtifactId} />

        <Section title="关注项" open={b.watches.some(w => w.status === 'proposed')}
          badge={b.watches.filter(w => w.status === 'proposed').length}>
          {b.watches.length === 0 ? <p className="ah-empty">暂无关注项。队友提议后会出现在这里。</p> : (
            <ul className="ah-edit-list">
              {b.watches.map(w => (
                <li key={w.id}>
                  <span>{w.kindLabel}：{w.target}{w.status === 'proposed' ? '（队友提议，待确认）' : w.status === 'paused' ? '（已暂停）' : ''}</span>
                  <span className="ah-edit-ops">
                    {w.status === 'proposed' ? (
                      <>
                        <button type="button" className="ah-btn ah-btn-primary" disabled={runner.busy} onClick={() => void doExec('decideWatchProposal', { id: w.id, approve: true }, '已同意。')}>同意</button>
                        <button type="button" className="ah-btn" disabled={runner.busy} onClick={() => void doExec('decideWatchProposal', { id: w.id, approve: false }, '已拒绝。')}>不要</button>
                      </>
                    ) : w.status === 'active' || w.status === 'paused' ? (
                      /* 暂停/恢复要拼完整入参（D07 第 10 条）：kind/target/why 来自该行已有字段，
                         否则 core 会报「关注项无效」。 */
                      <button type="button" className="ah-btn ah-btn-ghost" disabled={runner.busy}
                        onClick={() => void doExec('upsertWatch', watchStatusInput(b.card.id, w, w.status === 'active' ? 'paused' : 'active'), w.status === 'active' ? '已暂停。下一步：恢复，负责人 待安排。' : '已恢复。下一步：待安排。')}>
                        {w.status === 'active' ? '暂停' : '恢复'}
                      </button>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="规矩">
          <ul className="ah-edit-list">
            {b.rules.map(r => <li key={r.id}>{r.redLine ? <span className="ah-tag ah-tag-wait">红线</span> : null}{r.text}</li>)}
          </ul>
          <div className="ah-edit-add">
            {/* 同志向输入框：aria-label 补稳定可达名称，placeholder 保留视觉提示。 */}
            <input aria-label="加一条规矩" value={newRule} disabled={runner.busy} placeholder="加一条规矩" onChange={e => setNewRule(e.target.value)} />
            <label className="ah-right-kv"><input type="checkbox" disabled={runner.busy} checked={newRuleRedLine} onChange={e => setNewRuleRedLine(e.target.checked)} />红线</label>
            <button type="button" className="ah-btn" disabled={newRule.trim() === '' || runner.busy}
              onClick={() => { void (async () => {
                if (await doExec('upsertRule', { scope: b.card.id, text: newRule.trim(), redLine: newRuleRedLine }, '已加规矩')) { setNewRule(''); setNewRuleRedLine(false) }
              })() }}>加一条</button>
          </div>
        </Section>

        <Section title="会的技能">
          {b.routines.length === 0 ? <p className="ah-empty">还没有技能。点「教它技能」，下次它能自己来。</p> : (
            <ul className="ah-edit-list">
              {b.routines.map(r => (
                <li key={r.id}>
                  <span><strong>{r.name}</strong>：{r.whenToUse}（用过 {r.runs} 次）</span>
                  <span className="ah-edit-ops">
                    <button type="button" className="ah-btn ah-btn-ghost" ref={routineFocus.registerTrigger(r.id)} onClick={() => {
                      setEditingRoutine(editingRoutine === r.id ? null : r.id)
                      setRoutineSteps(r.steps.join('\n'))
                    }}>{editingRoutine === r.id ? '收起' : '查看 / 编辑'}</button>
                  </span>
                  {editingRoutine === r.id ? (
                    <div className="ah-edit-box">
                      <ol className="ah-routine-steps">{r.steps.map((step, i) => <li key={i}>{step}</li>)}</ol>
                      {/* 编辑态文本域：同类补齐 aria-label，避免读屏只读到一个无名称编辑框。 */}
                      <textarea rows={4} aria-label="技能步骤，一行一步" disabled={runner.busy} value={routineSteps} autoFocus onChange={e => setRoutineSteps(e.target.value)} placeholder="一行一步"
                        onKeyDown={e => escToCancel(e, () => setEditingRoutine(null))} />
                      <button type="button" className="ah-btn ah-btn-primary" disabled={runner.busy}
                        onClick={() => { void (async () => {
                          if (await doExec('editRoutine', { id: r.id, patch: { steps: routineSteps.split(/\r?\n/).map(s => s.trim()).filter(s => s !== '') } }, '技能已更新')) setEditingRoutine(null)
                        })() }}>保存步骤</button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Section>

        {/* 一处只讲一次：醒了的记录（原因、结果、账本）与没醒的判断放在同一块，
            同一次唤醒不再同时出现在「为什么醒」和「最近唤醒」两个列表里。
            活动流负责全队事件流水，这里负责单个队友的判断与账本明细。 */}
        <Section
          title="为什么醒 / 为什么没醒"
          open={liveWake || props.focusWakeId ? true : undefined}
          chip={liveWake ? '正在执行' : undefined}
        >
          <WakeLedgerSection
            wakes={b.wakes}
            ledgers={props.ledgers}
            ledgerErrors={props.ledgerErrors}
            onLoadLedger={props.onLoadLedger}
            focusWakeId={props.focusWakeId}
          />
          {notWoke.length > 0 ? (
            <>
              <p className="ah-section-subtitle">没醒的时候</p>
              <ul className="ah-appraisals">
                {notWoke.map((a) => (
                  <li key={a.id}>
                    <span className="ah-appraisal-decision">{a.decisionLabel}</span>
                    {a.text}（{a.timeText}）
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </Section>
      </div>
      <div className="ah-right-actions">
        <button type="button" className="ah-btn" onClick={props.onTeach}>教它技能</button>
        <button type="button" className="ah-btn" onClick={openSession}>打开工作会话</button>
        {/* D06 第 3 条 / D07 第 24 条：生命周期动作全部走 lifecycleAction，按当前状态
            只显示合法按钮——按钮表集中在 logic/lifecycle.ts 的纯函数（与线程头、设置页
            共用一份规则）；退役按钮单独处理（二次确认在组件内）。 */}
        {lifecycleButtons(b.card.lifecycle).filter(button => button.action !== 'retire').map(button => (
          <button key={button.action} type="button" className="ah-btn" disabled={runner.busy}
            onClick={() => void doExec('lifecycleAction', { botId: b.card.id, action: button.action }, LIFECYCLE_OK_TEXT[button.action])}>{button.label}</button>
        ))}
        {b.card.lifecycle !== 'retired' ? (
          confirmRetire ? (
            <>
              <button type="button" className="ah-btn ah-btn-danger" disabled={runner.busy}
                onClick={() => { void doExec('lifecycleAction', { botId: b.card.id, action: 'retire' }, '已退役。数据保留，可恢复。'); setConfirmRetire(false) }}>确认退役</button>
              <button type="button" className="ah-btn ah-btn-ghost" onClick={() => setConfirmRetire(false)}>取消</button>
            </>
          ) : (
            <button type="button" className="ah-btn ah-btn-ghost" onClick={() => setConfirmRetire(true)}>退役</button>
          )
        ) : null}
        {notice ? <p className="ah-right-notice">{notice}</p> : null}
        {!runner.success && runner.message ? <p className="ah-right-notice" role="alert">{runner.message}</p> : null}
      </div>
    </aside>
  )
}

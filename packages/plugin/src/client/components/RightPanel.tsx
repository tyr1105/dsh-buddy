/**
 * 右栏（可收起，任务卡 D03 第 6 节「机器人详情可编辑」）：
 * 档案（性格、自主等级、节奏、模型）编辑；志向增删改；目标：完成待验收的显示
 * 「验收通过 / 没过」；关注项：提议中的「同意 / 不要」，在用的暂停/恢复；
 * 规矩：新增一条（可勾红线）；生命周期：暂停/恢复/提前转正（试岗满 3 天）/解除停用/退役（二次确认）；
 * 套路可点开查看步骤并编辑（editRoutine）；「为什么醒 / 为什么没醒」最近 8 条。
 */
import { useState, type ReactNode } from 'react'
import type { BotView, CommandResult } from '../../shared/views.js'
import { openBotSessionWith, OPEN_SESSION_HINTS } from '../logic/thread.js'
import { lifecycleButtons } from '../logic/lifecycle.js'
import { modelSelectOptions } from '../logic/settings.js'

const AUTONOMY_CHOICES: ReadonlyArray<{ value: 'L0' | 'L1' | 'L2' | 'L3'; label: string }> = [
  { value: 'L0', label: 'L0 只观察' }, { value: 'L1', label: 'L1 建议' }, { value: 'L2', label: 'L2 执行' }, { value: 'L3', label: 'L3 授权执行' },
]
const PACE_CHOICES: ReadonlyArray<{ value: 'active' | 'normal' | 'quiet'; label: string }> = [
  { value: 'active', label: '积极' }, { value: 'normal', label: '适中' }, { value: 'quiet', label: '安静' },
]

/** 各生命周期动作成功后的提示语（doExec 的 okText）。 */
const LIFECYCLE_OK_TEXT: Readonly<Record<'pause' | 'resume' | 'promote' | 'release_quarantine' | 'retire', string>> = {
  pause: '已暂停（期间的变化都存着）',
  resume: '已恢复',
  promote: '已提前转正',
  release_quarantine: '已解除停用',
  retire: '已退役（数据保留）',
}

/**
 * 关注项暂停/恢复的完整入参（D07 第 10 条）：用视图该行已有的 kind/target/why 拼，
 * 只改 status——只发 {id,botId,status} 会被 core 按「关注项无效」拒绝。
 */
function watchStatusInput(botId: string, w: BotView['watches'][number], status: 'active' | 'paused'): Record<string, unknown> {
  return { id: w.id, botId, kind: w.kind, target: w.target, why: w.why ?? '', status }
}

function Section(props: { title: string; children: ReactNode }): ReactNode {
  return (
    <section className="ah-right-section">
      <h3>{props.title}</h3>
      {props.children}
    </section>
  )
}

/** 命令执行小钩子：统一 busy 与中文错误显示。 */
function useRunner(run: (name: string, input: Record<string, unknown>) => Promise<CommandResult>) {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const exec = async (name: string, input: Record<string, unknown>, okText: string): Promise<boolean> => {
    if (busy) return false
    setBusy(true)
    try {
      const result = await run(name, input)
      setMessage(result.ok ? okText : result.error)
      return result.ok
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e))
      return false
    } finally {
      setBusy(false)
    }
  }
  return { busy, message, exec, setMessage }
}

export function RightPanel(props: {
  bot: BotView | null
  modelOptions: ReadonlyArray<{ value: unknown; label: string }>
  /** 模型目录读取失败的原因（D07 第 2 条）：下拉旁显示并给「重试」。 */
  modelOptionsError?: string | null
  onRetrySettings?: () => void
  clientCtx: unknown
  run: (name: string, input: Record<string, unknown>) => Promise<CommandResult>
  onRefresh: () => void
  onTeach: () => void
  onCollapse: () => void
}): ReactNode {
  const runner = useRunner(props.run)
  const [editingProfile, setEditingProfile] = useState(false)
  const [editingAspiration, setEditingAspiration] = useState<string | null>(null)
  const [persona, setPersona] = useState('')
  const [newAspiration, setNewAspiration] = useState('')
  const [newRule, setNewRule] = useState('')
  const [newRuleRedLine, setNewRuleRedLine] = useState(false)
  const [editingRoutine, setEditingRoutine] = useState<string | null>(null)
  const [routineSteps, setRoutineSteps] = useState('')
  const [confirmRetire, setConfirmRetire] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  if (!props.bot) {
    return <aside className="ah-right"><div className="ah-empty">从左边选一个队友，这里显示它的档案、目标、议程和「为什么醒 / 为什么没醒」。</div></aside>
  }
  const b = props.bot
  const doExec = async (name: string, input: Record<string, unknown>, okText: string): Promise<void> => {
    const ok = await runner.exec(name, input, okText)
    if (ok) props.onRefresh()
  }

  const openSession = (): void => {
    if (!b.profile.sessionId) { setNotice('它还没有工作会话。'); return }
    const result = openBotSessionWith(props.clientCtx, b.profile.sessionId)
    setNotice(OPEN_SESSION_HINTS[result])
  }

  // 提前转正不再按本地时钟估算（D06 第 3 条）：试岗起点与「还差几天」以 core 的
  // 实际记录为准，未满三天时 core 会返回中文错误并显示在下方提示里。

  return (
    <aside className="ah-right" aria-label={`${b.card.name} 的详情`}>
      <div className="ah-right-head">
        <h2>{b.card.name}<span className="ah-bot-row-role">{b.card.roleLabel}</span></h2>
        <button type="button" className="ah-btn ah-btn-ghost" onClick={props.onCollapse} aria-label="收起右栏">收起</button>
      </div>
      <div className="ah-right-scroll">
        <Section title="档案">
          {editingProfile ? (
            <div className="ah-edit-box">
              <label>性格与说话风格<textarea rows={3} value={persona} onChange={e => setPersona(e.target.value)} /></label>
              <label>自主等级
                <select value={b.profile.autonomy} onChange={e => { void doExec('updateBot', { botId: b.card.id, patch: { autonomy: e.target.value } }, '已改自主等级（下一次思考生效）') }}>
                  {AUTONOMY_CHOICES.map(a => <option key={a.value} value={a.value}>{a.label}</option>)}
                </select>
              </label>
              <label>节奏
                <select value={b.profile.pace} onChange={e => { void doExec('updateBot', { botId: b.card.id, patch: { pace: e.target.value } }, '已改节奏') }}>
                  {PACE_CHOICES.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
                </select>
              </label>
              <label>模型
                <select value={b.profile.model === null ? '' : JSON.stringify(b.profile.model)}
                  onChange={e => { void doExec('updateBot', { botId: b.card.id, patch: { model: e.target.value === '' ? null : JSON.parse(e.target.value) } }, '已改模型') }}>
                  <option value="">跟随 DSH 默认</option>
                  {/* 当前模型已不在宿主目录时补一项如实显示（D07 第 7 条）。 */}
                  {modelSelectOptions(b.profile.model ?? undefined, props.modelOptions.filter(option => option.value !== null))
                    .map((option, i) => <option key={i} value={JSON.stringify(option.value) ?? ''}>{option.label}</option>)}
                </select>
                {props.modelOptionsError ? <span className="ah-right-kv ah-card-error">{props.modelOptionsError}{props.onRetrySettings ? <>　<button type="button" className="ah-btn ah-btn-ghost" onClick={props.onRetrySettings}>重试</button></> : null}</span> : null}
              </label>
              <div className="ah-settings-actions">
                <button type="button" className="ah-btn ah-btn-primary" disabled={runner.busy}
                  onClick={() => { void doExec('updateBot', { botId: b.card.id, patch: { persona } }, '已保存性格'); setEditingProfile(false) }}>保存</button>
                <button type="button" className="ah-btn" onClick={() => setEditingProfile(false)}>取消</button>
              </div>
            </div>
          ) : (
            <>
              <p>{b.profile.persona === '' ? '（还没写过性格说明）' : b.profile.persona}</p>
              <p className="ah-right-kv">自主等级：{b.profile.autonomyLabel} · 节奏：{b.profile.paceLabel} · 模型：{b.profile.modelText}</p>
              <p className="ah-right-kv">{b.profile.createdText} 上岗{b.profile.probationText ? ` · ${b.profile.probationText}` : ''}</p>
              <button type="button" className="ah-btn ah-btn-ghost" onClick={() => { setPersona(b.profile.persona); setEditingProfile(true) }}>编辑档案</button>
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
                    <input aria-label="改志向" defaultValue={a.text} autoFocus
                      onBlur={e => {
                        const text = e.target.value.trim()
                        if (text !== '' && text !== a.text) void doExec('upsertAspiration', { id: a.id, botId: b.card.id, text }, '已改志向')
                        setEditingAspiration(null)
                      }} />
                  </span>
                ) : (
                  <span className="ah-edit-row">
                    <span>{a.text}</span>
                    <span className="ah-edit-ops">
                      <button type="button" className="ah-btn ah-btn-ghost" onClick={() => setEditingAspiration(a.id)}>改</button>
                      {/* 收起志向要带上原文字（D07 第 10 条）：core 的入参要求 text。 */}
                      <button type="button" className="ah-btn ah-btn-ghost" onClick={() => void doExec('upsertAspiration', { id: a.id, botId: b.card.id, text: a.text, status: 'archived' }, '已收起志向')}>收起</button>
                    </span>
                  </span>
                )}
              </li>
            ))}
          </ul>
          <div className="ah-edit-add">
            <input value={newAspiration} placeholder="加一条志向" onChange={e => setNewAspiration(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && newAspiration.trim() !== '') { void doExec('upsertAspiration', { botId: b.card.id, text: newAspiration.trim() }, '已加志向'); setNewAspiration('') } }} />
            <button type="button" className="ah-btn" disabled={newAspiration.trim() === '' || runner.busy}
              onClick={() => { void doExec('upsertAspiration', { botId: b.card.id, text: newAspiration.trim() }, '已加志向'); setNewAspiration('') }}>加一条</button>
          </div>
        </Section>

        <Section title="目标">
          {b.goals.length === 0 ? <p className="ah-empty">还没有目标。可以在志向下建一个。</p> : (
            <ul className="ah-edit-list">
              {b.goals.map(g => (
                <li key={g.id}>
                  <span><strong>{g.title}</strong>（{g.periodText}）<br />{g.statusLabel}{g.lastProgressText ? ` · ${g.lastProgressText}` : ''}</span>
                  <span className="ah-edit-ops">
                    {g.status === 'done_pending_check' ? (
                      <>
                        <button type="button" className="ah-btn ah-btn-primary" disabled={runner.busy} onClick={() => void doExec('closeGoal', { id: g.id, outcome: true }, '已验收通过')}>验收通过</button>
                        <button type="button" className="ah-btn" disabled={runner.busy} onClick={() => void doExec('closeGoal', { id: g.id, outcome: false }, '已记验收没过')}>没过</button>
                      </>
                    ) : g.status === 'active' ? (
                      <button type="button" className="ah-btn ah-btn-ghost" disabled={runner.busy} onClick={() => void doExec('closeGoal', { id: g.id, outcome: 'abandoned' }, '已放弃目标')}>放弃</button>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="关注项">
          {b.watches.length === 0 ? <p className="ah-empty">它还没有在盯的东西。</p> : (
            <ul className="ah-edit-list">
              {b.watches.map(w => (
                <li key={w.id}>
                  <span>{w.kindLabel}：{w.target}{w.status === 'proposed' ? '（它提议的，等你点头）' : w.status === 'paused' ? '（已暂停）' : ''}</span>
                  <span className="ah-edit-ops">
                    {w.status === 'proposed' ? (
                      <>
                        <button type="button" className="ah-btn ah-btn-primary" disabled={runner.busy} onClick={() => void doExec('decideWatchProposal', { id: w.id, approve: true }, '已同意它的提议')}>同意</button>
                        <button type="button" className="ah-btn" disabled={runner.busy} onClick={() => void doExec('decideWatchProposal', { id: w.id, approve: false }, '已拒绝它的提议')}>不要</button>
                      </>
                    ) : w.status === 'active' || w.status === 'paused' ? (
                      /* 暂停/恢复要拼完整入参（D07 第 10 条）：kind/target/why 来自该行已有字段，
                         否则 core 会报「关注项无效」。 */
                      <button type="button" className="ah-btn ah-btn-ghost" disabled={runner.busy}
                        onClick={() => void doExec('upsertWatch', watchStatusInput(b.card.id, w, w.status === 'active' ? 'paused' : 'active'), w.status === 'active' ? '已暂停' : '已恢复')}>
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
            <input value={newRule} placeholder="加一条规矩" onChange={e => setNewRule(e.target.value)} />
            <label className="ah-right-kv"><input type="checkbox" checked={newRuleRedLine} onChange={e => setNewRuleRedLine(e.target.checked)} />红线</label>
            <button type="button" className="ah-btn" disabled={newRule.trim() === '' || runner.busy}
              onClick={() => { void doExec('upsertRule', { scope: b.card.id, text: newRule.trim(), redLine: newRuleRedLine }, '已加规矩'); setNewRule(''); setNewRuleRedLine(false) }}>加一条</button>
          </div>
        </Section>

        <Section title="会的套路">
          {b.routines.length === 0 ? <p className="ah-empty">还没学会套路。可以「教它一招」。</p> : (
            <ul className="ah-edit-list">
              {b.routines.map(r => (
                <li key={r.id}>
                  <span><strong>{r.name}</strong>：{r.whenToUse}（用过 {r.runs} 次）</span>
                  <span className="ah-edit-ops">
                    <button type="button" className="ah-btn ah-btn-ghost" onClick={() => {
                      setEditingRoutine(editingRoutine === r.id ? null : r.id)
                      setRoutineSteps(r.steps.join('\n'))
                    }}>{editingRoutine === r.id ? '收起' : '查看 / 编辑'}</button>
                  </span>
                  {editingRoutine === r.id ? (
                    <div className="ah-edit-box">
                      <ol className="ah-routine-steps">{r.steps.map((step, i) => <li key={i}>{step}</li>)}</ol>
                      <textarea rows={4} value={routineSteps} onChange={e => setRoutineSteps(e.target.value)} placeholder="一行一步" />
                      <button type="button" className="ah-btn ah-btn-primary" disabled={runner.busy}
                        onClick={() => { void doExec('editRoutine', { id: r.id, patch: { steps: routineSteps.split(/\r?\n/).map(s => s.trim()).filter(s => s !== '') } }, '套路已更新'); setEditingRoutine(null) }}>保存步骤</button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="为什么醒 / 为什么没醒（最近 8 条）">
          <ul className="ah-appraisals">
            {[...b.appraisals].slice(0, 8).map((a) => (
              <li key={a.id}>
                <span className={`ah-appraisal-decision${a.decision === 'woke' ? ' ah-appraisal-woke' : ''}`}>{a.decisionLabel}</span>
                {a.text}（{a.timeText}）
              </li>
            ))}
          </ul>
        </Section>
      </div>
      <div className="ah-right-actions">
        <button type="button" className="ah-btn" onClick={props.onTeach}>教它一招</button>
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
                onClick={() => { void doExec('lifecycleAction', { botId: b.card.id, action: 'retire' }, '已退役（数据保留）'); setConfirmRetire(false) }}>确认退役</button>
              <button type="button" className="ah-btn ah-btn-ghost" onClick={() => setConfirmRetire(false)}>再想想</button>
            </>
          ) : (
            <button type="button" className="ah-btn ah-btn-ghost" onClick={() => setConfirmRetire(true)}>退役</button>
          )
        ) : null}
        {notice ? <p className="ah-right-notice">{notice}</p> : null}
        {runner.message ? <p className="ah-right-notice">{runner.message}</p> : null}
      </div>
    </aside>
  )
}

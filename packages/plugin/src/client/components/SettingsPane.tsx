/**
 * 设置页（顶栏齿轮）：免打扰时段、日报时间、推送渠道（macOS 通知 / 不推）、
 * 每日单推上限（全体与每个队友）、默认模型、根目录（只读）、
 * 「全部暂停 / 全部恢复」（对所有在岗与试岗队友逐个调 lifecycleAction）、版本与健康。
 * 保存走 updateSettings；非法值中文提示、不能保存（校验在 logic/settings.ts）。
 */
import { useEffect, useState, type ReactNode } from 'react'
import type { OverviewView, SettingsView } from '../../shared/views.js'
import { EmptyHint, RetryBox, Skeleton } from './Ui.js'
import { buildSettingsPatch, draftFromSettings, modelSelectOptions, validateSettingsDraft, type SettingsDraft } from '../logic/settings.js'
import type { ModelChoice } from '../../shared/views.js'

const PUSH_CHANNEL_LABELS: Readonly<Record<string, string>> = { macos: 'macOS 通知', dsh: '宿主通知', none: '不推' }

/** 草稿的 defaultModel 序列化字符串 → ModelChoice（'' 为跟随默认）。 */
function parseModel(serialized: string): ModelChoice | undefined {
  if (serialized === '') return undefined
  try { return JSON.parse(serialized) as ModelChoice } catch { return undefined }
}

export function SettingsPane(props: {
  settings: SettingsView | null
  overview: OverviewView | null
  /** 设置视图拉取失败的原因（D07 第 2 条）：与「连不上」分开显示。 */
  loadError?: string | null
  loading: boolean
  onRetry: () => void
  onSave: (patch: Record<string, unknown>) => Promise<string | null>   // 返回错误文案或 null
  onPauseAll: () => Promise<string | null>
  onResumeAll: () => Promise<string | null>
}): ReactNode {
  const [draft, setDraft] = useState<SettingsDraft | null>(null)
  /** 加载到的设置派生草稿：defaultModel 只在与它不同时才进 patch（D07 第 7 条）。 */
  const [loaded, setLoaded] = useState<SettingsDraft | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [lifecycleBusy, setLifecycleBusy] = useState(false)
  const [lifecycleNote, setLifecycleNote] = useState<string | null>(null)

  // 设置视图到位后初始化表单（只在第一次或重试后）。
  useEffect(() => {
    if (props.settings) {
      const fresh = draftFromSettings(props.settings.settings)
      setLoaded(prev => prev ?? fresh)
      setDraft(prev => prev ?? fresh)
    }
  }, [props.settings])

  if (!props.settings || !draft) {
    return <div className="ah-settings">{props.loading ? <Skeleton rows={4} /> : <RetryBox message={`设置没加载出来${props.loadError ? `：${props.loadError}` : '。'}`} onRetry={props.onRetry} />}</div>
  }
  const set = (partial: Partial<SettingsDraft>): void => { setDraft({ ...draft, ...partial }); setError(null) }
  const validation = validateSettingsDraft(draft)

  const save = async (): Promise<void> => {
    if (validation !== null || saving) return
    setSaving(true)
    try {
      const message = await props.onSave(buildSettingsPatch(draft, loaded ?? undefined))
      setError(message)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const lifecycle = async (work: () => Promise<string | null>, label: string): Promise<void> => {
    if (lifecycleBusy) return
    setLifecycleBusy(true)
    setLifecycleNote(`${label}中…`)
    try {
      const message = await work()
      setLifecycleNote(message ?? `已${label}`)
    } catch (e) {
      setLifecycleNote(e instanceof Error ? e.message : String(e))
    } finally {
      setLifecycleBusy(false)
    }
  }

  const o = props.overview
  return (
    <section className="ah-settings" aria-label="设置">
      <h3>打扰与日报</h3>
      <div className="ah-settings-grid">
        <label>免打扰开始<input type="time" step={300} value={draft.quietStart} onChange={e => set({ quietStart: e.target.value })} /></label>
        <label>免打扰结束<input type="time" step={300} value={draft.quietEnd} onChange={e => set({ quietEnd: e.target.value })} /></label>
        <label>日报时间<input type="time" step={300} value={draft.digestAt} onChange={e => set({ digestAt: e.target.value })} /></label>
        <label>推送渠道
          <select value={draft.pushChannel} onChange={e => set({ pushChannel: e.target.value })}>
            {props.settings.pushChannelOptions.map(channel => (
              <option key={channel} value={channel}>{PUSH_CHANNEL_LABELS[channel] ?? channel}</option>
            ))}
          </select>
        </label>
        <label>每日单推上限（全体，0–10）<input type="number" min={0} max={10} value={draft.dailyPushCap} onChange={e => set({ dailyPushCap: e.target.value })} /></label>
        <label>每日单推上限（每个队友，0–3）<input type="number" min={0} max={3} value={draft.botDailyPushCap} onChange={e => set({ botDailyPushCap: e.target.value })} /></label>
        <label>默认模型
          <select value={draft.defaultModel} onChange={e => set({ defaultModel: e.target.value })}>
            <option value="">跟随 DSH 默认</option>
            {/* 当前默认模型已不在宿主目录时补一项如实显示（D07 第 7 条）。 */}
            {modelSelectOptions(parseModel(draft.defaultModel), props.settings.modelOptions.filter(option => option.value !== null))
              .map((option, i) => <option key={i} value={JSON.stringify(option.value) ?? ''}>{option.label}</option>)}
          </select>
          {props.loadError ? <span className="ah-right-kv ah-card-error">模型列表没加载出来：{props.loadError}</span> : null}
        </label>
        <label>根目录（只读）<input value={props.settings.settings.rootDir} readOnly disabled /></label>
      </div>
      {props.loadError ? <p className="ah-settings-error" role="alert">设置没加载出来：{props.loadError}　<button type="button" className="ah-btn ah-btn-ghost" onClick={props.onRetry}>重试</button></p> : null}
      {error ? <p className="ah-settings-error" role="alert">{error}</p> : null}
      {validation !== null ? <p className="ah-settings-error" role="alert">{validation}</p> : null}
      <div className="ah-settings-actions">
        <button type="button" className="ah-btn ah-btn-primary" disabled={validation !== null || saving} onClick={() => void save()}>
          {saving ? '保存中…' : '保存'}
        </button>
      </div>

      <h3>全体队友</h3>
      <div className="ah-settings-actions">
        <button type="button" className="ah-btn" disabled={lifecycleBusy} onClick={() => void lifecycle(props.onPauseAll, '全部暂停')}>全部暂停</button>
        <button type="button" className="ah-btn" disabled={lifecycleBusy} onClick={() => void lifecycle(props.onResumeAll, '全部恢复')}>全部恢复</button>
        {lifecycleNote ? <span className="ah-right-notice">{lifecycleNote}</span> : null}
      </div>

      <h3>健康</h3>
      {o ? (
        <ul className="ah-settings-health">
          <li>中心心跳：{o.health.heartbeatText}</li>
          {o.health.downtimeText ? <li>最近停机：{o.health.downtimeText}</li> : null}
          <li>未处理告警：{o.health.openAlerts} 条</li>
          <li>额度：{o.quota.lightLabel} · {o.quota.usedText}{o.quota.resetText ? ` · ${o.quota.resetText}` : ''}</li>
          <li>今天还能单推 {o.pushesLeftToday} 条（P0 告警不受限）</li>
          <li className="ah-right-kv">额度灯说明：绿灯正常；黄灯非紧急的节奏放慢一倍；橙灯只放紧急与主人发起；红灯全体歇着等窗口重置。</li>
        </ul>
      ) : <EmptyHint text="健康信息没加载出来。" />}
    </section>
  )
}

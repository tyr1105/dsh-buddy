/**
 * 设置页外壳（P51）：左边分区导航，右边当前分区的内容，底部保存条。
 *
 * 交互约定：
 * - 从左侧导航进入，是一个独立页面；资料也收在这里，因为它是全局配置，不属于某位队友；
 * - 表单项共用一份草稿，切换分区不丢内容，有改动的分区在导航上带圆点；
 * - 只有存在改动时才出现底部保存条，「放弃修改」回到已保存的值；
 * - 资料、知识库测试、全队暂停是立刻发生的动作，不进保存条。
 *
 * 校验和拼装仍在 logic/settings.ts；切走再回来时用暂存恢复未保存的修改。
 */
import { useEffect, useState, type ReactNode } from 'react'
import type { KnowledgeConnectionState } from '@agent-hub/core'
import type { OverviewView, SettingsView } from '../../shared/views.js'
import { RetryBox, Skeleton } from './Ui.js'
import {
  buildSettingsPatch, draftFromSettings, dropSettingsDraft,
  restoreSettingsDraft, stashSettingsDraft, validateSettingsDraft, type SettingsDraft,
} from '../logic/settings.js'
import {
  SETTINGS_SECTIONS, changedFieldCount, changedSections, type SettingsSectionId,
} from '../logic/settings-sections.js'
import { KnowledgeSection, NotifySection, StatusSection, UsageSection } from './settings-sections.js'

export function SettingsPane(props: {
  settings: SettingsView | null
  overview: OverviewView | null
  /** 设置视图拉取失败的原因：与「连不上」分开显示。 */
  loadError?: string | null
  loading: boolean
  onRetry: () => void
  /** 运行状态（总览）读不出来时的重试（U11 #28）：与设置本身的重试分开。 */
  onRetryOverview?: () => void
  onSave: (patch: Record<string, unknown>) => Promise<string | null>   // 返回错误文案或 null
  onPauseAll: () => Promise<string | null>
  onResumeAll: () => Promise<string | null>
  onTestKnowledge: (config: Record<string, unknown>) => Promise<KnowledgeConnectionState | string>
  /** 外部要求直接打开某个分区（例如跳转面板选「资料」）。 */
  requestedSection?: SettingsSectionId | null
  /** 切换分区时通知父层，资料分区据此拉最新数据。 */
  onOpenSection?: (id: SettingsSectionId) => void
  /** 资料分区的内容，由父层组装好传入。 */
  resources: ReactNode
}): ReactNode {
  const [section, setSection] = useState<SettingsSectionId>(props.requestedSection ?? 'notify')
  const [draft, setDraft] = useState<SettingsDraft | null>(null)
  /** 最近一次已保存的值：判断「改了什么」和「放弃修改」都以它为准。 */
  const [loaded, setLoaded] = useState<SettingsDraft | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  /** 当前草稿是否来自上次没保存的暂存。 */
  const [restored, setRestored] = useState(false)

  useEffect(() => {
    if (props.requestedSection) setSection(props.requestedSection)
  }, [props.requestedSection])

  useEffect(() => {
    if (!saved) return
    const timer = setTimeout(() => { try { setSaved(false) } catch { /* 提示不影响宿主。 */ } }, 2200)
    return () => clearTimeout(timer)
  }, [saved])

  // 设置视图到位后初始化表单（只在第一次）；本地有未保存且基线未变的草稿时优先恢复。
  useEffect(() => {
    if (!props.settings) return
    const fresh = draftFromSettings(props.settings.settings)
    const stashed = restoreSettingsDraft(fresh)
    setLoaded(prev => prev ?? fresh)
    setDraft(prev => prev ?? stashed ?? fresh)
    setRestored(prev => prev || stashed !== null)
  }, [props.settings])

  const open = (id: SettingsSectionId): void => {
    setSection(id)
    props.onOpenSection?.(id)
  }

  const set = (partial: Partial<SettingsDraft>): void => {
    if (draft === null) return
    const next = { ...draft, ...partial }
    setDraft(next)
    setError(null)
    // 每改一项就暂存：切到别的页面再回来，未保存的修改还在。
    stashSettingsDraft(next, loaded ?? draft)
  }

  const validation = draft ? validateSettingsDraft(draft) : null
  const count = draft ? changedFieldCount(draft, loaded) : 0
  const dirty = draft ? changedSections(draft, loaded) : []

  const save = async (): Promise<void> => {
    if (draft === null || validation !== null || saving) return
    setSaving(true)
    try {
      const message = await props.onSave(buildSettingsPatch(draft, loaded ?? undefined))
      setError(message)
      if (message === null) {
        setLoaded({ ...draft })
        setSaved(true)
        // 真正生效后暂存才作废，否则下次进来又会提示恢复。
        dropSettingsDraft()
        setRestored(false)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const discard = (): void => {
    if (loaded === null) return
    setDraft(loaded)
    setRestored(false)
    setError(null)
    dropSettingsDraft()
  }

  const current = SETTINGS_SECTIONS.find(item => item.id === section) ?? SETTINGS_SECTIONS[0]!
  const body = (): ReactNode => {
    if (!props.settings || !draft) {
      return props.loading ? <Skeleton rows={4} /> : <RetryBox message={`设置读取失败${props.loadError ? `：${props.loadError}` : ''}。点击「重试」。`} onRetry={props.onRetry} />
    }
    if (section === 'notify') return <NotifySection draft={draft} set={set} settings={props.settings} />
    if (section === 'usage') return <UsageSection draft={draft} set={set} settings={props.settings} overview={props.overview} loadError={props.loadError} onRetry={props.onRetry} />
    if (section === 'knowledge') return <KnowledgeSection draft={draft} set={set} onTest={props.onTestKnowledge} />
    return <StatusSection overview={props.overview} rootDir={props.settings.settings.rootDir} onRetry={props.onRetryOverview} onPauseAll={props.onPauseAll} onResumeAll={props.onResumeAll} />
  }

  const showBar = count > 0 || error !== null
  return (
    <section className="ah-set" aria-label="设置">
      {saved ? <div className="ah-save-toast" role="status">已保存。</div> : null}
      <nav className="ah-set-nav" aria-label="设置分区">
        <header className="ah-pane-heading"><h2>设置</h2></header>
        {SETTINGS_SECTIONS.map(item => (
          <button
            key={item.id}
            type="button"
            className={`ah-set-nav-item${item.id === section ? ' ah-selected' : ''}`}
            aria-current={item.id === section ? 'page' : undefined}
            onClick={() => open(item.id)}
          >
            <span>{item.title}</span>
            {dirty.includes(item.id) ? <span className="ah-set-dot" title="有未保存的修改" aria-label="有未保存的修改" /> : null}
          </button>
        ))}
      </nav>
      <div className="ah-set-main">
        {section === 'resources' ? props.resources : (
          <div className="ah-set-scroll">
            <div className="ah-set-body">
              <header className="ah-set-head">
                <h3>{current.title}</h3>
                <p>{current.summary}</p>
              </header>
              {body()}
            </div>
          </div>
        )}
        {showBar ? (
          <div className="ah-set-bar" role="region" aria-label="保存修改">
            <p className={validation !== null || error !== null ? 'ah-settings-error' : 'ah-set-bar-text'} role={validation !== null || error !== null ? 'alert' : undefined}>
              {validation ?? error ?? (restored ? `上次未保存的 ${count} 项修改尚未生效。` : `${count} 项修改未保存。`)}
            </p>
            <div className="ah-settings-actions">
              <button type="button" className="ah-btn ah-btn-ghost" disabled={saving} onClick={discard}>放弃修改</button>
              <button type="button" className="ah-btn ah-btn-primary" disabled={validation !== null || saving || count === 0} onClick={() => void save()}>
                {saving ? '保存中…' : '保存修改'}
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  )
}

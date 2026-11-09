/**
 * 「教它技能」弹窗：列出 recentSessions（标题、更新时间，可搜索），选一个 + 一句说明
 * → teach 命令 → 线程里出现中心消息「已把会话 {标题} 交给 {名字} 学习」。
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { RecentSessionView } from '../../shared/views.js'
import { useDialogFocus } from './use-dialog-focus.js'

export function TeachDialog(props: {
  botName: string
  sessions: readonly RecentSessionView[]
  onTeach: (sessionId: string, note: string) => Promise<string | null>   // 返回错误文案或 null
  onClose: () => void
}): ReactNode {
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<string>('')
  const [note, setNote] = useState('把该会话里的做法整理成技能')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dialogRef = useDialogFocus(props.onClose, busy)

  useEffect(() => { if (props.sessions.length > 0 && picked === '') setPicked(props.sessions[0]!.sessionId) }, [props.sessions, picked])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q === '' ? [...props.sessions] : props.sessions.filter(s => s.title.toLowerCase().includes(q))
  }, [props.sessions, query])

  const teach = async (): Promise<void> => {
    if (picked === '' || busy) return
    setBusy(true)
    try {
      const message = await props.onTeach(picked, note)
      if (message !== null) setError(message)
      else props.onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ah-dialog-mask" ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={`教 ${props.botName} 技能`}>
      <div className="ah-dialog ah-dialog-wide">
        {/* 与其它弹窗同构：标题从 h2 起（弹窗是独立表面，WCAG 1.3.1），视觉统一走 ah-wizard-head。 */}
        <header className="ah-wizard-head">
          <h2>教 {props.botName} 技能</h2>
        </header>
        <p className="ah-right-kv">选择一个近期会话，系统将读取记录生成技能。生成后会在线程中复述步骤，供核对。</p>
        <input className="ah-teach-search" aria-label="搜索会话标题" placeholder="搜索会话标题" value={query} onChange={e => setQuery(e.target.value)} />
        <ul className="ah-teach-list">
          {filtered.length === 0 ? <li className="ah-empty">暂无匹配会话。请先在 DSH 中完成一次会话。</li> : null}
          {filtered.slice(0, 12).map(s => (
            <li key={s.sessionId}>
              <label className={picked === s.sessionId ? 'ah-teach-picked' : ''}>
                <input type="radio" name="ah-teach-session" checked={picked === s.sessionId} onChange={() => setPicked(s.sessionId)} />
                <span className="ah-teach-title">{s.title}</span>
                <span className="ah-right-kv">{s.updatedText}</span>
              </label>
            </li>
          ))}
        </ul>
        <textarea className="ah-teach-note" aria-label="学习说明" rows={2} value={note} onChange={e => setNote(e.target.value)} placeholder="说明：生成什么技能" />
        {error ? <p className="ah-settings-error" role="alert">{error}</p> : null}
        <div className="ah-dialog-actions">
          <button type="button" className="ah-btn" onClick={props.onClose} disabled={busy}>取消</button>
          <button type="button" className="ah-btn ah-btn-primary" disabled={busy || picked === ''} onClick={() => void teach()}>
            {busy ? '提交中…' : '教它技能'}
          </button>
        </div>
      </div>
    </div>
  )
}

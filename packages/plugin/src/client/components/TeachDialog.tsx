/**
 * 「教它一招」弹窗：列出 recentSessions（标题、更新时间，可搜索），选一个 + 一句说明
 * → teach 命令 → 线程里出现中心消息「已把会话 {标题} 交给 {名字} 学习」。
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { RecentSessionView } from '../../shared/views.js'

export function TeachDialog(props: {
  botName: string
  sessions: readonly RecentSessionView[]
  onTeach: (sessionId: string, note: string) => Promise<string | null>   // 返回错误文案或 null
  onClose: () => void
}): ReactNode {
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<string>('')
  const [note, setNote] = useState('把我刚才在这个会话里做的事学成套路')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

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
    <div className="ah-dialog-mask" role="dialog" aria-label={`教 ${props.botName} 一招`}>
      <div className="ah-dialog ah-dialog-wide">
        <h3>教 {props.botName} 一招</h3>
        <p className="ah-right-kv">选一个你最近做过的会话，它会读记录写成套路，以后照做；学完会在线程里复述步骤请你纠正。</p>
        <input className="ah-teach-search" placeholder="搜索会话标题" value={query} onChange={e => setQuery(e.target.value)} />
        <ul className="ah-teach-list">
          {filtered.length === 0 ? <li className="ah-empty">没有找到会话。先在 DSH 里做一遍，再回来教它。</li> : null}
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
        <textarea className="ah-teach-note" rows={2} value={note} onChange={e => setNote(e.target.value)} placeholder="一句说明：把它学成什么套路" />
        {error ? <p className="ah-settings-error" role="alert">{error}</p> : null}
        <div className="ah-dialog-actions">
          <button type="button" className="ah-btn" onClick={props.onClose} disabled={busy}>取消</button>
          <button type="button" className="ah-btn ah-btn-primary" disabled={busy || picked === ''} onClick={() => void teach()}>
            {busy ? '提交中…' : '交给它学'}
          </button>
        </div>
      </div>
    </div>
  )
}

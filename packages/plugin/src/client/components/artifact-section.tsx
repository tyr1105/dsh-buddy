/** 右栏产物按固定版本查看、引用与验收；正文只作为 pre 文本渲染，不能执行 HTML 或脚本。 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { ArtifactListView, ArtifactVersion, ArtifactReview, CommandResult } from '../../shared/views.js'
import { artifactFocusVersion } from '../logic/office.js'
import { Section } from './right-section.js'

const verdictLabels = { passed: '通过', not_done: '没做', incorrect: '做错', mismatch: '不符预期' } as const

export function ArtifactSection(props: {
  artifacts?: ArtifactListView
  run: (name: string, input: Record<string, unknown>) => Promise<CommandResult>
  onRefresh: () => void
  /** 从办公室桌子下钻时指定要展开的产物头（F08）；自动选中并读取最新一版。 */
  focusArtifactId?: string | null
}): ReactNode {
  const rows = props.artifacts?.versions ?? []
  const [selected, setSelected] = useState('')
  const [version, setVersion] = useState<ArtifactVersion | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [review, setReview] = useState<ArtifactReview | null>(null)
  const [note, setNote] = useState('')
  const [notice, setNotice] = useState('')
  const request = useRef(0)
  const lock = useRef(false)
  /** 已自动处理过的下钻目标（F08）：同一产物只自动加载一次，之后不覆盖主人的手动选择。 */
  const focused = useRef('')
  useEffect(() => () => { request.current += 1 }, [])
  useEffect(() => {
    // 授权撤销或版本过期后索引不再含所选版本，立即撤掉已缓存正文与引用。
    if (!selected || rows.some(row => row.id === selected)) return
    request.current += 1
    setSelected(''); setVersion(null); setReview(null); setNote(''); setError(''); setLoading(false)
  }, [rows, selected])
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => { try { setNotice('') } catch { /* 提示异常不影响宿主。 */ } }, 2200)
    return () => clearTimeout(timer)
  }, [notice])

  /** 切版本立刻清旧正文；请求乱序或队友切换时不能把旧响应显示成新版本。 */
  async function load(id: string): Promise<void> {
    const generation = ++request.current
    setSelected(id); setVersion(null); setReview(null); setNote(''); setNotice(''); setError(''); setLoading(true)
    try {
      const result = await props.run('readArtifactVersion', { versionId: id })
      if (generation !== request.current) return
      if (!result.ok) throw new Error(result.error)
      const data = result.data as ArtifactVersion | undefined
      if (!data || data.id !== id || typeof data.content !== 'string') throw new Error('版本读取失败。点击「重试」。')
      setVersion(data); setReview(rows.find(row => row.id === id)?.review ?? null)
    } catch (cause) {
      if (generation === request.current) setError(cause instanceof Error ? cause.message : '版本读取失败。点击「重试」。')
    } finally { if (generation === request.current) setLoading(false) }
  }
  /** 只验收当前已读取的版本；保存失败保留版本和说明，允许原位重试。 */
  async function decide(verdict: ArtifactReview['verdict']): Promise<void> {
    if (!version || lock.current) return
    lock.current = true; setBusy(true); setError('')
    try {
      const result = await props.run('reviewArtifact', { versionId: version.id, verdict, note })
      if (!result.ok) throw new Error(result.error)
      setReview(result.data as ArtifactReview); setNotice(`已记录 v${version.number}：${verdictLabels[verdict]}`)
      props.onRefresh()
    } catch (cause) { setError(cause instanceof Error ? cause.message : '验收保存失败。点击「重试」。') }
    finally { lock.current = false; setBusy(false) }
  }
  // 从办公室桌上点进来（F08）：等产物列表里真的出现这个产物头再选中最新一版，
  // 避免列表还没到时把下钻目标「消费」掉；同一个目标只自动加载一次。
  useEffect(() => {
    const focus = props.focusArtifactId
    if (!focus || focused.current === focus) return
    const target = artifactFocusVersion(rows, focus)
    if (target === null) return
    focused.current = focus
    if (target.id !== selected) void load(target.id)
  }, [props.focusArtifactId, rows, selected])

  const titles = new Map(rows.map(row => [row.artifactId, row.title]))
  const focusTarget = props.focusArtifactId ? artifactFocusVersion(rows, props.focusArtifactId) : null
  return <Section title="产物" chip={titles.size ? `${titles.size} 份` : undefined} open={focusTarget !== null ? true : undefined}>
    {!rows.length ? <p className="ah-empty">暂无产物版本。交账引用工作或共享目录文本后，保留完整版本。</p> : null}
    {[...titles.entries()].map(([id, title]) => <div className="ah-artifact-row" key={id}>
      <strong>{title}</strong>
      <label>查看版本
        <select aria-label={`${title} 的版本`} disabled={busy} value={rows.some(row => row.artifactId === id && row.id === selected) ? selected : ''}
          onChange={e => { if (e.target.value) void load(e.target.value) }}>
          <option value="">选择版本</option>
          {rows.filter(row => row.artifactId === id).map(row => <option value={row.id} key={row.id}>v{row.number} · {row.review ? verdictLabels[row.review.verdict] : '未验收'} · {row.bytes} 字节</option>)}
        </select>
      </label>
    </div>)}
    {loading ? <p role="status">正在读取完整版本…</p> : null}
    {version ? <div className="ah-artifact-detail">
      <p>v{version.number} · {version.bytes} 字节 · {review ? verdictLabels[review.verdict] : '未验收'}</p>
      <label>固定引用<input aria-label="固定产物引用" readOnly value={`artifact:${version.id}`} onFocus={e => e.currentTarget.select()} /></label>
      <p className="ah-right-kv">引用只指向这一版，原文件修改后仍可查看。</p>
      <pre className="ah-artifact-text" tabIndex={0} aria-label="完整产物正文">{version.content}</pre>
      <label>验收说明<textarea rows={2} maxLength={1000} disabled={busy} value={note} onChange={e => setNote(e.target.value)} /></label>
      <div className="ah-artifact-actions">{Object.entries(verdictLabels).map(([key, label]) =>
        <button type="button" className="ah-btn" disabled={busy} key={key} onClick={() => void decide(key as ArtifactReview['verdict'])}>{label}</button>)}</div>
      <p className="ah-right-kv">验收只记录这一版的结论；目标仍在目标区验收。</p>
    </div> : null}
    {error ? <div className="ah-card-error" role="alert">{error}
      {!version && selected ? <button type="button" className="ah-btn" disabled={loading} onClick={() => void load(selected)}>重试</button> : null}</div> : null}
    {notice ? <div className="ah-save-toast" role="status">{notice}</div> : null}
    {props.artifacts?.unarchived.map((item, index) => <p className="ah-right-kv" key={index}>未归档：{item.where || '剩余位置'} · {item.detail}</p>)}
  </Section>
}

/**
 * 「关于你的记忆」一页里的一条（P75k，设计稿场景 E）。
 *
 * 一条依次显示：正文；出处一行；「你说：……」一行（有时）；范围一行（有时）；「被引用 n 次」（有时）；
 * 最近一次更正的「原为「……」。」（有时）；操作。这些文字全部来自 core 的 MemoryEntryView，界面原样显示。
 * 操作：
 * - 「更正」：正文变成输入框，下面是「保存」「取消」和提示。只在点「保存」时提交；失去焦点、按 Tab、按 Enter 都不提交；
 *   内容为空或超过上限时「保存」不可点，并写明原因。按 Esc 等同「取消」。保存或取消后焦点回到「更正」按钮。
 * - 「删除」：直接删除，不弹确认（页面顶部会出现「已删除」一行，24 小时内可撤销）。
 * - 固定规则：不显示操作，显示 core 给的「不能更正或删除」（出处一行已写「产品固定规则」）。
 * - 项目背景与项目页决策：显示「在项目页里修改」与「去项目页」。
 * 处理中按钮置灰防重复点击；失败在这一条里显示原因，按钮复位，输入框内容保留。
 * 从约定卡的出处点过来时，这一条带 ah-memory-entry-focus 样式（边框，2 秒后消失），焦点移到这一条（由页面层控制）。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { MemoryEntryView } from '../../shared/views.js'
import { stripFailureKey } from '../logic/failure-text.js'
import { MEM_TEXT, editProblemOf, entryActionsOf, fill, memoryCorrectDomId, memoryEntryDomId, memoryFocusHintDomId } from '../logic/memory.js'

/** 一条的三个命令；返回错误文字（失败）或 null（成功）。 */
export interface MemoryEntryCommands {
  correct: (memoryId: string, text: string) => Promise<string | null>
  remove: (memoryId: string) => Promise<string | null>
  openProject: (projectId: string) => void
}

export function MemoryEntry(props: { entry: MemoryEntryView; commands: MemoryEntryCommands; focused: boolean }): ReactNode {
  const { entry } = props
  const actions = entryActionsOf(entry)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(entry.text)
  const [busy, setBusy] = useState<'save' | 'delete' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const correctButtonRef = useRef<HTMLButtonElement | null>(null)
  /** 刚从编辑态退出：下一次渲染后把焦点还给「更正」按钮（键盘用户不用重新找）。 */
  const restoreFocus = useRef(false)
  const problem = editProblemOf(draft)

  useEffect(() => {
    try {
      if (editing) { inputRef.current?.focus(); inputRef.current?.select() }
      else if (restoreFocus.current) { restoreFocus.current = false; correctButtonRef.current?.focus() }
    } catch { /* 聚焦失败不影响编辑 */ }
  }, [editing])

  const startEdit = (): void => { setDraft(entry.text); setError(null); setEditing(true) }
  const cancelEdit = (): void => { restoreFocus.current = true; setEditing(false); setError(null) }

  /** 只在点「保存」时提交；成功后退出编辑态，条目文字由页面重取后更新。 */
  const save = (): void => {
    if (busy !== null || problem !== null || entry.memoryId === null) return
    setBusy('save')
    setError(null)
    props.commands.correct(entry.memoryId, draft.trim())
      .then(failure => { if (failure === null) { restoreFocus.current = true; setEditing(false) } else setError(stripFailureKey(failure)) })
      .catch(e => setError(e instanceof Error ? e.message : String(e) || MEM_TEXT.failed))
      .finally(() => setBusy(null))
  }

  const remove = (): void => {
    if (busy !== null || entry.memoryId === null) return
    setBusy('delete')
    setError(null)
    props.commands.remove(entry.memoryId)
      .then(failure => { if (failure !== null) setError(stripFailureKey(failure)) })
      .catch(e => setError(e instanceof Error ? e.message : String(e) || MEM_TEXT.failed))
      .finally(() => setBusy(null))
  }

  const domId = entry.memoryId !== null ? memoryEntryDomId(entry.memoryId) : undefined
  const projectLink = entry.link
  /** 定位说明的元素编号：只在这一条被定位（高亮）时存在。 */
  const hintId = props.focused && entry.memoryId !== null ? memoryFocusHintDomId(entry.memoryId) : undefined
  return (
    <li className={`ah-memory-entry${props.focused ? ' ah-memory-entry-focus' : ''}`} id={domId} tabIndex={domId === undefined ? undefined : -1}
      data-memory-entry={entry.memoryId ?? 'fixed'} aria-describedby={hintId}>
      {/* P75r7（B3）：定位到这一条时，读屏先读这一条自己的名称（正文），再读这段补充说明；2 秒后边框撤掉，说明一起去掉。 */}
      {hintId !== undefined ? <span id={hintId} className="ah-visually-hidden">{MEM_TEXT.focusedHint}</span> : null}
      {editing ? (
        <div className="ah-memory-edit">
          <input ref={inputRef} className="ah-memory-edit-input" aria-label={MEM_TEXT.editLabel} value={draft} disabled={busy !== null}
            onChange={event => setDraft(event.target.value)}
            onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelEdit() } }} />
          {problem !== null ? <p className="ah-memory-edit-problem" role="status">{problem}</p> : null}
          <p className="ah-memory-sub">{MEM_TEXT.saveHint}</p>
          <div className="ah-memory-actions">
            <button type="button" className="ah-btn ah-btn-primary" disabled={problem !== null || busy !== null} onClick={save}>
              {busy === 'save' ? MEM_TEXT.saving : MEM_TEXT.save}
            </button>
            <button type="button" className="ah-btn" disabled={busy !== null} onClick={cancelEdit}>{MEM_TEXT.cancel}</button>
          </div>
        </div>
      ) : (
        <p className="ah-memory-text">{entry.text}</p>
      )}
      <p className="ah-memory-sub ah-memory-source">{entry.sourceLine}</p>
      {entry.quoteLine !== null ? <p className="ah-memory-sub">{entry.quoteLine}</p> : null}
      {entry.scopeLine !== null || entry.citedText !== null ? (
        <p className="ah-memory-sub">
          {entry.scopeLine}
          {entry.scopeLine !== null && entry.citedText !== null ? '　' : ''}
          {entry.citedText}
        </p>
      ) : null}
      {entry.historyNote !== null ? <p className="ah-memory-sub ah-memory-history">{entry.historyNote}</p> : null}
      {!editing ? (
        <div className="ah-memory-actions">
          {actions.correct ? (
            <button type="button" className="ah-btn ah-btn-ghost" ref={correctButtonRef} id={entry.memoryId !== null ? memoryCorrectDomId(entry.memoryId) : undefined} disabled={busy !== null}
              aria-label={fill(MEM_TEXT.correctLabel, entry.text)} onClick={startEdit}>{MEM_TEXT.correct}</button>
          ) : null}
          {actions.remove ? (
            <button type="button" className="ah-btn ah-btn-ghost" disabled={busy !== null}
              aria-label={fill(MEM_TEXT.removeLabel, entry.text)} onClick={remove}>{busy === 'delete' ? MEM_TEXT.removing : MEM_TEXT.remove}</button>
          ) : null}
          {entry.readonlyNote !== null ? <span className="ah-memory-sub ah-memory-readonly">{entry.readonlyNote}</span>
            : projectLink !== null ? <span className="ah-memory-sub ah-memory-readonly">{MEM_TEXT.editInProject}</span> : null}
          {projectLink !== null ? (
            <button type="button" className="ah-btn ah-btn-ghost" aria-label={fill(MEM_TEXT.openProjectLabel, entry.text)}
              onClick={() => props.commands.openProject(projectLink.projectId)}>{MEM_TEXT.openProject}</button>
          ) : null}
        </div>
      ) : null}
      {error !== null ? <p className="ah-card-error" role="alert">{error}</p> : null}
    </li>
  )
}

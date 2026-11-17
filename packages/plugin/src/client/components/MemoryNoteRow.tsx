/**
 * 总管回复下面的「已记住」「已删除」「已更正」一行与「撤销」（P75k，设计稿场景 D）。
 *
 * 为什么是一行而不是一条新消息：同一条记忆的状态会变（撤销、删除、更正），一行挂在总管那条回复下面，
 * 状态变了就在原处改字（「已撤销」仍留在原处），不回头改历史消息（core 的视图生成，见 api/memory-views.ts）。
 * 行里的文字全部来自 core 的 MemoryNoteView：正文、「你说：……」一行、适用范围一行都原样显示，界面不自己拼；
 * 界面只决定小标（见 logic/memory.ts 的 noteLabelOf）和「撤销」按钮要不要出现。
 * 点「撤销」不弹确认（主人可以再说一遍恢复）；处理中按钮置灰防重复点击；失败在这一行旁显示原因，按钮复位。
 * 总管私聊与主题线程两处共用这个组件，缩进与消息正文对齐（样式在 workspace.css 的 ah-memory-notes）。
 */
import { useRef, useState, type ReactNode } from 'react'
import type { MemoryNoteView } from '../../shared/views.js'
import { stripFailureKey } from '../logic/failure-text.js'
import { MEM_TEXT, fill, noteKindText, noteLabelOf, noteShowsUndo } from '../logic/memory.js'

/** 点「撤销」：返回错误文字（失败）或 null（成功），规则与卡片作答相同。 */
export type UndoMemory = (note: MemoryNoteView) => Promise<string | null>

/** 一行。 */
export function MemoryNoteRow(props: { note: MemoryNoteView; onUndo?: UndoMemory }): ReactNode {
  const { note } = props
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const kind = noteKindText(note)
  const undone = note.state === 'undone'
  /**
   * P75r7（B2）：这一行自己能接收焦点（tabIndex 为 -1，只能用代码聚焦）。撤销成功后「撤销」按钮随之消失，
   * 焦点留在这一行上，键盘和读屏用户不会被甩到页面最外层。
   */
  const rowRef = useRef<HTMLDivElement | null>(null)

  /** 点「撤销」：先置灰，成功后由上层刷新视图（这一行随之改成「已撤销」）并把焦点留在这一行；失败复位并显示原因，焦点留在按钮上。 */
  const undo = (): void => {
    if (busy || props.onUndo === undefined) return
    setBusy(true)
    setError(null)
    props.onUndo(note)
      .then(failure => {
        if (failure !== null) { setError(stripFailureKey(failure)); return }
        try { rowRef.current?.focus() } catch { /* 聚焦失败不影响撤销结果 */ }
      })
      .catch(e => setError(e instanceof Error ? e.message : String(e) || MEM_TEXT.failed))
      .finally(() => setBusy(false))
  }

  return (
    <div className={`ah-memory-note${undone ? ' ah-memory-note-undone' : ''}`} data-memory-note={note.action} data-memory-state={note.state}
      ref={rowRef} tabIndex={-1}>
      <p className="ah-memory-note-line">
        <span className="ah-memory-note-label">{noteLabelOf(note)}</span>
        {kind !== null ? <span className="ah-memory-note-kind">{kind}</span> : null}
        <span className="ah-memory-note-text">{note.text}</span>
        {noteShowsUndo(note) && props.onUndo !== undefined ? (
          <button type="button" className="ah-btn ah-btn-ghost ah-memory-undo" disabled={busy}
            aria-label={fill(MEM_TEXT.undoLabel, note.text)} onClick={undo}>{busy ? MEM_TEXT.undoing : MEM_TEXT.undo}</button>
        ) : null}
      </p>
      {/* 主人当场核对用：这一条是不是自己说的那件事、范围有没有被放大（文字由 core 生成，已撤销的行不再显示）。 */}
      {!undone && note.quoteLine !== null ? <p className="ah-memory-note-sub">{note.quoteLine}</p> : null}
      {!undone && note.scopeLine !== null ? <p className="ah-memory-note-sub">{note.scopeLine}</p> : null}
      {error !== null ? <p className="ah-card-error" role="alert">{error}</p> : null}
    </div>
  )
}

/** 一条消息下面的全部行（没有行时返回 null，不占位置）。 */
export function MemoryNotes(props: { notes: readonly MemoryNoteView[] | undefined; onUndo?: UndoMemory }): ReactNode {
  const notes = props.notes
  if (notes === undefined || notes.length === 0) return null
  return (
    <div className="ah-memory-notes">
      {notes.map((note, index) => <MemoryNoteRow key={`${note.memoryId}-${note.action}-${index}`} note={note} onUndo={props.onUndo} />)}
    </div>
  )
}

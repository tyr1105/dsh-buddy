/**
 * 「关于你的记忆」一页（P75k，设计稿场景 E）：系统记住的关于主人的一切，一页看全。
 *
 * 页面结构：标题与说明一句（core 给）；类型筛选（全部、偏好、规矩、决定和先例、项目背景，带数量）；
 * 顶部「已删除」一行（24 小时内删掉的，带「撤销」）；按组列出每一条（见 MemoryEntry）。
 * 数据全部来自 core 的记忆页视图，直接读存下来的原文，不调用模型；文字界面原样显示，不自己拼。
 * 两处入口：左栏员工列表底部、总管右侧栏「状态」之后一行，都打开这同一页。
 *
 * 从约定卡的出处跳来时（focusMemoryId 不为空）：页面加载出那一条后，切到「全部」、滚到那一条、给它加边框高亮 2 秒、
 * 焦点移到那一条；滚动不用平滑动画（减少动态效果时本来就不动），高亮只是边框，动画样式由 CSS 在
 * prefers-reduced-motion: no-preference 下才加。定位只做一次（做完通知上层清掉定位请求），之后刷新不会再拽主人回来。
 * 视图读不到时在页内给原因和「重试」，不整页报错。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { MemoryPageView, MemoryTabKey } from '../../shared/views.js'
import { MemoryEntry, type MemoryEntryCommands } from '../components/MemoryEntry.js'
import { RetryBox, Skeleton, EmptyHint } from '../components/Ui.js'
import { stripFailureKey } from '../logic/failure-text.js'
import { MEM_TEXT, fill, groupsForTab, hasMemoryEntry, memoryCorrectDomId, memoryDeletedUndoDomId, memoryEntryDomId } from '../logic/memory.js'

/** 高亮持续多久（毫秒）。 */
const FOCUS_HIGHLIGHT_MS = 2000

/**
 * P75r7（B2）：命令成功之后焦点要去的地方。
 * - deletedUndo：删除成功，条目已从列表消失，焦点移到顶部新出现的那条「已删除」行的「撤销」按钮；
 * - restoredCorrect：撤销删除成功，焦点移到恢复的那一条的「更正」按钮。
 * 操作失败时不设这个请求，焦点留在原来的按钮上。
 */
type FocusRequest = { kind: 'deletedUndo' | 'restoredCorrect'; memoryId: string }

/** 已删除一行：core 给的「已删除「……」。」加「撤销」。 */
export function DeletedRow(props: { row: MemoryPageView['deleted'][number]; onUndo: (memoryId: string) => Promise<string | null> }): ReactNode {
  const { row } = props
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const undo = (): void => {
    if (busy) return
    setBusy(true)
    setError(null)
    props.onUndo(row.memoryId)
      .then(failure => { if (failure !== null) setError(stripFailureKey(failure)) })
      .catch(e => setError(e instanceof Error ? e.message : String(e) || MEM_TEXT.failed))
      .finally(() => setBusy(false))
  }
  return (
    <li className="ah-memory-deleted-row">
      <span>{row.text}</span>
      {row.canUndo ? (
        <button type="button" id={memoryDeletedUndoDomId(row.memoryId)} className="ah-btn ah-btn-ghost" disabled={busy}
          aria-label={fill(MEM_TEXT.undoLabel, row.text)} onClick={undo}>
          {busy ? MEM_TEXT.undoing : MEM_TEXT.undo}
        </button>
      ) : null}
      {error !== null ? <p className="ah-card-error" role="alert">{error}</p> : null}
    </li>
  )
}

export function MemoryPage(props: {
  page: MemoryPageView | null
  /** 视图读不到的原因（没有旧数据时显示一句原因和「重试」）。 */
  error: string | null
  onRetry: () => void
  /** 从约定卡的出处跳来时要定位的那一条记忆；null 表示普通进入。 */
  focusMemoryId: string | null
  /** 定位做完（或找不到这一条）后通知上层清掉定位请求。 */
  onFocusDone: () => void
  commands: MemoryEntryCommands & { undoDelete: (memoryId: string) => Promise<string | null> }
}): ReactNode {
  const [tab, setTab] = useState<MemoryTabKey>('all')
  /** 当前高亮的那一条（2 秒后清空）。 */
  const [highlightId, setHighlightId] = useState<string | null>(null)
  /** P75r7（B4）：从约定卡点过来但那一条已删除或已被取代时，页顶显示一行说明；下一次定位成功或切换筛选时消失。 */
  const [missing, setMissing] = useState(false)
  /** P75r7（B2）：删除、撤销删除成功之后焦点要去的地方（只试一次）。 */
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null)
  const rootRef = useRef<HTMLElement | null>(null)
  const { page } = props

  // 删除、撤销删除成功之后移动焦点。命令成功时页面数据已经重取完（上层先重取再交回结果），
  // 所以这一轮渲染里目标按钮已经在页面上；找不到（例如当前筛选把恢复的那一条藏起来了）就不动，不抛错。
  useEffect(() => {
    if (focusRequest === null) return
    setFocusRequest(null)
    try {
      const id = focusRequest.kind === 'deletedUndo' ? memoryDeletedUndoDomId(focusRequest.memoryId) : memoryCorrectDomId(focusRequest.memoryId)
      document.getElementById(id)?.focus()
    } catch { /* 聚焦失败不影响操作结果 */ }
  }, [focusRequest, page])

  // 定位：页面加载出那一条后做一次。找不到这一条（已被删除、已被取代）就在页顶写一句说明、不报错、不留着请求。
  useEffect(() => {
    const id = props.focusMemoryId
    if (id === null || page === null) return
    if (!hasMemoryEntry(page, id)) { setMissing(true); props.onFocusDone(); return }
    setMissing(false)
    setTab('all')
    // 切到「全部」后元素才一定在页面上：等这一轮渲染完成再找。
    const frame = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (run: () => void) => { run(); return 0 }
    frame(() => {
      try {
        const element = document.getElementById(memoryEntryDomId(id))
        if (element !== null) {
          // 滚动不用平滑动画：减少动态效果时不该动，其余时候瞬间到位也不影响看清。
          element.scrollIntoView({ block: 'center' })
          element.focus({ preventScroll: true })
        }
      } catch { /* 定位失败只是停在原位置，不影响阅读 */ }
      setHighlightId(id)
      props.onFocusDone()
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在定位请求或页面数据变化时做；回调是稳定的上层函数
  }, [props.focusMemoryId, page])

  // 高亮 2 秒后撤掉。
  useEffect(() => {
    if (highlightId === null) return
    const timer = setTimeout(() => setHighlightId(null), FOCUS_HIGHLIGHT_MS)
    return () => clearTimeout(timer)
  }, [highlightId])

  if (page === null) {
    return (
      <section className="ah-memory-page" aria-label={MEM_TEXT.entry} ref={rootRef}>
        {props.error !== null
          ? <RetryBox message={fill(MEM_TEXT.pageLoadFailed, props.error)} onRetry={props.onRetry} />
          : <Skeleton rows={5} />}
      </section>
    )
  }
  const groups = groupsForTab(page, tab)
  // 删除、撤销删除成功时记下焦点去向（失败不记，焦点留在原来的按钮上）。
  const commands = {
    ...props.commands,
    remove: async (memoryId: string): Promise<string | null> => {
      const failure = await props.commands.remove(memoryId)
      if (failure === null) setFocusRequest({ kind: 'deletedUndo', memoryId })
      return failure
    },
    undoDelete: async (memoryId: string): Promise<string | null> => {
      const failure = await props.commands.undoDelete(memoryId)
      if (failure === null) setFocusRequest({ kind: 'restoredCorrect', memoryId })
      return failure
    },
  }
  return (
    <section className="ah-memory-page" aria-label={page.title} ref={rootRef}>
      <header className="ah-pane-heading"><h2>{page.title}</h2><p>{page.intro}</p></header>
      {/* 定位目标找不到时的一行说明：容器一直在，文字出现时读屏会播报。 */}
      <div role="status" className="ah-memory-missing">{missing ? <p className="ah-memory-sub">{MEM_TEXT.entryMissing}</p> : null}</div>
      <div className="ah-memory-tabs" role="group" aria-label={MEM_TEXT.tabsLabel}>
        {page.tabs.map(item => (
          <button key={item.key} type="button" className={`ah-btn${tab === item.key ? ' ah-btn-primary' : ' ah-btn-ghost'}`}
            aria-pressed={tab === item.key} onClick={() => { setMissing(false); setTab(item.key) }}>{item.label}　{item.count}</button>
        ))}
      </div>
      {/* 「已删除」列表的容器一直在页面上，里面多出一行时读屏播报（aria-live）。 */}
      <div className="ah-memory-deleted-live" aria-live="polite">
        {page.deleted.length > 0 ? (
          <ul className="ah-memory-deleted" aria-label={MEM_TEXT.deletedListLabel}>
            {page.deleted.map(row => <DeletedRow key={row.memoryId} row={row} onUndo={commands.undoDelete} />)}
          </ul>
        ) : null}
      </div>
      {groups.length === 0 ? (
        <EmptyHint text={page.total === 0 ? MEM_TEXT.emptyAll : MEM_TEXT.emptyTab} />
      ) : groups.map(group => (
        <section key={group.key} className="ah-memory-group" aria-label={group.label}>
          <h3>{group.label}</h3>
          <ul className="ah-memory-list">
            {group.entries.map((entry, index) => (
              <MemoryEntry key={entry.memoryId ?? `${group.key}-${index}`} entry={entry} commands={commands}
                focused={entry.memoryId !== null && entry.memoryId === highlightId} />
            ))}
          </ul>
        </section>
      ))}
    </section>
  )
}

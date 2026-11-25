/**
 * 文件预览侧栏（W12 第三轮验收后改）：挂在页面最右边，和 DSH 自带的文件预览侧栏同一个样子——
 * 38 像素高的标题行（文件类型图标、文件名、在访达中显示、关闭），下面是可以滚动的正文；
 * md 用 DSH 自带的 Markdown 渲染器显示，其余文本按原样显示。卡片留在左边看得见，可以边看边核对。
 *
 * - 默认宽度占页面 45%（DSH 右侧栏的默认比例），左边缘可以拖动或用方向键调宽窄，夹在 320 像素和 70% 之间；
 * - 页面很窄时铺满整页（同 DSH 窄窗口时的做法）；
 * - Esc 或右上角关闭；关闭后焦点回到原来点的文件名（由文件小条负责）。
 * 取不到 DSH 的零件（旧版 DSH、测试环境）时退回我们自己的文字按钮和纯文本显示。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { api } from '../api.js'
import { useStore } from '../store.js'
import { JOB_TEXT } from '../logic/job.js'
import { dshPrimitives } from '../logic/dsh-primitives.js'
import { PREVIEW_DEFAULT_RATIO, clampPreviewWidth, closeFilePreview, filePreviewStore, type FilePreviewRef, type FilePreviewState } from '../logic/file-preview.js'

/** Markdown 渲染器里代码块、脚注的按钮文字。 */
const MD_LABELS = { code: { copyLabel: '复制', copiedLabel: '已复制' }, footnotes: '脚注' }

/** 主人拖过的宽度：同一次页面里记住，下次打开沿用。 */
let rememberedWidth: number | null = null

/** 在访达中显示的函数形状，测试里注入假实现。 */
export type PreviewRevealer = (input: FilePreviewRef & { action: 'reveal' }) => Promise<{ ok: boolean; error?: string }>

/** 挂在 .ah-body 最后的侧栏；没有预览时什么都不画。 */
export function FilePreviewPane(props: { reveal?: PreviewRevealer }): ReactNode {
  const state = useStore(filePreviewStore)
  if (state === null) return null
  return <FilePreviewBody state={state} reveal={props.reveal ?? (input => api.openJobEvidence(input))} />
}

/** 正文：标题行加滚动区。单独成组件，方便测试直接渲染某个状态。 */
export function FilePreviewBody(props: { state: FilePreviewState; reveal: PreviewRevealer }): ReactNode {
  const { state } = props
  const prims = dshPrimitives()
  const asideRef = useRef<HTMLElement | null>(null)
  const [width, setWidth] = useState<number | null>(rememberedWidth)
  const [revealError, setRevealError] = useState<string | null>(null)
  const [revealing, setRevealing] = useState(false)
  const refKey = `${state.ref.jobId}/${state.ref.submissionId}/${state.ref.evidenceId}`

  // 换了文件：清掉上一个文件的「显示位置」错误。
  useEffect(() => { setRevealError(null) }, [refKey])

  const containerWidth = (): number => {
    try { return asideRef.current?.parentElement?.getBoundingClientRect().width ?? 0 } catch { return 0 }
  }
  const applyWidth = (next: number): void => {
    const total = containerWidth()
    if (total <= 0) return
    const clamped = clampPreviewWidth(next, total)
    rememberedWidth = clamped
    setWidth(clamped)
  }

  // 拖动左边缘：按指针离页面右边的距离算宽度。
  const startDrag = (event: { clientX: number; preventDefault(): void }): void => {
    event.preventDefault()
    let right = 0
    try { right = asideRef.current?.parentElement?.getBoundingClientRect().right ?? 0 } catch { right = 0 }
    if (right <= 0) return
    const move = (e: PointerEvent): void => { applyWidth(right - e.clientX) }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      try { document.body.style.removeProperty('cursor') } catch { /* 无所谓 */ }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    try { document.body.style.cursor = 'col-resize' } catch { /* 无所谓 */ }
  }
  const resizeKey = (event: { key: string; preventDefault(): void }): void => {
    const current = width ?? Math.round(containerWidth() * PREVIEW_DEFAULT_RATIO)
    if (event.key === 'ArrowLeft') { event.preventDefault(); applyWidth(current + 24) }
    if (event.key === 'ArrowRight') { event.preventDefault(); applyWidth(current - 24) }
  }

  const reveal = (): void => {
    if (revealing) return
    setRevealing(true)
    setRevealError(null)
    void props.reveal({ ...state.ref, action: 'reveal' })
      .then(result => { setRevealing(false); if (!result.ok) setRevealError(result.error ?? '没能在访达中显示') })
      .catch((error: unknown) => { setRevealing(false); setRevealError(error instanceof Error ? error.message : String(error)) })
  }

  const keyDown = (event: { key: string; stopPropagation?: () => void }): void => {
    if (event.key !== 'Escape') return
    try { event.stopPropagation?.() } catch { /* 替身没有也不影响 */ }
    closeFilePreview()
  }

  const MarkdownText = prims?.MarkdownText ?? null
  const FileTypeIcon = prims?.FileTypeIcon ?? null
  const IconClose = prims?.IconClose ?? null
  const IconFolderOpen = prims?.IconFolderOpen ?? null
  const revealText = JOB_TEXT.fileReveal

  let body: ReactNode
  if (state.status === 'loading') body = <p className="ah-fp-status">{JOB_TEXT.fileOpening}</p>
  else if (state.status === 'error') body = <p className="ah-fp-status" role="alert">{state.error}</p>
  else if (state.format === 'markdown' && MarkdownText !== null) body = <div className="ah-fp-doc"><MarkdownText text={state.text} labels={MD_LABELS} variant="body" /></div>
  else body = <pre className="ah-fp-pre">{state.text}</pre>

  return (
    <aside ref={asideRef} className="ah-fp" aria-label={`文件预览：${state.name}`} onKeyDown={keyDown}
      style={width !== null ? { width: `${width}px` } : undefined}>
      <div className="ah-fp-resize" role="separator" aria-orientation="vertical" aria-label="拖动调整预览宽度" tabIndex={0}
        onPointerDown={startDrag} onKeyDown={resizeKey} />
      <header className="ah-fp-head">
        {FileTypeIcon !== null ? <span className="ah-fp-icon" aria-hidden="true"><FileTypeIcon path={state.name} size={16} /></span> : null}
        <span className="ah-fp-name" title={state.name}>{state.name}</span>
        <button type="button" className="ah-fp-tool" title={revealText} aria-label={revealText} disabled={revealing} onClick={reveal}>
          {IconFolderOpen !== null ? <IconFolderOpen size={16} /> : <span className="ah-fp-tool-text">{revealText}</span>}
        </button>
        <button type="button" className="ah-fp-tool" title={JOB_TEXT.shotClose} aria-label={`${JOB_TEXT.shotClose}预览`} onClick={closeFilePreview}>
          {IconClose !== null ? <IconClose size={16} /> : <span className="ah-fp-tool-text">{JOB_TEXT.shotClose}</span>}
        </button>
      </header>
      {revealError !== null ? <p className="ah-fp-changed" role="alert">{revealError}</p> : null}
      <div className="ah-fp-scroll" key={refKey}>{body}</div>
    </aside>
  )
}

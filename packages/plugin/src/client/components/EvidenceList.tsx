/**
 * 证据清单（P74h，设计稿场景 C）：交回卡、核对卡（P74i 的交付卡也用它）共用的清单，
 * 每一行对应约定里「怎样算做完」的一条：左边序号，中间条目原文和证据，右边结论小章。
 * 不符的行整行浅警示底色；「改到什么程度算过」单独一块，避免和「问题」混在一起。
 *
 * 截图证据（kind 为 image）是缩略图：进入视口后才经命令 readJobEvidence 请求（P74g 接宿主），
 * 同一张图在同一次页面里只请求一次（logic/job.ts 的内存缓存）；读取中显示灰色占位框；
 * 点缩略图打开大图，Esc 关闭、焦点回到缩略图。宽屏截图（宽大于高）显示 150 像素宽。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { EvidenceItemView } from '../../shared/views.js'
import { JOB_TEXT, evidenceTag, loadShot, returnFocus, trapTabIn, verdictClass, type ShotEntry, type ShotReader } from '../logic/job.js'
import { api } from '../api.js'
import { dshPrimitives } from '../logic/dsh-primitives.js'

/**
 * 截图读取命令的定位参数：core 的卡片视图不带内部编号，由接线的一层补上
 * （消息的 refId 写着 submission:<id>；jobId 由宿主接线时给出，P74g 一并接好）。
 * 没有 shotRef 时（旧数据、还没接线），截图只显示占位框，不发起请求。
 */
export interface ShotRef { jobId: string; submissionId: string }

/** 截图缩略图：进入视口才请求；读取中占位；点开大图，Esc 关闭并还焦。 */
export function ShotThumb(props: {
  shotRef: ShotRef | null
  evidence: EvidenceItemView['evidence'][number]
  readShot?: ShotReader
}): ReactNode {
  const { evidence } = props
  const read = props.readShot ?? ((input: Parameters<ShotReader>[0]) => api.readJobEvidence(input))
  const [inView, setInView] = useState(false)
  const [entry, setEntry] = useState<ShotEntry | null>(null)
  const [wide, setWide] = useState(false)
  const [open, setOpen] = useState(false)
  /** 观察目标：外层的框（缩略图读取前后都在）；读取前的占位框不是按钮，没有 ref 可挂。 */
  const wrapRef = useRef<HTMLSpanElement | null>(null)
  /** 大图关闭后焦点回到缩略图（读取完成前是占位框，没有可聚焦的元素）。 */
  const thumbRef = useRef<HTMLButtonElement | null>(null)
  /** P74i：大图按模态弹窗处理——打开时焦点进入弹窗（弹窗本身可聚焦，Esc 关闭后焦点回到缩略图）。 */
  const dialogRef = useRef<HTMLDivElement | null>(null)
  /** P74i-m1（走查 D-11）：弹窗右上角的「关闭」按钮；焦点圈（Tab 循环）在弹窗与它之间转。 */
  const closeRef = useRef<HTMLButtonElement | null>(null)

  // 大图打开时把焦点放进弹窗：键盘与读屏都以弹窗为起点；失败不影响图片本身。
  useEffect(() => {
    if (open) { try { dialogRef.current?.focus?.() } catch { /* 聚焦失败不影响显示 */ } }
  }, [open])

  // 进入视口的判断：用浏览器的 IntersectionObserver；环境里没有（测试替身）就当作已经进入视口，
  // 宁可多请求一次，也不能让缩略图永远空着。任何一步出错都不影响清单其余部分。
  useEffect(() => {
    if (inView) return
    const element = wrapRef.current
    type ObserverCtor = new (callback: (records: Array<{ isIntersecting: boolean }>) => void, options?: { rootMargin?: string }) =>
      { observe(el: object): void; disconnect(): void }
    const Observer = (globalThis as { IntersectionObserver?: ObserverCtor }).IntersectionObserver
    if (element === null || Observer === undefined) { setInView(true); return }
    try {
      const observer = new Observer(records => {
        try { if (records.some(record => record.isIntersecting)) setInView(true) } catch { /* 回调出错按未进入视口处理 */ }
      }, { rootMargin: '200px' })
      observer.observe(element)
      return () => { try { observer.disconnect() } catch { /* 清理失败不影响界面 */ } }
    } catch { setInView(true); return }
  }, [inView])

  // 进入视口后请求一次；结果留在组件状态里，缓存保证同一张图不再请求。
  // 没有 shotRef（旧数据、命令还没接线）时不请求：占位框比一次注定失败的请求更安静。
  useEffect(() => {
    if (!inView || entry !== null || props.shotRef === null) return
    let alive = true
    void loadShot(read, { ...props.shotRef, evidenceId: evidence.id })
      .then(loaded => { if (alive) setEntry(loaded) })
      .catch(() => { if (alive) setEntry({ state: 'error', error: '没有读到截图。' }) })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 读取函数来自 props 或 api，结果只按证据 id 缓存一次
  }, [inView, entry === null, evidence.id, props.shotRef])

  // 大图：Esc、点遮罩空白处、「关闭」按钮都关闭，并把焦点还给缩略图。
  const close = (): void => {
    setOpen(false)
    returnFocus(thumbRef.current)
  }

  /**
   * P74i-m1（走查 D-11）：大图浮在页面之上——固定定位的全屏遮罩弹窗，不再在缩略图原位插块。
   * - Esc 关闭；Tab 只在弹窗里循环（弹窗本身与「关闭」按钮之间，trapTabIn），页面其余部分到不了；
   * - 点遮罩空白处关闭（弹窗自身拦截点击，点图片不误关）；
   * - 没有过渡动画（减少动态效果时也没有）。环境缺方法（测试替身）时安静跳过。
   */
  const dialogKeyDown = (event: { key: string; shiftKey: boolean; preventDefault(): void; stopPropagation?: () => void }): void => {
    if (event.key === 'Escape') { try { event.stopPropagation?.() } catch { /* 测试替身没有这个方法也不影响关闭 */ } close(); return }
    if (event.key !== 'Tab') return
    let active: unknown = null
    try { active = document.activeElement } catch { active = null }
    if (trapTabIn([dialogRef.current, closeRef.current], active, event.shiftKey)) event.preventDefault()
  }

  const caption = <span className="ah-shot-caption">{evidence.summary}</span>
  return (
    <span className="ah-shot" ref={wrapRef}>
      {entry !== null && entry.state === 'ok' ? (
        <button
          type="button"
          ref={thumbRef}
          className={`ah-shot-btn${wide ? ' is-wide' : ''}`}
          aria-label={JOB_TEXT.shotOpen}
          onClick={() => { setOpen(true) }}
        >
          {/* 读取到实际尺寸后，宽屏（宽大于高）的截图显示 150 像素宽。 */}
          <img src={entry.dataUrl} alt={evidence.summary} onLoad={event => {
            const img = event.target as HTMLImageElement | null
            try { if (img !== null && img.naturalWidth > img.naturalHeight) setWide(true) } catch { /* 尺寸读不到按普通宽度 */ }
          }} />
        </button>
      ) : (
        <span className={`ah-shot-placeholder${entry !== null && entry.state === 'error' ? ' is-error' : ''}`} aria-label={evidence.summary}>
          {/* 出错显示错误文字；请求中显示「读取中」；没有定位参数（还没接线）时只画占位框。 */}
          {entry !== null && entry.state === 'error' ? entry.error : inView && props.shotRef !== null ? JOB_TEXT.shotLoading : null}
        </span>
      )}
      {caption}
      {open && entry !== null && entry.state === 'ok' ? (
        // P74i-m1（走查 D-11）：真正的遮罩弹窗——全屏遮罩浮在页面之上，图片居中、按窗口等比缩小；
        // 右上角「关闭」，点遮罩空白处、按 Esc 都关闭；Tab 只在弹窗里循环（见 dialogKeyDown）。
        // 弹窗清单登记在无障碍契约测试（accessibility-contract.test.ts）里。
        <div className="ah-shot-overlay" onClick={close}>
          <div ref={dialogRef} className="ah-shot-dialog" role="dialog" aria-modal="true" tabIndex={-1}
            aria-label={JOB_TEXT.shotDialogLabel}
            onClick={event => { event.stopPropagation() }}
            onKeyDown={dialogKeyDown}>
            <button type="button" ref={closeRef} className="ah-btn ah-shot-dialog-close" onClick={close}>{JOB_TEXT.shotClose}</button>
            <img src={entry.dataUrl} alt={evidence.summary} />
          </div>
        </div>
      ) : null}
    </span>
  )
}

/**
 * 一项证据：截图是缩略图；文件是一行小条（「文件」小标签加文件名）；测试一句（左边细线）；链接显示主机名。
 * 写成普通函数而不是子组件（与约定卡同一取舍）：整棵树是连续的元素，测试能直接检查每一种证据。
 */
function evidenceNode(evidence: EvidenceItemView['evidence'][number], shotRef: ShotRef | null, readShot?: ShotReader): ReactNode {
  if (evidence.kind === 'image') {
    return <ShotThumb key={evidence.id} shotRef={shotRef} evidence={evidence} readShot={readShot} />
  }
  if (evidence.kind === 'test') {
    // 测试证据是一句结果（summary，「依次提交 81 条…」），小标签是「测试」的缩写。
    return (
      <span key={evidence.id} className="ah-ev-test">
        <span className="ah-ev-tag">{evidenceTag(evidence.kind)}</span>
        {evidence.summary !== '' ? evidence.summary : evidence.label}
      </span>
    )
  }
  if (evidence.kind === 'link') {
    // P74i-m2（第四次审查中-2）：链接证据是员工交回时写的地址，核心只限定 http(s)，不限主机——
    // 画成不可点的文字（主机名加完整地址，可以选中复制），不出现 <a>，主人点一下不会离开 DSH
    // 打开模型给的任意网址。地址为空时只显示说明文字。
    let host: string | null = null
    if (evidence.url !== null) {
      try { host = new URL(evidence.url).hostname } catch { host = null }
    }
    return (
      <span key={evidence.id} className="ah-ev-link">
        <span className="ah-ev-tag">{evidenceTag(evidence.kind)}</span>
        {evidence.url === null || evidence.url === '' ? evidence.label : host !== null && host !== '' ? `${host} ${evidence.url}` : evidence.url}
      </span>
    )
  }
  // W12：有定位参数时文件小条可以点（交给电脑打开），旁边一个「在访达中显示」；没有定位参数（旧数据、预览）时仍是一行文字。
  if (shotRef !== null) return <FileChip key={evidence.id} shotRef={shotRef} evidence={evidence} />
  return (
    <span key={evidence.id} className="ah-ev-file">
      <span className="ah-ev-tag">{evidenceTag(evidence.kind)}</span>{evidence.label}
    </span>
  )
}

/** 打开文件的函数形状：与 client/api.ts 的 openJobEvidence 一致，测试里注入假实现。 */
export type FileOpener = (input: ShotRef & { evidenceId: string; action: 'open' | 'reveal' }) => Promise<{ ok: boolean; error?: string; path?: string }>

/** 默认的打开办法：交给宿主（用默认应用打开 / 在访达中显示）。 */
export const defaultFileOpener: FileOpener = input => api.openJobEvidence(input)

/** 读文本的函数形状：与 client/api.ts 的 readJobEvidenceText 一致，测试里注入假实现。 */
export type FileTextReader = (input: ShotRef & { evidenceId: string }) =>
  Promise<{ ok: boolean; error?: string; data?: { text: string; format: 'markdown' | 'plain'; name: string } }>

export const defaultFileTextReader: FileTextReader = input => api.readJobEvidenceText(input)

/** 能在当前页面直接看的纯文本格式（与 core 的 EVIDENCE_TEXT_EXTS 一致；core 读的时候还会再查一次）。 */
const TEXT_EXTS = ['md', 'markdown', 'txt', 'log', 'csv', 'tsv', 'json', 'yaml', 'yml']

/** 这条证据点文件名时能不能在当前页面直接看。 */
export function evidenceViewableHere(evidence: EvidenceItemView['evidence'][number]): boolean {
  if (evidence.kind !== 'file' || evidence.path === null) return false
  const match = /\.([^./\\]+)$/.exec(evidence.path)
  return match !== null && TEXT_EXTS.includes(match[1]!.toLowerCase())
}

/** Markdown 渲染器里代码块、脚注的按钮文字。 */
const MD_LABELS = { code: { copyLabel: '复制', copiedLabel: '已复制' }, footnotes: '脚注' }

/**
 * 文件查看弹窗（W12 验收后改）：浮在当前页面上，不跳去别的对话。
 * md 用 DSH 自带的 Markdown 渲染器（MarkdownText），弹窗用 DSH 自带的 Modal；
 * 这个版本的 DSH 没有这两个零件时，退回我们自己的遮罩弹窗和纯文本显示。
 */
export function FileTextViewer(props: { name: string; text: string; format: 'markdown' | 'plain'; onClose: () => void }): ReactNode {
  const { name, text, format, onClose } = props
  const prims = dshPrimitives()
  const MarkdownText = prims?.MarkdownText ?? null
  const Modal = prims?.Modal ?? null
  const body = format === 'markdown' && MarkdownText !== null
    ? <div className="ah-ev-viewer-md"><MarkdownText text={text} labels={MD_LABELS} variant="body" /></div>
    : <pre className="ah-ev-viewer-pre">{text}</pre>
  if (Modal !== null) {
    return <Modal open onClose={onClose} title={name} closeLabel={JOB_TEXT.shotClose} contentClassName="ah-ev-viewer">{body}</Modal>
  }
  return <FallbackViewer name={name} onClose={onClose}>{body}</FallbackViewer>
}

/** 没有 DSH 弹窗时的退路：和截图大图同一种遮罩弹窗，Esc、点遮罩空白处、「关闭」都能关。 */
function FallbackViewer(props: { name: string; onClose: () => void; children: ReactNode }): ReactNode {
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const closeRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => { try { dialogRef.current?.focus?.() } catch { /* 聚焦失败不影响显示 */ } }, [])
  const keyDown = (event: { key: string; shiftKey: boolean; preventDefault(): void; stopPropagation?: () => void }): void => {
    if (event.key === 'Escape') { try { event.stopPropagation?.() } catch { /* 替身没有也不影响 */ } props.onClose(); return }
    if (event.key !== 'Tab') return
    let active: unknown = null
    try { active = document.activeElement } catch { active = null }
    if (trapTabIn([dialogRef.current, closeRef.current], active, event.shiftKey)) event.preventDefault()
  }
  return (
    <div className="ah-shot-overlay" onClick={props.onClose}>
      <div ref={dialogRef} className="ah-shot-dialog ah-ev-viewer" role="dialog" aria-modal="true" tabIndex={-1} aria-label={props.name}
        onClick={event => { event.stopPropagation() }} onKeyDown={keyDown}>
        <div className="ah-ev-viewer-head">
          <strong>{props.name}</strong>
          <button type="button" ref={closeRef} className="ah-btn ah-shot-dialog-close" onClick={props.onClose}>{JOB_TEXT.shotClose}</button>
        </div>
        {props.children}
      </div>
    </div>
  )
}

/** 「在访达中显示」按系统换说法：苹果电脑叫访达，其余叫文件夹。读不到系统时按苹果电脑。 */
function revealLabel(): string {
  try {
    const platform = String((globalThis as { navigator?: { platform?: string; userAgent?: string } }).navigator?.platform ?? '')
    if (platform !== '' && !/mac/i.test(platform)) return JOB_TEXT.fileRevealOther
  } catch { /* 读不到按苹果电脑 */ }
  return JOB_TEXT.fileReveal
}

/**
 * 文件小条（W12）：点文件名查看——md、txt 这类文本在当前页面上弹窗看（DSH 自带的 Markdown 渲染），
 * 其余格式（pdf、表格、图片……）交给电脑上的默认应用；旁边的小按钮在访达中显示。
 * 打不开时在下面一行写原因，带路径时路径可以选中复制。
 */
export function FileChip(props: { shotRef: ShotRef; evidence: EvidenceItemView['evidence'][number]; open?: FileOpener; readText?: FileTextReader }): ReactNode {
  const { evidence, shotRef } = props
  const open: FileOpener = props.open ?? defaultFileOpener
  const readText: FileTextReader = props.readText ?? defaultFileTextReader
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<{ error: string; path: string | null } | null>(null)
  const [viewing, setViewing] = useState<{ text: string; format: 'markdown' | 'plain'; name: string } | null>(null)
  const nameRef = useRef<HTMLButtonElement | null>(null)
  const fail = (error: unknown): void => {
    setBusy(false)
    setProblem({ error: error instanceof Error ? error.message : String(error), path: null })
  }
  const run = (action: 'open' | 'reveal'): void => {
    if (busy) return
    setBusy(true)
    setProblem(null)
    void open({ ...shotRef, evidenceId: evidence.id, action })
      .then(result => {
        setBusy(false)
        if (!result.ok) setProblem({ error: result.error ?? '没能打开', path: typeof result.path === 'string' && result.path !== '' ? result.path : null })
      })
      .catch(fail)
  }
  const view = (): void => {
    if (busy) return
    if (!evidenceViewableHere(evidence)) { run('open'); return }
    setBusy(true)
    setProblem(null)
    void readText({ ...shotRef, evidenceId: evidence.id })
      .then(result => {
        setBusy(false)
        if (result.ok && result.data !== undefined) setViewing(result.data)
        else setProblem({ error: result.error ?? '没能读出这个文件', path: null })
      })
      .catch(fail)
  }
  const closeViewer = (): void => {
    setViewing(null)
    returnFocus(nameRef.current)
  }
  const reveal = revealLabel()
  return (
    <span className="ah-ev-file-wrap">
      <span className="ah-ev-file-row">
        <button type="button" ref={nameRef} className="ah-ev-file is-openable" title={JOB_TEXT.fileOpen} aria-label={`${JOB_TEXT.fileOpen}：${evidence.label}`}
          disabled={busy} onClick={view}>
          <span className="ah-ev-tag">{evidenceTag(evidence.kind)}</span>{evidence.label}
        </button>
        <button type="button" className="ah-ev-file-reveal" title={reveal} aria-label={`${reveal}：${evidence.label}`}
          disabled={busy} onClick={() => { run('reveal') }}>
          {busy ? JOB_TEXT.fileOpening : reveal}
        </button>
      </span>
      {problem !== null ? (
        <span className="ah-ev-file-error" role="alert">
          <span>{problem.error}</span>
          {problem.path !== null ? <code className="ah-job-preview-path">{problem.path}</code> : null}
        </span>
      ) : null}
      {viewing !== null ? <FileTextViewer name={viewing.name} text={viewing.text} format={viewing.format} onClose={closeViewer} /> : null}
    </span>
  )
}

/**
 * 清单里的一条：序号、条目原文、结论小章；下一行证据；说明、「改到什么程度算过」与历史按需出现。
 * 同样写成普通函数：行里的序号、结论小章和「改到什么程度算过」都要能被测试直接找到。
 */
function evidenceRow(item: EvidenceItemView, shotRef: ShotRef | null, readShot?: ShotReader): ReactNode {
  const bad = item.verdict.tone === 'bad'
  return (
    <li key={item.no} className={bad ? 'is-bad' : undefined}>
      <span className="ah-ev-no">{item.no}</span>
      <div className="ah-ev-main">
        <p className="ah-ev-text">{item.text}</p>
        {item.evidence.length > 0 ? (
          <div className="ah-ev-proof">
            {item.evidence.map(evidence => evidenceNode(evidence, shotRef, readShot))}
          </div>
        ) : null}
        {item.evidence.some(evidence => evidence.checkText !== null) ? (
          <p className="ah-ev-check">{item.evidence.filter(evidence => evidence.checkText !== null).map(evidence => evidence.checkText).join('；')}</p>
        ) : null}
        {item.note !== null ? <p className="ah-ev-note">{item.note}</p> : null}
        {item.fixTo !== null ? (
          <div className="ah-ev-fix">
            <strong>{JOB_TEXT.fixTitle}</strong>
            <span>{item.fixTo}</span>
          </div>
        ) : null}
        {item.history !== null ? <p className="ah-ev-history">{item.history}</p> : null}
      </div>
      <span className={`ah-ev-verdict ${verdictClass(item.verdict.tone)}`}>{item.verdict.label}</span>
    </li>
  )
}

/** 整份清单：交回卡、核对卡、交付卡共用，只有结论一栏的人不同。 */
export function EvidenceList(props: {
  items: readonly EvidenceItemView[]
  shotRef?: ShotRef | null
  readShot?: ShotReader
}): ReactNode {
  const shotRef = props.shotRef ?? null
  return (
    <ol className="ah-ev-list">
      {props.items.map(item => evidenceRow(item, shotRef, props.readShot))}
    </ol>
  )
}

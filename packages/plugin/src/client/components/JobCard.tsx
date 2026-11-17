/**
 * 「一件事」的卡片（P74h 起步，P74i 补齐）：五种卡片共用一个文件——
 * 交回卡（submission）、核对卡（review）、交付卡（delivery）、三轮不过卡（escalation）、回执（receipt）。
 *
 * 卡片内容完全照 core 的 JobCardView 画，本文件不手写任何视图字段：
 * - 卡头小标签（core 的 head）、标题、右侧状态（交付卡按状态着色：待你验收普通色、已完成成功色、
 *   未通过警示色、已失效灰）；
 * - 交回、核对、交付共用证据清单（EvidenceList）；截图缩略图的定位参数用视图的
 *   evidenceJobId、evidenceSubmissionId（任一为 null 时不请求，只显示占位框）；
 * - 交付卡待你验收时有「验收通过」（acceptJob，revision 取视图的修订号，没有按 0）和
 *   「在你的电脑上打开预览」（openJobPreview）两个按钮；能不能验收以视图的 actions.accept 为准、
 *   提示以 actions.hint 为准；失效的卡只读，没有任何按钮；
 * - 三轮不过卡：四段（受阻原因、已尝试的办法、可选的办法、建议理由），办法整行可点、单选、
 *   建议项预选但不会自动提交，必须主人点「按所选办法处理」（chooseJobOption，option 从 0 起）；
 *   主人选过的旧卡只读；每个办法的 changeLine 不为 null 时在做法下面另起一行原样显示；
 * - 回执：窄条，每行左标签右值，等宽数字，不调用任何命令。
 *
 * 按钮点了之后要防重复点（置灰）；失败时恢复并显示 core 返回的中文错误。
 * 命令默认走 client/api.ts；测试可经 props.commands 注入假实现。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { CommandResult, DeliveryCardView, EscalationCardView, JobCardView, ReceiptCardView } from '../../shared/views.js'
import { JOB_TEXT, deliveryIsExpired, deliveryStateClass, initialEscalationChoice, type ShotReader } from '../logic/job.js'
import { api } from '../api.js'
import { EvidenceList, type ShotRef } from './EvidenceList.js'
import { isDrawableJobCard, type DrawableJobCardView } from '../../shared/job-card-kinds.js'
import { RetroCard, SkillCheckCard } from './SkillCards.js'

/** 交付卡与三轮不过卡要用的命令；测试里注入假实现，正式环境走 client/api.ts。 */
export interface JobCommands {
  accept(input: { jobId: string; stage: number; revision?: number }): Promise<CommandResult>
  choose(input: { jobId: string; stage: number; option: number; revision?: number }): Promise<CommandResult>
  preview(input: { jobId: string }): Promise<CommandResult & { path?: string }>
}

/** 正式环境的命令实现（宿主已把这几条接到中心）。 */
const apiCommands: JobCommands = {
  accept: input => api.acceptJob(input),
  choose: input => api.chooseJobOption(input),
  preview: input => api.openJobPreview(input),
}

/** 卡片头：小标签（core 给的 head）、标题、右侧一行状态。写成普通函数，测试能直接检查标题。 */
function jobCardHead(card: Exclude<Extract<DrawableJobCardView, { head: string }>, { kind: 'retro' | 'skill_check' }>, stateClass = ''): ReactNode {
  return (
    <div className="ah-card-head ah-job-head">
      <span className="ah-card-type">{card.head}</span>
      <span className="ah-card-title">{card.title}</span>
      {/* 核对卡通过时右侧写「已通过」；不通过时写「剩余 n 轮」（core 的 roundText）。交付卡按状态着色。 */}
      <span className={`ah-job-state${stateClass === '' ? '' : ` ${stateClass}`}`}>
        {card.kind === 'review' ? (card.stateText ?? card.roundText) : card.stateText}
      </span>
    </div>
  )
}

/** 卡片视图自带的截图定位参数：两个字段任一为 null 就不请求（旧数据取不到编号）。 */
function shotRefOf(card: DeliveryCardView | Extract<DrawableJobCardView, { items: unknown[] }>): ShotRef | null {
  const jobId = card.evidenceJobId
  const submissionId = card.evidenceSubmissionId
  return jobId !== null && submissionId !== null ? { jobId, submissionId } : null
}

// ---------------------------------------------------------------------------
// 交付卡（delivery）
// ---------------------------------------------------------------------------

/** 打开预览这一步的状态：没有点过、正在打开、已打开（短暂提示）、失败（带路径）、命令报错。 */
type PreviewState =
  | { state: 'idle' }
  | { state: 'opening' }
  | { state: 'opened' }
  | { state: 'failed'; path: string; error: string }
  | { state: 'error'; error: string }

/** 「已打开」提示停留的时长；减少动态效果时也不做淡出，到点直接消失。 */
const OPENED_HINT_MS = 2000

/**
 * P74i-m1（走查 D-7、E-7）：命令成功后按钮保持「正在记下…」的兜底时长。
 * 正常路径是视图刷新后这张卡变成只读（按钮随之消失）；万一 10 秒后卡片还是原来的状态
 * （视图没刷新或刷新失败），恢复按钮可点，不显示错误——主人还能再试一次。
 */
const SUBMIT_HOLD_MS = 10_000

/** 交付卡（P74i，设计稿场景 D）。导出是为了测试与预览能单独渲染这一种卡。 */
export function DeliveryCard(props: { card: DeliveryCardView; commands?: JobCommands }): ReactNode {
  const { card } = props
  const commands = props.commands ?? apiCommands
  const [accepting, setAccepting] = useState(false)
  const [acceptError, setAcceptError] = useState<string | null>(null)
  const [preview, setPreview] = useState<PreviewState>({ state: 'idle' })
  const openedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // P74i-m1：成功后保持置灰的兜底定时器，与「点下时卡片的状态文字」一起判断要不要复位。
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const heldStateRef = useRef<string | null>(null)

  const clearHold = (): void => {
    if (holdTimer.current !== null) { clearTimeout(holdTimer.current); holdTimer.current = null }
    heldStateRef.current = null
  }

  // 卸载时清掉两个定时器，避免对已卸载组件 setState。
  useEffect(() => () => {
    if (openedTimer.current !== null) clearTimeout(openedTimer.current)
    if (holdTimer.current !== null) clearTimeout(holdTimer.current)
  }, [])

  // 命令成功后卡片状态变化（视图刷新，如「待你验收」变「已完成」）：复位按钮状态，不再等兜底定时器。
  useEffect(() => {
    if (heldStateRef.current !== null && card.stateText !== heldStateRef.current) {
      clearHold()
      setAccepting(false)
    }
  }, [card.stateText])

  // 只读、着色、收起一律只看核心给的 phase（P74r8），状态文字只原样显示。
  const expired = deliveryIsExpired(card.phase)
  // 只读（已完成）：收起为一行「N 条全部符合，你已验收。」加「展开证据」。
  const doneReadonly = card.phase === 'accepted' && card.doneHint !== null
  const [expanded, setExpanded] = useState(false)

  /**
   * 点「验收通过」：按钮置灰防重复点并显示「正在记下…」。
   * - 失败：恢复可点并显示 core 的中文错误；
   * - 成功：保持「正在记下…」直到卡片状态变化（视图刷新后变只读）；10 秒后仍是原状就恢复可点（不显示错误）。
   */
  const accept = (): void => {
    if (accepting) return
    setAccepting(true)
    setAcceptError(null)
    void commands.accept({ jobId: card.jobId, stage: card.stage, ...(card.revision === undefined ? {} : { revision: card.revision }) })
      .then(result => {
        if (!result.ok) { setAccepting(false); setAcceptError(result.error); return }
        // 成功：记下此刻的状态文字并起兜底定时器（状态变化或到点都会复位，见上方 useEffect / 定时器回调）。
        heldStateRef.current = card.stateText
        try {
          holdTimer.current = setTimeout(() => {
            holdTimer.current = null
            heldStateRef.current = null
            setAccepting(false)
          }, SUBMIT_HOLD_MS)
        } catch { /* 定时器不可用时按失败复位，不影响再点一次 */ setAccepting(false) }
      })
      .catch((error: unknown) => {
        setAccepting(false)
        setAcceptError(error instanceof Error ? error.message : String(error))
      })
  }

  /** 点「在你的电脑上打开预览」：三种返回各自落位（ok、失败带路径、error）。 */
  const openPreview = (): void => {
    if (preview.state === 'opening') return
    setPreview({ state: 'opening' })
    void commands.preview({ jobId: card.jobId })
      .then(result => {
        if (result.ok) {
          setPreview({ state: 'opened' })
          if (openedTimer.current !== null) clearTimeout(openedTimer.current)
          try {
            openedTimer.current = setTimeout(() => { try { setPreview({ state: 'idle' }) } catch { /* 组件已卸载就不再提示 */ } }, OPENED_HINT_MS)
          } catch { /* 定时器不可用时提示常驻，不影响功能 */ }
        } else if (typeof result.path === 'string' && result.path !== '') {
          setPreview({ state: 'failed', path: result.path, error: result.error })
        } else {
          setPreview({ state: 'error', error: result.error })
        }
      })
      .catch((error: unknown) => setPreview({ state: 'error', error: error instanceof Error ? error.message : String(error) }))
  }

  const shotRef = shotRefOf(card)

  // 已完成的卡收起为一行结论加「展开证据」；其余（待你验收、未通过、失效）整张画出。
  if (doneReadonly && !expanded) {
    return (
      <div className={`ah-card ah-card-agreement ah-card-job${expired ? ' is-void' : ''}`} data-job-card="delivery">
        {jobCardHead(card, deliveryStateClass(card.phase))}
        <p className="ah-job-done-hint">{card.doneHint}</p>
        <button type="button" className="ah-btn ah-btn-ghost" onClick={() => setExpanded(true)}>{JOB_TEXT.deliveryExpand}</button>
      </div>
    )
  }

  return (
    <div className={`ah-card ah-card-agreement ah-card-job${expired ? ' is-void' : ''}`} data-job-card="delivery">
      {jobCardHead(card, deliveryStateClass(card.phase))}
      {doneReadonly ? (
        <>
          <EvidenceList items={card.items} shotRef={shotRef} />
          <button type="button" className="ah-btn ah-btn-ghost" onClick={() => setExpanded(false)}>{JOB_TEXT.deliveryCollapse}</button>
        </>
      ) : (
        <>
          <EvidenceList items={card.items} shotRef={shotRef} />
          {card.returnedHint !== null ? <p className="ah-job-returned">{card.returnedHint}</p> : null}
          {/* 已失效（约定已更新、已重新交付、这件事已停止）的卡只读，没有任何按钮。 */}
          {!expired ? (
            <div className="ah-job-actions">
              {card.actions.accept ? (
                <button type="button" className="ah-btn ah-btn-primary" disabled={accepting} onClick={accept}>
                  {accepting ? JOB_TEXT.deliveryAccepting : JOB_TEXT.deliveryAccept}
                </button>
              ) : null}
              {card.actions.preview ? (
                <button type="button" className="ah-btn" disabled={preview.state === 'opening'} onClick={openPreview}>
                  {JOB_TEXT.deliveryPreview}
                </button>
              ) : null}
              {/* 「已打开」的短暂提示与按钮同一行；失败时错误与可复制的路径在按钮下方。 */}
              {preview.state === 'opened' ? <span className="ah-job-opened">{JOB_TEXT.deliveryOpened}</span> : null}
            </div>
          ) : null}
          {preview.state === 'failed' ? (
            <p className="ah-job-preview-error" role="alert">
              <span>{preview.error}</span>
              <code className="ah-job-preview-path">{preview.path}</code>
            </p>
          ) : null}
          {preview.state === 'error' ? <p className="ah-job-preview-error" role="alert">{preview.error}</p> : null}
          {card.actions.hint !== null ? <p className="ah-job-hint">{card.actions.hint}</p> : null}
          {acceptError !== null ? <p className="ah-card-error" role="alert">{acceptError}</p> : null}
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 三轮不过卡（escalation）
// ---------------------------------------------------------------------------

/** 三轮不过卡（P74i，设计稿场景 E）。导出是为了测试与预览能单独渲染这一种卡。
 *  P74i-m2（第四次审查低-4）：提交成功后调用 onSubmitted（「待你处理」里据此给「已提交」提示，
 *  与其余条目同一句），不传则什么都不做（对话里的卡不需要）。 */
export function EscalationCard(props: {
  card: EscalationCardView
  commands?: JobCommands
  onSubmitted?: () => void
  /** P79：放在「按所选办法处理」同一行的次要按钮（都不合适），只有「待你处理」里的说明条目传入。 */
  extraAction?: ReactNode
  /**
   * P74i-m4（第 2 节）：提交状态变化时通知「待你处理」，让它把次要按钮「都不合适」在提交中禁用、处理完后不显示。
   * submitting：已点「按所选办法处理」；done：核心已接受；none：提交失败，恢复。
   */
  onLockChange?: (lock: 'none' | 'submitting' | 'done') => void
}): ReactNode {
  const { card } = props
  const commands = props.commands ?? apiCommands
  const [selected, setSelected] = useState(() => initialEscalationChoice(card.options))
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // P74i-m1（第二次，任务卡 1.2）：卡可不可交互只看视图的 selectable 与 chosen，不按状态文字猜——
  // 主人选过的卡（chosen 不为 null）只读，被选的办法上加「已选」小标签（走查 E-5）；
  // 没选过而 selectable 为假的卡一律按失效画（办法不可点、没有「按所选办法处理」和建议理由），
  // 状态文字原样显示（核心以后再加失效原因也不用到界面改）。旧数据没有 selectable 字段时按可选处理。
  const chosen = card.chosen !== null
  const selectable = card.selectable !== false
  const interactive = !chosen && selectable
  // P74i-m2（第二次）：两种不可交互的卡分开画——
  // 主人已选的卡（chosen 不为空）是正常的只读样子：类名 is-chosen，不弱化、没有虚线边框，被选的办法有「已选」标签；
  // 失效的卡（没选过而 selectable 为假）才弱化：类名 is-void（弱化与虚线边框的样式只挂在它上面）。
  const voided = !chosen && !selectable
  // P74i-m1（走查 E-7）：与交付卡同一套「提交中」规则——成功后保持到卡片状态变化，10 秒兜底恢复。
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const heldStateRef = useRef<string | null>(null)

  useEffect(() => () => { if (holdTimer.current !== null) clearTimeout(holdTimer.current) }, [])

  // 命令成功后卡片状态变化（视图刷新，「等你决定」变「你选了 X」）：复位按钮状态。
  useEffect(() => {
    if (heldStateRef.current !== null && card.stateText !== heldStateRef.current) {
      if (holdTimer.current !== null) { clearTimeout(holdTimer.current); holdTimer.current = null }
      heldStateRef.current = null
      setSubmitting(false)
    }
  }, [card.stateText])

  /**
   * 点「按所选办法处理」：不会自动提交，必须主人点。
   * - 提交中按钮写「正在记下…」并不可点（与交付卡一致，走查 E-7）；
   * - 失败恢复按钮并显示 core 的中文错误；
   * - 成功保持「正在记下…」直到卡片状态变化；10 秒后仍是原状就恢复可点（不显示错误）。
   */
  const submit = (): void => {
    if (submitting) return
    setSubmitting(true)
    setError(null)
    props.onLockChange?.('submitting')
    void commands.choose({ jobId: card.jobId, stage: card.stage, option: selected, ...(card.revision === undefined ? {} : { revision: card.revision }) })
      .then(result => {
        if (!result.ok) { setSubmitting(false); setError(result.error); props.onLockChange?.('none'); return }
        props.onLockChange?.('done')
        heldStateRef.current = card.stateText
        // 成功即通知上层（「待你处理」里的说明条目据此显示「已提交」提示，低-4）；提示本身由上层管理。
        props.onSubmitted?.()
        try {
          holdTimer.current = setTimeout(() => {
            holdTimer.current = null
            heldStateRef.current = null
            setSubmitting(false)
          }, SUBMIT_HOLD_MS)
        } catch { /* 定时器不可用时按失败复位，不影响再点一次 */ setSubmitting(false) }
      })
      .catch((caught: unknown) => {
        setSubmitting(false)
        setError(caught instanceof Error ? caught.message : String(caught))
        props.onLockChange?.('none')
      })
  }

  return (
    <div className={`ah-card ah-card-agreement ah-card-job ah-card-escalation${voided ? ' is-void' : chosen ? ' is-chosen' : ''}`} data-job-card="escalation">
      {/* 失效的卡（没选过而不可选）右侧状态用与交付卡失效相同的灰样式；已选的卡状态保持正常色；文字原样显示。 */}
      {jobCardHead(card, voided ? ' is-na' : '')}
      {/* 四段：受阻原因、已尝试的办法、可选的办法、按钮行加建议理由（后两段只在可选时有）。 */}
      <div className="ah-esc-sec">
        <h4 className="ah-esc-title">{JOB_TEXT.escalationStuck}</h4>
        <p className="ah-esc-text">{card.stuckAt}</p>
      </div>
      <div className="ah-esc-sec">
        <h4 className="ah-esc-title">{JOB_TEXT.escalationTried}</h4>
        <ol className="ah-esc-tried">{card.tried.map((text, index) => <li key={index}>{text}</li>)}</ol>
      </div>
      <div className="ah-esc-sec">
        {/* 小标题直接显示视图的 optionsTitle（核心按「带改动的办法几个、可不可选」生成，界面不拼）。 */}
        <h4 className="ah-esc-title">{card.optionsTitle}</h4>
        {/* P74i-m2（第四次审查低-6）：办法是「从几个里选一个」，按单选的语义暴露给读屏——
            外层 radiogroup（以小标题命名）、每个办法 role=radio 加 aria-checked；
            键盘：Tab 进入（每个办法都是原生 button），方向键在办法之间移动（移到即选中，
            与单选习惯一致），空格或回车选中。不可选的卡（已选或失效）不暴露为可操作的单选。 */}
        <div className="ah-esc-options" role={interactive ? 'radiogroup' : undefined} aria-label={interactive ? card.optionsTitle : undefined}>
          {card.options.map((option, index) => {
            // 不可交互的卡（已选或失效）：办法画成普通一行；还在等决定时是整行按钮（原生 button，Tab 能到，Enter 或空格选中）。
            const inner = (
              <>
                <span className="ah-esc-option-head">
                  <strong>{option.letter}　{option.title}</strong>
                  {option.suggested ? <span className="ah-tag ah-tag-wait">{JOB_TEXT.escalationSuggested}</span> : null}
                  {/* 主人选过的卡：被选的那个办法上加「已选」小标签，不只靠卡头那行状态（走查 E-5）。 */}
                  {chosen && option.letter === card.chosen ? <span className="ah-tag ah-tag-ok">{JOB_TEXT.escalationChosen}</span> : null}
                </span>
                <span className="ah-esc-option-detail">{option.detail}</span>
                {/* 「选了实际会改什么」由中心生成，是主人确认的依据：与做法相同的字号、正文颜色，不用更浅的颜色。 */}
                {option.changeLine !== null ? <span className="ah-esc-option-detail ah-esc-change-line">{option.changeLine}</span> : null}
              </>
            )
            return interactive ? (
              <button key={option.letter} type="button" className={`ah-esc-option${index === selected ? ' is-selected' : ''}`}
                role="radio" aria-checked={index === selected} disabled={submitting}
                onClick={() => setSelected(index)}
                onKeyDown={event => {
                  // 方向键（上下左右）在办法之间移动并选中（到头循环），焦点跟着移到新的办法上；
                  // 原生 button 保证 Tab 与空格/回车可用。环境里找不到相邻按钮时只改选中，不影响可用。
                  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown' && event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
                  event.preventDefault()
                  const total = card.options.length
                  const step = event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 1
                  const next = (selected + step + total) % total
                  setSelected(next)
                  try {
                    const buttons = (event.currentTarget as HTMLElement).parentElement?.querySelectorAll('button')
                    buttons?.[next]?.focus()
                  } catch { /* 焦点移动失败不影响选中 */ }
                }}>
                {inner}
              </button>
            ) : (
              <div key={option.letter} className="ah-esc-option is-readonly" data-option-letter={option.letter}>{inner}</div>
            )
          })}
        </div>
      </div>
      {interactive ? (
        <div className="ah-job-actions ah-esc-submit">
          <button type="button" className="ah-btn ah-btn-primary" disabled={submitting} onClick={submit}>
            {/* P74i-m1（走查 E-7）：提交中的文字与交付卡一致——「正在记下…」。 */}
            {submitting ? JOB_TEXT.deliveryAccepting : JOB_TEXT.escalationSubmit}
          </button>
          {props.extraAction ?? null}
          <span className="ah-job-hint">{card.reasonHint}</span>
        </div>
      ) : null}
      {error !== null ? <p className="ah-card-error" role="alert">{error}</p> : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 回执（receipt）
// ---------------------------------------------------------------------------

/** 回执（P74i，设计稿场景 G 提案一：窄条、等宽数字、行间点线）。 */
export function ReceiptCard(props: { card: ReceiptCardView }): ReactNode {
  const { card } = props
  return (
    <div className="ah-card ah-card-job ah-receipt" data-job-card="receipt">
      <p className="ah-receipt-title">{card.title}</p>
      <dl className="ah-receipt-rows">
        {card.rows.map(row => (
          <div key={row.label} className="ah-receipt-row">
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 统一入口
// ---------------------------------------------------------------------------

export function JobCard(props: {
  card: JobCardView
  shotRef?: ShotRef | null
  readShot?: ShotReader
  commands?: JobCommands
}): ReactNode {
  const { card } = props
  // 不在白名单内的种类（核心以后新增、界面还没画的）一律不画，也不抛错。
  if (!isDrawableJobCard(card)) return null
  // P75k：复盘卡与技能核对卡在 SkillCards.tsx（没有按钮、没有证据清单）。
  if (card.kind === 'retro') return <RetroCard card={card} />
  if (card.kind === 'skill_check') return <SkillCheckCard card={card} />
  if (card.kind === 'submission') {
    return (
      <div className="ah-card ah-card-agreement ah-card-job" data-job-card={card.kind}>
        {jobCardHead(card)}
        <p className="ah-job-intro">{card.intro}</p>
        <EvidenceList items={card.items} shotRef={props.shotRef ?? shotRefOf(card)} readShot={props.readShot} />
      </div>
    )
  }
  if (card.kind === 'review') {
    return (
      <div className="ah-card ah-card-agreement ah-card-job" data-job-card={card.kind}>
        {jobCardHead(card)}
        <EvidenceList items={card.items} shotRef={props.shotRef ?? shotRefOf(card)} readShot={props.readShot} />
        {card.carriedText !== null ? <p className="ah-job-carried">{card.carriedText}</p> : null}
        <p className="ah-job-footer">{card.footer}</p>
      </div>
    )
  }
  if (card.kind === 'delivery') return <DeliveryCard card={card} commands={props.commands} />
  if (card.kind === 'escalation') return <EscalationCard card={card} commands={props.commands} />
  return <ReceiptCard card={card} />
}

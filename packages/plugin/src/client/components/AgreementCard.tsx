/**
 * 约定卡（P72e）：总管动手前和你对齐的那张卡，一张卡对应约定的一个版本。
 *
 * 卡里按顺序有六样东西，每块有小标题：
 *   一句话 / 草图 / 待你定（N 项）/ 我已定的（N 项）/ 这次做与这次不做 / 怎样算做完。
 * 待你定的事项每项一行，选项是单选按钮（建议项预先选好，不同意就点别的），
 * 整张卡只有一个「定了」按钮；要改别的地方，直接在下方输入框写，总管改好会出新版本。
 *
 * 四种状态，画法不同（状态由 core 决定，这里只管画）：
 * - pending（待你确认）：第 1 版完整展开；第 2 版起顶部先列「本版改动」，改动处加提示底色，
 *   并默认只显示改动：没改的待定项收成「其余 N 项与上一版相同」，没改的几块收成
 *   「除上面标出的改动外，与第 N 版相同」，点「展开全文」看全部（规则在 logic/agreement.ts 的 condensedPlan，P72g B3）；
 * - superseded / replaced（被新版取代）：折叠成一行，没有任何按钮，点一下可展开成只读全文；
 * - locked（已固定）：只读，默认收起成「头部 + 一句话 + 你选了：定了。…」加「展开全文」，
 *   右上角盖「定」字印章；第一次确认的那一版还会多一行采纳了几条建议、累计默契度；
 * - 整份约定被撤下（agreementState 为 withdrawn）：折叠成一行「已撤下」。
 *
 * 「定了」点下去：按钮禁用，调用 onConfirm；返回错误文字时按钮复位并在卡片底部显示错误，
 * 和待你处理里的提问卡是同一套规则（失败要看得见、能重试）。
 *
 * 印章动效：只在这张卡挂载期间、由待确认变成已固定的那一刻落一次章；
 * 页面加载时就已经固定的卡直接显示静态印章；系统要求减少动态效果时不播（规则在 logic/agreement.ts）。
 *
 * 实现上的取舍：卡里所有「块」都写成同一个文件里的普通函数，而不是一堆子组件，
 * 这样整张卡是一棵连续的元素树，测试能直接检查小标题、选项和按钮；
 * 所有 hook 都集中在 AgreementCard 一个函数的开头，保证每次渲染 hook 数量一致。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { AgreementCardView } from '../../shared/views.js'
import {
  AGR_TEXT, adoptionLine, condensedPlan, decidedTitle, estimateHeadlineParts, initialChoices, isChangedItem, pendingTitle, prefersReducedMotion,
  selectedOptionOf, shouldPlayStamp, sketchHasMark, stampDateText, stateLabelOf, submitChoices, unchangedPendingText,
  removedLineText, unchangedRestText, versionText,
  type AgreementChoices, type CondensedPlan,
} from '../logic/agreement.js'
import { JOB_TEXT } from '../logic/job.js'
import { MEM_TEXT, fill } from '../logic/memory.js'
import { AgreementSketch } from './AgreementSketch.js'

/** 点「定了」的回调：返回错误文字或 null（成功）。 */
export type ConfirmAgreement = (agreementId: string, version: number, choices: AgreementChoices) => Promise<string | null>

/** 改动处的样式类：只在本版改动处加，未改的不带。 */
function changedClass(item: { changed?: boolean; added?: boolean }): string {
  return isChangedItem(item) ? ' ah-agr-changed' : ''
}

/** 一块内容的小标题 + 提示（提示可选）。 */
function heading(title: string, hint?: string): ReactNode {
  return (
    <p className="ah-agr-sec-h">
      <span>{title}</span>
      {hint !== undefined ? <span className="ah-agr-sec-hint">{hint}</span> : null}
    </p>
  )
}

/** 一条列表（这次做 / 这次不做 / 怎样算做完共用）。 */
function listNode(items: ReadonlyArray<{ text: string; changed: boolean }>, ordered: boolean): ReactNode {
  const rows = items.map((item, i) => <li key={`i${i}`} className={changedClass(item).trim()}>{item.text}</li>)
  return ordered ? <ol>{rows}</ol> : <ul>{rows}</ul>
}

/** 待你定的一项：序号圆圈、问题、单选选项、理由。interactive 为假时选项只读。 */
function pendingItemNode(
  item: AgreementCardView['pending'][number],
  selected: string,
  interactive: boolean,
  disabled: boolean,
  onPick: (key: string, option: string) => void,
): ReactNode {
  return (
    <div key={item.key} className={`ah-agr-q${changedClass(item)}`}>
      <span className="ah-agr-pin" aria-hidden="true">{item.index}</span>
      <span className="ah-agr-q-text">{item.question}</span>
      <div className="ah-agr-q-opts" role="radiogroup" aria-label={item.question}>
        {item.options.map(option => {
          const checked = option === selected
          return (
            <button key={option} type="button" role="radio" aria-checked={checked}
              className={`ah-agr-chip${checked ? ' is-selected' : ''}`}
              disabled={disabled}
              aria-disabled={!interactive || undefined}
              onClick={() => { if (interactive) onPick(item.key, option) }}>
              {option}{option === item.suggested ? <em>{AGR_TEXT.suggested}</em> : null}
            </button>
          )
        })}
      </div>
      <p className="ah-agr-q-why">{item.reason}</p>
    </div>
  )
}

/**
 * 全文的六块内容（pending 的完整卡与「展开全文」共用）。
 * showChanges：待确认的第 2 版起，顶部先列「本版改动」。
 */
function bodyNodes(
  card: AgreementCardView,
  picked: AgreementChoices,
  interactive: boolean,
  disabled: boolean,
  onPick: (key: string, option: string) => void,
  showChanges: boolean,
  /** P72g B3：第 2 版起的待确认卡默认只显示改动；null 或 applies 为假时整张展开。 */
  plan: CondensedPlan | null = null,
  /** 收起了内容时，底部「展开全文」按钮的回调。 */
  onExpandAll?: () => void,
  /** P75k：已定事项的出处带 memoryId 时，出处按钮点开记忆页并定位到那一条；不传时出处仍是文字。 */
  onOpenMemory?: (memoryId: string) => void,
): ReactNode {
  const locked = card.state === 'locked'
  const condensed = plan !== null && plan.applies
  // 收起时待你定只列有改动的项；其余在下面写成一行。
  const pendingShown = condensed ? card.pending.filter(item => isChangedItem(item)) : card.pending
  return (
    <>
      {/* P74r2b + P74h-m1 第 5 处：「来源」「起因」两行移到卡片内容的最上面（卡头之下、「本版改动」之前）：
          它说明这一版为什么出现，应当先看到。起因是执行中提问的版本才有（originLine 非 null），
          其余版本不显示，卡片与没有这两行时完全一样。
          P74i：带「确认后这件事停止」一行（stopLine）的待确认版本，这一行也放在同一个位置、
          同一种小字（core 给的原文），为 null 时不显示。 */}
      {card.stopLine != null ? (
        <div className="ah-agr-origin">
          <p className="ah-agr-src">{card.stopLine}</p>
        </div>
      ) : null}
      {card.originLine !== null ? (
        <div className="ah-agr-origin">
          <p className="ah-agr-src">{card.sourceLabel}</p>
          <p className="ah-agr-src">{card.originLine}</p>
        </div>
      ) : null}
      {showChanges && card.versionNo > 1 && (card.changeNote.trim() !== '' || card.removed.length > 0) ? (
        <div className="ah-agr-sec ah-agr-changes">
          {heading(AGR_TEXT.changes)}
          {card.changeNote.trim() !== '' ? <p className="ah-agr-changes-text">{card.changeNote}</p> : null}
          {/* P72h：有意删去的条目逐条写「删去：某某」，由 core 按提交里写明的删除记下，不是总管自己总结。 */}
          {card.removed.map((text, i) => <p key={`rm${i}`} className="ah-agr-changes-text ah-agr-removed">{removedLineText(text)}</p>)}
        </div>
      ) : null}
      {/* P74h（B2）：这一版是某件进行中的事「等你确认」的那一版时，画出两栏（哪些照常在做、哪些暂停）、
          交付时间不变的一行；两栏版式沿用约定卡「这次做 / 这次不做」。两栏内容与时间由 core 按记录算出。 */}
      {card.jobSplit != null ? (
        <div className="ah-agr-split ah-job-split">
          <div className="ah-agr-sec">
            {heading(JOB_TEXT.splitContinuing)}
            {card.jobSplit.continuing.length > 0 ? <ul>{card.jobSplit.continuing.map((text, i) => <li key={`c${i}`}>{text}</li>)}</ul> : <p className="ah-agr-none">{AGR_TEXT.scopeNone}</p>}
          </div>
          <div className="ah-agr-sec">
            {heading(JOB_TEXT.splitPaused)}
            {card.jobSplit.paused.length > 0 ? <ul>{card.jobSplit.paused.map((text, i) => <li key={`p${i}`}>{text}</li>)}</ul> : <p className="ah-agr-none">{AGR_TEXT.scopeNone}</p>}
            {/* 暂停栏下一行：交付时间不变（core 已把时间拼进这一句）。 */}
            <p className="ah-agr-hint">{card.jobSplit.dueText}</p>
          </div>
        </div>
      ) : null}
      <div className="ah-agr-sec">
        {heading(AGR_TEXT.summary)}
        <p className={`ah-agr-one${changedClass(card.summary)}`}>{card.summary.text}</p>
      </div>
      <div className="ah-agr-sec">
        {heading(AGR_TEXT.sketch, sketchHasMark(card.sketch.value) ? AGR_TEXT.sketchHint : undefined)}
        <AgreementSketch sketch={card.sketch.value} changed={card.sketch.changed} />
      </div>
      {card.pending.length > 0 ? (
        <div className="ah-agr-sec">
          {heading(pendingTitle(card.pending.length), interactive ? AGR_TEXT.pendingHint : undefined)}
          <div className="ah-agr-decide">
            {pendingShown.map(item => pendingItemNode(item, selectedOptionOf(item, picked, locked), interactive, disabled, onPick))}
          </div>
          {condensed && plan.unchangedPending > 0 ? <p className="ah-agr-hint ah-agr-unchanged">{unchangedPendingText(plan.unchangedPending)}</p> : null}
        </div>
      ) : null}
      {card.decided.length > 0 && (!condensed || plan.showDecided) ? (
        <div className="ah-agr-sec">
          {heading(decidedTitle(card.decided.length), interactive ? AGR_TEXT.decidedHint : undefined)}
          <ul className="ah-agr-decided">
            {card.decided.map((item, i) => (
              <li key={`d${i}`} className={changedClass(item).trim()}>
                <span>{item.text}</span>
                {item.memoryId !== undefined && onOpenMemory !== undefined
                  ? (() => {
                    const memoryId = item.memoryId
                    return <button type="button" className="ah-agr-basis ah-agr-basis-link" aria-label={fill(MEM_TEXT.citeLabel, item.basisLabel)}
                      onClick={() => onOpenMemory(memoryId)}>{item.basisLabel}</button>
                  })()
                  : <span className="ah-agr-basis">{item.basisLabel}</span>}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {!condensed || plan.showScope ? (
        <div className="ah-agr-split">
          <div className="ah-agr-sec">
            {heading(AGR_TEXT.scopeIn)}
            {card.scopeIn.length > 0 ? listNode(card.scopeIn, false) : <p className="ah-agr-none">{AGR_TEXT.scopeNone}</p>}
          </div>
          <div className="ah-agr-sec">
            {heading(AGR_TEXT.scopeOut)}
            {card.scopeOut.length > 0 ? listNode(card.scopeOut, false) : <p className="ah-agr-none">{AGR_TEXT.scopeNone}</p>}
          </div>
        </div>
      ) : null}
      {!condensed || plan.showDoneWhen ? (
        <div className="ah-agr-sec">
          {heading(AGR_TEXT.doneWhen, AGR_TEXT.doneWhenHint)}
          {listNode(card.doneWhen, true)}
        </div>
      ) : null}
      {/* P74r9（第二次）：对外发布这一行放在「怎样算做完」之后（它说的是验收之后的事）。
          文字由核心原样给出（launchLine），界面不改写、不自己拼；样式与卡上别的正文一致、前面不加图标；
          这一版新增、改动或去掉这一项（launchChanged 为真）时，按「本版改动」同样的做法加 ah-agr-changed 标记。
          只有一行，所以收起模式下也照常显示。launchLine 为 null（没有这一项）时整行不画。 */}
      {/* P81：发布那一行之后的一行「发布到本机文件夹：{显示路径}」，同样由核心原样给出（localDirLine），样式照发布那一行，
          与它同属一块、同样随 launchChanged 标「本版改动」；没有这一项（null 或缺省）时不画。
          P81r1：改了发布位置时再加一行「原来的位置：…」（localDirPrevLine），同一块、同样的小字样式。 */}
      {card.launchLine != null ? (
        <div className="ah-agr-sec ah-agr-launch">
          <p className={`ah-agr-one${changedClass({ changed: card.launchChanged === true })}`}>{card.launchLine}</p>
          {card.localDirLine != null ? (
            <p className={`ah-agr-one${changedClass({ changed: card.launchChanged === true })}`}>{card.localDirLine}</p>
          ) : null}
          {card.localDirPrevLine != null ? (
            <p className="ah-agr-one ah-agr-hint">{card.localDirPrevLine}</p>
          ) : null}
        </div>
      ) : null}
      {/* P76j：约定卡的「预计消耗」一段（文字全部由 core 拼好）：标题、数字加粗的 headline、
          逐步的行、依据一句、页脚小字。旧数据与没有预计的版本没有这一段（estimate 为 null 或字段不存在）。
          收起规则沿用「怎样算做完」：收紧的那一版收起时，这一段一并收起。 */}
      {card.estimate != null && (!condensed || plan.showDoneWhen) ? (
        <div className="ah-agr-sec ah-agr-estimate">
          {heading(card.estimate.title)}
          <p className="ah-agr-one ah-agr-estimate-head">
            {estimateHeadlineParts(card.estimate.headline).map((part, i) => (
              part.strong ? <strong key={`h${i}`}>{part.text}</strong> : <span key={`h${i}`}>{part.text}</span>
            ))}
          </p>
          <ul className="ah-agr-estimate-lines">
            {card.estimate.lines.map((line, i) => <li key={`e${i}`}>{line}</li>)}
          </ul>
          <p className="ah-agr-hint">{card.estimate.basisLine}</p>
          <p className="ah-agr-hint ah-agr-estimate-footer">{card.estimate.footer}</p>
        </div>
      ) : null}
      {/* P72g B3：收起了内容时，一行说明加「展开全文」；展开后整张卡和第 1 版一样完整。 */}
      {condensed && plan.anyFolded && onExpandAll !== undefined ? (
        <p className="ah-agr-hint ah-agr-unchanged">
          <span>{unchangedRestText(card.versionNo - 1)}</span>
          <button type="button" className="ah-btn ah-btn-ghost" onClick={onExpandAll}>{AGR_TEXT.expand}</button>
        </p>
      ) : null}
    </>
  )
}

/** 卡片头部：「约定」标签、标题、第 N 版、状态。 */
function headNode(card: AgreementCardView): ReactNode {
  return (
    // 用 span 而不是 div：折叠的旧版整行是一个 button，button 里只能放行内元素；样式靠 .ah-card-head 的 flex 排开。
    <span className="ah-card-head ah-agr-head">
      <span className="ah-card-type">{AGR_TEXT.tag}</span>
      <span className="ah-card-title">{card.title}</span>
      <span className="ah-agr-version">{versionText(card.versionNo)}</span>
      <span className={`ah-agr-state${card.state === 'locked' ? ' is-locked' : ''}`}>{stateLabelOf(card)}</span>
    </span>
  )
}

export function AgreementCard(props: {
  card: AgreementCardView
  /** 点「定了」的回调；不传（例如没有操作入口的只读场合）就不显示按钮。 */
  onConfirm?: ConfirmAgreement
  /** 只读：不显示「定了」，选项不可点（主题第一层「查看全文」用）。 */
  readOnly?: boolean
  /** 一开始就展开全文（主题第一层「查看全文」用）。 */
  startExpanded?: boolean
  /**
   * P75k：已定事项的出处引用了一条记忆（core 给了 memoryId）时，出处标签是链接样式的按钮，点后打开「关于你的记忆」并定位到那一条；
   * 不传（没有接线、只读场合）或这一项没有 memoryId 时，出处仍是文字。标签文字由 core 给，不在这里拼。
   */
  onOpenMemory?: (memoryId: string) => void
}): ReactNode {
  const { card } = props
  // ---------- 所有 hook 放在最前面，渲染分支都在它们之后 ----------
  const [picked, setPicked] = useState<AgreementChoices>(() => initialChoices(card))
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(props.startExpanded === true)
  const [stampAnim, setStampAnim] = useState(false)
  /** 上一次渲染时的版本状态：用来认出「由待确认变成已固定」的那一刻。 */
  const prevState = useRef<AgreementCardView['state']>(card.state)
  useEffect(() => {
    try {
      const play = shouldPlayStamp(prevState.current, card.state, prefersReducedMotion())
      prevState.current = card.state
      if (play) setStampAnim(true)
    } catch { /* 动效判断失败只是不播动画，不影响卡片。 */ }
  }, [card.state])

  /** 选了某项：只改本卡的选择，真正提交在点「定了」时。 */
  const pick = (key: string, option: string): void => {
    setPicked(current => ({ ...current, [key]: option }))
  }

  /** 点「定了」：禁用按钮、交给上层；失败复位并显示原因，成功保持禁用（视图刷新后卡片变成已固定）。 */
  const confirm = (): void => {
    if (submitting || props.onConfirm === undefined) return
    setSubmitting(true)
    setError(null)
    void props.onConfirm(card.agreementId, card.versionNo, submitChoices(card, picked))
      .then(failure => { if (failure !== null) { setSubmitting(false); setError(failure) } })
      .catch(e => { setSubmitting(false); setError(e instanceof Error ? e.message : String(e)) })
  }

  const rootProps = { 'data-agreement-id': card.agreementId, 'data-version': card.versionNo }

  // ---------- 整份约定被撤下：一行 ----------
  if (card.agreementState === 'withdrawn') {
    return (
      <div className="ah-card ah-card-done ah-card-agreement ah-agr-fold" {...rootProps}>
        <div className="ah-card-head ah-agr-head">
          <span className="ah-card-type">{AGR_TEXT.tag}</span>
          <span className="ah-card-title">{card.title}</span>
          <span className="ah-agr-state">{AGR_TEXT.withdrawn}</span>
        </div>
      </div>
    )
  }

  // ---------- 被新版取代：折叠成一行，没有任何按钮，点一下展开只读全文 ----------
  if (card.state === 'superseded' || card.state === 'replaced') {
    const bodyId = `agr-body-${card.agreementId}-${card.versionNo}`
    return (
      <div className="ah-card ah-card-done ah-card-agreement ah-agr-fold" {...rootProps}>
        <button type="button" className="ah-agr-fold-row" aria-expanded={expanded} aria-controls={bodyId}
          onClick={() => setExpanded(open => !open)}>
          {headNode(card)}
        </button>
        {expanded ? <div id={bodyId} className="ah-agr-fold-body">{bodyNodes(card, picked, false, true, pick, false, null, undefined, props.onOpenMemory)}</div> : null}
      </div>
    )
  }

  // ---------- 已固定：只读，默认收起 ----------
  if (card.state === 'locked') {
    const bodyId = `agr-body-${card.agreementId}-${card.versionNo}`
    const adoption = adoptionLine(card)
    const date = stampDateText(card)
    return (
      <div className="ah-card ah-card-agreement ah-agr-locked" {...rootProps}>
        <span className={`ah-agr-seal${stampAnim ? ' is-anim' : ''}`} role="img" aria-label={AGR_TEXT.sealLabel}>
          <span className="ah-agr-seal-char" aria-hidden="true">定</span>
          {date !== '' ? <small aria-hidden="true">{date}</small> : null}
        </span>
        {headNode(card)}
        {expanded ? (
          <div id={bodyId} className="ah-agr-body">{bodyNodes(card, picked, false, true, pick, false, null, undefined, props.onOpenMemory)}</div>
        ) : (
          <p className="ah-agr-one">{card.summary.text}</p>
        )}
        <p className="ah-agr-hint">{AGR_TEXT.lockedChoice}</p>
        {adoption !== null ? <p className="ah-agr-adoption">{adoption}</p> : null}
        <div className="ah-agr-actions">
          <button type="button" className="ah-btn ah-btn-ghost" aria-expanded={expanded} aria-controls={bodyId}
            onClick={() => setExpanded(open => !open)}>{expanded ? AGR_TEXT.collapse : AGR_TEXT.expand}</button>
        </div>
      </div>
    )
  }

  // ---------- 待你确认：完整展开 ----------
  const interactive = props.readOnly !== true && card.canConfirm && props.onConfirm !== undefined
  return (
    <div className="ah-card ah-card-agreement ah-agr-pending" {...rootProps}>
      {headNode(card)}
      {bodyNodes(card, picked, interactive, submitting || !interactive, pick, true, expanded ? null : condensedPlan(card), () => setExpanded(true), props.onOpenMemory)}
      {interactive ? (
        <div className="ah-agr-actions">
          <button type="button" className="ah-btn ah-btn-primary" disabled={submitting} onClick={confirm}>{AGR_TEXT.confirm}</button>
          <p className="ah-agr-hint">{AGR_TEXT.confirmHint}</p>
          {/* P74h（B2）：总管给了不改的退路时，按钮旁一行小字（原文由 core 记下，例如「回复『不限』，我保留第 3 版」）。 */}
          {card.jobSplit?.fallback != null ? <p className="ah-agr-hint ah-job-fallback">{card.jobSplit.fallback}</p> : null}
        </div>
      ) : null}
      {error !== null ? <p className="ah-card-error" role="alert">{error}</p> : null}
    </div>
  )
}

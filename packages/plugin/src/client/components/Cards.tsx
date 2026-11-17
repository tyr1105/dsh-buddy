/**
 * 内嵌卡片：提问 / 审批 / 提议 / 告警（D06 第 4 条起按视图给的 options 渲染按钮）。
 * - 按钮文案完全来自 card.options（core 保证审批是['批准','拒绝']、提议是['接受','不做']、
 *   告警是['知道了']、提问是机器人自定的 2–4 项），点哪项就原样回传哪项；
 * - 默认选项主色填充并标注「默认」；
 * - 结果文字按状态写（D07 第 11 条）：answered「你选了：X」、expired「已过期，已按
 *   默认：X」、withdrawn「已撤回」、closed「已关闭」——不是主人作答的不冒充主人选的；
 * - 有效期带含义（D07 第 18 条）：提问「…前未答复按默认处理」、审批「…前有效，过期
 *   视为拒绝」、提议「…前未答复自动撤回」；
 * - 提交失败要看得见（D07 第 11 条）：按钮恢复可点并显示错误，自由文本草稿保留；
 *   只有成功才保持禁用。
 * 提交分流（审批用 approvalId、其他用 inboxId）在 logic/cards.ts，组件只负责展示。
 */
import { useState, type ReactNode } from 'react'
import { approvalPartsOf, cardSubmission, cardResultText, expiryMeaningOf, isAgreementCard, isApproveOption, isInboxLearnCard, isTeamCard, jobEntryKindOf, reinstateOf, REINSTATE_BUTTON_LABEL, type CardPayload } from '../logic/cards.js'
import { accessibleNameOf } from './InboxObjection.js'
import { JOB_TEXT } from '../logic/job.js'
import type { ConfirmAgreement } from './AgreementCard.js'
import type { AnswerTeamQuestion } from './TeamQuestionCard.js'
import type { TeamCommand } from './TeamCard.js'
import { ApprovalBlock } from './ApprovalBlock.js'
import { isSendEnter } from '../logic/thread.js'
import { NOTE_CHAR_LIMIT, charCountHint } from '../logic/char-count.js'
import type { UndoMemory } from './MemoryNoteRow.js'

export type { CardPayload } from '../logic/cards.js'

export const CARD_TYPE_LABELS: Readonly<Record<CardPayload['type'], string>> = {
  question: '提问', approval: '审批', proposal: '提议', alert: '告警',
}

/**
 * 卡片操作统一出口：把「点了哪张卡的哪一项（附言）」交给上层按 cardSubmission 分流。
 * 返回 Promise<错误文字 | null>（D07 第 11 条）：失败时卡片要显示原因并复位按钮。
 */
export interface CardActions {
  onPick(card: CardPayload, option: string, note?: string): Promise<string | null>
  /**
   * P72：约定卡上点「定了」（agreementId、版本号、每个待定项的选择）。
   * 可选：没有接线的场合（旧调用方、测试里的假动作）约定卡不显示「定了」按钮。
   * 返回错误文字或 null，规则同 onPick。
   */
  onConfirmAgreement?: ConfirmAgreement
  /**
   * P73e：三问卡的回答、组队卡的编辑与确认、三问第二问的选择文件夹。
   * 都可选：没有接线的场合（旧调用方、测试里的假动作）线程里只显示总管那句话，不显示卡片。
   * 三个命令都返回错误文字或 null，规则同 onPick。
   */
  onAnswerTeamQuestion?: AnswerTeamQuestion
  onEditTeamCandidate?: TeamCommand
  onConfirmTeam?: TeamCommand
  pickFolder?: () => Promise<string | null>
  /**
   * P75k：消息下面「已记住」「已删除」「已更正」一行上的「撤销」（按动作调 undoMemory、undoDeleteMemory、undoCorrectMemory）。
   * 可选：没有接线的场合（旧调用方、测试里的假动作）这一行照样显示，只是没有「撤销」按钮。返回错误文字或 null，规则同 onPick。
   */
  onUndoMemory?: UndoMemory
  /** P75k：约定卡已定事项的出处（带 memoryId 时是按钮）：打开记忆页并定位到那一条。没有接线时出处仍是文字。 */
  onOpenMemory?: (memoryId: string) => void
}

export function InboxCard(props: {
  card: CardPayload
  actions: CardActions
  busy: boolean
  /** 收件箱平铺后，紧急程度只由卡片自己的标签表达；线程内卡片不传。 */
  priority?: 'P0' | 'P1' | 'P2'
  /** P79：放在按钮行末尾的次要按钮（要修改、有不符），由「待你处理」的条目传入；线程内卡片不传。 */
  extra?: ReactNode
}): ReactNode {
  const c = props.card
  const [picked, setPicked] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [freeText, setFreeText] = useState('')
  const [note, setNote] = useState('')
  const [rejectingGoal, setRejectingGoal] = useState(false)
  // P69：新审批记录带结构化内容，按「一句话 / 原因 / 风险 / 收起的原始命令」显示；旧记录为 null，照旧显示标题和正文。
  const approvalParts = approvalPartsOf(c)
  // P74i-m1（第二次，任务卡 1.4）：中心作废的审批状态写「已作废」，不写「已过期」「已拒绝」，也没有按钮。
  const voided = approvalParts !== null && approvalParts.voided
  const resultText = voided ? JOB_TEXT.approvalVoided : cardResultText(c)
  // P74r20（第 3 节第 3 条）：已作废的审批卡在状态词下一行写作废的原因。核心（P74r19）把原因记在条目的答复栏里
  // （「执行者提交了新的发布命令」「这件事的发布已结束」等），卡片状态是已撤回；没有这段文字（旧记录、状态不是已撤回）就不显示。
  // 只认已撤回：旧写法的作废卡状态是已过期，答复栏里可能是到期时按默认记下的「拒绝」，不是原因。
  const voidedReason = voided && c.status === 'withdrawn' && typeof c.answer === 'string' && c.answer.trim() !== '' ? c.answer : null
  const answered = resultText !== null
  // P72：约定确认条目只有「按建议，定了」一个按钮，没有自由文本输入，按钮不加「（默认）」字样。
  const agreement = isAgreementCard(c)
  // P73e：组队确认条目同样只有一个按钮：文字取条目的 options[0]，没有自由文本，没有「（默认）」字样。
  const team = isTeamCard(c)
  // P74i：一件事的四类条目（验收、向主人说明、回合上限、停住了）都只有按钮、没有自由文本，
  // 按钮文字全部取条目的 options（不写死数字）；都没有期限，expiryMeaningOf 对它们返回 null。
  const jobKind = jobEntryKindOf(c)
  // P74i-m7：「员工被中心停用」的告警条目带恢复入口时，「知道了」旁多一个「恢复在岗」按钮（次要的样子，「知道了」是主要的样子）。
  const reinstate = reinstateOf(c)
  // P75k：学习选会话的提问卡（教它技能改为对总管说之后，总管问「学哪一段会话」）：正文按行显示（第二行说明会话交给谁阅读），
  // 选项是会话标题、整行可点、原样显示，没有默认项、没有到期说明、没有自由文本（回答必须是其中一项）。
  const learn = typeof c.learnRunId === 'string' && c.learnRunId !== ''
  const busy = props.busy || picked !== null

  /** 点了某个选项：记下禁用并按提交规则交给上层；失败复位按钮并显示原因。 */
  const pick = (option: string): void => {
    setPicked(option)
    setError(null)
    // P79：提议和审批一样可以附一句话（可不填）；点「接受」「不做」时都把附言交出去（可以为空）。
    void props.actions.onPick(c, option, c.type === 'approval' || c.type === 'proposal' ? note : undefined)
      .then(failure => { if (failure !== null) { setPicked(null); setError(failure) } })
      .catch(e => { setPicked(null); setError(e instanceof Error ? e.message : String(e)) })
  }

  return (
    <div className={`ah-card ah-card-${c.type}${answered ? ' ah-card-done' : ''}${learn ? ' ah-card-learn' : ''}`} data-answered={answered ? 'true' : 'false'}>
      <div className="ah-card-head">
        <span className="ah-card-type">{CARD_TYPE_LABELS[c.type]}</span>
        {props.priority ? <span className={`ah-card-priority ah-card-priority-${props.priority.toLowerCase()}`}>{props.priority}</span> : null}
        {/* 新审批卡的标题就是下面块里的第一行那句话，头部不再重复；旧记录照旧显示标题。 */}
        {approvalParts === null ? <span className="ah-card-title">{c.title}</span> : null}
      </div>
      {approvalParts !== null
        ? <ApprovalBlock approval={approvalParts} idBase={c.inboxId} />
        : learn
          // 学习选会话卡：正文有两行，各占一段（第一行是主人交代的话，第二行说明选中的会话交给谁阅读）。
          ? <div className="ah-card-body">{c.body.split('\n').filter(line => line.trim() !== '').map((line, index) => <p key={index}>{line}</p>)}</div>
          : <p className="ah-card-body">{c.body}</p>}
      {/* P74i-m2（第四次审查中-3）：卡片已经有结果（已批准、已拒绝、已过期、已作废等，不再等主人处理）
          时不显示有效期那一行——「…前有效，过期视为拒绝」与「已作废」并排会被读成主人拒绝了。 */}
      {!answered && expiryMeaningOf(c) ? <p className="ah-card-expire">{expiryMeaningOf(c)}</p> : null}
      {answered ? (
        <>
          <p className="ah-card-answer">{resultText}</p>
          {voidedReason !== null ? <p className="ah-card-answer-why">{voidedReason}</p> : null}
        </>
      ) : (
        <>
          <div className={`ah-card-options${learn ? ' ah-card-options-rows' : ''}`}>
            {/* 全部按钮按视图 options 渲染：审批的「批准」主色、「拒绝」警示色，其余默认项主色。
                P74i-m1（第二次，任务卡 1.4）：发布审批（launch 为真）的按钮写「批准发布」「暂不发布」，
                只换显示文字，提交仍是原来的批准、拒绝两个动作（pick 传原始选项）。 */}
            {!rejectingGoal && c.options.map(option => (
              <button key={option} type="button"
                className={c.type === 'approval'
                  ? (isApproveOption(option) ? 'ah-btn ah-btn-primary' : 'ah-btn ah-btn-danger')
                  // P74i-m5（第 6 节第 2 条）：验收条目的「验收通过」是主要按钮，与旁边次要样子的「有不符」分得出主次
                  // （约定确认、组队确认条目上「按建议，定了」与「要修改」本来就是这样）。
                  // P74i-m7：带恢复入口的告警条目上，「知道了」是主要按钮，与旁边次要样子的「恢复在岗」分得出主次。
                  : learn ? 'ah-btn ah-card-option-row'
                    : agreement || team || jobKind === 'accept' || reinstate !== null || option === c.defaultOption ? 'ah-btn ah-btn-primary' : 'ah-btn'}
                disabled={busy}
                onClick={() => c.goalId && option === '未通过' ? setRejectingGoal(true) : pick(option)}>
                {approvalParts !== null && approvalParts.launch && c.type === 'approval'
                  ? (isApproveOption(option) ? JOB_TEXT.approvalLaunchApprove : JOB_TEXT.approvalLaunchDecline)
                  : option}{option === c.defaultOption && c.type !== 'approval' && !agreement && !team ? '（默认）' : ''}
              </button>
            ))}
            {/* P74i-m7：恢复在岗：答复传视图给的 answer（reinstate），走与其他条目相同的提交路径（answerInbox）；
                处理中（picked 或上层 busy）与「知道了」一起禁用；失败时下面的错误行显示核心返回的原文，条目不动；
                可达名称带条目标题（同一页有多条告警时分得清），界面上显示的文字不变；不加二次确认。 */}
            {!rejectingGoal && reinstate !== null ? (
              <button type="button" className="ah-btn" aria-label={accessibleNameOf(REINSTATE_BUTTON_LABEL, c.title)}
                disabled={busy} onClick={() => pick(reinstate.answer)}>{REINSTATE_BUTTON_LABEL}</button>
            ) : null}
            {/* P79：次要按钮（要修改、有不符）紧跟在确认按钮后面。 */}
            {!rejectingGoal ? props.extra : null}
          </div>
          {rejectingGoal ? (
            <div className="ah-card-options" aria-label="验收未通过原因">
              {['没做', '做错', '不符预期', '未通过'].map(reason => (
                <button key={reason} type="button" className="ah-btn" disabled={busy} onClick={() => pick(reason === '不符预期' ? '不是你要的' : reason)}>{reason}</button>
              ))}
              <button type="button" className="ah-btn ah-btn-ghost" disabled={busy} onClick={() => setRejectingGoal(false)}>取消</button>
            </div>
          ) : null}
          {/* 仅有 placeholder 不构成稳定可达名称（WCAG 4.1.2）：补 aria-label，读屏直接报「审批附言」。 */}
          {c.type === 'approval' && picked === null ? (
            // P74i-m6（第 3 节）：审批附言框与提议的附言框同样处理：最多 200 个字，输入框本身不让多打；
            // 已输入到上限的九成时在输入框下面写字数，到上限时写明已到上限（普通审批与发布审批都是这个组件）。
            <>
              <input className="ah-card-note" aria-label="审批附言（可不填）" maxLength={NOTE_CHAR_LIMIT} value={note} placeholder="附一句话（可不填）" disabled={busy}
                onChange={e => setNote(e.target.value)} />
              {charCountHint(note.length, NOTE_CHAR_LIMIT) !== null
                ? <p className="ah-card-note-count" aria-live="polite">{charCountHint(note.length, NOTE_CHAR_LIMIT)}</p> : null}
            </>
          ) : null}
          {/* P79：提议的附言输入框，做法与审批的相同；可达名称与占位文字各自独立。 */}
          {c.type === 'proposal' && picked === null ? (
            // P74i-m4（第 4 节）：最多 200 个字，输入框本身不让多打（核心对超长的附言报错）。
            <>
              <input className="ah-card-note" aria-label="附言（可不填）" maxLength={NOTE_CHAR_LIMIT} value={note} placeholder="附一句话（可不填）" disabled={busy}
                onChange={e => setNote(e.target.value)} />
              {/* P74i-m5（第 5 节）：已输入到上限的九成时在输入框下面写字数，到上限时写明已到上限。 */}
              {charCountHint(note.length, NOTE_CHAR_LIMIT) !== null
                ? <p className="ah-card-note-count" aria-live="polite">{charCountHint(note.length, NOTE_CHAR_LIMIT)}</p> : null}
            </>
          ) : null}
          {/* P75r7（B7）：学习选会话卡在线程里没有自由文本（回答必须是其中一项）；在「待你处理」里保留（主人可以不选会话、自己写一句别的话，决策 DC64）。 */}
          {c.type === 'question' && !agreement && !team && (!learn || isInboxLearnCard(c)) && jobKind === null && picked === null ? (
            <div className="ah-card-freetext">
              {/* 失败后草稿保留（D07 第 11 条）：输入框回到可用状态，freeText 没被清。 */}
              {/* 同上：placeholder 只作视觉提示，可达名称由 aria-label 承担。 */}
              <input aria-label="或填写回答" value={freeText} placeholder="或填写回答" disabled={busy}
                onChange={e => setFreeText(e.target.value)}
                onKeyDown={e => {
                  // 中文输入法组合态的回车只是上屏候选词，不算发送（交互审查第 3 条）。
                  if (isSendEnter(e.nativeEvent) && freeText.trim() !== '') pick(freeText.trim())
                }} />
              <button type="button" className="ah-btn" disabled={busy || freeText.trim() === ''}
                onClick={() => pick(freeText.trim())}>发送</button>
            </div>
          ) : null}
          {error ? <p className="ah-card-error" role="alert">{error}</p> : null}
        </>
      )}
    </div>
  )
}

// 保留具名再导出，方便上层引用提交规则（也可直接 from '../logic/cards.js'）。
export { cardSubmission }

/**
 * 组队卡（P73e）：总管推荐的员工名单。你在卡上改名、换一位、不要这位、就地改性格和模型，
 * 最后点确认，员工才入职；确认前没有任何员工入职。外框沿用约定卡的样子（ah-card）。
 *
 * 数据：全部来自 core 的视图（TeamCardView）——名字、模板、四句性格、建议与已改标记、
 * 备选与置灰原因、在册人数、消耗换算、确认按钮文字、卡下说明。这里不重写任何一句，只负责画和发命令。
 * 命令：editTeamCandidate（每次编辑都带视图里的 rev）、confirmTeamProposal。
 * 改名：任务卡写的是「失焦或回车提交」，但全客户端的无障碍契约测试禁止任何失焦处理（WCAG 3.2.1），
 * 所以改成「回车，或点名字旁出现的『改名』按钮」提交；详见 docs/questions.md P73e。
 * 这些命令只改数据，不调用模型，所以卡上没有任何「正在思考」类的提示。
 *
 * 两种样子：
 * - 待确认：每位一块，带输入框和按钮；
 * - 已处理（已入职、你选择不新增、已撤下）：收起为每位一行加来历，没有任何按钮。
 *
 * 规则放在 logic/team-card.ts（命令参数、四维二选一拼类型、什么时候提交改名等，可单测）；
 * 本文件把每一块写成普通函数而不是子组件，测试渲染一次就能看到全部元素。
 */
import { useRef, useState, type ReactNode } from 'react'
import { templateById } from '@agent-hub/core/team'
import type { TeamCandidateView, TeamCardView } from '../../shared/views.js'
import { Avatar } from './Ui.js'
import { PersonalityLines } from './PersonalityLines.js'
import { isSendEnter } from '../logic/thread.js'
import {
  MBTI_AXES, TEAM_TEXT, alternateClickable, candidateEditable, confirmInput, editInput, estimateLine, failureText, fitLine,
  isPendingCard, rosterOverflow, mbtiAxisChoice, mbtiWithAxis, nameInputLabel, openEditorLabel, readonlyLine, shouldSubmitRename, swapIndexOf, templateLine,
  type TeamEditAction,
} from '../logic/team-card.js'

/** 提交一条命令：返回错误文字或 null（成功）。编辑和确认都用这个形状。 */
export type TeamCommand = (input: Record<string, unknown>) => Promise<string | null>

/** 性格、模型两栏里当前展开的是哪一栏：「候选编号:栏」。 */
type OpenPanel = `${string}:mbti` | `${string}:model` | null

export function TeamCard(props: {
  card: TeamCardView
  /** 编辑一位候选（editTeamCandidate）。 */
  onEdit: TeamCommand
  /** 确认入职（confirmTeamProposal）。 */
  onConfirm: TeamCommand
}): ReactNode {
  const { card } = props
  const pending = isPendingCard(card)
  const overflow = rosterOverflow(card)
  const [error, setError] = useState<string | null>(null)
  /** 提交中：按钮和输入框不可点，防重复点击。 */
  const [busy, setBusy] = useState(false)
  /** 同步的在途标记：状态更新是异步的，连点两下时第二下要靠它挡住。 */
  const inFlight = useRef(false)
  /** 名字输入框里还没提交的文字，按候选编号存。 */
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [panel, setPanel] = useState<OpenPanel>(null)
  /** 「换一位」下拉里已经选中、还没提交的备选序号（字符串，空串表示没选），按候选编号存。 */
  const [swapChoice, setSwapChoice] = useState<Record<string, string>>({})

  /** 提交一条命令：在途时不重复发；失败显示错误文字并复位按钮；不重试。 */
  const run = async (work: () => Promise<string | null>): Promise<string | null> => {
    if (inFlight.current) return '正在提交，请稍候'
    inFlight.current = true
    setBusy(true)
    setError(null)
    try {
      const failure = await work()
      if (failure !== null) setError(failure)
      return failure
    } catch (e) {
      const text = failureText(e)
      setError(text)
      return text
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  const edit = (candidate: TeamCandidateView, action: TeamEditAction, value?: string | number): Promise<string | null> =>
    run(() => props.onEdit(editInput(card, candidate.key, action, value)))

  /** 名字失焦或回车：与原名相同或为空不提交；失败时保留输入，方便改完再试。 */
  const commitName = async (candidate: TeamCandidateView): Promise<void> => {
    const typed = drafts[candidate.key]
    if (typed === undefined) return
    const clear = (): void => setDrafts(current => { const next = { ...current }; delete next[candidate.key]; return next })
    if (!shouldSubmitRename(candidate.name, typed)) { clear(); return }
    const failure = await edit(candidate, 'rename', typed.trim())
    if (failure === null) clear()
  }

  /** 性格或模型一栏：当前值（点开修改）、建议或已改标记、恢复按钮。 */
  const kvNode = (candidate: TeamCandidateView, kind: 'mbti' | 'model', editable: boolean): ReactNode => {
    const part = kind === 'mbti' ? candidate.personality : candidate.model
    const value = kind === 'mbti' ? candidate.personality.type : candidate.model.label
    const open = panel === `${candidate.key}:${kind}`
    return (
      <span className="ah-team-kv-item">
        <span>{kind === 'mbti' ? TEAM_TEXT.mbtiLabel : TEAM_TEXT.modelLabel}</span>
        <button type="button" className="ah-team-edit" aria-expanded={open} disabled={!editable || busy}
          aria-label={openEditorLabel(kind, candidate.name)}
          onClick={() => setPanel(open ? null : `${candidate.key}:${kind}`)}>
          <b>{value}</b>
        </button>
        <i className={`ah-team-flag${part.changed ? ' is-changed' : ''}`}>{part.changed ? TEAM_TEXT.changed : TEAM_TEXT.suggested}</i>
        {part.restoreText !== null ? (
          <button type="button" className="ah-btn ah-btn-ghost ah-team-reset" disabled={!editable || busy}
            onClick={() => void edit(candidate, kind === 'mbti' ? 'restore_mbti' : 'restore_model')}>{part.restoreText}</button>
        ) : null}
      </span>
    )
  }

  /** 性格修改面板：四个维度各二选一，选中即提交，四句话随视图刷新。 */
  const mbtiPanel = (candidate: TeamCandidateView): ReactNode => (
    <div className="ah-team-editor">
      {MBTI_AXES.map(axis => (
        <div key={axis.index} className="ah-team-axis" role="radiogroup" aria-label={axis.options.map(option => option.name).join('或')}>
          {axis.options.map(option => {
            const checked = mbtiAxisChoice(candidate.personality.type, axis.index) === option.code
            return (
              <button key={option.code} type="button" role="radio" aria-checked={checked} disabled={busy}
                className={`ah-agr-chip${checked ? ' is-selected' : ''}`}
                onClick={() => { if (!checked) void edit(candidate, 'set_mbti', mbtiWithAxis(candidate.personality.type, axis.index, option.code)) }}>
                {option.code}　{option.name}
              </button>
            )
          })}
        </div>
      ))}
    </div>
  )

  /** 模型修改面板：只在视图给的档位里二选一，不可用的不可点。 */
  const modelPanel = (candidate: TeamCandidateView): ReactNode => (
    <div className="ah-team-editor" role="radiogroup" aria-label={TEAM_TEXT.modelLabel}>
      {candidate.model.options.map(option => {
        const checked = option.tier === candidate.model.tier
        return (
          <button key={option.tier} type="button" role="radio" aria-checked={checked} disabled={busy || !option.available}
            className={`ah-agr-chip${checked ? ' is-selected' : ''}`}
            onClick={() => { if (!checked) void edit(candidate, 'set_model', option.tier) }}>
            {option.label}{option.available ? null : <em>{TEAM_TEXT.tierUnavailable}</em>}
          </button>
        )
      })}
    </div>
  )

  /** 一位候选（待确认）：名字、模板、适合做、四句性格、性格与模型、预计、换一位、不要这位。 */
  const candidateNode = (candidate: TeamCandidateView): ReactNode => {
    const editable = candidateEditable(candidate, pending)
    const template = templateById(candidate.templateId)
    const avatar = <Avatar color={template?.color ?? null} initials={candidate.avatarText} size={32} />
    if (candidate.removed) {
      // 被去掉的整块变淡：只留名字、「已选不要」和「撤销」。
      return (
        <div key={candidate.key} className="ah-team-hire is-removed" data-key={candidate.key}>
          {avatar}
          <div className="ah-team-hire-main">
            <div className="ah-team-name"><strong>{candidate.name}</strong><span className="ah-team-tpl">{templateLine(candidate)}</span></div>
            <p className="ah-team-removed">
              <span>{TEAM_TEXT.removedFlag}</span>
              <button type="button" className="ah-btn ah-btn-ghost" disabled={busy} onClick={() => void edit(candidate, 'unremove')}>{TEAM_TEXT.undo}</button>
            </p>
          </div>
        </div>
      )
    }
    return (
      <div key={candidate.key} className="ah-team-hire" data-key={candidate.key}>
        {avatar}
        <div className="ah-team-hire-main">
          <div className="ah-team-name">
            <input className="ah-team-name-input" aria-label={nameInputLabel(candidate.name)} maxLength={20}
              value={drafts[candidate.key] ?? candidate.name} disabled={busy || !editable}
              onChange={event => { const typed = event.target.value; setDrafts(current => ({ ...current, [candidate.key]: typed })) }}
              onKeyDown={event => { if (isSendEnter(event.nativeEvent ?? event)) { event.preventDefault(); void commitName(candidate) } }} />
            {/* 改名只走显式提交：回车，或名字有改动时出现的「改名」按钮。不做失焦自动提交（WCAG 3.2.1/3.2.2，见无障碍契约测试）。 */}
            {shouldSubmitRename(candidate.name, drafts[candidate.key] ?? candidate.name) ? (
              <button type="button" className="ah-btn ah-btn-ghost ah-team-rename" disabled={busy} onClick={() => void commitName(candidate)}>{TEAM_TEXT.rename}</button>
            ) : null}
            <span className="ah-team-tpl">{templateLine(candidate)}</span>
          </div>
          <p className="ah-team-fit">{fitLine(candidate)}</p>
          <PersonalityLines lines={candidate.personality.lines} label={`${TEAM_TEXT.mbtiLabel} ${candidate.personality.type}`} />
          <div className="ah-team-kv">
            {kvNode(candidate, 'mbti', editable)}
            {kvNode(candidate, 'model', editable)}
            <span className="ah-team-estimate">{estimateLine(candidate)}</span>
          </div>
          {panel === `${candidate.key}:mbti` ? mbtiPanel(candidate) : null}
          {panel === `${candidate.key}:model` ? modelPanel(candidate) : null}
          {candidate.briefChanged ? <p className="ah-team-brief">{TEAM_TEXT.briefChanged}</p> : null}
          <div className="ah-team-ops">
            {candidate.alternates.length > 0 ? (
              // P73f（设计稿场景 A3）：「换一位」是下拉，选项是事先算好的备选，不可选的置灰并写原因。
              // 选了备选后出现「换为这位」按钮才真的提交：不在选择变化时直接发命令（无障碍契约 WCAG 3.2.2，写操作只走显式按钮）。
              <span className="ah-team-swap">
                <select className="ah-team-swap-select" aria-label={TEAM_TEXT.swap} disabled={busy}
                  value={swapChoice[candidate.key] ?? ''}
                  onChange={event => { const chosen = event.target.value; setSwapChoice(current => ({ ...current, [candidate.key]: chosen })) }}>
                  <option value="">{TEAM_TEXT.swap}</option>
                  {candidate.alternates.map(alternate => (
                    <option key={alternate.index} value={String(alternate.index)} disabled={!alternateClickable(alternate)}>
                      {alternate.reason !== null ? `${alternate.label}（${alternate.reason}）` : alternate.label}
                    </option>
                  ))}
                </select>
                {swapIndexOf(candidate, swapChoice[candidate.key]) !== null ? (
                  <button type="button" className="ah-btn ah-btn-ghost" disabled={busy}
                    onClick={() => {
                      const index = swapIndexOf(candidate, swapChoice[candidate.key])
                      if (index === null) return
                      setSwapChoice(current => ({ ...current, [candidate.key]: '' }))
                      setPanel(null)
                      void edit(candidate, 'swap', index)
                    }}>{TEAM_TEXT.swapApply}</button>
                ) : null}
              </span>
            ) : null}
            {candidate.canRemove ? (
              <button type="button" className="ah-btn ah-btn-ghost" disabled={busy} onClick={() => void edit(candidate, 'remove')}>{TEAM_TEXT.remove}</button>
            ) : null}
          </div>
        </div>
      </div>
    )
  }

  /** 点确认：提交后卡片由视图刷新成只读；失败显示原因并复位按钮。 */
  const confirm = (): void => {
    // 名字改了一半没提交：不替你悄悄丢掉，也不替你悄悄提交，提示先提交再确认。
    const unsent = card.candidates.some(candidate => !candidate.removed && shouldSubmitRename(candidate.name, drafts[candidate.key] ?? candidate.name))
    if (unsent) { setError(TEAM_TEXT.renamePending); return }
    void run(() => props.onConfirm(confirmInput(card)))
  }

  return (
    <div className={`ah-card ah-card-team${pending ? ' ah-team-pending' : ' ah-team-fixed'}`} data-proposal-id={card.proposalId} data-rev={card.rev}>
      <div className="ah-card-head ah-team-head">
        <span className="ah-card-type">{TEAM_TEXT.tag}</span>
        <span className="ah-card-title">{card.title}</span>
        <span className={`ah-team-state${card.state === 'confirmed' ? ' is-ok' : ''}`}>{card.stateLabel}</span>
      </div>
      {pending
        ? card.candidates.map(candidateNode)
        : <ul className="ah-team-lines">{card.candidates.map(candidate => <li key={candidate.key} className={candidate.removed ? 'is-removed' : undefined}>{readonlyLine(candidate)}</li>)}</ul>}
      {pending ? (
        <div className="ah-team-sum" role="status">
          <span>{card.footer.rosterText}</span>
          <span>{card.footer.idleText}</span>
          <span>{card.footer.tokenText}</span>
        </div>
      ) : <p className="ah-team-sum">{card.footer.rosterText}</p>}
      {pending ? (
        <div className="ah-team-actions">
          <button type="button" className="ah-btn ah-btn-primary" disabled={busy || overflow !== null} onClick={confirm}>{card.confirmLabel}</button>
          {/* P73r4：入职后在册超过上限时按钮不可用，旁边写明原因和做法；人数回到上限内后按钮恢复。 */}
          {overflow !== null ? <p className="ah-team-note ah-team-overflow" role="status">{overflow.text}</p> : null}
          {card.note !== null ? <p className="ah-team-note">{card.note}</p> : null}
        </div>
      ) : null}
      {error !== null ? <p className="ah-card-error" role="alert">{error}</p> : null}
    </div>
  )
}

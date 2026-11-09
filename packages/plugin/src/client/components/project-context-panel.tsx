/**
 * 项目共享上下文面板与编辑弹窗（P39）。
 *
 * 为什么这样组织：项目页只负责摆事实，四段正文、待审建议与修改留痕集中在卡片里的
 * 一块面板，避免把项目卡撑成三四个并列区。面板自己不发命令，采纳/驳回/编辑都回传
 * 给项目页统一的 submit——成功轻提示、失败中文错误和刷新口径与其他操作完全一致。
 *
 * 显示纪律：四段全空且没有待审建议时不显示完整卡片，只在卡内留一行「填写」入口；
 * 归档项目只读，不给编辑与采纳按钮。正文、建议与留痕都不出现队友内部 id。
 */
import { useState, type ReactNode } from 'react'
import type { ProjectContext, ProjectViewRow } from '../../shared/views.js'
import {
  CONTEXT_BACKGROUND_MAX, CONTEXT_CONVENTIONS_MAX, CONTEXT_DECISION_MAX, CONTEXT_DECISION_TEXT_MAX,
  CONTEXT_GLOSSARY_MAX, CONTEXT_MEANING_MAX, CONTEXT_TERM_MAX,
  buildSaveProjectContextInput, contextBrief, contextDraftFrom, conventionPoints, decisionAuthor,
  validateContextDraft, type ContextDraft, type DecisionDraft, type GlossaryDraft,
} from '../logic/project-context.js'
import { DialogShell, FieldError } from './prj-dialog-shell.js'

/** 渲染四段正文（面板与「看看建议内容」共用）；空段写「还没写」，不显示空标签。 */
function ContextBody(props: { context: ProjectContext; row: ProjectViewRow }): ReactNode {
  const context = props.context
  const points = conventionPoints(context.conventions)
  return (
    <div className="ah-context-body">
      <div className="ah-context-section">
        <span className="ah-context-label">背景</span>
        {context.background.trim() !== ''
          ? <p className="ah-context-text">{context.background}</p>
          : <p className="ah-prj-meta">未填写</p>}
      </div>
      <div className="ah-context-section">
        <span className="ah-context-label">约定</span>
        {points.length > 0 ? (
          <ul className="ah-context-list">
            {points.map((point, i) => <li key={`${i}-${point}`}>{point}</li>)}
          </ul>
        ) : <p className="ah-prj-meta">未填写</p>}
      </div>
      <div className="ah-context-section">
        <span className="ah-context-label">已定决策</span>
        {context.decisions.length > 0 ? (
          <ul className="ah-context-list">
            {context.decisions.map(decision => (
              <li key={decision.id}>
                <span className="ah-context-by">{decisionAuthor(decision.by, props.row)}：</span>
                {decision.text}
              </li>
            ))}
          </ul>
        ) : <p className="ah-prj-meta">未填写</p>}
      </div>
      <div className="ah-context-section">
        <span className="ah-context-label">术语表</span>
        {context.glossary.length > 0 ? (
          <ul className="ah-context-list">
            {context.glossary.map(entry => (
              <li key={entry.term}>
                <span className="ah-tag">{entry.term}</span>
                <span className="ah-context-meaning">{entry.meaning}</span>
              </li>
            ))}
          </ul>
        ) : <p className="ah-prj-meta">未填写</p>}
      </div>
    </div>
  )
}

/** 共享上下文面板：正文、待审建议、修改留痕；没有内容时只留一行填写入口。 */
export function ProjectContextPanel(props: {
  row: ProjectViewRow
  /** 非归档项目才给编辑与采纳/驳回；归档项目只读陈列。 */
  canEdit: boolean
  busy: boolean
  onEdit: () => void
  onApprove: (proposalId: string) => void
  onReject: (proposalId: string) => void
}): ReactNode {
  const { row } = props
  const empty = row.contextEmpty
  // 四段全空且没有建议：不显示完整卡片；可编辑时只留一行入口，归档项目完全不显示。
  if (empty && row.contextProposals.length === 0) {
    if (!props.canEdit) return null
    return (
      <p className="ah-context-hint">
        共享上下文未配置。队友在项目中执行时将先读取该上下文。
        <button type="button" className="ah-btn ah-btn-ghost" disabled={props.busy} onClick={props.onEdit}>
          填写
        </button>
      </p>
    )
  }
  return (
    <section className="ah-context" aria-label="项目共享上下文">
      {/* U01 第 37 轮（1.3.1）：这一行只是已命名 section 内部的布局槽（标签+摘要+按钮），
          没有标题文本，用 header 会产生未命名地标；section.ah-context 本身已有可访问名，这里改回 div。 */}
      <div className="ah-context-head">
        <span className="ah-prj-block-label">共享上下文</span>
        <span className="ah-prj-meta">{contextBrief(row.context)}</span>
        <span className="ah-context-path" title={row.contextFilePath}>正文：{row.contextFilePath}</span>
        {props.canEdit ? (
          <button type="button" className="ah-btn ah-btn-ghost" disabled={props.busy} onClick={props.onEdit}>
            编辑
          </button>
        ) : <span className="ah-tag">只读</span>}
      </div>

      {empty ? <p className="ah-prj-meta">四段均未填写。点击「编辑」补充。</p> : <ContextBody context={row.context} row={row} />}

      {row.contextProposals.length > 0 ? (
        <div className="ah-context-proposals">
          <span className="ah-context-label">队友的修改建议（{row.contextProposals.length}）</span>
          {row.contextProposals.map(item => (
            <div key={item.proposal.id} className="ah-context-proposal">
              <div className="ah-context-proposal-main">
                <p className="ah-context-proposal-head">
                  {item.botName ?? '已删除的队友'}
                  {item.createdText !== null ? ` · ${item.createdText}` : ''}
                  {' · '}{item.summary}
                </p>
                {item.proposal.note.trim() !== ''
                  ? <p className="ah-context-text">{item.proposal.note}</p>
                  : null}
                <details className="ah-context-revisions">
                  <summary>看看建议内容</summary>
                  <ContextBody context={item.proposal.context} row={row} />
                </details>
              </div>
              {props.canEdit ? (
                <div className="ah-context-proposal-ops">
                  <button type="button" className="ah-btn ah-btn-primary" disabled={props.busy}
                    onClick={() => props.onApprove(item.proposal.id)}>采纳</button>
                  <button type="button" className="ah-btn ah-btn-ghost" disabled={props.busy}
                    onClick={() => props.onReject(item.proposal.id)}>驳回</button>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {row.contextRevisions.length > 0 ? (
        <details className="ah-context-revisions">
          <summary>修改留痕（{row.contextRevisions.length}）</summary>
          <ul className="ah-context-revision-list">
            {row.contextRevisions.slice(0, 10).map(view => (
              <li key={view.revision.id}>
                <span className="ah-context-by">{view.editorName}</span>
                <span className="ah-tag">{view.sourceLabel}</span>
                {view.timeText !== null ? <span className="ah-prj-meta">{view.timeText}</span> : null}
                <span>{view.revision.summary}</span>
                <code title={`内容哈希：${view.revision.hash}`}>#{view.hashShort}</code>
              </li>
            ))}
          </ul>
          {row.contextRevisions.length > 10
            ? <p className="ah-prj-meta">只显示最近 10 条，其余在正文文件与日志里。</p>
            : null}
        </details>
      ) : null}
    </section>
  )
}

/**
 * 上下文编辑弹窗：背景、约定、决策（可增删）、术语表（可增删）。
 * 失败时弹窗不关、输入不丢；core 的中文错误显示在外壳底部，本地校验错误显示在对应段下方。
 */
export function ProjectContextDialog(props: {
  row: ProjectViewRow
  busy: boolean
  error: string | null
  onClose: () => void
  onSubmit: (raw: Record<string, unknown>) => void
}): ReactNode {
  const [draft, setDraft] = useState<ContextDraft>(() => contextDraftFrom(props.row.context))
  const [localError, setLocalError] = useState<string | null>(null)

  /** 改任意字段都清掉上一次的本地校验错误，避免旧红字跟着新输入跑。 */
  const patch = (next: Partial<ContextDraft>): void => {
    setDraft(prev => ({ ...prev, ...next }))
    setLocalError(null)
  }
  const updateDecision = (index: number, text: string): void => {
    patch({ decisions: draft.decisions.map((item, i) => i === index ? { ...item, text } : item) })
  }
  const removeDecision = (index: number): void => {
    patch({ decisions: draft.decisions.filter((_, i) => i !== index) })
  }
  const addDecision = (): void => {
    if (draft.decisions.length >= CONTEXT_DECISION_MAX) return
    const next: DecisionDraft = { id: null, text: '' }
    patch({ decisions: [...draft.decisions, next] })
  }
  const updateGlossary = (index: number, next: Partial<GlossaryDraft>): void => {
    patch({ glossary: draft.glossary.map((item, i) => i === index ? { ...item, ...next } : item) })
  }
  const removeGlossary = (index: number): void => {
    patch({ glossary: draft.glossary.filter((_, i) => i !== index) })
  }
  const addGlossary = (): void => {
    if (draft.glossary.length >= CONTEXT_GLOSSARY_MAX) return
    const next: GlossaryDraft = { term: '', meaning: '' }
    patch({ glossary: [...draft.glossary, next] })
  }

  const submit = (): void => {
    const message = validateContextDraft(draft)
    if (message !== null) {
      setLocalError(message)
      return
    }
    props.onSubmit(buildSaveProjectContextInput(props.row.project.id, draft))
  }

  return (
    <DialogShell title={`共享上下文：${props.row.project.name}`} busy={props.busy}
      error={props.error} onClose={props.onClose}
      footer={<>
        <button type="button" className="ah-btn" disabled={props.busy} onClick={props.onClose}>取消</button>
        <button type="button" className="ah-btn ah-btn-primary" disabled={props.busy} onClick={submit}>
          {props.busy ? '保存中…' : '保存上下文'}
        </button>
      </>}>
      <div className="ah-wizard-field">
        <label>背景（≤{CONTEXT_BACKGROUND_MAX} 字）：这个项目为什么做、给谁用
          <textarea rows={3} value={draft.background} disabled={props.busy} maxLength={CONTEXT_BACKGROUND_MAX}
            autoFocus onChange={e => patch({ background: e.target.value })} />
        </label>
      </div>
      <div className="ah-wizard-field">
        <label>约定（≤{CONTEXT_CONVENTIONS_MAX} 字，一行一条）：队友执行时必须遵守的规则
          <textarea rows={4} value={draft.conventions} disabled={props.busy} maxLength={CONTEXT_CONVENTIONS_MAX}
            onChange={e => patch({ conventions: e.target.value })} />
        </label>
      </div>

      <div className="ah-wizard-field">
        <span className="ah-context-label">已定决策（{draft.decisions.length}/{CONTEXT_DECISION_MAX}）</span>
        {draft.decisions.map((decision, i) => (
          <div key={decision.id ?? `new-${i}`} className="ah-context-row">
            <input value={decision.text} disabled={props.busy} maxLength={CONTEXT_DECISION_TEXT_MAX}
              aria-label={`第 ${i + 1} 条决策`}
              onChange={e => updateDecision(i, e.target.value)} />
            <button type="button" className="ah-btn ah-btn-ghost" disabled={props.busy}
              onClick={() => removeDecision(i)}>删除</button>
          </div>
        ))}
        <button type="button" className="ah-btn ah-btn-ghost"
          disabled={props.busy || draft.decisions.length >= CONTEXT_DECISION_MAX}
          onClick={addDecision}>＋ 加一条决策</button>
      </div>

      <div className="ah-wizard-field">
        <span className="ah-context-label">术语表（{draft.glossary.length}/{CONTEXT_GLOSSARY_MAX}）</span>
        {draft.glossary.map((entry, i) => (
          <div key={`${i}-${entry.term}`} className="ah-context-row ah-context-row-glossary">
            <input value={entry.term} disabled={props.busy} maxLength={CONTEXT_TERM_MAX} placeholder="术语"
              aria-label={`第 ${i + 1} 条术语`}
              onChange={e => updateGlossary(i, { term: e.target.value })} />
            <input value={entry.meaning} disabled={props.busy} maxLength={CONTEXT_MEANING_MAX} placeholder="一句人话解释"
              aria-label={`第 ${i + 1} 条术语释义`}
              onChange={e => updateGlossary(i, { meaning: e.target.value })} />
            <button type="button" className="ah-btn ah-btn-ghost" disabled={props.busy}
              onClick={() => removeGlossary(i)}>删除</button>
          </div>
        ))}
        <button type="button" className="ah-btn ah-btn-ghost"
          disabled={props.busy || draft.glossary.length >= CONTEXT_GLOSSARY_MAX}
          onClick={addGlossary}>＋ 加一条术语</button>
      </div>

      <FieldError show={localError !== null} message={localError} />
    </DialogShell>
  )
}

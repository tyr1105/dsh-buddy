/**
 * 技能详情（P75j，设计稿场景 C 第二块）：在右侧栏里替换列表显示，顶部「返回技能库」。
 *
 * 内容：标题与当前版本时间；core 给的正文小标题（bodyTitle，写作「正文　每一句都注明出处」），每句一行、下方小字写出处；
 * 「历史版本」每行开头写「第 n 版」；
 * 「历史版本」从新到旧，当前版本标「当前」，其余有「回退到这一版」；有同类任务时画一张五列对比表，表下一句结论；
 * 收起的技能多一行说明和「放回」。
 * 所有句子（标题、正文、出处、版本说明、对比表与结论、收起说明）都是 core 生成的，这里原样显示。
 * 回退和放回都先弹确认框（沿用 ConfirmDialog），确认后调用命令，成功后重取详情；失败在确认框里显示原因，可以重试。
 * 数据与命令都经 SkillApi 传入，组件本身不发请求，测试换成替身即可；列表那边的刷新由宿主发的员工变化事件触发。
 * 键盘：打开时焦点落在「返回技能库」上；Esc 的处理在右侧栏（RightPanel）：详情打开时 Esc 先回到列表，不收起侧栏。
 */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { SkillDetailView } from '../../shared/views.js'
import {
  SKILL_COMMAND_FALLBACK_ERROR, restoreConfirmText, rollbackConfirmText, rollbackLabelOf, versionLineText, type SkillApi, type SkillConfirmText,
} from '../logic/skill-library.js'
import { stripFailureKey } from '../logic/failure-text.js'
import { ConfirmDialog } from './confirm-dialog.js'
import { RetryBox, Skeleton } from './Ui.js'

/** 确认框正在问的是哪件事。 */
type Pending = { kind: 'rollback'; versionNo: number } | { kind: 'restore' }

/** 同类任务对比表：表头五列、行按次序；「哪件事」一列允许换行，窄屏不横向溢出。 */
function CompareTable(props: { compare: NonNullable<SkillDetailView['compare']> }): ReactNode {
  const { compare } = props
  return (
    <section className="ah-skill-section" aria-label={compare.title}>
      <h4>{compare.title}</h4>
      <table className="ah-skill-compare">
        <thead><tr>{compare.headers.map(header => <th key={header} scope="col">{header}</th>)}</tr></thead>
        <tbody>
          {compare.rows.map(row => (
            <tr key={row.seqText}>
              <td>{row.seqText}</td><td>{row.title}</td><td>{row.rounds}</td><td>{row.reworks}</td><td>{row.turns}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {compare.note !== null ? <p className="ah-right-kv">{compare.note}</p> : null}
    </section>
  )
}

export function SkillDetail(props: {
  skillId: string
  api: SkillApi
  /** 这个值变了就重取详情（技能库视图更新时由右侧栏传入：员工那边有变化，详情也要跟着看最新的）。 */
  reloadKey: unknown
  onBack: () => void
}): ReactNode {
  const [view, setView] = useState<SkillDetailView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const [pending, setPending] = useState<Pending | null>(null)
  const [busy, setBusy] = useState(false)
  const [commandError, setCommandError] = useState<string | null>(null)
  const backRef = useRef<HTMLButtonElement | null>(null)

  // 取详情：技能、重试次数或技能库视图变化时重取；组件卸载或换技能后，晚到的结果丢弃。
  useEffect(() => {
    let cancelled = false
    props.api.detail(props.skillId).then(
      next => { if (!cancelled) { setView(next); setError(null) } },
      (reason: unknown) => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)) },
    )
    return () => { cancelled = true }
  }, [props.skillId, props.reloadKey, retry])

  // 打开时把焦点放在「返回技能库」上：键盘从这里继续，Esc 回到列表。
  useEffect(() => {
    try { backRef.current?.focus() } catch { /* 取不到元素时不影响显示 */ }
  }, [props.skillId])

  // 确认框关闭之后：触发它的按钮可能已经不存在（回退成功后它变成「当前」），确认框把焦点还回去落了空，
  // 焦点掉到页面上，Esc 就到不了右侧栏。这时把焦点放回「返回技能库」（确认框自己的还原先执行，这个 effect 在它之后）。
  const hadDialog = useRef(false)
  useEffect(() => {
    if (pending !== null) { hadDialog.current = true; return }
    if (!hadDialog.current) return
    hadDialog.current = false
    // 确认框还原焦点的时机在这个 effect 之后（浏览器里实测），所以延后一拍再看焦点在哪。
    const timer = setTimeout(() => {
      try {
        if (document.activeElement === null || document.activeElement === document.body) backRef.current?.focus()
      } catch { /* 取不到元素时不影响显示 */ }
    }, 80)
    return () => clearTimeout(timer)
  }, [pending])

  /** 确认框的文字：按正在问的事和当前详情拼出（文字规则在 logic/skill-library.ts）。 */
  const confirmText = (): SkillConfirmText | null => {
    if (pending === null || view === null) return null
    return pending.kind === 'rollback' ? rollbackConfirmText(view.title, pending.versionNo) : restoreConfirmText(view.title)
  }

  /** 点确认：调用命令；成功就关掉确认框并重取详情，失败把原因留在确认框里。 */
  const confirm = async (): Promise<void> => {
    if (pending === null || busy) return
    setBusy(true)
    setCommandError(null)
    try {
      const result = pending.kind === 'rollback'
        ? await props.api.rollback(props.skillId, pending.versionNo)
        : await props.api.restore(props.skillId)
      if (result.ok) {
        setPending(null)
        setRetry(count => count + 1)
      } else {
        // P75r7（B10）：失败原因开头如果带英文键名（「skillId：……」）先去掉再给主人看。
        setCommandError(stripFailureKey(result.error ?? SKILL_COMMAND_FALLBACK_ERROR))
      }
    } catch (reason) {
      setCommandError(reason instanceof Error ? stripFailureKey(reason.message) : SKILL_COMMAND_FALLBACK_ERROR)
    } finally {
      setBusy(false)
    }
  }

  const dialog = confirmText()
  return (
    <div className="ah-skill-detail">
      <button type="button" ref={backRef} className="ah-btn ah-btn-ghost ah-skill-back" onClick={props.onBack}>返回技能库</button>
      {view === null ? (error !== null ? <RetryBox message={error} onRetry={() => setRetry(count => count + 1)} /> : <Skeleton rows={4} />) : (
        <>
          <h3 className="ah-skill-detail-title">{view.title}</h3>
          <p className="ah-right-kv">{view.headText}</p>
          {view.stateText !== null ? (
            <div className="ah-skill-state">
              <p className="ah-right-kv">{view.stateText}</p>
              {view.canRestore ? <button type="button" className="ah-btn" onClick={() => { setCommandError(null); setPending({ kind: 'restore' }) }}>放回</button> : null}
            </div>
          ) : null}
          <section className="ah-skill-section" aria-label={view.bodyTitle}>
            <h4>{view.bodyTitle}</h4>
            <ol className="ah-skill-sentences">
              {view.sentences.map((sentence, index) => (
                <li key={`${index}-${sentence.text}`}>
                  <p>{sentence.text}</p>
                  <p className="ah-right-kv ah-skill-source">{sentence.sourceText}</p>
                </li>
              ))}
            </ol>
          </section>
          <section className="ah-skill-section" aria-label="历史版本">
            <h4>历史版本</h4>
            <ul className="ah-skill-versions">
              {view.versions.map(version => (
                <li key={version.no} className="ah-skill-version">
                  {/* P75r7（B5）：每一行开头写「第 n 版」，主人不用自己数行就能对上确认框里问的版本。 */}
                  <span className="ah-skill-version-text">{versionLineText(version.no, version.text)}</span>
                  {version.current ? <span className="ah-tag ah-tag-entry">当前</span> : null}
                  {version.canRollback ? (
                    <button type="button" className="ah-btn" aria-label={rollbackLabelOf(version.no)}
                      onClick={() => { setCommandError(null); setPending({ kind: 'rollback', versionNo: version.no }) }}>回退到这一版</button>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
          {view.compare !== null ? <CompareTable compare={view.compare} /> : null}
        </>
      )}
      {dialog !== null ? (
        <ConfirmDialog title={dialog.title} text={dialog.text} confirmText={dialog.confirmText} tone="primary"
          busy={busy} error={commandError} onCancel={() => { setPending(null); setCommandError(null) }} onConfirm={() => { void confirm() }} />
      ) : null}
    </div>
  )
}

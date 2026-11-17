/**
 * 三问卡（P73e）：总管初始化时问你的三个固定问题，一问一张，点选回答。
 *
 * 结构：问题正文是总管消息气泡（由线程负责画，沿用普通消息样式），这里只画气泡下面的部分——
 * 一组选项按钮（沿用提问卡的 ah-card-options）、按钮下一行说明、失败时的错误文字。
 * 全部文字（选项、说明、建议项）来自 core 的视图（TeamQuestionView），这里不重写；
 * 点选发出的命令是 answerTeamQuestion，不调用模型。
 *
 * 状态：
 * - 已答：按钮全部不可点，选中项保持高亮；当前问以外的问题也不可点（视图的 current 决定）；
 * - 第二问的「有」：先弹出选择文件夹，拿到路径才发命令；
 *   选择器不可用、出错、没有返回结果（含你关掉窗口）、或长时间不返回时，卡下写一句提示，
 *   这一问保持等待回答，你可以再点一次，或在输入框里写出完整路径（P73r4）；
 * - 命令失败：卡下显示错误文字，按钮恢复可点。
 */
import { useRef, useState, type ReactNode } from 'react'
import type { TeamQuestionView } from '../../shared/views.js'
import { TEAM_TEXT, answerInput, failureText, needsFolder, questionGroupLabel } from '../logic/team-card.js'

/** 选择文件夹的窗口多久没有返回就先给出提示（毫秒）；窗口开着时只是多一行字，不会取消等待。 */
export const FOLDER_WAIT_MS = 15000

/** 提交一次回答：返回错误文字或 null（成功）。 */
export type AnswerTeamQuestion = (input: Record<string, unknown>) => Promise<string | null>

export function TeamQuestionCard(props: {
  question: TeamQuestionView
  onAnswer: AnswerTeamQuestion
  /** 选择文件夹：返回路径，取消返回 null，环境不支持时抛错。不传按「不可用」处理。 */
  pickFolder?: () => Promise<string | null>
}): ReactNode {
  const q = props.question
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** 选择文件夹的点选序号：每点一次加 1，迟到的旧结果据此丢弃。 */
  const pickToken = useRef(0)

  /** 点选一个选项：需要文件夹的先选文件夹；提交期间按钮不可点，失败后复位。 */
  const pick = async (value: string): Promise<void> => {
    if (busy || !q.current) return
    setError(null)
    let folderPath: string | undefined
    if (needsFolder(q, value)) {
      if (props.pickFolder === undefined) { setError(TEAM_TEXT.folderUnavailable); return }
      // P73r4：只认最近一次点选的结果；窗口一直不返回时，你再点一次不会和上一次的迟到结果混在一起。
      pickToken.current += 1
      const myToken = pickToken.current
      // 窗口打不开、请求一直不返回（网页沙箱里出现过）：过一会儿给出提示，但仍继续等；之后若返回了路径照常使用。
      const hangTimer = setTimeout(() => { if (pickToken.current === myToken) setError(TEAM_TEXT.folderUnavailable) }, FOLDER_WAIT_MS)
      let picked: string | null | undefined
      try {
        picked = await props.pickFolder()
      } catch {
        picked = null
      } finally {
        clearTimeout(hangTimer)
      }
      if (pickToken.current !== myToken) return
      // 能力不可用、调用出错、没有返回结果（含你关掉窗口）：写一行提示，这一问保持等待回答，可重新点选或打字。
      if (typeof picked !== 'string' || picked.trim() === '') { setError(TEAM_TEXT.folderUnavailable); return }
      setError(null)
      folderPath = picked
    }
    setBusy(true)
    try {
      const failure = await props.onAnswer(answerInput(q, value, folderPath))
      if (failure !== null) setError(failure)
    } catch (e) {
      setError(failureText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ah-team-q" data-setup-id={q.setupId} data-step={q.step}>
      <div className="ah-card-options" role="group" aria-label={questionGroupLabel(q.step)}>
        {q.options.map(option => {
          // 已答的问题里，选中项保持高亮（视图给出的是选中项的文字）。
          const chosen = q.answered && q.chosenLabel === option.label
          return (
            <button key={option.value} type="button" className={`ah-btn${chosen ? ' ah-btn-primary' : ''}`}
              aria-pressed={chosen} disabled={!q.current || busy}
              onClick={() => void pick(option.value)}>
              {option.label}{option.suggested ? <em className="ah-team-flag">{TEAM_TEXT.suggested}</em> : null}
            </button>
          )
        })}
      </div>
      <p className="ah-team-note">{q.note}</p>
      {error !== null ? <p className="ah-card-error" role="alert">{error}</p> : null}
    </div>
  )
}

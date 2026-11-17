/**
 * 进度行（P74h，设计稿场景 A）：约定面板底部的两到三行——
 * 上半是步骤条（四步或五步：对齐、执行、核对、你验收、发布），
 * 第二行「现在 / 在等 / 交付」；P76j 起有消耗时第三行「消耗」。
 *
 * 完全照 core 的 JobProgressView 画，不做任何判断（状态、轮次、在等谁、延迟说明、
 * 消耗文字与逐回合明细都由中心算出）。
 * 样式规则在 logic/job.ts：done 实线、current 主色加粗、stuck 警示色、todo 浅色；
 * 状态小标签的颜色按 stateTone（run 主色、you 警示色、ok 成功色），标签里有文字，不靠颜色单独表达。
 * pausedText（暂停的部分）有值时另起一行。
 *
 * P76j 第三行：有 costTurns 时这一行是一个可展开的按钮（aria-expanded），展开后每个回合一行；
 * 默认收起，再点收起；按钮本身可用键盘操作。减少动态效果时不播展开动画（CSS 里关掉过渡）。
 */
import { useState, type ReactNode } from 'react'
import type { JobProgressView } from '../../shared/views.js'
import { JOB_TEXT, stepClass, toneClass, waitingText } from '../logic/job.js'

export function JobProgress(props: { progress: JobProgressView }): ReactNode {
  const { progress } = props
  const waiting = waitingText(progress)
  // P76j：逐回合明细默认收起；没有明细（旧数据、还没记过账）时第三行只是文字，不是按钮。
  const [turnsOpen, setTurnsOpen] = useState(false)
  const costLine = progress.costLine ?? null
  const costTurns = progress.costTurns ?? []
  return (
    <div className="ah-job-progress" aria-label={JOB_TEXT.progressLabel}>
      <ol className="ah-job-steps">
        {progress.steps.map(step => (
          <li key={step.label} className={stepClass(step.state)}>{step.label}</li>
        ))}
      </ol>
      <p className="ah-job-now">
        <span>
          {JOB_TEXT.now}：
          <span className={`ah-job-state ${toneClass(progress.stateTone)}`}>{progress.stateLabel}</span>
          {progress.roundText !== null ? `　${progress.roundText}` : null}
        </span>
        {waiting !== null ? <span>{waiting}</span> : null}
        <span>{JOB_TEXT.due}：{progress.dueText}</span>
      </p>
      {progress.pausedText !== null ? <p className="ah-job-paused">{progress.pausedText}</p> : null}
      {costLine === null ? null : costTurns.length === 0 ? (
        <p className="ah-job-cost">{costLine}</p>
      ) : (
        <>
          <button type="button" className="ah-job-cost ah-job-cost-toggle" aria-expanded={turnsOpen}
            onClick={() => setTurnsOpen(open => !open)}>
            <span>{costLine}</span>
            <span className="ah-job-cost-hint">{turnsOpen ? JOB_TEXT.costCollapse : JOB_TEXT.costExpand}</span>
          </button>
          {turnsOpen ? (
            <ul className="ah-job-cost-turns">
              {costTurns.map((turn, index) => (
                <li key={`${turn.at}-${index}`}>
                  <span>{turn.at}</span><span>{turn.who}</span><span>{turn.step}</span><span>{turn.tokens}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}
    </div>
  )
}

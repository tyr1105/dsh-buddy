/**
 * 右栏「目标」分区（从 RightPanel 抽出，给主文件压到 400 行以内）：
 * - 完成待验收的目标显示「验收通过 / 没过」，让主人给结果；
 * - 进行中的目标可以放弃，但放弃不可撤销，所以先换成就地二次确认
 *   （「确认放弃 / 再想想」），避免一次误点丢掉目标——可预期、可反悔原则；
 * - 确认态是组件内部状态，父组件用 key={botId} 挂载，切换队友时自然重置，
 *   不会把 A 的确认态带到 B 身上。
 * 键盘约定（U01 第 10 轮）：确认条一展开默认焦点在安全按钮（再想想 / 取消），
 * 回车不毁数据；Esc 等于点安全按钮，且焦点还给「放弃 / 没过」触发按钮。
 */
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { BotView } from '../../shared/views.js'
import { Section } from './right-section.js'
import { useReturnFocus } from './use-inline-edit-focus.js'

export function GoalSection(props: {
  goals: BotView['goals']
  /** 命令进行中：禁用所有按钮，防止重复提交。 */
  busy: boolean
  /** 关闭目标：outcome=true 验收通过、false 验收没过、'abandoned' 放弃。 */
  onCloseGoal: (id: string, outcome: boolean | 'abandoned' | 'not_done' | 'incorrect' | 'mismatch') => Promise<boolean>
}): ReactNode {
  /** 当前处于二次确认态的目标 id；null 表示没有展开任何确认。 */
  const [confirmAbandon, setConfirmAbandon] = useState<string | null>(null)
  const [rejectingGoal, setRejectingGoal] = useState<string | null>(null)

  /* 确认条关闭（确认或取消）后，焦点还给打开它的触发按钮；触发按钮随状态消失则跳过。 */
  const abandonFocus = useReturnFocus(confirmAbandon)
  const rejectFocus = useReturnFocus(rejectingGoal)
  /* 确认条展开时要预聚焦的安全按钮：放弃流程是「再想想」，验收驳回流程是「取消」。 */
  const abandonSafeRefs = useRef(new Map<string, HTMLButtonElement>())
  const rejectSafeRefs = useRef(new Map<string, HTMLButtonElement>())
  const prevAbandonRef = useRef<string | null>(confirmAbandon)
  const prevRejectRef = useRef<string | null>(rejectingGoal)
  useEffect(() => {
    if (confirmAbandon !== null && prevAbandonRef.current !== confirmAbandon) {
      abandonSafeRefs.current.get(confirmAbandon)?.focus()
    }
    prevAbandonRef.current = confirmAbandon
  }, [confirmAbandon])
  useEffect(() => {
    if (rejectingGoal !== null && prevRejectRef.current !== rejectingGoal) {
      rejectSafeRefs.current.get(rejectingGoal)?.focus()
    }
    prevRejectRef.current = rejectingGoal
  }, [rejectingGoal])

  /** 确认条上的 Esc 只收确认条（stopPropagation 防止冒泡成整栏收起）；提交中不响应。 */
  const onOpsKeyDown = (event: KeyboardEvent, goalId: string): void => {
    if (event.key !== 'Escape' || props.busy) return
    if (confirmAbandon === goalId) {
      event.preventDefault(); event.stopPropagation(); setConfirmAbandon(null)
    } else if (rejectingGoal === goalId) {
      event.preventDefault(); event.stopPropagation(); setRejectingGoal(null)
    }
  }
  const refOf = (map: Map<string, HTMLButtonElement>, id: string) => (el: HTMLButtonElement | null): void => {
    if (el) map.set(id, el)
    else map.delete(id)
  }

  return (
    <Section title="目标">
      {props.goals.length === 0 ? <p className="ah-empty">暂无目标。请在对话中说明目标。</p> : (
        <ul className="ah-edit-list">
          {props.goals.map(g => (
            <li key={g.id}>
              <span><strong>{g.title}</strong>（{g.periodText}）<br />{g.statusLabel}{g.lastProgressText ? ` · ${g.lastProgressText}` : ''}
                <br />完成标准：{g.doneWhen}{g.checkText ? <><br />{g.checkText}</> : null}</span>
              <span className="ah-edit-ops" onKeyDown={event => onOpsKeyDown(event, g.id)}>
                {g.status === 'done_pending_check' ? (
                  <>
                    <button type="button" className="ah-btn ah-btn-primary" disabled={props.busy} onClick={() => void props.onCloseGoal(g.id, true)}>验收通过</button>
                    {rejectingGoal === g.id ? (
                      <>
                        {([['not_done', '没做'], ['incorrect', '做错'], ['mismatch', '不符预期']] as const).map(([outcome, label]) => (
                          <button key={outcome} type="button" className="ah-btn" disabled={props.busy}
                            onClick={() => void props.onCloseGoal(g.id, outcome)}>{label}</button>
                        ))}
                        <button type="button" className="ah-btn ah-btn-ghost" disabled={props.busy}
                          ref={refOf(rejectSafeRefs.current, g.id)}
                          onClick={() => setRejectingGoal(null)}>取消</button>
                      </>
                    ) : <button type="button" className="ah-btn" disabled={props.busy}
                      ref={rejectFocus.registerTrigger(g.id)}
                      onClick={() => setRejectingGoal(g.id)}>没过</button>}
                  </>
                ) : g.status === 'active' ? (
                  /* 放弃无法撤销：先换成就地二次确认，确认后才发命令。 */
                  confirmAbandon === g.id ? (
                    <>
                      <button type="button" className="ah-btn ah-btn-danger" disabled={props.busy}
                        onClick={() => { setConfirmAbandon(null); void props.onCloseGoal(g.id, 'abandoned') }}>确认放弃</button>
                      <button type="button" className="ah-btn ah-btn-ghost" disabled={props.busy}
                        ref={refOf(abandonSafeRefs.current, g.id)}
                        onClick={() => setConfirmAbandon(null)}>取消</button>
                    </>
                  ) : (
                    <button type="button" className="ah-btn ah-btn-ghost" disabled={props.busy}
                      ref={abandonFocus.registerTrigger(g.id)}
                      onClick={() => setConfirmAbandon(g.id)}>放弃</button>
                  )
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}

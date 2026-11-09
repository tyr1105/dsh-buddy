/**
 * 唤醒与账本（F02 最小读法）：在机器人详情右栏展开一次唤醒的来龙去脉。
 *
 * 为什么单独成文件：账本字段多、渲染分支多，塞进 RightPanel 会把那个文件撑过 400 行；
 * 这里只负责「列最近几条唤醒 + 展开一条看账本」，数据由 hub-state 按需拉取。
 * 纪律（与 docs/plan/v2-transformation.md 3.1 一致）：观察到的动作与机器人自述分开显示，
 * 回填、不完整、已截断、缺某段都必须明说，不能让主人把回填当成实时观察。
 */
import { useEffect, useState, type ReactNode } from 'react'
import type { WakeLedgerView, WakeRow } from '../../shared/views.js'
import { ARTIFACT_CHECK_LABELS, RESULT_VERDICT_LABELS } from '../../shared/result-check-labels.js'

/** 「为什么醒 / 为什么没醒」里的唤醒内容区（外层折叠标题由 RightPanel 的 Section 提供）。 */
export function WakeLedgerSection(props: {
  wakes: WakeRow[]
  ledgers: Record<string, WakeLedgerView | null>
  ledgerErrors: Record<string, string>
  onLoadLedger: (wakeId: string) => void
  /** 从办公室桌上产出下钻时指定要展开的唤醒（F03）。 */
  focusWakeId?: string | null
}): ReactNode {
  const [expanded, setExpanded] = useState<string | null>(props.focusWakeId ?? null)

  // 从办公室点「桌上产出」过来时（F03）：直接展开那一次唤醒并拉账本，
  // 主人不用在右栏里再找一遍「刚才点的是哪条」。
  // 依赖只放 focusWakeId：账本缓存变化不该反复触发展开，否则主人手动收起后又会被弹开。
  useEffect(() => {
    const focus = props.focusWakeId
    if (!focus) return
    const row = props.wakes.find(wake => wake.id === focus)
    // 最近的唤醒里没有这次（项目页可以引用更早的唤醒）：仍按 wakeId 拉一次详情，
    // 详情为空就在下面照实说「没有账本记录」，不能因为不在列表里就整块不显示。
    if (row !== undefined && !row.hasLedger) return
    setExpanded(focus)
    if (props.ledgers[focus] === undefined && props.ledgerErrors[focus] === undefined) props.onLoadLedger(focus)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在 focus 变化时响应（见上）
  }, [props.focusWakeId])

  // 点开才拉账本：没拉过、也没报过错才发请求；失败后用错误块里的「重试」。
  const toggle = (wakeId: string): void => {
    if (expanded === wakeId) { setExpanded(null); return }
    setExpanded(wakeId)
    if (props.ledgers[wakeId] === undefined && props.ledgerErrors[wakeId] === undefined) props.onLoadLedger(wakeId)
  }

  const recent = props.wakes.slice(0, 6)
  // 下钻指定的唤醒若不在最近 6 条里，也补进来：否则主人点了桌上产出却看不到对应账本。
  const focusId = props.focusWakeId ?? null
  const focusRow = focusId === null ? undefined : props.wakes.find(wake => wake.id === focusId)
  if (focusRow !== undefined && !recent.some(wake => wake.id === focusRow.id)) recent.unshift(focusRow)
  // 更早的唤醒可能已经不在机器人详情的最近 50 条里：单独给它一块，按 wakeId 拉详情。
  const outsideFocusId = focusId !== null && focusRow === undefined ? focusId : null
  if (recent.length === 0 && outsideFocusId === null) return <p className="ah-empty">暂无唤醒记录。下一次唤醒后在此显示。</p>

  return (
    <ul className="ah-wake-ledger">
      {outsideFocusId !== null ? (
        <li>
          <div className="ah-wake-ledger-head">
            <span className="ah-wake-ledger-head-main">本次唤醒（不在最近列表中）</span>
          </div>
          <LedgerDetail
            wakeId={outsideFocusId}
            view={props.ledgers[outsideFocusId]}
            error={props.ledgerErrors[outsideFocusId]}
            onLoad={props.onLoadLedger}
          />
        </li>
      ) : null}
      {recent.map(wake => (
        <li key={wake.id}>
          <div className="ah-wake-ledger-head">
            <span className="ah-wake-ledger-head-main">
              {/* 进行中的唤醒亮「进行中」：主人一眼知道这条不是历史（交互审查第 4 轮）。 */}
              {wake.status === 'running' || wake.status === 'delivering'
                ? <span className="ah-ledger-badge ah-ledger-live">进行中</span> : null}
              {wake.timeText} · {wake.variantLabel}{wake.outcomeLabel ? ` · ${wake.outcomeLabel}` : ''}
            </span>
            {wake.hasLedger
              ? <button type="button" className="ah-btn ah-btn-ghost" onClick={() => toggle(wake.id)}>{expanded === wake.id ? '收起账本' : '看账本'}</button>
              : <span className="ah-right-kv">无账本记录</span>}
          </div>
          {wake.reasonText ? <p className="ah-right-kv">{wake.reasonText}</p> : null}
          {expanded === wake.id ? (
            <LedgerDetail
              wakeId={wake.id}
              view={props.ledgers[wake.id]}
              error={props.ledgerErrors[wake.id]}
              onLoad={props.onLoadLedger}
            />
          ) : null}
        </li>
      ))}
    </ul>
  )
}

/** 一条账本的详情；三种「空」要分开：还在读、没有账本、读失败。 */
function LedgerDetail(props: {
  wakeId: string
  view: WakeLedgerView | null | undefined
  error: string | undefined
  onLoad: (wakeId: string) => void
}): ReactNode {
  if (props.error !== undefined) {
    return (
      <div className="ah-ledger">
        <p>账本读取失败：{props.error}。点击「重试」；仍失败请检查 DSH 运行状态。</p>
        <button type="button" className="ah-btn ah-btn-ghost" onClick={() => props.onLoad(props.wakeId)}>重试</button>
      </div>
    )
  }
  if (props.view === undefined) return <p className="ah-ledger ah-ledger-muted">正在读取账本……</p>
  if (props.view === null) return <p className="ah-ledger ah-ledger-muted">该次唤醒无账本记录（主人直聊或旧唤醒单）。</p>

  const { entry, row } = props.view
  const view = props.view
  // 账本服务最多保留 30 条动作；按类别拆开只影响展示，不改变记录。
  const dshTools = view.actions.filter(action => action.kind === 'dsh_tool')
  const otherActions = view.actions.filter(action => action.kind !== 'dsh_tool')
  return (
    <div className="ah-ledger">
      <p className="ah-ledger-meta">
        <span className="ah-ledger-badge">{row.sourceLabel}</span>
        <span className="ah-ledger-badge">{row.completenessLabel}</span>
        {row.truncated ? <span className="ah-ledger-badge ah-ledger-warn">已截断</span> : null}
        {row.missingLabels.length > 0 ? <span className="ah-ledger-badge ah-ledger-warn">缺少：{row.missingLabels.join('、')}</span> : null}
      </p>

      {/* U01 第 37 轮（1.3.1）：账本各段是真实文档分区，标题从装饰 p 升级为 h3：
          上层是右栏 h2（机器人名），h2→h3 不跳级，读屏可按标题导航逐段跳读。 */}
      <h3 className="ah-ledger-title">为什么醒</h3>
      <p>{row.triggerKindLabel}：{row.triggerText}（评分 {row.triggerScore.toFixed(2)} / 门槛 {row.triggerThreshold.toFixed(2)}）</p>

      {view.evidence.length > 0 ? (
        <>
          <h3 className="ah-ledger-title">手里的证据</h3>
          <ul className="ah-ledger-list">
            {view.evidence.map(item => (
              <li key={`${item.kind}-${item.refId}`}>
                <span className="ah-ledger-badge">{item.kindLabel}</span>
                {item.summary}
                {/* 外部内容必须显式标出，别让主人把这些话当成指令。 */}
                {item.trust === 'trusted' ? null : <span className="ah-ledger-badge ah-ledger-warn">{item.trustLabel}</span>}
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {/* F02 过程下钻：DSH 工具单独一组，主人不用跳去 DSH 会话翻它到底调了什么。 */}
      <h3 className="ah-ledger-title">工具调用（中心观察到的）</h3>
      {dshTools.length === 0 ? <p className="ah-ledger-muted">该次唤醒无 DSH 工具调用记录（旧档、主人直聊或宿主未上报）。</p> : (
        <ul className="ah-ledger-list">
          {dshTools.map((action, i) => (
            <li key={`tool-${i}`}>
              <span className="ah-ledger-badge">{action.outcome === 'ok' ? '成功' : '失败'}</span>
              <code>{action.name}</code>{action.target ? ` → ${action.target}` : ''}
              {action.detail ? <span className="ah-ledger-muted">　{action.detail}</span> : null}
            </li>
          ))}
        </ul>
      )}

      <h3 className="ah-ledger-title">其它动作</h3>
      {otherActions.length === 0 ? <p className="ah-ledger-muted">无中心工具、出站或宿主命令动作。</p> : (
        <ul className="ah-ledger-list">
          {otherActions.map((action, i) => (
            <li key={i}>
              <span className="ah-ledger-badge">{action.kindLabel}</span>
              {action.name}{action.target ? `（${action.target}）` : ''} · {action.outcomeLabel}
              <span className="ah-ledger-badge">{action.sourceLabel}</span>
              {action.detail ? <span className="ah-ledger-muted">　{action.detail}</span> : null}
            </li>
          ))}
        </ul>
      )}

      {entry.result.refs.length > 0 ? (
        <>
          <h3 className="ah-ledger-title">结果引用</h3>
          <ul className="ah-ledger-list">
            {entry.result.refs.map((ref, i) => <li key={i}><code>{ref}</code></li>)}
          </ul>
        </>
      ) : null}

      <h3 className="ah-ledger-title">交了什么</h3>
      {entry.decision === null ? <p className="ah-ledger-muted">无交账记录（未交账或投递失败）。</p> : (
        <>
          <p>{row.outcomeLabel ?? '未记结果'}：{entry.decision.summary}</p>
          {entry.decision.blocker ? <p className="ah-ledger-muted">受阻：{entry.decision.blocker}</p> : null}
          {entry.decision.ownerQuestion ? <p className="ah-ledger-muted">问了主人：{entry.decision.ownerQuestion}</p> : null}
          {entry.decision.report || view.fullReport ? <p className="ah-ledger-muted">
            汇报{view.fullReport ? '原文' : view.fullReport === undefined ? '（账本摘要，全文未读到）' : '（账本摘要，原交账已不可读）'}：{view.fullReport ?? entry.decision.report}
          </p> : null}
        </>
      )}

      {view.verificationLabel ? (
        <p className="ah-ledger-muted">
          执行者自述验证：{view.verificationLabel}
          {entry.result.verification?.notCovered ? `；没覆盖：${entry.result.verification.notCovered}` : ''}
        </p>
      ) : null}
      <h3 className="ah-ledger-title">中心实查与主人验收</h3>
      {view.resultCheck ? (
        <>
          <p className="ah-ledger-muted">中心只核对文件存在且非空；内容是否正确、是否符合要求由主人验收。</p>
          <ul className="ah-ledger-list">
            {view.resultCheck.artifacts.map((item, index) => (
              <li key={index}>{item.where || '未给出位置'}：{ARTIFACT_CHECK_LABELS[item.status]} · {item.detail}</li>
            ))}
            {view.resultCheck.decisions.map(item => (
              <li key={item.goalId}>{RESULT_VERDICT_LABELS[item.verdict]}：{item.answer}</li>
            ))}
          </ul>
          {view.resultCheck.artifacts.length === 0 ? <p className="ah-ledger-muted">未提供可实查的交付位置。</p> : null}
          {view.resultCheck.decisions.length === 0 ? <p className="ah-ledger-muted">尚无主人验收结论。</p> : null}
        </>
      ) : <p className="ah-ledger-muted">该次交账无独立结果校验记录。</p>}
      {view.worldChanges.length > 0 ? (
        <>
          <h3 className="ah-ledger-title">执行者报告的变更</h3>
          <ul className="ah-ledger-list">
            {view.worldChanges.map((change, i) => (
              <li key={i}>{change.what}（{change.where}，{change.visibilityLabel}）</li>
            ))}
          </ul>
        </>
      ) : null}

      <p className="ah-ledger-muted">
        {row.openedText} 开账{row.sealedText ? ` · ${row.sealedText} 封存` : ' · 尚未封存'} · {row.steps} 步 · {row.tokens} tokens
      </p>
    </div>
  )
}

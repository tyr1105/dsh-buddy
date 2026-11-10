/**
 * 活动流页（顶栏入口）：全队时间线（唤醒、交账、审批、告警、交接、生命周期）。
 * 每行：时间、头像、文字；按队友与类型筛选；向下「加载更多」。
 */
import { useState, type ReactNode } from 'react'
import type { ActivityRow, ActivityView, BotCard } from '../../shared/views.js'
import { Avatar, EmptyHint, RetryBox, Skeleton } from './Ui.js'
import { ACTIVITY_KIND_LABELS, activityLine, filterActivity } from '../logic/feeds.js'

function RowView(props: { row: ActivityRow }): ReactNode {
  const r = props.row
  return (
    <li className={`ah-activity-row ah-activity-${r.kind}`}>
      <span className="ah-activity-time">{r.timeText}</span>
      {r.botName ? <Avatar color={r.botColor} initials={r.botName.slice(0, 1)} size={22} /> : <span className="ah-avatar ah-avatar-team" aria-hidden="true">中</span>}
      <span className="ah-activity-text"><span className="ah-activity-kind">{ACTIVITY_KIND_LABELS[r.kind]}</span>{r.botName ? `${r.botName}：` : ''}{activityLine(r.kind, r.text)}</span>
    </li>
  )
}

export function ActivityPane(props: {
  activity: ActivityView | null
  bots: readonly BotCard[]
  /** 首屏读不到的原因（U01 第 32 轮）：有值时在页内给「重试」，不端走整页。 */
  error: string | null
  onRetry: () => void
  onLoadMore: () => void
  /** 从别的页面点某位队友的唤醒记录进来时，替主人先筛好这位队友（P64）；普通进入不传。 */
  initialBotId?: string | null
}): ReactNode {
  const [botId, setBotId] = useState(props.initialBotId ?? '')
  const [kind, setKind] = useState<ActivityRow['kind'] | ''>('')
  // U01 第 32 轮（3.2.3/3.2.4）：①首屏加载失败时页内给一句原因加「重试」按钮——
  // 旧版只有「刷新试试」一句话，筛选条在本态不渲染，键盘和鼠标都没有出口；
  // ②这块区域的名字与顶栏导航统一叫「动态」，同一目的地不出现两个名字。
  if (!props.activity) {
    return (
      <div className="ah-activity" role="region" aria-label="动态">
        {props.error
          ? <RetryBox message={`动态读取失败：${props.error}。点击「重试」；仍失败请检查 DSH 运行状态。`} onRetry={props.onRetry} />
          : <Skeleton rows={5} />}
      </div>
    )
  }
  const rows = filterActivity(props.activity.rows, { botId: botId || null, kind: kind || null })
  /** 是否有人在筛选：无结果时要说清「是筛没了」还是「本来就没有」。 */
  const filtering = botId !== '' || kind !== ''
  return (
    <section className="ah-activity" aria-label="动态">
      {/* U01 第 37 轮（1.3.1）：本视图原来只有 section 名称没有标题元素，补页面级 h2，
          让标题导航（读屏 H 键）能落到这一屏；结构与其他页头统一走 ah-pane-heading。 */}
      <header className="ah-pane-heading"><h2>动态</h2><p>全队唤醒、交账、审批、告警与交接的时间线。</p></header>
      <div className="ah-activity-filters">
        <label>
          队友
          <select value={botId} onChange={e => setBotId(e.target.value)}>
            <option value="">全部</option>
            {props.bots.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </label>
        <label>
          类型
          <select value={kind} onChange={e => setKind(e.target.value as ActivityRow['kind'] | '')}>
            <option value="">全部</option>
            {(Object.keys(ACTIVITY_KIND_LABELS) as Array<ActivityRow['kind']>).map(k => (
              <option key={k} value={k}>{ACTIVITY_KIND_LABELS[k]}</option>
            ))}
          </select>
        </label>
        <button type="button" className="ah-btn" onClick={props.onRetry}>刷新</button>
      </div>
      {rows.length === 0 ? (
        <EmptyHint text={filtering
          ? '暂无此类动态。切换筛选或点击「刷新」。'
          : '暂无动态。下次唤醒后将在此显示判断与交账记录。'} />
      ) : (
        <ol className="ah-activity-list">
          {rows.map(row => <RowView key={row.id} row={row} />)}
        </ol>
      )}
      {props.activity.hasMore ? (
        <div className="ah-activity-more">
          <button type="button" className="ah-btn" onClick={props.onLoadMore}>加载更多</button>
        </div>
      ) : null}
    </section>
  )
}

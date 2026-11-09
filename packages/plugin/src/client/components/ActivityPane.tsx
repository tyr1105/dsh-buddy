/**
 * 活动流页（顶栏入口）：全队时间线（唤醒、交账、审批、告警、交接、生命周期）。
 * 每行：时间、头像、文字；按队友与类型筛选；向下「加载更多」。
 */
import { useState, type ReactNode } from 'react'
import type { ActivityRow, ActivityView, BotCard } from '../../shared/views.js'
import { Avatar, EmptyHint, Skeleton } from './Ui.js'
import { ACTIVITY_KIND_LABELS, filterActivity } from '../logic/feeds.js'

function RowView(props: { row: ActivityRow }): ReactNode {
  const r = props.row
  return (
    <li className={`ah-activity-row ah-activity-${r.kind}`}>
      <span className="ah-activity-time">{r.timeText}</span>
      {r.botName ? <Avatar color={r.botColor} initials={r.botName.slice(0, 1)} size={22} /> : <span className="ah-avatar ah-avatar-team" aria-hidden="true">中</span>}
      <span className="ah-activity-text"><span className="ah-activity-kind">{ACTIVITY_KIND_LABELS[r.kind]}</span>{r.botName ? `${r.botName}：` : ''}{r.text}</span>
    </li>
  )
}

export function ActivityPane(props: {
  activity: ActivityView | null
  bots: readonly BotCard[]
  loading: boolean
  onRetry: () => void
  onLoadMore: () => void
}): ReactNode {
  const [botId, setBotId] = useState('')
  const [kind, setKind] = useState<ActivityRow['kind'] | ''>('')
  if (!props.activity) return <div className="ah-activity">{props.loading ? <Skeleton rows={5} /> : <EmptyHint text="活动流还没打开。刷新试试，或者等队友们动起来。" />}</div>
  const rows = filterActivity(props.activity.rows, { botId: botId || null, kind: kind || null })
  return (
    <section className="ah-activity" aria-label="活动流">
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
        <EmptyHint text="还没有动静。下一次自查的时候，这里会出现它们的判断和交账。" />
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

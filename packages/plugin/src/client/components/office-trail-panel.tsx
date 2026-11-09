/**
 * 当日轨迹面板（P36）：点像素小人后，在右侧列出它今天的唤醒轨迹，可往前翻。
 *
 * 为什么这样设计：轨迹必须是对真实唤醒账本的复盘，不是另编一份「工作日志」。
 * 本组件只做三件事——按需读这个队友的账本行、交给 P31 的纯逻辑按本地自然日分组、
 * 把每条事件画成可点的行；点一行就打开那次唤醒的账本，界面不自己编造事件或结论。
 * 读取失败、某天没有记录、时间不可靠的条数，都如实写在面板里。
 */
import { useEffect, useState, type ReactNode } from 'react'
import type { WakeLedgerRow } from '../../shared/views.js'
import { buildOfficeTrail, officeTrailWindow, stepTrailDay } from '../logic/office-trail.js'
import { trailEventsFromWakes, utcOffsetMinutesAt } from '../logic/office.js'

export interface OfficeTrailPanelProps {
  botId: string
  botName: string
  /** 桌上产出（来自 core 投影）；没有产出时 title 为 null。 */
  deskKindLabel: string
  deskTitle: string | null
  /** 座位门口未关闭的收件箱件数（来自 core 投影）。 */
  doorCount: number
  /** 当前投影时刻：轨迹以它为「今天」，倒带时不会把未来事件算进来。 */
  now: number
  /** 中心设置时区；缺省时按本机时区分组。 */
  timezone?: string
  /** 按需读唤醒账本行（HubPage 注入现有 /wake-ledger 接口，不新增数据源）。 */
  loadRows: (botId: string) => Promise<WakeLedgerRow[]>
  /** 点一条轨迹：打开这次唤醒的账本。 */
  onOpenWake: (botId: string, wakeId: string) => void
  /** 点桌上产出（沿用办公室既有的下钻规则）。 */
  onOpenDesk: () => void
  /** 打开这位队友详情。 */
  onOpenBotDetail: () => void
  /** 打开门口对应的收件箱项。 */
  onOpenInbox: () => void
  /** 收起面板，回到房间。 */
  onClose: () => void
}

/** 读账本的三态：加载中 / 读到 / 读失败；界面按它给骨架、列表或重试。 */
type LoadPhase = 'loading' | 'ready' | 'error'

export function OfficeTrailPanel(props: OfficeTrailPanelProps): ReactNode {
  const [phase, setPhase] = useState<LoadPhase>('loading')
  const [rows, setRows] = useState<WakeLedgerRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  /** 当前看的是第几天：0=今天，1=昨天，往后依次更早。 */
  const [dayIndex, setDayIndex] = useState(0)

  // 换人、重试才重新读账本；组件内部翻页不再发请求。
  useEffect(() => {
    let cancelled = false
    setPhase('loading')
    setError(null)
    setDayIndex(0)
    const load = async (): Promise<void> => {
      try {
        const next = await props.loadRows(props.botId)
        if (cancelled) return
        setRows(next)
        setPhase('ready')
      } catch (cause) {
        if (cancelled) return
        setError(cause instanceof Error ? cause.message : '唤醒账本读取失败。点击「重试」；仍失败请检查 DSH 运行状态。')
        setPhase('error')
      }
    }
    void load()
    return () => { cancelled = true }
  }, [props.botId, props.loadRows, reloadKey])

  // 轨迹完全由 P31 的纯逻辑分组；这里只把时区偏移算出来交给它。
  const trail = buildOfficeTrail({
    events: trailEventsFromWakes(rows),
    now: props.now,
    utcOffsetMinutes: utcOffsetMinutesAt(props.now, props.timezone),
  })
  const window = officeTrailWindow(trail, dayIndex)

  return (
    <aside className="ah-trail" aria-label={`${props.botName}的当日轨迹`}>
      <header className="ah-trail-head">
        {/* U01 第 37 轮（1.3.1）：标题容器升级为真 h3，挂在办公室页 h2 之下不跳级；
            同时让 header 因地标内标题自动获得可访问名。 */}
        <h3 className="ah-trail-title">
          <strong>{props.botName}</strong>
          <span>当日轨迹</span>
        </h3>
        <button type="button" className="ah-btn ah-btn-ghost" onClick={props.onClose}>收起</button>
      </header>

      {/* 桌子与门口都直接来自 core 投影：没有产出就如实说，不拿别的东西充数。 */}
      <div className="ah-trail-facts">
        <button type="button" className="ah-trail-fact" disabled={props.deskTitle === null}
          title={props.deskTitle === null ? '桌上暂无产出' : '打开桌上的产出'}
          onClick={props.onOpenDesk}>
          <span className="ah-trail-fact-label">{props.deskKindLabel}</span>
          <span className="ah-trail-fact-text">{props.deskTitle ?? '—'}</span>
        </button>
        <button type="button" className="ah-trail-fact" disabled={props.doorCount === 0}
          title={props.doorCount === 0 ? '门口暂无待办' : '打开门口第一件事'}
          onClick={props.onOpenInbox}>
          <span className="ah-trail-fact-label">门口</span>
          <span className="ah-trail-fact-text">{props.doorCount === 0 ? '暂无待办' : `${props.doorCount} 件待办`}</span>
        </button>
      </div>

      {phase === 'loading' ? (
        <p className="ah-trail-note" role="status">正在读唤醒账本……</p>
      ) : phase === 'error' ? (
        <p className="ah-trail-error" role="alert">
          {error ?? '唤醒账本读取失败。点击「重试」；仍失败请检查 DSH 运行状态。'}
          <button type="button" className="ah-btn" onClick={() => setReloadKey(key => key + 1)}>重试</button>
        </p>
      ) : window === null ? (
        <p className="ah-trail-note">暂无轨迹。下一次唤醒后在此显示。</p>
      ) : (
        <>
          <div className="ah-trail-days">
            {/* 前翻=更早；到最早一天时按钮禁用，不越界也不循环。 */}
            <button type="button" className="ah-btn ah-btn-ghost" disabled={!window.canGoOlder}
              title="看更早的一天" onClick={() => setDayIndex(stepTrailDay(trail, window.index, 'older'))}>‹ 前翻</button>
            <span className="ah-trail-day-label">{window.day.label}</span>
            <button type="button" className="ah-btn ah-btn-ghost" disabled={!window.canGoNewer}
              title="看更新的一天" onClick={() => setDayIndex(stepTrailDay(trail, window.index, 'newer'))}>后翻 ›</button>
          </div>

          {window.day.events.length === 0 ? (
            <p className="ah-trail-note">该日暂无唤醒记录。切换其他日期查看。</p>
          ) : (
            <ol className="ah-trail-list">
              {window.day.events.map(event => (
                <li key={event.id}>
                  <button type="button" className="ah-trail-event"
                    title={`打开 ${event.timeText} 这次唤醒的账本`}
                    onClick={() => props.onOpenWake(props.botId, event.id)}>
                    <span className="ah-trail-time">{event.timeText}</span>
                    {event.kindLabel ? <span className="ah-trail-kind">{event.kindLabel}</span> : null}
                    <span className="ah-trail-text">{event.text}</span>
                  </button>
                </li>
              ))}
            </ol>
          )}

          <footer className="ah-trail-foot">
            <button type="button" className="ah-btn ah-btn-ghost" onClick={props.onOpenBotDetail}>打开队友详情</button>
            <p className="ah-trail-note">
              轨迹仅取自唤醒账本，不补充推断。
              {trail.dropped > 0 ? ` ${trail.dropped} 条时间不可靠，已丢弃。` : ''}
              {trail.truncated > 0 ? ` 更早的 ${trail.truncated} 条超出回看窗口。` : ''}
            </p>
          </footer>
        </>
      )}
    </aside>
  )
}

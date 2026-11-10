/**
 * 员工动线面板（P62，决策 DC37）：点像素小人后，从办公室页右侧展开这位队友的动线，
 * 一行一段时间，只到「空闲」「项目，事项」「完成工作，等待验收」这个颗粒度。
 *
 * 为什么这样设计：主人要的是一眼看懂「它这段时间在干嘛」，不是复盘账本。所以这里只留
 * 标题、收起、按天翻看、时间段列表和「打开对话」；桌上产出、门口待办、结果标签、账本说明
 * 全部拿掉，行也不再可点。时间段怎么算全在 logic/office-trail-timeline.ts，这里只管读数据和画。
 *
 * 宽屏是页面右侧的侧栏，窄窗是盖在上面的抽屉，差别全部由 workspace.css 的 .ah-trail 段决定；
 * 抽屉模式下的键盘和读屏规则在 use-trail-drawer.ts。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { ProjectView, WakeLedgerRow } from '../../shared/views.js'
import { officeTrailWindow, stepTrailDay } from '../logic/office-trail.js'
import { buildTrailTimeline, trailProjectsFromView, type TrailProjectInput } from '../logic/office-trail-timeline.js'
import { utcOffsetMinutesAt } from '../logic/office.js'
import { useTrailDrawer } from './use-trail-drawer.js'

/**
 * 看现在的房间时，每隔多久走一次钟（10 秒）。
 * 走钟要做两件事：一是更新「现在」，这样工作刚结束的那段空闲到了一分钟就能出现；
 * 二是看房间有没有变化，变了才重读。一次回合里事件很密，隔 10 秒合并一次，不连发请求。
 */
const TRAIL_LIVE_TICK_MS = 10_000

export interface OfficeTrailPanelProps {
  botId: string
  botName: string
  /** 房间投影的时刻：动线以它为「今天」。 */
  now: number
  /** true=看现在的房间，时钟会走、内容会自己刷新；false=倒带，时间停在所选时刻。 */
  live: boolean
  /** 中心设置时区；缺省时按本机时区分组。 */
  timezone?: string
  /** 按需读这位队友的唤醒账本行。 */
  loadRows: (botId: string) => Promise<WakeLedgerRow[]>
  /** 读项目全貌，用来判断每次唤醒属于哪个任务。 */
  loadProjects: () => Promise<ProjectView>
  /** 打开和这位队友的对话。 */
  onOpenChat: () => void
  /** 收起面板，办公室恢复全宽。 */
  onClose: () => void
}

/** 读到的内容记着是谁的：换人那一刻不把上一位的动线安在新名字下面。 */
interface LoadedTrail {
  botId: string
  rows: WakeLedgerRow[]
  projects: TrailProjectInput[]
  /** 项目信息这次没读到：行会退回「为什么醒」的说法，要跟主人说一声。 */
  projectsFailed: boolean
}

export function OfficeTrailPanel(props: OfficeTrailPanelProps): ReactNode {
  const { panelRef, scrimRef } = useTrailDrawer(props.botId)
  const [loaded, setLoaded] = useState<LoadedTrail | null>(null)
  const [failure, setFailure] = useState<{ botId: string; message: string } | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  /** 当前看的是第几天：0=今天，1=昨天，往后依次更早。 */
  const [dayIndex, setDayIndex] = useState(0)
  /** 只用来触发重新渲染，让「现在」往前走。 */
  const [, setClockTick] = useState(0)

  // HubPage 传进来的读取函数每次渲染都是新的。放进 ref，只有换人、重试、房间变化才重读，
  // 否则整页任何一次刷新都会重读，还会把翻到的日期打回今天。
  const loaders = useRef({ loadRows: props.loadRows, loadProjects: props.loadProjects })
  loaders.current = { loadRows: props.loadRows, loadProjects: props.loadProjects }

  // 房间投影的时刻只在房间有变化时更新，可能停在几小时前。看现在的房间时，
  // 从收到投影的那一刻起往前走，今天的最后一段才写得准；用中心给的时刻做基准，不依赖本机时钟。
  const arrival = useRef({ asOf: props.now, receivedAt: Date.now() })
  if (arrival.current.asOf !== props.now) arrival.current = { asOf: props.now, receivedAt: Date.now() }
  const now = props.live ? props.now + (Date.now() - arrival.current.receivedAt) : props.now
  /** 上一次读数据时房间的时刻；走钟时比对它，房间变了才重读。 */
  const loadedAsOf = useRef(props.now)

  useEffect(() => { setDayIndex(0) }, [props.botId])

  useEffect(() => {
    let cancelled = false
    loadedAsOf.current = arrival.current.asOf
    const load = async (): Promise<void> => {
      try {
        const [rows, projects] = await Promise.all([
          loaders.current.loadRows(props.botId),
          // 项目读不到不拖垮整块：动线本身还能看，只是说得粗一点。
          loaders.current.loadProjects().then(trailProjectsFromView).catch(() => null),
        ])
        if (cancelled) return
        setLoaded(previous => ({
          botId: props.botId,
          rows,
          projects: projects ?? (previous?.projects ?? []),
          projectsFailed: projects === null,
        }))
        setFailure(null)
      } catch (cause) {
        if (cancelled) return
        setFailure({
          botId: props.botId,
          message: cause instanceof Error ? cause.message : '动线读取失败。点击「重试」；仍失败请检查 DSH 运行状态。',
        })
      }
    }
    void load()
    return () => { cancelled = true }
  }, [props.botId, reloadKey])

  useEffect(() => {
    if (!props.live) return
    const timer = setInterval(() => {
      // 定时器回调必须兜底：这里出错不能影响宿主。
      try {
        setClockTick(tick => tick + 1)
        if (arrival.current.asOf !== loadedAsOf.current) setReloadKey(key => key + 1)
      } catch { /* 下一次走钟再试 */ }
    }, TRAIL_LIVE_TICK_MS)
    return () => clearInterval(timer)
  }, [props.live])

  // 还没读到这个人的内容时不算出空列表，免得先闪一句「没有记录」。
  const current = loaded?.botId === props.botId ? loaded : null
  // 已经有内容时后台重读失败不打断主人看，只有一次都没读到才显示重试。
  const failed = current === null && failure?.botId === props.botId ? failure : null
  const timeline = buildTrailTimeline({
    rows: current?.rows ?? [],
    projects: current?.projects ?? [],
    now,
    utcOffsetMinutes: utcOffsetMinutesAt(now, props.timezone),
    live: props.live,
  })
  const dayWindow = officeTrailWindow(timeline.trail, dayIndex)
  const segments = dayWindow === null ? [] : timeline.segments[dayWindow.day.key] ?? []

  const retry = (): void => {
    setFailure(null)
    setReloadKey(key => key + 1)
  }

  return (
    <>
      {/* 窄窗抽屉的遮罩，宽屏由 CSS 隐藏；点一下就收起。 */}
      <div className="ah-trail-scrim" ref={scrimRef} aria-hidden="true" onClick={props.onClose} />
      <aside className="ah-trail" ref={panelRef} tabIndex={-1} aria-label={`${props.botName}的动线`}
        onKeyDown={event => { if (event.key === 'Escape') props.onClose() }}>
        <header className="ah-trail-head">
          {/* 标题是真 h3，挂在办公室页 h2 之下不跳级；外层的 strong 只管字重。 */}
          <h3 className="ah-trail-title"><strong>{props.botName}的动线</strong></h3>
          <button type="button" className="ah-btn ah-btn-ghost" onClick={props.onClose}>收起</button>
        </header>

        {dayWindow !== null ? (
          <div className="ah-trail-days">
            {/* 前翻=更早；到头时按钮禁用，不越界也不循环。 */}
            <button type="button" className="ah-btn ah-btn-ghost" disabled={!dayWindow.canGoOlder}
              title="看更早的一天" onClick={() => setDayIndex(stepTrailDay(timeline.trail, dayWindow.index, 'older'))}>‹ 前翻</button>
            <span className="ah-trail-day-label">{dayWindow.day.label}</span>
            <button type="button" className="ah-btn ah-btn-ghost" disabled={!dayWindow.canGoNewer}
              title="看更新的一天" onClick={() => setDayIndex(stepTrailDay(timeline.trail, dayWindow.index, 'newer'))}>后翻 ›</button>
          </div>
        ) : null}

        {/* key：换人或换天时滚动位置回到顶部。tabIndex：行不再是按钮，键盘要靠这里滚动长列表。 */}
        <div className="ah-trail-scroll" key={`${props.botId}:${dayWindow?.day.key ?? ''}`}
          tabIndex={0} role="group" aria-label="时间段列表">
          {failed !== null ? (
            <p className="ah-trail-error" role="alert">
              {failed.message}
              <button type="button" className="ah-btn" onClick={retry}>重试</button>
            </p>
          ) : current === null ? (
            <p className="ah-trail-note" role="status">正在读取动线……</p>
          ) : segments.length === 0 ? (
            <p className="ah-trail-note">
              {dayWindow?.day.isToday === true ? '今天暂无活动记录。队友开工后在此显示。' : '该日暂无活动记录。可切换其他日期查看。'}
            </p>
          ) : (
            <ol className="ah-trail-list">
              {segments.map(segment => (
                <li key={segment.id} className={`ah-trail-row ah-trail-row-${segment.kind}`}>
                  {/* 全角波浪线和全角冒号是主人定的格式，整行连起来读就是「14:02～14:30：内容」。 */}
                  <span className="ah-trail-time">{segment.timeText}：</span>
                  <span className="ah-trail-text">{segment.text}</span>
                </li>
              ))}
            </ol>
          )}
          {current?.projectsFailed === true ? (
            <p className="ah-trail-note">
              项目信息读取失败，部分时段仅显示大致内容。
              <button type="button" className="ah-btn" onClick={retry}>重试</button>
            </p>
          ) : null}
        </div>

        <footer className="ah-trail-foot">
          <button type="button" className="ah-btn" onClick={props.onOpenChat}>打开对话</button>
        </footer>
      </aside>
    </>
  )
}

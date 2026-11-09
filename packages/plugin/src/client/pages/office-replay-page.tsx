/** 办公室倒带：时间轴选择历史观察；当前推送与历史选择分开，迟到请求不能改回旧选择。 */
import { useEffect, useRef, useState, type ComponentProps, type KeyboardEvent, type ReactNode } from 'react'
import type { CommandResult, OfficeReplayView } from '../../shared/views.js'
import { buildReplayTrack, nextFrameAt, previousFrameAt } from '../logic/replay-track.js'
import { OfficePage } from './OfficePage.js'

type Props = ComponentProps<typeof OfficePage> & {
  run: (name: string, input: Record<string, unknown>) => Promise<CommandResult>
}

/** 拖动时间轴时命令合并的节奏：一次拖动最多每 120ms 读一次，松手再补最终值。 */
const DRAG_THROTTLE_MS = 120

/** 时间统一使用设置时区；显示到秒，避免同一分钟多次观察看起来像同一帧。 */
function clock(at: number, timezone: string): string {
  return new Date(at).toLocaleTimeString('zh-CN', { timeZone: timezone, hour12: false })
}

export function OfficeReplayPage(props: Props): ReactNode {
  const [index, setIndex] = useState<OfficeReplayView | null>(null)
  const [selectedAt, setSelectedAt] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)
  const selection = useRef<number | null>(null)
  /** 拖动合并：定时器与最后一个未落地点，避免一次拖出几十次 officeReplay 命令。 */
  const dragTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingAt = useRef<number | null>(null)
  /** 上一轮节流已发出的时刻；松手事件丢失时，发现落点没再变就自行停摆，不永久轮询。 */
  const scheduledAt = useRef<number | null>(null)
  /** 最近一次真正发过命令的时刻，避免「点击轨道」时 onChange 与松手 commit 对同一时刻读两次。 */
  const lastLoadAt = useRef<number | null>(null)
  /** 时间轴滑块：一键跳到实际记录帧后把焦点交回滑块，键盘用户不丢位置。 */
  const scrubRef = useRef<HTMLInputElement>(null)
  const run = props.run

  /** 每个异步回调都有兜错与世代检查；退回现在或卸载后不接受迟到历史。 */
  async function load(at: number | null): Promise<void> {
    lastLoadAt.current = at
    const token = ++generation.current
    setLoading(true)
    setError(null)
    try {
      const result = await run('officeReplay', at === null ? {} : { at })
      if (token !== generation.current) return
      if (!result.ok) setError(result.error)
      else if (!result.data) setError('倒带没有返回房间记录')
      else setIndex(result.data as OfficeReplayView)
    } catch (cause) {
      if (token === generation.current) setError(cause instanceof Error ? cause.message : '倒带读取失败')
    } finally { if (token === generation.current) setLoading(false) }
  }
  // 现在模式更新索引；历史模式保留主人选中的观察，不被实时推送覆盖。
  useEffect(() => {
    if (selection.current === null) void load(null)
  }, [run, props.office?.asOf])
  // 卸载：作废在途中请求并清掉拖动节流定时器。
  useEffect(() => () => { generation.current += 1; cancelDrag() }, [])

  /** 清掉尚未发出的节流请求。 */
  function cancelDrag(): void {
    pendingAt.current = null
    scheduledAt.current = null
    if (dragTimer.current !== null) {
      clearTimeout(dragTimer.current)
      dragTimer.current = null
    }
  }

  /**
   * 拖动时节流加载：第一个点立即读（100ms 内有回应），之后每 120ms 最多一次；
   * 快速拖过几十个时刻不会发几十个命令，世代检查天然丢弃迟到响应。
   * 落点已经追上拖动位置时不再自我续期——即使松手事件意外丢失，节流也会自行停摆。
   */
  function scheduleLoad(at: number): void {
    pendingAt.current = at
    if (dragTimer.current !== null) return
    scheduledAt.current = at
    void load(at)
    dragTimer.current = setTimeout(() => {
      dragTimer.current = null
      const last = pendingAt.current
      if (last === null || last === scheduledAt.current) return
      scheduleLoad(last)
    }, DRAG_THROTTLE_MS)
  }

  /** commit=true：键盘步进或松手，取消节流并立即读最终时刻；与在途请求同时刻则不重复读。 */
  function choose(at: number | null, commit = false): void {
    try {
      selection.current = at
      setSelectedAt(at)
      if (at === null || commit) {
        cancelDrag()
        if (lastLoadAt.current !== at) void load(at)
        return
      }
      scheduleLoad(at)
    } catch { setError('时间选择失败，请重试') }
  }

  /** 时间轴键盘：左右键在「有房间记录的时刻」之间跳，Home/End 回两端，PageUp/Down 快进 15 分钟。 */
  function onScrubKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (!bounds) return
    const current = selectedAt ?? now
    let target: number | null = null
    if (event.key === 'ArrowLeft') target = previousFrameAt(bounds.frames, current)
    else if (event.key === 'ArrowRight') target = nextFrameAt(bounds.frames, current)
    else if (event.key === 'Home') target = bounds.dayStart
    else if (event.key === 'End') target = now
    else if (event.key === 'PageUp') target = Math.max(bounds.dayStart, current - 15 * 60_000)
    else if (event.key === 'PageDown') target = Math.min(now, current + 15 * 60_000)
    else return
    // 到头也要拦住原生 1ms 步移，否则拇指会悄悄挪到没有记录的时刻。
    event.preventDefault()
    if (target !== null) choose(target, true)
  }

  /**
   * 一键落到当前房间真正的记录帧：主人选的时刻往往落在两帧之间，看到的是最近一帧的
   * 房间；以前只能自己把滑块拖回去找。落点后焦点交回滑块，键盘 Tab 位置不丢；
   * 已经停在记录帧上时按钮不出现（没有动作可做）。
   */
  function jumpToRecorded(): void {
    if (!bounds || bounds.recordedAt === null) return
    choose(bounds.recordedAt, true)
    scrubRef.current?.focus()
  }

  const historical = selectedAt !== null
  const bounds = index
  const now = props.office?.asOf ?? bounds?.now ?? 0
  // 轨道刻度与断带是纯函数计算；没有 bounds 时不渲染尺子。
  const track = bounds ? buildReplayTrack(bounds.frames, bounds.dayStart, now) : null
  const pending = historical && (loading || index?.selectedAt !== selectedAt)
  const dayKey = (at: number) => new Date(at).toLocaleDateString('en-CA', { timeZone: bounds?.timezone })
  const crossedDay = historical && bounds !== null && dayKey(now) !== dayKey(bounds.now)
  /** 下钻和重试也属于宿主回调边界，错误保留在本页，不击穿桌面事件。 */
  const safeProps = { ...props,
    onOpenBot: (botId: string, wakeId?: string, artifactId?: string) => {
      try { props.onOpenBot(botId, wakeId, artifactId) } catch { setError('队友详情没有打开，请重试') }
    },
    onOpenInbox: (inboxId?: string) => {
      try { props.onOpenInbox(inboxId) } catch { setError('待办没有打开，请重试') }
    },
    onRetry: () => { try { props.onRetry() } catch { setError('办公室重试失败') } },
  }

  return (
    <div className="ah-office-replay">
      <section className="ah-replay-controls" aria-label="当天倒带">
        <div className="ah-replay-title">
          <strong>{historical ? '回看今天' : '现在的房间'}</strong>
          <span>{bounds ? `${bounds.frames.filter(frame => frame.kind === 'frame').length} 次房间观察` : '读取时间轴'}</span>
          <button type="button" className="ah-btn" disabled={!historical} onClick={() => choose(null, true)}>返回现在</button>
        </div>
        {bounds ? (
          <>
            {/* WCAG 2.5.3：外层不用 <label>——两端时间是动态读数而非字段名，包进 label 会让
                可见标签变成「00:00 22:20」与滑块 aria-label「当天回放时间」不一致；
                滑块名称由自身 aria-label 提供，当前值由 aria-valuetext 播报。 */}
            <div className="ah-replay-range">
              <span>{clock(bounds.dayStart, bounds.timezone)}</span>
              <span className="ah-replay-scrub">
                <input ref={scrubRef} type="range" aria-label="当天回放时间" min={bounds.dayStart} max={now}
                  step={1} value={selectedAt ?? now} disabled={now <= bounds.dayStart || crossedDay}
                  aria-valuetext={clock(selectedAt ?? now, bounds.timezone)}
                  onChange={event => choose(Number(event.currentTarget.value))}
                  onPointerUp={() => { if (selection.current !== null) choose(selection.current, true) }}
                  onKeyDown={onScrubKeyDown} />
                {/* 尺子：刻度=有房间观察，红色色带=没有可靠观察的时段；与滑块两端对齐。 */}
                {track ? (
                  <span className="ah-replay-ruler" aria-hidden="true">
                    {track.gaps.map(gap => (
                      <span key={gap.id} className="ah-replay-gap"
                        style={{ left: `${gap.left}%`, width: `${gap.width}%` }}
                        title={gap.reason ?? '这段时间没有可靠观察'} />
                    ))}
                    {track.ticks.map(tick => (
                      <span key={tick.id} className="ah-replay-tick" style={{ left: `${tick.left}%` }}
                        title={clock(tick.at, bounds.timezone)} />
                    ))}
                  </span>
                ) : null}
              </span>
              <span>{clock(now, bounds.timezone)}</span>
            </div>
            <p className="ah-replay-caption" aria-live="polite">
              {historical ? `选择 ${clock(selectedAt, bounds.timezone)}；` : ''}
              {historical && !pending && !error && bounds.recordedAt !== null ? (
                <>
                  实际记录 {clock(bounds.recordedAt, bounds.timezone)}。
                  {/* 看到的房间属于最近一帧：给一键落点，不用手动拖回去找；已停在帧上时不出现。 */}
                  {bounds.recordedAt !== selectedAt ? (
                    <button type="button" className="ah-btn ah-replay-jump" onClick={jumpToRecorded}>跳到该时刻</button>
                  ) : null}
                </>
              ) : '拖动选择时刻；← / → 在有房间记录的时刻之间跳。'}
              {historical ? ' 历史待办只供复盘；打开后查看当前处理状态。' : ''}
              {/* 图例解释真实轨道：历史回看时红色断带同样在屏，不能只在现在模式给说明。 */}
              {track && track.gaps.length > 0 ? (
                <span className="ah-replay-legend">
                  <i className="ah-replay-legend-gap" />没有可靠观察
                  <i className="ah-replay-legend-tick" />有房间记录
                </span>
              ) : null}
            </p>
          </>
        ) : null}
        {/*
          * 错误分级：历史模式读不到帧，所选房间无法呈现，用 alert 明确报错；
          * 现在模式下方的实时房间照常渲染，时间轴读不到不影响看现在，只能给温和的
          * status 提示并说清影响范围——红色 alert 会让人误以为整个房间坏了。
          */}
        {error ? (historical ? (
          <p className="ah-retry" role="alert">{error} <button type="button" className="ah-btn"
            onClick={() => void load(selection.current)}>重试</button></p>
        ) : (
          <p className="ah-replay-caption" role="status">时间轴暂时读不到，不影响看现在的房间。
            <button type="button" className="ah-btn" onClick={() => void load(null)}>重试</button>
          </p>
        )) : null}
      </section>
      {crossedDay ? <p className="ah-replay-empty" role="status">所选时刻已不在今天；请返回现在查看今天的时间轴。</p> : historical ? pending && !error ? (
        <p className="ah-replay-empty" role="status">正在读取所选时刻的房间……</p>
      ) : error ? null : index?.room ? (
        <OfficePage {...safeProps} office={index.room} loading={false} timezone={index.timezone} showWelcome={false} />
      ) : (
        <p className="ah-replay-empty" role="status">{index?.missing ?? '这个时刻没有房间记录'}</p>
      ) : <OfficePage {...safeProps} timezone={index?.timezone} />}
    </div>
  )
}

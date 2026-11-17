/**
 * 像素办公室页面（P36）：用 PH6 的固定布局、固定外观与真实状态灯画出一帧房间。
 *
 * 为什么用 canvas + 浮层：房间本身是一张 480x270 的像素画，适合整帧绘制；
 * 可点的对象（小人、门口）用透明按钮浮在对应逻辑坐标上，键盘与读屏也能用，
 * 不把交互埋进 canvas 像素里。画面只消费 core 的 OfficeView，不新增数据源。
 * 气泡文案、桌上产出、门口件数全部来自 projection；没有数据就如实空着。
 *
 * P54 起房间是活的，但页面只做调度：每分钟重算一次静态帧（钟面、日历、窗外天色），
 * 每一拍再把动画层叠上去。页面藏起来就暂停，主人要求减少动态效果时不动画、只刷新钟面。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { OfficeView, QuotaWindowView } from '../../shared/views.js'
import { OFFICE_AMBIENT_TICK_MS, officeAmbient, type OfficeCatVisit } from '../office-pixel/ambient.js'
import { ARRIVAL_WALK_MS, mergeArrived, pickCatVisitSeat, planArrivals, readArrived, writeArrived } from '../office-pixel/arrival.js'
import { officeMomentFrom, type OfficeMoment } from '../office-pixel/moment.js'
import { officeBubbleWidth, officePixelFrame, paintOfficeFrame, paintOfficeRects } from '../office-pixel/render.js'
import { OFFICE_PIXEL_HEIGHT, OFFICE_PIXEL_WIDTH, officeSeatAt } from '../office-pixel/layout.js'
import { OFFICE_QUOTA_WINDOW_MS, quotaClockLabel, quotaSignText, quotaSignRect, quotaWindowStartOf } from '../office-pixel/quota-decor.js'

/** 减少动态效果时不需要按拍画，隔半分钟看一眼钟面要不要翻到下一分钟就够了。 */
const STILL_REFRESH_MS = 30_000

export interface OfficePixelPageProps {
  office: OfficeView
  /** 当前选中的队友（选中态描边）；null 表示没选。 */
  selectedBotId: string | null
  /** 点小人：从页面右侧展开它的动线（P62）。 */
  onSelectSeat: (botId: string) => void
  /** 点门口/座位旁的件数：打开收件箱。 */
  onOpenInbox: (inboxId?: string) => void
  /** 画布下方的一行说明（如「点小人看动线」）；不占侧栏，随房间保持单列。 */
  guide?: ReactNode
  /**
   * P76k：额度窗口视图。给定时画挂钟外圈的窗口弧、挂钟下的一行小字，
   * 并在员工份额用完、真实额度用完、你自己要用这三种状态下给每位在岗员工立午休牌。
   */
  quota?: QuotaWindowView | null
  /** 写牌上与挂钟下的时刻用的时区（中心设置）；不传按北京时间。 */
  timezone?: string
}

/** 逻辑坐标换算成 CSS 百分比，让浮层和缩放到任意宽度的画布严丝合缝。 */
function percentX(x: number): string {
  return `${(x / OFFICE_PIXEL_WIDTH) * 100}%`
}
function percentY(y: number): string {
  return `${(y / OFFICE_PIXEL_HEIGHT) * 100}%`
}

export function OfficePixelPage(props: OfficePixelPageProps): ReactNode {
  const { office } = props
  const canvasRef = useRef<HTMLCanvasElement>(null)
  // 静态帧只随分钟变化：把「当前这一分钟」放进状态，翻分钟时才重算一整帧。
  const [minute, setMinute] = useState<OfficeMoment>(() => officeMomentFrom(new Date()))

  /**
   * P73f 报到：正在播放「从门口走到工位」的员工（员工 id → 开始走的时刻）。
   * 只在今天入职、本机第一次看到、且没有开启「减少动态效果」时才有；走完（约 2.5 秒）就清掉。
   */
  const [arrivals, setArrivals] = useState<Record<string, number>>({})
  /** 这次打开页面已经处理过的员工：本地存储写不进去时，也不会因为办公室刷新而重复播放。 */
  const handledRef = useRef<Set<string>>(new Set())
  const arrivalTimers = useRef<Array<ReturnType<typeof setTimeout>>>([])
  /** 猫去新员工工位旁的开始时刻：每次打开页面从头算，目标员工不变时不重新开始。 */
  const catStartRef = useRef<{ botId: string; sinceMs: number } | null>(null)
  const catSeatIndex = pickCatVisitSeat(office.seats)
  const catBotId = catSeatIndex === null ? null : office.seats[catSeatIndex]?.botId ?? null
  if (catBotId === null) catStartRef.current = null
  else if (catStartRef.current?.botId !== catBotId) catStartRef.current = { botId: catBotId, sinceMs: Date.now() }
  const catVisitRef = useRef<OfficeCatVisit | null>(null)
  catVisitRef.current = catSeatIndex !== null && catStartRef.current !== null ? { seatIndex: catSeatIndex, sinceMs: catStartRef.current.sinceMs } : null

  useEffect(() => {
    try {
      // 减少动态效果或读不到本地存储时 planArrivals 不会安排走位；只有真的要播放的才进 arrivals。
      const reduced = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
      const stored = readArrived()
      const plan = planArrivals({
        seats: office.seats.filter(seat => !handledRef.current.has(seat.botId)).map(seat => ({ botId: seat.botId, joinedToday: seat.joinedToday })),
        arrived: stored,
        reducedMotion: reduced,
      })
      for (const id of [...plan.remember, ...plan.play]) handledRef.current.add(id)
      if (plan.remember.length > 0) writeArrived(mergeArrived(stored ?? [], plan.remember))
      if (plan.play.length === 0) return
      const startedAt = Date.now()
      setArrivals(prev => ({ ...prev, ...Object.fromEntries(plan.play.map(id => [id, startedAt])) }))
      // 走完就清掉：静态帧随之重算，这位员工坐在工位上。多留 200 毫秒，保证最后一步画完。
      arrivalTimers.current.push(setTimeout(() => {
        try { setArrivals(prev => Object.fromEntries(Object.entries(prev).filter(([id]) => !plan.play.includes(id)))) } catch { /* 清不掉只是多画一会儿 */ }
      }, ARRIVAL_WALK_MS + 200))
    } catch {
      // 本地存储或定时器出错：不播放、不报错，办公室照常显示。
    }
  }, [office.seats])
  useEffect(() => () => { for (const timer of arrivalTimers.current) clearTimeout(timer) }, [])

  // 座位按 core 投影顺序坐进固定工位；超过六个时渲染层会给出中文警告并跳过。
  const frame = useMemo(() => officePixelFrame({
    occupants: office.seats.slice(0, 6).map((seat, seatIndex) => ({
      seatIndex,
      botId: seat.occupant.botId,
      name: seat.occupant.name,
      light: seat.light,
      joinedToday: seat.joinedToday,
      arriving: arrivals[seat.occupant.botId] !== undefined,
    })),
    moment: minute,
  }), [office.seats, minute, arrivals])

  /**
   * P76k：额度窗口的三样只读装饰。午休牌的文字与挂钟下的一行小字都在这里算一次，
   * canvas 与浮层共用同一份结果，牌面与文字不会各算各的。
   */
  const quota = props.quota ?? null
  const signText = quotaSignText(quota, props.timezone)
  const clockLabel = quotaClockLabel(quota, props.timezone)
  const windowStartAt = quota === null ? null : quotaWindowStartOf(quota)

  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null) return
    const context = canvas.getContext('2d')
    if (context === null) return
    // 跟随系统的「减少动态效果」设置；老环境没有 matchMedia 时按允许动画处理。
    const reducedMotion = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null
    let timer: ReturnType<typeof setInterval> | null = null

    /** 画一拍：先铺静态帧，再叠动画层；翻分钟时交给 React 重算静态帧，这一拍不画。 */
    const paint = (): void => {
      try {
        const date = new Date()
        const moment = officeMomentFrom(date)
        if (moment.minute !== minute.minute || moment.hour !== minute.hour || moment.day !== minute.day || moment.month !== minute.month) {
          setMinute(moment)
          return
        }
        paintOfficeFrame(context, frame)
        paintOfficeRects(context, officeAmbient({
          timeMs: date.getTime(), moment, figures: frame.figures, motion: reducedMotion?.matches !== true,
          arrivals, catVisit: catVisitRef.current,
          // P76k：额度窗口的装饰每一拍按当前时刻重画；减少动态效果时拍子放慢，弧停在那一刻。
          quota: quota === null || (windowStartAt === null && signText === null) ? null
            : { now: date.getTime(), windowStartAt, windowMs: OFFICE_QUOTA_WINDOW_MS, light: quota.light, signText },
        }))
      } catch {
        // 画布异常只影响这一屏画面，不能让整页或宿主崩掉。
      }
    }

    const stop = (): void => {
      if (timer !== null) clearInterval(timer)
      timer = null
    }

    /** 按当前条件重新开始：页面藏起来时不跑，省电也省算力。 */
    const restart = (): void => {
      try {
        stop()
        if (document.visibilityState === 'hidden') return
        paint()
        timer = setInterval(paint, reducedMotion?.matches === true ? STILL_REFRESH_MS : OFFICE_AMBIENT_TICK_MS)
      } catch {
        // 监听回调同样不能把异常抛给宿主。
      }
    }

    restart()
    document.addEventListener('visibilitychange', restart)
    reducedMotion?.addEventListener?.('change', restart)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', restart)
      reducedMotion?.removeEventListener?.('change', restart)
    }
  }, [frame, minute, arrivals, quota?.state, quota?.light, quota?.resetAt, signText, windowStartAt])

  /** 座位 id → 门口件数：点击小人旁边的角标时直接打开第一件。 */
  const seatByBot = new Map(office.seats.map(seat => [seat.botId, seat]))
  const doorSign = office.doorway

  return (
    <section className="ah-office-pixel" aria-label="像素办公室">
      <div className="ah-office-pixel-room">
        <canvas ref={canvasRef} width={OFFICE_PIXEL_WIDTH} height={OFFICE_PIXEL_HEIGHT}
          className="ah-office-pixel-canvas" aria-hidden="true" />

        {/* 房间门口：团队级收件箱只出现在这里，数字与列表同源。 */}
        <button type="button" className="ah-office-pixel-door"
          title={doorSign.count > 0 ? '打开房间门口的团队级待办' : '房间门口暂无团队级待办'}
          onClick={() => props.onOpenInbox(doorSign.items[0]?.inboxId)}>
          门口 {doorSign.count > 0 ? `${doorSign.count} 件` : '暂无'}
        </button>

        {/* P76k：午休牌的牌面由 canvas 画好，这里只放文字，位置与牌面同一份矩形，缩放时不会错位。
            牌面 22 像素宽放不下「19:00 回来」一整行，所以拆成两行（时刻、回来）。 */}
        {signText !== null ? frame.figures.map(figure => {
          const seat = officeSeatAt(figure.seatIndex)
          if (seat === null) return null
          const rect = quotaSignRect(seat)
          const [clock, word] = signText.split(' ')
          return (
            <span key={`quota-sign-${figure.botId}`} className="ah-office-pixel-sign"
              title={`${figure.name}：额度窗口 ${signText}之前不开新回合`}
              style={{ left: percentX(rect.x), top: percentY(rect.y), width: percentX(rect.w), height: percentY(rect.h) }}>
              <span>{clock}</span>
              <span>{word}</span>
            </span>
          )
        }) : null}

        {/* P76k：挂钟下方的一行小字，时刻与额度视图的 resetText 同一个。 */}
        {clockLabel !== null ? (
          <span className="ah-office-pixel-quota-label" style={{ left: percentX(146), top: percentY(47) }}>{clockLabel}</span>
        ) : null}

        {/* 小人热区：位置来自渲染帧的脚底坐标，和 pixelated 缩放共用同一套比例。 */}
        {frame.figures.map(figure => {
          const seat = seatByBot.get(figure.botId)
          const selected = props.selectedBotId === figure.botId
          return (
            <span key={figure.botId}>
              <button type="button"
                className={`ah-office-pixel-figure${selected ? ' ah-office-pixel-figure-on' : ''}`}
                style={{
                  // figure.x 是人的水平中心：热区宽 30，左缘要往回退一半，人像才正好落在热区中间。
                  left: percentX(figure.x - 15),
                  top: percentY(figure.y - 56),
                  width: percentX(30),
                  height: percentY(54),
                }}
                aria-label={`${figure.name}：${figure.bubble.label}，点击查看今日动线`}
                aria-pressed={selected}
                title={`${figure.name}：${figure.bubble.label}（点击查看今日动线）`}
                onClick={() => props.onSelectSeat(figure.botId)}>
                <span className="ah-office-pixel-bubble" data-contrast-on-canvas="bubble" style={{
                  left: '50%',
                  // 热区高 54 逻辑像素，气泡占顶部 10 像素：用相对热区的比例，随画布一起缩放。
                  top: `${(2 / 54) * 100}%`,
                  // 宽度和画布上的气泡用同一个函数算，文字才正好落在框里。
                  width: `${(officeBubbleWidth(figure.bubble.short) / 30) * 100}%`,
                  height: `${(10 / 54) * 100}%`,
                }}>{figure.bubble.short}</span>
              </button>
              {seat !== undefined && seat.door.count > 0 ? (
                <button type="button" className="ah-office-pixel-badge"
                  style={{ left: percentX(figure.x + 15), top: percentY(figure.y - 42) }}
                  title={`${figure.name}的门口有 ${seat.door.count} 件待办`}
                  onClick={() => props.onOpenInbox(seat.door.inboxIds[0])}>
                  {seat.door.count > 9 ? '9+' : seat.door.count}
                </button>
              ) : null}
            </span>
          )
        })}

        {office.seats.length === 0 ? (
          <p className="ah-office-pixel-empty">暂无在岗员工。可通过「新建员工」添加。</p>
        ) : null}
      </div>

      {/* 引导放在画布正下方，不占右侧一列：房间始终按卡片宽度铺满。 */}
      {props.guide}

      {/* 图例同时是键盘入口：颜色取自同一套固定外观，名字与气泡文案来自真实状态。 */}
      {frame.figures.length > 0 ? (
        <ul className="ah-office-pixel-legend" aria-label="房间里的员工">
          {frame.figures.map(figure => (
            <li key={figure.botId}>
              <button type="button"
                className={`ah-office-pixel-legend-item${props.selectedBotId === figure.botId ? ' ah-office-pixel-legend-on' : ''}`}
                aria-pressed={props.selectedBotId === figure.botId}
                onClick={() => props.onSelectSeat(figure.botId)}>
                <span className="ah-office-pixel-swatch" aria-hidden="true"
                  style={{ background: figure.appearance.shirt }} />
                <span>{figure.name}</span>
                <span className="ah-office-pixel-legend-state">{figure.bubble.short}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {frame.warnings.length > 0 ? (
        <ul className="ah-office-warnings">
          {frame.warnings.map(warning => <li key={warning}>{warning}</li>)}
        </ul>
      ) : null}
    </section>
  )
}

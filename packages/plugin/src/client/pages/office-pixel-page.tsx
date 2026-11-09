/**
 * 像素办公室页面（P36）：用 PH6 的固定布局、固定外观与真实状态灯画出一帧房间。
 *
 * 为什么用 canvas + 浮层：房间本身是一张 480x270 的像素画，适合整帧绘制；
 * 可点的对象（小人、门口）用透明按钮浮在对应逻辑坐标上，键盘与读屏也能用，
 * 不把交互埋进 canvas 像素里。画面只消费 core 的 OfficeView，不新增数据源。
 * 气泡文案、桌上产出、门口件数全部来自 projection；没有数据就如实空着。
 */
import { useEffect, useMemo, useRef, type ReactNode } from 'react'
import type { OfficeView } from '../../shared/views.js'
import { officePixelFrame, paintOfficeFrame } from '../office-pixel/render.js'
import { OFFICE_PIXEL_HEIGHT, OFFICE_PIXEL_WIDTH } from '../office-pixel/layout.js'

export interface OfficePixelPageProps {
  office: OfficeView
  /** 当前选中的队友（选中态描边）；null 表示没选。 */
  selectedBotId: string | null
  /** 点小人：打开它的当日轨迹。 */
  onSelectSeat: (botId: string) => void
  /** 点门口/座位旁的件数：打开收件箱。 */
  onOpenInbox: (inboxId?: string) => void
  /** 画布下方的一行说明（如「点一个小人看轨迹」）；不占侧栏，随房间保持单列。 */
  guide?: ReactNode
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

  // 座位按 core 投影顺序坐进固定工位；超过六个时渲染层会给出中文警告并跳过。
  const frame = useMemo(() => officePixelFrame({
    occupants: office.seats.slice(0, 6).map((seat, seatIndex) => ({
      seatIndex,
      botId: seat.occupant.botId,
      name: seat.occupant.name,
      light: seat.light,
    })),
  }), [office.seats])

  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null) return
    const context = canvas.getContext('2d')
    if (context === null) return
    try {
      paintOfficeFrame(context, frame)
    } catch {
      // 画布异常只影响这一屏画面，不能让整页或宿主崩掉。
    }
  }, [frame])

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

        {/* 小人热区：位置来自渲染帧的脚底坐标，和 pixelated 缩放共用同一套比例。 */}
        {frame.figures.map(figure => {
          const seat = seatByBot.get(figure.botId)
          const selected = props.selectedBotId === figure.botId
          return (
            <span key={figure.botId}>
              <button type="button"
                className={`ah-office-pixel-figure${selected ? ' ah-office-pixel-figure-on' : ''}`}
                style={{
                  // figure.x 是脚底中心：热区宽 30，左缘要往回退一半，人像才正好落在热区中间。
                  left: percentX(figure.x - 15),
                  top: percentY(figure.y - 56),
                  width: percentX(30),
                  height: percentY(54),
                }}
                aria-label={`${figure.name}：${figure.bubble.label}，点击查看今日轨迹`}
                aria-pressed={selected}
                title={`${figure.name}：${figure.bubble.label}（点击查看今日轨迹）`}
                onClick={() => props.onSelectSeat(figure.botId)}>
                <span className="ah-office-pixel-bubble" data-contrast-on-canvas="bubble" style={{
                  left: '50%',
                  // 热区高 54 逻辑像素，气泡占顶部 10 像素：用相对热区的比例，随画布一起缩放。
                  top: `${(2 / 54) * 100}%`,
                  width: `${(22 / 30) * 100}%`,
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
          <p className="ah-office-pixel-empty">暂无在岗队友。可通过「新建队友」添加。</p>
        ) : null}
      </div>

      {/* 引导放在画布正下方，不占右侧一列：房间始终按卡片宽度铺满。 */}
      {props.guide}

      {/* 图例同时是键盘入口：颜色取自同一套固定外观，名字与气泡文案来自真实状态。 */}
      {frame.figures.length > 0 ? (
        <ul className="ah-office-pixel-legend" aria-label="房间里的队友">
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

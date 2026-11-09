/**
 * 办公室一屏（F03 / P36）：两种看法共用同一份 core 投影。
 *
 * - 像素视图（默认）：固定工位、固定外观、真实状态气泡；点小人打开它当天的
 *   唤醒轨迹，轨迹可前翻、可下钻到那次唤醒的账本。
 * - 列表视图：F03 起的座位卡，保留原有下钻（座位→详情、桌面→账本/产物、门口→收件箱）。
 *
 * 为什么这样摆：主人队友一多就看不清谁卡住。这里不新增任何数据源，整页只渲染
 * core 的 OfficeView（纯投影）：每个座位就是一位在岗队友，没有空位与部门分组。
 */
import { useEffect, useState, type ReactNode } from 'react'
import type { OfficeView, SeatView, WakeLedgerRow } from '../../shared/views.js'
import {
  deskTarget, doorTarget, doorwayTarget, officeLightTone, officeSummary, seatTarget,
} from '../logic/office.js'
import { Skeleton } from '../components/Ui.js'
import { CARD_TYPE_LABELS } from '../components/Cards.js'
import { OfficeStart } from '../components/office-start.js'
import { OfficePixelPage } from './office-pixel-page.js'
import { OfficeTrailPanel } from '../components/office-trail-panel.js'

/** 单个座位：灯、队友、桌上产出、门口与矛盾提示。 */
function SeatCard(props: { seat: SeatView; onOpenBot: (botId: string, wakeId?: string, artifactId?: string) => void; onOpenInbox: (inboxId?: string) => void }): ReactNode {
  const { seat } = props
  const tone = officeLightTone(seat.light)
  const seatGo = seatTarget(seat)
  const deskGo = deskTarget(seat)
  const doorGo = doorTarget(seat)
  const occupant = seat.occupant
  return (
    <article className={`ah-office-seat ah-office-seat-${seat.light}`} aria-label={`${seat.title}：${occupant.name}`}>
      <header className="ah-office-seat-head">
        {/* 灯：颜色只表达状态，文案用 core 的 lightLabel，避免界面自己另编一套说法。 */}
        <span className={`ah-office-light ah-office-light-${tone}`} aria-hidden="true" />
        <span className="ah-office-light-label">{seat.lightLabel}</span>
        <span className="ah-office-seat-title">{seat.title}</span>
      </header>

      <button type="button" className="ah-office-occupant ah-btn-reset" onClick={() => props.onOpenBot(occupant.botId)}>
        <span className="ah-avatar" style={{ background: occupant.color, color: 'var(--dsw-alias-text-on-accent)' }} aria-hidden="true">{occupant.initials}</span>
        <span className="ah-office-occupant-main">
          <span className="ah-office-occupant-name">{occupant.name}<span className="ah-bot-row-role">{occupant.roleLabel}</span></span>
          {/* 单行省略的活动句：全文经 title 可取，放大字距后省略更早发生也不丢内容（WCAG 1.4.12）。 */}
          <span className="ah-office-occupant-activity" title={occupant.activityText ?? occupant.activityLabel ?? '状态未知'}>{occupant.activityText ?? occupant.activityLabel ?? '状态未知'}</span>
        </span>
      </button>

      {/* 桌上：没有产出也如实说「暂时没有」，不拿别的东西充数。 */}
      <div className="ah-office-desk">
        <span className="ah-office-desk-label">{seat.desk.kindLabel}</span>
        {seat.desk.title === null ? (
          <span className="ah-office-desk-empty">—</span>
        ) : deskGo === null ? (
          <span className="ah-office-desk-text">{seat.desk.title}</span>
        ) : (
          <button type="button" className="ah-office-desk-btn" onClick={() => {
            if (deskGo.kind === 'ledger') props.onOpenBot(deskGo.botId, deskGo.wakeId)
            else if (deskGo.kind === 'artifact') props.onOpenBot(deskGo.botId, undefined, deskGo.artifactId)
            else props.onOpenBot(deskGo.botId)
          }} title={deskGo.kind === 'ledger' ? '打开这次唤醒的账本' : deskGo.kind === 'artifact' ? '打开产物面板' : '打开队友详情'}>
            {seat.desk.title}
          </button>
        )}
      </div>

      <footer className="ah-office-seat-foot">
        {doorGo === null ? (
          <span className="ah-office-door-empty">门口暂无待办</span>
        ) : (
          <div className="ah-office-door">
            <span className="ah-office-door-label">门口 {doorGo.inboxIds.length} 件待办</span>
            {/* F04：门口不只给数字，直接列出是哪几件事；点哪条就打开收件箱里那张卡。 */}
            <ul className="ah-office-door-list">
              {seat.door.items.slice(0, 3).map(item => (
                <li key={item.inboxId}>
                  <button type="button" className="ah-office-door-item"
                    title={`打开「${item.title}」`} onClick={() => props.onOpenInbox(item.inboxId)}>
                    <span className="ah-office-door-type">{CARD_TYPE_LABELS[item.type]}</span>
                    <span className="ah-office-door-title">{item.title}</span>
                  </button>
                </li>
              ))}
              {seat.door.items.length > 3 ? (
                <li>
                  <button type="button" className="ah-office-door-item ah-office-door-more"
                    onClick={() => props.onOpenInbox()}>还有 {seat.door.items.length - 3} 件</button>
                </li>
              ) : null}
            </ul>
          </div>
        )}
        <span className="ah-office-seat-hint">点击名字查看详情</span>
      </footer>

      {seat.warnings.length > 0 ? (
        <ul className="ah-office-warnings">
          {seat.warnings.map(warning => <li key={warning}>{warning}</li>)}
        </ul>
      ) : null}
    </article>
  )
}

/** 办公室页：加载中给骨架；数据到齐后按座位网格铺开每位在岗队友。 */
export function OfficePage(props: {
  office: OfficeView | null
  loading: boolean
  /** 回放使用中心设置时区，避免宿主所在时区把历史时刻显示成另一天。 */
  timezone?: string
  /** 仅实时空房间解释创建；倒带不在历史里邀请创建队友。 */
  showWelcome?: boolean
  onNewBot?: () => void
  onRetry: () => void
  /** 打开队友详情；带 wakeId 时展开账本，带 artifactId 时展开产物面板（F08）。 */
  onOpenBot: (botId: string, wakeId?: string, artifactId?: string) => void
  /** 打开「待你处理」；带 inboxId 时直接聚焦那张卡（F04）。 */
  onOpenInbox: (inboxId?: string) => void
  /** 按需读某个队友的唤醒账本行（P36 轨迹面板）；缺省时轨迹面板不出现。 */
  loadTrail?: (botId: string) => Promise<WakeLedgerRow[]>
}): ReactNode {
  /** 房间的两种看法：像素是 P36 默认，列表保留 F03 的座位卡。 */
  const [mode, setMode] = useState<'pixel' | 'list'>('pixel')
  /** 当前打开轨迹的队友；null 表示没选，右侧显示一句话引导。 */
  const [trailBotId, setTrailBotId] = useState<string | null>(null)

  // 刷新或倒带换了房间后，已选队友可能不在场：自动收起，避免面板指向不存在的人。
  useEffect(() => {
    if (trailBotId === null) return
    const seats = props.office?.seats ?? []
    if (!seats.some(seat => seat.botId === trailBotId)) setTrailBotId(null)
  }, [props.office, trailBotId])

  if (props.office === null) {
    return (
      <section className="ah-office" aria-label="办公室">
        {props.loading ? <Skeleton rows={6} /> : (
          <div className="ah-retry">
            办公室读取失败。点击「重试」；仍失败请检查 DSH 运行状态。
            <button type="button" className="ah-btn" onClick={props.onRetry}>重试</button>
          </div>
        )}
      </section>
    )
  }

  const office = props.office
  const summary = officeSummary(office)
  const doorway = doorwayTarget(office)
  // 轨迹面板指向的座位必须仍在投影里；不在就当作没选，不打开一个不存在的队友。
  const trailSeat = trailBotId === null ? null : office.seats.find(seat => seat.botId === trailBotId) ?? null
  const loadTrail = props.loadTrail

  /** 点轨迹面板里的桌上产出：沿用列表视图同一套下钻规则，不另编一套。 */
  const openDeskOf = (seat: SeatView): void => {
    const go = deskTarget(seat)
    if (go.kind === 'artifact') props.onOpenBot(go.botId, undefined, go.artifactId)
    else if (go.kind === 'ledger') props.onOpenBot(go.botId, go.wakeId)
    else props.onOpenBot(go.botId)
  }

  return (
    <section className="ah-office" aria-label="办公室">
      {/* 房间抬头：汇总、看法切换与健康；每个座位就是一位在岗队友。 */}
      <header className="ah-office-head">
        <div className="ah-office-head-main">
          <h2>办公室</h2>
          <span className="ah-office-stats">
            <span>{summary.occupied} 位在座</span>
            {summary.waiting > 0 ? <span>{summary.waiting} 位待确认</span> : null}
            {summary.blocked > 0 ? <span>{summary.blocked} 位受阻</span> : null}
            <span>门口 {summary.doorTotal} 件待办</span>
          </span>
        </div>
        <div className="ah-office-controls">
          {/* P36：像素与列表读同一份投影，切换只改呈现，不触发任何写入。 */}
          <div className="ah-seg" role="group" aria-label="办公室看法">
            <button type="button" className={`ah-seg-btn${mode === 'pixel' ? ' ah-seg-on' : ''}`}
              aria-pressed={mode === 'pixel'} onClick={() => setMode('pixel')}>像素</button>
            <button type="button" className={`ah-seg-btn${mode === 'list' ? ' ah-seg-on' : ''}`}
              aria-pressed={mode === 'list'} onClick={() => setMode('list')}>列表</button>
          </div>
          <div className="ah-office-health" title="额度、告警与沙箱状态">
            <span className={`ah-dot ah-dot-${office.health.quotaLight === 'green' ? 'ok' : office.health.quotaLight === 'yellow' ? 'warn' : 'danger'}`}>
              <span className="ah-dot-circle" aria-hidden="true" />额度 {office.health.quotaLightLabel}
            </span>
            {office.health.openAlerts > 0 ? <span className="ah-office-alert">未恢复告警 {office.health.openAlerts}</span> : null}
            {office.health.sandboxOk ? null : <span className="ah-office-alert">沙箱不可用</span>}
          </div>
        </div>
      </header>

      {mode === 'pixel' ? (
        <>
          {/* 空房间仍画固定工位；欢迎说明只在实时房间出现，倒带不邀请建队友。 */}
          {props.showWelcome !== false && office.seats.length === 0 ? (
            <OfficeStart office={office} onNewBot={props.onNewBot} />
          ) : null}
          <div className="ah-office-pixel-layout">
            <OfficePixelPage office={office} selectedBotId={trailBotId}
              onSelectSeat={setTrailBotId} onOpenInbox={props.onOpenInbox}
              guide={trailSeat !== null && loadTrail !== undefined ? null : (
                // U01 第 37 轮（1.3.1）：引导块是 aside 互补地标，补可访问名，不再是未命名区域。
                <aside className="ah-office-pixel-guide" aria-label="像素办公室引导">
                  <strong>选择一位队友</strong>
                  <p>查看今日唤醒轨迹。轨迹仅取自真实账本，点击可打开对应唤醒。</p>
                  {office.seats.length > 0 && loadTrail === undefined
                    ? <p className="ah-office-pixel-warn">唤醒账本接口未接入，当前仅显示房间。</p>
                    : null}
                </aside>
              )} />
            {trailSeat !== null && loadTrail !== undefined ? (
              <OfficeTrailPanel
                botId={trailSeat.occupant.botId}
                botName={trailSeat.occupant.name}
                deskKindLabel={trailSeat.desk.kindLabel}
                deskTitle={trailSeat.desk.title}
                doorCount={trailSeat.door.count}
                now={office.asOf}
                timezone={props.timezone}
                loadRows={loadTrail}
                onOpenWake={(botId, wakeId) => props.onOpenBot(botId, wakeId)}
                onOpenDesk={() => openDeskOf(trailSeat)}
                onOpenBotDetail={() => props.onOpenBot(trailSeat.occupant.botId)}
                onOpenInbox={() => props.onOpenInbox(trailSeat.door.inboxIds[0])}
                onClose={() => setTrailBotId(null)}
              />
            ) : null}
          </div>
        </>
      ) : (
        /* 列表视图：地板是装饰（不承载状态），座位卡片才是可点节点。 */
        <div className="ah-office-room">
          <div className="ah-office-floor" aria-hidden="true" />
          {props.showWelcome !== false ? (
            <OfficeStart office={office} onNewBot={props.onNewBot} />
          ) : null}
          {/* 座位即队友：一屏按网格铺开，不再按部门分区，也没有空位卡片。 */}
          {office.seats.length > 0 ? (
            <div className="ah-office-seats">
              {office.seats.map(seat => (
                <SeatCard key={seat.ref} seat={seat} onOpenBot={props.onOpenBot} onOpenInbox={props.onOpenInbox} />
              ))}
            </div>
          ) : props.showWelcome === false ? (
            <p className="ah-office-empty">暂无在岗队友。可通过「新建队友」添加。</p>
          ) : null}
        </div>
      )}

      {/* 房间门口的总信箱：团队级收件箱（botId=null）只出现这里，同样逐条列出、点开就是那张卡。
          U01 第 37 轮（1.3.1）：footer 是内容区地标，补可访问名说明这块就是门口总信箱。 */}
      <footer className="ah-office-foot" aria-label="房间门口总信箱">
        {doorway === null ? (
          <span className="ah-office-door-empty">暂无团队级待办。可打开收件箱查看。</span>
        ) : (
          <div className="ah-office-doorway">
            <span className="ah-office-doorway-label">房间门口：{doorway.inboxIds.length} 件团队级待办</span>
            <ul className="ah-office-door-list">
              {office.doorway.items.slice(0, 3).map(item => (
                <li key={item.inboxId}>
                  <button type="button" className="ah-office-door-item"
                    title={`打开「${item.title}」`} onClick={() => props.onOpenInbox(item.inboxId)}>
                    <span className="ah-office-door-type">{CARD_TYPE_LABELS[item.type]}</span>
                    <span className="ah-office-door-title">{item.title}</span>
                  </button>
                </li>
              ))}
              {office.doorway.items.length > 3 ? (
                <li>
                  <button type="button" className="ah-office-door-item ah-office-door-more"
                    onClick={() => props.onOpenInbox()}>还有 {office.doorway.items.length - 3} 件</button>
                </li>
              ) : null}
            </ul>
          </div>
        )}
        {office.truncated ? <span className="ah-office-truncated">仅显示最近账本，更早的产出未显示</span> : null}
        <span className="ah-office-asof">{new Date(office.asOf).toLocaleTimeString('zh-CN', { timeZone: props.timezone, hour: '2-digit', minute: '2-digit' })} 的状态</span>
      </footer>
    </section>
  )
}

/**
 * 收件箱页（左栏底部入口）：所有要主人动手的事只有这一个入口。
 * 一列平铺（优先级高的在前，同级按时间新到旧），顶部可按请求类型筛选；
 * 每项显示队友头像名字、标题、正文、剩余有效期；
 * 操作：提问选选项或填自由文本、审批批准/拒绝（可附一句话）、提议接受/拒绝、告警「知道了」。
 * 处理后从列表消失（服务端把 open 项作答），结果出现在对应线程里。
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { InboxItemView, InboxView } from '../../shared/views.js'
import { Avatar, EmptyHint, RetryBox, Skeleton } from './Ui.js'
import { InboxCard, type CardActions, type CardPayload } from './Cards.js'
import { sortInbox, focusInboxTarget } from '../logic/feeds.js'

/**
 * 筛选记忆（模块级）：收件箱页离开（去看某条对话）再回来时，InboxPane 会重挂载，
 * 组件内 state 丢失，筛选会跳回「全部」。存在组件外，回来后还停在原来的分类上。
 * 只记纯展示偏好，不记业务数据。
 */
let inboxFilterMemory = 'all'

/**
 * 滚动位置记忆（模块级）：和筛选一样，从收件箱去看某条对话再回来时会重挂载。
 * 记下离开时的 scrollTop，回来后恢复，主人不用重新往下翻。
 */
let inboxScrollMemory = 0

/** 处理成功提示的显示时长（毫秒）：带「查看会话」入口，留足点击时间。 */
const HANDLED_MS = 6000

/** 处理成功提示：一句话结论 + 这条请求来自哪个队友（用于一键回到它的线程）。 */
interface HandledNotice {
  text: string
  botId: string | null
}

/** 把 InboxItemView 适配成 InboxCard 需要的卡片形状（复用同一张卡的交互）。 */
function itemToCard(item: InboxItemView): CardPayload {
  return {
    inboxId: item.id, approvalId: item.approvalId, type: item.type, status: 'open' as const,
    goalId: item.goalId,
    title: item.title, body: item.body,
    options: item.options, defaultOption: item.defaultOption, answer: null, expiresText: item.expiresText,
  }
}

export function InboxPane(props: {
  inbox: InboxView | null
  loading: boolean
  error: string | null
  onRetry: () => void
  actions: CardActions
  busyId: string | null
  onOpenThread?: (botId: string) => void
  /** 从办公室门口点进来时要聚焦的那张卡（F04）；普通进入为 null。 */
  focusInboxId?: string | null
}): ReactNode {
  const [, force] = useState(0)
  const [filter, setFilter] = useState(inboxFilterMemory)
  /** 刚处理完的提示：处理后该项从列表消失，必须给一句「已经生效」的回应。 */
  const [handled, setHandled] = useState<HandledNotice | null>(null)
  /** 当前被门口点亮的卡片：短暂描边，帮主人一眼找到是哪张。 */
  const [focusedId, setFocusedId] = useState<string | null>(null)
  /** 已处理过的聚焦请求，避免每次 SSE 刷新都重新滚动。 */
  const handledFocusRef = useRef<string | null>(null)
  const scrollRef = useRef<HTMLElement | null>(null)
  /** 每次挂载只恢复一次：后续 SSE 刷新不能把主人正在看的位置拽走。 */
  const restoredRef = useRef(false)
  useLayoutEffect(() => {
    if (restoredRef.current || scrollRef.current === null) return
    scrollRef.current.scrollTop = inboxScrollMemory
    restoredRef.current = true
  }, [props.inbox])
  useEffect(() => {
    if (handled === null) return
    const timer = setTimeout(() => { try { setHandled(null) } catch { /* 提示消失失败不影响页面。 */ } }, HANDLED_MS)
    return () => clearTimeout(timer)
  }, [handled])
  // F04：从办公室门口点进来时，先把目标卡露出来。若当前筛选会挡住它，先切回「全部」，
  // 下一轮再滚动并描边；同一 focusInboxId 只处理一次，SSE 刷新不会把阅读位置拽走。
  useEffect(() => {
    const focusId = props.focusInboxId
    if (focusId === null || focusId === undefined || handledFocusRef.current === focusId) return
    const target = focusInboxTarget(props.inbox?.items ?? [], focusId, filter)
    if (target === null) return
    if (target.filter !== filter) {
      inboxFilterMemory = target.filter
      setFilter(target.filter)
      return
    }
    handledFocusRef.current = focusId
    setFocusedId(focusId)
    const node = document.querySelector(`[data-inbox-id="${focusId}"]`)
    if (node !== null && typeof (node as HTMLElement).scrollIntoView === 'function') {
      (node as HTMLElement).scrollIntoView({ block: 'center' })
    }
  }, [props.focusInboxId, props.inbox, filter])
  // 描边只亮一小会儿，避免主人以为这是「已选中」的持久状态。
  useEffect(() => {
    if (focusedId === null) return
    const timer = setTimeout(() => { try { setFocusedId(null) } catch { /* 描边消失失败不影响页面。 */ } }, 2400)
    return () => clearTimeout(timer)
  }, [focusedId])
  if (props.error) {
    return <div className="ah-inbox"><div className="ah-retry" role="alert"><span>{props.error}</span><button type="button" className="ah-btn" onClick={props.onRetry}>重试</button></div></div>
  }
  // U11（audit #19-21）：区域名统一为「待你处理」，不再让用户从「待你处理」
  // 入口进来却看到「收件箱 / 待处理」这些旧名。
  if (!props.inbox) return <div className="ah-inbox">{props.loading
    ? <Skeleton rows={3} />
    // U11 #21：加载失败用全插件统一的报错模板，就地给重试。
    : <RetryBox message="读不出来。点重试。还不行，看看 DSH 是不是关了。" onRetry={props.onRetry} />}</div>
  // 一列平铺：优先级高的在前，同级按时间新到旧；分级只留在每条卡片的优先级标签上。
  const items = sortInbox(props.inbox.items.filter(item => filter === 'all' || item.type === filter))
  return (
    <section
      className="ah-inbox"
      aria-label="待你处理"
      data-testid="ah-inbox"
      ref={scrollRef}
      onScroll={event => { inboxScrollMemory = event.currentTarget.scrollTop }}
    >
      <header className="ah-pane-heading"><h2>待你处理</h2><p>你处理完，队友接着做。</p></header>
      {/* 处理结果反馈（role=status）：卡片从列表消失后，主人仍能确认「刚才那一下生效了」，
          并能一键回到该队友的线程看它接下来怎么做。 */}
      {handled ? (
        <div className="ah-inbox-done" role="status">
          <span>{handled.text}</span>
          {handled.botId !== null && props.onOpenThread ? (
            <button type="button" className="ah-btn ah-btn-ghost" onClick={() => props.onOpenThread?.(handled.botId!)}>查看会话</button>
          ) : null}
        </div>
      ) : null}
      <nav className="ah-filter-tabs" aria-label="按请求类型筛选">
        {(() => {
          // 先算好每个分类的计数，避免每个按钮重复 filter 一遍。
          const all = props.inbox!.items
          const filters = [
            { v: 'all', label: '全部', n: all.length },
            { v: 'approval', label: '审批', n: all.filter(i => i.type === 'approval').length },
            { v: 'question', label: '提问', n: all.filter(i => i.type === 'question').length },
            { v: 'proposal', label: '提议', n: all.filter(i => i.type === 'proposal').length },
            { v: 'alert', label: '告警', n: all.filter(i => i.type === 'alert').length },
          ]
          return filters.map(({ v, label, n }) => {
            const pressed = filter === v
            // 计数 0 且不是当前选中 → 降级：aria-disabled + 样式置灰。
            // 选中的分类即使变成 0 也保持可点（用户可能想从"审批 0"切回"全部"）。
            const disabled = n === 0 && !pressed
            return (
              <button type="button" className={`ah-btn ah-btn-ghost${disabled ? ' ah-filter-disabled' : ''}`} key={v}
                aria-pressed={pressed} aria-disabled={disabled || undefined}
                onClick={() => {
                  if (disabled) return
                  inboxFilterMemory = v
                  // 换分类是新的浏览起点：回到顶部，避免停在上一类的半截位置。
                  inboxScrollMemory = 0
                  if (scrollRef.current !== null) scrollRef.current.scrollTop = 0
                  setFilter(v)
                }}>
                {label} <span>{n}</span>
              </button>
            )
          })
        })()}
      </nav>
      {items.length === 0 ? <EmptyHint text={filter === 'all' ? '现在没有要你处理的事。它们都在忙，有事会来找你。' : '暂无此类请求。切换「全部」查看其他类型。'} /> : null}
      {items.map(item => (
        <article key={item.id} data-inbox-id={item.id} className={`ah-inbox-row ah-inbox-${item.priority.toLowerCase()}${focusedId === item.id ? ' is-focused' : ''}`}>
          {/* U01 第 37 轮（1.3.1）：这一行只是卡片内部的元信息布局槽，没有标题文本，
              用 header 会变成未命名地标；article 本身已经承担整条请求的分组语义，这里改回普通 div。 */}
          <div className="ah-inbox-row-head">
            {item.botName ? <Avatar color={item.botColor} initials={item.botName.slice(0, 1)} size={24} /> : null}
            <span className="ah-inbox-bot">{item.botName ?? '中心'}</span>
            {item.botId && props.onOpenThread ? <button type="button" className="ah-btn ah-btn-ghost" onClick={() => props.onOpenThread?.(item.botId!)}>查看对话</button> : null}
            {/* 这里只放创建时间；有效期的含义由卡片正文统一说明，避免同一句话出现两遍。 */}
            <span className="ah-inbox-time">{item.createdText}</span>
          </div>
          <InboxCard card={itemToCard(item)} priority={item.priority} actions={{
            ...props.actions,
            // 本卡处理中禁用；处理完由 SSE 刷新把项移出列表。这里 force 触发本行重渲染，
            // 并在成功后给一句全局反馈（该项随即消失，没有别的地方能确认结果）。
            onPick: async (card, option, note) => {
              force(n => n + 1)
              const failure = await props.actions.onPick(card, option, note)
              if (failure === null) setHandled({
                text: item.botName
                  ? `已提交。下一步：继续执行，负责人 ${item.botName}。`
                  : '已提交。下一步：待安排。',
                botId: item.botId ?? null,
              })
              return failure
            },
          }} busy={props.busyId === item.id} />
        </article>
      ))}
    </section>
  )
}

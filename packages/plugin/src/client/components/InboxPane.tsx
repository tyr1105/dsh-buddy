/**
 * 收件箱页（左栏底部入口）：所有要主人动手的事只有这一个入口。
 * 一列平铺（优先级高的在前，同级按时间新到旧），顶部可按请求类型筛选；
 * 每项显示队友头像名字、标题、正文、剩余有效期；来自项目主题的事项再写一句「来自主题：主题名」（P65）；
 * 操作：提问选选项或填自由文本、审批批准/拒绝（可附一句话）、提议接受/拒绝、告警「知道了」。
 * 处理后从列表消失（服务端把 open 项作答），结果出现在对应线程里：
 * 来自主题的事项，队友回到主题里接着做，所以「查看对话」「查看会话」都直接进那个主题。
 * 例外（P72g B2）：约定条目的对齐在总管私聊里，「查看对话」进总管私聊并滚到那张约定卡。
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { InboxItemView, InboxView } from '../../shared/views.js'
import { Avatar, EmptyHint, RetryBox, Skeleton } from './Ui.js'
import { CARD_TYPE_LABELS, InboxCard, type CardActions, type CardPayload } from './Cards.js'
import { EscalationCard } from './JobCard.js'
import { sortInbox, focusInboxTarget, inboxThreadId } from '../logic/feeds.js'
import { inboxHandledNotice } from '../logic/inbox-notice.js'
import { objectionKey, objectionOf } from '../logic/inbox-objection.js'
import { ObjectionHost } from './InboxObjection.js'

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

/** 处理成功提示：一句话结论 + 队友接着做的那条线程（主题或私聊，用于一键过去看）。 */
interface HandledNotice {
  text: string
  threadId: string | null
}

/** 把 InboxItemView 适配成 InboxCard 需要的卡片形状（复用同一张卡的交互）。
 *  约定确认条目下面的说明（有效期那一行）只看条目自己带的 agreementJobSplit（有两栏）与 agreementStop（确认后停止，优先），
 *  这两个事实由核心给出（P74r8）；不再从已打开的对话里推断，所以对话没有加载时说明同样正确。 */
export function itemToCard(item: InboxItemView): CardPayload {
  return {
    inboxId: item.id, approvalId: item.approvalId, type: item.type, status: 'open' as const,
    goalId: item.goalId,
    title: item.title, body: item.body,
    options: item.options, defaultOption: item.defaultOption, answer: null, expiresText: item.expiresText,
    ...(item.approval !== undefined ? { approval: item.approval } : {}), // P69：审批卡的一句话、原因、风险、原始命令
    // P72：约定确认条目带约定 id，卡片据此隐藏自由文本输入、固定写「不会自动按建议处理」那一行。
    ...(typeof item.agreementId === 'string' && item.agreementId !== '' ? { agreementId: item.agreementId, agreementJobSplit: item.agreementJobSplit === true, agreementStop: item.agreementStop === true } : {}),
    // P73e：组队确认条目带组队卡 id，卡片据此只显示一个按钮、隐藏自由文本、写「不会自动入职」。
    ...(typeof item.teamProposalId === 'string' && item.teamProposalId !== '' ? { teamProposalId: item.teamProposalId } : {}),
    // P75r7：学习选会话条目带学习记录编号，并标明这张卡来自「待你处理」（卡片据此保留自由文本输入框，线程里的学习卡不保留）。
    ...(typeof item.learnRunId === 'string' && item.learnRunId !== '' ? { learnRunId: item.learnRunId, fromInbox: true } : {}),
    // P74r4b/P74i-m1（第二次，任务卡 1.3）：一件事的四类条目带 jobEntry，界面据此识别，不按按钮文字猜。
    ...(item.jobEntry !== undefined ? { jobEntry: item.jobEntry } : {}),
    // P74i-m7：「员工被中心停用」的告警条目带恢复入口，卡片据此多画「恢复在岗」按钮；没有这个字段时卡片与原来完全一样。
    ...(item.reinstate != null ? { reinstate: item.reinstate } : {}),
  }
}

export function InboxPane(props: {
  inbox: InboxView | null
  loading: boolean
  error: string | null
  onRetry: () => void
  actions: CardActions
  busyId: string | null
  /** 打开一条线程：队友 id 或主题 id（两者都是线程 id）。 */
  onOpenThread?: (threadId: string, agreementId?: string | null) => void
  /** 从办公室门口点进来时要聚焦的那张卡（F04）；普通进入为 null。 */
  focusInboxId?: string | null
  /**
   * P79：把一句话发到某条对话（线程编号，文字）。就是对话输入框发消息用的那条路径（sendMessage），
   * 返回错误文字或 null（成功）。不传时约定确认、组队确认、验收、说明卡四种条目不显示「要修改」等次要按钮。
   */
  onSendMessage?: (threadId: string, text: string) => Promise<string | null>
}): ReactNode {
  const [, force] = useState(0)
  /**
   * P74i-m4（第 2 节）：每个条目的提交状态（条目编号 到 submitting 或 done）。
   * 点了确认、选办法、验收之后，「要修改」「有不符」「都不合适」不能再发：提交中禁用，处理完不显示；
   * 提交失败时清掉，恢复可用。条目随刷新从列表消失后这条记录无用，留着无害。
   */
  const [locks, setLocks] = useState<Record<string, 'submitting' | 'done'>>({})
  const setLock = (id: string, lock: 'none' | 'submitting' | 'done'): void => {
    setLocks(prev => {
      const next = { ...prev }
      if (lock === 'none') delete next[id]
      else next[id] = lock
      return next
    })
  }
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
      <header className="ah-pane-heading"><h2>待你处理</h2><p>你处理完，员工继续做。</p></header>
      {/* 处理结果反馈（role=status）：卡片从列表消失后，主人仍能确认「刚才那一下生效了」，
          并能一键去队友接着做的那条线程（来自主题的去主题，其余去私聊）看它接下来怎么做。 */}
      {handled ? (
        <div className="ah-inbox-done" role="status">
          <span>{handled.text}</span>
          {handled.threadId !== null && props.onOpenThread ? (
            <button type="button" className="ah-btn ah-btn-ghost" onClick={() => props.onOpenThread?.(handled.threadId!)}>查看会话</button>
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
      {items.map(item => {
        // P65：来自主题的事，「查看对话」进主题；其余进队友私聊；全队事项没有入口。
        // P72g B2：约定条目去总管私聊（inboxThreadId 内已处理）。
        const threadId = inboxThreadId(item)
        // P79：约定确认、组队确认、验收、说明卡四种条目多一个次要按钮（要修改、有不符、都不合适），
        // 点开写一句话，发到对应的对话（等同主人在对话里说的话）；没有接线发送时不显示。
        const objection = props.onSendMessage !== undefined ? objectionOf(item) : null
        const sendMessage = props.onSendMessage
        /** 带上次要按钮与输入区画条目的主体：没有次要按钮的条目原样画。 */
        const withObjection = (render: (button: ReactNode) => ReactNode): ReactNode => {
          if (objection === null || sendMessage === undefined) return render(null)
          // 提交状态：本组件记的，或上层传入的「正在处理这一条」（busyId），后者按提交中算。
          const lock = locks[item.id] ?? (props.busyId === item.id ? 'submitting' : 'none')
          return (
            // P74i-m4（第 3 节）：发出去的文字 = 界面拼的「（关于……）」说明 + 主人写的话（验收不加）。
            <ObjectionHost spec={objection.spec} itemKey={objectionKey(item)} itemTitle={item.title} lock={lock}
              send={text => sendMessage(objection.threadId, `${objection.prefix}${text}`)}
              onSent={notice => setHandled({ text: notice, threadId: objection.threadId })}>
              {({ button, panel }) => <>{render(button)}{panel}</>}
            </ObjectionHost>
          )
        }
        return (
          <article key={item.id} data-inbox-id={item.id} className={`ah-inbox-row ah-inbox-${item.priority.toLowerCase()}${focusedId === item.id ? ' is-focused' : ''}`}>
            {/* U01 第 37 轮（1.3.1）：这一行只是卡片内部的元信息布局槽，没有标题文本，
                用 header 会变成未命名地标；article 本身已经承担整条请求的分组语义，这里改回普通 div。 */}
            <div className="ah-inbox-row-head">
              {item.botName ? <Avatar color={item.botColor} initials={item.botName.slice(0, 1)} size={24} /> : null}
              <span className="ah-inbox-bot">{item.botName ?? '中心'}</span>
              {/* P65：主题名可能很长，一行放不下时省略，鼠标悬停看全名。 */}
              {item.topicTitle ? <span className="ah-inbox-topic" title={item.topicTitle}>来自主题：{item.topicTitle}</span> : null}
              {threadId !== null && props.onOpenThread ? <button type="button" className="ah-btn ah-btn-ghost" onClick={() => {
                // 约定条目多带一个约定 id，好让总管私聊滚到那张卡；其余条目调用方式不变。
                if (item.agreementId) props.onOpenThread?.(threadId, item.agreementId)
                else props.onOpenThread?.(threadId)
              }}>查看对话</button> : null}
              {/* P76g：开着满 1 小时的条目才有「已等 {时长}」；界面照原样显示，不自己算时长。 */}
              {item.waitedText !== undefined ? <span className="ah-inbox-waited">{item.waitedText}</span> : null}
              {/* 这里只放创建时间；有效期的含义由卡片正文统一说明，避免同一句话出现两遍。 */}
              <span className="ah-inbox-time">{item.createdText}</span>
            </div>
            {/* P74i-m1（第二次，任务卡 1.1）：说明条目（三轮不过的办法）带完整卡片（escalationCard）时，
                用与总管对话里同一个组件画——办法整行可点、单选、建议项预选但不自动提交、
                「选了会……」一行和「按所选办法处理」都在；不再显示只有标题的小按钮，正文不重复显示（卡片里已有）。 */}
            {item.jobEntry?.kind === 'escalate' ? (
              item.escalationCard != null ? (
                // P74i-m2（第四次审查低-4）：说明卡提交成功后同样给一句「已提交」提示（与其余条目同一句），
                // 卡片本身不经过 onPick，改为经 onSubmitted 通知；条目随后随刷新消失。
                // P74i-m5（第 3 节）：提示只写已发生的事：「已提交你选的办法。」。
                withObjection(button => (
                  <EscalationCard card={item.escalationCard!} extraAction={button} onLockChange={lock => setLock(item.id, lock)} onSubmitted={() => setHandled({
                    text: inboxHandledNotice(item, ''),
                    threadId,
                  })} />
                ))
              ) : (
                // escalationCard 为 null（不应出现）：只显示正文，不给任何可提交的按钮，保留「查看对话」。
                <div className="ah-card ah-card-question">
                  <div className="ah-card-head">
                    <span className="ah-card-type">{CARD_TYPE_LABELS.question}</span>
                    <span className="ah-card-title">{item.title}</span>
                  </div>
                  <p className="ah-card-body">{item.body}</p>
                </div>
              )
            ) : withObjection(button => (
              <InboxCard card={itemToCard(item)} priority={item.priority} extra={button} actions={{
                ...props.actions,
                // 本卡处理中禁用；处理完由 SSE 刷新把项移出列表。这里 force 触发本行重渲染，
                // 并在成功后给一句全局反馈（该项随即消失，没有别的地方能确认结果）。
                onPick: async (card, option, note) => {
                  force(n => n + 1)
                  // P74i-m4（第 2 节）：提交中锁住次要按钮；失败（含抛错）解锁，成功保持到条目消失。
                  setLock(item.id, 'submitting')
                  let failure: string | null
                  try { failure = await props.actions.onPick(card, option, note) } catch (caught) { setLock(item.id, 'none'); throw caught }
                  setLock(item.id, failure === null ? 'done' : 'none')
                  // P74i-m3（第 4 节）：按条目种类和主人点的按钮给提示（logic/inbox-notice.ts），
                  // 不再所有条目都写「下一步：继续执行」；P74i-m5 起提示一律不预告下一步。
                  if (failure === null) setHandled({
                    text: inboxHandledNotice(item, option),
                    threadId,
                  })
                  return failure
                },
              }} busy={props.busyId === item.id} />
            ))}
          </article>
        )
      })}
    </section>
  )
}

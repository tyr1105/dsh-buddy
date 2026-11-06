/**
 * 中栏线程视图（像发短信）：
 * - 头部：名字、角色、状态句（activityText 完整形）、下次自查文案，右侧「教它一招」
 *   「打开工作会话」「暂停/恢复」按钮（任务卡问题第 4 条）；正在处理（thinking）时
 *   显示「打断」按钮，二次确认后回调（D04 3b）。
 * - 顶部提示条（试跑提示等）放在头部下方、不遮挡输入框（D04 3c-3）。
 * - 气泡：主人靠右主色淡底；机器人靠左中性底带头像名字（连续同一发送者合并头像）；
 *   中心/日报/系统消息居中小字无气泡；汇报气泡左侧细色条（任务卡问题第 3 条）。
 * - 卡片内嵌（提问/审批/提议/告警）；底部输入框回车发送；向上「加载更早」。
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { ThreadMessageView, ThreadView } from '../../shared/views.js'
import { Avatar, EmptyHint, Skeleton } from './Ui.js'
import { InboxCard, type CardActions } from './Cards.js'
import { groupMessages, isCenterMessage, isSendEnter, shouldStickToBottom } from '../logic/thread.js'
import { pauseResumeAction } from '../logic/lifecycle.js'

/** 头部信息由上层从 BotCard 组装（团队线程没有这些，就不显示）。 */
export interface ThreadHeaderInfo {
  name: string
  roleLabel: string | null
  activityText: string | null
  nextThinkText: string | null
  lifecycle: 'paused' | 'active' | 'probation' | 'quarantined' | 'retired' | 'draft' | null
  /** 是否正在处理（activity=thinking）：线程头部显示「打断」按钮（D04 3b）。 */
  thinking: boolean
}

function Message(props: { m: ThreadMessageView; showHeader: boolean; actions: CardActions; busyInboxId: string | null }): ReactNode {
  const { m, showHeader } = props
  // 中心消息（system/digest）：居中、小字、无气泡。
  if (isCenterMessage(m)) {
    return <div className="ah-msg ah-msg-center"><span className="ah-msg-time">{m.timeText}</span><div className="ah-msg-bubble-center">{m.text}</div></div>
  }
  // 带卡片的消息只渲染卡片（D07 第 17 条）：卡片自带标题与正文，再画一个内容
  // 相同的气泡只会重复一遍。
  if (m.card) {
    return (
      <div className={`ah-msg${m.from === 'owner' ? ' ah-msg-mine' : ''}`}>
        {m.from === 'owner' || !showHeader ? null : <Avatar color={m.fromColor} initials={m.fromName.slice(0, 1)} size={28} />}
        <div className="ah-msg-body">
          {m.from === 'owner' || !showHeader ? null : <span className="ah-msg-meta">{m.fromName} · {m.timeText}</span>}
          {m.from === 'owner' && showHeader ? <span className="ah-msg-meta">{m.timeText}</span> : null}
          <InboxCard card={m.card} actions={props.actions} busy={props.busyInboxId === m.card.inboxId} />
        </div>
      </div>
    )
  }
  const mine = m.from === 'owner'
  return (
    <div className={`ah-msg${mine ? ' ah-msg-mine' : ''}${m.kind === 'report' ? ' ah-msg-report' : ''}`}>
      {mine || !showHeader ? null : <Avatar color={m.fromColor} initials={m.fromName.slice(0, 1)} size={28} />}
      <div className="ah-msg-body">
        {mine || !showHeader ? null : <span className="ah-msg-meta">{m.fromName} · {m.timeText}</span>}
        {mine && showHeader ? <span className="ah-msg-meta">{m.timeText}</span> : null}
        <div className="ah-msg-bubble">{m.text}</div>
      </div>
    </div>
  )
}

/** 底部附近的判定阈值：滚动位置离底部不到这个距离算「在底部」。 */
const NEAR_BOTTOM_PX = 120

/**
 * 各线程的输入草稿（模块级，交互审查第 5 条）：ThreadPane 以 key={threadId} 重挂载，
 * 状态会整个丢掉；把草稿存在组件外，切换队友再切回来，打到一半的字还在。
 * 只存纯文本草稿，不存任何派生状态。
 */
const threadDrafts = new Map<string, string>()

function readDraft(threadId: string): string {
  return threadDrafts.get(threadId) ?? ''
}
function saveDraft(threadId: string, text: string): void {
  if (text === '') threadDrafts.delete(threadId)
  else threadDrafts.set(threadId, text)
}

export function ThreadPane(props: {
  thread: ThreadView | null
  loading: boolean
  header: ThreadHeaderInfo | null
  inputPlaceholderName: string
  /** 线程顶部提示条（如「正在试跑」）：不遮挡输入框（D04 3c-3）。 */
  banner: string | null
  onBannerDismiss: () => void
  onLoadEarlier: () => void
  onSend: (text: string) => Promise<void>
  actions: CardActions
  busyInboxId: string | null
  onRetry: () => void
  error: string | null
  onTeach: () => void
  onOpenSession: () => void
  onTogglePause: () => void
  /** 打断当前回合（二次确认在组件内做；D04 3b）。 */
  onInterrupt: () => void
  /** 详情右栏收起时，线程头部显示「详情」按钮把它重新展开（交互审查第 1 条）。 */
  rightCollapsed?: boolean
  onExpandRight?: () => void
}): ReactNode {
  const [draft, setDraft] = useState(() => readDraft(props.thread?.threadId ?? ''))
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const [confirmInterrupt, setConfirmInterrupt] = useState(false)
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  /** 上一帧最后一条消息 id 与列表高度：判定贴底 / 保持滚动位置用。 */
  const prevLastIdRef = useRef<string | null>(null)
  const prevHeightRef = useRef<number | null>(null)

  // 每次提交后记录当前列表高度（布局阶段，先于滚动判定），供「加载更早」补偿位移。
  const messageCount = props.thread?.messages.length ?? 0
  useLayoutEffect(() => {
    const list = listRef.current
    if (list !== null) prevHeightRef.current = list.scrollHeight
  }, [messageCount])

  // 滚动控制（交互审查第 2 条）：规则在 shouldStickToBottom（可单测）——
  // 新消息且用户在底部附近才贴底；「加载更早」只在前面拼消息（最后一条没变），
  // 这时保持用户正在看的位置：把新增的高度补回 scrollTop，视口看起来纹丝不动。
  const lastId = props.thread?.messages.at(-1)?.id ?? null
  useEffect(() => {
    const list = listRef.current
    const prevLastId = prevLastIdRef.current
    prevLastIdRef.current = lastId
    if (list === null) return
    if (lastId !== null && prevLastId !== null && lastId === prevLastId) {
      // 最后一条没变：多半是往前拼了更早的历史（或已有消息状态更新），保位。
      const prevHeight = prevHeightRef.current
      prevHeightRef.current = list.scrollHeight
      if (prevHeight !== null && list.scrollHeight > prevHeight) list.scrollTop += list.scrollHeight - prevHeight
      return
    }
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < NEAR_BOTTOM_PX
    if (shouldStickToBottom({ prevLastId, lastId, nearBottom })) {
      bottomRef.current?.scrollIntoView({ block: 'end' })
    }
  }, [lastId, messageCount])

  const send = async (): Promise<void> => {
    const text = draft.trim()
    if (!text || sending) return
    setSending(true)
    setSendError(null)
    try {
      await props.onSend(text)
      saveDraft(props.thread?.threadId ?? '', '')
      setDraft('')
    } catch (error) {
      // 交互审查第 4 条：发送失败要让主人看得见（不再只进 console），草稿保留可重试。
      setSendError(error instanceof Error ? error.message : String(error) || '发送失败，请重试')
    } finally {
      setSending(false)
    }
  }

  const h = props.header
  if (props.error) {
    return <div className="ah-thread"><div className="ah-retry" role="alert"><span>{props.error}</span><button type="button" className="ah-btn" onClick={props.onRetry}>重试</button></div></div>
  }
  if (!props.thread) {
    return <div className="ah-thread">{props.loading ? <Skeleton rows={5} /> : <EmptyHint text="从左边选一个队友开始聊；它们的汇报和提问都会出现在对应线程里。" />}</div>
  }
  return (
    <section className="ah-thread" aria-label={`与 ${h?.name ?? props.thread.title} 的对话`}>
      <header className="ah-thread-header">
        <div className="ah-thread-header-main">
          <h2>{h?.name ?? props.thread.title}{h?.roleLabel ? <span className="ah-bot-row-role">{h.roleLabel}</span> : null}</h2>
          {h?.activityText ? <p className="ah-thread-status" title={h.activityText}>{h.activityText}</p> : null}
          {h?.nextThinkText ? <p className="ah-thread-next">下次自查：{h.nextThinkText}</p> : null}
        </div>
        <div className="ah-thread-header-actions">
          {props.thread.hasMore ? <button type="button" className="ah-btn ah-btn-ghost" onClick={props.onLoadEarlier}>加载更早</button> : null}
          {h?.thinking ? (
            confirmInterrupt ? (
              <>
                <button type="button" className="ah-btn ah-btn-danger" onClick={() => { setConfirmInterrupt(false); props.onInterrupt() }}>确认打断</button>
                <button type="button" className="ah-btn ah-btn-ghost" onClick={() => setConfirmInterrupt(false)}>再想想</button>
              </>
            ) : (
              <button type="button" className="ah-btn ah-btn-danger" onClick={() => setConfirmInterrupt(true)}>打断</button>
            )
          ) : null}
          {h && h.lifecycle !== null ? (
            <>
              <button type="button" className="ah-btn" onClick={props.onTeach}>教它一招</button>
              <button type="button" className="ah-btn" onClick={props.onOpenSession}>打开工作会话</button>
              {/* 交互审查第 1 条：右栏收起后唯一入口在头部这里——不补这个按钮，收起就再也打不开。 */}
              {props.rightCollapsed && props.onExpandRight ? (
                <button type="button" className="ah-btn" onClick={props.onExpandRight}>详情</button>
              ) : null}
              {/* 按当前状态只显示合法按钮（D06 第 3 条 / D07 第 24 条）：判断集中在
                  logic/lifecycle.ts 的纯函数（与右栏共用一份规则）。 */}
              {pauseResumeAction(h.lifecycle) !== null ? (
                <button type="button" className="ah-btn" onClick={props.onTogglePause}>{pauseResumeAction(h.lifecycle) === 'pause' ? '暂停' : '恢复'}</button>
              ) : null}
            </>
          ) : null}
        </div>
      </header>
      {props.banner ? (
        <div className="ah-thread-banner" role="status">
          <span>{props.banner}</span>
          <button type="button" className="ah-btn ah-btn-ghost" onClick={props.onBannerDismiss}>知道了</button>
        </div>
      ) : null}
      <div className="ah-thread-messages" ref={listRef}>
        {groupMessages(props.thread.messages).map(slot => (
          <Message key={slot.message.id} m={slot.message} showHeader={slot.showHeader}
            actions={props.actions} busyInboxId={props.busyInboxId} />
        ))}
        <div ref={bottomRef} />
      </div>
      <footer className="ah-thread-input">
        <input
          value={draft}
          placeholder={`给 ${props.inputPlaceholderName} 发消息…`}
          disabled={sending}
          onChange={(e) => { setDraft(e.target.value); saveDraft(props.thread?.threadId ?? '', e.target.value) }}
          onKeyDown={(e) => { if (isSendEnter(e.nativeEvent)) void send() }}
        />
        <button type="button" className="ah-btn ah-btn-primary" disabled={sending || draft.trim() === ''} onClick={() => void send()}>
          {sending ? '发送中…' : '发送'}
        </button>
      </footer>
      {sendError ? (
        <div className="ah-thread-senderror" role="alert">
          <span>没发出去：{sendError}</span>
          <button type="button" className="ah-btn" onClick={() => void send()}>重试</button>
        </div>
      ) : null}
    </section>
  )
}

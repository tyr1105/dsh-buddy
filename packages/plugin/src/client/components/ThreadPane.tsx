/**
 * 中栏线程视图（像发短信）：
 * - 头部：名字、角色、状态句（activityText 完整形）、下次自查文案，右侧「教它技能」
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
import { groupMessages, isCenterMessage, isSendEnter, threadScrollTop } from '../logic/thread.js'
import { pauseResumeAction } from '../logic/lifecycle.js'
import { insertMention, type MentionMember } from '../logic/mentions.js'

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
  /** 异步加载之前也有明确的线程身份，草稿不会落到空键里。 */
  threadId: string
  /** 无队友时解释第一步；只替代默认空提示，旧团队消息与输入仍然保留。 */
  intro?: ReactNode
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
  /** 从「待处理」跳转而来：头部显示回程钮，处理完能一键回到原处。 */
  fromInbox?: boolean
  onBackToInbox?: () => void
  /** 从队友主页的工作会话跳转而来（P33）：头部显示「返回队友主页」。 */
  fromHome?: boolean
  onBackHome?: () => void
  /**
   * 项目会话的 @ 上下文（P37）：只有从项目工作会话进来的线程才传，
   * 普通会话不传就不显示 @ 入口——避免在私聊里 @ 一个不在场的人。
   */
  mention?: { projectName: string; members: readonly MentionMember[] } | null
  /**
   * 当前打开的是哪条工作会话（P1-2）：侧栏子行和队友主页都带着任务 id 进来，
   * 线程头显示它的标题、项目与状态——同一队友同项目下的多条子行才分得清，
   * 点哪条进来就看见哪条，不会看起来都像同一个线程。
   */
  openedTask?: { title: string; projectName: string; statusLabel: string } | null
}): ReactNode {
  const [draft, setDraft] = useState(() => readDraft(props.threadId))
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const [confirmInterrupt, setConfirmInterrupt] = useState(false)
  /** 「更多」菜单的开合：把 6 个等权按钮收起来，头部只留一个主操作。 */
  const [menuOpen, setMenuOpen] = useState(false)
  /** @ 菜单的开合：只在项目会话里有入口（P37）。 */
  const [mentionOpen, setMentionOpen] = useState(false)
  const menuWrapRef = useRef<HTMLDivElement | null>(null)
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null)
  const mentionWrapRef = useRef<HTMLSpanElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  /** 上一帧最后一条消息 id 与列表高度：判定贴底 / 保持滚动位置用。 */
  const prevLastIdRef = useRef<string | null>(null)
  const prevHeightRef = useRef<number | null>(null)
  const prevTopRef = useRef(0)

  // 「更多」菜单：点外面或按 Esc 关闭；Esc 关闭后焦点回到触发按钮。
  // 所有监听都兜底，菜单出错不能影响线程本身。
  useEffect(() => {
    if (!menuOpen) return
    // 打开后焦点进入菜单第一项：键盘用户按回车打开就能直接操作，Esc 关闭仍回到「更多」。
    try {
      menuWrapRef.current?.querySelector<HTMLButtonElement>('.ah-thread-menu button:not(:disabled)')?.focus()
    } catch { /* 聚焦失败不影响菜单本身。 */ }
    const onPointerDown = (event: MouseEvent): void => {
      try {
        const target = event.target
        if (menuWrapRef.current !== null && target instanceof Node && !menuWrapRef.current.contains(target)) setMenuOpen(false)
      } catch { /* 关闭菜单失败不影响页面。 */ }
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      try {
        if (event.key !== 'Escape') return
        setMenuOpen(false)
        menuTriggerRef.current?.focus()
      } catch { /* 同上。 */ }
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [menuOpen])

  // 菜单关闭时清掉「确认打断」：下次打开回到普通菜单，不残留上回的确认态。
  useEffect(() => {
    if (!menuOpen) setConfirmInterrupt(false)
  }, [menuOpen])

  // 点「打断」后菜单内容换成确认按钮：焦点跟到「确认打断」，键盘用户不用重新找。
  useEffect(() => {
    if (!menuOpen || !confirmInterrupt) return
    try {
      menuWrapRef.current?.querySelector<HTMLButtonElement>('.ah-thread-menu .ah-btn-danger')?.focus()
    } catch { /* 同上。 */ }
  }, [menuOpen, confirmInterrupt])

  // @ 菜单：点外面或按 Esc 关闭；与「更多」同一套兜底，菜单出错不影响线程本身。
  useEffect(() => {
    if (!mentionOpen) return
    const onPointerDown = (event: MouseEvent): void => {
      try {
        const target = event.target
        if (mentionWrapRef.current !== null && target instanceof Node && !mentionWrapRef.current.contains(target)) setMentionOpen(false)
      } catch { /* 关闭菜单失败不影响页面。 */ }
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      try { if (event.key === 'Escape') setMentionOpen(false) } catch { /* 同上。 */ }
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [mentionOpen])

  // 记录上一版的高度和用户位置，在本版布局完成后补偿位移，不能提前覆盖旧高度。
  const messageCount = props.thread?.messages.length ?? 0

  // 滚动控制：规则在 threadScrollTop（可单测）——
  // 新消息且用户在底部附近才贴底；「加载更早」只在前面拼消息（最后一条没变），
  // 这时保持用户正在看的位置：把新增的高度补回 scrollTop，视口看起来纹丝不动。
  const lastId = props.thread?.messages.at(-1)?.id ?? null
  useLayoutEffect(() => {
    const list = listRef.current
    const prevLastId = prevLastIdRef.current
    if (list === null) return
    list.scrollTop = threadScrollTop({
      previousHeight: prevHeightRef.current ?? 0, previousTop: prevTopRef.current,
      viewportHeight: list.clientHeight, height: list.scrollHeight, previousLastId: prevLastId, lastId,
    })
    prevLastIdRef.current = lastId
    prevHeightRef.current = list.scrollHeight
    prevTopRef.current = list.scrollTop
  }, [lastId, messageCount])

  /**
   * 选中一位项目成员：把「@名字」插到光标处（有选中文字就替换），
   * 然后把焦点与光标交还输入框——主人可以接着把话打完，不用再点一次。
   */
  const pickMention = (name: string): void => {
    const el = textareaRef.current
    const start = el?.selectionStart ?? draft.length
    const end = el?.selectionEnd ?? start
    const next = insertMention(draft, start, end, name)
    setDraft(next.text)
    saveDraft(props.threadId, next.text)
    setMentionOpen(false)
    // 等 React 把新值写进 textarea 后再放光标；失败只是光标不在原位，不影响输入。
    requestAnimationFrame(() => {
      try {
        el?.focus()
        el?.setSelectionRange(next.caret, next.caret)
      } catch { /* 光标恢复失败不影响文本。 */ }
    })
  }

  const send = async (): Promise<void> => {
    const text = draft.trim()
    if (!text || sending) return
    setSending(true)
    setSendError(null)
    try {
      await props.onSend(text)
      saveDraft(props.threadId, '')
      setDraft('')
    } catch (error) {
      // 交互审查第 4 条：发送失败要让主人看得见（不再只进 console），草稿保留可重试。
      setSendError(error instanceof Error ? error.message : String(error) || '未返回原因')
    } finally {
      setSending(false)
    }
  }

  const h = props.header
  // 菜单里是否有可做的事：没有就不显示「更多」，避免点开一个空菜单。
  const hasMenuItems = (props.thread?.hasMore ?? false) || (h?.thinking ?? false) || (h !== null && h.lifecycle !== null)
  if (props.error) {
    return <div className="ah-thread"><div className="ah-retry" role="alert"><span>{props.error}</span><button type="button" className="ah-btn" onClick={props.onRetry}>重试</button></div></div>
  }
  if (!props.thread) {
    return <div className="ah-thread">{props.loading ? <Skeleton rows={5} /> : <EmptyHint text="从左边选一位队友。它的汇报和提问，都会留在这条会话里。" />}</div>
  }
  return (
    <section className="ah-thread" aria-label={`与 ${h?.name ?? props.thread.title} 的对话`}>
      <header className="ah-thread-header">
        <div className="ah-thread-header-main">
          {/* 从「待处理」来的：头部第一行就是回程入口，处理完不用再找顶栏。 */}
          {props.fromInbox && props.onBackToInbox ? (
            <button type="button" className="ah-back-link" onClick={props.onBackToInbox}>← 返回待你处理</button>
          ) : null}
          {/* 从队友主页的工作会话来的：回程目标是原队友主页，不是收件箱（P33）。 */}
          {props.fromHome && props.onBackHome ? (
            <button type="button" className="ah-back-link" onClick={props.onBackHome}>← 返回队友主页</button>
          ) : null}
          <h2>{h?.name ?? '团队全景'}{h?.roleLabel ? <span className="ah-bot-row-role">{h.roleLabel}</span> : null}</h2>
          {/* 工作会话的上下文（P1-2）：标题 + 项目 + 状态一行说完，同项目的多条子行不会看起来一样。 */}
          {props.openedTask ? (
            <p className="ah-thread-task" title={`${props.openedTask.title} · ${props.openedTask.projectName} · ${props.openedTask.statusLabel}`}>
              <span className="ah-thread-task-label">工作会话</span>
              <span className="ah-thread-task-title">{props.openedTask.title}</span>
              <span className="ah-thread-task-meta">{props.openedTask.projectName} · {props.openedTask.statusLabel}</span>
            </p>
          ) : null}
          {!h ? <p className="ah-thread-status">汇报、提问与团队消息，都留在这条会话里。</p> : null}
          {h?.activityText ? <p className="ah-thread-status" title={h.activityText}>{h.activityText}</p> : null}
          {/* 活动句（core 原文用「下次自查」）里已经带过这句时不再单独重复一行；
              界面标签按 audit 术语表写「下次叫醒」。 */}
          {h?.nextThinkText && !h.activityText?.includes('下次自查') ? <p className="ah-thread-next">下次叫醒：{h.nextThinkText}</p> : null}
        </div>
        <div className="ah-thread-header-actions">
          {/* 主操作唯一：头部只留「详情」，其余动作都收进「更多」。
              右栏收起后这是唯一入口，不能藏进菜单里。 */}
          {props.rightCollapsed && props.onExpandRight ? (
            // data-testid 是右栏抽屉关闭后归还键盘焦点的稳定锚点（该按钮在右栏打开期间卸载、关闭后重挂）。
            <button type="button" className="ah-btn ah-btn-primary" data-testid="ah-detail-open" onClick={props.onExpandRight}>详情</button>
          ) : null}
          {hasMenuItems ? (
            <div className="ah-thread-menu-wrap" ref={menuWrapRef}>
              <button
                type="button"
                className="ah-btn ah-btn-ghost"
                aria-expanded={menuOpen}
                aria-controls="ah-thread-more"
                ref={menuTriggerRef}
                onClick={() => setMenuOpen(open => !open)}
              >更多</button>
              {/* 受控面板常驻 DOM、用原生 hidden 收展：收起态下「更多」按钮的 aria-controls
                  仍能解析到本面板（WCAG 4.1.2），展开状态由按钮的 aria-expanded 表达。 */}
              <div className="ah-thread-menu" id="ah-thread-more" aria-label="更多操作" hidden={!menuOpen}>
                  {props.thread.hasMore ? (
                    <button type="button" className="ah-btn ah-btn-ghost" onClick={() => { setMenuOpen(false); props.onLoadEarlier() }}>加载更早</button>
                  ) : null}
                  {h?.thinking ? (
                    confirmInterrupt ? (
                      <>
                        <button type="button" className="ah-btn ah-btn-danger" onClick={() => { setMenuOpen(false); setConfirmInterrupt(false); props.onInterrupt() }}>确认打断</button>
                        <button type="button" className="ah-btn ah-btn-ghost" onClick={() => setConfirmInterrupt(false)}>取消</button>
                      </>
                    ) : (
                      <button type="button" className="ah-btn ah-btn-danger" onClick={() => setConfirmInterrupt(true)}>打断</button>
                    )
                  ) : null}
                  {(props.thread.hasMore || (h?.thinking ?? false)) && h !== null && h.lifecycle !== null ? <span className="ah-menu-sep" role="separator" /> : null}
                  {h && h.lifecycle !== null ? (
                    <>
                      <button type="button" className="ah-btn ah-btn-ghost" onClick={() => { setMenuOpen(false); props.onTeach() }}>教它技能</button>
                      <button type="button" className="ah-btn ah-btn-ghost" onClick={() => { setMenuOpen(false); props.onOpenSession() }}>打开工作会话</button>
                      {/* 按当前状态只显示合法按钮（D06 第 3 条 / D07 第 24 条）：判断集中在
                          logic/lifecycle.ts 的纯函数（与右栏共用一份规则）。 */}
                      {pauseResumeAction(h.lifecycle) !== null ? (
                        <button type="button" className="ah-btn ah-btn-ghost" onClick={() => { setMenuOpen(false); props.onTogglePause() }}>{pauseResumeAction(h.lifecycle) === 'pause' ? '暂停' : '恢复'}</button>
                      ) : null}
                    </>
                  ) : null}
              </div>
            </div>
          ) : null}
        </div>
      </header>
      {props.banner ? (
        <div className="ah-thread-banner" role="status">
          <span>{props.banner}</span>
          <button type="button" className="ah-btn ah-btn-ghost" onClick={props.onBannerDismiss}>关闭</button>
        </div>
      ) : null}
      <div className="ah-thread-messages" ref={listRef} onScroll={() => { if (listRef.current) prevTopRef.current = listRef.current.scrollTop }}>
        {props.intro ?? (props.thread.messages.length === 0 ? <div className="ah-thread-welcome"><span className="ah-brand-mark" aria-hidden="true">B</span><h3>{h ? `跟 ${h.name} 说下一步做什么。` : '从左边选一位队友。'}</h3><p>{h ? '说清目标，给点线索，或者教它一个技能。它做完会在这儿汇报。' : '它的汇报和提问，都会留在这条会话里。'}</p></div> : null)}
        {groupMessages(props.thread.messages).map(slot => (
          <Message key={slot.message.id} m={slot.message} showHeader={slot.showHeader}
            actions={props.actions} busyInboxId={props.busyInboxId} />
        ))}
      </div>
      {/* U01 第 37 轮（1.3.1）：输入区是线程里的独立功能区，显式命名，读屏可按地标直达。 */}
      <footer className="ah-thread-input" aria-label="消息输入区">
        <div className="ah-composer">
        <textarea
          ref={textareaRef}
          aria-label={`向 ${props.inputPlaceholderName} 发送消息`}
          rows={3}
          value={draft}
          placeholder={`向 ${props.inputPlaceholderName} 发送消息…`}
          disabled={sending}
          onChange={(e) => { setDraft(e.target.value); saveDraft(props.threadId, e.target.value) }}
          onKeyDown={(e) => { if (isSendEnter(e.nativeEvent)) { e.preventDefault(); void send() } }}
        />
        <div className="ah-composer-bottom">
          <span className="ah-composer-tools">
          {/* @ 入口只在项目会话出现（P37）：members 为空时也不显示，避免点开一个空菜单。 */}
          {props.mention !== null && props.mention !== undefined && props.mention.members.length > 0 ? (
            <span className="ah-mention-wrap" ref={mentionWrapRef}>
              <button
                type="button"
                className="ah-btn ah-btn-ghost ah-mention-trigger"
                aria-expanded={mentionOpen}
                aria-haspopup="listbox"
                title={`@ ${props.mention.projectName} 的成员`}
                onClick={() => setMentionOpen(open => !open)}
              >@ 队友</button>
              {mentionOpen ? (
                <div className="ah-mention-menu" role="listbox" aria-label={`@ ${props.mention.projectName} 的成员`}>
                  <span className="ah-mention-title">@ 项目成员 · {props.mention.projectName}</span>
                  {props.mention.members.map(member => (
                    <button key={member.botId} type="button" role="option" aria-selected={false}
                      className="ah-mention-item" onClick={() => pickMention(member.name)}>
                      <Avatar color={member.color} initials={member.initials} size={20} />
                      <span>{member.name}</span>
                    </button>
                  ))}
                </div>
              ) : null}
            </span>
          ) : null}
          <span>Enter 发送 · Shift + Enter 换行</span>
          </span>
        <button type="button" className="ah-btn ah-btn-primary" disabled={sending || draft.trim() === ''} onClick={() => void send()}>
          {sending ? '发送中…' : '发送'}
        </button>
        </div></div>
      </footer>
      {sendError ? (
        <div className="ah-thread-senderror" role="alert">
          <span>没发出去：{sendError}。点重试。还不行，看看 DSH 是不是关了。</span>
          <button type="button" className="ah-btn" onClick={() => void send()}>重试</button>
        </div>
      ) : null}
    </section>
  )
}

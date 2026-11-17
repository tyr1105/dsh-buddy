/**
 * 中栏线程视图（像发短信）：
 * - 头部：名字、角色、状态句（activityText 完整形）、下次自查文案，右侧「更多」菜单里有
 *   「打开工作会话」「暂停/恢复」按钮（任务卡问题第 4 条；P75k 起没有教学入口，要员工学某段会话的做法改为对总管说）；正在处理（thinking）时
 *   显示「打断」按钮，二次确认后回调（D04 3b）。
 * - 顶部提示条（试跑提示等）放在头部下方、不遮挡输入框（D04 3c-3）。
 * - 气泡：主人靠右主色淡底；机器人靠左中性底带头像名字（连续同一发送者合并头像）；
 *   中心/日报/系统消息居中小字无气泡；汇报气泡左侧细色条（任务卡问题第 3 条）。
 * - 卡片内嵌（提问/审批/提议/告警）；底部输入框回车发送；向上「加载更早」。
 * - 项目主题（P63）复用这个页面：头部换成主题名和项目名，楼层换成 TopicThreadBody 的群聊样式，
 *   输入框可以 @ 项目成员，不显示右侧边栏，「更多」里只留主题用得上的。
 */
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { StaffStatus, ThreadMessageView, ThreadView } from '../../shared/views.js'
import { Avatar, EmptyHint, Skeleton } from './Ui.js'
import { InboxCard, type CardActions } from './Cards.js'
import { AgreementCard } from './AgreementCard.js'
import { TeamCard } from './TeamCard.js'
import { TeamQuestionCard } from './TeamQuestionCard.js'
import { JobCard } from './JobCard.js'
import { isDrawableJobCard } from '../../shared/job-card-kinds.js'
import { TEAM_TEXT, questionInProgress } from '../logic/team-card.js'
import { AGR_TEXT, chiefPendingStatusOf, composerPlaceholder, hasPendingAgreement, hasPendingTeamCard } from '../logic/agreement.js'
import { groupMessages, isCenterMessage, isSendEnter, threadScrollTop } from '../logic/thread.js'
import { headerStatusAction, headerStatusLabel } from '../logic/lifecycle.js'
import { insertMention } from '../logic/mentions.js'
import { buildTopicThread, type TopicPaneInfo } from '../logic/topics.js'
import { TopicThreadBody } from './TopicThreadBody.js'
import { MemoryNotes } from './MemoryNoteRow.js'

/** 头部信息由上层从 BotCard 或主题组装；P71 团队全景下线后，摆出来的对话总有头部，null 只作兜底。 */
export interface ThreadHeaderInfo {
  name: string
  roleLabel: string | null
  activityText: string | null
  nextThinkText: string | null
  /** P73f：员工状态（在岗、停用、归档）；null 表示不是员工对话（主题等），不显示状态相关的菜单项。 */
  staffStatus: StaffStatus | null
  /** 是否正在处理（activity=thinking）：线程头部显示「打断」按钮（D04 3b）。 */
  thinking: boolean
}

/** 一条消息。写成普通函数而不是子组件（与约定卡同一取舍）：测试能直接检查每种消息的画法。 */
function messageNode(m: ThreadMessageView, showHeader: boolean, actions: CardActions, busyInboxId: string | null): ReactNode {
  // 中心消息（system/digest）：居中、小字、无气泡。
  if (isCenterMessage(m)) {
    return <div className="ah-msg ah-msg-center"><span className="ah-msg-time">{m.timeText}</span><div className="ah-msg-bubble-center">{m.text}</div></div>
  }
  // P74h：工作往来只在主题里画（折叠组）；私聊里一般不会出现，兜底按普通中心提示画，
  // 不让一条员工之间的消息在私聊里冒充总管对主人说的话。
  if (m.kind === 'work') {
    return <div className="ah-msg ah-msg-center"><span className="ah-msg-time">{m.timeText}</span><div className="ah-msg-bubble-center">{m.text}</div></div>
  }
  // P72：约定卡（kind 为 agreement 且找到了对应版本）整张渲染；找不到时 agreement 为 null，
  // 退回下面的普通气泡显示 text，主人至少看得到「约定「X」第 N 版」这句话。
  if (m.agreement) {
    return (
      <div className="ah-msg">
        {showHeader ? <Avatar color={m.fromColor} initials={m.fromName.slice(0, 1)} size={28} /> : null}
        <div className="ah-msg-body ah-msg-body-wide">
          {showHeader ? <span className="ah-msg-meta">{m.fromName} · {m.timeText}</span> : null}
          <AgreementCard card={m.agreement} onConfirm={actions.onConfirmAgreement} onOpenMemory={actions.onOpenMemory} />
        </div>
      </div>
    )
  }
  // P73e：三问卡。问题正文照普通消息气泡画，选项按钮在气泡下面；没有接线（actions 里没有回答函数）时只显示气泡。
  if (m.teamQuestion && actions.onAnswerTeamQuestion !== undefined) {
    return (
      <div className="ah-msg">
        {showHeader ? <Avatar color={m.fromColor} initials={m.fromName.slice(0, 1)} size={28} /> : null}
        <div className="ah-msg-body ah-msg-body-wide">
          {showHeader ? <span className="ah-msg-meta">{m.fromName} · {m.timeText}</span> : null}
          <div className="ah-msg-bubble">{m.text}</div>
          <TeamQuestionCard question={m.teamQuestion} onAnswer={actions.onAnswerTeamQuestion} pickFolder={actions.pickFolder} />
        </div>
      </div>
    )
  }
  // P73e：组队卡整张渲染；找不到对应卡（teamCard 为 null）或没有接线时退回普通气泡显示 text。
  if (m.teamCard && actions.onEditTeamCandidate !== undefined && actions.onConfirmTeam !== undefined) {
    return (
      <div className="ah-msg">
        {showHeader ? <Avatar color={m.fromColor} initials={m.fromName.slice(0, 1)} size={28} /> : null}
        <div className="ah-msg-body ah-msg-body-wide">
          {showHeader ? <span className="ah-msg-meta">{m.fromName} · {m.timeText}</span> : null}
          <TeamCard card={m.teamCard} onEdit={actions.onEditTeamCandidate} onConfirm={actions.onConfirmTeam} />
        </div>
      </div>
    )
  }
  // P74h：交回卡、核对卡（job_card）整张渲染；找不到对应记录（jobCard 为 null）时
  // 退回普通气泡显示 text，主人至少看得到「活动报名页　第 1 轮」这样的标题。
  // P74i-m1（走查 G-5）：回执是主题里独立的一张事实卡片，不显示头像、名字和时间。
  // 复盘卡、技能核对卡由 P75k 画，在那之前不显示：不在白名单内的种类不走这里，退回后面的普通气泡。
  if (m.jobCard && isDrawableJobCard(m.jobCard)) {
    const receipt = m.jobCard.kind === 'receipt'
    return (
      <div className="ah-msg">
        {!receipt && showHeader ? <Avatar color={m.fromColor} initials={m.fromName.slice(0, 1)} size={28} /> : null}
        <div className="ah-msg-body ah-msg-body-wide">
          {!receipt && showHeader ? <span className="ah-msg-meta">{m.fromName} · {m.timeText}</span> : null}
          <JobCard card={m.jobCard} />
        </div>
      </div>
    )
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
          <InboxCard card={m.card} actions={actions} busy={busyInboxId === m.card.inboxId} />
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
  /** 需要额外解释第一步时传；只替代默认空提示，消息与输入仍然保留。 */
  intro?: ReactNode
  thread: ThreadView | null
  loading: boolean
  header: ThreadHeaderInfo | null
  inputPlaceholderName: string
  /** P72：当前是总管私聊（全队入口）时输入框占位换成「交代一件事……」；其他员工和主题不传。 */
  chiefEntry?: boolean
  /**
   * P72g B2：从待你处理的约定条目点「查看对话」进来时，要滚到的那份约定。
   * 线程加载出那张卡后滚一次，卡顶对齐可视区顶部；找不到就保持原来的滚动位置（贴底）。
   */
  focusAgreementId?: string | null
  /** 线程顶部提示条（如「正在试跑」）：不遮挡输入框（D04 3c-3）。 */
  banner: string | null
  onBannerDismiss: () => void
  onLoadEarlier: () => void
  onSend: (text: string) => Promise<void>
  actions: CardActions
  busyInboxId: string | null
  onRetry: () => void
  error: string | null
  onOpenSession: () => void
  onTogglePause: () => void
  /** 打断当前回合（二次确认在组件内做；D04 3b）。 */
  onInterrupt: () => void
  /** 右侧边栏收起时（默认就是收起，P64），线程头部显示「查看状态」按钮把它展开。 */
  rightCollapsed?: boolean
  onExpandRight?: () => void
  /** P78：「更多」菜单里「编辑员工」的回调，打开页面层的编辑弹窗（与右侧栏底部按钮是同一个弹窗）；主题页不传。 */
  onEditStaff?: () => void
  /** 从「待处理」跳转而来：头部显示回程钮，处理完能一键回到原处。 */
  fromInbox?: boolean
  onBackToInbox?: () => void
  /**
   * 当前线程是项目主题时传（P63），私聊不传。
   * @ 入口也只在这里出现：私聊里 @ 一个不在场的人没有意义。
   */
  topic?: TopicPaneInfo | null
  /** 挂载时把光标放进输入框（P60 草稿主题：点了「新开会话」就该直接打字）。 */
  autoFocus?: boolean
  /**
   * P76k：点「知道了，收起」时调用（由页面发 dismissAwaySummary 并刷新线程）。
   * 不传时摘要只读显示按钮，不发命令。
   */
  onDismissAway?: () => Promise<void>
}): ReactNode {
  const [draft, setDraft] = useState(() => readDraft(props.threadId))
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const [confirmInterrupt, setConfirmInterrupt] = useState(false)
  /** P76k：收起离开期间摘要的进行中与失败原因（失败留在块里，不吞掉）。 */
  const [dismissingAway, setDismissingAway] = useState(false)
  const [dismissAwayError, setDismissAwayError] = useState<string | null>(null)
  /** 「更多」菜单的开合：把 6 个等权按钮收起来，头部只留一个主操作。 */
  const [menuOpen, setMenuOpen] = useState(false)
  /** @ 菜单的开合：只在项目主题里有入口（P37、P63）。 */
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

  // P72g B2：约定条目的「查看对话」要落在那张约定卡上。同一份约定在线程里可能有几个版本，
  // 取最后一张（最新版）；每次挂载只滚一次，之后新消息照常贴底，不再把你拽回来。
  const focusedOnceRef = useRef<string | null>(null)
  useLayoutEffect(() => {
    try {
      const id = props.focusAgreementId
      const list = listRef.current
      if (id === null || id === undefined || list === null || focusedOnceRef.current === id) return
      const cards = list.querySelectorAll<HTMLElement>(`[data-agreement-id="${id}"]`)
      const target = cards.item(cards.length - 1)
      if (target === null) return
      focusedOnceRef.current = id
      // 用列表自己的滚动位置算，而不是 scrollIntoView：后者可能连外层页面一起滚。
      const top = target.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop - 8
      list.scrollTop = Math.max(0, top)
      prevTopRef.current = list.scrollTop
    } catch { /* 定位失败只是停在原位置，不影响对话。 */ }
  }, [props.focusAgreementId, lastId, messageCount])

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
  /**
   * P76k：离开期间摘要（总管私聊视图的 awaySummary）。它不是消息、不计未读，
   * 画在消息列表最上方；首行加粗，其余每项一行。收起成功后刷新线程，字段消失，这块自然不再画。
   */
  const away = props.thread?.awaySummary ?? null
  const dismissAway = async (): Promise<void> => {
    if (props.onDismissAway === undefined || dismissingAway) return
    setDismissingAway(true)
    setDismissAwayError(null)
    try {
      await props.onDismissAway()
    } catch (error) {
      setDismissAwayError(error instanceof Error ? error.message : String(error))
    } finally {
      setDismissingAway(false)
    }
  }
  // P72g B5：总管私聊（不是主题）才有「全队入口」标签；有待确认约定卡时状态行换句。
  const chiefHeader = props.chiefEntry === true && (props.topic === null || props.topic === undefined)
  const chiefPending = chiefHeader && props.thread !== null && hasPendingAgreement(props.thread.messages)
  // P73f：有待确认的组队卡时同理换成「等你确认组队卡。确认前没有员工入职。」；两种卡不会同时待确认，约定卡优先只是兜底。
  const chiefPendingTeam = chiefHeader && !chiefPending && props.thread !== null && hasPendingTeamCard(props.thread.messages)
  // 菜单里是否有可做的事：没有就不显示「更多」，避免点开一个空菜单。
  // P78：员工私聊（staffStatus 非空）始终有「编辑员工」，已归档的员工不能再改档案，不显示这一项。
  const canEditStaff = h !== null && h.staffStatus !== null && h.staffStatus !== 'archived'
  const hasMenuItems = (props.thread?.hasMore ?? false) || (h?.thinking ?? false) || (h !== null && h.staffStatus !== null)
  if (props.error) {
    return <div className="ah-thread"><div className="ah-retry" role="alert"><span>{props.error}</span><button type="button" className="ah-btn" onClick={props.onRetry}>重试</button></div></div>
  }
  if (!props.thread) {
    return <div className="ah-thread">{props.loading ? <Skeleton rows={5} /> : <EmptyHint text="从左边选一位员工。它的汇报和提问，都会留在这条会话里。" />}</div>
  }
  return (
    <section className="ah-thread" aria-label={`与 ${h?.name ?? props.thread.title} 的对话`}>
      <header className="ah-thread-header">
        <div className="ah-thread-header-main">
          {/* 从「待处理」来的：头部第一行就是回程入口，处理完不用再找顶栏。 */}
          {props.fromInbox && props.onBackToInbox ? (
            <button type="button" className="ah-back-link" onClick={props.onBackToInbox}>← 返回待你处理</button>
          ) : null}
          {/* P72g B5：总管私聊顶部，名字旁写「全队入口」标签（代替角色字「总管」，名字已经是总管）。 */}
          <h2>{h?.name ?? props.thread.title}{chiefHeader ? <span className="ah-tag ah-tag-entry">{AGR_TEXT.chiefTag}</span> : h?.roleLabel ? <span className="ah-bot-row-role">{h.roleLabel}</span> : null}</h2>
          {props.topic?.projectName ? <p className="ah-thread-status">{props.topic.projectName}</p> : null}
          {/* P72g B5：有待确认的约定时，状态行换成「等你确认约定。…」，不再显示别的活动句。
              P74h-m1 第 6 处：待确认卡带两栏（有正在做的事）时用「确认前，暂停的部分不会做。」那句。 */}
          {chiefPending ? <p className="ah-thread-status" data-testid="ah-chief-pending-status">{chiefPendingStatusOf(props.thread!.messages)}</p> : null}
          {chiefPendingTeam ? <p className="ah-thread-status" data-testid="ah-chief-pending-status">{AGR_TEXT.chiefPendingTeamStatus}</p> : null}
          {!chiefPending && !chiefPendingTeam && h?.activityText ? <p className="ah-thread-status" title={h.activityText}>{h.activityText}</p> : null}
          {/* 活动句（core 原文用「下次自查」）里已经带过这句时不再单独重复一行；
              界面标签按 audit 术语表写「下次叫醒」。 */}
          {!chiefPending && !chiefPendingTeam && h?.nextThinkText && !h.activityText?.includes('下次自查') ? <p className="ah-thread-next">下次叫醒：{h.nextThinkText}</p> : null}
        </div>
        <div className="ah-thread-header-actions">
          {/* 主操作唯一：头部只留「查看状态」，其余动作都收进「更多」。
              右侧边栏默认收起，这是唯一的展开入口，不能藏进菜单里。 */}
          {props.rightCollapsed && props.onExpandRight ? (
            // data-testid 是右栏抽屉关闭后归还键盘焦点的稳定锚点（该按钮在右栏打开期间卸载、关闭后重挂）。
            <button type="button" className="ah-btn ah-btn-primary" data-testid="ah-detail-open" onClick={props.onExpandRight}>查看状态</button>
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
                  {/* P78：放在第一项，打开后焦点先进入它。点它之前先把焦点交还「更多」再关菜单：
                      弹窗按「打开时的焦点所在」还焦，菜单收起后那一项已不可见，必须让它记住「更多」。 */}
                  {canEditStaff ? (
                    <button type="button" className="ah-btn ah-btn-ghost" onClick={() => { try { menuTriggerRef.current?.focus() } catch { /* 还焦失败不影响打开弹窗。 */ } setMenuOpen(false); props.onEditStaff?.() }}>编辑员工</button>
                  ) : null}
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
                  {(props.thread.hasMore || (h?.thinking ?? false)) && h !== null && h.staffStatus !== null ? <span className="ah-menu-sep" role="separator" /> : null}
                  {h && h.staffStatus !== null ? (
                    <>
                      <button type="button" className="ah-btn ah-btn-ghost" onClick={() => { setMenuOpen(false); props.onOpenSession() }}>打开工作会话</button>
                      {/* 按当前状态只显示合法按钮（D06 第 3 条 / D07 第 24 条）：判断集中在
                          logic/lifecycle.ts 的纯函数（与右栏共用一份规则）。 */}
                      {headerStatusAction(h.staffStatus) !== null ? (
                        <button type="button" className="ah-btn ah-btn-ghost" onClick={() => { setMenuOpen(false); props.onTogglePause() }}>{headerStatusLabel(headerStatusAction(h.staffStatus)!)}</button>
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
      {/* P76n：离开摘要的 live 区域常驻在 DOM 里（空态也在），摘要插入时才播报。
          不要改成条件挂载或 display:none，读屏会吞掉首次播报。视觉摘要仍在下面的消息列表里。 */}
      <div className="ah-away-live" role="status" aria-live="polite" aria-atomic="false">
        {away !== null && away.lines.length > 0 ? away.lines.join('；') : ''}
      </div>
      <div className="ah-thread-messages" ref={listRef} onScroll={() => { if (listRef.current) prevTopRef.current = listRef.current.scrollTop }}>
        {/* P76k：离开期间摘要放在第一条消息之前；首行加粗，其余一行一项，底部一个文字按钮。 */}
        {away !== null && away.lines.length > 0 ? (
          <section className="ah-away" aria-label="你离开的这段时间">
            {away.lines.map((line, index) => index === 0
              ? <p key={index} className="ah-away-head"><strong>{line}</strong></p>
              : <p key={index} className="ah-away-line">{line}</p>)}
            <button type="button" className="ah-btn ah-btn-ghost ah-away-dismiss" disabled={dismissingAway}
              onClick={() => void dismissAway()}>知道了，收起</button>
            {dismissAwayError !== null ? <p className="ah-settings-error" role="alert">没收起：{dismissAwayError}</p> : null}
          </section>
        ) : null}
        {props.intro ?? ((props.topic === null || props.topic === undefined) && props.thread.messages.length === 0 ? <div className="ah-thread-welcome"><span className="ah-brand-mark" aria-hidden="true">B</span><h3>{h ? `跟 ${h.name} 说下一步做什么。` : '从左边选一位员工。'}</h3><p>{h ? '说明目标和已知的线索。完成后会在这里汇报。' : '它的汇报和提问，都会留在这条会话里。'}</p></div> : null)}
        {/* 还没有楼层的主题只可能是草稿（P60）：不画「0 条回复」，由 intro 说明怎么开始。 */}
        {props.topic !== null && props.topic !== undefined && props.thread.messages.length > 0 ? (
          <TopicThreadBody model={buildTopicThread(props.thread.messages, props.thread.hasMore, { hasAgreement: Boolean(props.thread.agreement) })}
            replying={props.topic.replying} actions={props.actions} busyInboxId={props.busyInboxId}
            agreement={props.thread.agreement ?? null}
            progress={props.thread.progress ?? null}
            floors={props.thread.floors}
            onLoadEarlier={props.thread.hasMore ? props.onLoadEarlier : undefined} />
        ) : groupMessages(props.thread.messages).map(slot => (
          <Fragment key={slot.message.id}>
            {messageNode(slot.message, slot.showHeader, props.actions, props.busyInboxId)}
            {/* P75k：这条消息下面挂着的「已记住」「已删除」「已更正」行（core 的 memoryNotes），缩进与消息正文对齐。 */}
            <MemoryNotes notes={slot.message.memoryNotes} onUndo={props.actions.onUndoMemory} />
          </Fragment>
        ))}
      </div>
      {/* 项目不在进行中时主题只能看：引擎也会拒收，这里直接说清楚，不让主人打完字才知道。 */}
      {props.topic?.readOnlyText ? <p className="ah-topic-readonly" role="status">{props.topic.readOnlyText}</p> : (
      /* U01 第 37 轮（1.3.1）：输入区是线程里的独立功能区，显式命名，读屏可按地标直达。 */
      <footer className="ah-thread-input" aria-label="消息输入区">
        <div className="ah-composer">
        <textarea
          ref={textareaRef}
          aria-label={props.topic ? '在这条会话里发言' : `向 ${props.inputPlaceholderName} 发送消息`}
          rows={3}
          autoFocus={props.autoFocus}
          value={draft}
          placeholder={props.topic?.placeholder ?? (questionInProgress(props.thread.messages)
            // P73e：三问进行中，输入框占位换成「点选上面的选项，或写下你的回答」；三问结束后恢复第一块的占位文字。
            ? TEAM_TEXT.questionPlaceholder
            : composerPlaceholder({ chief: props.chiefEntry === true, name: props.inputPlaceholderName }))}
          disabled={sending}
          onChange={(e) => { setDraft(e.target.value); saveDraft(props.threadId, e.target.value) }}
          onKeyDown={(e) => { if (isSendEnter(e.nativeEvent)) { e.preventDefault(); void send() } }}
        />
        <div className="ah-composer-bottom">
          <span className="ah-composer-tools">
          {/* @ 入口只在主题里出现（P37、P63）：members 为空时也不显示，避免点开一个空菜单。 */}
          {props.topic !== null && props.topic !== undefined && props.topic.members.length > 0 ? (
            <span className="ah-mention-wrap" ref={mentionWrapRef}>
              <button
                type="button"
                className="ah-btn ah-btn-ghost ah-mention-trigger"
                aria-expanded={mentionOpen}
                aria-haspopup="listbox"
                title={`@ ${props.topic.projectName} 的成员`}
                onClick={() => setMentionOpen(open => !open)}
              >@ 员工</button>
              {mentionOpen ? (
                <div className="ah-mention-menu" role="listbox" aria-label={`@ ${props.topic.projectName} 的成员`}>
                  <span className="ah-mention-title">@ 项目成员 · {props.topic.projectName}</span>
                  {props.topic.members.map(member => (
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
      )}
      {sendError ? (
        <div className="ah-thread-senderror" role="alert">
          <span>没发出去：{sendError}。点重试。还不行，看看 DSH 是不是关了。</span>
          <button type="button" className="ah-btn" onClick={() => void send()}>重试</button>
        </div>
      ) : null}
    </section>
  )
}

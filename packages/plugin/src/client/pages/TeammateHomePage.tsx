/**
 * 队友主页（P33）：中栏的「这个队友在做什么」。
 *
 * 结构照 Demo：顶部是队友摘要，下面分「在做 / 已归档」；每段按项目分组，
 * 项目是母、工作会话是子。会话行点开进入该队友的线程（头部有「返回队友主页」），
 * 「完成并归档」只对进行中的会话出现，且只发 reportDone 让任务进入待验收。
 *
 * 数据：工作会话由 logic/work-session 从项目视图投影而来，页面不自己判断状态；
 * 项目视图还没到时只显示骨架与「重试」，不假装没有工作。
 */
import { useState, type ReactNode } from 'react'
import type { BotCard, ProjectView } from '../../shared/views.js'
import type { WorkSession, WorkSessionGroup } from '../logic/work-session.js'
import { buildTeammateHome } from '../logic/teammate-home.js'
import { WorkSessionRow } from '../components/work-session-row.js'
import { WorkBoardView } from '../components/work-board.js'
import { buildWorkBoard, type WorkBoardCard, type WorkBoardCommand } from '../logic/work-board.js'
import { boardCardActions, teammateBoardItems, type WorkBoardActionKind } from '../logic/work-board-source.js'
import { Avatar, Skeleton, UnreadBadge } from '../components/Ui.js'

/** 项目分组：母行可收起；归档分组是只读标题，不再做展开交互。 */
function ProjectGroup(props: {
  group: WorkSessionGroup
  collapsed: boolean
  onToggle: () => void
  busyTaskId: string | null
  onOpen: (session: WorkSession) => void
  onComplete: (session: WorkSession) => void
}): ReactNode {
  const group = props.group
  return (
    <div className="ah-home-group">
      <button
        type="button"
        className="ah-home-group-head"
        aria-expanded={!props.collapsed}
        onClick={props.onToggle}
      >
        <span className="ah-home-group-name">{group.projectName}</span>
        <span className="ah-home-group-count">{group.sessions.length} 件{group.archived ? ' · 已归档项目' : ''}</span>
      </button>
      {props.collapsed ? null : (
        <div className="ah-home-group-body">
          {group.sessions.map(session => (
            <WorkSessionRow
              key={session.id}
              session={session}
              busy={props.busyTaskId === session.id}
              onOpen={props.onOpen}
              onComplete={props.onComplete}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/** 归档分组的标题不做展开：整段已经由「展开已归档」控制，避免再点两层。 */
function ArchivedGroup(props: {
  group: WorkSessionGroup
  busyTaskId: string | null
  onOpen: (session: WorkSession) => void
  onComplete: (session: WorkSession) => void
}): ReactNode {
  const group = props.group
  return (
    <div className="ah-home-group">
      <div className="ah-home-group-head ah-home-group-static">
        <span className="ah-home-group-name">{group.projectName}</span>
        <span className="ah-home-group-count">{group.sessions.length} 件</span>
      </div>
      <div className="ah-home-group-body">
        {group.sessions.map(session => (
          <WorkSessionRow
            key={session.id}
            session={session}
            busy={props.busyTaskId === session.id}
            onOpen={props.onOpen}
            onComplete={props.onComplete}
          />
        ))}
      </div>
    </div>
  )
}

export function TeammateHomePage(props: {
  bot: BotCard
  /** 工作会话；null 表示项目视图还没拉到。 */
  sessions: readonly WorkSession[] | null
  /** 项目视图（P35 看板的数据源；与工作会话同一份记录）。 */
  project: ProjectView | null
  loading: boolean
  /** 交账结果等一次性提示；由页面顶部显示，切走队友即清空。 */
  notice: string | null
  /** 正在提交的会话 id：只禁用那一行的按钮。 */
  busyTaskId: string | null
  onRetry: () => void
  onOpenSession: (session: WorkSession) => void
  onComplete: (session: WorkSession) => void
  /** 打开和这个队友的私聊线程（U01 r46）：主页回答「它在做什么」，但新队友还没有
   *  工作会话时，主页没有任何开口说话的入口，互动线「新建队友→第一次对话」会断。 */
  onOpenThread: () => void
  /** 看板「领取」：让当前队友领走这条待领事项（走 dispatchTask）。 */
  onClaimTask: (card: WorkBoardCard) => void
  /** 看板「交账」：把进行中的工作推进到待验收（走 reportDone）。 */
  onSubmitTask: (card: WorkBoardCard) => void
}): ReactNode {
  const bot = props.bot
  /** 收起的项目分组；默认全展开，主人点一下才收起。 */
  const [collapsed, setCollapsed] = useState<string[]>([])
  /** 已归档整段默认折叠：交出去的活不该占首屏。 */
  const [archivedOpen, setArchivedOpen] = useState(false)
  /** 「列表 / 看板」两种看法：默认列表，与项目页同一套切换语言。 */
  const [mode, setMode] = useState<'list' | 'board'>('list')
  /** 看板的解释型提示（例如任务在最新视图里被改动时）。 */
  const [boardNotice, setBoardNotice] = useState<string | null>(null)

  // 看板数据源：自己名下的任务 + 所在进行中项目里还没被领走的待领事项。
  // 与列表来自同一份 ProjectView，不另存记录。
  const board = buildWorkBoard(props.project === null ? [] : teammateBoardItems(props.project, bot.id))
  const statusById = new Map((props.project?.projects ?? []).map(row => [row.project.id, row.project.status]))
  const actionsOf = (card: WorkBoardCard): WorkBoardActionKind[] =>
    boardCardActions(card.status, statusById.get(card.projectId) ?? 'archived', 'teammate')
  const runBoardAction = (kind: WorkBoardActionKind, card: WorkBoardCard): void => {
    setBoardNotice(null)
    if (kind === 'claim') props.onClaimTask(card)
    else if (kind === 'submit') props.onSubmitTask(card)
  }
  /** 拖拽落列：能到这里的都是 workBoardMove 判过的合法方向，复用同一套按钮动作。
   *  「在做拖回待领」已在纯逻辑层判非法，由看板自己弹原因，不会进到这里。 */
  const runBoardMove = (card: WorkBoardCard, command: WorkBoardCommand): void => {
    runBoardAction(command, card)
  }

  // 数据还没到时也用空会话建模型：hooks 顺序不变，页面结构也不跳。
  const model = buildTeammateHome({
    botId: bot.id,
    botName: bot.name,
    roleLabel: bot.roleLabel,
    activityText: bot.activityText,
    unread: bot.unread,
    sessions: props.sessions ?? [],
  })
  const toggleProject = (projectId: string): void => {
    setCollapsed(prev => (prev.includes(projectId) ? prev.filter(id => id !== projectId) : [...prev, projectId]))
  }

  return (
    <section className="ah-home" aria-label={`${bot.name} 的队友主页`}>
      <header className="ah-home-head">
        <Avatar color={bot.color} initials={bot.initials} />
        <div className="ah-home-head-main">
          <h2>{bot.name}{bot.roleLabel ? <span className="ah-home-role">{bot.roleLabel}</span> : null}</h2>
          <p className="ah-home-activity" title={bot.activityText}>{bot.activityText}</p>
          {props.notice ? <p className="ah-home-notice" role="alert">{props.notice}</p> : null}
        </div>
        {/* 主操作唯一且常驻：不管有没有工作会话，都能从主页直接开口找它（r46）。
            未读数贴着按钮放——它数的正是这条对话里的未读，语义同槽。 */}
        <div className="ah-home-head-actions">
          <button
            type="button"
            className="ah-btn ah-btn-primary"
            data-testid="ah-home-open-thread"
            onClick={props.onOpenThread}
          >打开对话</button>
          <UnreadBadge count={bot.unread} />
        </div>
      </header>

      <div className="ah-home-scroll">
        {props.sessions === null ? (
          props.loading ? <Skeleton rows={5} /> : (
            <div className="ah-home-empty">
              <p>项目里的工作还没加载出来。</p>
              <button type="button" className="ah-btn" onClick={props.onRetry}>重试</button>
            </div>
          )
        ) : (
          <>
            {/* P35：列表与看板是同一份任务记录的两种看法；切换只改呈现，不写数据。 */}
            <div className="ah-home-viewbar">
              <div className="ah-seg" role="group" aria-label="队友看法">
                <button type="button" className={`ah-seg-btn${mode === 'list' ? ' ah-seg-on' : ''}`}
                  aria-pressed={mode === 'list'} onClick={() => { setMode('list'); setBoardNotice(null) }}>列表</button>
                <button type="button" className={`ah-seg-btn${mode === 'board' ? ' ah-seg-on' : ''}`}
                  aria-pressed={mode === 'board'} onClick={() => { setMode('board'); setBoardNotice(null) }}>看板</button>
              </div>
              {mode === 'board' ? <span className="ah-home-group-count">和列表同一份记录；拖动只发命令</span> : null}
            </div>
            {mode === 'board' ? (
              <WorkBoardView board={board} actionsOf={actionsOf} onAction={runBoardAction}
                onMove={runBoardMove} notice={boardNotice} busy={props.busyTaskId !== null} />
            ) : model.emptyText !== null ? (
              <p className="ah-home-empty">{model.emptyText}</p>
            ) : (
              <>
                <div className="ah-home-summary">
                  <span className="ah-home-stat"><strong>{model.summary.doing}</strong>在做</span>
                  <span className="ah-home-stat"><strong>{model.summary.blocked}</strong>受阻</span>
                  <span className="ah-home-stat"><strong>{model.summary.archived}</strong>已归档</span>
                </div>
                <p className="ah-home-summary-text">{model.summaryText}</p>

                <section className="ah-home-section" aria-label="在做">
                  <div className="ah-home-section-head">
                    <h3>在做</h3>
                    <span className="ah-home-group-count">{model.summary.doing} 件</span>
                  </div>
                  {model.doing.length === 0 ? (
                    <p className="ah-home-empty">暂无进行中任务。派发任务后在此显示。</p>
                  ) : model.doing.map(group => (
                    <ProjectGroup
                      key={group.projectId}
                      group={group}
                      collapsed={collapsed.includes(group.projectId)}
                      onToggle={() => toggleProject(group.projectId)}
                      busyTaskId={props.busyTaskId}
                      onOpen={props.onOpenSession}
                      onComplete={props.onComplete}
                    />
                  ))}
                </section>

                <section className="ah-home-section" aria-label="已归档">
                  <button
                    type="button"
                    className="ah-home-archived-toggle"
                    aria-expanded={archivedOpen}
                    onClick={() => setArchivedOpen(open => !open)}
                  >
                    <span>已归档 {model.summary.archived} 件</span>
                    <span>{archivedOpen ? '收起' : '展开'}</span>
                  </button>
                  {archivedOpen ? (
                    model.archived.length === 0
                      ? <p className="ah-home-empty">暂无已交付工作。交账后在此显示。</p>
                      : model.archived.map(group => (
                        <ArchivedGroup
                          key={group.projectId}
                          group={group}
                          busyTaskId={props.busyTaskId}
                          onOpen={props.onOpenSession}
                          onComplete={props.onComplete}
                        />
                      ))
                  ) : null}
                </section>
              </>
            )}
          </>
        )}
      </div>
    </section>
  )
}

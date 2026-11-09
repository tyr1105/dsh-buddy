/**
 * 四列工作看板（P35）：待领 / 在做 / 等你 / 已完成。
 *
 * 为什么单独成组件：项目页和队友主页都要画同一块看板，差异只在「看哪些任务」和
 * 「卡片能做什么」。数据由 logic/work-board-source 投影，列映射与移动合法性和 P29
 * 共用同一份规则；本组件只负责把卡片摆成四列、把点击与拖拽翻译成页面级动作。
 *
 * 纪律：拖拽不发命令也不改状态——只调用 P29 的 workBoardMove 判断方向是否合法，
 * 合法就把命令交给页面（页面再走 core），非法就在看板顶部说明原因。
 * 所有卡片同时提供按钮，键盘和读屏用户不依赖拖拽。
 */
import { useEffect, useState, type ReactNode } from 'react'
import type { TaskStatus } from '../../shared/views.js'
import {
  WORK_BOARD_COLUMNS, workBoardMove,
  type WorkBoard, type WorkBoardCard, type WorkBoardColumnId, type WorkBoardCommand,
} from '../logic/work-board.js'
import { BOARD_ACTION_LABEL, boardCardDraggable, type WorkBoardActionKind } from '../logic/work-board-source.js'

/** 一条卡片：项目名、标题、负责人（未指派写「待领」）、受阻标记与动作按钮。 */
function BoardCard(props: {
  card: WorkBoardCard
  actions: WorkBoardActionKind[]
  busy: boolean
  onAction: (kind: WorkBoardActionKind, card: WorkBoardCard) => void
  onDragStart: (card: WorkBoardCard) => void
}): ReactNode {
  const card = props.card
  // 负责人：没有指派就是待领；指派了但查不到名字说明队友已失效，给固定中文占位，id 只进 title。
  const owner = card.ownerBotId === null
    ? '待领'
    : card.ownerName ?? '队友已删除或退役'
  // U01 第 35 轮（WCAG 2.5.1）：能不能拖交给纯函数 boardCardDraggable——没有任何按钮
  // 等价动作的卡片一律不可拖（暂停/已完成项目里的待领、队友主页的待验收等），
  // 保证「能拖到的每个落点都有一个同名按钮走得通」，拖拽永不成为唯一死路。
  const draggable = boardCardDraggable({
    status: card.status,
    blocked: card.blocked,
    actions: props.actions,
    busy: props.busy,
  })
  return (
    <li
      className={`ah-board-card${card.blocked ? ' ah-board-card-blocked' : ''}`}
      draggable={draggable}
      onDragStart={event => {
        // 记录被拖的卡片 id；真正的移动在目标列 drop 时判断。
        event.dataTransfer.setData('text/plain', card.id)
        event.dataTransfer.effectAllowed = 'move'
        props.onDragStart(card)
      }}
    >
      <p className="ah-board-card-project" title={card.projectName}>{card.projectName}</p>
      <p className="ah-board-card-title">{card.title}</p>
      <p className="ah-board-card-meta">
        <span className={card.ownerBotId !== null && card.ownerName === null ? 'ah-org-issue-text' : ''}
          title={card.ownerBotId !== null && card.ownerName === null ? `内部 id：${card.ownerBotId}` : undefined}>
          {owner}
        </span>
        {card.blocked ? <span className="ah-board-card-blocked-tag">受阻</span> : null}
      </p>
      {props.actions.length > 0 ? (
        <div className="ah-board-card-ops">
          {props.actions.map(kind => (
            <button
              key={kind}
              type="button"
              className={`ah-btn${kind === 'accept' ? ' ah-btn-primary' : kind === 'reject' ? ' ah-btn-danger' : ' ah-btn-ghost'}`}
              disabled={props.busy}
              onClick={() => props.onAction(kind, card)}
            >
              {BOARD_ACTION_LABEL[kind]}
            </button>
          ))}
        </div>
      ) : null}
    </li>
  )
}

export function WorkBoardView(props: {
  board: WorkBoard
  /** 每张卡片当前能做的动作（页面按项目状态与页面范围算好）。 */
  actionsOf: (card: WorkBoardCard) => WorkBoardActionKind[]
  onAction: (kind: WorkBoardActionKind, card: WorkBoardCard) => void
  /** 合法移动：页面把命令发给 core；非法方向（含「在做拖回待领」）在看板内部拦成提示。 */
  onMove: (card: WorkBoardCard, command: WorkBoardCommand) => void
  /** 页面级提示（例如任务已被别人改动）；看板自己的非法拖拽提示显示在它下面。 */
  notice?: string | null
  busy?: boolean
}): ReactNode {
  const [dragging, setDragging] = useState<WorkBoardCard | null>(null)
  const [overColumn, setOverColumn] = useState<WorkBoardColumnId | null>(null)
  const [moveNotice, setMoveNotice] = useState<string | null>(null)

  // 非法拖拽的提示是瞬时反馈：4 秒后自动收起，避免一直占着看板顶部、
  // 也避免主人在改走按钮操作后还看到「不能这样拖」的旧提示。
  useEffect(() => {
    if (moveNotice === null) return
    const timer = setTimeout(() => { try { setMoveNotice(null) } catch { /* 提示消失失败不影响看板。 */ } }, 4000)
    return () => clearTimeout(timer)
  }, [moveNotice])

  /** 按钮操作前清掉拖拽提示：主人已经换了一条路，旧的「不能拖」不该再挂着。 */
  const handleAction = (kind: WorkBoardActionKind, card: WorkBoardCard): void => {
    setMoveNotice(null)
    props.onAction(kind, card)
  }

  /** 放到某一列：方向合法才把命令交给页面；不合法就地说明，不本地改状态。 */
  const drop = (column: WorkBoardColumnId): void => {
    const card = dragging
    setDragging(null)
    setOverColumn(null)
    if (card === null) return
    const result = workBoardMove(card.status as TaskStatus, column)
    if (!result.ok) {
      setMoveNotice(result.reason)
      return
    }
    setMoveNotice(null)
    props.onMove(card, result.command)
  }

  return (
    <div className="ah-board" aria-label="工作看板">
      {props.notice ? <p className="ah-board-notice" role="status">{props.notice}</p> : null}
      {moveNotice ? <p className="ah-board-notice" role="status">{moveNotice}</p> : null}
      <div className="ah-board-columns">
        {WORK_BOARD_COLUMNS.map(column => {
          const current = props.board.columns.find(item => item.id === column.id)
          const cards = current?.cards ?? []
          // 拖拽时实时告诉主人这一列能不能接：合法目标用主色描边，非法目标用红色虚线，
          // 松手前就知道会发生什么，不用靠猜。同列也是非法（没有命令可发）。
          const canDrop = dragging !== null && workBoardMove(dragging.status as TaskStatus, column.id).ok
          const overThis = overColumn === column.id
          const colClass = overThis
            ? canDrop ? ' ah-board-col-over' : ' ah-board-col-over-invalid'
            : ''
          return (
            <section
              key={column.id}
              className={`ah-board-col${colClass}`}
              aria-label={`${column.label}（${cards.length}）`}
              onDragOver={event => {
                // 必须阻止默认行为，drop 才会触发；非法目标也允许 drop，落列时再判并给提示。
                event.preventDefault()
                event.dataTransfer.dropEffect = canDrop ? 'move' : 'none'
                if (overColumn !== column.id) setOverColumn(column.id)
              }}
              onDragLeave={() => setOverColumn(prev => (prev === column.id ? null : prev))}
              onDrop={event => {
                event.preventDefault()
                drop(column.id)
              }}
            >
              <header className="ah-board-col-head">
                <h4>{column.label}</h4>
                <span className="ah-board-col-count">{cards.length}</span>
              </header>
              {cards.length === 0 ? (
                <p className="ah-board-col-empty">{column.emptyText}</p>
              ) : (
                <ul className="ah-board-col-cards">
                  {cards.map(card => (
                    <BoardCard
                      key={card.id}
                      card={card}
                      actions={props.actionsOf(card)}
                      busy={props.busy === true}
                      onAction={handleAction}
                      onDragStart={setDragging}
                    />
                  ))}
                </ul>
              )}
            </section>
          )
        })}
      </div>
    </div>
  )
}

/**
 * P35 看板数据源测试：项目页与队友主页的看板怎么从同一份 ProjectView 投影出来，
 * 以及每张卡片在不同项目状态下能发起哪些动作。
 *
 * 为什么单独测：看板最容易出的问题是「列表说 3 件、看板说 4 件」或「把别人的活
 * 算到这个队友头上」。这里用 shared/fixture-project 的真实样例逐条核对：
 * 项目看板 = 未归档项目的全部任务；队友看板 = 自己名下的任务 + 所在进行中项目里
 * 还没被领走的待领事项；动作表只给 core 真能执行的命令。
 */
import { describe, expect, it } from 'vitest'
import { fixtureProject } from '../src/shared/fixture-project.js'
import { buildWorkBoard, type WorkBoardColumnId } from '../src/client/logic/work-board.js'
import {
  BOARD_ACTION_LABEL, boardCardActions, boardCardDraggable, isOpenTaskStatus,
  projectBoardItems, teammateBoardItems,
  type WorkBoardActionKind,
} from '../src/client/logic/work-board-source.js'

describe('projectBoardItems：项目页看板覆盖未归档项目的全部任务', () => {
  it('10 条任务全部投影出来；归档项目的任务带 projectArchived，由 buildWorkBoard 过滤', () => {
    const items = projectBoardItems(fixtureProject)
    expect(items).toHaveLength(10)
    const old = items.find(item => item.projectId === 'prj_old')
    expect(old?.projectArchived).toBe(true)
    expect(buildWorkBoard(items).total).toBe(9)
  })
  it('四列分布与列表状态一致：待领 2 / 在做 3（含 1 条受阻）/ 等你 1 / 已完成 3', () => {
    const board = buildWorkBoard(projectBoardItems(fixtureProject))
    const counts = Object.fromEntries(board.columns.map(column => [column.id, column.cards.length]))
    expect(counts).toEqual({ open: 2, doing: 3, waiting: 1, done: 3 })
    const blocked = board.columns.find(column => column.id === 'doing')!.cards.filter(card => card.blocked)
    expect(blocked.map(card => card.id)).toEqual(['pt_weekly_3'])
  })
  it('卡片带项目名与负责人名字，未指派写 null（界面显示「待领」）', () => {
    const items = projectBoardItems(fixtureProject)
    const unassigned = items.find(item => item.id === 'pt_weekly_1')
    expect(unassigned?.ownerBotId).toBeNull()
    expect(unassigned?.ownerName).toBeNull()
    expect(unassigned?.projectName).toBe('竞品周报自动化')
    const assigned = items.find(item => item.id === 'pt_weekly_2')
    expect(assigned?.ownerName).toBe('探路')
  })
})

describe('teammateBoardItems：队友看板只放自己的活与可领的待领事项', () => {
  it('探路：自己名下 4 条 + 进行中项目里 1 条未指派待办 = 5 条，不含别人名下的任务', () => {
    const items = teammateBoardItems(fixtureProject, 'bot-tanlu')
    expect(items.map(item => item.id).sort()).toEqual([
      'pt_onboard_2', 'pt_weekly_1', 'pt_weekly_2', 'pt_weekly_5', 'pt_weekly_6',
    ])
    // 巡检员的受阻任务、失效队友的进行中任务都不应算到探路头上。
    expect(items.some(item => item.id === 'pt_weekly_3')).toBe(false)
    expect(items.some(item => item.id === 'pt_weekly_4')).toBe(false)
  })
  it('探路看板四列：待领 2（自己的待办 + 可领的未指派）/ 在做 1 / 等你 1 / 已完成 1', () => {
    const board = buildWorkBoard(teammateBoardItems(fixtureProject, 'bot-tanlu'))
    expect(board.columns.map(column => column.cards.length)).toEqual([2, 1, 1, 1])
    expect(board.columns[0]!.cards.map(card => card.id).sort()).toEqual(['pt_onboard_2', 'pt_weekly_1'])
  })
  it('巡检员：自己名下 2 条 + 可领 1 条；暂停项目里的待领事项不出现（core 只接受进行中项目）', () => {
    const items = teammateBoardItems(fixtureProject, 'bot-xunjian')
    expect(items.map(item => item.id).sort()).toEqual(['pt_migrate_1', 'pt_weekly_1', 'pt_weekly_3'])
    const board = buildWorkBoard(items)
    expect(board.columns.map(column => column.cards.length)).toEqual([1, 1, 0, 1])
  })
  it('归档项目里自己的活仍进队友看板（与主页已归档列表同一份记录），按任务真实状态落列', () => {
    const items = teammateBoardItems(fixtureProject, 'bot-zongguan')
    // 总管的入职清单已通过；归档项目里的旧任务不属于总管，不会误入。
    expect(items.map(item => item.id)).toContain('pt_onboard_1')
    expect(items.some(item => item.id === 'pt_old_1')).toBe(false)
  })
  it('isOpenTaskStatus 只认 todo/rejected；blocked 不是待领', () => {
    expect(isOpenTaskStatus('todo')).toBe(true)
    expect(isOpenTaskStatus('rejected')).toBe(true)
    expect(isOpenTaskStatus('blocked')).toBe(false)
    expect(isOpenTaskStatus('doing')).toBe(false)
  })
})

describe('boardCardActions：卡片动作只给 core 真能执行的命令', () => {
  it('待领：项目进行中才可领取；暂停/完成/归档都不给', () => {
    expect(boardCardActions('todo', 'active', 'project')).toEqual(['claim'])
    expect(boardCardActions('rejected', 'active', 'teammate')).toEqual(['claim'])
    expect(boardCardActions('todo', 'paused', 'project')).toEqual([])
    expect(boardCardActions('todo', 'done', 'project')).toEqual([])
    expect(boardCardActions('todo', 'archived', 'project')).toEqual([])
  })
  it('在做：都能交账；项目页多一个改派；受阻不给动作（要先恢复并派活）', () => {
    expect(boardCardActions('doing', 'active', 'project')).toEqual(['submit', 'reassign'])
    expect(boardCardActions('doing', 'active', 'teammate')).toEqual(['submit'])
    expect(boardCardActions('doing', 'paused', 'project')).toEqual(['submit', 'reassign'])
    expect(boardCardActions('blocked', 'active', 'project')).toEqual([])
    expect(boardCardActions('doing', 'archived', 'project')).toEqual([])
  })
  it('等你：项目页可验收通过 / 驳回；队友主页不给验收入口', () => {
    expect(boardCardActions('done_pending_check', 'active', 'project')).toEqual(['accept', 'reject'])
    expect(boardCardActions('done_pending_check', 'active', 'teammate')).toEqual([])
    expect(boardCardActions('done_pending_check', 'archived', 'project')).toEqual([])
  })
  it('已完成是终态：任何范围都不给动作；五种动作都有中文按钮文案', () => {
    expect(boardCardActions('accepted', 'active', 'project')).toEqual([])
    const kinds: WorkBoardActionKind[] = ['claim', 'submit', 'reassign', 'accept', 'reject']
    expect(kinds.map(kind => BOARD_ACTION_LABEL[kind])).toEqual(['领取', '交账', '改派', '验收通过', '驳回'])
  })
})

describe('boardCardDraggable：可拖 ⇔ 至少有一个按钮等价动作（U01 第 35 轮，WCAG 2.5.1）', () => {
  it('进行中项目的待领 / 在做 / 项目页待验收可拖；终态、受阻、忙碌不可拖', () => {
    expect(boardCardDraggable({ status: 'todo', blocked: false, actions: ['claim'], busy: false })).toBe(true)
    expect(boardCardDraggable({ status: 'doing', blocked: false, actions: ['submit', 'reassign'], busy: false })).toBe(true)
    expect(boardCardDraggable({ status: 'done_pending_check', blocked: false, actions: ['accept', 'reject'], busy: false })).toBe(true)
    expect(boardCardDraggable({ status: 'accepted', blocked: false, actions: [], busy: false })).toBe(false)
    expect(boardCardDraggable({ status: 'blocked', blocked: true, actions: [], busy: false })).toBe(false)
    expect(boardCardDraggable({ status: 'doing', blocked: false, actions: ['submit'], busy: true })).toBe(false)
  })
  it('没有按钮等价物就不可拖：已完成项目的待领卡、队友主页的待验收卡都堵住拖拽死路', () => {
    // 第 35 轮巡检抓到的真实缺陷：prj_onboard（done）里的待领卡原来仍可拖，
    // 拖到在做会向 core 发注定被拒收的 claim，且没有按钮可走。
    expect(boardCardDraggable({ status: 'todo', blocked: false, actions: boardCardActions('todo', 'done', 'project'), busy: false })).toBe(false)
    expect(boardCardDraggable({ status: 'todo', blocked: false, actions: boardCardActions('todo', 'paused', 'project'), busy: false })).toBe(false)
    // 队友主页不给验收按钮：等你列的卡不能靠拖拽走验收/驳回。
    expect(boardCardDraggable({
      status: 'done_pending_check', blocked: false,
      actions: boardCardActions('done_pending_check', 'active', 'teammate'), busy: false,
    })).toBe(false)
  })
  it('全夹具契约：两种看板范围下，每张可拖卡片都覆盖该列全部合法拖放命令', () => {
    // 列 → 该列拖得出去的合法命令（与 workBoardMove 的 ok 分支一一对应），
    // 这些命令必须都能在卡片按钮里找到同名动作。
    const required: Record<WorkBoardColumnId, WorkBoardActionKind[]> = {
      open: ['claim'],
      doing: ['submit'],
      waiting: ['accept', 'reject'],
      done: [],
    }
    const statusById = new Map(
      fixtureProject.projects.map(row => [row.project.id, row.project.status] as const),
    )
    for (const scope of ['project', 'teammate'] as const) {
      const items = scope === 'project'
        ? projectBoardItems(fixtureProject)
        : teammateBoardItems(fixtureProject, 'bot-tanlu')
      const board = buildWorkBoard(items)
      for (const column of board.columns) {
        for (const card of column.cards) {
          const projectStatus = statusById.get(card.projectId) ?? 'archived'
          const actions = boardCardActions(card.status, projectStatus, scope)
          const draggable = boardCardDraggable({ status: card.status, blocked: card.blocked, actions, busy: false })
          if (draggable) {
            for (const need of required[column.id]) expect(actions).toContain(need)
          }
        }
      }
    }
  })
})

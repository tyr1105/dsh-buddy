/**
 * 工作看板纯逻辑测试（P29）：状态映射、排序、可见性与跨列移动合法性。
 *
 * 为什么单测：看板一旦自己编状态，列表和看板会各说一套，主人就不知道该信哪边。
 * 这里把 DC17 的口径逐条钉死，并用正反例保证非法移动不会被界面放出去。
 */
import { describe, expect, it } from 'vitest'
import type { TaskStatus } from '../src/shared/views.js'
import {
  buildWorkBoard, isWorkBlocked, workBoardColumnOf, workBoardMove,
  type WorkBoardItemInput,
} from '../src/client/logic/work-board.js'

/** 造一条任务；默认是待领、无 owner。 */
function item(id: string, patch: Partial<WorkBoardItemInput> = {}): WorkBoardItemInput {
  return {
    id,
    title: id,
    projectId: 'prj-one',
    projectName: '进市场',
    status: 'todo',
    ownerBotId: null,
    ownerName: null,
    createdAt: 100,
    updatedAt: 100,
    ...patch,
  }
}

describe('workBoardColumnOf：五种真实状态与一个瞬时值', () => {
  it('正例：todo/rejected 待领，doing/blocked 在做，待验收等你，accepted 已完成', () => {
    expect(workBoardColumnOf('todo')).toBe('open')
    expect(workBoardColumnOf('rejected')).toBe('open')
    expect(workBoardColumnOf('doing')).toBe('doing')
    expect(workBoardColumnOf('blocked')).toBe('doing')
    expect(workBoardColumnOf('done_pending_check')).toBe('waiting')
    expect(workBoardColumnOf('accepted')).toBe('done')
  })

  it('反例：blocked 不会被单独算成第五列，也不会当成等你', () => {
    const statuses: TaskStatus[] = ['todo', 'doing', 'blocked', 'done_pending_check', 'accepted', 'rejected']
    for (const status of statuses) {
      expect(['open', 'doing', 'waiting', 'done']).toContain(workBoardColumnOf(status))
    }
    expect(workBoardColumnOf('blocked')).not.toBe('waiting')
  })

  it('受阻标记只在 blocked 为真', () => {
    expect(isWorkBlocked('blocked')).toBe(true)
    expect(isWorkBlocked('doing')).toBe(false)
    expect(isWorkBlocked('done_pending_check')).toBe(false)
  })
})

describe('buildWorkBoard：可见性', () => {
  it('归档项目与已删除任务不出现，其余四条各就各位', () => {
    const board = buildWorkBoard([
      item('open'),
      item('doing', { status: 'doing' }),
      item('waiting', { status: 'done_pending_check' }),
      item('done', { status: 'accepted' }),
      item('archived', { projectArchived: true }),
      item('deleted', { deleted: true }),
    ])
    expect(board.total).toBe(4)
    expect(board.columns.map(column => column.id)).toEqual(['open', 'doing', 'waiting', 'done'])
    expect(board.columns.map(column => column.cards.map(card => card.id))).toEqual([
      ['open'], ['doing'], ['waiting'], ['done'],
    ])
  })

  it('空看板仍保留四列与固定空列文案', () => {
    const board = buildWorkBoard([])
    expect(board.columns).toHaveLength(4)
    expect(board.columns.map(column => column.emptyText)).toEqual([
      '暂无待领任务。在项目中新建任务后在此显示。',
      '暂无进行中任务。领取待领任务后在此显示。',
      '暂无待确认事项。队友交账后在此显示。',
      '暂无已完成事项。验收通过后在此显示。',
    ])
  })

  it('owner 与受阻标记原样带到卡片上', () => {
    const board = buildWorkBoard([
      item('blocked', { status: 'blocked', ownerBotId: 'bot-a', ownerName: '阿蓝', ownerColor: '#123456' }),
    ])
    const card = board.columns[1]?.cards[0]
    expect(card?.ownerBotId).toBe('bot-a')
    expect(card?.ownerName).toBe('阿蓝')
    expect(card?.ownerColor).toBe('#123456')
    expect(card?.blocked).toBe(true)
  })
})

describe('buildWorkBoard：列内排序', () => {
  it('待领最早创建的在最上', () => {
    const board = buildWorkBoard([
      item('late', { createdAt: 300 }),
      item('early', { createdAt: 100 }),
      item('middle', { createdAt: 200 }),
    ])
    expect(board.columns[0]?.cards.map(card => card.id)).toEqual(['early', 'middle', 'late'])
  })

  it('在做里受阻置顶，其余按最近更新倒序', () => {
    const board = buildWorkBoard([
      item('normal-old', { status: 'doing', updatedAt: 100 }),
      item('blocked', { status: 'blocked', updatedAt: 50 }),
      item('normal-new', { status: 'doing', updatedAt: 300 }),
    ])
    expect(board.columns[1]?.cards.map(card => card.id)).toEqual(['blocked', 'normal-new', 'normal-old'])
  })

  it('等你里拖得最久的在上，已完成里最近完成的在上', () => {
    const board = buildWorkBoard([
      item('wait-long', { status: 'done_pending_check', updatedAt: 100 }),
      item('wait-short', { status: 'done_pending_check', updatedAt: 300 }),
      item('done-old', { status: 'accepted', updatedAt: 100 }),
      item('done-new', { status: 'accepted', updatedAt: 300 }),
    ])
    expect(board.columns[2]?.cards.map(card => card.id)).toEqual(['wait-long', 'wait-short'])
    expect(board.columns[3]?.cards.map(card => card.id)).toEqual(['done-new', 'done-old'])
  })

  it('时间戳相同按 id 稳定排序', () => {
    const board = buildWorkBoard([item('b'), item('a')])
    expect(board.columns[0]?.cards.map(card => card.id)).toEqual(['a', 'b'])
  })
})

describe('workBoardMove：只发合法命令', () => {
  it('正例：四条主链路都给出命令', () => {
    expect(workBoardMove('todo', 'doing')).toEqual({ ok: true, command: 'claim' })
    expect(workBoardMove('doing', 'waiting')).toEqual({ ok: true, command: 'submit' })
    expect(workBoardMove('done_pending_check', 'done')).toEqual({ ok: true, command: 'accept' })
    expect(workBoardMove('done_pending_check', 'doing')).toEqual({ ok: true, command: 'reject' })
  })

  it('反例（U01 r35 / WCAG 2.5.1）：在做拖回待领判非法，不产出无按钮等价物的 release 命令', () => {
    const result = workBoardMove('doing', 'open')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      // 原因必须给出真实可走的替代路径，不能只说「不行」。
      expect(result.reason).toContain('不能直接退回待领')
      expect(result.reason).toMatch(/改派|交账/)
    }
    // 受阻条目同样不能借这个方向绕开受阻限制。
    expect(workBoardMove('blocked', 'open').ok).toBe(false)
  })

  it('反例：受阻的条目不能直接交活', () => {
    const result = workBoardMove('blocked', 'waiting')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('受阻')
  })

  it('反例：待领不能直接完成，已完成不能拖回去', () => {
    expect(workBoardMove('todo', 'done').ok).toBe(false)
    expect(workBoardMove('accepted', 'doing').ok).toBe(false)
    expect(workBoardMove('accepted', 'waiting').ok).toBe(false)
  })

  it('同列移动不产生命令', () => {
    expect(workBoardMove('doing', 'doing').ok).toBe(false)
    expect(workBoardMove('todo', 'open').ok).toBe(false)
  })
})

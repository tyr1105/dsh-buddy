/**
 * 收件箱分组排序 / 活动流筛选 / 入口 label 计数 / 新到提示的纯逻辑测试（任务卡「测试」一节）。
 */
import { describe, expect, it } from 'vitest'
import { ACTIVITY_KIND_LABELS, entryLabel, filterActivity, groupInbox, newUrgentInbox } from '../src/client/logic/feeds.js'
import type { ActivityRow, InboxItemView } from '../src/shared/views.js'

function inboxItem(overrides: Partial<InboxItemView>): InboxItemView {
  return {
    id: 'i1', botId: 'b1', botName: '甲', botColor: null, type: 'question', typeLabel: '提问',
    priority: 'P1', approvalId: null, title: 't', body: 'b', options: ['是', '否'], defaultOption: '是',
    createdAt: 1000, createdText: '刚刚', expiresText: null, ...overrides,
  }
}

describe('收件箱分组与排序', () => {
  const items = [
    inboxItem({ id: 'p2-old', priority: 'P2', createdAt: 100 }),
    inboxItem({ id: 'p1-new', priority: 'P1', createdAt: 300 }),
    inboxItem({ id: 'p0', priority: 'P0', createdAt: 150 }),
    inboxItem({ id: 'p1-old', priority: 'P1', createdAt: 200 }),
  ]
  it('按 P0 → P1 → P2 分组，空组不出现', () => {
    expect(groupInbox(items).map(g => g.priority)).toEqual(['P0', 'P1', 'P2'])
  })
  it('组内按创建时间新→旧', () => {
    const p1 = groupInbox(items).find(g => g.priority === 'P1')!
    expect(p1.items.map(i => i.id)).toEqual(['p1-new', 'p1-old'])
  })
  it('空收件箱返回空数组', () => {
    expect(groupInbox([])).toEqual([])
  })
})

describe('活动流筛选', () => {
  const rows: ActivityRow[] = [
    { id: '1', at: 3, timeText: '', botId: 'b1', botName: '甲', botColor: null, kind: 'wake', text: '' },
    { id: '2', at: 2, timeText: '', botId: 'b2', botName: '乙', botColor: null, kind: 'commit', text: '' },
    { id: '3', at: 1, timeText: '', botId: null, botName: null, botColor: null, kind: 'system', text: '' },
  ]
  it('按队友筛选', () => {
    expect(filterActivity(rows, { botId: 'b1' }).map(r => r.id)).toEqual(['1'])
  })
  it('按类型筛选；中心条（botId 为空）在按队友筛选时不出现', () => {
    expect(filterActivity(rows, { kind: 'commit' }).map(r => r.id)).toEqual(['2'])
    expect(filterActivity(rows, { botId: 'b1', kind: 'system' })).toEqual([])
  })
  it('不筛时全量返回', () => {
    expect(filterActivity(rows, {})).toHaveLength(3)
  })
  it('全部类型都有中文名（界面不出英文状态码）', () => {
    for (const label of Object.values(ACTIVITY_KIND_LABELS)) expect(label).toMatch(/[\u4e00-\u9fff]/)
  })
})

describe('入口 label 计数', () => {
  it('无待处理显示「队友」', () => expect(entryLabel(0)).toBe('队友'))
  it('有待处理显示「队友 · N」', () => {
    expect(entryLabel(3)).toBe('队友 · 3')
    expect(entryLabel(120)).toBe('队友 · 99+')
  })
})

describe('新到 P0/P1 收件箱判定（应用内提示只报这两级）', () => {
  const before = [inboxItem({ id: 'a', priority: 'P1', createdAt: 1 })]
  it('新 P0/P1 项触发提示；P2 不提示；已有项不重复提示', () => {
    const after = [
      inboxItem({ id: 'a', priority: 'P1', createdAt: 1 }),
      inboxItem({ id: 'b', priority: 'P0', createdAt: 2 }),
      inboxItem({ id: 'c', priority: 'P2', createdAt: 3 }),
    ]
    expect(newUrgentInbox(before, after).map(i => i.id)).toEqual(['b'])
  })
  it('prevItems 为空数组时（之前确实没有待办）新 P0/P1 会被报出', () => {
    expect(newUrgentInbox([], [inboxItem({ id: 'x', priority: 'P0' })]).map(i => i.id)).toEqual(['x'])
  })
})

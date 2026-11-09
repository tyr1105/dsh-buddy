/**
 * 收件箱平铺排序 / 活动流筛选 / 新到提示的纯逻辑测试（任务卡「测试」一节）。
 */
import { describe, expect, it } from 'vitest'
import { ACTIVITY_KIND_LABELS, activityLine, filterActivity, focusInboxTarget, newUrgentInbox, sortInbox } from '../src/client/logic/feeds.js'
import type { ActivityRow, InboxItemView } from '../src/shared/views.js'

function inboxItem(overrides: Partial<InboxItemView>): InboxItemView {
  return {
    id: 'i1', botId: 'b1', botName: '甲', botColor: null, type: 'question', typeLabel: '提问',
    priority: 'P1', approvalId: null, title: 't', body: 'b', options: ['是', '否'], defaultOption: '是',
    createdAt: 1000, createdText: '刚刚', expiresText: null, ...overrides,
  }
}

describe('收件箱平铺排序', () => {
  const items = [
    inboxItem({ id: 'p2-old', priority: 'P2', createdAt: 100 }),
    inboxItem({ id: 'p1-new', priority: 'P1', createdAt: 300 }),
    inboxItem({ id: 'p0', priority: 'P0', createdAt: 150 }),
    inboxItem({ id: 'p1-old', priority: 'P1', createdAt: 200 }),
  ]
  it('一列平铺，按优先级 P0 → P1 → P2；同级按创建时间新→旧', () => {
    expect(sortInbox(items).map(i => i.id)).toEqual(['p0', 'p1-new', 'p1-old', 'p2-old'])
  })
  it('不改调用方数组，空收件箱返回空数组', () => {
    const before = items.map(i => i.id)
    sortInbox(items)
    expect(items.map(i => i.id)).toEqual(before)
    expect(sortInbox([])).toEqual([])
  })
  it('同一优先级同一毫秒按 id 稳定排序', () => {
    const tied = [
      inboxItem({ id: 'b', priority: 'P1', createdAt: 1 }),
      inboxItem({ id: 'a', priority: 'P1', createdAt: 1 }),
    ]
    expect(sortInbox(tied).map(i => i.id)).toEqual(['a', 'b'])
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

describe('活动流正文去重', () => {
  it('去掉与类型标签重复的开头，避免「唤醒：唤醒：……」', () => {
    expect(activityLine('wake', '唤醒：变化——依赖服务超时')).toBe('变化——依赖服务超时')
    expect(activityLine('wake', '唤醒：到自查时刻')).toBe('到自查时刻')
    expect(activityLine('commit', '交账：已交账，等你验收')).toBe('已交账，等你验收')
  })
  it('只是恰好以同字开头时不误删', () => {
    expect(activityLine('wake', '唤醒记录：没有新变化')).toBe('唤醒记录：没有新变化')
    expect(activityLine('commit', '交账结果有进展')).toBe('交账结果有进展')
  })
  it('没有前缀的正文原样返回', () => {
    expect(activityLine('wake', '被叫醒：变化——依赖服务超时')).toBe('被叫醒：变化——依赖服务超时')
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

describe('从办公室门口聚焦收件箱卡（F04）', () => {
  const items = [inboxItem({ id: 'a', type: 'approval' }), inboxItem({ id: 'q', type: 'question' })]
  it('目标在当前筛选里 → 保持筛选并返回目标', () => {
    expect(focusInboxTarget(items, 'a', 'approval')).toEqual({ id: 'a', filter: 'approval' })
    expect(focusInboxTarget(items, 'q', 'all')).toEqual({ id: 'q', filter: 'all' })
  })
  it('当前筛选会挡住目标 → 先切回「全部」，避免主人以为卡丢了', () => {
    expect(focusInboxTarget(items, 'q', 'approval')).toEqual({ id: 'q', filter: 'all' })
  })
  it('目标已不存在或没有指定目标 → 不聚焦', () => {
    expect(focusInboxTarget(items, 'gone', 'all')).toBeNull()
    expect(focusInboxTarget(items, null, 'all')).toBeNull()
  })
})

/**
 * P75k：活动流的「技能库」记录与类型筛选（任务卡第 7 节，第 12 节第 5 条）。
 * 样例行在 shared/fixture-activity-skill.ts（P75r7 C1 起由核心生成后冻结：每周整理、七条技能更新、一条回退）。
 * 覆盖：kind 为 skill 的行显示 text，有 lines 时逐行缩进显示；不再加「{名字}：」前缀（core 的句子自己带员工名字）；
 * 「类型」下拉有「技能库」；选了立即筛选，只剩技能库记录；这是筛选不是提交（没有任何命令）；
 * 白名单之外的行种类仍然不画。
 */
import { describe, expect, it, vi } from 'vitest'
import { ActivityPane, RowView } from '../src/client/components/ActivityPane.js'
import { ACTIVITY_KIND_LABELS, DRAWABLE_ACTIVITY_KINDS, filterActivity, isDrawableActivity } from '../src/client/logic/feeds.js'
import { fixtureActivity, fixtureOverview } from '../src/shared/fixtures.js'
import { fixtureSkillActivityRows } from '../src/shared/fixture-activity-skill.js'
import type { ActivityRow, ActivityView } from '../src/shared/views.js'
import { createHookHost } from './helpers/hook-host.js'
import { findElements, type StubElement } from './helpers/jsx-runtime-stub.js'

vi.mock('react', async () => (await import('./helpers/hook-host.js')).reactFacade)

function textOf(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object' && node !== null && 'props' in node) return textOf((node as StubElement).props.children)
  return ''
}

const skillRows = fixtureSkillActivityRows(Date.parse('2026-11-19T10:00:00+08:00'))
const activity: ActivityView = { rows: [...fixtureActivity.rows, ...skillRows], hasMore: false }
const tidyRow = skillRows.find(row => row.lines !== undefined)!

describe('技能库记录的一行', () => {
  it('显示类型小标「技能库」与 core 生成的句子，整理一行带细项逐行缩进显示；不再加员工名字前缀', () => {
    const tree = createHookHost().render(RowView, { row: tidyRow as never })
    const text = textOf(tree)
    expect(text).toContain('技能库')
    expect(text).toContain(tidyRow.text)
    // 句子自己已经带员工名字，界面不再拼「探路：」。
    expect(text).not.toContain('探路：')
    const lines = findElements(tree, 'li').filter(row => row.props.className === undefined)
    expect(lines.map(row => textOf(row))).toEqual(tidyRow.lines)
    expect(findElements(tree, 'ul').some(list => list.props.className === 'ah-activity-lines')).toBe(true)
  })

  it('没有 lines 的技能库行只有一句话，没有细项列表', () => {
    const single = skillRows.find(row => row.lines === undefined)!
    const tree = createHookHost().render(RowView, { row: single as never })
    expect(textOf(tree)).toContain(single.text)
    expect(findElements(tree, 'ul')).toHaveLength(0)
  })

  it('其他种类的行写法不变：类型小标、员工名字、去掉与小标重复的开头', () => {
    const wake = fixtureActivity.rows.find(row => row.kind === 'wake')!
    const text = textOf(createHookHost().render(RowView, { row: wake as never }))
    expect(text).toContain('唤醒')
    expect(text).toContain('探路：')
  })
})

describe('类型筛选', () => {
  const bots = fixtureOverview.bots
  const render = (host = createHookHost()) => ({ host, view: (): unknown => host.render(ActivityPane, { activity, bots, error: null, onRetry: () => undefined, onLoadMore: () => undefined }) })

  it('「类型」下拉里有「技能库」，白名单与小标表都加了 skill', () => {
    expect(DRAWABLE_ACTIVITY_KINDS).toContain('skill')
    expect(ACTIVITY_KIND_LABELS.skill).toBe('技能库')
    const { view } = render()
    const kindSelect = findElements(view(), 'select')[1]!
    const options = findElements(kindSelect, 'option').map(option => textOf(option))
    expect(options).toContain('技能库')
  })

  it('活动流「技能库」样例共九行（核心生成的整理、更新与回退）', () => {
    expect(skillRows).toHaveLength(9)
    expect(skillRows.filter(row => row.lines !== undefined)).toHaveLength(1)
  })

  it('P75r7 复核：样例员工与总览里的「探路」一致，按探路筛选仍有九行', () => {
    // 员工筛选只列总览里的员工（fixtureOverview.bots）；样例编号不一致时选「探路」会把这几行全筛掉。
    expect(fixtureOverview.bots.some(bot => bot.id === 'bot-tanlu' && bot.name === '探路')).toBe(true)
    expect(skillRows.every(row => row.botId === 'bot-tanlu' && row.botName === '探路')).toBe(true)
    // 按「探路」筛选时，九行技能库记录一条不丢（基础样例里探路自己的行也照常在）。
    expect(filterActivity(activity.rows, { botId: 'bot-tanlu' }).filter(row => row.kind === 'skill')).toHaveLength(skillRows.length)
  })

  it('选「技能库」立即筛选，只剩技能库记录；改回「全部」恢复；筛选不发任何命令', () => {
    const { view } = render()
    expect(findElements(view(), RowView)).toHaveLength(activity.rows.length)
    ;(findElements(view(), 'select')[1]!.props.onChange as (event: unknown) => void)({ target: { value: 'skill' } })
    const rows = findElements(view(), RowView)
    expect(rows).toHaveLength(skillRows.length)
    expect(rows.every(row => (row.props.row as ActivityRow).kind === 'skill')).toBe(true)
    ;(findElements(view(), 'select')[1]!.props.onChange as (event: unknown) => void)({ target: { value: '' } })
    expect(findElements(view(), RowView)).toHaveLength(activity.rows.length)
  })

  it('与员工筛选并列：选了员工再选技能库，两个条件同时生效；没有结果时说清是筛没了', () => {
    const { view } = render()
    ;(findElements(view(), 'select')[1]!.props.onChange as (event: unknown) => void)({ target: { value: 'skill' } })
    ;(findElements(view(), 'select')[0]!.props.onChange as (event: unknown) => void)({ target: { value: 'bot-xunjian' } })
    expect(findElements(view(), RowView)).toHaveLength(0)
    expect(JSON.stringify(view())).toContain('暂无此类动态。切换筛选或点击「刷新」。')
  })

  it('filterActivity：按 skill 只留技能库记录；白名单之外的种类不画也不抛错', () => {
    expect(filterActivity(activity.rows, { kind: 'skill' })).toHaveLength(skillRows.length)
    const unknown = { ...skillRows[0]!, id: 'ac-future', kind: 'future_kind' } as unknown as ActivityRow
    expect(isDrawableActivity(unknown)).toBe(false)
    expect(filterActivity([unknown, ...skillRows], {})).toHaveLength(skillRows.length)
  })
})

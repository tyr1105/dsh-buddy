/**
 * P76k 设置页（界面）：两区五项、删掉的五项不再出现、给你自己留出三档、
 * 员工自己发起的工作 1 到 10、最近 7 天的用量表只读、旧宿主没有表时不显示。
 *
 * 为什么要逐条断言被删掉的标签：任务卡要求「逐个断言文字不出现」——只断言新文字在，
 * 旧项可能还挂在页面上而看不出来。
 */
import { describe, expect, it, vi } from 'vitest'
import { resolveSettings, WeeklyUsageViewSchema } from '@agent-hub/core'
import { NotifySection, Row, StatusSection, UsageSection, WeeklyUsageTable } from '../src/client/components/settings-sections.js'
import { draftFromSettings, validateSettingsDraft } from '../src/client/logic/settings.js'
import type { SettingsView } from '../src/shared/views.js'
import { fixtureWeeklyUsage } from '../src/shared/fixture-budget.js'
import { createHookHost } from './helpers/hook-host.js'
import { findElements, type StubElement } from './helpers/jsx-runtime-stub.js'

vi.mock('react', async () => (await import('./helpers/hook-host.js')).reactFacade)

function textOf(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object' && node !== null && 'props' in node) return textOf((node as StubElement).props.children)
  return ''
}
/**
 * 测试环境不执行子组件（Row 的输出不会出现），所以遇到 Row 时把它的标题与说明接上，
 * 其余按元素树继续。这样断言的是主人真正能看到的文字。
 */
function rowTextOf(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(rowTextOf).join('')
  if (typeof node === 'object' && node !== null && 'props' in node) {
    const element = node as StubElement
    if (element.type === Row) {
      return `${String(element.props.label ?? '')}${rowTextOf(element.props.hint)}${rowTextOf(element.props.children)}`
    }
    return rowTextOf(element.props.children)
  }
  return ''
}
const classOf = (node: StubElement): string => String(node.props.className ?? '')
const inputs = (tree: unknown): StubElement[] => findElements(tree, 'input')

/** 真实的设置对象（core 的默认值），只补界面要用到的选项表。 */
const settings = resolveSettings({})
const settingsView: SettingsView = {
  settings,
  pushChannelOptions: ['macos', 'dsh', 'none'],
  modelOptions: [{ value: null, label: '跟随 DSH 默认' }],
  presetSkillOptions: [],
  dshSkillOptions: [],
}
const draft = draftFromSettings(settings)

/** 渲染一遍两个设置分区，返回整页文字（不包括知识库与资料）。每个分区各用一次独立挂载。 */
function renderSections(overrides: Partial<typeof draft> = {}) {
  const current = { ...draft, ...overrides }
  const notify = createHookHost().render(NotifySection, { draft: current, set: () => {}, settings: settingsView })
  const usage = createHookHost().render(UsageSection, {
    draft: current, set: () => {}, settings: settingsView,
    weeklyUsage: fixtureWeeklyUsage(), weeklyUsageError: null, onRetryWeeklyUsage: () => {},
  })
  return { notify, usage, text: `${rowTextOf(notify)}${rowTextOf(usage)}` }
}

describe('P76k 设置页：五项都在、五项被删的都不在', () => {
  it('五项逐条出现', () => {
    const { text } = renderSections()
    for (const label of ['免打扰时段', '通知方式', '默认模型', '给你自己留出', '员工自己发起的工作']) expect(text).toContain(label)
  })

  it('被删的五项一个都不出现', () => {
    const { text } = renderSections()
    for (const gone of ['日报时间', '全队每天最多通知', '每位员工每天最多通知', '每位员工每天最多用', '自主节奏在每位员工的「编辑员工」里单独设置']) {
      expect(text).not.toContain(gone)
    }
  })

  it('运行状态区不再有「今天还能通知」一行', () => {
    const host = createHookHost()
    const overview = {
      bots: [], inbox: { total: 0, approvals: 0, questions: 0, proposals: 0, alerts: 0 },
      team: { unread: 0, lastMessageText: null },
      quota: { light: 'green' as const, lightLabel: '额度充足', usedText: '0 / 40 回合', resetText: null },
      health: { ok: true, heartbeatText: '刚刚', downtimeText: null, openAlerts: 0, sandboxWarning: null },
      nowText: '10:00', quietNow: false, pushesLeftToday: 3,
    }
    const tree = host.render(StatusSection, { overview, rootDir: '~/AgentHub', onPauseAll: async () => null, onResumeAll: async () => null })
    expect(textOf(tree)).not.toContain('今天还能通知')
  })

  it('说明文字与分区一句话逐字', () => {
    const { text } = renderSections()
    expect(text).toContain('这段时间产生的通知，到点后再发。')
    expect(text).toContain('只有四类事会通知你：要你确认的约定改动；花钱、对外发布、不可撤销的动作；三轮核对不过或做不下去；长时间没有进展。')
    expect(text).toContain('新员工默认使用，已有员工不受影响。')
    expect(text).toContain('每个 5 小时额度窗口里，员工不碰这一部分。')
    expect(text).toContain('只管员工没人交代、自己开工的回合。你交代的事按约定里的预计消耗计，复盘与整理另有上限，都不受这一项限制。')
    expect(text).toContain('每位每天最多')
    expect(text).toContain('回合')
  })
})

describe('P76k 给你自己留出：三档写回与自定义值', () => {
  it('三档是 0.9、0.7、0.5，只有三成带「默认」', () => {
    const { usage } = renderSections()
    const radios = inputs(usage).filter(node => node.props.type === 'radio')
    expect(radios.map(node => String(node.props.value))).toEqual(['0.9', '0.7', '0.5'])
    expect(radios.map(node => node.props.checked)).toEqual([false, true, false])
    const text = rowTextOf(usage)
    expect(text).toContain('一成')
    expect(text).toContain('三成')
    expect(text).toContain('五成')
    expect(findElements(usage, 'span').filter(node => classOf(node) === 'ah-set-default-tag')).toHaveLength(1)
  })

  it('点某一档，上报的是那一档的份额（保存时写回 0.9、0.7、0.5）', () => {
    const host = createHookHost()
    const seen: string[] = []
    const tree = host.render(UsageSection, {
      draft, set: partial => { if (partial.botQuotaShare !== undefined) seen.push(String(partial.botQuotaShare)) },
      settings: settingsView, weeklyUsage: fixtureWeeklyUsage(), weeklyUsageError: null, onRetryWeeklyUsage: () => {},
    })
    const radios = inputs(tree).filter(node => node.props.type === 'radio')
    for (const radio of radios) (radio.props.onChange as () => void)()
    expect(seen).toEqual(['0.9', '0.7', '0.5'])
  })

  it('自定义值原样显示成一个额外选项，点它不改这个值', () => {
    const host = createHookHost()
    const seen: string[] = []
    const tree = host.render(UsageSection, {
      draft: { ...draft, botQuotaShare: '0.8' }, set: partial => { if (partial.botQuotaShare !== undefined) seen.push(String(partial.botQuotaShare)) },
      settings: settingsView, weeklyUsage: fixtureWeeklyUsage(), weeklyUsageError: null, onRetryWeeklyUsage: () => {},
    })
    const text = rowTextOf(tree)
    // 份额 0.8 → 给你自己留出 20%。
    expect(text).toContain('20%（自定义）')
    const radios = inputs(tree).filter(node => node.props.type === 'radio')
    expect(radios).toHaveLength(4)
    expect(radios[3]!.props.checked).toBe(true)
    ;(radios[3]!.props.onChange as () => void)()
    expect(seen).toEqual(['0.8'])
  })

  it('1 到 10 的校验文字逐字', () => {
    expect(validateSettingsDraft({ ...draft, botDailyTurnBudget: '0' })).toBe('员工自己发起的工作：请填写 1 到 10 的整数。')
    expect(validateSettingsDraft({ ...draft, botDailyTurnBudget: '11' })).toBe('员工自己发起的工作：请填写 1 到 10 的整数。')
    expect(validateSettingsDraft({ ...draft, botDailyTurnBudget: '3' })).toBeNull()
  })
})

describe('P76k 最近 7 天的用量表', () => {
  it('表头与固定三行来自 core 的视图（只读表）', () => {
    const host = createHookHost()
    const tree = host.render(WeeklyUsageTable, { usage: fixtureWeeklyUsage(), error: null, onRetry: () => {} })
    const text = textOf(tree)
    for (const cell of ['事', '回合', '预计', 'token', '员工自己发起', '复盘、学习与整理', '你发起的对话']) expect(text).toContain(cell)
    expect(findElements(tree, 'table')).toHaveLength(1)
    expect(findElements(tree, 'input')).toHaveLength(0)
    // 样例由 core 的视图函数生成：形状必须过 core 的 schema。
    expect(() => WeeklyUsageViewSchema.parse(fixtureWeeklyUsage())).not.toThrow()
  })

  it('旧宿主没有这个接口（既没有数据也没有错误）时不显示这一块', () => {
    const host = createHookHost()
    expect(host.render(WeeklyUsageTable, { usage: null, error: null, onRetry: () => {} })).toBeNull()
  })

  it('读不出来时给原因与重试，不端走整页', () => {
    const host = createHookHost()
    const tree = host.render(WeeklyUsageTable, { usage: null, error: '连接中断', onRetry: () => {} })
    const text = textOf(tree)
    expect(text).toContain('用量读不出来')
    expect(text).toContain('重试')
    expect(findElements(tree, 'table')).toHaveLength(0)
  })
})

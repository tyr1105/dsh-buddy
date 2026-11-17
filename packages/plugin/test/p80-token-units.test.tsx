/**
 * P80：token 数量自动换算单位（界面一侧）。
 * 1 界面里的那一份换算函数与核心的权威实现逐条同输出（任务卡第 1 节的例子表加一批随机数）。
 * 2 悬停文字：`{带千位分隔符的完整数字} token`。
 * 3 清单里每一处：设置页「模型额度」一行（截图原文）、顶栏额度、右侧栏「模型与额度」、每日用量表、组队卡页脚。
 * 4 反例：回合数（6 / 40 回合）没有被换算；读不到用量时不编数字、不加悬停。
 */
import { describe, expect, it, vi } from 'vitest'
import { formatTokenCount as coreFormatTokenCount } from '@agent-hub/core'
import { CostMeter } from '../src/client/components/cost-meter.js'
import { RightPanel } from '../src/client/components/RightPanel.js'
import { StatusSection } from '../src/client/components/settings-sections.js'
import { TeamCard } from '../src/client/components/TeamCard.js'
import { TopBar } from '../src/client/components/TopBar.js'
import { fixtureBots, fixtureOverview } from '../src/shared/fixtures.js'
import { sampleQuotaWindow } from '../src/shared/fixture-budget.js'
import { sampleInitialProposal, sampleViewOfProposal } from '../src/shared/fixture-team.js'
import { formatTokenCount, formatTokenTitle } from '../src/shared/token-format.js'
import type { CostView, OverviewView } from '../src/shared/views.js'
import { createHookHost } from './helpers/hook-host.js'
import { findElements, type StubElement } from './helpers/jsx-runtime-stub.js'

vi.mock('react', async () => (await import('./helpers/hook-host.js')).reactFacade)
// 右侧栏抽屉要读真实样式和 document，测试里换成不碰浏览器的替身（同 teammate-right-panel.test.tsx）。
vi.mock('../src/client/components/use-drawer-focus.js', () => ({
  useDrawerFocus: () => ({ panelRef: { current: null } }),
  isDrawerMode: () => false,
}))

// ---------- 小工具 ----------

function textOf(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object' && node !== null && 'props' in node) return textOf((node as StubElement).props.children)
  return ''
}

/** 任务卡第 1 节的例子表（输入，期望输出）。 */
const TABLE: ReadonlyArray<readonly [number, string]> = [
  [0, '0'], [999, '999'], [1000, '1K'], [1500, '1.5K'], [59970, '60K'], [123456, '123K'], [999499, '999K'],
  [999500, '1M'], [1065566, '1.07M'], [1281646, '1.28M'], [1636469, '1.64M'], [12345678, '12.3M'],
  [2500000000, '2.5B'], [1000000000000, '1T'], [1234567890123456, '1235T'], [-5, '0'], [Number.NaN, '0'],
]

/** 一份总览：额度一句取截图里的样子（核心拼好的整句，界面原样显示）。 */
function overviewWith(usedText: string, resetText: string | null): OverviewView {
  return { ...fixtureOverview, quota: { light: 'green', lightLabel: '充足', usedText, resetText } }
}

// ---------- 1 两份实现同输出 ----------

describe('P80 界面里的换算函数与核心的权威实现输出相同', () => {
  it.each(TABLE)('例子表：%s 写成 %s（两份都是）', (input, expected) => {
    expect(formatTokenCount(input)).toBe(expected)
    expect(coreFormatTokenCount(input)).toBe(expected)
  })

  it('一批覆盖各个数量级的数：两份逐个相同', () => {
    // 用固定的线性同余序列造数，保证每次运行一样（测试里不使用随机数）。
    let seed = 20261113
    const next = (): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed }
    const samples: number[] = [9995, 99950, 999500, 999_500_000, 999_500_000_000, 0.4, 0.5, 999.5, Number.POSITIVE_INFINITY]
    for (let i = 0; i < 3000; i += 1) samples.push(Math.floor((next() / 2147483648) * 10 ** (next() % 16)))
    for (const n of samples) expect(formatTokenCount(n), String(n)).toBe(coreFormatTokenCount(n))
  })
})

// ---------- 2 悬停文字 ----------

describe('P80 悬停文字：完整数字加 token', () => {
  it('逐字：1636469 写成「1,636,469 token」', () => {
    expect(formatTokenTitle(1636469)).toBe('1,636,469 token')
    expect(formatTokenTitle(856)).toBe('856 token')
    expect(formatTokenTitle(1_234_567_890_123)).toBe('1,234,567,890,123 token')
  })
  it('反例：不是有限数、小于 0 的按 0；小数取整', () => {
    expect(formatTokenTitle(Number.NaN)).toBe('0 token')
    expect(formatTokenTitle(-3)).toBe('0 token')
    expect(formatTokenTitle(1999.6)).toBe('2,000 token')
  })
})

// ---------- 3 清单里每一处 ----------

describe('P80 设置页「模型额度」一行', () => {
  const rowOf = (overview: OverviewView): StubElement => {
    const tree = createHookHost().render(StatusSection, { overview, rootDir: '/hub', onPauseAll: async () => null, onResumeAll: async () => null })
    return findElements(tree, 'div').find(node => findElements(node, 'dt').some(dt => textOf(dt) === '模型额度'))!
  }

  it('截图那一行逐字：额度充足，6 / 40 回合，1.64M token，今天 16:44', () => {
    // 核心拼的额度一句：回合数原样，token 换算（核心一侧另有测试断言这句本身）。
    const usedText = `6 / 40 回合，${coreFormatTokenCount(1636469)} token`
    const dd = findElements(rowOf(overviewWith(usedText, '今天 16:44')), 'dd')[0]!
    expect(textOf(dd)).toBe('额度充足，6 / 40 回合，1.64M token，今天 16:44')
  })

  it('反例：回合数没有被换算，也没有出现完整的长数字', () => {
    const dd = findElements(rowOf(overviewWith('6 / 40 回合，1.64M token', '今天 16:44')), 'dd')[0]!
    expect(textOf(dd)).toContain('6 / 40 回合')
    expect(textOf(dd)).not.toContain('1636469')
  })

  it('样例总览里的额度一句也是换算后的写法', () => {
    expect(fixtureOverview.quota.usedText).toBe('6 / 40 回合，121K token')
  })
})

describe('P80 顶栏的额度文字', () => {
  it('显示核心整句里换算后的写法，回合数不变', () => {
    const tree = createHookHost().render(TopBar, { overview: overviewWith('6 / 40 回合，1.64M token', '今天 16:44') })
    const text = textOf(tree)
    expect(text).toContain('额度充足 · 6 / 40 回合，1.64M token')
    expect(text).not.toContain('1636469')
  })

  it('有额度窗口时，顶栏与右栏用同一份回合文字和灯色', () => {
    const overview = {
      ...fixtureOverview,
      quota: { ...fixtureOverview.quota, light: 'green' as const, window: sampleQuotaWindow },
    }
    const tree = createHookHost().render(TopBar, { overview })
    const text = textOf(tree)
    // P86：顶栏恢复 token 数量，写在「已用回合」之后：「员工已用约 18 回合（3.5M token），员工还可用约 18 回合」。
    expect(text).toContain('额度过半 · 员工已用约 18 回合（3.5M token），员工还可用约 18 回合')
    expect(text).not.toContain('6 / 40')
    const dot = findElements(tree, 'span').find(node => String(node.props.className).split(' ')[0] === 'ah-quota')!
    expect(String(dot.props.className)).toContain('ah-dot-warn')
    // 悬停提示里 token 写完整数字（带千位分隔符），无障碍标签里用换算后的短写法。
    expect(String(dot.props.title)).toContain('员工已用约 18 回合（3,500,000 token），员工还可用约 18 回合')
    expect(String(dot.props['aria-label'])).toContain('员工已用约 18 回合（3.5M token），员工还可用约 18 回合')
  })

  it('P86：窗口视图没有 token 两项（旧宿主）时，顶栏退回只写回合数的旧写法，不报错', () => {
    // 去掉新增的两项，模拟升级前的 core 给出的视图。
    const { staffUsedTokensText: _text, staffUsedTokens: _tokens, ...legacyWindow } = sampleQuotaWindow
    const overview = { ...fixtureOverview, quota: { ...fixtureOverview.quota, light: 'green' as const, window: legacyWindow } }
    const tree = createHookHost().render(TopBar, { overview })
    expect(textOf(tree)).toContain('额度过半 · 员工已用约 18 回合，员工还可用约 18 回合')
    expect(textOf(tree)).not.toContain('token')
    const dot = findElements(tree, 'span').find(node => String(node.props.className).split(' ')[0] === 'ah-quota')!
    expect(String(dot.props.title)).toContain('员工已用约 18 回合，员工还可用约 18 回合')
    expect(String(dot.props.title)).not.toContain('token')
  })

  it('P86：没有窗口视图（更老的宿主）时，顶栏显示宿主给的那一句，不拼 token', () => {
    const overview = { ...fixtureOverview, quota: { ...fixtureOverview.quota, window: null } }
    const tree = createHookHost().render(TopBar, { overview })
    expect(textOf(tree)).toContain(`${overview.quota.usedText}`)
    expect(textOf(tree)).not.toContain('（')
  })
})

describe('P80 右侧栏「模型与额度」一行', () => {
  const tanlu = fixtureBots['bot-tanlu']!
  const panel = (todayTokens: number, withCard = true) => createHookHost().render(RightPanel, {
    card: { ...tanlu.card, todayTokens }, detail: withCard ? tanlu : null, light: 'green', costs: undefined, sessions: [],
    onOpenSession: () => undefined, onCollapse: () => undefined, onEdit: () => undefined,
  })
  const lineOf = (tree: unknown): StubElement => {
    const section = findElements(tree, 'section').find(node => node.props['aria-label'] === '模型与额度')!
    return findElements(section, 'p')[0]!
  }

  it('用量写成换算后的写法，悬停显示完整数字', () => {
    const line = lineOf(panel(1636469))
    expect(textOf(line)).toContain('今天约 1.64M token。')
    expect(line.props.title).toBe('1,636,469 token')
  })

  it('小于 1000 原样写，悬停仍给出完整数字', () => {
    const line = lineOf(panel(856))
    expect(textOf(line)).toContain('今天约 856 token。')
    expect(line.props.title).toBe('856 token')
  })

  it('反例：读不到用量时不编数字，也没有悬停', () => {
    const tree = createHookHost().render(RightPanel, {
      card: { ...tanlu.card, todayTokens: undefined as unknown as number }, detail: tanlu, light: 'green', costs: undefined, sessions: [],
      onOpenSession: () => undefined, onCollapse: () => undefined, onEdit: () => undefined,
    })
    const line = lineOf(tree)
    expect(textOf(line)).toContain('今天还没有用量记录。')
    expect(line.props.title).toBeUndefined()
  })
})

describe('P80 每日用量表', () => {
  /** 只有一天、一位员工，数字取大一点，来源三栏都有值。 */
  const costs: CostView = {
    asOf: 0, timezone: 'Asia/Shanghai', projectStatus: 'unallocated',
    days: [{
      date: '2026-11-13',
      total: { turns: 6, ownerTurns: 1, unknownOwnerTurns: 0, tokens: 1636469, hostTokens: 1000000, estimatedTokens: 600000, unknownTokens: 36469, unknownMeasurements: 1, pending: 0 },
      bots: [{ botId: 'b1', name: '探路', archived: false, turns: 6, ownerTurns: 1, unknownOwnerTurns: 0, tokens: 1636469, hostTokens: 1000000, estimatedTokens: 600000, unknownTokens: 36469, unknownMeasurements: 1, pending: 0 }],
    }],
  }
  const tree = createHookHost().render(CostMeter, { costs })

  it('汇总一句：记账数字换算，回合数不变，悬停完整数字', () => {
    const summary = findElements(tree, 'p').find(node => node.props.className === 'ah-cost-summary')!
    expect(textOf(summary)).toContain('已结账 6 回合 · 记账 1.64M token')
    const span = findElements(summary, 'span')[0]!
    expect(span.props.title).toBe('1,636,469 token')
  })

  it('表格：记账列、来源列都是换算后的写法，各自带悬停', () => {
    const cells = findElements(findElements(tree, 'tbody')[0]!, 'td')
    expect(textOf(cells[0])).toContain('6')
    expect(textOf(cells[1])).toBe('宿主 1M · 估算 600K · 来源不明 1 笔（记账值）36.5K')
    expect(cells[1]!.props.title).toBe('宿主 1,000,000 · 估算 600,000 · 来源不明 1 笔（记账值）36,469 token')
    expect(textOf(cells[2])).toBe('1.64M')
    expect(cells[2]!.props.title).toBe('1,636,469 token')
  })

  it('合计行同样换算', () => {
    const cells = findElements(findElements(tree, 'tfoot')[0]!, 'td')
    expect(textOf(cells[2])).toBe('1.64M')
    expect(cells[2]!.props.title).toBe('1,636,469 token')
  })
})

describe('P80 组队卡页脚的「1 个回合约……」', () => {
  it('取核心的写法：110K 到 160K', () => {
    const card = sampleViewOfProposal(sampleInitialProposal)
    const tree = createHookHost().render(TeamCard, { card, onEdit: async () => null, onConfirm: async () => null })
    expect(textOf(tree)).toContain('1 个回合约 110K 到 160K token')
    expect(textOf(tree)).not.toContain('万')
  })
})

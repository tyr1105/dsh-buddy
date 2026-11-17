/**
 * P76j 第 5 节第 2、3 条：右侧栏渲染。
 * - 三件事的样例三行文字与视图一致；消耗条宽度；在等你的强调线；点一块跳到对应主题；「查看全部记录」打开动态页；
 * - 本窗口额度：正常与员工份额用完两种、读屏文字、只有总管有这一栏；
 * - 旧宿主没有视图时退回工作会话列表，两者都没有时显示空态。
 */
import { describe, expect, it, vi } from 'vitest'
import { RightPanel } from '../src/client/components/RightPanel.js'
import { NO_ACTIVE_WORK_TEXT } from '../src/client/logic/teammate-panel.js'
import { costBarWidth } from '../src/client/logic/active-jobs.js'
import { sampleActiveJobsChief, sampleQuotaWindow, sampleQuotaWindowFull } from '../src/shared/fixture-budget.js'
import { fixtureOverview } from '../src/shared/fixtures.js'
import { WorkSessionRow } from '../src/client/components/work-session-row.js'
import type { BotCard, QuotaWindowView } from '../src/shared/views.js'
import type { WorkSession } from '../src/client/logic/work-session.js'
import { createHookHost } from './helpers/hook-host.js'
import { findElements, type StubElement } from './helpers/jsx-runtime-stub.js'

vi.mock('react', async () => (await import('./helpers/hook-host.js')).reactFacade)
vi.mock('../src/client/components/use-drawer-focus.js', () => ({
  useDrawerFocus: () => ({ panelRef: { current: null } }),
  isDrawerMode: () => false,
}))

/** 一位员工的卡（总管由它复制出来）。 */
const baseCard = fixtureOverview.bots[0]!
const chiefCard: BotCard = { ...baseCard, role: 'chief', roleLabel: '总管', name: '总管', chiefJobLine: '3 件在办，2 件等你' }

function textOf(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object' && node !== null && 'props' in node) return textOf((node as StubElement).props.children)
  return ''
}

/** 摊平元素树里所有对象节点（含子组件 props 上的 children）。 */
function allElements(node: unknown): StubElement[] {
  if (Array.isArray(node)) return node.flatMap(allElements)
  if (typeof node !== 'object' || node === null || !('props' in node)) return []
  const element = node as StubElement
  return [element, ...allElements(element.props.children)]
}

function renderPanel(overrides: Partial<Parameters<typeof RightPanel>[0]> = {}): unknown {
  return createHookHost().render(RightPanel, {
    card: chiefCard, detail: null, costs: undefined, sessions: [], onOpenSession: () => undefined,
    activeJobs: sampleActiveJobsChief, quotaWindow: sampleQuotaWindow, onOpenJob: () => undefined,
    onOpenActivity: () => undefined, onCollapse: () => undefined, onEdit: () => undefined,
    ...overrides,
  })
}

/** 一件的整块按钮（按类名里的 ah-active-job 这一项认；底部的「查看全部记录」是另一个类名）。 */
function jobButtons(tree: unknown): StubElement[] {
  return allElements(tree).filter(element => String(element.props.className).split(' ').includes('ah-active-job')
    && typeof element.props.onClick === 'function')
}

describe('1 在办的事：三件事的样例', () => {
  it('头部合计与每一件的三行文字都来自视图', () => {
    const text = textOf(renderPanel())
    expect(text).toContain(sampleActiveJobsChief.headText)
    for (const row of sampleActiveJobsChief.rows) {
      expect(text).toContain(row.title)
      expect(text).toContain(row.waitText)
      expect(text).toContain(row.costText)
    }
  })

  it('消耗条只画在有预计的那几行，宽度取 costRatio', () => {
    const tree = renderPanel()
    const bars = allElements(tree).filter(element => element.props.className === 'ah-active-job-bar')
    const withRatio = sampleActiveJobsChief.rows.filter(row => row.costRatio !== null)
    expect(bars).toHaveLength(withRatio.length)
    for (const bar of bars) {
      const inner = allElements(bar)[1]
      expect((inner?.props.style as { width: string }).width).toBe(costBarWidth(withRatio[bars.indexOf(bar)]!.costRatio))
    }
  })

  it('没有预计（costRatio 为 null）的那一行不画消耗条', () => {
    const view = {
      headText: '在办的事　1 件　共用 3 回合，300K token', footerText: '查看全部记录' as const,
      rows: [{ ...sampleActiveJobsChief.rows[0]!, key: 'job_none', costRatio: null, costText: '已用 3 回合　300K token' }],
    }
    const tree = renderPanel({ activeJobs: view })
    expect(allElements(tree).filter(element => element.props.className === 'ah-active-job-bar')).toHaveLength(0)
    expect(textOf(tree)).toContain('已用 3 回合　300K token')
  })

  it('在等你的那一块左侧有强调线（is-waiting），顺序与视图一致', () => {
    const buttons = jobButtons(renderPanel())
    expect(buttons).toHaveLength(sampleActiveJobsChief.rows.length)
    buttons.forEach((button, index) => {
      const waiting = String(button.props.className).includes('is-waiting')
      expect(waiting).toBe(sampleActiveJobsChief.rows[index]!.waitingOwner)
    })
  })

  it('点一块按它所在的主题跳转', () => {
    const onOpenJob = vi.fn()
    const tree = renderPanel({ onOpenJob })
    ;(jobButtons(tree)[0]!.props.onClick as () => void)()
    expect(onOpenJob).toHaveBeenCalledWith(sampleActiveJobsChief.rows[0]!.topicId)
  })

  it('底部「查看全部记录」打开动态页', () => {
    const onOpenActivity = vi.fn()
    const tree = renderPanel({ onOpenActivity })
    const footer = allElements(tree).find(element => textOf(element) === '查看全部记录')
    expect(footer).toBeDefined()
    const click = footer!.props.onClick as () => void
    click()
    expect(onOpenActivity).toHaveBeenCalledTimes(1)
  })
})

describe('2 本窗口额度：只有总管有，两种状态都照视图画', () => {
  it('正常状态：标题、重置时刻、两行文字与三段条都在', () => {
    const tree = renderPanel({ quotaWindow: sampleQuotaWindow })
    const section = allElements(tree).find(element => element.props['aria-label'] === '本窗口额度')
    expect(section).toBeDefined()
    const text = textOf(section)
    expect(text).toContain(sampleQuotaWindow.resetText)
    expect(text).toContain(sampleQuotaWindow.staffUsedTurnsText)
    expect(text).toContain(sampleQuotaWindow.staffLeftTurnsText)
    expect(text).toContain(sampleQuotaWindow.reserveText)
    const bar = allElements(section).find(element => element.props.role === 'img')
    expect(bar?.props['aria-label']).toBe('员工已用、员工还可用、给你留出')
    const segments = allElements(bar).filter(element => String(element.props.className).startsWith('ah-quota-seg'))
    expect(segments).toHaveLength(3)
    expect(segments.map(segment => (segment.props.style as { width: string }).width)).toEqual([
      `${Math.round(sampleQuotaWindow.barParts.staffUsed * 100)}%`,
      `${Math.round(sampleQuotaWindow.barParts.staffLeft * 100)}%`,
      `${Math.round(sampleQuotaWindow.barParts.reserved * 100)}%`,
    ])
  })

  it('员工份额用完：写「已到上限」与红灯说明的恢复时刻', () => {
    const text = textOf(renderPanel({ quotaWindow: sampleQuotaWindowFull }))
    expect(text).toContain('已到上限')
    expect(sampleQuotaWindowFull.state).toBe('staff_full')
  })

  it('其他员工没有这一栏（不传 quotaWindow）', () => {
    const tree = renderPanel({ card: baseCard, quotaWindow: null })
    expect(allElements(tree).some(element => element.props['aria-label'] === '本窗口额度')).toBe(false)
  })

  it('旧宿主没有额度视图时不画这一栏', () => {
    const tree = renderPanel({ quotaWindow: undefined as unknown as QuotaWindowView | null })
    expect(allElements(tree).some(element => element.props['aria-label'] === '本窗口额度')).toBe(false)
  })
})

describe('3 旧宿主、空态与「其他事务」', () => {
  const session: WorkSession = {
    id: 'pt_old', projectId: 'prj_1', projectName: '旧项目', projectStatus: 'active', projectArchived: false,
    title: '往期名单导出', status: 'doing', statusLabel: '进行中', phase: 'doing', blocked: false, pendingCheck: false,
    assigneeBotId: baseCard.id, topicId: null, createdAt: 1, updatedAt: 2,
  }

  it('旧宿主（没有视图）：退回工作会话列表，不报错', () => {
    const tree = renderPanel({ activeJobs: null, sessions: [session] })
    expect(findElements(tree, WorkSessionRow)).toHaveLength(1)
    expect(textOf(tree)).not.toContain('其他事务')
    expect(textOf(tree)).not.toContain(NO_ACTIVE_WORK_TEXT)
  })

  it('视图行与旧任务都有：旧任务排在后面，带「其他事务」', () => {
    const tree = renderPanel({ sessions: [session] })
    expect(textOf(tree)).toContain('其他事务')
    expect(findElements(tree, WorkSessionRow)).toHaveLength(1)
  })

  it('都没有：显示空态', () => {
    const tree = renderPanel({ activeJobs: { headText: NO_ACTIVE_WORK_TEXT, rows: [], footerText: '查看全部记录' }, sessions: [] })
    expect(textOf(tree)).toContain(NO_ACTIVE_WORK_TEXT)
    expect(jobButtons(tree)).toHaveLength(0)
  })
})

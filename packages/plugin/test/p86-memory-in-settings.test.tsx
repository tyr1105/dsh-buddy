/**
 * P86：记忆收进设置页、总管右侧栏恢复 token 数量。
 *
 * 覆盖：
 * 1. 设置页导航里出现「关于你的记忆」（倒数第二项）；选中后显示记忆页的内容，没有保存栏、没有改动圆点；
 * 2. 左栏员工列表、总管右侧栏不再有记忆入口（用源码文本和渲染结果两种办法守住）；
 * 3. 页面状态 memory（约定卡出处跳转、从上次页面状态恢复）落在设置页的记忆分区，左栏选中「设置」；
 * 4. 仓库：requestMemory 仍然定位到那一条；从存储恢复上次页面状态时，memory 被保留（不退回别的页面）；
 * 5. 总管右侧栏「本窗口额度」多一行「已用 token」，悬停显示完整数字；旧宿主缺这两项时不画这一行。
 *
 * 顶栏三种情形（有新字段、没有新字段、没有窗口视图）的断言放在 p80-token-units.test.tsx 的「P80 顶栏的额度文字」里；
 * core 视图里新增两项的值与单位换算放在 packages/core/test/p76d-views.test.ts。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { SettingsPane } from '../src/client/components/SettingsPane.js'
import { RightPanel } from '../src/client/components/RightPanel.js'
import { TopBar } from '../src/client/components/TopBar.js'
import { StatusSection } from '../src/client/components/settings-sections.js'
import { SETTINGS_SECTIONS, isSettingsPageView, settingsSectionOfView } from '../src/client/logic/settings-sections.js'
import { readSurface, saveSurface, spaceSurfaceStorageKey } from '../src/client/logic/mode-nav.js'
import { createHubStore } from '../src/client/hub-state.js'
import { sampleQuotaWindow } from '../src/shared/fixture-budget.js'
import { fixtureOverview } from '../src/shared/fixtures.js'
import type { BotCard, QuotaWindowView } from '../src/shared/views.js'
import { createHookHost } from './helpers/hook-host.js'
import { findElements, type StubElement } from './helpers/jsx-runtime-stub.js'

vi.mock('react', async () => (await import('./helpers/hook-host.js')).reactFacade)
vi.mock('../src/client/components/use-drawer-focus.js', () => ({
  useDrawerFocus: () => ({ panelRef: { current: null } }),
  isDrawerMode: () => false,
}))

const clientRoot = new URL('../src/client/', import.meta.url)
const read = (path: string): string => readFileSync(new URL(path, clientRoot), 'utf8')

/** 取元素树里的全部文字。 */
function textOf(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object' && node !== null && 'props' in node) return textOf((node as StubElement).props.children)
  return ''
}

/** 摊平元素树里所有对象节点。 */
function allElements(node: unknown): StubElement[] {
  if (Array.isArray(node)) return node.flatMap(allElements)
  if (typeof node !== 'object' || node === null || !('props' in node)) return []
  const element = node as StubElement
  return [element, ...allElements(element.props.children)]
}

/** 记忆分区的替身内容：只要它出现在页面里，就说明设置页把记忆页放进了右侧。 */
const MEMORY_SENTINEL = 'MEMORY-PAGE-SENTINEL'

/** 渲染设置页（设置还没读到，只看外壳：导航、右侧内容、保存栏）。 */
function renderSettings(requestedSection: Parameters<typeof SettingsPane>[0]['requestedSection']): unknown {
  return createHookHost().render(SettingsPane, {
    settings: null, overview: null, weeklyUsage: null, loading: true,
    onRetry: () => undefined, onSave: async () => null, onPauseAll: async () => null, onResumeAll: async () => null,
    onTestKnowledge: async () => 'unused' as never,
    requestedSection,
    resources: <p>RESOURCES-SENTINEL</p>,
    memory: <p>{MEMORY_SENTINEL}</p>,
  })
}

describe('1 设置页：「关于你的记忆」分区', () => {
  it('导航里出现这一项，位置在给主人改的分区之后、只读的运行状态之前（倒数第二项）', () => {
    const ids = SETTINGS_SECTIONS.map(section => section.id)
    expect(ids.at(-2)).toBe('memory')
    expect(ids.at(-1)).toBe('status')
    const tree = renderSettings(null)
    const nav = allElements(tree).find(element => element.props['aria-label'] === '设置分区')!
    const items = allElements(nav).filter(element => String(element.props.className).startsWith('ah-set-nav-item'))
    expect(items.map(item => textOf(item))).toEqual(['通知', '模型与额度', '资料', '公共知识库', '关于你的记忆', '运行状态'])
  })

  it('选中后右侧显示记忆页的内容，没有保存栏、没有改动圆点；其他分区里没有记忆页内容', () => {
    const selected = renderSettings('memory')
    expect(textOf(selected)).toContain(MEMORY_SENTINEL)
    expect(allElements(selected).some(element => element.props['aria-label'] === '保存修改')).toBe(false)
    expect(allElements(selected).some(element => String(element.props.className) === 'ah-set-dot')).toBe(false)
    // 反例：停在别的分区时，记忆页内容不出现。
    expect(textOf(renderSettings('resources'))).not.toContain(MEMORY_SENTINEL)
    expect(textOf(renderSettings(null))).not.toContain(MEMORY_SENTINEL)
  })

  it('点导航里的「关于你的记忆」：切到这一分区并通知上层（上层据此把页面状态切到记忆）', () => {
    const opened: string[] = []
    const host = createHookHost()
    const tree = host.render(SettingsPane, {
      settings: null, overview: null, weeklyUsage: null, loading: true,
      onRetry: () => undefined, onSave: async () => null, onPauseAll: async () => null, onResumeAll: async () => null,
      onTestKnowledge: async () => 'unused' as never,
      resources: <p>RESOURCES-SENTINEL</p>, memory: <p>{MEMORY_SENTINEL}</p>,
      onOpenSection: (id: string) => { opened.push(id) },
    })
    const button = allElements(tree).find(element => textOf(element) === '关于你的记忆' && typeof element.props.onClick === 'function')!
    ;(button.props.onClick as () => void)()
    expect(opened).toEqual(['memory'])
  })
})

describe('2 左栏与总管右侧栏不再有记忆入口', () => {
  it('源码里没有入口按钮、条数文字、样式与属性', () => {
    for (const file of ['components/sidebar-teammates-group.tsx', 'components/team-sidebar-nav.tsx', 'components/team-sidebar.tsx', 'components/RightPanel.tsx', 'pages/HubPage.tsx']) {
      const source = read(file)
      expect(source, file).not.toContain('memoryEntryText')
      expect(source, file).not.toContain('ah-nav-memory-entry')
      expect(source, file).not.toContain('ah-right-memory-entry')
      expect(source, file).not.toContain('memoryCount')
      expect(source, file).not.toContain('onOpenMemory={() => { setRightOpen')
    }
    expect(read('components/sidebar-teammates-group.tsx')).not.toContain('onOpenMemory')
    expect(read('components/RightPanel.tsx')).not.toContain('onOpenMemory')
  })

  it('总管右侧栏渲染出来没有「关于你的记忆」，也没有「N 条」', () => {
    const chief: BotCard = { ...fixtureOverview.bots[0]!, role: 'chief', roleLabel: '总管', name: '总管', chiefJobLine: '3 件在办，2 件等你' }
    const tree = createHookHost().render(RightPanel, {
      card: chief, detail: null, costs: undefined, sessions: [], onOpenSession: () => undefined,
      quotaWindow: sampleQuotaWindow, onCollapse: () => undefined, onEdit: () => undefined,
    })
    expect(textOf(tree)).not.toContain('关于你的记忆')
    expect(allElements(tree).some(element => String(element.props.className ?? '').includes('memory-entry'))).toBe(false)
  })
})

describe('3 页面状态 memory 落在设置页的记忆分区', () => {
  it('对应关系：memory -> 记忆分区；resource -> 资料分区；settings 不指定分区；其余页面不是设置页', () => {
    expect(settingsSectionOfView('memory')).toBe('memory')
    expect(settingsSectionOfView('resource')).toBe('resources')
    expect(settingsSectionOfView('settings')).toBeNull()
    for (const view of ['main', 'office', 'project', 'inbox', 'activity']) expect(settingsSectionOfView(view), view).toBeUndefined()
  })

  it('左栏据此高亮「设置」：memory、resource、settings 都算设置页，其余不算', () => {
    for (const view of ['memory', 'resource', 'settings']) expect(isSettingsPageView(view), view).toBe(true)
    for (const view of ['main', 'office', 'project', 'inbox', 'activity']) expect(isSettingsPageView(view), view).toBe(false)
  })

  it('HubPage 把 memory 当作设置页渲染，不再有独立的记忆页分支', () => {
    const hubPage = read('pages/HubPage.tsx')
    expect(hubPage).toContain("view === 'settings' || view === 'resource' || view === 'memory'")
    expect(hubPage).toContain('requestedSection={settingsSectionOfView(view) ?? null}')
    expect(hubPage).not.toContain(") : view === 'memory' ? (")
  })

  it('SettingsPane 收到 requestedSection 为 memory 时直接选中这一分区（首次挂载与之后的跳转都成立）', () => {
    expect(textOf(renderSettings('memory'))).toContain(MEMORY_SENTINEL)
  })
})

describe('4 仓库：出处跳转定位、从上次页面状态恢复', () => {
  it('requestMemory 带编号：页面状态为 memory 并记下要定位的那一条；不带编号不定位', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    try {
      const hub = createHubStore()
      hub.requestMemory('mem_x1')
      expect(hub.getSnapshot().view).toBe('memory')
      expect(hub.getSnapshot().memoryFocusId).toBe('mem_x1')
      hub.requestMemory()
      expect(hub.getSnapshot().memoryFocusId).toBeNull()
      expect(isSettingsPageView(hub.getSnapshot().view)).toBe(true)
    } finally { vi.unstubAllGlobals() }
  })

  it('上次停在记忆页：存下来再读出来仍是 memory，且对应设置页的记忆分区（不会出现没有导航的孤立记忆页）', () => {
    const box = new Map<string, string>()
    const storage = () => ({ getItem: (key: string) => box.get(key) ?? null, setItem: (key: string, value: string) => { box.set(key, value) } }) as unknown as Storage
    saveSurface(storage, { view: 'memory', threadId: '' })
    expect(box.has(spaceSurfaceStorageKey)).toBe(true)
    const restored = readSurface(storage)
    expect(restored?.view).toBe('memory')
    expect(settingsSectionOfView(restored!.view)).toBe('memory')
  })
})

describe('6 设置页只读状态里的「模型额度」一行写明时间范围', () => {
  const rowText = (window: QuotaWindowView | null): string => {
    const overview = { ...fixtureOverview, quota: { ...fixtureOverview.quota, usedText: '6 / 40 回合，1.64M token', resetText: '今天 16:44', window } }
    const tree = createHookHost().render(StatusSection, { overview, rootDir: '/hub', onPauseAll: async () => null, onResumeAll: async () => null })
    const row = findElements(tree, 'div').find(node => findElements(node, 'dt').some(dt => textOf(dt) === '模型额度'))!
    return textOf(findElements(row, 'dd')[0])
  }

  it('有额度窗口视图时，数字前写「本窗口」', () => {
    // P86r1：前缀改为能与顶栏「员工已用」区分开的说法。
    expect(rowText(sampleQuotaWindow)).toContain('本窗口全队合计（含你发起的对话，不含项目主题） 6 / 40 回合，1.64M token，今天 16:44')
  })

  it('反例：没有窗口视图的旧宿主保持原写法，不加「本窗口」', () => {
    expect(rowText(null)).toBe('额度充足，6 / 40 回合，1.64M token，今天 16:44')
  })
})

describe('7 P86r1：窄窗口下顶栏灯点旁边的 token 短文字', () => {
  const shortOf = (window: QuotaWindowView | null): StubElement | undefined => {
    const overview = { ...fixtureOverview, quota: { ...fixtureOverview.quota, window } }
    return allElements(createHookHost().render(TopBar, { overview })).find(element => element.props.className === 'ah-quota-short')
  }

  it('视图有 token 文字时画出短文字，内容就是视图里的文字', () => {
    expect(textOf(shortOf(sampleQuotaWindow))).toBe('3.5M token')
  })

  it('反例：旧宿主视图没有 token 文字、或没有窗口视图时不画', () => {
    const { staffUsedTokensText: _text, staffUsedTokens: _tokens, ...legacy } = sampleQuotaWindow
    expect(shortOf(legacy)).toBeUndefined()
    expect(shortOf(null)).toBeUndefined()
  })

  it('样式：宽窗隐藏；1100 断点里长文字收起、短文字显示且不换行', () => {
    const css = read('workspace.css')
    expect(css).toMatch(/\n\.ah-quota-short \{ display: none; \}/)
    expect(css).toMatch(/@container buddy \(max-width: 1100px\) \{[^@]*\.ah-quota-text \{ display: none; \}[^@]*\.ah-quota-short \{ display: inline; white-space: nowrap; \}/)
  })
})

describe('5 总管右侧栏「本窗口额度」：已用 token 一行', () => {
  const chief: BotCard = { ...fixtureOverview.bots[0]!, role: 'chief', roleLabel: '总管', name: '总管', chiefJobLine: '3 件在办，2 件等你' }
  const render = (quotaWindow: QuotaWindowView): unknown => createHookHost().render(RightPanel, {
    card: chief, detail: null, costs: undefined, sessions: [], onOpenSession: () => undefined,
    quotaWindow, onCollapse: () => undefined, onEdit: () => undefined,
  })
  const sectionOf = (tree: unknown): StubElement => allElements(tree).find(element => element.props['aria-label'] === '本窗口额度')!

  it('有视图的两项时：行名「已用 token」加视图给的文字，悬停显示完整数字', () => {
    const section = sectionOf(render(sampleQuotaWindow))
    const line = allElements(section).find(element => textOf(element).startsWith('已用 token'))!
    expect(textOf(line)).toBe(`已用 token　${sampleQuotaWindow.staffUsedTokensText}`)
    expect(textOf(line)).toBe('已用 token　3.5M token')
    expect(line.props.title).toBe('3,500,000 token')
  })

  it('反例：旧宿主的视图没有这两项时不画这一行，也不报错', () => {
    const { staffUsedTokensText: _text, staffUsedTokens: _tokens, ...legacy } = sampleQuotaWindow
    const section = sectionOf(render(legacy))
    expect(textOf(section)).not.toContain('已用 token')
    expect(textOf(section)).toContain(sampleQuotaWindow.staffUsedTurnsText)
  })
})

/**
 * 员工动线面板测试（P62）：只留下主人要的那几样，读取和刷新的时机也要对。
 *
 * 为什么要测组件：时间段怎么算已经有纯逻辑测试，这里钉住面板自己的事——
 * 拿掉的内容不能回来、行不能点、每次整页刷新不能重读（以前这样会把翻到的日期打回今天）、
 * 房间变了才重读、读不到时有路可走。测试环境没有真 React，用 hook 宿主连续渲染同一次挂载。
 */
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectView, WakeLedgerRow } from '../src/shared/views.js'
import { fixtureLedgerRows } from '../src/shared/fixture-ledger.js'
import { fixtureOffice } from '../src/shared/fixture-office.js'
import { api } from '../src/client/api.js'
import { OfficeTrailPanel, type OfficeTrailPanelProps } from '../src/client/components/office-trail-panel.js'
import { OfficePage } from '../src/client/pages/OfficePage.js'
import { OfficePixelPage } from '../src/client/pages/office-pixel-page.js'
import { createHookHost } from './helpers/hook-host.js'
import { findElements, type StubElement } from './helpers/jsx-runtime-stub.js'

vi.mock('react', async () => (await import('./helpers/hook-host.js')).reactFacade)

/** 东八区 2026-11-08 12:00。 */
const NOW = Date.UTC(2026, 10, 8, 4, 0)
function atLocal(day: number, hour: number, minute: number): number {
  return Date.UTC(2026, 10, day, hour - 8, minute)
}

function row(wakeId: string, openedAt: number, sealedAt: number | null, botId = 'bot-a'): WakeLedgerRow {
  const base = fixtureLedgerRows('bot-tanlu')[0]!
  return { ...base, wakeId, botId, openedAt, sealedAt, triggerKind: 'owner_message', summary: '摘要原文', triggerText: '触发原文' }
}

/** 一个项目一个任务，够测「项目名，任务标题」。 */
function projectView(wakeIds: string[]): ProjectView {
  return {
    asOf: NOW,
    projects: [{ project: { name: 'dddd' }, tasks: [{ task: { id: 'pt_1', title: '来来', status: 'doing', wakeIds, createdAt: 1, updatedAt: 1, dueAt: null } }] }],
    counts: { active: 1, paused: 0, done: 0, archived: 0, total: 1, tasksTotal: 1, tasksPendingCheck: 0 },
  } as unknown as ProjectView
}

function props(patch: Partial<OfficeTrailPanelProps> = {}): OfficeTrailPanelProps {
  return {
    botId: 'bot-a', botName: '研究员', now: NOW, live: false, timezone: 'Asia/Shanghai',
    loadRows: vi.fn(async () => [row('w1', atLocal(8, 9, 0), atLocal(8, 9, 30)), row('w2', atLocal(8, 10, 0), atLocal(8, 10, 30))]),
    loadProjects: vi.fn(async () => projectView(['w1'])),
    onOpenChat: vi.fn(), onClose: vi.fn(),
    ...patch,
  }
}

/** 把元素树里的文字拼起来；函数组件不展开，和面板实际输出一致。 */
function textOf(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node !== 'object' || node === null || !('props' in node)) return ''
  return textOf((node as StubElement).props.children)
}

/** 等读取的 Promise 走完，再渲染一次把结果画出来。 */
async function settle(host: ReturnType<typeof createHookHost>, panelProps: OfficeTrailPanelProps): Promise<unknown> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve()
  return host.render(OfficeTrailPanel, panelProps)
}

function buttonNamed(tree: unknown, name: string): StubElement {
  const found = findElements(tree, 'button').find(element => textOf(element).includes(name))
  if (found === undefined) throw new Error(`没有找到按钮：${name}`)
  return found
}

beforeEach(() => { vi.useFakeTimers({ now: NOW }) })
afterEach(() => { vi.useRealTimers() })

describe('面板只留主人要的内容', () => {
  it('标题是「名字的动线」，地标名一致，收起和打开对话都在', async () => {
    const panelProps = props()
    const host = createHookHost()
    const tree = await (host.render(OfficeTrailPanel, panelProps), settle(host, panelProps))
    expect(textOf(findElements(tree, 'h3')[0])).toBe('研究员的动线')
    expect(findElements(tree, 'aside')[0]?.props['aria-label']).toBe('研究员的动线')
    ;(buttonNamed(tree, '收起').props.onClick as () => void)()
    expect(panelProps.onClose).toHaveBeenCalledOnce()
    ;(buttonNamed(tree, '打开对话').props.onClick as () => void)()
    expect(panelProps.onOpenChat).toHaveBeenCalledOnce()
  })

  it('每行是「hh:mm～hh:mm：内容」，属于任务的写「项目名，任务标题」', async () => {
    const panelProps = props()
    const host = createHookHost()
    const tree = await (host.render(OfficeTrailPanel, panelProps), settle(host, panelProps))
    expect(findElements(tree, 'li').map(textOf)).toEqual([
      '09:00～09:30：dddd，来来', '09:30～10:00：空闲', '10:00～10:30：回你的消息', '10:30～12:00：空闲',
    ])
  })

  it('反例：行里没有按钮；桌上产出、门口、结果标签、账本说明都不见了', async () => {
    const panelProps = props()
    const host = createHookHost()
    const tree = await (host.render(OfficeTrailPanel, panelProps), settle(host, panelProps))
    for (const item of findElements(tree, 'li')) expect(findElements(item, 'button')).toEqual([])
    const all = textOf(tree)
    expect(all).not.toMatch(/桌上|门口|账本|唤醒|有进展|摘要原文|触发原文/)
    expect(textOf(findElements(tree, 'footer')[0])).toBe('打开对话')
  })

  it('按天翻看：今天不能往后翻，前翻到更早一天再翻回来', async () => {
    const panelProps = props({ loadRows: vi.fn(async () => [row('old', atLocal(7, 9, 0), atLocal(7, 9, 30)), row('new', atLocal(8, 9, 0), atLocal(8, 9, 30))]) })
    const host = createHookHost()
    let tree = await (host.render(OfficeTrailPanel, panelProps), settle(host, panelProps))
    expect(buttonNamed(tree, '后翻').props.disabled).toBe(true)
    expect(buttonNamed(tree, '前翻').props.disabled).toBe(false)
    expect(textOf(findElements(tree, 'li')[0])).toBe('09:00～09:30：回你的消息')
    ;(buttonNamed(tree, '前翻').props.onClick as () => void)()
    tree = host.render(OfficeTrailPanel, panelProps)
    expect(textOf(tree)).toContain('昨天 · 11 月 7 日')
    expect(buttonNamed(tree, '后翻').props.disabled).toBe(false)
    expect(buttonNamed(tree, '前翻').props.disabled).toBe(true)
  })

  it('当天和往日没有记录时各有一句话，不是空白', async () => {
    const panelProps = props({ loadRows: vi.fn(async () => [row('old', atLocal(6, 9, 0), atLocal(6, 9, 30))]) })
    const host = createHookHost()
    let tree = await (host.render(OfficeTrailPanel, panelProps), settle(host, panelProps))
    expect(textOf(tree)).toContain('今天暂无活动记录')
    ;(buttonNamed(tree, '前翻').props.onClick as () => void)()
    tree = host.render(OfficeTrailPanel, panelProps)
    expect(textOf(tree)).toContain('该日暂无活动记录')
  })
})

describe('读取和刷新的时机', () => {
  it('反例：上层每次渲染都换一个新的读取函数，不会重读，翻到的日期也不会被打回今天', async () => {
    const loadRows = vi.fn<OfficeTrailPanelProps['loadRows']>(async () => [row('old', atLocal(7, 9, 0), atLocal(7, 9, 30))])
    const loadProjects = vi.fn(async () => projectView([]))
    const panelProps = props({ loadRows, loadProjects })
    const host = createHookHost()
    let tree = await (host.render(OfficeTrailPanel, panelProps), settle(host, panelProps))
    ;(buttonNamed(tree, '前翻').props.onClick as () => void)()
    tree = host.render(OfficeTrailPanel, { ...panelProps, loadRows: botId => loadRows(botId), loadProjects: () => loadProjects() })
    expect(textOf(tree)).toContain('昨天')
    expect(loadRows).toHaveBeenCalledOnce()
    expect(loadProjects).toHaveBeenCalledOnce()
  })

  it('看现在的房间：房间变了，下一次走钟才重读；没变就不发请求', async () => {
    const loadRows = vi.fn(async () => [row('w1', atLocal(8, 9, 0), atLocal(8, 9, 30))])
    const panelProps = props({ live: true, loadRows })
    const host = createHookHost()
    await (host.render(OfficeTrailPanel, panelProps), settle(host, panelProps))
    expect(loadRows).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(10_000)
    await settle(host, panelProps)
    expect(loadRows).toHaveBeenCalledTimes(1)
    const changed = { ...panelProps, now: NOW + 60_000 }
    host.render(OfficeTrailPanel, changed)
    vi.advanceTimersByTime(10_000)
    await settle(host, changed)
    expect(loadRows).toHaveBeenCalledTimes(2)
  })

  it('看现在的房间：「现在」跟着真实时间走，刚结束的工作过一分钟出现末尾空闲', async () => {
    const panelProps = props({ live: true, loadRows: vi.fn(async () => [row('w9', NOW - 10 * 60_000, NOW - 1000)]) })
    const host = createHookHost()
    let tree = await (host.render(OfficeTrailPanel, panelProps), settle(host, panelProps))
    expect(findElements(tree, 'li').map(textOf)).toEqual(['11:50～11:59：回你的消息'])
    vi.advanceTimersByTime(70_000)
    tree = await settle(host, panelProps)
    expect(findElements(tree, 'li').map(textOf)).toEqual(['11:50～11:59：回你的消息', '11:59～现在：空闲'])
  })

  it('反例：倒带时不走钟、不重读，末尾写所选时刻', async () => {
    const loadRows = vi.fn(async () => [row('w9', atLocal(8, 9, 0), atLocal(8, 9, 30))])
    const panelProps = props({ live: false, loadRows })
    const host = createHookHost()
    let tree = await (host.render(OfficeTrailPanel, panelProps), settle(host, panelProps))
    vi.advanceTimersByTime(60_000)
    tree = await settle(host, panelProps)
    expect(loadRows).toHaveBeenCalledOnce()
    expect(findElements(tree, 'li').map(textOf)).toEqual(['09:00～09:30：回你的消息', '09:30～12:00：空闲'])
  })

  it('换人：不把上一位的动线安在新名字下面，翻页回到今天', async () => {
    const first = props({ loadRows: vi.fn(async () => [row('w1', atLocal(8, 9, 0), atLocal(8, 9, 30))]) })
    const host = createHookHost()
    await (host.render(OfficeTrailPanel, first), settle(host, first))
    const next = { ...first, botId: 'bot-b', botName: '探路', loadRows: vi.fn(() => new Promise<WakeLedgerRow[]>(() => undefined)) }
    const tree = host.render(OfficeTrailPanel, next)
    expect(textOf(findElements(tree, 'h3')[0])).toBe('探路的动线')
    expect(findElements(tree, 'li')).toEqual([])
    expect(textOf(tree)).toContain('正在读取动线')
  })
})

describe('读不到的时候', () => {
  it('动线读不到：显示原因和重试，重试成功后恢复列表', async () => {
    const loadRows = vi.fn<OfficeTrailPanelProps['loadRows']>()
      .mockRejectedValueOnce(new Error('连接中断。点击重试；仍失败请确认 DSH 是否已关闭。'))
      .mockResolvedValue([row('w1', atLocal(8, 9, 0), atLocal(8, 9, 30))])
    const panelProps = props({ loadRows })
    const host = createHookHost()
    let tree = await (host.render(OfficeTrailPanel, panelProps), settle(host, panelProps))
    expect(textOf(tree)).toContain('连接中断')
    expect(findElements(tree, 'li')).toEqual([])
    ;(buttonNamed(tree, '重试').props.onClick as () => void)()
    tree = host.render(OfficeTrailPanel, panelProps)
    tree = await settle(host, panelProps)
    expect(textOf(tree)).not.toContain('连接中断')
    expect(findElements(tree, 'li')).toHaveLength(2)
  })

  it('项目读不到：动线照常显示，只退回大致说法，并说一声', async () => {
    const panelProps = props({ loadProjects: vi.fn(async () => { throw new Error('404') }) })
    const host = createHookHost()
    const tree = await (host.render(OfficeTrailPanel, panelProps), settle(host, panelProps))
    expect(textOf(findElements(tree, 'li')[0])).toBe('09:00～09:30：回你的消息')
    expect(textOf(tree)).toContain('项目信息读取失败')
  })

  it('已经有内容时后台重读失败：继续显示旧内容，不换成报错', async () => {
    const loadRows = vi.fn<OfficeTrailPanelProps['loadRows']>()
      .mockResolvedValueOnce([row('w1', atLocal(8, 9, 0), atLocal(8, 9, 30))])
      .mockRejectedValue(new Error('连接中断'))
    const panelProps = props({ live: true, loadRows })
    const host = createHookHost()
    await (host.render(OfficeTrailPanel, panelProps), settle(host, panelProps))
    const changed = { ...panelProps, now: NOW + 60_000 }
    host.render(OfficeTrailPanel, changed)
    vi.advanceTimersByTime(10_000)
    const tree = await settle(host, changed)
    expect(loadRows).toHaveBeenCalledTimes(2)
    expect(textOf(tree)).not.toContain('连接中断')
    expect(findElements(tree, 'li').length).toBeGreaterThan(0)
  })
})

describe('办公室页的接线', () => {
  type PageProps = Parameters<typeof OfficePage>[0]

  function pageProps(patch: Partial<PageProps> = {}): PageProps {
    return {
      office: fixtureOffice, loading: false, onRetry: vi.fn(), onOpenBot: vi.fn(), onOpenInbox: vi.fn(),
      loadTrail: vi.fn(async () => []), ...patch,
    }
  }

  /** 走真实的点小人回调，返回打开面板后的元素树。 */
  function openTrail(host: ReturnType<typeof createHookHost>, page: PageProps, botId = 'bot-tanlu'): unknown {
    const first = host.render(OfficePage, page)
    ;(findElements(first, OfficePixelPage)[0]?.props.onSelectSeat as (id: string) => void)(botId)
    return host.render(OfficePage, page)
  }

  it('没点小人时没有面板；点了指向这位队友；收起后面板消失，办公室恢复全宽', () => {
    const page = pageProps()
    const host = createHookHost()
    expect(findElements(host.render(OfficePage, page), OfficeTrailPanel)).toEqual([])
    const opened = findElements(openTrail(host, page), OfficeTrailPanel)
    expect(opened).toHaveLength(1)
    expect(opened[0]?.props.botId).toBe('bot-tanlu')
    expect(opened[0]?.props.botName).toBe('探路')
    ;(opened[0]?.props.onClose as () => void)()
    expect(findElements(host.render(OfficePage, page), OfficeTrailPanel)).toEqual([])
  })

  it('打开对话用 onOpenBot，只带队友，不再带某次唤醒', () => {
    const page = pageProps()
    const panel = findElements(openTrail(createHookHost(), page), OfficeTrailPanel)[0]
    ;(panel?.props.onOpenChat as () => void)()
    expect(page.onOpenBot).toHaveBeenCalledExactlyOnceWith('bot-tanlu')
  })

  it('面板只收动线需要的东西：桌上产出、门口、账本入口都不再传', () => {
    const panel = findElements(openTrail(createHookHost(), pageProps()), OfficeTrailPanel)[0]
    expect(Object.keys(panel?.props ?? {}).sort()).toEqual(
      ['botId', 'botName', 'live', 'loadProjects', 'loadRows', 'now', 'onClose', 'onOpenChat', 'timezone'].sort(),
    )
  })

  it('看现在的房间 live=true，倒带 live=false', () => {
    expect(findElements(openTrail(createHookHost(), pageProps()), OfficeTrailPanel)[0]?.props.live).toBe(true)
    expect(findElements(openTrail(createHookHost(), pageProps({ replaying: true })), OfficeTrailPanel)[0]?.props.live).toBe(false)
  })

  it('没传项目读取函数时直接读中心接口；传了就用传入的', () => {
    expect(findElements(openTrail(createHookHost(), pageProps()), OfficeTrailPanel)[0]?.props.loadProjects).toBe(api.project)
    const custom = vi.fn(async () => projectView([]))
    expect(findElements(openTrail(createHookHost(), pageProps({ loadProjects: custom })), OfficeTrailPanel)[0]?.props.loadProjects).toBe(custom)
  })

  it('反例：选中的队友不在房间里了，面板自动收起', () => {
    const page = pageProps()
    const host = createHookHost()
    openTrail(host, page)
    const emptied = { ...page, office: { ...fixtureOffice, seats: [] } }
    expect(findElements(host.render(OfficePage, emptied), OfficeTrailPanel)).toEqual([])
  })
})

describe('样式和接线的契约', () => {
  const read = (path: string): string => readFileSync(new URL(`../src/client/${path}`, import.meta.url), 'utf8')
  const css = read('workspace.css')
  const panel = read('components/office-trail-panel.tsx')
  const page = read('pages/OfficePage.tsx')

  it('默认是带遮罩的抽屉，容器宽于 760 才变成右侧栏，并让出房间的宽度', () => {
    expect(css).toMatch(/\.ah-trail \{[^}]*position: fixed/)
    const rail = css.slice(css.indexOf('@container buddy (width > 760px)'))
    expect(rail).toMatch(/\.ah-trail \{ position: absolute/)
    expect(rail).toMatch(/\.ah-trail-scrim \{ display: none/)
    expect(rail).toMatch(/\.ah-office-replay:has\(\.ah-trail\) \{ margin-right: var\(--ah-trail-rail\)/)
  })

  it('被拿掉的样式和入口不再存在', () => {
    expect(css).not.toMatch(/\.ah-trail-(fact|event|kind)/)
    expect(panel).not.toMatch(/onOpenWake|onOpenDesk|onOpenInbox|onOpenBotDetail|trail\.dropped|trail\.truncated/)
    expect(page).not.toContain('onOpenWake')
    expect(page).not.toContain('openDeskOf')
  })
})

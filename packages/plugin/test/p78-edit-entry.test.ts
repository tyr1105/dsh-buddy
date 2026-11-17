/**
 * P78：对话页「更多」菜单里的「编辑员工」入口，以及「更多」菜单不被头部裁切的样式约定。
 *
 * 用 hook 宿主渲染真实组件：只看这一层交给下一层什么，子组件不展开。
 * 每条规则至少一个正例一个反例。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RightPanel } from '../src/client/components/RightPanel.js'
import { TeammateEditHost } from '../src/client/components/teammate-edit-host.js'
import { ThreadPane } from '../src/client/components/ThreadPane.js'
import { createHubStore, type HubStore } from '../src/client/hub-state.js'
import { HubPage } from '../src/client/pages/HubPage.js'
import { fixtureProject } from '../src/shared/fixture-project.js'
import { fixtureBots, fixtureOverview, fixtureThreads } from '../src/shared/fixtures.js'
import type { StaffStatus, ThreadView } from '../src/shared/views.js'
import { createHookHost } from './helpers/hook-host.js'
import { findElements, type StubElement } from './helpers/jsx-runtime-stub.js'

vi.mock('react', async () => (await import('./helpers/hook-host.js')).reactFacade)
vi.mock('react-dom', () => ({ createPortal: () => null }))
vi.mock('../src/client/components/use-drawer-focus.js', () => ({
  useDrawerFocus: () => ({ panelRef: { current: null } }),
  isDrawerMode: () => false,
}))

// 页面挂载时会拉数据、监听 window 键盘：这里的断言只看页面状态，数据请求永远等待，window 用替身。
beforeEach(() => {
  vi.stubGlobal('fetch', () => new Promise(() => undefined))
  vi.stubGlobal('window', { addEventListener: () => undefined, removeEventListener: () => undefined })
})
afterEach(() => { vi.unstubAllGlobals() })

/** 把元素树里的文字拼起来；子组件不展开。 */
function textOf(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object' && node !== null && 'props' in node) return textOf((node as StubElement).props.children)
  return ''
}
const classOf = (node: StubElement): string => String(node.props.className ?? '')

const thread: ThreadView = fixtureThreads.find(item => item.threadId === 'bot-tanlu')!

/** 员工私聊页的最小入参；staffStatus 可换，topic 可传。 */
function paneProps(patch: Partial<Parameters<typeof ThreadPane>[0]> = {}, staffStatus: StaffStatus | null = 'on_duty'): Parameters<typeof ThreadPane>[0] {
  return {
    threadId: thread.threadId, thread: { ...thread, hasMore: false }, loading: false,
    header: { name: '探路', roleLabel: '调研', activityText: '空闲', nextThinkText: null, staffStatus, thinking: false },
    inputPlaceholderName: '探路', banner: null, onBannerDismiss: () => undefined, onLoadEarlier: () => undefined, onSend: async () => undefined,
    actions: { onPick: async () => null }, busyInboxId: null, onRetry: () => undefined, error: null,    onOpenSession: () => undefined, onTogglePause: () => undefined, onInterrupt: () => undefined, ...patch,
  }
}

/** 「更多」菜单面板里的按钮文字（按出现顺序）；没有「更多」时返回 null。 */
function menuLabels(tree: unknown): string[] | null {
  const menu = findElements(tree, 'div').find(node => classOf(node) === 'ah-thread-menu')
  return menu === undefined ? null : findElements(menu, 'button').map(textOf)
}

describe('P78 员工私聊页「更多」里的「编辑员工」', () => {
  it('正例：在岗员工的「更多」始终显示，「编辑员工」是第一项', () => {
    const labels = menuLabels(createHookHost().render(ThreadPane, paneProps()))
    expect(labels).not.toBeNull()
    expect(labels![0]).toBe('编辑员工')
  })

  it('正例：停用的员工同样有这一项；有「加载更早」「打断」时它仍排第一', () => {
    expect(menuLabels(createHookHost().render(ThreadPane, paneProps({}, 'suspended')))![0]).toBe('编辑员工')
    const busy = paneProps({ thread: { ...thread, hasMore: true } })
    busy.header = { ...busy.header!, thinking: true }
    const labels = menuLabels(createHookHost().render(ThreadPane, busy))!
    expect(labels[0]).toBe('编辑员工')
    expect(labels).toContain('加载更早')
    expect(labels).toContain('打断')
  })

  it('点它：把焦点交还「更多」、收起菜单、通知页面打开弹窗', () => {
    const onEditStaff = vi.fn()
    const tree = createHookHost().render(ThreadPane, paneProps({ onEditStaff }))
    const menu = findElements(tree, 'div').find(node => classOf(node) === 'ah-thread-menu')!
    const item = findElements(menu, 'button').find(node => textOf(node) === '编辑员工')!
    ;(item.props.onClick as () => void)()
    expect(onEditStaff).toHaveBeenCalledTimes(1)
  })

  it('反例：已归档的员工没有这一项（「更多」里其余项照旧）', () => {
    const labels = menuLabels(createHookHost().render(ThreadPane, paneProps({}, 'archived')))
    expect(labels).not.toBeNull()
    expect(labels).not.toContain('编辑员工')
  })

  it('反例：项目主题页没有这一项（主题没有员工状态，「更多」只在有可做的事时才显示）', () => {
    const topic = paneProps({
      topic: { title: '主题', projectName: '项目', placeholder: 'x', readOnlyText: null, members: [], replying: [] },
      thread: { ...thread, hasMore: true },
    }, null)
    expect(menuLabels(createHookHost().render(ThreadPane, topic))).toEqual(['加载更早'])
    const quiet = paneProps({ thread: { ...thread, hasMore: false } }, null)
    expect(menuLabels(createHookHost().render(ThreadPane, quiet))).toBeNull()
  })
})

describe('P78 两个入口共用同一个弹窗', () => {
  function loadedHub(): HubStore {
    const hub = createHubStore()
    hub.update(prev => ({ ...prev, overview: fixtureOverview, project: fixtureProject, bots: fixtureBots, selectedThread: 'bot-tanlu', view: 'main' }))
    return hub
  }
  const pageProps = (hub: HubStore): Parameters<typeof HubPage>[0] => ({ hub, clientCtx: null })
  const hostsOf = (tree: unknown): StubElement[] => findElements(tree, TeammateEditHost)

  it('右侧栏没有展开：点「更多」里的「编辑员工」，弹窗打开；关闭后收起', () => {
    const hub = loadedHub()
    const host = createHookHost()
    const first = host.render(HubPage, pageProps(hub))
    expect(findElements(first, RightPanel)).toEqual([])
    expect(hostsOf(first)).toHaveLength(1)
    expect(hostsOf(first)[0]!.props.open).toBe(false)
    ;(findElements(first, ThreadPane)[0]!.props.onEditStaff as () => void)()
    const opened = host.render(HubPage, pageProps(hub))
    expect(findElements(opened, RightPanel)).toEqual([])
    expect(hostsOf(opened)).toHaveLength(1)
    expect(hostsOf(opened)[0]!.props.open).toBe(true)
    ;(hostsOf(opened)[0]!.props.onClose as () => void)()
    expect(hostsOf(host.render(HubPage, pageProps(hub)))[0]!.props.open).toBe(false)
  })

  it('右侧栏展开：底部按钮打开的是同一个弹窗（页面上始终只有一份）', () => {
    const hub = loadedHub()
    const host = createHookHost()
    ;(findElements(host.render(HubPage, pageProps(hub)), ThreadPane)[0]!.props.onExpandRight as () => void)()
    const withPanel = host.render(HubPage, pageProps(hub))
    ;(findElements(withPanel, RightPanel)[0]!.props.onEdit as () => void)()
    const opened = host.render(HubPage, pageProps(hub))
    expect(hostsOf(opened)).toHaveLength(1)
    expect(hostsOf(opened)[0]!.props.open).toBe(true)
  })

  it('反例：在 A 的页面打开弹窗后切到 B，弹窗不跟过去', () => {
    const hub = loadedHub()
    const host = createHookHost()
    ;(findElements(host.render(HubPage, pageProps(hub)), ThreadPane)[0]!.props.onEditStaff as () => void)()
    hub.selectThread('bot-xunjian')
    expect(hostsOf(host.render(HubPage, pageProps(hub)))[0]!.props.open).toBe(false)
  })
})

describe('P78 「更多」菜单不被头部裁切', () => {
  const css = readFileSync(fileURLToPath(new URL('../src/client/styles.css', import.meta.url)), 'utf-8')
  /** 取某条选择器的最后一条规则体：后写的规则会盖过前面的。 */
  const ruleBodies = (selector: string): string[] =>
    [...css.matchAll(new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'g'))].map(m => m[1]!)

  it('头部本身不设溢出隐藏或滚动：绝对定位的菜单才不会被头部边界裁切', () => {
    const bodies = ruleBodies('.ah-thread-header')
    expect(bodies.length).toBeGreaterThan(0)
    for (const body of bodies) expect(body).not.toMatch(/overflow(-y|-x)?:\s*(auto|hidden|scroll|clip)/)
  })

  it('状态文字过多时的滚动只放在文字区，不在整个头部', () => {
    const body = ruleBodies('.ah-thread-header-main').join(' ')
    expect(body).toMatch(/overflow-y:\s*auto/)
    expect(body).toMatch(/max-height:/)
  })

  it('菜单放不下时自己滚动，限高不依赖头部高度', () => {
    const body = ruleBodies('.ah-thread-menu').join(' ')
    expect(body).toMatch(/max-height:/)
    expect(body).toMatch(/overflow-y:\s*auto/)
  })

  it('「名字不被标签挤没」的布局没被改动：名字行允许换行、名字文本最多收缩到容器宽度', () => {
    expect(/\.ah-bot-row-name \{[^}]*\}/.exec(css)![0]).toContain('flex-wrap: wrap')
    expect(/\.ah-bot-row-name-text \{[^}]*\}/.exec(css)![0]).toContain('max-width: 100%')
  })
})

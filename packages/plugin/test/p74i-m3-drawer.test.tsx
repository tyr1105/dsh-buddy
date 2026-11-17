/**
 * P74i-m3 第 2 节的测试：「查看状态」抽屉开着时点「编辑员工」，先收起抽屉再打开编辑弹窗。
 *
 * 原因（读代码得出）：窄屏下右栏是抽屉，useDrawerFocus 把 .ah-body 里除抽屉面板和遮罩之外的
 * 全部子节点设为不可操作；编辑员工弹窗（TeammateEditHost 的遮罩）也是 .ah-body 的子节点，
 * 弹窗一出现就被当成「背景」设为不可操作，所以点不动。
 * 处理：点「编辑员工」时先收起抽屉（setRightOpen(false)）再置位弹窗；抽屉的「背景」判断也
 * 不再把弹窗遮罩算进去（isDrawerBackgroundKid，双重保险）；关掉弹窗后不重新打开抽屉。
 * 其他能从抽屉里打开的弹窗：右栏里只有「编辑员工」一个入口（教它技能、新建员工的弹窗不在 .ah-body 里，
 * 入口也不在抽屉里），所以没有别的同类问题。
 * 测试环境没有真实 DOM，用假节点测判断函数，用 hook 宿主测页面状态（与 p78-edit-entry.test.ts 同做法）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RightPanel } from '../src/client/components/RightPanel.js'
import { TeammateEditHost } from '../src/client/components/teammate-edit-host.js'
import { ThreadPane } from '../src/client/components/ThreadPane.js'
import { createHubStore, type HubStore } from '../src/client/hub-state.js'
import { HubPage } from '../src/client/pages/HubPage.js'
import { fixtureProject } from '../src/shared/fixture-project.js'
import { fixtureBots, fixtureOverview } from '../src/shared/fixtures.js'
import { createHookHost } from './helpers/hook-host.js'
import { findElements } from './helpers/jsx-runtime-stub.js'

vi.mock('react', async () => (await import('./helpers/hook-host.js')).reactFacade)
vi.mock('react-dom', () => ({ createPortal: () => null }))
// 抽屉的真实实现要读 DOM；页面状态测试里用替身（真实的判断函数在下面单独测）。
vi.mock('../src/client/components/use-drawer-focus.js', async importOriginal => {
  const original = await importOriginal<typeof import('../src/client/components/use-drawer-focus.js')>()
  return { ...original, useDrawerFocus: () => ({ panelRef: { current: null } }), isDrawerMode: () => false }
})

beforeEach(() => {
  vi.stubGlobal('fetch', () => new Promise(() => undefined))
  vi.stubGlobal('window', { addEventListener: () => undefined, removeEventListener: () => undefined })
})
afterEach(() => { vi.unstubAllGlobals() })

function loadedHub(): HubStore {
  const hub = createHubStore()
  hub.update(prev => ({ ...prev, overview: fixtureOverview, project: fixtureProject, bots: fixtureBots, selectedThread: 'bot-tanlu', view: 'main' }))
  return hub
}
const pageProps = (hub: HubStore): Parameters<typeof HubPage>[0] => ({ hub, clientCtx: null })

describe('抽屉开着时点「编辑员工」', () => {
  it('抽屉先收起，编辑弹窗打开；弹窗不在任何会被抽屉设为不可操作的区域里', async () => {
    const hub = loadedHub()
    const host = createHookHost()
    // 展开右栏（窄屏时就是抽屉）。
    ;(findElements(host.render(HubPage, pageProps(hub)), ThreadPane)[0]!.props.onExpandRight as () => void)()
    const withDrawer = host.render(HubPage, pageProps(hub))
    expect(findElements(withDrawer, RightPanel)).toHaveLength(1)
    expect(findElements(withDrawer, TeammateEditHost)[0]!.props.open).toBe(false)
    // 抽屉里点「编辑员工」。
    ;(findElements(withDrawer, RightPanel)[0]!.props.onEdit as () => void)()
    const after = host.render(HubPage, pageProps(hub))
    // 抽屉已收起（右栏和遮罩都不在了，没有东西再去设置不可操作）。
    expect(findElements(after, RightPanel)).toEqual([])
    expect(findElements(after, 'div').some(node => String(node.props.className ?? '') === 'ah-right-scrim')).toBe(false)
    // 编辑弹窗打开。
    expect(findElements(after, TeammateEditHost)[0]!.props.open).toBe(true)
  })

  it('关掉弹窗后不自动重新打开抽屉', () => {
    const hub = loadedHub()
    const host = createHookHost()
    ;(findElements(host.render(HubPage, pageProps(hub)), ThreadPane)[0]!.props.onExpandRight as () => void)()
    ;(findElements(host.render(HubPage, pageProps(hub)), RightPanel)[0]!.props.onEdit as () => void)()
    const opened = host.render(HubPage, pageProps(hub))
    ;(findElements(opened, TeammateEditHost)[0]!.props.onClose as () => void)()
    const closed = host.render(HubPage, pageProps(hub))
    expect(findElements(closed, TeammateEditHost)[0]!.props.open).toBe(false)
    expect(findElements(closed, RightPanel)).toEqual([])
  })
})

describe('isDrawerBackgroundKid：抽屉的背景判断不含弹窗遮罩', () => {
  const kid = (...names: string[]) => ({ classList: { contains: (name: string) => names.includes(name) } })

  it('普通背景内容（线程、队友列表）算背景，会被设为不可操作', async () => {
    const { isDrawerBackgroundKid } = await import('../src/client/components/use-drawer-focus.js')
    expect(isDrawerBackgroundKid(kid('ah-thread'), false)).toBe(true)
  })

  it('弹窗遮罩（编辑员工弹窗）不算背景', async () => {
    const { isDrawerBackgroundKid } = await import('../src/client/components/use-drawer-focus.js')
    expect(isDrawerBackgroundKid(kid('ah-dialog-mask'), false)).toBe(false)
  })

  it('抽屉面板自己和抽屉的遮罩也不算背景', async () => {
    const { isDrawerBackgroundKid } = await import('../src/client/components/use-drawer-focus.js')
    expect(isDrawerBackgroundKid(kid('ah-right'), true)).toBe(false)
    expect(isDrawerBackgroundKid(kid('ah-right-scrim'), false)).toBe(false)
  })
})

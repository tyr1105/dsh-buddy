/**
 * 选中的队友已不存在时的接线（看板 P58）：规则和仓库都对，接线丢了问题照样回来。
 * - 真实的 HubPage（hook 宿主跑）：什么时候拉对话、退出后页面状态有没有归位；
 * - 真实的 apply 入口：本地记住的选中有没有被写回。
 * P71：团队全景下线，「退回」的落点从团队线程改成办公室（选中清空）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHubStore, type HubStore } from '../src/client/hub-state.js'
import { InboxPane } from '../src/client/components/InboxPane.js'
import { ThreadPane } from '../src/client/components/ThreadPane.js'
import { apply } from '../src/client/index.js'
import { spaceSurfaceStorageKey } from '../src/client/logic/mode-nav.js'
import { HubPage } from '../src/client/pages/HubPage.js'
import { OfficeReplayPage } from '../src/client/pages/office-replay-page.js'
import { DisabledHub } from '../src/host/real-hub.js'
import { fixtureProject } from '../src/shared/fixture-project.js'
import { createHookHost, type HookHost } from './helpers/hook-host.js'
import { findElements } from './helpers/jsx-runtime-stub.js'
import { fakeRosterBackend, settle } from './helpers/fake-roster-backend.js'

// 把 react 换成 hook 宿主的替身；react-dom 只要 import 不断，这里不渲染门户。
vi.mock('react', async () => (await import('./helpers/hook-host.js')).reactFacade)
vi.mock('react-dom', () => ({ createPortal: () => null }))

/** 手动控制的假推送连接：open() 相当于连上，生产里这时会补拉当前选中。 */
class FakeEventSource {
  static instances: FakeEventSource[] = []
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor() { FakeEventSource.instances.push(this) }
  addEventListener(): void { /* 这组测试不发 changed 事件 */ }
  close(): void { /* 不需要 */ }
  open(): void { this.onopen?.() }
}

beforeEach(() => {
  FakeEventSource.instances = []
  vi.stubGlobal('EventSource', FakeEventSource)
  // 中心页挂载时要监听快捷键；测试环境没有浏览器，给两个空函数就够。
  vi.stubGlobal('window', { addEventListener: () => undefined, removeEventListener: () => undefined })
})
afterEach(() => { vi.unstubAllGlobals() })

function pageProps(hub: HubStore): Parameters<typeof HubPage>[0] {
  return { hub, clientCtx: null }
}

/** 取当前渲染出的线程页；项目页等其他视图下取不到。 */
function threadPaneOf(host: HookHost, hub: HubStore) {
  return findElements(host.render(HubPage, pageProps(hub)), ThreadPane)[0]
}

/** 当前是不是摆着办公室（P71 的默认落点）。 */
function showsOffice(host: HookHost, hub: HubStore): boolean {
  return findElements(host.render(HubPage, pageProps(hub)), OfficeReplayPage).length === 1
}

/** 后端收到的全部线程请求（不分 id）。 */
function threadCalls(backend: ReturnType<typeof fakeRosterBackend>): string[] {
  return backend.calls.filter(path => path.startsWith('thread'))
}

describe('HubPage：什么时候按 id 拉对话', () => {
  it('恢复的 id 已不存在：名册到手前不拉，到手后落到办公室，一条线程都不拉', async () => {
    const backend = fakeRosterBackend(['b_1'])
    backend.pauseOverview = true
    const hub = createHubStore()
    hub.update(prev => ({ ...prev, view: 'main', selectedThread: 'b_gone' }))
    const host = createHookHost()
    host.render(HubPage, pageProps(hub))
    await settle()
    expect(backend.byId('thread', 'b_gone')).toEqual([])

    backend.pauseOverview = false
    backend.releaseOverviews()
    await settle()
    const pane = threadPaneOf(host, hub)
    await settle()
    expect(pane).toBeUndefined()
    expect(showsOffice(host, hub)).toBe(true)
    expect(hub.getSnapshot().selectedThread).toBe('')
    expect(threadCalls(backend)).toEqual([])
  })

  it('反例：恢复的 id 还在名册里，名册到手后拉它的对话和详情', async () => {
    const backend = fakeRosterBackend(['b_1'])
    const hub = createHubStore()
    hub.update(prev => ({ ...prev, view: 'main', selectedThread: 'b_1' }))
    const host = createHookHost()
    host.render(HubPage, pageProps(hub))
    await settle()
    host.render(HubPage, pageProps(hub))
    await settle()
    expect(hub.getSnapshot().selectedThread).toBe('b_1')
    expect(backend.byId('thread', 'b_1').length).toBeGreaterThan(0)
    expect(backend.byId('bot', 'b_1').length).toBeGreaterThan(0)
  })

  it('断线重连且数据被清空：新名册回来之前，页面不抢先按旧 id 拉详情', async () => {
    const backend = fakeRosterBackend(['b_1'])
    const hub = createHubStore()
    await hub.refreshOverview()
    await hub.refreshBot('b_1')
    hub.selectThread('b_1')
    await settle()
    const host = createHookHost()
    host.render(HubPage, pageProps(hub))
    await settle()
    backend.calls.length = 0

    backend.roster = []
    backend.pauseOverview = true
    hub.onReconnected()
    // 真实 React 里，仓库一变页面就重新渲染，这一刻新名册还没回来。
    host.render(HubPage, pageProps(hub))
    await settle()
    expect(backend.byId('bot', 'b_1')).toEqual([])

    backend.pauseOverview = false
    backend.releaseOverviews()
    await settle()
    host.render(HubPage, pageProps(hub))
    await settle()
    expect(backend.byId('bot', 'b_1')).toEqual([])
    expect(hub.getSnapshot().selectedThread).toBe('')
  })

  it('P71：刚打开、什么都没选时落在办公室，不拉团队线程，也不拉任何线程', async () => {
    const backend = fakeRosterBackend(['b_1'])
    const hub = createHubStore()
    const host = createHookHost()
    expect(showsOffice(host, hub)).toBe(true)
    await settle()
    expect(showsOffice(host, hub)).toBe(true)
    expect(threadPaneOf(host, hub)).toBeUndefined()
    expect(threadCalls(backend)).toEqual([])
  })
})

describe('HubPage：退出后页面状态归位', () => {
  it('从待你处理进来的对话被删：退到办公室，回程钮不会留到下一次对话上', async () => {
    const backend = fakeRosterBackend(['b_1'])
    const hub = createHubStore()
    await hub.refreshOverview()
    const host = createHookHost()
    hub.setView('inbox')
    const inbox = findElements(host.render(HubPage, pageProps(hub)), InboxPane)[0]!
    ;(inbox.props.onOpenThread as (id: string) => void)('b_1')
    expect(threadPaneOf(host, hub)?.props.fromInbox).toBe(true)

    backend.roster = []
    await hub.refreshOverview()
    expect(threadPaneOf(host, hub)).toBeUndefined()
    expect(showsOffice(host, hub)).toBe(true)

    backend.roster = [{ id: 'b_1', lifecycle: 'active' }]
    await hub.refreshOverview()
    hub.selectThread('b_1')
    expect(threadPaneOf(host, hub)?.props.fromInbox).toBe(false)
  })

  it('反例：主人点旧的团队入口不算自动退出，直接落到办公室（P71）', async () => {
    fakeRosterBackend(['b_1'])
    const hub = createHubStore()
    await hub.refreshOverview()
    const host = createHookHost()
    threadPaneOf(host, hub)
    hub.selectThread('b_1')
    threadPaneOf(host, hub)
    hub.selectThread('team')
    expect(hub.getSnapshot().selectionExitSeq).toBe(0)
    expect(threadPaneOf(host, hub)).toBeUndefined()
    expect(showsOffice(host, hub)).toBe(true)
  })

  it('页面没挂载时发生过退出：之后挂载不会盖掉新选的线程', async () => {
    const backend = fakeRosterBackend(['b_1'])
    const hub = createHubStore()
    await hub.refreshOverview()
    backend.roster = []
    hub.selectThread('b_1')
    await settle()
    expect(hub.getSnapshot().selectionExitSeq).toBe(1)

    backend.roster = [{ id: 'b_1', lifecycle: 'active' }]
    await hub.refreshOverview()
    hub.selectThread('b_1')
    expect(threadPaneOf(createHookHost(), hub)?.props.threadId).toBe('b_1')
  })
})

describe('HubPage：项目主题（P63）', () => {
  it('本地记住的主题重启后恢复：拉楼层，不拉 /bot，页面按主题模式画', async () => {
    const backend = fakeRosterBackend(['b_1'])
    backend.projectOverride = fixtureProject
    const hub = createHubStore()
    hub.update(prev => ({ ...prev, view: 'main', selectedThread: 'ptp_weekly_price' }))
    const host = createHookHost()
    host.render(HubPage, pageProps(hub))
    await settle()
    const pane = threadPaneOf(host, hub)
    await settle()
    expect(hub.getSnapshot().selectedThread).toBe('ptp_weekly_price')
    expect(backend.byId('thread', 'ptp_weekly_price').length).toBeGreaterThan(0)
    expect(backend.byId('bot', 'ptp_weekly_price')).toEqual([])
    expect((pane?.props.topic as { projectName: string }).projectName).toBe('竞品周报自动化')
  })

  it('本地记住的主题已经没了：项目视图到手后回办公室（P71 前是团队全景）', async () => {
    const backend = fakeRosterBackend(['b_1'])
    backend.projectOverride = fixtureProject
    const hub = createHubStore()
    hub.update(prev => ({ ...prev, view: 'main', selectedThread: 'ptp_gone' }))
    const host = createHookHost()
    host.render(HubPage, pageProps(hub))
    await settle()
    expect(threadPaneOf(host, hub)).toBeUndefined()
    expect(showsOffice(host, hub)).toBe(true)
  })

  it('页面摆出有未读的主题才标已读；未读清零后不再发', async () => {
    const backend = fakeRosterBackend(['b_1'])
    backend.projectOverride = fixtureProject
    const hub = createHubStore()
    await Promise.all([hub.refreshOverview(), hub.refreshProject()])
    hub.selectThread('ptp_weekly_sources')
    backend.calls.length = 0
    const host = createHookHost()
    host.render(HubPage, pageProps(hub))
    await settle()
    // P76k：挂载时还会发一条 ownerSeen，这里只数「标已读」。
    expect(backend.commands.filter(name => name === 'markThreadRead')).toHaveLength(1)
  })

  it('反例：没有未读就不发标已读', async () => {
    const backend = fakeRosterBackend(['b_1'])
    backend.projectOverride = fixtureProject
    const hub = createHubStore()
    await Promise.all([hub.refreshOverview(), hub.refreshProject()])
    hub.selectThread('ptp_weekly_price')
    backend.calls.length = 0
    const host = createHookHost()
    host.render(HubPage, pageProps(hub))
    await settle()
    // P76k：挂载时的那条 ownerSeen 不算「标已读」。
    expect(backend.commands.filter(name => name === 'markThreadRead')).toEqual([])
  })

  it('主题页没有右侧边栏，也没有展开入口', async () => {
    const backend = fakeRosterBackend(['b_1'])
    backend.projectOverride = fixtureProject
    const hub = createHubStore()
    await Promise.all([hub.refreshOverview(), hub.refreshProject()])
    hub.selectThread('ptp_weekly_price')
    expect(threadPaneOf(createHookHost(), hub)?.props.rightCollapsed).toBe(false)
  })
})

describe('apply 入口：本地记住的选中', () => {
  /** 假的浏览器本地存储：测试读写同一份。 */
  function seedSurface(view: string, threadId: string): Map<string, string> {
    const data = new Map([[spaceSurfaceStorageKey, JSON.stringify({ view, threadId })]])
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => { data.set(key, value) },
    })
    return data
  }
  const surfaceOf = (data: Map<string, string>): unknown => JSON.parse(data.get(spaceSurfaceStorageKey) ?? 'null')

  /**
   * 假宿主：只执行 apply 登记的 effect，不做其他事。
   * 需要真实 DOM 的 effect（插样式）在测试环境里会抛错，这里吞掉；它们不属于本测试。
   */
  function fakeHostContext(): Parameters<typeof apply>[0] {
    return {
      get: () => undefined,
      effect: (setup: () => unknown) => { try { setup() } catch { /* 需要真实 DOM 的 effect 跳过 */ } },
      on: () => undefined,
      inject: () => undefined,
      slots: { inject: () => undefined, register: () => () => undefined },
    }
  }

  it('记住的队友已不存在：写回办公室、没有选中（P71 前写回团队线程），全程不按这个 id 请求', async () => {
    const backend = fakeRosterBackend(['b_1'])
    const data = seedSurface('main', 'b_gone')
    apply(fakeHostContext())
    FakeEventSource.instances[0]?.open()
    await settle()
    expect(surfaceOf(data)).toEqual({ view: 'office', threadId: '' })
    expect(backend.byId('bot', 'b_gone')).toEqual([])
    expect(backend.byId('thread', 'b_gone')).toEqual([])
  })

  it('停在项目页时只改记住的线程，页面不动', async () => {
    fakeRosterBackend(['b_1'])
    const data = seedSurface('project', 'b_gone')
    apply(fakeHostContext())
    await settle()
    expect(surfaceOf(data)).toEqual({ view: 'project', threadId: '' })
  })

  it('P71 旧数据：本地记着团队全景，打开后落到办公室，不请求团队线程', async () => {
    const backend = fakeRosterBackend(['b_1'])
    const data = seedSurface('main', 'team')
    apply(fakeHostContext())
    FakeEventSource.instances[0]?.open()
    await settle()
    expect(surfaceOf(data)).toEqual({ view: 'office', threadId: '' })
    expect(threadCalls(backend)).toEqual([])
  })

  it('P71 旧数据：本地记着团队线程但停在设置页，设置页照常恢复', async () => {
    fakeRosterBackend(['b_1'])
    const data = seedSurface('settings', 'team')
    apply(fakeHostContext())
    await settle()
    expect(surfaceOf(data)).toEqual({ view: 'settings', threadId: '' })
  })

  it('反例：记住的队友还在，本地记忆不动', async () => {
    fakeRosterBackend(['b_1'])
    const data = seedSurface('main', 'b_1')
    apply(fakeHostContext())
    await settle()
    expect(surfaceOf(data)).toEqual({ view: 'main', threadId: 'b_1' })
  })

  it('反例：引擎还没起来，本地记忆不动', async () => {
    const backend = fakeRosterBackend(['b_1'])
    backend.overviewFailure = '中心引擎尚未就绪，请稍后重试'
    const data = seedSurface('main', 'b_gone')
    apply(fakeHostContext())
    await settle()
    expect(surfaceOf(data)).toEqual({ view: 'main', threadId: 'b_gone' })
  })

  it('反例：网络断开，本地记忆不动', async () => {
    const backend = fakeRosterBackend(['b_1'])
    backend.offline = true
    const data = seedSurface('main', 'b_gone')
    apply(fakeHostContext())
    await settle()
    expect(surfaceOf(data)).toEqual({ view: 'main', threadId: 'b_gone' })
  })

  it('反例：中心已停用，占位名册不能把本地记忆清掉', async () => {
    const backend = fakeRosterBackend(['b_1'])
    backend.overviewOverride = await new DisabledHub('中心已停用').overview()
    const data = seedSurface('main', 'b_1')
    apply(fakeHostContext())
    await settle()
    expect(surfaceOf(data)).toEqual({ view: 'main', threadId: 'b_1' })
  })
})

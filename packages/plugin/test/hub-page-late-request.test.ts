/**
 * 左栏加号早于中心页挂载的回归测试（P53）。
 *
 * 事故：页面刚加载时左栏已经是队友模式，中栏却还停在对话页，中心页（HubPage）没有挂载。
 * 这时点左栏「＋」，切面板和写请求发生在同一次点击里，请求比中心页挂载早。
 * 中心页原来用 useRef 记住「挂载时的计数」当起点，把这次请求当成了历史，于是只切了页面，弹窗不出现。
 *
 * 修法：请求由中心页消费后清零，和 sessionOpen 同一个模式。
 * 这里用真实的 HubPage 和真实的仓库跑，只把 react 换成 hook 宿主，
 * 三种时机都要对：挂载前点、挂载后点、处理完再回来。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHubStore, type HubStore } from '../src/client/hub-state.js'
import { NewBotWizard } from '../src/client/components/NewBotWizard.js'
import { HubPage } from '../src/client/pages/HubPage.js'
import { ProjectPage } from '../src/client/pages/ProjectPage.js'
import { fixtureOverview } from '../src/shared/fixtures.js'
import { createHookHost } from './helpers/hook-host.js'
import { findElements } from './helpers/jsx-runtime-stub.js'

// 把 react 换成 hook 宿主的替身；HubPage 里的 hook 都会走到这里。
vi.mock('react', async () => (await import('./helpers/hook-host.js')).reactFacade)

/** 建一个已经读到总览的仓库：左栏要读到总览才会显示，所以点加号时总览一定在。 */
function loadedHub(): HubStore {
  const hub = createHubStore()
  hub.update(prev => ({ ...prev, overview: fixtureOverview }))
  return hub
}

function pageProps(hub: HubStore): Parameters<typeof HubPage>[0] {
  return { hub, clientCtx: null }
}

beforeEach(() => {
  // 中心页挂载时会拉数据，这里的断言用不到结果：永远等待，也不产生网络访问。
  vi.stubGlobal('fetch', () => new Promise(() => undefined))
  // 中心页挂载时要监听快捷键；测试环境没有浏览器，给两个空函数就够。
  vi.stubGlobal('window', { addEventListener: () => undefined, removeEventListener: () => undefined })
})
afterEach(() => { vi.unstubAllGlobals() })

describe('新建队友加号', () => {
  it('中心页还没挂载时点加号：挂载后打开向导，请求清零', () => {
    const hub = loadedHub()
    hub.requestNewBot()
    const tree = createHookHost().render(HubPage, pageProps(hub))
    expect(findElements(tree, NewBotWizard)).toHaveLength(1)
    expect(hub.getSnapshot().newBotRequest).toBe(0)
  })

  it('处理过的请求：离开再回来不会把向导又弹出来', () => {
    const hub = loadedHub()
    hub.requestNewBot()
    createHookHost().render(HubPage, pageProps(hub))
    // 换一个宿主等于重新挂载一次中心页。
    const remounted = createHookHost().render(HubPage, pageProps(hub))
    expect(findElements(remounted, NewBotWizard)).toHaveLength(0)
  })

  it('没有点加号：挂载后不打开', () => {
    const tree = createHookHost().render(HubPage, pageProps(loadedHub()))
    expect(findElements(tree, NewBotWizard)).toHaveLength(0)
  })

  it('中心页已挂载时点加号：每点一次都打开，关掉后再点还能打开', () => {
    const hub = loadedHub()
    const host = createHookHost()
    expect(findElements(host.render(HubPage, pageProps(hub)), NewBotWizard)).toHaveLength(0)

    hub.requestNewBot()
    const opened = findElements(host.render(HubPage, pageProps(hub)), NewBotWizard)
    expect(opened).toHaveLength(1)

    // 走真实的关闭回调，确认「关掉之后」这个状态下一次点击不会被漏掉。
    ;(opened[0]?.props.onClose as () => void)()
    expect(findElements(host.render(HubPage, pageProps(hub)), NewBotWizard)).toHaveLength(0)

    hub.requestNewBot()
    expect(findElements(host.render(HubPage, pageProps(hub)), NewBotWizard)).toHaveLength(1)
  })
})

describe('新建项目加号', () => {
  /** 和左栏点击时的顺序一致：先切到项目页，再发打开表单的请求。 */
  function requestNewProject(hub: HubStore): void {
    hub.setView('project')
    hub.requestNewProject()
  }

  it('中心页还没挂载时点加号：挂载后项目页收到打开表单的请求，请求清零', () => {
    const hub = loadedHub()
    requestNewProject(hub)
    const tree = createHookHost().render(HubPage, pageProps(hub))
    expect(findElements(tree, ProjectPage)[0]?.props.openNewProject).toBe(true)
    expect(hub.getSnapshot().newProjectRequest).toBe(0)
  })

  it('处理过的请求：离开再回来不会把表单又弹出来', () => {
    const hub = loadedHub()
    requestNewProject(hub)
    createHookHost().render(HubPage, pageProps(hub))
    const remounted = createHookHost().render(HubPage, pageProps(hub))
    expect(findElements(remounted, ProjectPage)[0]?.props.openNewProject).toBe(false)
  })

  it('中心页已挂载时点加号：表单打开后归位，再点还能打开', () => {
    const hub = loadedHub()
    hub.setView('project')
    const host = createHookHost()
    expect(findElements(host.render(HubPage, pageProps(hub)), ProjectPage)[0]?.props.openNewProject).toBe(false)

    hub.requestNewProject()
    const page = findElements(host.render(HubPage, pageProps(hub)), ProjectPage)[0]
    expect(page?.props.openNewProject).toBe(true)

    // 项目页打开表单后会回调父层；归位之后下一次点击才看得出变化。
    ;(page?.props.onNewProjectOpened as () => void)()
    expect(findElements(host.render(HubPage, pageProps(hub)), ProjectPage)[0]?.props.openNewProject).toBe(false)

    hub.requestNewProject()
    expect(findElements(host.render(HubPage, pageProps(hub)), ProjectPage)[0]?.props.openNewProject).toBe(true)
  })
})

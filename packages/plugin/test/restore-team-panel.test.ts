/**
 * 启动后把中栏选回队友页的回归测试（看板 P56 / I18）。
 *
 * 事故：中栏选中哪一页只记在宿主内存里，页面刷新、DSH 重启、界面被热替换时都会退回对话页；
 * 左栏的模式是插件存在本地的，不会变。于是左栏还是队友，中栏却自己跳回了对话。
 *
 * 这里分两层测：
 * 1. 规则本身（什么时候选、什么时候不选、没就绪时怎么等）；
 * 2. 真实的 apply 入口接上假宿主，防止规则还在、但接线被改丢。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/client/index.js'
import { spaceModeStorageKey } from '../src/client/logic/mode-nav.js'
import { createTeamPanelRestore, type TeamPanelRestorePort } from '../src/client/logic/restore-team-panel.js'
import type { SpaceMode } from '../src/client/logic/space-capability.js'

// apply 里引用的组件会 import react 和 react-dom。这里不渲染组件，只要 import 不断：
// react 用已有的 hook 宿主替身（里面有组件基类），react-dom 给一个空实现。
vi.mock('react', async () => (await import('./helpers/hook-host.js')).reactFacade)
vi.mock('react-dom', () => ({ createPortal: () => null }))

/** 等排队的微任务跑完：attempt 把真正的动作放在微任务里。 */
const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

/** 规则层用的假端口：默认是队友模式、中栏没选中功能页、选页面能成功。 */
function fakePort(overrides: Partial<TeamPanelRestorePort> = {}): TeamPanelRestorePort & { selected: () => number } {
  let selected = 0
  return {
    getMode: () => 'team',
    getActivePanel: () => null,
    selectTeamPanel: () => { selected += 1 },
    ...overrides,
    selected: () => selected,
  }
}

describe('把中栏选回队友页的规则', () => {
  it('队友模式：选一次，后面再来信号也不重复选', async () => {
    const port = fakePort()
    const restore = createTeamPanelRestore(port)
    restore.attempt()
    restore.attempt()
    await flushMicrotasks()
    restore.attempt()
    await flushMicrotasks()
    expect(port.selected()).toBe(1)
  })

  it('对话模式：不选', async () => {
    const port = fakePort({ getMode: () => 'chat' })
    const restore = createTeamPanelRestore(port)
    restore.attempt()
    await flushMicrotasks()
    expect(port.selected()).toBe(0)
  })

  it('页面还没就绪：宿主抛错不外溢，下一个信号再试并成功', async () => {
    let ready = false
    let selected = 0
    const restore = createTeamPanelRestore(fakePort({
      selectTeamPanel: () => {
        if (!ready) throw new Error('main panel "agent-hub" is not registered')
        selected += 1
      },
    }))
    restore.attempt()
    await flushMicrotasks()
    expect(selected).toBe(0)
    ready = true
    restore.attempt()
    await flushMicrotasks()
    expect(selected).toBe(1)
  })

  it('等待期间主人切回了对话：不再选，读的是最新模式', async () => {
    let mode: SpaceMode = 'team'
    let ready = false
    let selected = 0
    const restore = createTeamPanelRestore(fakePort({
      getMode: () => mode,
      selectTeamPanel: () => {
        if (!ready) throw new Error('not registered')
        selected += 1
      },
    }))
    restore.attempt()
    await flushMicrotasks()
    mode = 'chat'
    ready = true
    restore.attempt()
    await flushMicrotasks()
    expect(selected).toBe(0)
  })

  it('中栏停在别的功能页：不抢', async () => {
    const port = fakePort({ getActivePanel: () => 'plugins' })
    const restore = createTeamPanelRestore(port)
    restore.attempt()
    await flushMicrotasks()
    expect(port.selected()).toBe(0)
  })

  it('中栏已经是队友页：不重复选', async () => {
    const port = fakePort({ getActivePanel: () => 'agent-hub' })
    const restore = createTeamPanelRestore(port)
    restore.attempt()
    await flushMicrotasks()
    expect(port.selected()).toBe(0)
  })

  it('宿主不提供当前页信息：仍然选回队友页', async () => {
    const port = fakePort({ getActivePanel: () => undefined })
    const restore = createTeamPanelRestore(port)
    restore.attempt()
    await flushMicrotasks()
    expect(port.selected()).toBe(1)
  })

  it('插件已卸载：排队中的尝试作废，之后的信号也不处理', async () => {
    const port = fakePort()
    const restore = createTeamPanelRestore(port)
    restore.attempt()
    restore.dispose()
    restore.attempt()
    await flushMicrotasks()
    expect(port.selected()).toBe(0)
  })
})

/**
 * 假宿主：只实现 apply 用到的部分。
 * - 选页面时和真实宿主一样：页面没注册就抛错；
 * - 布局服务、中栏插槽可以分别晚到，用来模拟冷启动。
 */
function fakeHost(options: { layoutLate?: boolean; mainLate?: boolean; activePanel?: string | null } = {}) {
  const selections: Array<string | null> = []
  const registered = new Set<string>()
  const disposers: Array<() => void> = []
  let layoutReady = options.layoutLate !== true
  let mainDeclared = options.mainLate !== true
  let onLayoutReady: (() => void) | undefined
  let onMainDeclared: (() => unknown) | undefined

  const layout = {
    selectPanel(key: string | null): void {
      if (key !== null && !registered.has(key)) throw new Error(`main panel "${key}" is not registered`)
      selections.push(key)
    },
    panelInfo: { getSnapshot: () => ({ activePanelId: options.activePanel ?? null }) },
  }
  const ctx = {
    get: (name: string) => (name === 'layout' && layoutReady ? layout : undefined),
    // 这里只运行恢复逻辑的清理登记；样式、推送、DOM 挂载这些不属于本测试。
    effect: (setup: () => () => void, label: string) => {
      if (label === 'dsh-buddy: restore-team-panel') disposers.push(setup())
    },
    on: () => undefined,
    inject: (deps: string[], callback: () => void) => {
      if (!deps.includes('layout')) return
      if (layoutReady) callback()
      else onLayoutReady = callback
    },
    slots: {
      inject: (name: string, callback: () => unknown) => {
        if (name !== 'main' || mainDeclared) callback()
        else onMainDeclared = callback
      },
      register: (definition: { name: string; key?: string }) => {
        if (definition.name === 'main' && definition.key) registered.add(definition.key)
        return () => { if (definition.key) registered.delete(definition.key) }
      },
    },
  }
  return {
    ctx,
    selections,
    dispose: () => { disposers.splice(0).forEach(dispose => dispose()) },
    /** 模拟界面被替换：旧界面的页面注册消失。 */
    unregisterMain: () => { registered.clear() },
    layoutBecomesReady: () => { layoutReady = true; onLayoutReady?.() },
    mainBecomesDeclared: () => { mainDeclared = true; onMainDeclared?.() },
  }
}

/** 把左栏模式写进假的本地存储：apply 启动时从这里读。 */
function storeSpaceMode(mode: SpaceMode): void {
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => (key === spaceModeStorageKey ? mode : null),
    setItem: () => undefined,
  })
}

describe('apply 入口接线', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('队友模式启动：中栏选回队友页', async () => {
    storeSpaceMode('team')
    const host = fakeHost()
    apply(host.ctx)
    await flushMicrotasks()
    expect(host.selections).toEqual(['agent-hub'])
  })

  it('对话模式启动：不动中栏', async () => {
    storeSpaceMode('chat')
    const host = fakeHost()
    apply(host.ctx)
    await flushMicrotasks()
    expect(host.selections).toEqual([])
  })

  it('冷启动时布局服务晚到：就绪后才选', async () => {
    storeSpaceMode('team')
    const host = fakeHost({ layoutLate: true })
    apply(host.ctx)
    await flushMicrotasks()
    expect(host.selections).toEqual([])
    host.layoutBecomesReady()
    await flushMicrotasks()
    expect(host.selections).toEqual(['agent-hub'])
  })

  it('冷启动时中栏插槽晚到：页面注册后才选', async () => {
    storeSpaceMode('team')
    const host = fakeHost({ mainLate: true })
    apply(host.ctx)
    await flushMicrotasks()
    expect(host.selections).toEqual([])
    host.mainBecomesDeclared()
    await flushMicrotasks()
    expect(host.selections).toEqual(['agent-hub'])
  })

  it('中栏停在插件管理页时界面被替换：不抢', async () => {
    storeSpaceMode('team')
    const host = fakeHost({ activePanel: 'plugins' })
    apply(host.ctx)
    await flushMicrotasks()
    expect(host.selections).toEqual([])
  })

  it('界面被替换：旧实例卸载后，新实例再选回来一次', async () => {
    storeSpaceMode('team')
    const host = fakeHost()
    apply(host.ctx)
    await flushMicrotasks()
    host.dispose()
    host.unregisterMain()
    apply(host.ctx)
    await flushMicrotasks()
    expect(host.selections).toEqual(['agent-hub', 'agent-hub'])
  })
})

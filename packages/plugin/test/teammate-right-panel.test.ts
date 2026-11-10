/**
 * 点队友直接进对话、右侧边栏三块内容、编辑队友弹窗的接线测试（P64）。
 *
 * 为什么用 hook 宿主跑真实组件：这张卡的风险都在接线上——展开入口有没有、
 * 旧的「为什么醒」入口点了去哪、切线程后回程钮和任务条会不会留在错的地方，
 * 纯函数测不到。子组件不会被执行，这里检查的是「这一层组件交给下一层什么」。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHubStore, type HubStore } from '../src/client/hub-state.js'
import { ActivityPane } from '../src/client/components/ActivityPane.js'
import { BotConfigFields } from '../src/client/components/bot-config-fields.js'
import { CommandPalette } from '../src/client/components/command-palette.js'
import { InboxPane } from '../src/client/components/InboxPane.js'
import { RightPanel } from '../src/client/components/RightPanel.js'
import { TeammateEditDialog } from '../src/client/components/TeammateEditDialog.js'
import { ThreadPane } from '../src/client/components/ThreadPane.js'
import { Dot, Skeleton } from '../src/client/components/Ui.js'
import { WorkSessionRow } from '../src/client/components/work-session-row.js'
import { exitMissingSelection } from '../src/client/logic/missing-teammate.js'
import { collectWorkSessions, sessionsForBot, type WorkSession } from '../src/client/logic/work-session.js'
import { HubPage } from '../src/client/pages/HubPage.js'
import { OfficeReplayPage } from '../src/client/pages/office-replay-page.js'
import { fixtureProject } from '../src/shared/fixture-project.js'
import { fixtureBots, fixtureOverview } from '../src/shared/fixtures.js'
import type { BotView, Lifecycle } from '../src/shared/views.js'
import { createHookHost, type HookHost } from './helpers/hook-host.js'
import { findElements, type StubElement } from './helpers/jsx-runtime-stub.js'

// 把 react 换成 hook 宿主的替身；抽屉判断要读真实样式，这里改成可控的开关。
vi.mock('react', async () => (await import('./helpers/hook-host.js')).reactFacade)
vi.mock('react-dom', () => ({ createPortal: () => null }))
const drawer = vi.hoisted(() => ({ on: false }))
vi.mock('../src/client/components/use-drawer-focus.js', () => ({
  useDrawerFocus: () => ({ panelRef: { current: null } }),
  isDrawerMode: () => drawer.on,
}))

/** 按下 ⌘K 的入口：中心页把键盘监听挂在 window 上，这里接住它。 */
let keydown: ((event: unknown) => void) | null = null

beforeEach(() => {
  drawer.on = false
  keydown = null
  // 中心页挂载时会拉数据，这里的断言只看页面状态：永远等待，也不产生网络访问。
  vi.stubGlobal('fetch', () => new Promise(() => undefined))
  vi.stubGlobal('window', {
    addEventListener: (_name: string, handler: (event: unknown) => void) => { keydown = handler },
    removeEventListener: () => undefined,
  })
})
afterEach(() => { vi.unstubAllGlobals() })

/** 建一个数据都到齐、停在某位队友对话上的仓库。 */
function loadedHub(threadId = 'bot-tanlu'): HubStore {
  const hub = createHubStore()
  hub.update(prev => ({ ...prev, overview: fixtureOverview, project: fixtureProject, bots: fixtureBots, selectedThread: threadId }))
  return hub
}

function pageProps(hub: HubStore): Parameters<typeof HubPage>[0] {
  return { hub, clientCtx: null }
}

/** 取当前的线程页元素；不在对话页时取不到。 */
function paneOf(tree: unknown): StubElement {
  const pane = findElements(tree, ThreadPane)[0]
  if (pane === undefined) throw new Error('当前没有渲染线程页')
  return pane
}

function panelsOf(tree: unknown): StubElement[] {
  return findElements(tree, RightPanel)
}

/** 把元素树里的文字拼起来；子组件不展开，所以只有这一层写的文字。 */
function textOf(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object' && node !== null && 'props' in node) return textOf((node as StubElement).props.children)
  return ''
}

/** 打开侧边栏并返回重新渲染后的页面。 */
function openPanel(host: HookHost, hub: HubStore): unknown {
  (paneOf(host.render(HubPage, pageProps(hub))).props.onExpandRight as () => void)()
  return host.render(HubPage, pageProps(hub))
}

describe('点队友直接进对话', () => {
  it('选中队友后中栏就是和它的对话', () => {
    const hub = loadedHub('team')
    const host = createHookHost()
    host.render(HubPage, pageProps(hub))
    hub.selectThread('bot-tanlu')
    const pane = paneOf(host.render(HubPage, pageProps(hub)))
    expect(pane.props.threadId).toBe('bot-tanlu')
    expect((pane.props.header as { name: string }).name).toBe('探路')
  })

  it('团队全景也还是对话，没有侧边栏，也没有展开入口', () => {
    const tree = createHookHost().render(HubPage, pageProps(loadedHub('team')))
    expect(paneOf(tree).props.rightCollapsed).toBe(false)
    expect(panelsOf(tree)).toEqual([])
  })
})

describe('右侧边栏：默认收起，按需展开', () => {
  it('默认收起，对话页给展开入口', () => {
    const tree = createHookHost().render(HubPage, pageProps(loadedHub()))
    expect(paneOf(tree).props.rightCollapsed).toBe(true)
    expect(panelsOf(tree)).toEqual([])
  })

  it('点展开出现侧边栏、入口收起；点收起恢复原样', () => {
    const hub = loadedHub()
    const host = createHookHost()
    const opened = openPanel(host, hub)
    expect(paneOf(opened).props.rightCollapsed).toBe(false)
    const panel = panelsOf(opened)[0]!
    ;(panel.props.onCollapse as () => void)()
    const closed = host.render(HubPage, pageProps(hub))
    expect(panelsOf(closed)).toEqual([])
    expect(paneOf(closed).props.rightCollapsed).toBe(true)
  })

  it('侧边栏拿到的是这位队友的卡片、在办的事和全队额度灯', () => {
    const panel = panelsOf(openPanel(createHookHost(), loadedHub()))[0]!
    expect((panel.props.card as { id: string }).id).toBe('bot-tanlu')
    expect(panel.props.light).toBe(fixtureOverview.quota.light)
    expect((panel.props.sessions as WorkSession[]).map(session => session.id).sort()).toEqual(['pt_weekly_2', 'pt_weekly_5', 'pt_weekly_6'])
  })

  it('项目视图还没到：传 null，由侧边栏显示骨架，不假装没有工作', () => {
    const hub = loadedHub()
    hub.update(prev => ({ ...prev, project: null }))
    expect(panelsOf(openPanel(createHookHost(), hub))[0]!.props.sessions).toBeNull()
  })

  it('队友被删除退回团队全景：侧边栏收起，下次选别人也不会自己打开（P58）', () => {
    const hub = loadedHub()
    const host = createHookHost()
    openPanel(host, hub)
    hub.update(exitMissingSelection)
    expect(panelsOf(host.render(HubPage, pageProps(hub)))).toEqual([])
    hub.selectThread('bot-xunjian')
    const tree = host.render(HubPage, pageProps(hub))
    expect(panelsOf(tree)).toEqual([])
    expect(paneOf(tree).props.rightCollapsed).toBe(true)
  })
})

describe('事务清单点一行', () => {
  /** 打开侧边栏，点探路名下的某一件事。 */
  function openRow(host: HookHost, hub: HubStore, patch: Partial<WorkSession> = {}): unknown {
    const panel = panelsOf(openPanel(host, hub))[0]!
    const session = (panel.props.sessions as WorkSession[]).find(item => item.id === 'pt_weekly_2')!
    ;(panel.props.onOpenSession as (item: WorkSession) => void)({ ...session, ...patch })
    return host.render(HubPage, pageProps(hub))
  }

  it('这件事有主题：进那条主题聊天', () => {
    const hub = loadedHub()
    const pane = paneOf(openRow(createHookHost(), hub))
    expect(pane.props.threadId).toBe('ptp_weekly_price')
    expect((pane.props.topic as { projectName: string }).projectName).toBe('竞品周报自动化')
  })

  it('反例：老事务没有主题，去它所在的项目页，不是点了没反应', () => {
    const hub = loadedHub()
    openRow(createHookHost(), hub, { topicId: null })
    expect(hub.getSnapshot().view).toBe('project')
    expect(hub.getSnapshot().activeProjectId).toBe('prj_weekly')
  })
})

describe('原来跳「为什么醒」的入口', () => {
  it('办公室点账本：同样落到动态页', () => {
    const hub = loadedHub()
    const host = createHookHost()
    hub.setView('office')
    const page = findElements(host.render(HubPage, pageProps(hub)), OfficeReplayPage)[0]!
    ;(page.props.onOpenBot as (botId: string, wakeId?: string) => void)('bot-xunjian', 'wk_1')
    expect(hub.getSnapshot().view).toBe('activity')
  })

  it('办公室点人或点产物：进和它的对话，侧边栏保持收起', () => {
    for (const args of [['bot-xunjian'], ['bot-xunjian', undefined, 'art_1']] as const) {
      const hub = loadedHub()
      const host = createHookHost()
      hub.setView('office')
      const page = findElements(host.render(HubPage, pageProps(hub)), OfficeReplayPage)[0]!
      ;(page.props.onOpenBot as (...input: typeof args) => void)(...args)
      const tree = host.render(HubPage, pageProps(hub))
      expect(paneOf(tree).props.threadId).toBe('bot-xunjian')
      expect(panelsOf(tree)).toEqual([])
    }
  })

  it('反例：跳转面板进动态页是看全队，上次筛的队友不留着', () => {
    const hub = loadedHub()
    const host = createHookHost()
    hub.setView('office')
    const page = findElements(host.render(HubPage, pageProps(hub)), OfficeReplayPage)[0]!
    ;(page.props.onOpenBot as (botId: string, wakeId?: string) => void)('bot-xunjian', 'wk_1')
    expect(findElements(host.render(HubPage, pageProps(hub)), ActivityPane)[0]!.props.initialBotId).toBe('bot-xunjian')
    keydown?.({ key: 'k', metaKey: true, preventDefault: () => undefined })
    const palette = findElements(host.render(HubPage, pageProps(hub)), CommandPalette)[0]!
    ;(palette.props.onNavigate as (target: string) => void)('activity')
    expect(findElements(host.render(HubPage, pageProps(hub)), ActivityPane)[0]!.props.initialBotId).toBeNull()
  })
})

describe('从「待你处理」进来的回程钮', () => {
  it('显示在那条线程上；宿主侧栏切到别的队友后不再跟着走', () => {
    const hub = loadedHub()
    const host = createHookHost()
    hub.setView('inbox')
    const inbox = findElements(host.render(HubPage, pageProps(hub)), InboxPane)[0]!
    ;(inbox.props.onOpenThread as (id: string) => void)('bot-tanlu')
    expect(paneOf(host.render(HubPage, pageProps(hub))).props.fromInbox).toBe(true)

    hub.selectThread('bot-xunjian')
    expect(paneOf(host.render(HubPage, pageProps(hub))).props.fromInbox).toBe(false)
    // 回到原来那条也不再显示：主人已经离开过了。
    hub.selectThread('bot-tanlu')
    expect(paneOf(host.render(HubPage, pageProps(hub))).props.fromInbox).toBe(false)
  })

  it('反例：普通进入对话没有回程钮', () => {
    expect(paneOf(createHookHost().render(HubPage, pageProps(loadedHub()))).props.fromInbox).toBe(false)
  })
})

describe('RightPanel：只放三块，底部只留编辑队友', () => {
  const tanlu = fixtureBots['bot-tanlu']!
  const sessions = sessionsForBot(collectWorkSessions(fixtureProject), 'bot-tanlu')

  function panelProps(patch: Partial<Parameters<typeof RightPanel>[0]> = {}): Parameters<typeof RightPanel>[0] {
    return {
      card: tanlu.card, detail: tanlu, light: 'green', costs: undefined, sessions,
      onOpenSession: () => undefined, onCollapse: () => undefined, roster: fixtureOverview.bots,
      modelOptions: [], presetSkillOptions: [], dshSkillOptions: [],
      run: async () => ({ ok: true }), onRefresh: () => undefined, ...patch,
    }
  }
  const footButtons = (tree: unknown): StubElement[] => {
    const foot = findElements(tree, 'div').find(node => node.props.className === 'ah-right-actions')!
    return findElements(foot, 'button')
  }

  it('分区正好三块：忙碌状态、额度、在办的事', () => {
    const tree = createHookHost().render(RightPanel, panelProps())
    expect(findElements(tree, 'section').map(node => node.props['aria-label'])).toEqual(['忙碌状态', '额度', '在办的事'])
    expect(findElements(tree, Dot)[0]!.props.label).toBe('正在忙')
    expect(textOf(findElements(tree, 'section')[1])).toContain('今天用了约 6.8 万 token')
  })

  it('反例：档案、目标、产物、为什么醒都不在了', () => {
    const text = textOf(createHookHost().render(RightPanel, panelProps()))
    for (const gone of ['档案', '目标', '产物', '为什么醒', '打开工作会话']) expect(text).not.toContain(gone)
  })

  it('底部只有「编辑队友」一个按钮，点开是编辑弹窗', () => {
    const host = createHookHost()
    const props = panelProps()
    const tree = host.render(RightPanel, props)
    expect(footButtons(tree).map(textOf)).toEqual(['编辑队友'])
    expect(findElements(tree, TeammateEditDialog)).toEqual([])
    ;(footButtons(tree)[0]!.props.onClick as () => void)()
    expect(findElements(host.render(RightPanel, props), TeammateEditDialog)).toHaveLength(1)
  })

  it('反例：详情还没拉到时按钮不可点，也打不开弹窗', () => {
    const tree = createHookHost().render(RightPanel, panelProps({ detail: null }))
    expect(footButtons(tree)[0]!.props.disabled).toBe(true)
  })

  it('有在办的事：按项目分组列出', () => {
    const tree = createHookHost().render(RightPanel, panelProps())
    const rows = findElements(tree, WorkSessionRow)
    expect(rows.map(row => (row.props.session as WorkSession).id)).toEqual(['pt_weekly_2'])
    expect(textOf(tree)).toContain('竞品周报自动化')
  })

  it('反例：没有在办的事写那一句话；项目视图没到显示骨架', () => {
    expect(textOf(createHookHost().render(RightPanel, panelProps({ sessions: [] })))).toContain('现在没有在办的事')
    expect(findElements(createHookHost().render(RightPanel, panelProps({ sessions: null })), Skeleton)).toHaveLength(1)
  })

  it('点一行：宽屏侧边栏留着方便接着看，窄屏抽屉收起露出对话', () => {
    for (const on of [false, true]) {
      drawer.on = on
      const onOpenSession = vi.fn()
      const onCollapse = vi.fn()
      const tree = createHookHost().render(RightPanel, panelProps({ onOpenSession, onCollapse }))
      ;(findElements(tree, WorkSessionRow)[0]!.props.onOpen as (item: WorkSession) => void)(sessions[0]!)
      expect(onOpenSession).toHaveBeenCalledTimes(1)
      expect(onCollapse).toHaveBeenCalledTimes(on ? 1 : 0)
    }
  })
})

describe('TeammateEditDialog：八项表单加生命周期动作', () => {
  const tanlu = fixtureBots['bot-tanlu']!
  /** 换一个生命周期状态的同一位队友。 */
  const withLifecycle = (lifecycle: Lifecycle): BotView => ({ ...tanlu, card: { ...tanlu.card, lifecycle } })

  /** 渲染弹窗；命令默认成功，用 exec 的返回值控制成败。 */
  function setup(bot: BotView = tanlu) {
    const exec = vi.fn(async () => true)
    const onClose = vi.fn()
    const onRefresh = vi.fn()
    const props: Parameters<typeof TeammateEditDialog>[0] = {
      bot, roster: fixtureOverview.bots, modelOptions: [], presetSkillOptions: [], dshSkillOptions: [],
      runner: { busy: false, message: null, success: false, exec, setMessage: () => undefined },
      onRefresh, onClose,
    }
    const host = createHookHost()
    const render = (): StubElement => host.render(TeammateEditDialog, props) as StubElement
    return { render, exec, onClose, onRefresh }
  }
  /** 底部的全部按钮文字。 */
  const labels = (tree: StubElement): string[] => findElements(tree.props.footer, 'button').map(textOf)
  /** 按下底部某个按钮。 */
  const press = (tree: StubElement, label: string): void => {
    (findElements(tree.props.footer, 'button').find(button => textOf(button) === label)!.props.onClick as () => void)()
  }

  it('按当前状态只显示合法的生命周期按钮，保存和取消一直都在', () => {
    expect(labels(setup(withLifecycle('active')).render())).toEqual(['暂停', '退役', '取消', '保存'])
    expect(labels(setup(withLifecycle('paused')).render())).toEqual(['恢复', '退役', '取消', '保存'])
    expect(labels(setup(withLifecycle('probation')).render())).toEqual(['暂停', '转正', '退役', '取消', '保存'])
    expect(labels(setup(withLifecycle('quarantined')).render())).toEqual(['解除停用', '退役', '取消', '保存'])
    expect(labels(setup(withLifecycle('retired')).render())).toEqual(['取消', '保存'])
  })

  it('八项表单在弹窗中间，打开时用这位队友的现状填好', () => {
    const fields = findElements(setup().render(), BotConfigFields)[0]!
    expect((fields.props.draft as { name: string }).name).toBe('探路')
    expect(fields.props.autoFocusName).toBe(true)
  })

  it('暂停：发 lifecycleAction，成功后刷新，弹窗不关', async () => {
    const { render, exec, onRefresh, onClose } = setup(withLifecycle('active'))
    press(render(), '暂停')
    await vi.waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1))
    expect(exec).toHaveBeenCalledWith('lifecycleAction', { botId: 'bot-tanlu', action: 'pause' }, '已暂停。变更记录保留，可恢复。')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('退役要二次确认：第一下只换按钮，确认后才发命令', async () => {
    const { render, exec } = setup(withLifecycle('active'))
    press(render(), '退役')
    expect(exec).not.toHaveBeenCalled()
    const confirming = render()
    expect(labels(confirming)).toEqual(['暂停', '确认退役', '先不退役', '取消', '保存'])
    press(confirming, '确认退役')
    await vi.waitFor(() => expect(exec).toHaveBeenCalledWith('lifecycleAction', { botId: 'bot-tanlu', action: 'retire' }, '已退役。数据保留，可恢复。'))
  })

  it('反例：点「先不退役」回到原样，什么命令都不发', () => {
    const { render, exec } = setup(withLifecycle('active'))
    press(render(), '退役')
    press(render(), '先不退役')
    expect(labels(render())).toEqual(['暂停', '退役', '取消', '保存'])
    expect(exec).not.toHaveBeenCalled()
  })

  it('保存只提交改过的字段，成功后关闭弹窗', async () => {
    const { render, exec, onClose } = setup()
    ;(findElements(render(), BotConfigFields)[0]!.props.onChange as (partial: object) => void)({ name: '探路二号' })
    press(render(), '保存')
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(exec).toHaveBeenCalledWith('updateBot', { botId: 'bot-tanlu', patch: { name: '探路二号' } }, '已保存。下一步：下次唤醒生效。')
  })

  it('反例：什么都没改点保存，不发命令，直接关', async () => {
    const { render, exec, onClose } = setup()
    press(render(), '保存')
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(exec).not.toHaveBeenCalled()
  })

  it('反例：名字和别的队友重复，不发命令也不关，字段上显示原因', async () => {
    const { render, exec, onClose } = setup()
    ;(findElements(render(), BotConfigFields)[0]!.props.onChange as (partial: object) => void)({ name: '总管' })
    press(render(), '保存')
    await Promise.resolve()
    expect(exec).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    expect(findElements(render(), BotConfigFields)[0]!.props.problem).not.toBeNull()
  })

  it('反例：保存失败不关弹窗，改的内容还在', async () => {
    const { render, exec, onClose } = setup()
    exec.mockResolvedValueOnce(false)
    ;(findElements(render(), BotConfigFields)[0]!.props.onChange as (partial: object) => void)({ name: '探路二号' })
    press(render(), '保存')
    await vi.waitFor(() => expect(exec).toHaveBeenCalledTimes(1))
    await Promise.resolve()
    expect(onClose).not.toHaveBeenCalled()
    expect((findElements(render(), BotConfigFields)[0]!.props.draft as { name: string }).name).toBe('探路二号')
  })
})

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
import { PersonalityLines } from '../src/client/components/PersonalityLines.js'
import { Dot, Skeleton } from '../src/client/components/Ui.js'
import { mbtiBehaviorLines } from '@agent-hub/core/team'
import { WorkSessionRow } from '../src/client/components/work-session-row.js'
import { exitMissingSelection } from '../src/client/logic/missing-teammate.js'
import { collectWorkSessions, sessionsForBot, type WorkSession } from '../src/client/logic/work-session.js'
import { HubPage } from '../src/client/pages/HubPage.js'
import { OfficeReplayPage } from '../src/client/pages/office-replay-page.js'
import { fixtureProject } from '../src/shared/fixture-project.js'
import { fixtureBots, fixtureOverview } from '../src/shared/fixtures.js'
import type { ArchiveConfirmInfo } from '../src/client/logic/lifecycle.js'
import type { BotView } from '../src/shared/views.js'
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

/**
 * 建一个数据都到齐、停在某位队友对话上的仓库。
 * P71 起仓库默认落在办公室，这里显式摆到主视图（对话）；传空串表示没有选中任何对话。
 */
function loadedHub(threadId = 'bot-tanlu'): HubStore {
  const hub = createHubStore()
  hub.update(prev => ({ ...prev, overview: fixtureOverview, project: fixtureProject, bots: fixtureBots, selectedThread: threadId, view: 'main' }))
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
    const hub = loadedHub('')
    const host = createHookHost()
    host.render(HubPage, pageProps(hub))
    hub.selectThread('bot-tanlu')
    const pane = paneOf(host.render(HubPage, pageProps(hub)))
    expect(pane.props.threadId).toBe('bot-tanlu')
    expect((pane.props.header as { name: string }).name).toBe('探路')
  })

  it('P71：旧数据停在团队全景时不再摆对话，落到办公室，也没有侧边栏', () => {
    const tree = createHookHost().render(HubPage, pageProps(loadedHub('team')))
    expect(findElements(tree, ThreadPane)).toEqual([])
    expect(findElements(tree, OfficeReplayPage)).toHaveLength(1)
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

  it('队友被删除退回办公室（P71 前是团队全景）：侧边栏收起，下次选别人也不会自己打开（P58）', () => {
    const hub = loadedHub()
    const host = createHookHost()
    openPanel(host, hub)
    hub.update(exitMissingSelection)
    const exited = host.render(HubPage, pageProps(hub))
    expect(panelsOf(exited)).toEqual([])
    expect(findElements(exited, OfficeReplayPage)).toHaveLength(1)
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

describe('RightPanel：状态、性格、模型与额度、在办的事，底部只留编辑员工', () => {
  const tanlu = fixtureBots['bot-tanlu']!
  const sessions = sessionsForBot(collectWorkSessions(fixtureProject), 'bot-tanlu')

  function panelProps(patch: Partial<Parameters<typeof RightPanel>[0]> = {}): Parameters<typeof RightPanel>[0] {
    return {
      card: tanlu.card, detail: tanlu, light: 'green', costs: undefined, sessions,
      onOpenSession: () => undefined, onCollapse: () => undefined,
      onEdit: () => undefined, ...patch,
    }
  }
  const footButtons = (tree: unknown): StubElement[] => {
    const foot = findElements(tree, 'div').find(node => node.props.className === 'ah-right-actions')!
    return findElements(foot, 'button')
  }

  it('P73f：分区是状态、在办的事、性格、模型与额度（P76j 起在办的事排在性格前）；状态行写「在岗　」加忙碌结论', () => {
    const tree = createHookHost().render(RightPanel, panelProps())
    expect(findElements(tree, 'section').map(node => node.props['aria-label'])).toEqual(['状态', '在办的事', '性格', '模型与额度'])
    expect(findElements(tree, Dot)[0]!.props.label).toBe('在岗　正在忙')
    // 没有档位信息时一行里写模型显示名，不猜档位；回合数取队友卡，token 取队友卡（没有成本视图）。
    const modelSection = findElements(tree, 'section').find(node => node.props['aria-label'] === '模型与额度')!
    expect(textOf(modelSection)).toContain('今天约 68K token。')
  })

  it('P73f：模型与额度一行写档位；有档位信息且等于轻档时写「轻档」', () => {
    const tiers = { standard: { provider: 'deepseek-official', model: 'deepseek-pro' }, light: { provider: 'deepseek-official', model: 'deepseek-flash' }, lightAvailable: true }
    const tree = createHookHost().render(RightPanel, panelProps({ tiers }))
    const modelSection = findElements(tree, 'section').find(node => node.props['aria-label'] === '模型与额度')!
    expect(textOf(modelSection)).toContain('轻档。今天约')
  })

  it('P73f：性格一栏有「性格　ISTJ」和四句话，逐字等于 core 的总表', () => {
    const istj: BotView = { ...tanlu, profile: { ...tanlu.profile, mbti: 'ISTJ' } }
    const tree = createHookHost().render(RightPanel, panelProps({ detail: istj }))
    const section = findElements(tree, 'section').find(node => node.props['aria-label'] === '性格')!
    expect(textOf(findElements(section, 'h3')[0])).toBe('性格　ISTJ')
    const lines = findElements(section, PersonalityLines)[0]!.props.lines as Array<{ code: string; text: string }>
    expect(lines).toEqual(mbtiBehaviorLines('ISTJ'))
    expect(lines.map(line => line.text)).toHaveLength(4)
  })

  it('P73f：没有设置性格的旧员工写「性格　未设置」，不画四句话；详情还没拉到时整栏不画', () => {
    const none: BotView = { ...tanlu, profile: { ...tanlu.profile, mbti: null } }
    const section = findElements(createHookHost().render(RightPanel, panelProps({ detail: none })), 'section').find(node => node.props['aria-label'] === '性格')!
    expect(textOf(findElements(section, 'h3')[0])).toBe('性格　未设置')
    expect(findElements(section, PersonalityLines)).toEqual([])
    expect(findElements(createHookHost().render(RightPanel, panelProps({ detail: null })), 'section').map(node => node.props['aria-label'])).not.toContain('性格')
  })

  it('P73f：停用的员工状态行写「停用：原因」；不显示「试岗」「退役」', () => {
    const suspended = { ...tanlu.card, staffStatus: 'suspended' as const, staffStatusLabel: '停用', staffStatusReason: '连续出错，系统已停用：额度保护' }
    const tree = createHookHost().render(RightPanel, panelProps({ card: suspended, detail: { ...tanlu, card: suspended } }))
    expect(findElements(tree, Dot)[0]!.props.label).toBe('停用：连续出错，系统已停用：额度保护')
    const text = textOf(tree)
    for (const word of ['试岗', '退役', '转正']) expect(text).not.toContain(word)
  })

  it('反例：档案、目标、产物、为什么醒都不在了', () => {
    const text = textOf(createHookHost().render(RightPanel, panelProps()))
    for (const gone of ['档案', '目标', '产物', '为什么醒', '打开工作会话']) expect(text).not.toContain(gone)
  })

  it('底部只有「编辑员工」一个按钮；P78 起弹窗在页面层，点它只通知页面（onEdit）', () => {
    const onEdit = vi.fn()
    const tree = createHookHost().render(RightPanel, panelProps({ onEdit }))
    expect(footButtons(tree).map(textOf)).toEqual(['编辑员工'])
    expect(findElements(tree, TeammateEditDialog)).toEqual([])
    ;(footButtons(tree)[0]!.props.onClick as () => void)()
    expect(onEdit).toHaveBeenCalledTimes(1)
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

describe('TeammateEditDialog：状态三选一加八项表单', () => {
  const tanlu = fixtureBots['bot-tanlu']!
  /** 换一个员工状态的同一位员工（P73f：状态读 staffStatus）。 */
  const withStatus = (staffStatus: 'on_duty' | 'suspended' | 'archived', role: BotView['card']['role'] = tanlu.card.role): BotView => ({
    ...tanlu,
    card: { ...tanlu.card, role, staffStatus, staffStatusLabel: { on_duty: '在岗', suspended: '停用', archived: '归档' }[staffStatus] },
  })

  /** 渲染弹窗；命令默认成功，用 exec 的返回值控制成败；archiveCheck 控制归档检查的结果。 */
  function setup(bot: BotView = tanlu, archiveCheck: ArchiveConfirmInfo | string = { canArchive: true, reason: null, memberProjects: [] }) {
    const exec = vi.fn(async () => true)
    const onClose = vi.fn()
    const onRefresh = vi.fn()
    const onCheckArchive = vi.fn(async () => archiveCheck)
    const props: Parameters<typeof TeammateEditDialog>[0] = {
      bot, roster: fixtureOverview.bots, modelOptions: [], presetSkillOptions: [], dshSkillOptions: [],
      runner: { busy: false, message: null, success: false, exec, setMessage: () => undefined },
      onCheckArchive, onRefresh, onClose,
    }
    const host = createHookHost()
    const render = (): StubElement => host.render(TeammateEditDialog, props) as StubElement
    return { render, exec, onClose, onRefresh, onCheckArchive }
  }
  /** 底部的全部按钮文字。 */
  const labels = (tree: StubElement): string[] => findElements(tree.props.footer, 'button').map(textOf)
  /** 按下底部某个按钮。 */
  const press = (tree: StubElement, label: string): void => {
    (findElements(tree.props.footer, 'button').find(button => textOf(button) === label)!.props.onClick as () => void)()
  }
  /** 状态单选组里的按钮（不含归档确认里的按钮）。 */
  const statusGroup = (tree: StubElement): StubElement => findElements(tree.props.children, 'div').find(node => node.props.className === 'ah-choice-row')!
  const statusButtons = (tree: StubElement): StubElement[] => findElements(statusGroup(tree), 'button')
  const pickStatus = (tree: StubElement, label: string): void => {
    (statusButtons(tree).find(button => textOf(button) === label)!.props.onClick as () => void)()
  }
  /** 归档二次确认那一块；没出现时为 undefined。 */
  const confirmBlock = (tree: StubElement): StubElement | undefined => findElements(tree.props.children, 'div').find(node => node.props.className === 'ah-archive-confirm')
  const confirmButtons = (tree: StubElement): StubElement[] => findElements(confirmBlock(tree), 'button')

  it('P73f：底部只有取消和保存；停用、归档等状态按钮都在上面的状态单选组里', () => {
    for (const status of ['on_duty', 'suspended', 'archived'] as const) {
      expect(labels(setup(withStatus(status)).render())).toEqual(['取消', '保存'])
    }
  })

  it('P73f：状态单选组按当前状态标出选中项；下面是设计稿的说明一行', () => {
    const states = (status: 'on_duty' | 'suspended'): string[] => statusButtons(setup(withStatus(status)).render()).map(button => `${textOf(button)}:${button.props['aria-pressed']}`)
    expect(states('on_duty')).toEqual(['在岗:true', '停用:false', '归档:false'])
    expect(states('suspended')).toEqual(['在岗:false', '停用:true', '归档:false'])
    expect(textOf(findElements(setup().render().props.children, 'p').find(node => textOf(node).startsWith('停用：')))).toBe('停用：保留记忆和工位，不接新活。归档：腾出名额，记录保留可查。')
  })

  it('P73f：总管的「归档」不可选，旁边写「总管不能归档」', () => {
    const tree = setup(withStatus('on_duty', 'chief')).render()
    const archiveButton = statusButtons(tree).find(button => textOf(button) === '归档')!
    expect(archiveButton.props.disabled).toBe(true)
    expect(textOf(tree.props.children)).toContain('总管不能归档')
    // 反例：别的员工的归档可点，没有这句说明。
    const other = setup(withStatus('on_duty')).render()
    expect(statusButtons(other).find(button => textOf(button) === '归档')!.props.disabled).toBe(false)
    expect(textOf(other.props.children)).not.toContain('总管不能归档')
  })

  it('P73f：不再出现试岗、转正、解除隔离、退役这些字样', () => {
    for (const status of ['on_duty', 'suspended', 'archived'] as const) {
      const text = textOf(setup(withStatus(status)).render().props.children) + labels(setup(withStatus(status)).render()).join('')
      for (const word of ['试岗', '转正', '解除', '隔离', '退役']) expect(text).not.toContain(word)
    }
  })

  it('八项表单在弹窗中间，打开时用这位队友的现状填好', () => {
    const fields = findElements(setup().render(), BotConfigFields)[0]!
    expect((fields.props.draft as { name: string }).name).toBe('探路')
    expect(fields.props.autoFocusName).toBe(true)
  })

  it('P73f：从在岗选停用，发 suspend，成功后刷新，弹窗不关', async () => {
    const { render, exec, onRefresh, onClose } = setup(withStatus('on_duty'))
    pickStatus(render(), '停用')
    await vi.waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1))
    expect(exec).toHaveBeenCalledWith('lifecycleAction', { botId: 'bot-tanlu', action: 'suspend' }, '已停用。记忆和工位保留，可随时恢复在岗。')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('P73f：从停用选在岗，发 reinstate', async () => {
    const { render, exec, onRefresh } = setup(withStatus('suspended'))
    pickStatus(render(), '在岗')
    await vi.waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1))
    expect(exec).toHaveBeenCalledWith('lifecycleAction', { botId: 'bot-tanlu', action: 'reinstate' }, '已恢复在岗。')
  })

  it('P73f：反例：选当前已选的状态，什么命令都不发', () => {
    const { render, exec } = setup(withStatus('on_duty'))
    pickStatus(render(), '在岗')
    expect(exec).not.toHaveBeenCalled()
  })

  it('P73f：选归档要二次确认：先调归档检查、出确认文字；确认后才发 archive，成功后关弹窗', async () => {
    const check: ArchiveConfirmInfo = { canArchive: true, reason: null, memberProjects: [] }
    const { render, exec, onClose, onCheckArchive } = setup(withStatus('on_duty'), check)
    pickStatus(render(), '归档')
    expect(exec).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(textOf(confirmBlock(render()))).toContain('归档后探路不再接活，腾出 1 个名额；记录保留可查。归档后不能恢复为在岗。'))
    expect(onCheckArchive).toHaveBeenCalledWith('bot-tanlu')
    expect(confirmButtons(render()).map(textOf)).toEqual(['确认归档', '取消'])
    expect(confirmButtons(render())[0]!.props.disabled).toBe(false)
    ;(confirmButtons(render())[0]!.props.onClick as () => void)()
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(exec).toHaveBeenCalledWith('lifecycleAction', { botId: 'bot-tanlu', action: 'archive' }, '已归档。记录保留可查。')
  })

  it('P73f：不能归档时，确认按钮不可点，并显示原因；点确认也不发命令', async () => {
    const { render, exec } = setup(withStatus('on_duty'), { canArchive: false, reason: '它还有 2 件在办的事，请先交接。' })
    pickStatus(render(), '归档')
    await vi.waitFor(() => expect(textOf(confirmBlock(render()))).toContain('它还有 2 件在办的事，请先交接。'))
    const confirm = confirmButtons(render())[0]!
    expect(confirm.props.disabled).toBe(true)
    ;(confirm.props.onClick as () => void)()
    expect(exec).not.toHaveBeenCalled()
    // 反例：不能归档时没有「后果」主句。
    expect(textOf(confirmBlock(render()))).not.toContain('腾出 1 个名额')
  })

  it('P73f：归档检查命令本身失败：当作不能归档，原因就是错误文字', async () => {
    const { render } = setup(withStatus('on_duty'), '归档检查失败：读取不到项目')
    pickStatus(render(), '归档')
    await vi.waitFor(() => expect(textOf(confirmBlock(render()))).toContain('归档检查失败：读取不到项目'))
    expect(confirmButtons(render())[0]!.props.disabled).toBe(true)
  })

  it('P73f：有 memberProjects 时另起一行「将移出项目：…」；没有时没有这一行', async () => {
    const withProjects = setup(withStatus('on_duty'), { canArchive: true, reason: null, memberProjects: [{ projectId: 'p1', projectName: '活动报名页' }, { projectId: 'p2', projectName: '竞品周报' }] })
    pickStatus(withProjects.render(), '归档')
    await vi.waitFor(() => expect(textOf(confirmBlock(withProjects.render()))).toContain('将移出项目：活动报名页、竞品周报'))
    const without = setup(withStatus('on_duty'))
    pickStatus(without.render(), '归档')
    await vi.waitFor(() => expect(textOf(confirmBlock(without.render()))).toContain('腾出 1 个名额'))
    expect(textOf(confirmBlock(without.render()))).not.toContain('将移出项目')
  })

  it('P73f：反例：点二次确认里的「取消」收起确认，什么命令都不发', async () => {
    const { render, exec } = setup(withStatus('on_duty'))
    pickStatus(render(), '归档')
    await vi.waitFor(() => expect(confirmBlock(render())).toBeDefined())
    ;(confirmButtons(render())[1]!.props.onClick as () => void)()
    expect(confirmBlock(render())).toBeUndefined()
    expect(exec).not.toHaveBeenCalled()
  })

  it('P73f：性格改了之后四句话即时变化，但没点保存前不发任何命令', () => {
    const istj: BotView = { ...tanlu, profile: { ...tanlu.profile, mbti: 'ISTJ' } }
    const { render, exec } = setup(istj)
    ;(findElements(render(), BotConfigFields)[0]!.props.onChange as (partial: object) => void)({ mbti: 'ESTJ' })
    expect((findElements(render(), BotConfigFields)[0]!.props.draft as { mbti: string }).mbti).toBe('ESTJ')
    expect(exec).not.toHaveBeenCalled()
  })

  it('P73f：执行类员工保存时，提交的参数里没有 onDemand、autonomy、pace', async () => {
    const { render, exec, onClose } = setup(withStatus('on_duty', 'executor'))
    ;(findElements(render(), BotConfigFields)[0]!.props.onChange as (partial: object) => void)({ name: '探路二号', rhythm: 'drive' })
    press(render(), '保存')
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    const patch = (exec.mock.calls[0] as unknown as [string, { patch: Record<string, unknown> }])[1].patch
    expect(patch.name).toBe('探路二号')
    for (const key of ['onDemand', 'autonomy', 'pace']) expect(patch).not.toHaveProperty(key)
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

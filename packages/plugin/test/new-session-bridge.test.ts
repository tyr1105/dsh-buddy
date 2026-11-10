/**
 * 新会话页接线的行为测试（P57）：用假宿主跑真实的 installNewSessionBridge。
 *
 * 规则本身在 new-session-mention / new-session-project 的单测里；这里防的是接线走样：
 * 回车到底发给了谁、有没有误建 DSH 会话、失败时草稿能不能留住、
 * 下拉有没有只在队友模式替换官方选择器。
 * 其中「不声明子插槽」是实测踩过的坑：声明了会把官方选择器的注册挤失败。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installNewSessionBridge } from '../src/client/new-session-bridge.js'
import { createStore } from '../src/client/store.js'
import type { SpaceMode } from '../src/client/logic/space-capability.js'
import { MENTION_SECTION_TITLE, TEAMMATE_CLAIM_NAME } from '../src/client/logic/new-session-mention.js'
import { PROJECT_CLAIM_NAME } from '../src/client/logic/new-session-project.js'
import { createHookHost } from './helpers/hook-host.js'
import { findElements, type StubElement } from './helpers/jsx-runtime-stub.js'

vi.mock('react', async () => (await import('./helpers/hook-host.js')).reactFacade)
// 门户直接返回内容，测试才能在元素树里找到下拉的行。
vi.mock('react-dom', () => ({ createPortal: (node: unknown) => node }))

interface Candidate { name: string; description: string; section: string; value: string }
interface Claim {
  name: string
  token: string
  hint: string
  submit: (args: string, actx: unknown, attachments: readonly unknown[]) => Promise<{ kind: string; text?: string }>
}
interface Source {
  trigger: string
  order?: number
  candidates: (session: { sessionId: string }, request: { query: string; quoted?: boolean; position: string }) => Promise<Candidate[]>
  onPick: (pick: unknown) => { claim?: Claim; text?: string } | undefined
  matchClaim: (session: unknown, token: string) => Promise<Claim | undefined>
}

function harness(options: { mode?: SpaceMode; blank?: boolean; noProjects?: boolean } = {}) {
  const state = {
    overview: {
      bots: [
        { id: 'b_1', name: '小李', roleLabel: '调研', lifecycle: 'active', archived: false, color: '#123', initials: '小李' },
        { id: 'b_2', name: '老王', roleLabel: '执行', lifecycle: 'active', archived: false, color: '#456', initials: '老王' },
        { id: 'b_3', name: '局外人', roleLabel: '盯守', lifecycle: 'active', archived: false, color: '#789', initials: '局' },
      ],
    },
    project: {
      projects: options.noProjects === true ? [] : [{
        project: { id: 'prj_a', name: 'dddd', status: 'active' },
        members: [
          { botId: 'b_2', name: '老王', invalid: false, roleLabel: '执行', isOwner: false },
          { botId: 'b_1', name: '小李', invalid: false, roleLabel: '调研', isOwner: true },
        ],
      }],
    },
  }
  const hub = Object.assign(createStore(state), {
    send: vi.fn(async () => undefined),
    selectThread: vi.fn(),
    refreshProject: vi.fn(async () => undefined),
    command: vi.fn(async () => ({ ok: true, data: { topicId: 'ptp_1' } }) as { ok: boolean; data?: unknown; error?: string }),
  })
  const mode = createStore<SpaceMode>(options.mode ?? 'team')
  const sources: Source[] = []
  const entries: Array<{ name: string; options: Record<string, unknown>; component: unknown }> = []
  const host = {
    slots: {
      // 假宿主里插槽都已声明：inject 直接执行，返回撤销函数。
      inject: (_name: string, callback: () => () => void) => callback(),
      register: (entryOptions: Record<string, unknown>, component: unknown) => {
        const entry = { name: String(entryOptions.name), options: entryOptions, component }
        entries.push(entry)
        return () => { entries.splice(entries.indexOf(entry), 1) }
      },
    },
    effect: (factory: () => () => void) => { factory() },
    inputTriggers: { registerSource: (next: Source) => { sources.push(next); return () => undefined } },
    sessions: { list: { getSnapshot: () => ({ byId: { s1: { blank: options.blank ?? true } } }) } },
    workspaces: { create: vi.fn(async () => ({ workspaceId: 'w9', title: 'new' })) },
  }
  const layout = { selectPanel: vi.fn() }
  const ctx = {
    inject: (_names: string[], callback: (services: typeof host) => void) => callback(host),
    get: (name: string) => (name === 'layout' ? layout : undefined),
    locale: { bind: () => (key: string) => key },
  }
  installNewSessionBridge(ctx, { hub: hub as never, mode })
  return {
    source: sources.find(item => item.trigger === '@') as Source,
    chipSource: sources.find(item => item.trigger === '#') as Source,
    hub, mode, host, layout, entries,
  }
}

type Context = ReturnType<typeof harness>
type PickerProps = {
  open: boolean
  selectedId?: string
  anchorRef: { current: unknown }
  onPick: (id: string) => void
  onClose: () => void
  useWorkspaces: (select: (state: { items: Array<{ workspaceId: string; title: string; path: string }> }) => unknown) => unknown
}

const session = { sessionId: 's1' }
const pickOf = (value: string, position = 'leading') => ({ candidate: { value }, session, position, action: 'pick', via: 'menu' })
const nextTick = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 0) })

/** 假的下拉环境：组件要用 document 和 window，但测试没有浏览器。 */
function stubBrowser(): void {
  vi.stubGlobal('document', { addEventListener: () => undefined, removeEventListener: () => undefined, activeElement: null, body: {}, querySelector: () => null })
  vi.stubGlobal('window', { innerHeight: 800, innerWidth: 1200 })
  // 假元素没有 querySelector，取焦点那段会走兜底日志，这里不让它污染测试输出。
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
}

/** 渲染一次下拉，返回渲染函数和两个回调。 */
function mountPicker(context: Context, anchor: unknown = null) {
  const entry = context.entries.find(item => item.name === 'conversation.hero.workspace')
  const onPick = vi.fn()
  const onClose = vi.fn()
  const props = (open: boolean): PickerProps => ({
    open, selectedId: 'w1', onPick, onClose, anchorRef: { current: anchor },
    useWorkspaces: select => select({ items: [{ workspaceId: 'w1', title: 'code', path: '/Users/me/code' }] }),
  })
  const host = createHookHost()
  const tree = (open = true): unknown => host.render(entry?.component as (p: PickerProps) => unknown, props(open))
  const buttons = (open = true): StubElement[] => findElements(tree(open), 'button')
  return { tree, buttons, onPick, onClose }
}

/** 通过下拉选中项目：和主人真实操作走同一条路。 */
function selectProject(context: Context): void {
  const { buttons } = mountPicker(context)
  const row = buttons().find(item => item.props.role === 'menuitemradio' && String(item.props.title).includes('发到项目'))
  ;(row?.props.onClick as () => void)()
}

function claimOfProject(context: Context): Promise<Claim> {
  return context.chipSource.matchClaim(session, '#dddd') as Promise<Claim>
}

beforeEach(stubBrowser)
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('没选项目：@ 队友发给本人', () => {
  it('队友模式的新会话：列出全部队友，排在官方来源前面', async () => {
    const { source } = harness()
    expect(source.order).toBeLessThan(0)
    const rows = await source.candidates(session, { query: '', position: 'leading' })
    expect(rows.map(item => item.name)).toEqual(['小李', '老王', '局外人'])
    expect(rows[0]?.section).toBe(MENTION_SECTION_TITLE)
  })

  it('写在句中、对话模式、进行中的会话：不列', async () => {
    expect(await harness().source.candidates(session, { query: '', position: 'inline' })).toEqual([])
    expect(await harness({ mode: 'chat' }).source.candidates(session, { query: '', position: 'leading' })).toEqual([])
    expect(await harness({ blank: false }).source.candidates(session, { query: '', position: 'leading' })).toEqual([])
  })

  function claimOf() {
    const context = harness()
    const claim = context.source.onPick(pickOf('b_1'))?.claim
    expect(claim?.name).toBe(TEAMMATE_CLAIM_NAME)
    expect(claim?.token).toBe('@小李 ')
    return { ...context, claim: claim as Claim }
  }

  it('回车：发进它的线程，然后跳到和它的对话，不建主题', async () => {
    const { claim, hub, layout } = claimOf()
    await expect(claim.submit('  帮我看下日志 ', null, [])).resolves.toEqual({ kind: 'success' })
    expect(hub.send).toHaveBeenCalledWith('b_1', '帮我看下日志')
    expect(hub.command).not.toHaveBeenCalled()
    await nextTick()
    expect(layout.selectPanel).toHaveBeenCalledWith('agent-hub')
    expect(hub.selectThread).toHaveBeenCalledWith('b_1')
  })

  it('没写内容、带附件：不发，提示清楚', async () => {
    const { claim, hub } = claimOf()
    expect((await claim.submit('   ', null, [])).text).toContain('小李')
    expect((await claim.submit('看图', null, [{ id: 'a' }])).text).toContain('附件')
    expect(hub.send).not.toHaveBeenCalled()
  })

  it('发送失败：报错、不跳转，宿主据此保留草稿', async () => {
    const { claim, hub, layout } = claimOf()
    hub.send.mockRejectedValueOnce(new Error('连接中断'))
    await expect(claim.submit('帮我', null, [])).resolves.toEqual({ kind: 'error', text: '发送失败。连接中断' })
    await nextTick()
    expect(layout.selectPanel).not.toHaveBeenCalled()
  })

  it('反例：写在句中、对话模式、队友已不在名单时都不接管发送', () => {
    expect(harness().source.onPick(pickOf('b_1', 'inline'))).toBeUndefined()
    expect(harness({ mode: 'chat' }).source.onPick(pickOf('b_1'))).toBeUndefined()
    expect(harness().source.onPick(pickOf('b_gone'))).toBeUndefined()
  })

  it('切换工作区后宿主能按文字把标签重建回来；认不出的不接', async () => {
    const { source } = harness()
    expect((await source.matchClaim(session, '@小李'))?.token).toBe('@小李 ')
    expect(await source.matchClaim(session, '@没这人')).toBeUndefined()
  })
})

describe('选了项目：@ 列项目成员', () => {
  it('只列成员，负责人排第一并标出来', async () => {
    const context = harness()
    selectProject(context)
    const rows = await context.source.candidates(session, { query: '', position: 'leading' })
    expect(rows.map(item => item.name)).toEqual(['小李', '老王'])
    expect(rows[0]?.description).toBe('负责人 · 调研')
    expect(rows[0]?.section).toContain('dddd')
  })

  it('写在句中也列', async () => {
    const context = harness()
    selectProject(context)
    expect(await context.source.candidates(session, { query: '', position: 'inline' })).toHaveLength(2)
  })

  it('选人只是插入「@名字」文字，不接管发送', () => {
    const context = harness()
    selectProject(context)
    expect(context.source.onPick(pickOf('b_2', 'inline'))).toEqual({ text: '@老王 ' })
  })
})

describe('选了项目：回车开主题', () => {
  it('标签提示写清不 @ 时发给谁', async () => {
    const claim = await claimOfProject(harness())
    expect(claim.name).toBe(PROJECT_CLAIM_NAME)
    expect(claim.token).toBe('#dddd ')
    expect(claim.hint).toContain('负责人 小李')
  })

  it('回车：调 createProjectTopic，文字原样，跳进主题，不发给 DSH 也不走发给本人', async () => {
    const context = harness()
    selectProject(context)
    const claim = await claimOfProject(context)
    await expect(claim.submit('@老王 帮我看下日志 ', null, [])).resolves.toEqual({ kind: 'success' })
    expect(context.hub.command).toHaveBeenCalledWith('createProjectTopic', { projectId: 'prj_a', text: '@老王 帮我看下日志' })
    expect(context.hub.send).not.toHaveBeenCalled()
    await nextTick()
    expect(context.layout.selectPanel).toHaveBeenCalledWith('agent-hub')
    expect(context.hub.selectThread).toHaveBeenCalledWith('ptp_1')
  })

  it('发完回到普通状态：@ 又是发给本人', async () => {
    const context = harness()
    selectProject(context)
    await (await claimOfProject(context)).submit('帮我', null, [])
    const rows = await context.source.candidates(session, { query: '', position: 'leading' })
    expect(rows[0]?.section).toBe(MENTION_SECTION_TITLE)
  })

  it('引擎报错：把原因交给宿主显示，不跳转，项目还选着', async () => {
    const context = harness()
    selectProject(context)
    context.hub.command.mockResolvedValueOnce({ ok: false, error: '这个项目还没有能当负责人的成员' })
    const claim = await claimOfProject(context)
    await expect(claim.submit('帮我', null, [])).resolves.toEqual({ kind: 'error', text: '这个项目还没有能当负责人的成员' })
    await nextTick()
    expect(context.hub.selectThread).not.toHaveBeenCalled()
    expect((await context.source.candidates(session, { query: '', position: 'inline' })).length).toBeGreaterThan(0)
  })

  it('没写内容、带附件：不开主题', async () => {
    const context = harness()
    const claim = await claimOfProject(context)
    expect((await claim.submit('  ', null, [])).kind).toBe('error')
    expect((await claim.submit('看图', null, [{ id: 'a' }])).kind).toBe('error')
    expect(context.hub.command).not.toHaveBeenCalled()
  })

  it('返回里没有主题 id：按失败处理，不跳到空页面', async () => {
    const context = harness()
    context.hub.command.mockResolvedValueOnce({ ok: true, data: {} })
    expect((await (await claimOfProject(context)).submit('帮我', null, [])).kind).toBe('error')
    await nextTick()
    expect(context.hub.selectThread).not.toHaveBeenCalled()
  })

  it('项目标签的来源不在任何菜单里出现', async () => {
    const { chipSource } = harness()
    expect(await chipSource.candidates(session, { query: '', position: 'leading' })).toEqual([])
  })

  it('认不出的项目标签不接', async () => {
    expect(await harness().chipSource.matchClaim(session, '#没这个项目')).toBeUndefined()
  })
})

describe('项目标签跟着选中状态走', () => {
  type GuardProps = {
    sessionId: string
    useInput: <T>(select: (state: { phase: string; draft: string; claim?: unknown }) => T) => T
    inputActions: { setDraft: ReturnType<typeof vi.fn> }
  }

  function runGuard(context: Context, input: { phase: string; draft: string; claim?: unknown }) {
    const entry = context.entries.find(item => item.name === 'conversation.hero.options')
    const setDraft = vi.fn()
    createHookHost().render(entry?.component as (props: GuardProps) => unknown, {
      sessionId: 's1',
      useInput: select => select(input),
      inputActions: { setDraft },
    })
    return setDraft
  }

  it('选了项目：把标签放进输入框，已打的字留着', () => {
    const context = harness()
    selectProject(context)
    expect(runGuard(context, { phase: 'plain', draft: '帮我' })).toHaveBeenCalledWith({ text: '#dddd 帮我', references: [], command: { token: '#dddd ' } })
  })

  it('没选项目但输入框里带着标签（比如换了工作区）：摘掉，正文留下', () => {
    const setDraft = runGuard(harness(), { phase: 'claimed', draft: '#dddd 帮我', claim: { name: PROJECT_CLAIM_NAME, token: '#dddd ' } })
    expect(setDraft).toHaveBeenCalledWith('帮我')
  })

  it('反例：普通状态不碰输入框', () => {
    expect(runGuard(harness(), { phase: 'plain', draft: '普通的话' })).not.toHaveBeenCalled()
  })
})

describe('工作区下拉', () => {
  const heroPicker = (entries: Context['entries']) => entries.filter(entry => entry.name === 'conversation.hero.workspace')

  it('队友模式：以更小的 priority 盖住官方选择器，且不声明子插槽', () => {
    const [entry] = heroPicker(harness().entries)
    expect(entry?.options.priority).toBeLessThan(0)
    expect(entry?.options.children).toBeUndefined()
  })

  it('对话模式：不替换；切模式时撤掉和恢复，不会重复注册', () => {
    expect(heroPicker(harness({ mode: 'chat' }).entries)).toHaveLength(0)
    const { mode, entries } = harness()
    mode.set('chat')
    expect(heroPicker(entries)).toHaveLength(0)
    mode.set('team')
    expect(heroPicker(entries)).toHaveLength(1)
  })

  it('切到对话模式：清掉选中的项目', async () => {
    const context = harness()
    selectProject(context)
    context.mode.set('chat')
    context.mode.set('team')
    const rows = await context.source.candidates(session, { query: '', position: 'leading' })
    expect(rows[0]?.section).toBe(MENTION_SECTION_TITLE)
  })

  it('关着和开着的 hook 数量一致（改错会让整个新会话页报错）', () => {
    const { buttons } = mountPicker(harness())
    expect(buttons(false)).toEqual([])
    expect(buttons(true).length).toBeGreaterThan(0)
    expect(buttons(false)).toEqual([])
  })

  it('选项目：只记下来并关闭，不登记工作区、不切换', () => {
    const context = harness()
    const { buttons, onPick, onClose } = mountPicker(context)
    const row = buttons().find(item => String(item.props.title).includes('发到项目'))
    ;(row?.props.onClick as () => void)()
    expect(onClose).toHaveBeenCalled()
    expect(onPick).not.toHaveBeenCalled()
    expect(context.host.workspaces.create).not.toHaveBeenCalled()
  })

  it('选普通工作区：清掉项目并交给宿主切换', async () => {
    const context = harness()
    selectProject(context)
    const { buttons, onPick } = mountPicker(context)
    const row = buttons().find(item => item.props.title === '/Users/me/code')
    ;(row?.props.onClick as () => void)()
    expect(onPick).toHaveBeenCalledWith('w1')
    const rows = await context.source.candidates(session, { query: '', position: 'leading' })
    expect(rows[0]?.section).toBe(MENTION_SECTION_TITLE)
  })

  it('没有进行中的项目：不显示这一组', () => {
    const { tree } = mountPicker(harness({ noProjects: true }))
    const groups = findElements(tree(), 'div').filter(item => item.props.role === 'group').map(item => item.props['aria-label'])
    expect(groups).toEqual(['工作区'])
  })

  it('有项目时两组都在，项目在前', () => {
    const { tree } = mountPicker(harness())
    const groups = findElements(tree(), 'div').filter(item => item.props.role === 'group').map(item => item.props['aria-label'])
    expect(groups).toEqual(['项目', '工作区'])
  })

  it('工作区按钮的文字跟着选中的项目变，取消后换回去', () => {
    const context = harness()
    const label = { textContent: '默认工作区' }
    const anchor = { querySelector: () => label, contains: () => false, getBoundingClientRect: () => ({ left: 100, bottom: 200 }) }
    const { buttons } = mountPicker(context, anchor)
    const row = buttons().find(item => String(item.props.title).includes('发到项目'))
    ;(row?.props.onClick as () => void)()
    buttons()
    expect(label.textContent).toBe('dddd')
    const plain = buttons().find(item => item.props.title === '/Users/me/code')
    ;(plain?.props.onClick as () => void)()
    buttons()
    expect(label.textContent).toBe('默认工作区')
  })

  it('添加工作区：取消选择时什么都不发生', async () => {
    vi.stubGlobal('__DSH_DIRECTORY_PICKER__', { pick: vi.fn(async () => null) })
    const context = harness()
    const { buttons, onPick } = mountPicker(context)
    ;(buttons().find(item => item.props.role === 'menuitem')?.props.onClick as () => void)()
    await nextTick()
    expect(context.host.workspaces.create).not.toHaveBeenCalled()
    expect(onPick).not.toHaveBeenCalled()
  })

  it('添加工作区：选了文件夹就登记并切换', async () => {
    vi.stubGlobal('__DSH_DIRECTORY_PICKER__', { pick: vi.fn(async () => '/Users/me/new') })
    const context = harness()
    const { buttons, onPick } = mountPicker(context)
    ;(buttons().find(item => item.props.role === 'menuitem')?.props.onClick as () => void)()
    await nextTick()
    expect(context.host.workspaces.create).toHaveBeenCalledWith({ path: '/Users/me/new' })
    expect(onPick).toHaveBeenCalledWith('w9')
  })

  it('添加工作区失败：留在菜单里说清楚', async () => {
    vi.stubGlobal('__DSH_DIRECTORY_PICKER__', { pick: vi.fn(async () => { throw new Error('权限不足') }) })
    const context = harness()
    const { buttons, tree, onPick } = mountPicker(context)
    ;(buttons().find(item => item.props.role === 'menuitem')?.props.onClick as () => void)()
    await nextTick()
    const alert = findElements(tree(), 'p').find(item => item.props.role === 'alert')
    expect(onPick).not.toHaveBeenCalled()
    expect(alert?.props.children).toContain('权限不足')
  })
})

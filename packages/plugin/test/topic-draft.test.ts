/**
 * 草稿主题的测试（P60，2026-11-10）：项目里「新开会话」直接进空聊天，第一句发出才真正建主题。
 *
 * 覆盖主人验收的四件事：
 * 1. 点入口（项目页「新开会话」、左栏项目行 ＋）只进草稿，不调用 createProjectTopic；
 * 2. 在草稿里发第一句才调用 createProjectTopic，成功后切到新主题、草稿清掉；
 * 3. 没发就离开（点队友、换页面、点项目行），草稿清掉，不留主题、不发命令；
 * 4. 发送失败时中文原因显示在输入框附近，打好的字原样留着。
 *
 * 用真实仓库和 hook 宿主跑真实组件；子组件不执行，只看交给它们的参数。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHubStore, type HubStore } from '../src/client/hub-state.js'
import { HubPage } from '../src/client/pages/HubPage.js'
import { ThreadPane } from '../src/client/components/ThreadPane.js'
import { TopicThreadBody } from '../src/client/components/TopicThreadBody.js'
import { TopicDraftPane } from '../src/client/components/topic-draft-pane.js'
import { TeamSidebarNav, type TeamSidebarNavProps } from '../src/client/components/team-sidebar-nav.js'
import { WorkspacesGroup } from '../src/client/components/sidebar-workspaces-group.js'
import {
  TOPIC_DRAFT_PROJECT_GONE_TEXT, TOPIC_DRAFT_TITLE, emptyDraftThread, sendDraftFirstMessage, sidebarSelectedThread,
  topicDraftPaneInfo, topicDraftThreadId,
} from '../src/client/logic/topic-draft.js'
import { fixtureProject } from '../src/shared/fixture-project.js'
import { fixtureOverview } from '../src/shared/fixtures.js'
import type { ProjectView } from '../src/shared/views.js'
import { createHookHost } from './helpers/hook-host.js'
import { findElements, type StubElement } from './helpers/jsx-runtime-stub.js'

// 把 react 换成 hook 宿主的替身；组件里的 hook 都会走到这里。
vi.mock('react', async () => (await import('./helpers/hook-host.js')).reactFacade)

/** 把元素树里的文字拼起来；子组件不展开。 */
function textOf(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object' && node !== null && 'props' in node) return textOf((node as StubElement).props.children)
  return ''
}

/** 等 then 链上的微任务跑完。 */
const flush = () => new Promise(resolve => setTimeout(resolve, 0))

/**
 * 建仓库：名册和项目视图都已到手，选中某条线程；
 * command 可观察、默认成功，refreshProject / refreshOverview 不联网。
 */
function setup(options: { selected?: string; command?: (name: string, input: Record<string, unknown>) => Promise<unknown> } = {}) {
  const hub: HubStore = createHubStore()
  hub.update(prev => ({ ...prev, overview: fixtureOverview, project: fixtureProject, selectedThread: options.selected ?? 'bot-tanlu', view: 'main' }))
  const command = vi.fn(options.command ?? (async () => ({ ok: true as const })))
  ;(hub as unknown as { command: unknown }).command = command
  ;(hub as unknown as { refreshProject: unknown }).refreshProject = vi.fn(async () => undefined)
  ;(hub as unknown as { refreshOverview: unknown }).refreshOverview = vi.fn(async () => undefined)
  return { hub, command }
}

/** 只数某个命令的调用。 */
const callsOf = (command: ReturnType<typeof vi.fn>, name: string): unknown[][] => command.mock.calls.filter(call => call[0] === name)

beforeEach(() => {
  // 中心页挂载时会拉数据：永远等待，不产生网络访问。
  vi.stubGlobal('fetch', () => new Promise(() => undefined))
  vi.stubGlobal('window', { addEventListener: () => undefined, removeEventListener: () => undefined })
  vi.stubGlobal('ResizeObserver', class { observe(): void {} disconnect(): void {} })
})
afterEach(() => { vi.unstubAllGlobals() })

describe('仓库里的草稿', () => {
  it('打开草稿：中栏切到对话页、记下项目，不发任何命令', () => {
    const { hub, command } = setup()
    hub.setView('project')
    hub.openTopicDraft('prj_weekly')
    const state = hub.getSnapshot()
    expect(state.view).toBe('main')
    expect(state.topicDraft).toEqual({ projectId: 'prj_weekly', seq: 1 })
    expect(state.activeProjectId).toBeNull()
    expect(command).not.toHaveBeenCalled()
  })

  it('同一个项目再点一次是一张新的白纸（序号加一，线程 id 不同）', () => {
    const { hub } = setup()
    hub.openTopicDraft('prj_weekly')
    const first = hub.getSnapshot().topicDraft!
    hub.openTopicDraft('prj_weekly')
    const second = hub.getSnapshot().topicDraft!
    expect(second.seq).toBe(first.seq + 1)
    expect(topicDraftThreadId(second)).not.toBe(topicDraftThreadId(first))
  })

  it('没发就离开：点队友、换页面、点项目行都清掉草稿，项目视图不多主题、不发建主题命令', () => {
    const { hub, command } = setup()
    const leaves: Array<() => void> = [
      () => hub.selectThread('bot-tanlu'),
      () => hub.selectThread('team'),
      () => hub.setView('office'),
      () => hub.requestProject('prj_weekly'),
    ]
    for (const leave of leaves) {
      hub.openTopicDraft('prj_weekly')
      leave()
      expect(hub.getSnapshot().topicDraft).toBeNull()
    }
    expect(hub.getSnapshot().project).toBe(fixtureProject)
    expect(callsOf(command, 'createProjectTopic')).toHaveLength(0)
  })

  it('左栏在草稿时哪一行都不亮；反例：不在草稿、或已离开对话页时照旧', () => {
    expect(sidebarSelectedThread({ view: 'main', selectedThread: 'bot-tanlu', topicDraft: { projectId: 'p', seq: 1 } })).toBe('')
    expect(sidebarSelectedThread({ view: 'main', selectedThread: 'bot-tanlu', topicDraft: null })).toBe('bot-tanlu')
    expect(sidebarSelectedThread({ view: 'office', selectedThread: 'bot-tanlu', topicDraft: { projectId: 'p', seq: 1 } })).toBe('bot-tanlu')
  })
})

describe('草稿聊天页的信息', () => {
  it('标题是「新会话」，项目名、默认发给负责人、能 @ 的成员和真主题一致', () => {
    const info = topicDraftPaneInfo(fixtureProject, 'prj_weekly', fixtureOverview.bots)
    expect(info.title).toBe(TOPIC_DRAFT_TITLE)
    expect(info.projectName).toBe('竞品周报自动化')
    expect(info.placeholder).toBe('默认发给 探路，@ 可以点名…')
    expect(info.members.map(member => member.name)).toEqual(['探路', '巡检员'])
    expect(info.readOnlyText).toBeNull()
    expect(info.replying).toEqual([])
  })

  it('反例：开着草稿时项目被暂停，换成只读说明', () => {
    expect(topicDraftPaneInfo(fixtureProject, 'prj_migrate', fixtureOverview.bots).readOnlyText).toContain('暂停')
  })

  it('反例：项目被删了说清楚；项目视图还没到时先用通用占位，不判只读', () => {
    expect(topicDraftPaneInfo(fixtureProject, 'prj_nope', []).readOnlyText).toBe(TOPIC_DRAFT_PROJECT_GONE_TEXT)
    expect(topicDraftPaneInfo(null, 'prj_weekly', [])).toMatchObject({ title: TOPIC_DRAFT_TITLE, readOnlyText: null, members: [] })
    expect(topicDraftPaneInfo({} as ProjectView, 'prj_weekly', []).readOnlyText).toBeNull()
  })

  it('空线程：没有楼层，线程 id 不是主题也不是队友，不会拿去请求接口', () => {
    const thread = emptyDraftThread({ projectId: 'prj_weekly', seq: 3 })
    expect(thread.messages).toEqual([])
    expect(thread.threadId.startsWith('ptp_')).toBe(false)
  })
})

describe('入口只进草稿，不建主题', () => {
  it('左栏项目行 ＋：交给草稿入口，不展开表单、不调用建会话', () => {
    const onOpenTopicDraft = vi.fn()
    const onCreateSession = vi.fn(async () => null)
    const props: TeamSidebarNavProps = {
      overview: fixtureOverview, project: fixtureProject, view: 'main', selectedThread: 'team',
      onOpenOffice: () => undefined, onSelectBot: () => undefined, onOpenInbox: () => undefined, onOpenSettings: () => undefined,
      onNewBot: () => undefined, onOpenProject: () => undefined, onOpenTopic: () => undefined, onCreateSession, onOpenTopicDraft,
    }
    const host = createHookHost()
    const group = findElements(host.render(TeamSidebarNav, props), WorkspacesGroup)[0]!
    ;(group.props.onOpenProjectForm as (projectId: string) => void)('prj_weekly')
    expect(onOpenTopicDraft).toHaveBeenCalledWith('prj_weekly')
    expect(findElements(host.render(TeamSidebarNav, props), WorkspacesGroup)[0]!.props.form).toBeNull()
    expect(onCreateSession).not.toHaveBeenCalled()
  })

  it('中心页摆着草稿：中栏是草稿聊天，不给上一条主题标已读、不调用建主题', async () => {
    // ptp_weekly_sources 在样例里有未读：正常摆着它会标已读，草稿盖在上面时不该标。
    const { hub, command } = setup({ selected: 'ptp_weekly_sources' })
    hub.openTopicDraft('prj_weekly')
    const tree = createHookHost().render(HubPage, { hub, clientCtx: null })
    await flush()
    const panes = findElements(tree, TopicDraftPane)
    expect(panes).toHaveLength(1)
    expect((panes[0]!.props.draft as { projectId: string }).projectId).toBe('prj_weekly')
    expect(findElements(tree, ThreadPane)).toHaveLength(0)
    expect(callsOf(command, 'markThreadRead')).toHaveLength(0)
    expect(callsOf(command, 'createProjectTopic')).toHaveLength(0)
  })
})

describe('在草稿里发第一句', () => {
  it('发出才调用 createProjectTopic，成功后切到新主题、草稿清掉', async () => {
    const { hub, command } = setup({
      command: async name => (name === 'createProjectTopic' ? { ok: true, data: { topicId: 'ptp_new' } } : { ok: true }),
    })
    hub.openTopicDraft('prj_weekly')
    const tree = createHookHost().render(HubPage, { hub, clientCtx: null })
    const pane = findElements(tree, TopicDraftPane)[0]!
    expect(callsOf(command, 'createProjectTopic')).toHaveLength(0)
    await (pane.props.onSendFirst as (projectId: string, text: string) => Promise<void>)('prj_weekly', '把本周竞品整理成一页')
    expect(callsOf(command, 'createProjectTopic')).toEqual([['createProjectTopic', { projectId: 'prj_weekly', text: '把本周竞品整理成一页' }]])
    const state = hub.getSnapshot()
    expect(state.selectedThread).toBe('ptp_new')
    expect(state.topicDraft).toBeNull()
    expect(state.view).toBe('main')
  })

  it('反例：建主题失败时抛出中文原因，留在草稿里，不切线程', async () => {
    const { hub } = setup({ command: async () => ({ ok: false, error: '项目暂停中，恢复后才能开会话。' }) })
    hub.openTopicDraft('prj_weekly')
    await expect(sendDraftFirstMessage(hub, 'prj_weekly', 'x')).rejects.toThrow('项目暂停中，恢复后才能开会话。')
    expect(hub.getSnapshot().topicDraft).not.toBeNull()
    expect(hub.getSnapshot().selectedThread).toBe('bot-tanlu')
  })
})

describe('草稿聊天的样子与失败提示', () => {
  /** TopicDraftPane 没有 hook，直接调用拿到它交给 ThreadPane 的参数。 */
  function draftPaneProps(onSendFirst: (projectId: string, text: string) => Promise<void>): Parameters<typeof ThreadPane>[0] {
    const element = TopicDraftPane({ draft: { projectId: 'prj_weekly', seq: 99 }, project: fixtureProject, bots: fixtureOverview.bots, onSendFirst }) as StubElement
    return element.props as Parameters<typeof ThreadPane>[0]
  }

  it('标题「新会话」、项目名、@ 队友、占位文字都在，输入框自动聚焦，没有「0 条回复」', () => {
    const tree = createHookHost().render(ThreadPane, draftPaneProps(async () => undefined))
    const text = textOf(tree)
    expect(text).toContain('新会话')
    expect(text).toContain('竞品周报自动化')
    expect(text).toContain('@ 队友')
    expect(text).toContain('这条会话做什么？')
    const textarea = findElements(tree, 'textarea')[0]!
    expect(textarea.props.placeholder).toBe('默认发给 探路，@ 可以点名…')
    expect(textarea.props.autoFocus).toBe(true)
    expect(findElements(tree, TopicThreadBody)).toHaveLength(0)
  })

  it('发送失败：原因显示在输入框附近，打好的字还在', async () => {
    const onSendFirst = vi.fn(async () => { throw new Error('项目暂停中') })
    const host = createHookHost()
    const props = draftPaneProps(onSendFirst)
    let tree = host.render(ThreadPane, props)
    ;(findElements(tree, 'textarea')[0]!.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: '第一句' } })
    tree = host.render(ThreadPane, props)
    const sendButton = findElements(tree, 'button').find(node => textOf(node) === '发送')!
    ;(sendButton.props.onClick as () => void)()
    await vi.waitFor(() => expect(textOf(host.render(ThreadPane, props))).toContain('没发出去：项目暂停中'))
    expect(onSendFirst).toHaveBeenCalledWith('prj_weekly', '第一句')
    expect(findElements(host.render(ThreadPane, props), 'textarea')[0]!.props.value).toBe('第一句')
  })

  it('反例：项目不在进行中时不放「怎么开始」，换成只读说明、没有输入框', () => {
    const element = TopicDraftPane({ draft: { projectId: 'prj_migrate', seq: 1 }, project: fixtureProject, bots: [], onSendFirst: async () => undefined }) as StubElement
    const tree = createHookHost().render(ThreadPane, element.props as Parameters<typeof ThreadPane>[0])
    expect(textOf(tree)).toContain('暂停')
    expect(textOf(tree)).not.toContain('这条会话做什么？')
    expect(findElements(tree, 'textarea')).toHaveLength(0)
  })
})

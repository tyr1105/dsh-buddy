/**
 * 项目主题聊天和项目页的接线测试（P60、P63）：认主题 id、楼层怎么分、谁在回复、
 * 开主题的流程，以及 ThreadPane 的主题模式、项目页的四块内容。
 *
 * 用 hook 宿主跑真实组件：只看这一层组件交给下一层什么，子组件不执行。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectFormDialog } from '../src/client/components/project-dialogs.js'
import { SidebarSessionForm } from '../src/client/components/sidebar-session-form.js'
import { WorkspacesGroup, type WorkspacesGroupProps } from '../src/client/components/sidebar-workspaces-group.js'
import { ThreadPane } from '../src/client/components/ThreadPane.js'
import { TopicThreadBody } from '../src/client/components/TopicThreadBody.js'
import {
  buildTopicThread, findTopic, isTopicCapNote, isTopicThreadId, openNewTopic, topicPaneInfo, topicReplyingNames,
} from '../src/client/logic/topics.js'
import { ProjectBoard, ProjectPage } from '../src/client/pages/ProjectPage.js'
import { fixtureProject, fixtureTopicThreads } from '../src/shared/fixture-project.js'
import { fixtureOverview } from '../src/shared/fixtures.js'
import { FixtureHub } from '../src/host/hub-facade.js'
import type { BotCard, ThreadMessageView, ThreadView } from '../src/shared/views.js'
import { createHookHost } from './helpers/hook-host.js'
import { findElements, type StubElement } from './helpers/jsx-runtime-stub.js'

vi.mock('react', async () => (await import('./helpers/hook-host.js')).reactFacade)

const weekly = fixtureProject.projects[0]!
const priceThread = fixtureTopicThreads[0]!
const sourcesThread = fixtureTopicThreads[1]!

/** 把元素树里的文字拼起来；子组件不展开。 */
function textOf(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object' && node !== null && 'props' in node) return textOf((node as StubElement).props.children)
  return ''
}

/** 造一条消息。 */
function message(patch: Partial<ThreadMessageView>): ThreadMessageView {
  return { id: 'm', thread: 'ptp_1', from: 'owner', fromName: '主人', fromColor: null, kind: 'chat', text: 'x', createdAt: 1, timeText: '刚刚', card: null, ...patch }
}

describe('认主题和找主题', () => {
  it('ptp_ 开头的是主题', () => {
    expect(isTopicThreadId('ptp_abc')).toBe(true)
  })

  it('反例：团队线程和队友 id 不是', () => {
    expect(isTopicThreadId('team')).toBe(false)
    expect(isTopicThreadId('b_123')).toBe(false)
  })

  it('能找到主题和它所在的项目', () => {
    expect(findTopic(fixtureProject, 'ptp_weekly_price')?.row.project.id).toBe('prj_weekly')
  })

  it('反例：查不到、视图没到、形状不对都返回 null', () => {
    expect(findTopic(fixtureProject, 'ptp_nope')).toBeNull()
    expect(findTopic(null, 'ptp_weekly_price')).toBeNull()
    expect(findTopic({} as typeof fixtureProject, 'ptp_weekly_price')).toBeNull()
  })
})

describe('楼层怎么分', () => {
  it('第一条是主题卡片，「N 条回复」只算人说的话', () => {
    const model = buildTopicThread(priceThread.messages, false)
    expect(model.opening?.id).toBe(priceThread.messages[0]!.id)
    expect(model.floors).toHaveLength(4)
    expect(model.replyCount).toBe(3)
    expect(model.countText).toBe('3 条回复')
  })

  it('反例：还有更早的没加载时，第一条不是主题原文，不当卡片，文案也要说清', () => {
    const model = buildTopicThread(priceThread.messages, true)
    expect(model.opening).toBeNull()
    expect(model.floors).toHaveLength(5)
    expect(model.countText).toBe('最近 4 条回复，更早的在「更多」里')
  })

  it('反例：第一条不是主人说的，也不当卡片', () => {
    expect(buildTopicThread([message({ from: 'b_1' })], false).opening).toBeNull()
  })

  it('到上限的提示能认出来，别的提示不算', () => {
    expect(isTopicCapNote(sourcesThread.messages.at(-1)!)).toBe(true)
    expect(isTopicCapNote({ text: '点名的 老周 这次没有叫醒。' })).toBe(false)
  })
})

describe('谁在回复', () => {
  const bot = (patch: Partial<BotCard>) => ({ id: 'bot-tanlu', name: '探路', activity: 'thinking', activityText: '正在处理：回复主题「选题」', ...patch }) as BotCard

  it('成员正在这个主题上跑或排队：列出名字', () => {
    expect(topicReplyingNames(weekly, '选题', [bot({})])).toEqual(['探路'])
    expect(topicReplyingNames(weekly, '选题', [bot({ activity: 'queued', activityText: '接着讨论主题「选题」' })])).toEqual(['探路'])
  })

  it('反例：在忙别的事、不是成员、没在忙，都不算', () => {
    expect(topicReplyingNames(weekly, '选题', [bot({ activityText: '正在处理：回复主题「别的」' })])).toEqual([])
    expect(topicReplyingNames(weekly, '选题', [bot({ id: 'b_outside' })])).toEqual([])
    expect(topicReplyingNames(weekly, '选题', [bot({ activity: 'watching' })])).toEqual([])
  })

  it('主题名很长时按 core 的规则截断后比对', () => {
    const title = '长'.repeat(50)
    expect(topicReplyingNames(weekly, title, [bot({ activityText: `回复主题「${'长'.repeat(40)}…」` })])).toEqual(['探路'])
  })
})

describe('聊天页要的信息', () => {
  const found = findTopic(fixtureProject, 'ptp_weekly_price')

  it('项目名、默认发给谁、能 @ 的成员（不排除任何人）', () => {
    const info = topicPaneInfo(found, null, fixtureOverview.bots)
    expect(info.projectName).toBe('竞品周报自动化')
    expect(info.placeholder).toBe('默认发给 探路，@ 可以点名…')
    expect(info.members.map(member => member.name)).toEqual(['探路', '巡检员'])
    expect(info.readOnlyText).toBeNull()
  })

  it('项目不在进行中：给一句说明，不显示输入框', () => {
    const paused = { row: { ...found!.row, project: { ...found!.row.project, status: 'paused' as const } }, topic: found!.topic }
    expect(topicPaneInfo(paused, null, []).readOnlyText).toContain('暂停')
  })

  it('反例：项目视图还没到，用线程标题先撑起来', () => {
    expect(topicPaneInfo(null, '线程标题', [])).toMatchObject({ title: '线程标题', projectName: '', members: [] })
  })
})

describe('openNewTopic：开一个主题并进去', () => {
  function hubWith(result: unknown) {
    const calls: string[] = []
    return {
      calls,
      command: vi.fn(async () => { calls.push('command'); return result as { ok: true } }),
      refreshProject: vi.fn(async () => { calls.push('refresh') }),
      selectThread: vi.fn((id: string) => { calls.push(`select:${id}`) }),
    }
  }

  it('成功：发命令、先刷新项目视图、再进主题，返回 null', async () => {
    const hub = hubWith({ ok: true, data: { topicId: 'ptp_1' } })
    expect(await openNewTopic(hub, 'prj_1', '第一句')).toBeNull()
    expect(hub.command).toHaveBeenCalledWith('createProjectTopic', { projectId: 'prj_1', text: '第一句' })
    expect(hub.calls).toEqual(['command', 'refresh', 'select:ptp_1'])
  })

  it('反例：core 报错时把中文原因带回来，不进主题', async () => {
    const hub = hubWith({ ok: false, error: '项目暂停中' })
    expect(await openNewTopic(hub, 'prj_1', 'x')).toBe('项目暂停中')
    expect(hub.selectThread).not.toHaveBeenCalled()
  })

  it('反例：成功但没给 topicId（旧宿主）：说清楚，不进一个空线程', async () => {
    const hub = hubWith({ ok: true })
    expect(await openNewTopic(hub, 'prj_1', 'x')).toContain('没有建成')
    expect(hub.selectThread).not.toHaveBeenCalled()
  })

  it('命令抛错也不往外抛：转成中文原因', async () => {
    const hub = hubWith({ ok: true })
    hub.command.mockRejectedValueOnce(new Error('断了'))
    expect(await openNewTopic(hub, 'prj_1', 'x')).toBe('断了')
  })
})

describe('样例模式也能开主题', () => {
  it('createProjectTopic 返回 topicId，项目视图和线程都能查到', async () => {
    const hub = new FixtureHub()
    const result = await hub.command('createProjectTopic', { projectId: 'prj_weekly', text: '新话题\n第二行' })
    expect(result.ok).toBe(true)
    const topicId = (result as { data: { topicId: string } }).data.topicId
    expect(isTopicThreadId(topicId)).toBe(true)
    const row = (await hub.project()).projects[0]!
    expect(row.topics[0]).toMatchObject({ id: topicId, title: '新话题' })
    expect((await hub.thread(topicId)).messages[0]!.text).toBe('新话题\n第二行')
    for (const timer of hub.pendingTimers) clearTimeout(timer)
  })

  it('反例：暂停的项目开不了', async () => {
    const hub = new FixtureHub()
    const result = await hub.command('createProjectTopic', { projectId: 'prj_migrate', text: 'x' })
    expect(result.ok).toBe(false)
  })

  it('标已读后主题的未读清零', async () => {
    const hub = new FixtureHub()
    await hub.command('markThreadRead', { threadId: 'ptp_weekly_sources' })
    expect((await hub.project()).projects[0]!.topics.find(item => item.id === 'ptp_weekly_sources')?.unread).toBe(0)
  })
})

describe('ThreadPane 的主题模式', () => {
  const info = topicPaneInfo(findTopic(fixtureProject, 'ptp_weekly_price'), null, fixtureOverview.bots)

  function paneProps(thread: ThreadView, patch: Partial<Parameters<typeof ThreadPane>[0]> = {}): Parameters<typeof ThreadPane>[0] {
    return {
      threadId: thread.threadId, thread, loading: false,
      header: { name: info.title, roleLabel: null, activityText: null, nextThinkText: null, lifecycle: null, thinking: false },
      inputPlaceholderName: '队友', banner: null, onBannerDismiss: () => undefined, onLoadEarlier: () => undefined,
      onSend: async () => undefined, actions: { onPick: async () => null }, busyInboxId: null, onRetry: () => undefined, error: null,
      onTeach: () => undefined, onOpenSession: () => undefined, onTogglePause: () => undefined, onInterrupt: () => undefined,
      topic: info, ...patch,
    }
  }

  it('头部是主题名和项目名，楼层交给群聊样式', () => {
    const tree = createHookHost().render(ThreadPane, paneProps(priceThread))
    expect(textOf(tree)).toContain('竞品周报自动化')
    expect(findElements(tree, TopicThreadBody)).toHaveLength(1)
  })

  it('占位写默认发给谁，能 @ 项目成员', () => {
    const tree = createHookHost().render(ThreadPane, paneProps(priceThread))
    expect(findElements(tree, 'textarea')[0]!.props.placeholder).toBe('默认发给 探路，@ 可以点名…')
    expect(textOf(tree)).toContain('@ 队友')
  })

  it('反例：私聊没有 @ 入口，也不用群聊楼层', () => {
    const tree = createHookHost().render(ThreadPane, paneProps(priceThread, { topic: null }))
    expect(textOf(tree)).not.toContain('@ 队友')
    expect(findElements(tree, TopicThreadBody)).toHaveLength(0)
  })

  it('「更多」只留主题用得上的：没有教它技能、打开工作会话、暂停', () => {
    const tree = createHookHost().render(ThreadPane, paneProps({ ...priceThread, hasMore: true }))
    const more = textOf(tree)
    expect(more).toContain('加载更早')
    for (const gone of ['教它技能', '打开工作会话', '暂停', '打断']) expect(more).not.toContain(gone)
  })

  it('项目不在进行中：换成一句说明，没有输入框', () => {
    const tree = createHookHost().render(ThreadPane, paneProps(priceThread, { topic: { ...info, readOnlyText: '项目暂停中，恢复后才能接着讨论。' } }))
    expect(textOf(tree)).toContain('项目暂停中')
    expect(findElements(tree, 'textarea')).toHaveLength(0)
  })
})

describe('TopicThreadBody：楼层', () => {
  const render = (thread: ThreadView, replying: string[] = []): unknown =>
    TopicThreadBody({ model: buildTopicThread(thread.messages, false), replying, actions: { onPick: async () => null }, busyInboxId: null })

  it('有主题卡片和「N 条回复」，正在回复的人能看出来', () => {
    const tree = render(priceThread, ['探路'])
    expect(textOf(tree)).toContain('3 条回复')
    expect(textOf(tree)).toContain('探路 正在回复…')
  })

  it('反例：没人在回复时不显示那一行', () => {
    expect(textOf(render(priceThread))).not.toContain('正在回复')
  })
})

describe('左栏项目行的加号', () => {
  function groupWith(status: 'active' | 'paused' | 'done', topics: WorkspacesGroupProps['projects'][number]['topics'] = []): unknown {
    return WorkspacesGroup({
      expanded: true, onToggle: () => undefined, projectUnloaded: false, selectedThread: '', clipped: false, canNewProject: true,
      onNewProject: () => undefined, onToggleProject: () => undefined, onOpenProject: () => undefined, onOpenProjectForm: () => undefined,
      onOpenTopic: () => undefined, rowsRef: { current: null }, form: null, formNode: null,
      projects: [{ projectId: 'prj_1', name: '周报', status, topicCount: topics.length, topics, expanded: true, active: false }],
    })
  }
  const addButtons = (tree: unknown): StubElement[] => findElements(tree, 'button').filter(node => node.props.className === 'ah-nav-row-add')

  it('进行中的项目有加号，空态也指向它', () => {
    const tree = groupWith('active')
    expect(addButtons(tree)).toHaveLength(1)
    expect(textOf(tree)).toContain('暂无会话。点击项目行「＋」新建。')
  })

  it('反例：暂停、已完成的项目开不了主题，不放一个写完一句话才报错的加号', () => {
    for (const status of ['paused', 'done'] as const) {
      const tree = groupWith(status)
      expect(addButtons(tree)).toHaveLength(0)
      expect(textOf(tree)).toContain('暂无会话。')
      expect(textOf(tree)).not.toContain('＋」新建')
    }
  })

  it('有未读的主题带一个点，读过的不带', () => {
    const topic = { id: 'ptp_1', projectId: 'prj_1', title: '选题', preview: null }
    const dots = (unread: number): number => findElements(groupWith('active', [{ ...topic, unread }]), 'span').filter(node => node.props.className === 'ah-nav-topic-unread').length
    expect(dots(2)).toBe(1)
    expect(dots(0)).toBe(0)
  })
})

describe('ProjectPage：只留四块', () => {
  beforeEach(() => { vi.stubGlobal('window', { addEventListener: () => undefined, removeEventListener: () => undefined }) })
  afterEach(() => { vi.unstubAllGlobals() })

  function pageProps(patch: Partial<Parameters<typeof ProjectPage>[0]> = {}): Parameters<typeof ProjectPage>[0] {
    return {
      project: fixtureProject, loading: false, onRetry: () => undefined, run: async () => ({ ok: true }), onRefresh: () => undefined,
      bots: fixtureOverview.bots.map(bot => ({ id: bot.id, name: bot.name, lifecycle: bot.lifecycle, role: bot.role })),
      selectedProjectId: 'prj_weekly', onSelectProject: () => undefined, onOpenTopic: () => undefined, onNewTopic: () => undefined,
      ...patch,
    }
  }
  const sections = (tree: unknown): unknown[] => findElements(tree, 'section').map(node => node.props['aria-label'])
  /** 四块内容在页内子组件 ProjectBoard 里，宿主不展开子组件，这里取出元素直接调用。 */
  const boardOf = (tree: unknown): unknown => {
    const element = findElements(tree, ProjectBoard)[0]!
    return ProjectBoard(element.props as Parameters<typeof ProjectBoard>[0])
  }
  const buttonNamed = (tree: unknown, label: string): StubElement => findElements(tree, 'button').find(node => textOf(node) === label)!

  it('选中项目：四块内容，顶部是项目名、新开会话、编辑', () => {
    const tree = createHookHost().render(ProjectPage, pageProps())
    expect(sections(boardOf(tree))).toEqual(['有哪些队友', '当前事务清单', '项目背景', '项目文件路径'])
    expect(textOf(tree)).toContain('竞品周报自动化')
    expect(buttonNamed(tree, '新开会话')).toBeDefined()
    expect(buttonNamed(tree, '编辑')).toBeDefined()
  })

  it('反例：看板、派活、验收这些都不在了', () => {
    const tree = createHookHost().render(ProjectPage, pageProps())
    const text = textOf(tree) + textOf(boardOf(tree))
    for (const gone of ['看板', '派活', '改派', '催办', '待领', '验收通过', '驳回', '关联唤醒', '新任务', '原始版本', '共享上下文']) expect(text).not.toContain(gone)
  })

  it('有主题的事务点一下进主题；没有主题的不是按钮', () => {
    const onOpenTopic = vi.fn()
    const board = boardOf(createHookHost().render(ProjectPage, pageProps({ onOpenTopic })))
    ;(buttonNamed(board, '抓取本周竞品动态探路进行中').props.onClick as () => void)()
    expect(onOpenTopic).toHaveBeenCalledWith('ptp_weekly_price')
    expect(findElements(board, 'button').some(node => textOf(node).startsWith('整理历史发布记录格式'))).toBe(false)
  })

  it('没选项目：项目名列表，点一下选中', () => {
    const onSelectProject = vi.fn()
    const tree = createHookHost().render(ProjectPage, pageProps({ selectedProjectId: null, onSelectProject }))
    expect(textOf(tree)).toContain('旧版数据迁移')
    ;(buttonNamed(tree, '旧版数据迁移已暂停').props.onClick as () => void)()
    expect(onSelectProject).toHaveBeenCalledWith('prj_migrate')
  })

  it('选中的项目已经不在了：退回项目名列表，不是空白页', () => {
    expect(textOf(createHookHost().render(ProjectPage, pageProps({ selectedProjectId: 'prj_nope' })))).toContain('旧版数据迁移')
  })

  // P60（2026-11-10）主人改了交互：「新开会话」不再弹「先写一句」的输入框，直接进草稿主题（空聊天）。
  // 原用例「新开会话用和左栏同一个输入，提交后开主题」测的是被拿掉的输入框，按新交互改写。
  it('新开会话直接进草稿：交出项目 id，不弹输入框，也不发任何命令', () => {
    const onNewTopic = vi.fn()
    const run = vi.fn(async () => ({ ok: true as const }))
    const host = createHookHost()
    const props = pageProps({ onNewTopic, run })
    ;(buttonNamed(host.render(ProjectPage, props), '新开会话').props.onClick as () => void)()
    expect(onNewTopic).toHaveBeenCalledWith('prj_weekly')
    expect(findElements(host.render(ProjectPage, props), SidebarSessionForm)).toHaveLength(0)
    expect(run).not.toHaveBeenCalled()
  })

  it('反例：暂停的项目不给新开会话，已归档的换成恢复项目', () => {
    expect(buttonNamed(createHookHost().render(ProjectPage, pageProps({ selectedProjectId: 'prj_migrate' })), '新开会话')).toBeUndefined()
    const archived = createHookHost().render(ProjectPage, pageProps({ selectedProjectId: 'prj_old' }))
    expect(buttonNamed(archived, '恢复项目')).toBeDefined()
    expect(buttonNamed(archived, '编辑')).toBeUndefined()
  })

  it('保存新项目：先存项目，再存背景，然后选中它', async () => {
    const run = vi.fn(async (name: string) => (name === 'saveProject' ? { ok: true as const, data: { id: 'prj_new' } } : { ok: true as const }))
    const onProjectSaved = vi.fn()
    const host = createHookHost()
    const props = pageProps({ selectedProjectId: null, run, onProjectSaved })
    ;(buttonNamed(host.render(ProjectPage, props), '＋ 新项目').props.onClick as () => void)()
    const dialog = findElements(host.render(ProjectPage, props), ProjectFormDialog)[0]!
    ;(dialog.props.onSubmit as (values: object) => void)({ name: '新项目', ownerBotId: 'bot-tanlu', memberBotIds: ['bot-tanlu'], sharedDir: '', background: '背景' })
    await vi.waitFor(() => expect(onProjectSaved).toHaveBeenCalledWith('prj_new'))
    expect(run.mock.calls.map(call => call[0])).toEqual(['saveProject', 'saveProjectContext'])
  })

  it('反例：项目存上了、背景失败：弹窗转成编辑这个项目，重试不会多建一个', async () => {
    const run = vi.fn(async (name: string) => (name === 'saveProject' ? { ok: true as const, data: { id: 'prj_weekly' } } : { ok: false as const, error: '磁盘满了' }))
    const host = createHookHost()
    const props = pageProps({ selectedProjectId: null, run })
    ;(buttonNamed(host.render(ProjectPage, props), '＋ 新项目').props.onClick as () => void)()
    ;(findElements(host.render(ProjectPage, props), ProjectFormDialog)[0]!.props.onSubmit as (values: object) => void)({ name: '新', ownerBotId: 'bot-tanlu', memberBotIds: ['bot-tanlu'], sharedDir: '', background: '背景' })
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(findElements(host.render(ProjectPage, props), ProjectFormDialog)[0]!.props.error).toContain('磁盘满了'))
    expect((findElements(host.render(ProjectPage, props), ProjectFormDialog)[0]!.props.editing as { project: { id: string } }).project.id).toBe('prj_weekly')
  })
})

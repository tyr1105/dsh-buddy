/**
 * 选中的队友已不存在时，界面仓库的行为（看板 P58）。
 * 用真实的 createHubStore 和假后端跑，断言落在两件事上：选中有没有被清、
 * 有没有再用这个 id 发请求。事件顺序和真实 core 的 deleteArchivedBot 一致。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHubStore, type HubStore } from '../src/client/hub-state.js'
import { DisabledHub } from '../src/host/real-hub.js'
import { fakeRosterBackend, settle } from './helpers/fake-roster-backend.js'

afterEach(() => { vi.unstubAllGlobals() })

/** 和入口文件一样，把上次记住的选中回填进仓库：这是「从本地恢复」的唯一写法。 */
function restoredHub(threadId: string, view: 'main' | 'project' = 'main'): HubStore {
  const hub = createHubStore()
  hub.update(prev => ({ ...prev, view, selectedThread: threadId }))
  return hub
}

/** 建一个已经读到名册、主人选中了某位队友的仓库，并清空请求记录。 */
async function hubViewing(backend: ReturnType<typeof fakeRosterBackend>, botId: string): Promise<HubStore> {
  const hub = createHubStore()
  await hub.refreshOverview()
  hub.selectThread(botId)
  await settle()
  backend.calls.length = 0
  return hub
}

/** core 删除队友时发的三条事件，顺序也一样。 */
function emitDeleted(hub: HubStore, botId: string): void {
  hub.onChanged({ scope: 'bot', botId })
  hub.onChanged({ scope: 'overview' })
  hub.onChanged({ scope: 'office' })
}

describe('本地记住了已不存在的队友', () => {
  it('名册到手后退回团队全景，不算连接问题', async () => {
    fakeRosterBackend(['b_1'])
    const hub = restoredHub('b_gone')
    await hub.refreshOverview()
    const state = hub.getSnapshot()
    expect(state.selectedThread).toBe('team')
    expect(state.connectionDown).toBe(false)
    expect(state.selectionExitSeq).toBe(1)
  })

  it('名册到手前也不用这个 id 发请求，包括推送第一次连上时的补拉', async () => {
    const backend = fakeRosterBackend(['b_1'])
    backend.pauseOverview = true
    const hub = restoredHub('b_gone')
    hub.onReconnected()
    await hub.refreshThread('b_gone')
    await hub.refreshBot('b_gone')
    await settle()
    expect(backend.byId('bot', 'b_gone')).toEqual([])
    expect(backend.byId('thread', 'b_gone')).toEqual([])

    backend.pauseOverview = false
    backend.releaseOverviews()
    await settle()
    expect(hub.getSnapshot().selectedThread).toBe('team')
    expect(backend.byId('bot', 'b_gone')).toEqual([])
    expect(backend.byId('thread', 'b_gone')).toEqual([])
  })

  it('退出之后再来这个 id 的事件，也不再请求（这个 id 从没在这次的名册里出现过）', async () => {
    const backend = fakeRosterBackend(['b_1'])
    const hub = restoredHub('b_gone')
    await hub.refreshOverview()
    hub.onChanged({ scope: 'bot', botId: 'b_gone' })
    await settle()
    expect(backend.byId('bot', 'b_gone')).toEqual([])
  })

  it('反例：记住的队友还在，名册到手后不清选中，也能正常请求', async () => {
    const backend = fakeRosterBackend(['b_1'])
    const hub = restoredHub('b_1')
    await hub.refreshOverview()
    await hub.refreshBot('b_1')
    expect(hub.getSnapshot().selectedThread).toBe('b_1')
    expect(hub.getSnapshot().selectionExitSeq).toBe(0)
    expect(backend.byId('bot', 'b_1')).toHaveLength(1)
    expect(hub.getSnapshot().bots.b_1).toBeDefined()
  })

  it('主人停在项目页：选中清掉，但不把他从项目页拽走', async () => {
    fakeRosterBackend(['b_1'])
    const hub = restoredHub('b_gone', 'project')
    await hub.refreshOverview()
    expect(hub.getSnapshot().selectedThread).toBe('team')
    expect(hub.getSnapshot().view).toBe('project')
  })
})

describe('对话开着时队友被删除', () => {
  it('删除事件带着它的 id：先看新名册，不发注定失败的详情请求，也不闪「连不上」', async () => {
    const backend = fakeRosterBackend(['b_1', 'b_2'])
    const hub = await hubViewing(backend, 'b_1')
    backend.roster = backend.roster.filter(row => row.id !== 'b_1')
    const downFlashes: boolean[] = []
    hub.subscribe(() => { if (hub.getSnapshot().connectionDown) downFlashes.push(true) })

    emitDeleted(hub, 'b_1')
    await settle()

    expect(backend.byId('bot', 'b_1')).toEqual([])
    expect(hub.getSnapshot().selectedThread).toBe('team')
    expect(downFlashes).toEqual([])
  })

  it('退出之后再来这个 id 的事件，详情和对话都不再请求', async () => {
    const backend = fakeRosterBackend(['b_1'])
    const hub = await hubViewing(backend, 'b_1')
    backend.roster = []
    emitDeleted(hub, 'b_1')
    await settle()
    backend.calls.length = 0

    hub.onChanged({ scope: 'bot', botId: 'b_1' })
    hub.onChanged({ scope: 'thread', botId: 'b_1' })
    hub.onChanged({ scope: 'ledger', botId: 'b_1' })
    await settle()

    expect(backend.byId('bot', 'b_1')).toEqual([])
    expect(backend.byId('thread', 'b_1')).toEqual([])
  })

  it('反例：别的队友的事件照常拉详情（排在名册之后，但不能漏）', async () => {
    const backend = fakeRosterBackend(['b_1', 'b_2'])
    const hub = await hubViewing(backend, 'b_1')
    hub.onChanged({ scope: 'bot', botId: 'b_2' })
    await settle()
    expect(backend.byId('bot', 'b_2')).toHaveLength(1)
    expect(hub.getSnapshot().selectedThread).toBe('b_1')
  })
})

describe('断线重连', () => {
  it('断线期间数据被清空：重连后不再按旧 id 补拉，退回团队全景', async () => {
    const backend = fakeRosterBackend(['b_1'])
    const hub = await hubViewing(backend, 'b_1')
    backend.roster = []
    hub.onReconnected()
    await settle()
    expect(backend.byId('bot', 'b_1')).toEqual([])
    expect(backend.byId('thread', 'b_1')).toEqual([])
    expect(hub.getSnapshot().selectedThread).toBe('team')
  })

  it('反例：队友还在，重连后照常补拉它的详情和对话', async () => {
    const backend = fakeRosterBackend(['b_1'])
    const hub = await hubViewing(backend, 'b_1')
    hub.onReconnected()
    await settle()
    expect(backend.byId('bot', 'b_1')).toHaveLength(1)
    expect(backend.byId('thread', 'b_1')).toHaveLength(1)
    expect(hub.getSnapshot().selectedThread).toBe('b_1')
  })
})

describe('按 id 的请求失败时，用名册核实', () => {
  it('错误文案换成什么都行：名册说没了就安静退出，不标连不上', async () => {
    const backend = fakeRosterBackend(['b_1'])
    backend.missingBotError = '一句和现在完全不同的错误文案'
    const hub = await hubViewing(backend, 'b_1')
    backend.roster = []
    await hub.refreshBot('b_1')
    expect(hub.getSnapshot().selectedThread).toBe('team')
    expect(hub.getSnapshot().connectionDown).toBe(false)
  })

  it('反例：错误文案写着不存在，但名册里还有它，不清选中', async () => {
    const backend = fakeRosterBackend(['b_1'])
    backend.botFailure = 'botId：机器人不存在'
    const hub = await hubViewing(backend, 'b_1')
    await hub.refreshBot('b_1')
    expect(hub.getSnapshot().selectedThread).toBe('b_1')
    expect(hub.getSnapshot().connectionDown).toBe(true)
  })

  it('没被选中的队友查不到：不动当前选中，之后也不再请求它', async () => {
    const backend = fakeRosterBackend(['b_1'])
    const hub = await hubViewing(backend, 'b_1')
    await hub.refreshBot('b_gone')
    expect(hub.getSnapshot().selectedThread).toBe('b_1')
    expect(hub.getSnapshot().connectionDown).toBe(false)
    expect(backend.byId('bot', 'b_gone')).toHaveLength(1)
    await hub.refreshBot('b_gone')
    expect(backend.byId('bot', 'b_gone')).toHaveLength(1)
  })
})

describe('反例：名册不可用时不能清选中', () => {
  it('网络断开：详情和总览都失败，选中不动，按连不上处理', async () => {
    const backend = fakeRosterBackend(['b_1'])
    const hub = await hubViewing(backend, 'b_1')
    backend.offline = true
    await hub.refreshBot('b_1')
    await hub.refreshOverview()
    expect(hub.getSnapshot().selectedThread).toBe('b_1')
    expect(hub.getSnapshot().connectionDown).toBe(true)
  })

  it('引擎还没起来：恢复的选中保留；起来后名册里有它，继续留在这条对话', async () => {
    const backend = fakeRosterBackend(['b_1'])
    backend.overviewFailure = '中心引擎尚未就绪，请稍后重试'
    const hub = restoredHub('b_1')
    await hub.refreshOverview()
    expect(hub.getSnapshot().selectedThread).toBe('b_1')
    expect(hub.getSnapshot().downReason).toBe('starting')

    backend.overviewFailure = null
    await hub.refreshOverview()
    expect(hub.getSnapshot().selectedThread).toBe('b_1')
    expect(hub.getSnapshot().connectionDown).toBe(false)
  })

  it('总览还没加载：什么都不清', () => {
    fakeRosterBackend(['b_1'])
    const hub = restoredHub('b_gone')
    expect(hub.getSnapshot().selectedThread).toBe('b_gone')
  })

  it('这次总览加载失败：沿用上一份成功的名册，选中不动', async () => {
    const backend = fakeRosterBackend(['b_1'])
    const hub = await hubViewing(backend, 'b_1')
    backend.roster = []
    backend.overviewFailure = '总览查询失败'
    await hub.refreshOverview()
    expect(hub.getSnapshot().selectedThread).toBe('b_1')
    expect(hub.getSnapshot().overview?.bots).toHaveLength(1)
  })

  it('中心已停用：总览是 200 的空占位，选中不动，恢复后还在原来的对话', async () => {
    const backend = fakeRosterBackend(['b_1'])
    backend.overviewOverride = await new DisabledHub('中心已停用').overview()
    const hub = restoredHub('b_1')
    await hub.refreshOverview()
    expect(hub.getSnapshot().overview?.bots).toEqual([])
    expect(hub.getSnapshot().selectedThread).toBe('b_1')
    expect(hub.getSnapshot().selectionExitSeq).toBe(0)

    backend.overviewOverride = null
    await hub.refreshOverview()
    expect(hub.getSnapshot().selectedThread).toBe('b_1')
    await hub.refreshBot('b_1')
    expect(hub.getSnapshot().bots.b_1).toBeDefined()
  })

  it('已经开着对话时中心被停用：之前的选中也不被占位名册清掉', async () => {
    const backend = fakeRosterBackend(['b_1'])
    const hub = await hubViewing(backend, 'b_1')
    backend.overviewOverride = await new DisabledHub('中心已停用').overview()
    await hub.refreshOverview()
    expect(hub.getSnapshot().selectedThread).toBe('b_1')
  })
})

describe('反例：还在名册里的、不是队友的', () => {
  it('队友只是退役并归档：名册里还有它，不清选中，详情和对话照常请求', async () => {
    const backend = fakeRosterBackend([])
    backend.roster = [{ id: 'b_old', lifecycle: 'retired', archived: true }]
    const hub = await hubViewing(backend, 'b_old')
    await hub.refreshOverview()
    await hub.refreshBot('b_old')
    await hub.refreshThread('b_old')
    expect(hub.getSnapshot().selectedThread).toBe('b_old')
    expect(hub.getSnapshot().selectionExitSeq).toBe(0)
    expect(backend.byId('bot', 'b_old')).toHaveLength(1)
    expect(backend.byId('thread', 'b_old')).toHaveLength(1)
  })

  it('选中团队线程：名册空着也不受影响，团队对话照常请求', async () => {
    const backend = fakeRosterBackend([])
    const hub = createHubStore()
    await hub.refreshOverview()
    await hub.refreshThread('team')
    expect(hub.getSnapshot().selectedThread).toBe('team')
    expect(hub.getSnapshot().selectionExitSeq).toBe(0)
    expect(backend.byId('thread', 'team')).toHaveLength(1)
  })
})

describe('名册和选中的先后', () => {
  it('反例：刚建好的队友，晚到的旧名册里没有它，不能把主人踢出去', async () => {
    const backend = fakeRosterBackend(['b_old'])
    const hub = createHubStore()
    await hub.refreshOverview()
    backend.pauseOverview = true
    const stale = hub.refreshOverview()
    await settle()

    backend.roster.push({ id: 'b_new', lifecycle: 'probation' })
    hub.selectThread('b_new')
    await settle()
    backend.pauseOverview = false
    backend.releaseOverviews()
    await stale
    await settle()

    expect(hub.getSnapshot().selectedThread).toBe('b_new')
    expect(hub.getSnapshot().selectionExitSeq).toBe(0)
  })

  it('正例：请求发出后才点选，但它原来在名册里、新名册里没了，确实是被删了', async () => {
    const backend = fakeRosterBackend(['b_1'])
    const hub = createHubStore()
    await hub.refreshOverview()
    backend.roster = []
    backend.pauseOverview = true
    const inFlight = hub.refreshOverview()
    await settle()
    hub.selectThread('b_1')
    backend.pauseOverview = false
    backend.releaseOverviews()
    await inFlight
    expect(hub.getSnapshot().selectedThread).toBe('team')
  })

  it('晚到的旧名册不覆盖更新的名册，被删的队友不会闪回来', async () => {
    const backend = fakeRosterBackend(['b_1'])
    const hub = createHubStore()
    backend.pauseOverview = true
    const older = hub.refreshOverview()
    await settle()
    backend.roster = []
    backend.pauseOverview = false
    await hub.refreshOverview()
    expect(hub.getSnapshot().overview?.bots).toEqual([])

    backend.releaseOverviews()
    await older
    expect(hub.getSnapshot().overview?.bots).toEqual([])
  })

  it('点了名册里查不到的队友：马上核对名册，确认没了就退回，不发标已读', async () => {
    const backend = fakeRosterBackend(['b_1'])
    const hub = createHubStore()
    await hub.refreshOverview()
    backend.calls.length = 0
    hub.selectThread('b_gone')
    await settle()
    expect(backend.calls.filter(path => path.startsWith('overview'))).toHaveLength(1)
    expect(backend.calls.filter(path => path.startsWith('command'))).toEqual([])
    expect(hub.getSnapshot().selectedThread).toBe('team')
  })

  it('反例：点名册里有的队友，只有标已读后那一次刷新，不额外核对名册', async () => {
    const backend = fakeRosterBackend(['b_1'])
    const hub = createHubStore()
    await hub.refreshOverview()
    backend.calls.length = 0
    hub.selectThread('b_1')
    await settle()
    expect(backend.calls.filter(path => path.startsWith('command'))).toHaveLength(1)
    expect(backend.calls.filter(path => path.startsWith('overview'))).toHaveLength(1)
    expect(hub.getSnapshot().selectedThread).toBe('b_1')
  })
})

/** 造一份只含主题 id 的项目视图：判断规则只看这一项。 */
function projectWith(...topicIds: string[]): unknown {
  return { asOf: 0, projects: [{ project: { status: 'active' }, topics: topicIds.map(id => ({ id, unread: 0 })) }], counts: {} }
}

describe('项目主题（P63）', () => {
  it('恢复的主题还在：名册和项目视图到手后都不退回，也不拿它去拉 /bot', async () => {
    const backend = fakeRosterBackend(['b_1'])
    backend.projectOverride = projectWith('ptp_1')
    const hub = restoredHub('ptp_1')
    await Promise.all([hub.refreshOverview(), hub.refreshProject()])
    await hub.refreshBot('ptp_1')
    await settle()
    expect(hub.getSnapshot().selectedThread).toBe('ptp_1')
    expect(hub.getSnapshot().selectionExitSeq).toBe(0)
    expect(backend.byId('bot', 'ptp_1')).toEqual([])
  })

  it('恢复的主题已不存在：项目视图到手后退回团队全景，不算连接问题', async () => {
    const backend = fakeRosterBackend(['b_1'])
    backend.projectOverride = projectWith('ptp_other')
    const hub = restoredHub('ptp_gone')
    await hub.refreshProject()
    expect(hub.getSnapshot().selectedThread).toBe('team')
    expect(hub.getSnapshot().connectionDown).toBe(false)
    expect(hub.getSnapshot().selectionExitSeq).toBe(1)
  })

  it('反例：项目视图还没到时，名册到手也不动选中的主题', async () => {
    fakeRosterBackend(['b_1'])
    const hub = restoredHub('ptp_1')
    await hub.refreshOverview()
    expect(hub.getSnapshot().selectedThread).toBe('ptp_1')
  })

  it('反例：中心停用时的占位视图不算数，本地记住的主题不被清掉', async () => {
    const backend = fakeRosterBackend(['b_1'])
    backend.projectOverride = { ...(projectWith() as object), projects: [], rosterUnavailable: true }
    const hub = restoredHub('ptp_1')
    await hub.refreshProject()
    expect(hub.getSnapshot().selectedThread).toBe('ptp_1')
  })

  it('进一个手头视图里没有的主题：马上重拉，确认没了就退回', async () => {
    const backend = fakeRosterBackend(['b_1'])
    backend.projectOverride = projectWith('ptp_1')
    const hub = createHubStore()
    await hub.refreshProject()
    backend.calls.length = 0
    hub.selectThread('ptp_gone')
    await settle()
    expect(backend.calls.filter(path => path.startsWith('project'))).toHaveLength(1)
    expect(hub.getSnapshot().selectedThread).toBe('team')
  })

  it('反例：刚建好的主题，发请求时还没有它的旧视图晚到，不把它判没了', async () => {
    const backend = fakeRosterBackend(['b_1'])
    backend.projectOverride = projectWith('ptp_1')
    const hub = createHubStore()
    await hub.refreshProject()
    // 把项目视图的响应扣住：内容在发请求那一刻就定了，这样才是真实的「旧视图」。
    const held: Array<() => void> = []
    const realFetch = globalThis.fetch
    vi.stubGlobal('fetch', (input: unknown) => {
      const response = realFetch(input as string)
      if (!String(input).includes('project')) return response
      return new Promise<Response>(resolve => { held.push(() => { void response.then(resolve) }) })
    })
    // 这份视图的请求在主人进新主题之前就发出去了，它当然不知道这个主题。
    const stale = hub.refreshProject()
    await settle()
    // 主题在 core 里建好，主人进去；进主题时手头视图里没有它，会马上再核对一次。
    backend.projectOverride = projectWith('ptp_1', 'ptp_new')
    hub.selectThread('ptp_new')
    await settle()
    expect(held).toHaveLength(2)
    // 旧视图先到：里面没有新主题，但它发得比这次选中早，不能据此退回。
    held[0]!()
    await stale
    await settle()
    expect(hub.getSnapshot().selectedThread).toBe('ptp_new')
    expect(hub.getSnapshot().selectionExitSeq).toBe(0)
    // 核对的那份视图到了：主题确实在，选中不动。
    held[1]!()
    await settle()
    expect(hub.getSnapshot().selectedThread).toBe('ptp_new')
    expect(hub.getSnapshot().selectionExitSeq).toBe(0)
    vi.stubGlobal('fetch', realFetch)
  })

  it('进主题时不标已读（页面摆出来才算读过），也不按名册核对', async () => {
    const backend = fakeRosterBackend(['b_1'])
    backend.projectOverride = projectWith('ptp_1')
    const hub = createHubStore()
    await Promise.all([hub.refreshOverview(), hub.refreshProject()])
    backend.calls.length = 0
    hub.selectThread('ptp_1')
    await settle()
    expect(backend.calls).toEqual([])
    expect(hub.getSnapshot().selectedThread).toBe('ptp_1')
    expect(hub.getSnapshot().view).toBe('main')
  })

  it('断线重连时当前选中是主题：补拉楼层，不拉 /bot', async () => {
    const backend = fakeRosterBackend(['b_1'])
    backend.projectOverride = projectWith('ptp_1')
    const hub = createHubStore()
    await Promise.all([hub.refreshOverview(), hub.refreshProject()])
    hub.selectThread('ptp_1')
    backend.calls.length = 0
    hub.onReconnected()
    await settle()
    expect(backend.byId('thread', 'ptp_1').length).toBeGreaterThan(0)
    expect(backend.byId('bot', 'ptp_1')).toEqual([])
    expect(hub.getSnapshot().selectedThread).toBe('ptp_1')
  })

  it('办公室动线一次读最近 100 次唤醒', async () => {
    const backend = fakeRosterBackend(['b_1'])
    const hub = createHubStore()
    await hub.wakeRows('b_1').catch(() => undefined)
    expect(backend.calls.some(path => path.startsWith('wake-ledger') && path.includes('limit=100'))).toBe(true)
  })
})

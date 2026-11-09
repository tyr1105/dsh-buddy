/**
 * 界面仓库测试（D05 第 12/13 条）：
 * - SSE 断开按 1/2/5/10 秒退避重连；重连成功清除断开态并补拉；只有连续 30 秒
 *   连不上才把整页标成「连不上」。
 * - 拉取失败时按错误文字识别「已停用 / 启动中」，页面显示对应提示而不是「连不上」。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHubStore, connectEvents, type HubStore } from '../src/client/hub-state.js'

/** 假 fetch：按路径返回配置的结果（成功 JSON 或错误）。 */
function stubFetch(handler: (url: string) => Promise<{ status: number; body: unknown }>) {
  const fetchCalls: string[] = []
  const fake = async (input: any, _init?: unknown) => {
    const url = String(input)
    fetchCalls.push(url)
    const result = await handler(url)
    return new Response(JSON.stringify(result.body), { status: result.status, headers: { 'Content-Type': 'application/json' } })
  }
  vi.stubGlobal('fetch', fake)
  return { fetchCalls }
}

/** 可操控的假 EventSource：手动触发 onopen/onerror，记录 close。 */
class FakeEventSource {
  static instances: FakeEventSource[] = []
  url: string
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  closed = false
  listeners = new Map<string, Array<(e: unknown) => void>>()
  constructor(url: string) { this.url = url; FakeEventSource.instances.push(this) }
  addEventListener(name: string, cb: (e: unknown) => void) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), cb]) }
  close() { this.closed = true }
  open() { this.onopen?.() }
  error() { this.onerror?.() }
  emit(name: string, data: unknown) { for (const cb of this.listeners.get(name) ?? []) cb({ data }) }
}

beforeEach(() => { FakeEventSource.instances = []; vi.stubGlobal('EventSource', FakeEventSource as unknown as typeof EventSource) })
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('connectEvents：退避重连与 30 秒阈值（D05 第 12 条）', () => {
  it('断开后按 1/2/5/10 秒重连；重连成功清除断开态并补拉全部、设置与当前线程（D07 第 28 条：断言真的拉了 thread?id=<选中线程>）', async () => {
    vi.useFakeTimers()
    const { fetchCalls } = stubFetch(async () => ({ status: 200, body: {} }))
    const hub = createHubStore()
    const refreshAll = vi.spyOn(hub, 'refreshAll')
    const close = connectEvents(hub)
    // 第一次连接成功。
    FakeEventSource.instances[0]!.open()
    expect(hub.getSnapshot().connectionDown).toBe(false)
    // 断线 1：不立刻标「连不上」，按 1 秒退避重连。
    FakeEventSource.instances[0]!.error()
    expect(hub.getSnapshot().connectionDown).toBe(false)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(FakeEventSource.instances.length).toBe(2)
    // 又断：2 秒后重连。
    FakeEventSource.instances[1]!.error()
    await vi.advanceTimersByTimeAsync(1_999)
    expect(FakeEventSource.instances.length).toBe(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(FakeEventSource.instances.length).toBe(3)
    // 重连成功：清除断开态并补拉。
    FakeEventSource.instances[2]!.error()
    await vi.advanceTimersByTimeAsync(5_000)
    FakeEventSource.instances.at(-1)!.open()
    expect(hub.getSnapshot().connectionDown).toBe(false)
    expect(refreshAll).toHaveBeenCalled()
    expect(fetchCalls.some(u => u.includes('overview'))).toBe(true)
    // D07 第 28 条：当前线程的补拉要真的发生（此前只断言了 refreshAll 被调）。
    expect(fetchCalls.some(u => u.includes('thread?id=team'))).toBe(true)
    expect(fetchCalls.some(u => u.includes('settings'))).toBe(true)
    close()
  })

  it('断线 5 秒、10 秒退避可推进；30 秒内连上都不显示「连不上」', async () => {
    vi.useFakeTimers()
    stubFetch(async () => ({ status: 200, body: {} }))
    const hub = createHubStore()
    const close = connectEvents(hub)
    let n = FakeEventSource.instances.length
    for (const wait of [1_000, 2_000, 5_000, 10_000]) {
      FakeEventSource.instances.at(-1)!.error()
      await vi.advanceTimersByTimeAsync(wait - 1)
      expect(FakeEventSource.instances.length).toBe(n) // 退避未到不重连
      await vi.advanceTimersByTimeAsync(1)
      expect(FakeEventSource.instances.length).toBe(n + 1)
      n += 1
    }
    // 累计已 18 秒：还没到 30 秒，页面不显示「连不上」。
    expect(hub.getSnapshot().connectionDown).toBe(false)
    FakeEventSource.instances.at(-1)!.open()
    expect(hub.getSnapshot().connectionDown).toBe(false)
    close()
  })

  it('连续 30 秒连不上才 markDown；恢复连接后清除', async () => {
    vi.useFakeTimers()
    stubFetch(async () => ({ status: 200, body: {} }))
    const hub = createHubStore()
    const close = connectEvents(hub)
    FakeEventSource.instances[0]!.error()
    await vi.advanceTimersByTimeAsync(29_999)
    expect(hub.getSnapshot().connectionDown).toBe(false)
    await vi.advanceTimersByTimeAsync(2)
    expect(hub.getSnapshot().connectionDown).toBe(true) // 30 秒到：整页提示
    FakeEventSource.instances.at(-1)!.open()
    expect(hub.getSnapshot().connectionDown).toBe(false)
    close()
  })
})

describe('guard：断开原因识别（D05 第 13 条）', () => {
  it('错误文字含「已停用」→ downReason=disabled', async () => {
    stubFetch(async (url) => url.includes('settings')
      ? { status: 500, body: { ok: false, error: '中心已停用：删除 <rootDir>/.hub/DISABLED 后重启 DSH 即可恢复' } }
      : { status: 200, body: {} })
    const hub = createHubStore()
    await hub.refreshSettings()
    const state = hub.getSnapshot()
    expect(state.connectionDown).toBe(true)
    expect(state.downReason).toBe('disabled')
  })
  it('错误文字含「尚未就绪」→ downReason=starting', async () => {
    stubFetch(async (url) => url.includes('thread')
      ? { status: 500, body: { ok: false, error: '中心引擎尚未就绪，请稍后重试' } }
      : { status: 200, body: {} })
    const hub = createHubStore()
    await hub.refreshThread('team')
    const state = hub.getSnapshot()
    expect(state.connectionDown).toBe(true)
    expect(state.downReason).toBe('starting')
  })
  it('普通网络错误 → downReason=null（显示通用「连不上」文案）', async () => {
    stubFetch(async () => { throw new Error('连不上 Agent 中心（网络错误）') })
    const hub: HubStore = createHubStore()
    await hub.refreshOverview()
    const state = hub.getSnapshot()
    expect(state.connectionDown).toBe(true)
    expect(state.downReason).toBeNull()
  })
  it('恢复成功后 connectionDown 与 downReason 一起清除', async () => {
    let fail = true
    stubFetch(async () => {
      if (fail) return { status: 500, body: { ok: false, error: '中心已停用：删除' } }
      return { status: 200, body: {} }
    })
    const hub = createHubStore()
    await hub.refreshSettings()
    expect(hub.getSnapshot().downReason).toBe('disabled')
    fail = false
    await hub.refreshSettings()
    const state = hub.getSnapshot()
    expect(state.connectionDown).toBe(false)
    expect(state.downReason).toBeNull()
  })
})

describe('refreshSettings：设置读不到不等于连不上（D07 第 2 条）', () => {
  it('视图 500（如模型目录坏了）→ 不标 connectionDown，settingsError 记中文原因', async () => {
    let broken = true
    stubFetch(async url => url.includes('settings')
      ? broken
        ? { status: 500, body: { ok: false, error: '模型目录读取失败：读取宿主模型目录失败：服务炸了' } }
        : { status: 200, body: { settings: {}, modelOptions: [], pushChannelOptions: [] } }
      : { status: 200, body: {} })
    const hub = createHubStore()
    await hub.refreshSettings()
    const state = hub.getSnapshot()
    expect(state.connectionDown).toBe(false)
    expect(state.downReason).toBeNull()
    expect(state.settingsError).toContain('模型目录读取失败')
    // 目录恢复后重试：错误清除。
    broken = false
    await hub.refreshSettings()
    expect(hub.getSnapshot().settingsError).toBeNull()
  })
  it('网络错误 / 尚未就绪 / 已停用 / 启动失败 仍然整页提示', async () => {
    for (const [error, reason] of [
      ['连不上 Agent 中心（网络错误）', null],
      ['中心引擎尚未就绪，请稍后重试', 'starting'],
      ['中心已停用：删除标记', 'disabled'],
      ['中心引擎启动失败：ENOTDIR', 'failed'],
    ] as const) {
      stubFetch(async () => ({ status: 500, body: { ok: false, error } }))
      const hub = createHubStore()
      await hub.refreshSettings()
      const state = hub.getSnapshot()
      expect(state.connectionDown).toBe(true)
      expect(state.downReason).toBe(reason)
      if (reason === 'failed') expect(state.downMessage).toContain('ENOTDIR')
      else expect(state.settingsError).toBeNull()
    }
  })
})

describe('refreshActivity：动态读不到不等于连不上（U01 第 32 轮）', () => {
  it('首屏 500 → 不标 connectionDown，activityError 记中文原因；再拉成功清掉', async () => {
    let broken = true
    stubFetch(async url => url.includes('activity')
      ? broken
        ? { status: 500, body: { ok: false, error: '动态查询失败：索引损坏' } }
        : { status: 200, body: { rows: [], hasMore: false } }
      : { status: 200, body: {} })
    const hub = createHubStore()
    await hub.refreshActivity()
    let state = hub.getSnapshot()
    expect(state.connectionDown).toBe(false)
    expect(state.activityError).toBe('动态查询失败：索引损坏')
    broken = false
    await hub.refreshActivity()
    state = hub.getSnapshot()
    expect(state.activityError).toBeNull()
    expect(state.activity).not.toBeNull()
  })
  it('网络错误仍然整页提示，activityError 不滥用', async () => {
    stubFetch(async () => ({ status: 500, body: { ok: false, error: '连不上 Agent 中心（网络错误）' } }))
    const hub = createHubStore()
    await hub.refreshActivity()
    const state = hub.getSnapshot()
    expect(state.connectionDown).toBe(true)
    expect(state.activityError).toBeNull()
  })
})

describe('onChanged：每种 scope 实际请求了哪些接口（D07 第 25 条）', () => {
  it('已知 scope + 未知 scope 的实际请求逐项断言（假 fetch）', async () => {
    vi.useFakeTimers()
    const { fetchCalls } = stubFetch(async url => {
      if (url.includes('overview')) return { status: 200, body: { bots: [] } }
      if (url.includes('inbox')) return { status: 200, body: { items: [] } }
      if (url.includes('activity')) return { status: 200, body: { rows: [], hasMore: false } }
      if (url.includes('settings')) return { status: 200, body: { settings: {}, modelOptions: [], pushChannelOptions: [] } }
      if (url.includes('bot?')) return { status: 200, body: { card: { id: 'b_1' } } }
      if (url.includes('thread')) return { status: 200, body: { threadId: 't', title: 't', messages: [], hasMore: false, oldestId: null } }
      return { status: 200, body: {} }
    })
    const hub = createHubStore()
    const pathsOf = (): string[] => fetchCalls.map(u => u.replace(/^.*agent-hub\//, '').split('?')[0]!)
    const cases: Array<{ event: { scope: string; botId?: string }; expectPaths: string[] }> = [
      // F03：总览/详情/账本/收件箱变化都会改变房间里的灯、桌面或门口，顺带刷办公室。
      // V2-PH2-04：overview/bot 同口径顺带刷资料授权矩阵（resource）。
      { event: { scope: 'overview', botId: 'b_1' }, expectPaths: ['overview', 'bot', 'office', 'resource'] },
      { event: { scope: 'bot', botId: 'b_1' }, expectPaths: ['overview', 'bot', 'office', 'resource'] },
      { event: { scope: 'thread', botId: 'b_1' }, expectPaths: ['overview', 'thread'] },
      { event: { scope: 'thread', botId: undefined }, expectPaths: ['overview', 'thread'] },
      { event: { scope: 'inbox' }, expectPaths: ['overview', 'inbox', 'office'] },
      { event: { scope: 'activity' }, expectPaths: ['activity'] },
      { event: { scope: 'settings' }, expectPaths: ['settings'] },
      { event: { scope: 'office' }, expectPaths: ['office'] },
      // V2-PH4-02：项目/任务变化刷总览计数并定向重拉项目页，不连带其它视图。
      { event: { scope: 'project' }, expectPaths: ['overview', 'project'] },
      { event: { scope: 'wakes' }, expectPaths: ['overview', 'activity'] },
    ]
    for (const { event, expectPaths } of cases) {
      fetchCalls.length = 0
      hub.onChanged({ scope: event.scope, botId: event.botId })
      await vi.advanceTimersByTimeAsync(0)
      await Promise.resolve()
      const got = pathsOf()
      for (const path of expectPaths) expect(got).toContain(path)
      expect([...new Set(got)].sort()).toEqual([...new Set(expectPaths)].sort())
    }
  })
})

describe('refreshBot / refreshThread：并发与合并（D07 第 9/14 条）', () => {
  it('两条 bot 推送挨着到：后返回的请求不会把另一台的新详情改回旧值（D07 第 9 条）', async () => {
    // 两个详情请求都延迟返回：旧实现先展开快照再 await，后写回的会覆盖先写回的。
    const versions: Record<string, number> = { b_1: 1, b_2: 1 }
    const pending: Array<() => void> = []
    stubFetch(async url => {
      const match = /bot\?id=(b_\d)/.exec(url)
      if (match === null) return { status: 200, body: {} }
      await new Promise<void>(resolve => { pending.push(resolve) })
      const id = match[1]!
      return { status: 200, body: { card: { id, lifecycle: versions[id] === 1 ? 'probation' : 'paused' } } }
    })
    const hub = createHubStore()
    const p1 = hub.refreshBot('b_1')
    const p2 = hub.refreshBot('b_2')
    await vi.waitFor(() => expect(pending.length).toBe(2))
    // b_2 先返回（旧值 probation），随后服务端把 b_1 变成 paused、b_1 的新详情返回。
    versions.b_1 = 2
    pending[1]!()
    await p2
    pending[0]!()
    await p1
    const bots = hub.getSnapshot().bots
    expect(bots.b_1?.card.lifecycle).toBe('paused')   // 新详情没有被旧快照覆盖
    expect(bots.b_2?.card.lifecycle).toBe('probation')
  })
  it('线程不带 before 的刷新按 id 合并：翻出来的更早历史不被最新一页冲掉（D07 第 14 条）', async () => {
    // 先给 60 条（首页 50 + 加载更早 10），再推送一条新消息（服务端只剩最新 50 页）。
    let total = 60
    const message = (i: number) => ({ id: `m_${i}`, thread: 'team', from: 'hub', fromName: '中心', fromColor: null, kind: 'system', text: `第 ${i} 条`, createdAt: i, timeText: '刚刚', card: null })
    stubFetch(async url => {
      if (!url.includes('thread')) return { status: 200, body: {} }
      const before = /before=(m_\d+)/.exec(url)?.[1]
      const all = Array.from({ length: total }, (_, i) => message(i + 1))
      let page: typeof all
      if (before === undefined) page = all.slice(-50)
      else page = all.slice(0, all.findIndex(m => m.id === before))
      return { status: 200, body: { threadId: 'team', title: '团队', messages: page, hasMore: page.length < all.length, oldestId: page[0]?.id ?? null } }
    })
    const hub = createHubStore()
    await hub.refreshThread('team')
    expect(hub.getSnapshot().threads.team?.messages).toHaveLength(50)
    await hub.refreshThread('team', 'm_11') // 加载更早：10 条历史 + 已有 50 条
    expect(hub.getSnapshot().threads.team?.messages).toHaveLength(60)
    expect(hub.getSnapshot().threads.team?.messages[0]?.id).toBe('m_1')
    // 新推送：最新一页（50 条）按 id 合并，60 条历史仍在，新消息追加。
    total = 61
    await hub.refreshThread('team')
    const merged = hub.getSnapshot().threads.team?.messages ?? []
    expect(merged).toHaveLength(61)
    expect(merged[0]?.id).toBe('m_1')
    expect(merged.at(-1)?.id).toBe('m_61')
  })
  it('切换线程时重置已加载历史；重复点同一线程不重置（D07 第 14 条）', async () => {
    stubFetch(async url => {
      if (!url.includes('thread')) return { status: 200, body: {} }
      const id = /thread\?id=(\w+)/.exec(url)?.[1] ?? 'team'
      return { status: 200, body: { threadId: id, title: id, messages: [{ id: `x_${id}`, thread: id, from: 'hub', fromName: '中心', fromColor: null, kind: 'system', text: 'hi', createdAt: 1, timeText: '刚刚', card: null }], hasMore: false, oldestId: null } }
    })
    const hub = createHubStore()
    await hub.refreshThread('b_1')
    expect(hub.getSnapshot().threads.b_1).toBeDefined()
    // 切进一个线程时重置它自己缓存的旧历史（回来要拿最新一页，不跨次拼接）。
    hub.selectThread('b_1')
    expect(hub.getSnapshot().threads.b_1).toBeUndefined()
    await hub.refreshThread('b_1')
    hub.selectThread('b_1')
    expect(hub.getSnapshot().threads.b_1).toBeDefined()     // 重复点同一线程不重置
  })
  it('SSE 重连后补拉当前机器人详情，其他已缓存详情标为过期（D07 第 13 条）', async () => {
    const bodies: Record<string, unknown> = {
      overview: { bots: [] }, settings: {}, activity: { rows: [], hasMore: false }, inbox: { items: [] },
    }
    stubFetch(async url => {
      for (const key of Object.keys(bodies)) if (url.includes(key)) return { status: 200, body: bodies[key] }
      if (url.includes('bot?id=b_sel')) return { status: 200, body: { card: { id: 'b_sel', lifecycle: 'paused' } } }
      if (url.includes('thread')) return { status: 200, body: { threadId: 'b_sel', title: '选中', messages: [], hasMore: false, oldestId: null } }
      return { status: 200, body: {} }
    })
    const hub = createHubStore()
    // 预置两台已缓存的详情与选中的线程。
    await Promise.all([hub.refreshBot('b_sel'), hub.refreshBot('b_other')])
    hub.selectThread('b_sel')
    hub.onReconnected()
    await vi.waitFor(() => expect(hub.getSnapshot().bots.b_sel).toBeDefined())
    const bots = hub.getSnapshot().bots
    expect(bots.b_sel?.card.lifecycle).toBe('paused')  // 当前机器人的详情被重拉
    expect(bots.b_other).toBeUndefined()               // 其他缓存被清（选中时 HubPage 会重拉）
  })
})

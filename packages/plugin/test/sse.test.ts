/** SSE：被拒时写状态码结束；接受时写 event-stream 头；变化时写 changed 事件；close 后取消订阅；卸载时结束全部连接。 */
import { describe, expect, it, vi } from 'vitest'
import { registerEvents } from '../src/host/events.js'
import { FixtureHub } from '../src/host/hub-facade.js'

/** 假 res：记录 writeHead/write，close 语义由测试手动触发。 */
function fakeRes() {
  const chunks: string[] = []
  let headers: { status: number; headers: Record<string, string> } | null = null
  let ended = false
  const closeHandlers: Array<() => void> = []
  const errorHandlers: Array<() => void> = []
  return {
    chunks, get headers() { return headers }, get ended() { return ended },
    destroyed: false, writableEnded: false,
    writeHead(status: number, h: Record<string, string>) { headers = { status, headers: h } },
    write(chunk: string) { chunks.push(chunk); return true },
    end() { ended = true },
    on(event: string, cb: () => void) { if (event === 'close') closeHandlers.push(cb); if (event === 'error') errorHandlers.push(cb) },
    close() { for (const cb of closeHandlers) cb() },
    error() { for (const cb of errorHandlers) cb() },
  }
}

function setup(rejection?: number) {
  const hub = new FixtureHub()
  const res = fakeRes()
  let registered: { kind: string; path: string; handler: (req: unknown, res: unknown) => void } | null = null
  const ctx = {
    webServer: { register: (route: { kind: string; path: string; handler: (req: unknown, res: unknown) => void }) => { registered = route; return () => { registered = null } } },
    connection: { requestRejection: () => rejection },
  }
  registerEvents(ctx as never, hub)
  registered!.handler({}, res as never)
  return { hub, res }
}

describe('SSE /agent-hub/events', () => {
  it('注册的是 exact 路由 /agent-hub/events', () => {
    const hub = new FixtureHub()
    let registered: { kind: string; path: string } | null = null
    registerEvents({ webServer: { register: (r: never) => { registered = r; return () => {} } }, connection: { requestRejection: () => undefined } } as never, hub)
    expect(registered).toMatchObject({ kind: 'exact', path: '/agent-hub/events' })
  })
  it('被拒时写对应状态码并结束，不写事件流', () => {
    const { res } = setup(401)
    expect(res.headers!.status).toBe(401)
    expect(res.ended).toBe(true)
    expect(res.chunks).toHaveLength(0)
  })
  it('接受时写 200 与 text/event-stream 头', () => {
    const { res } = setup()
    expect(res.headers!.status).toBe(200)
    expect(res.headers!.headers['Content-Type']).toContain('text/event-stream')
    expect(res.chunks[0]).toBe(': connected\n\n')
  })
  it('变化时写 changed 事件（JSON 载荷含 scope）', async () => {
    const { hub, res } = setup()
    await hub.command('sendMessage', { threadId: 'team', text: 'hi' })
    const changed = res.chunks.find((c) => c.startsWith('event: changed'))
    expect(changed).toBeTruthy()
    const data = JSON.parse(changed!.split('data: ')[1] ?? '') as { scope: string }
    expect(data.scope).toBe('thread')
  })
  it('close 后取消订阅：此后变化不再写入', async () => {
    const { hub, res } = setup()
    res.close()
    await hub.command('sendMessage', { threadId: 'team', text: 'again' })
    expect(res.chunks.filter((c) => c.startsWith('event: changed'))).toHaveLength(0)
  })
  it('error 后同样取消订阅', async () => {
    const { hub, res } = setup()
    res.error()
    await hub.command('sendMessage', { threadId: 'team', text: 'once more' })
    expect(res.chunks.filter((c) => c.startsWith('event: changed'))).toHaveLength(0)
  })
  it('连接断开（destroyed）后不再写入', async () => {
    const { hub, res } = setup()
    res.destroyed = true
    await hub.command('sendMessage', { threadId: 'team', text: 'x' })
    expect(res.chunks.filter((c) => c.startsWith('event: changed'))).toHaveLength(0)
  })
  it('卸载（disposer）时结束全部已打开的连接、清保活定时器并退订（D05 第 12 条）', async () => {
    vi.useFakeTimers()
    try {
      const hub = new FixtureHub()
      const responses = [fakeRes(), fakeRes()]
      let registered: { kind: string; path: string; handler: (req: unknown, res: unknown) => void } | null = null
      let routeDisposed = false
      const ctx = {
        webServer: {
          register: (route: { kind: string; path: string; handler: (req: unknown, res: unknown) => void }) => {
            registered = route
            return () => { routeDisposed = true }
          },
        },
        connection: { requestRejection: () => undefined },
      }
      const dispose = registerEvents(ctx as never, hub)
      for (const res of responses) registered!.handler({}, res as never)
      // 连接还开着时变化能写入；disposer 之后：已打开的响应被 end、保活被清、路由被注销。
      await hub.command('sendMessage', { threadId: 'team', text: 'x' })
      expect(responses.every(r => r.chunks.some(c => c.startsWith('event: changed')))).toBe(true)
      dispose()
      expect(responses.every(r => r.ended)).toBe(true)
      expect(routeDisposed).toBe(true)
      // 再触发一次变化：退订已生效（写不进去，也不会抛）。
      await hub.command('sendMessage', { threadId: 'team', text: 'y' })
      // 推进 25 秒：保活定时器已被清掉，不会再写注释行。
      const before = responses.map(r => r.chunks.length)
      vi.advanceTimersByTime(26_000)
      expect(responses.map(r => r.chunks.length)).toEqual(before)
    } finally { vi.useRealTimers() }
  })
})

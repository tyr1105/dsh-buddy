/**
 * SSE 实时推送：webServer exact 路由 /agent-hub/events。
 * 为什么不在 /api 下：桌面更新锁会等所有在途 /api 请求结束，长连接会被卡（verified-T5 Q3-3）。
 * 鉴权：handler 第一行 ctx.connection.requestRejection(req)，被拒就写对应状态码结束。
 * 保活：每 25 秒写一行注释；事件格式 event: changed + data: {"scope":…,"botId":…}。
 * 清理：res 的 close/error 时取消订阅；卸载时（D05 第 12 条）对每条打开的连接清保活、
 * 取消订阅并 res.end()——webServer.register 的 disposer 只删路由表，不会结束响应；
 * 连接不断开浏览器的 EventSource 就不会重连到新实例，页面从此收不到推送。
 * 注册用 ctx.effect(() => ctx.webServer.register(...))：register 的 disposer 不会自动跟随插件卸载。
 */
import type { ChangedEvent, HubFacade } from './hub-facade.js'

interface ServerResponseLike {
  writeHead: (status: number, headers: Record<string, string>) => unknown
  write: (chunk: string) => boolean
  end: (chunk?: string) => unknown
  destroyed: boolean
  writableEnded: boolean
  on: (event: string, listener: () => void) => unknown
}

interface IncomingMessageLike { url?: string }

interface WebServerLike {
  register: (route: { kind: 'exact'; path: string; handler: (req: IncomingMessageLike, res: ServerResponseLike) => void }) => () => void
}

interface ConnectionLike {
  requestRejection: (req: IncomingMessageLike) => number | undefined
}

const KEEPALIVE_MS = 25_000

/** 一条打开中的连接：响应 + 保活定时器 + 退订函数（disposer 收尾用）。 */
interface OpenConnection {
  res: ServerResponseLike
  keepalive: ReturnType<typeof setInterval>
  unsubscribe: () => void
  closed: boolean
}

/** 注册 SSE 路由（放在 ctx.inject(['webServer'], …) 子插件里调用；返回 disposer）。 */
export function registerEvents(ctx: { webServer: WebServerLike; connection: ConnectionLike }, hub: HubFacade): () => void {
  const connections = new Set<OpenConnection>()
  const disposer = ctx.webServer.register({
    kind: 'exact',
    path: '/agent-hub/events',
    handler: (req, res) => {
      // 1) 鉴权：被拒就写对应状态码并结束，不给任何事件流。
      const rejection = ctx.connection.requestRejection(req)
      if (rejection !== undefined) {
        res.writeHead(rejection, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('未授权')
        return
      }
      // 2) 接受：写 event-stream 头并开始推。
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })
      res.write(': connected\n\n')
      const writable = (): boolean => !res.destroyed && !res.writableEnded
      const writeLine = (chunk: string): void => { if (writable()) res.write(chunk) }
      // 3) 变化事件 + 25 秒注释保活。
      const unsubscribe = hub.subscribe((event: ChangedEvent) => {
        writeLine(`event: changed\ndata: ${JSON.stringify(event)}\n\n`)
      })
      const keepalive = setInterval(() => writeLine(': keepalive\n'), KEEPALIVE_MS)
      // 保活定时器不阻止进程退出（Node 环境；测试与关停时不挂住事件循环）。
      if (typeof (keepalive as { unref?: () => void }).unref === 'function') (keepalive as { unref: () => void }).unref()
      const conn: OpenConnection = { res, keepalive, unsubscribe, closed: false }
      connections.add(conn)
      // 4) close/error 时取消订阅、清定时器并移出连接集合（幂等）。
      const cleanup = () => {
        if (conn.closed) return
        conn.closed = true
        connections.delete(conn)
        clearInterval(keepalive)
        unsubscribe()
      }
      res.on('close', cleanup)
      res.on('error', cleanup)
    },
  })
  // 卸载：结束全部已打开的连接（EventSource 会自动重连到新实例），再注销路由。
  return () => {
    for (const conn of [...connections]) {
      try { clearInterval(conn.keepalive) } catch { /* 忽略 */ }
      try { conn.unsubscribe() } catch { /* 忽略 */ }
      try { if (!conn.res.writableEnded && !conn.res.destroyed) conn.res.end() } catch { /* 已断开 */ }
      connections.delete(conn)
    }
    disposer()
  }
}

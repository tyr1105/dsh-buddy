/**
 * SSE 实时推送：webServer exact 路由 /agent-hub/events。
 * 为什么不在 /api 下：桌面更新锁会等所有在途 /api 请求结束，长连接会被卡（verified-T5 Q3-3）。
 * 鉴权：handler 第一行 requestRejectionOf(ctx.connection, req)，被拒就写对应状态码结束。
 *   它兼容两代宿主（旧版调 requestRejection；DSH 0.2.3 起由宿主先鉴权再传入 peer），见函数注释。
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
  register: (route: {
    kind: 'exact'
    path: string
    /** DSH 0.2.3 起的路由鉴权方式；旧版宿主不认识这个字段，会忽略它。 */
    auth?: 'required'
    /** peer 只有 DSH 0.2.3 起才会传：宿主鉴权通过后选出的访问者。 */
    handler: (req: IncomingMessageLike, res: ServerResponseLike, peer?: unknown) => void
  }) => () => void
}

/**
 * 宿主连接服务里的旧鉴权接口。写成可选：DSH 0.2.3 把它删掉了。
 * 返回拒绝的状态码；放行时返回 undefined。
 */
interface ConnectionLike {
  requestRejection?: (req: IncomingMessageLike) => number | undefined
}

/**
 * 判断一条请求是否要拒绝：返回要写回的状态码，放行时返回 undefined。
 *
 * 两代宿主的鉴权方式不同，这里把它们收在一处：
 * - DSH 0.2.2 及更早：路由处理函数自己调 connection.requestRejection(req) 判断；
 * - DSH 0.2.3 起：requestRejection 被删掉，改由宿主的网页服务在进入处理函数之前统一鉴权
 *   （路由的 auth 默认就是 required），通过后把代表访问者的 peer 作为第三个参数传进来。
 *   没通过的请求根本到不了处理函数。
 *
 * 为什么不直接调新接口 connection.admit：它内部要读 connection.authentication 这个
 * 嵌套服务，插件没有声明注入就会抛错；而旧宿主上没有这个服务，声明了插件又加载不了。
 * 宿主文档也写明「处理函数直接使用网页服务选好的 peer，不要重复鉴权」。
 *
 * 取舍：旧接口在就用旧接口，行为与以前完全一致；旧接口不在时，只有确实拿到 peer 才放行。
 * 两样都没有、或者调用时抛错，一律拒绝：宁可不推送，也不开一条没有鉴权的长连接。
 */
export function requestRejectionOf(
  connection: ConnectionLike | null | undefined,
  req: IncomingMessageLike,
  peer?: unknown,
): number | undefined {
  try {
    if (typeof connection?.requestRejection === 'function') return connection.requestRejection(req)
    return typeof peer === 'object' && peer !== null ? undefined : 401
  } catch (error) {
    console.error('[agent-hub] 推送鉴权出错，已拒绝这条连接:', error)
    return 503
  }
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
    // 明确要求登录后才能访问。DSH 0.2.3 的默认值本来就是 required，这里写出来是为了不依赖默认值。
    auth: 'required',
    handler: (req, res, peer) => {
      // 1) 鉴权：被拒就写对应状态码并结束，不给任何事件流。
      const rejection = requestRejectionOf(ctx.connection, req, peer)
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

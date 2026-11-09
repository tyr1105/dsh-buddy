/**
 * 宿主路由：用 ctx.connection.fetch.register 注册 /api/agent-hub/<名字> 的精确路由。
 * 为什么用 connection.fetch 而不是 webServer：它走 Connection 的 Host/Origin 栅栏与 Cookie 鉴权，
 * 只放行主人（verified-T5 Q3-1）。多段路径是允许的：endpointFromPath 只逐段校验
 * [A-Za-z0-9_$.-]（dsh-client-connection/lib/index.js:926-931），所以采用 /api/agent-hub/<名字>。
 * GET 一律 requestBody:'buffered'（省略会让 GET 带上流式 body 而 400，verified-T5 Q3-1 推断）。
 */
import type { HubFacade } from './hub-facade.js'

const JSON_TYPE = 'application/json; charset=utf-8'

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': JSON_TYPE } })
}

function errorResponse(error: unknown, status = 500): Response {
  const message = error instanceof Error ? error.message : String(error)
  return json({ ok: false, error: message }, status)
}

/** 从 Request 的 query 里取字符串参数。 */
function query(request: Request, key: string): string | undefined {
  const value = new URL(request.url).searchParams.get(key)
  return value === null ? undefined : value
}

function queryInt(request: Request, key: string): number | undefined {
  const raw = query(request, key)
  if (raw === undefined || raw === '') return undefined
  const n = Number(raw)
  return Number.isFinite(n) ? n : undefined
}

interface FetchRoute {
  path: string
  methods: string[]
  requestBody: 'buffered'
  fetch: (request: Request) => Promise<Response>
}

/** 组装全部路由描述（测试也用它做形状断言）。 */
export function buildRoutes(hub: HubFacade): FetchRoute[] {
  const get = (path: string, handler: (request: Request) => Promise<unknown>): FetchRoute => ({
    path, methods: ['GET'], requestBody: 'buffered',
    fetch: async (request) => json(await handler(request)),
  })
  return [
    get('/api/agent-hub/overview', () => hub.overview()),
    get('/api/agent-hub/bot', async (request) => {
      const id = query(request, 'id')
      if (!id) throw new Error('缺少参数 id（要哪个机器人）')
      return hub.bot(id)
    }),
    get('/api/agent-hub/thread', async (request) => {
      const id = query(request, 'id')
      if (!id) throw new Error('缺少参数 id（要哪个线程）')
      return hub.thread(id, { before: query(request, 'before'), limit: queryInt(request, 'limit') })
    }),
    get('/api/agent-hub/inbox', () => hub.inbox()),
    get('/api/agent-hub/activity', async (request) => hub.activity({ before: query(request, 'before'), limit: queryInt(request, 'limit') })),
    get('/api/agent-hub/settings', () => hub.settings()),
    // 办公室（F03）：一次读一屏纯投影，不接受任何写参数。
    get('/api/agent-hub/office', () => hub.office()),
    // 资料授权矩阵（V2-PH2-04）：资料、授权展开行与计数的只读组装。
    get('/api/agent-hub/resource', () => hub.resource()),
    // 项目容器（V2-PH4-02）：项目分区、成员/验收项/任务展开、问题与计数的只读组装。
    get('/api/agent-hub/project', () => hub.project()),
    get('/api/agent-hub/recent-sessions', () => hub.recentSessions()),
    // 账本只读视图：按机器人取摘要、按唤醒单取一次完整记录。
    get('/api/agent-hub/wake-ledger', async (request) => {
      const botId = query(request, 'botId')
      if (!botId) throw new Error('缺少参数 botId（要哪个机器人的账本）')
      return hub.wakeLedger(botId, { limit: queryInt(request, 'limit'), before: queryInt(request, 'before') })
    }),
    get('/api/agent-hub/wake-ledger-detail', async (request) => {
      const wakeId = query(request, 'wakeId')
      if (!wakeId) throw new Error('缺少参数 wakeId（要哪次唤醒的账本）')
      return hub.wakeLedgerDetail(wakeId)
    }),
    {
      path: '/api/agent-hub/command', methods: ['POST'], requestBody: 'buffered',
      fetch: async (request) => {
        // POST command：JSON { name, input } → CommandResult
        let body: unknown
        try { body = await request.json() } catch { return errorResponse('请求体不是合法的 JSON', 400) }
        const { name, input } = (body ?? {}) as { name?: unknown; input?: unknown }
        if (typeof name !== 'string' || name === '') return errorResponse('缺少命令名 name', 400)
        if (input !== undefined && (typeof input !== 'object' || input === null)) return errorResponse('input 必须是对象', 400)
        return json(await hub.command(name, (input ?? {}) as Record<string, unknown>))
      },
    },
  ]
}

/** 全部路由（已逐条兜错）：registerRoutes 注册它，测试也用它做形状与行为断言。 */
export function buildGuardedRoutes(hub: HubFacade): FetchRoute[] {
  return buildRoutes(hub).map((route) => ({
    ...route,
    fetch: async (request) => {
      try {
        return await route.fetch(request)
      } catch (error) {
        console.error(`[agent-hub] 路由 ${route.path} 出错:`, error)
        return errorResponse(error, 500)
      }
    },
  }))
}

/**
 * 在 ctx.connection.fetch 上注册全部路由（自动挂到调用方 effect，插件卸载即移除）。
 * 返回注册的路由表：诊断服务用它把「冒烟跑者等进程内插件」的请求走同一组
 * 处理函数（D07 第 1 条：设置接口检查经真实路由代码，e2e 能抓到目录回调回归）。
 */
export function registerRoutes(ctx: { connection: { fetch: { register: (route: FetchRoute) => unknown } } }, hub: HubFacade): FetchRoute[] {
  const routes = buildGuardedRoutes(hub)
  for (const route of routes) {
    ctx.connection.fetch.register(route)
  }
  return routes
}

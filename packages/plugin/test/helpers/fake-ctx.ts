/**
 * 测试辅助：够本插件 apply 跑起来的假 ctx（L2 单测，不启动 DSH）。
 * 只实现本插件真正用到的方法：effect（登记清理）、inject（服务齐了就跑）、on、
 * connection.fetch.register（记录调用）、webServer.register（记录调用）。
 */
export interface RecordedFetchRoute {
  path: string
  methods: string[]
  requestBody: string
  fetch: (request: Request) => Promise<Response>
}

/** 测试用的「真引擎」宿主服务最小桩（E04：满足 apply 的引擎能力探测）。 */
export function engineHarnessServices(): Record<string, unknown> {
  return {
    sessionController: {
      create: async () => ({ sessionId: 'session-stub' }),
      rename: async () => ({ title: '测试' }),
      resolveAgent: async () => ({ error: new Error('测试桩没有真实会话') }),
      selectModel: async () => undefined,
      modelCatalog: async () => ({ routableProviders: [], groups: [] }),
      projections: async () => null,
      list: async () => ({ items: [] }),
      inspect: async () => ({ events: [] }),
    },
    workspaceRegistry: { create: async () => ({ id: 'ws-stub' }) },
    agents: { list: () => [] },
  }
}

export function createFakeCtx(services: Record<string, unknown> = {}) {
  const disposers: Array<() => unknown> = []
  const listeners = new Map<string, Array<(...args: unknown[]) => unknown>>()
  const fetchRoutes: RecordedFetchRoute[] = []
  const webRoutes: Array<{ kind: string; path: string; handler: (req: unknown, res: unknown) => void }> = []
  const ctx: Record<string, any> = {
    ...services,
    effect(execute: () => unknown) {
      const out: unknown = execute()
      if (typeof out === 'function') disposers.push(out as () => unknown)
      return () => { for (const d of disposers.splice(0).reverse()) d() }
    },
    on(name: string, cb: (...args: unknown[]) => unknown) {
      const arr = listeners.get(name) ?? []
      arr.push(cb)
      listeners.set(name, arr)
      // 对齐真 cordis：ctx.on 的监听随插件 fiber 卸载自动移除（它本身是 effect）。
      const off = () => { const i = arr.indexOf(cb); if (i >= 0) arr.splice(i, 1) }
      disposers.push(off)
      return off
    },
    emit(name: string, ...args: unknown[]) {
      for (const cb of [...(listeners.get(name) ?? [])]) cb(...args)
    },
    inject(deps: string[], cb: (c: unknown) => unknown) {
      if (deps.every((d) => ctx[d] !== undefined)) cb(ctx)
    },
    listenerCount: (name: string) => listeners.get(name)?.length ?? 0,
    async dispose() { for (const d of disposers.splice(0).reverse()) await d() },
  }
  ctx.connection = services.connection ?? {
    fetch: { register: (route: RecordedFetchRoute) => { fetchRoutes.push(route) } },
    requestRejection: (_req: unknown) => undefined,
  }
  ctx.webServer = services.webServer ?? {
    register: (route: { kind: string; path: string; handler: (req: unknown, res: unknown) => void }) => {
      webRoutes.push(route)
      return () => { const i = webRoutes.indexOf(route); if (i >= 0) webRoutes.splice(i, 1) }
    },
  }
  // D02 新增：provide（agentHub 诊断服务）与 get（可选服务探测）。
  const provided = new Map<string, unknown>()
  ctx.provide = (name: string, value: unknown) => {
    if (provided.has(name)) throw new Error(`service "${name}" has been registered`)
    provided.set(name, value)
    return () => provided.delete(name)
  }
  ctx.get = (name: string) => (Object.prototype.hasOwnProperty.call(services, name) ? services[name] : provided.get(name))
  return { ctx, fetchRoutes, webRoutes, provided, disposers }
}

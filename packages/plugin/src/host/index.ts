/**
 * dsh-buddy 宿主半边入口（D02：真引擎 + 会话/工具/钩子/模型/事件接线）。
 * 三种模式：
 * - AGENT_HUB_FIXTURE=1：D01 的样例数据模式（演示与测试）。
 * - <rootDir>/.hub/DISABLED 存在：只提供界面（显示已停用），不启动引擎。
 * - 默认：创建 core Hub（系统时钟/文件/网络/执行器 + FileStore），启动、挂事件翻译、
 *   工具安装、动作闸钩子、60 秒 tick；卸载时等 hub.stop() 完成（D05 第 4 条：清理
 *   函数返回 Promise，cordis 会等旧引擎排空落盘后再挂新实例，避免新旧引擎并存）。
 *   引擎启动失败时把原因交给门面（D07 第 12 条：界面显示失败，而不是永远「正在启动」）。
 * 写法照 verified-T1 Q1-c 的推荐：具名导出同步 apply（不 return），异步初始化写
 * init().catch(log)；可选服务（webServer/SSE）放进 ctx.inject 子插件。
 * 顶层 inject 只放「没有就完全不能工作」的服务；permissionPresets、agentDefaultModel、
 * sessions、tools 这些只在特定调用点需要的，用 ctx.get 探测（verified-T8 第 5 题 ①）。
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve as resolvePath } from 'node:path'
import {
  ConsoleLogger, DEFAULTS, FileStore, SystemClock, SystemExec, SystemFs, SystemNet, SystemRng,
  createHub, type Hub, type HostPort, type ListModels,
} from '@agent-hub/core'
import { FixtureHub } from './hub-facade.js'
import type { HubFacade } from './hub-facade.js'
import { DisabledHub, LazyHubFacade, RealHubFacade } from './real-hub.js'
import { registerRoutes } from './routes.js'
import { registerEvents } from './events.js'
import { safe } from './safe.js'
import { createDshHostPort } from './host-port.js'
import { createHostListModels } from './list-models.js'
import { SessionEventTranslator } from './turn-events.js'
import { registerBotToolsLifecycle, type BotToolsInstaller } from './bot-tools.js'
import { registerGuardHooks } from './hooks.js'
import { createTickScheduler } from './tick.js'
import { loadSessionRoster, rosterFilePath, inMemoryRoster, type SessionRoster } from './session-roster.js'

export const name = 'agent-hub'
export const inject = ['connection', 'sessionController', 'workspaceRegistry', 'agents']

export interface HostConfig { rootDir?: string }

/** 引擎每 60 秒 tick 一次（规格第 6.1 节）。 */
const TICK_INTERVAL_MS = 60_000

/**
 * 展开 ~ 开头路径（D05 第 1 条修复）：'~/AgentHub'.slice(1) 是绝对路径 '/AgentHub'，
 * path.resolve 遇到绝对段会丢掉前面的家目录，所以必须用 join 拼在家目录后面。
 */
export function expandHome(p: string): string { return join(homedir(), p.replace(/^~\/?/, '')) }

/**
 * 解析 hub 根目录：config.rootDir → 环境变量 AGENT_HUB_ROOT → ~/AgentHub，展开成绝对路径。
 * 测试守护（D07 第 22 条）：在 vitest 环境里，任何会落到「默认 ~/AgentHub」的解析
 * （既没传 rootDir 也没设 AGENT_HUB_ROOT，或显式指向 ~/AgentHub）都直接抛错——
 * 测试绝不许在主人的真实数据目录里起引擎。
 */
export function resolveRootDir(config?: HostConfig): string {
  const fromConfig = config?.rootDir
  const fromEnv = process.env.AGENT_HUB_ROOT
  if (process.env.VITEST && (fromConfig === undefined || fromConfig === '') && (fromEnv === undefined || fromEnv === '')) {
    throw new Error('测试守护：测试环境必须显式传 rootDir 或设 AGENT_HUB_ROOT，不得使用默认 ~/AgentHub')
  }
  const raw = fromConfig || fromEnv || DEFAULTS.ROOT_DIR
  const expanded = raw.startsWith('~') ? expandHome(raw) : raw
  const resolved = isAbsolute(expanded) ? expanded : resolvePath(expanded)
  if (process.env.VITEST && resolved === join(homedir(), 'AgentHub')) {
    throw new Error(`测试守护：根目录解析成了主人真实的 ${resolved}，测试不得使用`)
  }
  return resolved
}

/** 停用标记文件：<rootDir>/.hub/DISABLED（任务卡 D02 引擎循环一节）。 */
export function disabledMarkerPath(rootDir: string): string { return join(rootDir, '.hub', 'DISABLED') }

/** 引擎句柄：apply 同步注册的清理函数要能拿到异步启动的结果；stop 返回 Promise（D05 第 4 条）。 */
export interface EngineHandle { stop(): Promise<void> }

/** 引擎句柄之外还要交给调用方的拼装件（createEngineHub 的返回形状；测试装配用）。 */
export interface EngineParts {
  hub: Hub
  clock: SystemClock
  rng: SystemRng
  store: FileStore
  logger: ConsoleLogger
}

/**
 * 组装真引擎的核心依赖并 createHub（不 start）。startEngine 传入 DSH 的 HostPort 与
 * 宿主模型目录回调 listModels（D06 第 6 条：从 DSH 的模型目录取可路由模型）；
 * 测试传 core 的 FakeHost 验证装配（D04 1b：ownerHome 必须传入，动作闸才能展开
 * ~ / $HOME 并判断主人目录）。
 */
export function createEngineHub(rootDir: string, host: HostPort, listModels?: ListModels): EngineParts {
  const logger = new ConsoleLogger()
  const clock = new SystemClock()
  const rng = new SystemRng()
  const fs = new SystemFs(logger)
  const store = new FileStore(fs, clock, rootDir, DEFAULTS.TIMEZONE, logger)
  const hub: Hub = createHub({
    host, clock, rng, fs, net: new SystemNet(), exec: new SystemExec(), logger, store,
    // settings.rootDir 必须与 FileStore 的落盘目录一致：core 的家目录初始化读设置。
    settings: { rootDir },
    // D04 1b（M02）：动作闸用它展开 ~ / $HOME 并判断主人目录；不传时带 ~ 的路径只能按需审批。
    ownerHome: homedir(),
    // M07/D06 第 6 条：注入宿主模型目录；未注入时 core 保留旧的选项来源。
    ...(listModels === undefined ? {} : { listModels }),
  })
  return { hub, clock, rng, store, logger }
}

export function apply(ctx: any, config: HostConfig = {}): void {
  const rootDir = resolveRootDir(config)
  const facade = new LazyHubFacade()
  // 会话名册（sessionId → botId）：真引擎模式换成持久化名册（D07 第 15 条：重启后
  // 仍认得被 interruptBot 解绑的旧会话，它们的工具照样过闸、事件照样交给 core）。
  // 样例/停用模式用内存版即可。
  let roster: SessionRoster = inMemoryRoster()
  // 预登记 id → 实际 id（D07 第 23 条 H7 诊断）：不随名册迁移，冒烟跑者据此比对。
  const mints = new Map<string, string>()

  // 界面接口与 SSE 先挂门面（引擎异步就绪后门面自动接通）；注册失败只记日志。
  // 注册返回的路由表留给诊断服务：进程内插件经它走与真实 HTTP 同一组处理函数。
  let httpRoutes: ReturnType<typeof registerRoutes> = []
  try { httpRoutes = registerRoutes(ctx, facade) } catch (error) { console.error('[agent-hub] 注册路由失败:', error) }
  ctx.inject(['webServer'], (sub: any) => {
    sub.effect(() => registerEvents(sub, facade), 'agent-hub: sse')
  })

  // 给冒烟跑者等测试插件用的诊断服务（同名已存在会抛错，兜住）。
  try {
    ctx.provide('agentHub', {
      api: {
        overview: () => facade.overview(),
        bot: (id: string) => facade.bot(id),
        thread: (id: string, opts?: { before?: string; limit?: number }) => facade.thread(id, opts),
        inbox: () => facade.inbox(),
        command: (name: string, input: Record<string, unknown>) => facade.command(name, input),
      },
      status: () => facade.status(),
      // H7 诊断（D05 第 19 条 / D07 第 23 条）：预登记 id → 实际 id 的映射（不随名册
      // 迁移），冒烟跑者据此比对 DSH 有没有另铸会话 id。
      sessionMints: () => [...mints.entries()],
      // 持久名册里的会话 id（D07 第 15 条诊断用）。
      rosterSessionIds: () => roster.sessionIds(),
      // D07 第 1 条：进程内 GET——走与真实 HTTP 相同的路由处理函数（浏览器鉴权只放行
      // 带 Cookie 的主人连接，进程内插件拿不到，所以走同一组 handler 而不是发网络请求）。
      request: async (path: string) => {
        const route = httpRoutes.find(r => r.path === path && r.methods.includes('GET'))
        if (route === undefined) return null
        try {
          const response = await route.fetch(new Request(`http://agent-hub${path}`))
          let body: unknown = null
          try { body = await response.json() } catch { /* 非 JSON 保持 null */ }
          return { status: response.status, body }
        } catch (error) {
          return { status: 500, body: { ok: false, error: error instanceof Error ? error.message : String(error) } }
        }
      },
    })
  } catch { /* 已有同名服务（例如重复挂载），忽略 */ }

  // 模式一：样例数据（AGENT_HUB_FIXTURE=1）。
  if (process.env.AGENT_HUB_FIXTURE === '1') {
    console.log(`[agent-hub] 已启动（样例数据模式）rootDir=${rootDir}`)
    const fixture = new FixtureHub()
    facade.setImpl(fixture)
    ctx.effect(() => () => { for (const timer of fixture.pendingTimers) clearTimeout(timer) }, 'agent-hub: fixture timers')
    return
  }

  // 模式二：停用标记存在，只提供界面。
  if (existsSync(disabledMarkerPath(rootDir))) {
    console.log(`[agent-hub] 引擎已停用（发现 ${disabledMarkerPath(rootDir)}），只提供界面`)
    facade.setImpl(new DisabledHub('中心已停用：删除 <rootDir>/.hub/DISABLED 后重启 DSH 即可恢复'))
    return
  }

  // 模式三：真引擎。先挂清理（引擎可能还没起来，stop 幂等），再异步启动。
  // 清理函数返回 Promise：cordis 卸载时会等它结算，保证旧引擎排空落盘后才挂新实例。
  roster = loadSessionRoster(rosterFilePath(rootDir))
  const engineState: { handle: EngineHandle | null; stopped: boolean } = { handle: null, stopped: false }
  ctx.effect(() => () => {
    engineState.stopped = true
    return engineState.handle?.stop() ?? Promise.resolve()
  }, 'agent-hub: engine')
  startEngine(ctx, rootDir, facade, engineState, roster, mints)
    .catch(error => {
      console.error('[agent-hub] init failed:', error)
      // D07 第 12 条：把失败原因交给门面——界面显示「启动失败：原因」并给重试，
      // 而不是永远停在「中心正在启动」。
      facade.markFailed(error instanceof Error ? error.message : String(error))
    })
}

/**
 * 启动真引擎：组装注入、createHub、start、挂事件/工具/钩子/心跳。
 * 引擎句柄在 createHub 之后立刻登记（不等 onReady），启动期间被卸载也能 stop；
 * start 完成后若已卸载，立即 stop 再返回（手册 2.8 的 `if (state.stopped)` 检查）。
 */
async function startEngine(ctx: any, rootDir: string, facade: LazyHubFacade, engineState: { handle: EngineHandle | null; stopped: boolean }, roster: SessionRoster, mints: Map<string, string>): Promise<void> {
  const running = new Map<string, boolean>()
  let real: RealHubFacade | null = null
  let translator: SessionEventTranslator | null = null
  let hubRef: Hub | null = null
  // hub_* 工具安装器：createSession 的 wireIfBot 补装要用，但它要到 hub.start 之后
  // 才建出来，所以先留迟绑定引用（D07 第 5 条：DSH 另铸会话 id 时补装工具）。
  let installerRef: BotToolsInstaller | null = null
  // 就绪后才有的收尾件（未就绪时为 null，stop 里逐个判空）。
  let stopExtras: Array<() => void> = []

  const host = createDshHostPort({
    ctx,
    prereg: roster,
    mints,
    // D07 第 6 条：推送渠道从引擎存储直读（RealHubFacade 内部同步读 settings 行），
    // 不依赖会读宿主模型目录的 settings() 视图；引擎未就绪时按「不推送」处理。
    pushChannel: () => real?.pushChannel() ?? 'none',
    onNotified: () => facade.emitInApp('overview'),
    running: sessionId => running.get(sessionId) === true,
    // 名册识别（listRecentSessions 过滤机器人自己的会话用）；hub 起来前后都能查。
    botIdFor: sessionId => hubRef?.botIdForSession(sessionId) ?? roster.get(sessionId) ?? null,
    // D05 第 9 条 / D07 第 5 条：DSH 另铸会话 id 时 agent/created 认不出机器人，
    // resolveAgent 之后在这里补装 hub_* 工具与 restrict（幂等）。
    wireIfBot: agent => { try { installerRef?.install(agent) } catch (error) { console.error('[agent-hub] 补装机器人工具失败:', error) } },
  })
  const { hub, clock, store } = createEngineHub(rootDir, host, createHostListModels(ctx))
  hubRef = hub
  // 引擎一创建就登记停止入口：启动途中被卸载时清理函数也拿得到（D05 第 4 条）。
  engineState.handle = {
    stop: async () => {
      for (const dispose of stopExtras.splice(0)) { try { dispose() } catch { /* 忽略 */ } }
      try { translator?.dispose() } catch { /* 忽略 */ }
      try { await hub.stop() } catch (error) { console.error('[agent-hub] hub.stop 失败:', error) }
    },
  }
  await hub.start()
  if (engineState.stopped) { await hub.stop().catch(() => undefined); return } // 启动途中已卸载

  const botIdFor = (sessionId: string): string | null =>
    hub.botIdForSession(sessionId) ?? roster.get(sessionId) ?? null
  const isBotSession = (sessionId: string): boolean => botIdFor(sessionId) !== null

  // 会话事件翻译：running 状态顺带维护（sessionInfo 与 host.cancel 的「在跑判定」用）。
  translator = new SessionEventTranslator({
    hub,
    now: () => clock.now(),
    botIdFor,
    // 外部会话标题：优先读 sessionProjections 快照（重启后也能取到），内存缓存兜底。
    externalTitle: session => {
      try {
        return ctx.get?.('sessionProjections')?.snapshot(session, ['title'])?.values?.title ?? null
      } catch { return null }
    },
  })
  ctx.on('session/event', safe('session/event', (session: any, event: any) => {
    const sessionId = String(session?.id ?? '')
    if (event?.type === 'turn/start') running.set(sessionId, true)
    if (event?.type === 'turn/end') running.set(sessionId, false)
    translator?.handle(session, event)
  }))

  const tools = registerBotToolsLifecycle(ctx, { hub, isBotSession })
  installerRef = tools.installer
  const disposeHooks = registerGuardHooks(ctx, { hub, isBotSession })
  const scheduler = createTickScheduler(hub, TICK_INTERVAL_MS)
  scheduler.start()
  stopExtras = [() => scheduler.stop(), tools.dispose, disposeHooks]

  // M07/D06：打断按钮经路由命令 interruptBot 直接交给 core（取消、线程消息、恢复
  // 感知都由 core 完成），插件不自己 cancel、不写系统消息。
  real = new RealHubFacade(hub, store)
  facade.setImpl(real)
  console.log(`[agent-hub] 引擎已启动 rootDir=${rootDir}`)
}

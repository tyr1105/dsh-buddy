/**
 * harness 兼容探测（E04）：启动时检查当前 DSH 宿主到底提供了哪些能力。
 *
 * 为什么要有这个文件：
 * - DSH 的版本闸门（package.json 顶层 engines.dsh）由宿主执行，版本不匹配时插件
 *   根本不会被加载；但版本号没变、接口签名却变了（例如某个服务改名、某个方法消失）
 *   时宿主不会拦，插件会在真正用到它的那一刻才炸，而且报错位置离原因很远。
 * - 所以这里在 apply 开头做一次纯探测，把能力分三档：
 *   1. shell（外壳）：没有它连界面接口和清理都挂不上，只能明确停用；
 *   2. engine（真引擎）：创建机器人会话必需，缺了就不启动引擎，界面显示中文原因；
 *   3. optional（可选）：缺了只降级对应功能（实时推送、模型目录、权限、落盘等），
 *      引擎继续运行，并把降级项写进日志与诊断服务，方便排查。
 * - 探测本身不调用任何宿主方法、不写状态、不抛错：只读属性、判断是不是函数。
 *   这样探测失败绝不会成为新的崩溃点。
 */

/** 一项能力的探测结果。 */
export interface CapabilityStatus {
  /** 程序用的稳定键（例如 sessionController.create）。 */
  key: string
  /** 给人看的中文说明（含技术键，排错时能直接对照代码）。 */
  label: string
  /** 宿主是否提供了这项能力。 */
  ok: boolean
}

/** 一组能力的探测结果；missing* 里放的是 label，可直接拼进中文句子。 */
export interface HarnessCompatReport {
  /** 外壳能力是否齐全（不齐就不能加载界面）。 */
  shellOk: boolean
  /** 真引擎能力是否齐全（不齐就不启动引擎）。 */
  engineOk: boolean
  shell: CapabilityStatus[]
  engine: CapabilityStatus[]
  optional: CapabilityStatus[]
  missingShell: string[]
  missingEngine: string[]
  /** 缺失的可选能力（只降级，不阻止运行）。 */
  degradedOptional: string[]
}

/** 能力描述：paths 里每一条都必须读到函数，才算这项能力可用。 */
interface CapabilityProbe {
  key: string
  label: string
  paths: string[][]
}

/** 外壳能力：路由注册、事件订阅、清理钩子、服务注入。缺一项就完全跑不起来。 */
const SHELL_PROBES: CapabilityProbe[] = [
  { key: 'ctx.effect', label: '清理钩子（ctx.effect）', paths: [['effect']] },
  { key: 'ctx.on', label: '事件订阅（ctx.on）', paths: [['on']] },
  { key: 'ctx.inject', label: '服务注入（ctx.inject）', paths: [['inject']] },
  { key: 'connection.fetch.register', label: '界面接口（connection.fetch.register）', paths: [['connection', 'fetch', 'register']] },
]

/** 真引擎能力：创建机器人会话与工作区必需。缺一项就不启动引擎，避免静默半残。 */
const ENGINE_PROBES: CapabilityProbe[] = [
  { key: 'sessionController.create', label: '创建会话（sessionController.create）', paths: [['sessionController', 'create']] },
  { key: 'sessionController.rename', label: '重命名会话（sessionController.rename）', paths: [['sessionController', 'rename']] },
  { key: 'sessionController.resolveAgent', label: '取会话代理（sessionController.resolveAgent）', paths: [['sessionController', 'resolveAgent']] },
  { key: 'workspaceRegistry.create', label: '创建工作区（workspaceRegistry.create）', paths: [['workspaceRegistry', 'create']] },
]

/**
 * 可选能力：缺了只影响某一项功能。
 * 每条都对应代码里已有的兜底分支，探测结果只是把「哪一项在降级」说清楚。
 */
const OPTIONAL_PROBES: CapabilityProbe[] = [
  { key: 'ctx.provide', label: '诊断服务（ctx.provide）', paths: [['provide']] },
  { key: 'ctx.get', label: '可选服务探测（ctx.get）', paths: [['get']] },
  { key: 'webServer.register', label: '实时推送（webServer.register）', paths: [['webServer', 'register']] },
  { key: 'connection.requestRejection', label: '推送鉴权（connection.requestRejection）', paths: [['connection', 'requestRejection']] },
  { key: 'sessionController.selectModel', label: '按会话选模型（sessionController.selectModel）', paths: [['sessionController', 'selectModel']] },
  { key: 'sessionController.modelCatalog', label: '模型目录（sessionController.modelCatalog）', paths: [['sessionController', 'modelCatalog']] },
  { key: 'llm.listProviders', label: '模型目录兜底（llm.listProviders）', paths: [['llm', 'listProviders']] },
  { key: 'llm.listModels', label: '模型目录兜底（llm.listModels）', paths: [['llm', 'listModels']] },
  { key: 'sessionController.projections', label: '会话状态投影（sessionController.projections）', paths: [['sessionController', 'projections']] },
  { key: 'sessionController.list', label: '最近会话（sessionController.list）', paths: [['sessionController', 'list']] },
  { key: 'sessionController.inspect', label: '会话摘要（sessionController.inspect）', paths: [['sessionController', 'inspect']] },
  { key: 'permissionPresets.set', label: '无人值守权限（permissionPresets.set）', paths: [['permissionPresets', 'set']] },
  { key: 'approval.overrideOf', label: '审批策略（approval.overrideOf）', paths: [['approval', 'overrideOf']] },
  { key: 'sandboxPolicy.overrideOf', label: '沙箱策略（sandboxPolicy.overrideOf）', paths: [['sandboxPolicy', 'overrideOf']] },
  {
    key: 'agentDefaultModel',
    label: '选模型后还原默认（agentDefaultModel）',
    paths: [['agentDefaultModel', 'currentSelection'], ['agentDefaultModel', 'saveSelection']],
  },
  { key: 'sessions.flush', label: '会话落盘（sessions.flush）', paths: [['sessions', 'flush']] },
  { key: 'sessionProjections.snapshot', label: '外部会话标题（sessionProjections.snapshot）', paths: [['sessionProjections', 'snapshot']] },
  { key: 'agents.list', label: '补装已有机器人工具（agents.list）', paths: [['agents', 'list']] },
]

/** 安全读一个属性：宿主代理可能抛错，探测绝不能让异常冒出去。 */
function readProperty(target: unknown, key: string): unknown {
  if (target === null || (typeof target !== 'object' && typeof target !== 'function')) return undefined
  try {
    return (target as Record<string, unknown>)[key]
  } catch {
    return undefined
  }
}

/**
 * 按路径读一个能力。
 * 第一段优先进 ctx.get(name)：这是手册推荐的「可选服务探测」写法，也不会因为
 * 服务没注入而在代理上抛错；读不到再退回普通属性（ctx 自带的 effect/on 等）。
 */
function readPath(ctx: unknown, path: string[]): unknown {
  if (path.length === 0) return ctx
  const head = path[0]!
  const rest = path.slice(1)
  let current: unknown
  const get = readProperty(ctx, 'get')
  if (typeof get === 'function') {
    try { current = (get as (name: string) => unknown).call(ctx, head) } catch { current = undefined }
  }
  if (current === undefined) current = readProperty(ctx, head)
  for (const key of rest) current = readProperty(current, key)
  return current
}

/** 一条能力是否可用：所有路径都读到函数才算通过。 */
function probeOne(ctx: unknown, probe: CapabilityProbe): CapabilityStatus {
  const ok = probe.paths.every(path => typeof readPath(ctx, path) === 'function')
  return { key: probe.key, label: probe.label, ok }
}

/**
 * 探测当前 ctx 的能力，返回分组报告。纯函数：不调用宿主方法、不写状态、不抛错。
 * group 全部按固定顺序输出，便于日志与测试逐项断言。
 */
export function probeHarness(ctx: unknown): HarnessCompatReport {
  const shell = SHELL_PROBES.map(probe => probeOne(ctx, probe))
  const engine = ENGINE_PROBES.map(probe => probeOne(ctx, probe))
  const optional = OPTIONAL_PROBES.map(probe => probeOne(ctx, probe))
  const failed = (rows: CapabilityStatus[]): string[] => rows.filter(row => !row.ok).map(row => row.label)
  return {
    shellOk: shell.every(row => row.ok),
    engineOk: engine.every(row => row.ok),
    shell,
    engine,
    optional,
    missingShell: failed(shell),
    missingEngine: failed(engine),
    degradedOptional: failed(optional),
  }
}

/** 报告里某项能力是否可用（按稳定键查；没登记的键按不可用处理）。 */
export function hasCapability(report: HarnessCompatReport, key: string): boolean {
  const row = [...report.shell, ...report.engine, ...report.optional].find(item => item.key === key)
  return row?.ok === true
}

/**
 * 外壳能力缺失时的中文停用原因。
 * 以「中心启动失败」开头：界面的 hub-state 会把它识别成 failed 并原样显示，
 * 主人看到的是缺了哪几项，而不是笼统的「连不上」。
 */
export function shellIncompatibleReason(report: HarnessCompatReport): string {
  return `中心启动失败：插件与当前 DSH 不兼容，缺少${report.missingShell.join('、')}。请升级 DSH 或安装与它匹配的插件版本。`
}

/** 真引擎能力缺失时的中文停用原因（同上，界面会显示完整原因）。 */
export function engineIncompatibleReason(report: HarnessCompatReport): string {
  return `中心启动失败：插件与当前 DSH 不兼容，缺少${report.missingEngine.join('、')}。请升级 DSH 或安装与它匹配的插件版本。`
}

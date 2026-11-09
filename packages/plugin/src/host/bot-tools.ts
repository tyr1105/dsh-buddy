/**
 * hub_* 工具的安装与按会话收窄（照官方 dsh-experimental-tool-agent-team 的写法，
 * verified-T3 Q2-a 写法③）：
 * - 工具只注册在机器人的 agent.ctx 上（apply 时遍历 ctx.agents.list() 补装；
 *   agent/created（serial，监听器绝不返回值、绝不抛错）新装；agent/disposed 撤销；
 *   插件 effect 里全部撤销——agent.ctx 上的注册不会随插件卸载自动撤销）。
 * - restrict 去掉不该给机器人用的继承工具：ask_user_question、计划模式、schedule_*、
 *   goal 三件、子代理/委派/workflow 全家、插件管理、working_directory（理由：子代理
 *   不受机器人作用域上的工具/钩子/guard 管辖；working_directory 会让人设目录漂移，
 *   verified-T4 1d 核查说明）。restrict 只收「限制前继承集合」（全局层/祖先层）的名字，
 *   点名 preset 层工具会整次抛错、一个都删不掉（D03 先修项 A1 的沙箱事故），所以先与
 *   view(scope).restrictableNames 求交集再调用；preset 层工具由 hooks.ts 的 pre-execute
 *   双保险逐次拒绝。
 * - 用 raw ToolDefinition：parameters 直接给 core 工具的 JSON Schema（去掉 $schema 键），
 *   output schema 固定 string；execute 调 hub.tools() 的 handler（core 自己用 zod 校验），
 *   失败 throw new Error(中文)——工具失败不结束回合，模型会看到错误文字。
 * - 识别机器人：名册 sessionId + 排除 header.origin === 'subagent'。
 */
import type { Hub } from '@agent-hub/core'

/** 要从机器人会话去掉的工具（verified-T3 Q5-a/Q5-b 清单），preset 层的一并点名。 */
export const BOT_DENY_TOOLS: readonly string[] = [
  'ask_user_question',      // legacy 模式会无限等人（verified-T3 Q5-a）
  'exit_plan_mode',         // 计划模式相关
  'schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete',
  'create_goal', 'update_goal', 'get_goal',
  'send_message', 'interrupt_agent', 'list_agents', 'list_subagent_models',
  'subagent', 'subagent_fork', 'workflow', // 子代理/委派/workflow：不受机器人作用域管辖
  'plugin_manager', 'plugin_market',
  'working_directory',      // 防止机器人 cd 走导致人设目录漂移（verified-T4 1d）
]

/**
 * 每个禁用工具的一句中文原因（pre-execute 双保险用，任务卡 D03 先修项 A2）。
 * 为什么需要双保险：restrict 只能删「限制前继承集合」里的名字（dsh-tools 的
 * view(scope).restrictableNames，不含 agent 自己层注册的 subagent 等 preset 工具），
 * preset 层工具只能靠 tools/pre-execute 逐次拒绝。
 */
export const BOT_DENY_REASONS: Readonly<Record<string, string>> = {
  ask_user_question: '机器人不能向你提问；需要你决定的事写进交账的 ownerQuestion',
  exit_plan_mode: '计划模式不向机器人开放',
  schedule_create: '不能设定时任务；想下次什么时候想，写进交账的 nextThink',
  schedule_list: '不能管理定时任务',
  schedule_update: '不能管理定时任务',
  schedule_delete: '不能管理定时任务',
  create_goal: '目标由中心管理；用 hub_goal_upsert',
  update_goal: '目标由中心管理；用 hub_goal_upsert',
  get_goal: '中心目标由中心管理；用 hub_state_get',
  send_message: '不能操作其他会话；找同伴用 hub_send',
  interrupt_agent: '不能打断其他会话',
  list_agents: '不能查看其他会话',
  list_subagent_models: '不能再委派子代理',
  subagent: '机器人不能再派子代理（子代理不受机器人的规矩约束）',
  subagent_fork: '机器人不能再派子代理（子代理不受机器人的规矩约束）',
  workflow: '机器人不能再编排多代理流程',
  plugin_manager: '不能管理插件',
  plugin_market: '不能安装或卸载插件',
  working_directory: '不能切换工作目录（防止它的家目录漂移）',
}

/** 组装 pre-execute 的拒绝文案（任务卡 D03 先修项 A2 的固定格式）；不在清单返回 null。 */
export function botDenyMessage(tool: string): string | null {
  const reason = BOT_DENY_REASONS[tool]
  return reason === undefined ? null : `Agent 中心的机器人不能使用 ${tool}：${reason}`
}

/**
 * 取该 agent「限制前继承集合」的名字表：dsh-tools Service 公开方法 view(scope) 返回
 * { visible, knownNames, restrictableNames }，restrict 校验用的正是 restrictableNames
 * （dsh-tools/lib/index.js：restrict() 里 const known = this.view(scope).restrictableNames）。
 * 拿不到（宿主版本无此方法）返回 null。
 */
export function restrictableToolNames(agent: any): Set<string> | null {
  const view = agent?.ctx?.tools?.view
  if (typeof view !== 'function') return null
  try {
    const names = view.call(agent.ctx.tools, agent)?.restrictableNames
    return names instanceof Set ? names : null
  } catch {
    return null
  }
}

/**
 * 与该 agent「可被 restrict 点名」的名字求交集（restrict 只收全局层/祖先层的继承名；
 * 点名 agent 自己层注册的 subagent 等 preset 工具会整次抛错，结果一个都删不掉——
 * D03 先修项 A1 的核心修正）。拿不到 view() 时退回 get 口径兜底。
 */
export function intersectRestrictableTools(deny: readonly string[], agent: any): string[] {
  const restrictable = restrictableToolNames(agent)
  if (restrictable !== null) return deny.filter(name => restrictable.has(name))
  return intersectVisibleTools(deny, agent)
}

/** 兜底口径：与该 agent 当前可见工具求交集（view 不可用时用；get 能看到的含 own 层）。 */
export function intersectVisibleTools(deny: readonly string[], agent: any): string[] {
  const get = agent?.ctx?.tools?.get
  if (typeof get !== 'function') return []
  return deny.filter(name => {
    try { return get.call(agent.ctx.tools, name, agent) !== undefined } catch { return false }
  })
}

/** 去掉 JSON Schema 里的 $schema 键（DSH 的 parameters 原样发给模型，不带该键）。 */
export function stripSchemaKey(jsonSchema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _drop, ...rest } = jsonSchema
  return rest
}

/**
 * 用 core 的 RegisteredHubTool 构造 DSH 的 raw ToolDefinition。
 * D05 第 10 条：hub_commit 成功的那一步调用 exec.concludeTurn() 请求收口，
 * 省掉交账后再来一次模型请求（手册 4.2；同一步不用 deferContext，这里本来就没用）。
 */
export function hubToolDefinition(tool: {
  name: string
  description: string
  jsonSchema: Record<string, unknown>
  handler(sessionId: string, rawArgs: unknown): Promise<{ ok: true; text: string } | { ok: false; error: string }>
}): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    parameters: stripSchemaKey(tool.jsonSchema),
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
    },
    async execute(args: unknown, exec: any): Promise<string> {
      const sessionId = exec?.agent?.id
      if (sessionId === undefined || sessionId === null) throw new Error('hub 工具必须在机器人会话里调用')
      const result = await tool.handler(String(sessionId), args)
      if (!result.ok) throw new Error(result.error)
      // 交账成功即收口：DSH 把本回合标记为完成，不再多发一次模型请求。
      if (tool.name === 'hub_commit') {
        try { exec?.concludeTurn?.() } catch (error) { console.error('[agent-hub] concludeTurn 失败:', error) }
      }
      return result.text
    },
  }
}

export interface BotToolsInstaller {
  /** 给一个 agent 装 hub_* 工具 + restrict 收窄（重复调用幂等）。 */
  install(agent: any): void
  /** 撤销某个 agent 上的全部注册（agent/disposed 与插件卸载时用）。 */
  revoke(agentId: string): void
  /** 撤销全部（插件 effect 用）。 */
  disposeAll(): void
}

export interface BotToolsDeps {
  hub: Hub
  /** 会话是否机器人会话（名册；调用方决定是否排除子代理）。 */
  isBotSession(sessionId: string): boolean
}

/** 创建安装器；listener 的挂载由 registerBotToolsLifecycle 完成。 */
export function createBotToolsInstaller(deps: BotToolsDeps): BotToolsInstaller {
  const disposers = new Map<string, Array<() => unknown>>()
  const installed = new Set<string>()

  function isBotAgent(agent: any): boolean {
    if (agent?.session?.header?.origin === 'subagent') return false
    return deps.isBotSession(String(agent?.id ?? ''))
  }

  function restrict(agent: any, agentId: string, list: Array<() => unknown>): void {
    try {
      const deny = intersectRestrictableTools(BOT_DENY_TOOLS, agent)
      if (deny.length === 0) return
      // restrict 返回撤销函数（D05 第 9 条附带修正）：记进撤销列表，插件卸载时一并撤销。
      const undo = agent.ctx.tools.restrict({ deny })
      if (typeof undo === 'function') list.push(undo)
    } catch (error) {
      console.error(`[agent-hub] restrict 失败（会话 ${agentId}）:`, error)
    }
  }

  function install(agent: any): void {
    const agentId = String(agent?.id ?? '')
    if (agentId === '' || !isBotAgent(agent) || installed.has(agentId)) return
    installed.add(agentId)
    const list: Array<() => unknown> = []
    try {
      for (const tool of deps.hub.tools()) {
        const disposer = agent.ctx.tools.register(hubToolDefinition(tool))
        if (typeof disposer === 'function') list.push(disposer)
      }
      restrict(agent, agentId, list)
    } catch (error) {
      console.error(`[agent-hub] 安装机器人工具失败（会话 ${agentId}）:`, error)
    }
    disposers.set(agentId, list)
  }

  function revoke(agentId: string): void {
    installed.delete(agentId)
    const list = disposers.get(agentId)
    disposers.delete(agentId)
    for (const dispose of list ?? []) {
      try { dispose() } catch { /* agent/disposed 后再撤销是安全空操作 */ }
    }
  }

  return { install, revoke, disposeAll: () => { for (const id of [...disposers.keys()]) revoke(id) } }
}

/** registerBotToolsLifecycle 的返回件：总撤销函数 + 安装器（wireIfBot 补装用）。 */
export interface BotToolsLifecycle {
  /** 撤销全部监听与已装工具（插件 effect 用）。 */
  dispose(): void
  /** 给一个 agent 幂等补装 hub_* 工具与 restrict（D05 第 9 条 / D07 第 5 条）。 */
  installer: BotToolsInstaller
}

/**
 * 挂生命周期监听：agent/created 新装（serial：块体、不返回值、绝不抛错）、
 * agent/disposed 撤销；apply 时遍历现有 agent 补装。返回总撤销函数与安装器——
 * 安装器交给 HostPort 的 wireIfBot（D07 第 5 条：DSH 另铸会话 id 时补装）。
 */
export function registerBotToolsLifecycle(ctx: any, deps: BotToolsDeps): BotToolsLifecycle {
  const installer = createBotToolsInstaller(deps)
  const offCreated = ctx.on('agent/created', (payload: any) => {
    // serial 事件：绝不能返回值（会短路官方监听器），绝不能抛错（会让会话创建失败）。
    try { installer.install(payload?.agent) } catch (error) { console.error('[agent-hub] agent/created 安装失败:', error) }
  })
  const offDisposed = ctx.on('agent/disposed', (payload: any) => {
    try { installer.revoke(String(payload?.agent?.id ?? '')) } catch { /* 撤销失败不再传播 */ }
  })
  try {
    for (const agent of ctx.agents?.list?.() ?? []) installer.install(agent)
  } catch (error) { console.error('[agent-hub] 补装现有机器人工具失败:', error) }
  return {
    installer,
    dispose() {
      try { offCreated() } catch { /* 忽略 */ }
      try { offDisposed() } catch { /* 忽略 */ }
      installer.disposeAll()
    },
  }
}

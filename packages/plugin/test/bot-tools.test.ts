/** hub_* 工具安装与按会话收窄测试（写法照官方 agent-team；verified-T3 Q2-a/Q2-b）。 */
import { describe, expect, it, vi } from 'vitest'
import { BOT_DENY_TOOLS, botDenyMessage, hubToolDefinition, intersectRestrictableTools, intersectVisibleTools, registerBotToolsLifecycle, createBotToolsInstaller, stripSchemaKey } from '../src/host/bot-tools.js'
import type { Hub } from '@agent-hub/core'

/** 造一个 agent：ctx.tools.register 记录注册并返回撤销函数；get 只认 visible 名单。
 *  view 模拟 dsh-tools 的 view(scope)：restrictableNames 是「限制前的继承集合」（全局层），
 *  preset 层工具（subagent 等）get 能看到、但不在 restrictableNames 里（它们在 agent 自己层）。 */
function fakeAgent(id: string, opts: { visible?: string[]; restrictable?: string[]; origin?: string } = {}) {
  const registered: Array<{ name: string; dispose: () => void }> = []
  const restricted: Array<{ allow?: string[]; deny?: string[] }> = []
  const visible = opts.visible ?? ['read', 'bash', 'ask_user_question', 'working_directory']
  const restrictable = opts.restrictable ?? visible
  const tools = {
    register: (def: any) => {
      const record = { name: def.name, dispose: () => { const i = registered.indexOf(record); if (i >= 0) registered.splice(i, 1) } }
      registered.push(record)
      return record.dispose
    },
    get: (name: string) => (visible.includes(name) ? { name } : undefined),
    view: () => ({ visible: new Map(visible.map(n => [n, { name: n }])), knownNames: new Set(visible), restrictableNames: new Set(restrictable) }),
    restrict: (filter: any) => { restricted.push(filter) },
  }
  return {
    id, session: { header: { origin: opts.origin ?? 'x' } },
    ctx: { tools },
    registered, restricted,
  }
}

function fakeHub(tools: Array<{ name: string; handler?: any }> = [{ name: 'hub_state_get' }, { name: 'hub_commit' }]) {
  return {
    tools: () => tools.map(t => ({
      name: t.name, description: `${t.name} 描述`,
      jsonSchema: { $schema: 'http://x', type: 'object', properties: {} },
      handler: t.handler ?? (async (): Promise<{ ok: true; text: string }> => ({ ok: true, text: 'done' })),
    })),
    guardToolCall: () => ({ allow: true }),
  } as any as Hub
}

describe('hubToolDefinition（raw ToolDefinition）', () => {
  it('parameters 去掉 $schema 键；output schema 是 string；render 产文本块', () => {
    const def: any = hubToolDefinition({
      name: 'hub_state_get', description: 'd', jsonSchema: { $schema: 'http://x', type: 'object' },
      handler: async () => ({ ok: true, text: 'ok' }),
    })
    expect(def.parameters).toEqual({ type: 'object' })
    expect(def.output.schema).toEqual({ type: 'string' })
    expect(def.output.render(null, '文本')).toEqual([{ type: 'text', text: '文本' }])
  })
  it('execute 把 sessionId 交给 core handler；失败 throw 中文错误', async () => {
    const handler = vi.fn(async (): Promise<{ ok: false; error: string }> => ({ ok: false, error: '参数不对' }))
    const def: any = hubToolDefinition({ name: 'hub_commit', description: 'd', jsonSchema: {}, handler })
    await expect(def.execute({ a: 1 }, { agent: { id: 'bot-s' } })).rejects.toThrow('参数不对')
    expect(handler).toHaveBeenCalledWith('bot-s', { a: 1 })
  })
  it('hub_commit 成功后调用 exec.concludeTurn() 收口（D05 第 10 条）；失败或其他工具不调', async () => {
    const commitDef: any = hubToolDefinition({ name: 'hub_commit', description: 'd', jsonSchema: {}, handler: async () => ({ ok: true, text: '已交账' }) })
    const concludeTurn = vi.fn()
    await expect(commitDef.execute({}, { agent: { id: 'bot-s' }, concludeTurn })).resolves.toBe('已交账')
    expect(concludeTurn).toHaveBeenCalledTimes(1)
    // 失败的交账不收口。
    const failedDef: any = hubToolDefinition({ name: 'hub_commit', description: 'd', jsonSchema: {}, handler: async () => ({ ok: false, error: 'x' }) })
    const concludeFailed = vi.fn()
    await expect(failedDef.execute({}, { agent: { id: 'bot-s' }, concludeTurn: concludeFailed })).rejects.toThrow('x')
    expect(concludeFailed).not.toHaveBeenCalled()
    // 其他工具不触发收口。
    const otherDef: any = hubToolDefinition({ name: 'hub_state_get', description: 'd', jsonSchema: {}, handler: async () => ({ ok: true, text: 'ok' }) })
    const concludeOther = vi.fn()
    await otherDef.execute({}, { agent: { id: 'bot-s' }, concludeTurn: concludeOther })
    expect(concludeOther).not.toHaveBeenCalled()
  })
  it('exec.agent 缺失时直接报错（不冒充机器人）', async () => {
    const def: any = hubToolDefinition({ name: 't', description: 'd', jsonSchema: {}, handler: async () => ({ ok: true, text: '' }) })
    await expect(def.execute({}, {})).rejects.toThrow('机器人会话')
  })
  it('stripSchemaKey 只去掉 $schema', () => {
    expect(stripSchemaKey({ $schema: 'x', type: 'object' })).toEqual({ type: 'object' })
  })
})

describe('restrict 收窄', () => {
  it('deny 清单先与可见工具求交集（未知名字不传给 restrict）', () => {
    const agent = fakeAgent('bot-s', { visible: ['read', 'ask_user_question'] })
    const deny = intersectVisibleTools(BOT_DENY_TOOLS, agent)
    expect(deny).toEqual(['ask_user_question'])
  })
  it('交集为空时不调 restrict；restrict 抛错被兜住（交集非空时工具仍装上）', () => {
    // 反例：交集为空，restrict 从没被调用。
    const empty = fakeAgent('bot-s', { visible: ['read'] })
    ;(empty.ctx.tools.restrict as any) = () => { throw new Error('names unknown') }
    const installerA = createBotToolsInstaller({ hub: fakeHub(), isBotSession: id => id === 'bot-s' })
    expect(() => installerA.install(empty)).not.toThrow()
    expect(empty.restricted).toHaveLength(0)
    // 正例：交集非空但 restrict 抛错——install 不抛错，hub 工具照样在。
    const agent = fakeAgent('bot-s', { visible: ['read', 'ask_user_question'] })
    ;(agent.ctx.tools.restrict as any) = () => { throw new Error('names unknown') }
    const installer = createBotToolsInstaller({ hub: fakeHub(), isBotSession: id => id === 'bot-s' })
    expect(() => installer.install(agent)).not.toThrow()
    expect(agent.registered.map(r => r.name)).toEqual(['hub_state_get', 'hub_commit'])
  })
  it('restrict 返回的撤销函数被记录：revoke 时一并撤销（D05 第 9 条附带修正）', () => {
    const agent = fakeAgent('bot-s', { visible: ['read', 'ask_user_question'] })
    let undoCalled = false
    agent.ctx.tools.restrict = (filter: any) => {
      agent.restricted.push(filter)
      return () => { undoCalled = true }
    }
    const installer = createBotToolsInstaller({ hub: fakeHub(), isBotSession: () => true })
    installer.install(agent)
    expect(agent.restricted).toEqual([{ deny: ['ask_user_question'] }])
    expect(undoCalled).toBe(false)
    installer.revoke('bot-s')
    expect(undoCalled).toBe(true)
  })
  it('收窄清单包含子代理/委派/计划/调度/目标/插件管理/working_directory', () => {
    for (const name of ['subagent', 'workflow', 'exit_plan_mode', 'schedule_create', 'create_goal', 'plugin_manager', 'working_directory', 'ask_user_question']) {
      expect(BOT_DENY_TOOLS).toContain(name)
    }
  })
})

describe('restrict 只收全局层名字（D03 先修项 A1）', () => {
  it('preset 层工具（get 看得见、不在 restrictableNames）不进 restrict 名单', () => {
    // 复现沙箱事故：subagent 能被 get 查到，但它在 agent 自己层，restrict 点名会整次抛错。
    const agent = fakeAgent('bot-s', {
      visible: ['read', 'bash', 'ask_user_question', 'subagent', 'subagent_fork', 'workflow', 'schedule_create'],
      restrictable: ['read', 'bash', 'ask_user_question', 'schedule_create'],
    })
    const deny = intersectRestrictableTools(BOT_DENY_TOOLS, agent)
    expect(deny).toEqual(['ask_user_question', 'schedule_create'])
    expect(deny).not.toContain('subagent')
    expect(intersectVisibleTools(BOT_DENY_TOOLS, agent)).toContain('subagent') // 旧口径确实会把 preset 名混进去
  })
  it('install 时 restrict 只收到全局层名字', () => {
    const agent = fakeAgent('bot-s', {
      visible: ['read', 'bash', 'ask_user_question', 'subagent', 'working_directory'],
      restrictable: ['read', 'bash', 'ask_user_question', 'working_directory'],
    })
    const installer = createBotToolsInstaller({ hub: fakeHub(), isBotSession: () => true })
    installer.install(agent)
    expect(agent.restricted).toEqual([{ deny: ['ask_user_question', 'working_directory'] }])
  })
  it('宿主没有 view 方法时退回 get 口径（不抛错）', () => {
    const agent = fakeAgent('bot-s', { visible: ['read', 'ask_user_question'] })
    delete (agent.ctx.tools as any).view
    expect(intersectRestrictableTools(BOT_DENY_TOOLS, agent)).toEqual(['ask_user_question'])
  })
  it('每个禁用工具都有一句中文原因（pre-execute 双保险用）', () => {
    for (const name of BOT_DENY_TOOLS) {
      expect(botDenyMessage(name)).toContain(`Agent 中心的机器人不能使用 ${name}：`)
    }
    expect(botDenyMessage('read')).toBeNull()
  })
})

describe('安装生命周期（agent-team 写法）', () => {
  it('只装在机器人根会话上；子代理排除；重复安装幂等', () => {
    const hub = fakeHub()
    const installer = createBotToolsInstaller({ hub, isBotSession: id => id === 'bot-s' })
    const bot = fakeAgent('bot-s')
    const other = fakeAgent('other-s')
    const sub = fakeAgent('bot-s', { origin: 'subagent' })
    installer.install(bot); installer.install(bot); installer.install(other); installer.install(sub)
    expect(bot.registered.map(r => r.name)).toEqual(['hub_state_get', 'hub_commit'])
    expect(other.registered).toHaveLength(0)
    expect(sub.registered).toHaveLength(0)
  })

  it('revoke / disposeAll 撤销全部注册', () => {
    const installer = createBotToolsInstaller({ hub: fakeHub(), isBotSession: () => true })
    const bot = fakeAgent('bot-s')
    installer.install(bot)
    installer.revoke('bot-s')
    expect(bot.registered).toHaveLength(0)
    installer.install(bot)
    installer.disposeAll()
    expect(bot.registered).toHaveLength(0)
  })

  it('register 工具抛错时已注册的撤销仍保留、不向外抛（revoke 会调用已登记的撤销）', () => {
    const hub = fakeHub([{ name: 'a' }, { name: 'b' }, { name: 'c' }])
    const agent = fakeAgent('bot-s')
    const undone: string[] = []
    let first = true
    agent.ctx.tools.register = (def: any) => {
      if (first) { first = false; return () => { undone.push(def.name) } }
      throw new Error('duplicate')
    }
    const installer = createBotToolsInstaller({ hub, isBotSession: () => true })
    expect(() => installer.install(agent)).not.toThrow()
    // 抛错前成功注册的那个工具的撤销仍然可用：revoke 时被调用。
    installer.revoke('bot-s')
    expect(undone).toEqual(['a'])
    // 再装一遍（installed 标记已清）也安全。
    expect(() => installer.install(agent)).not.toThrow()
  })
})

describe('registerBotToolsLifecycle', () => {
  function makeCtx() {
    const listeners = new Map<string, Array<(payload: any) => unknown>>()
    const agents = [fakeAgent('bot-s'), fakeAgent('other-s')]
    return {
      ctx: {
        agents: { list: () => agents },
        on: (name: string, cb: (payload: any) => unknown) => {
          const arr = listeners.get(name) ?? []; arr.push(cb); listeners.set(name, arr)
          return () => { const i = arr.indexOf(cb); if (i >= 0) arr.splice(i, 1) }
        },
      },
      listeners, agents,
      fire: (name: string, payload: any) => [...(listeners.get(name) ?? [])].map(cb => cb(payload)),
    }
  }

  it('apply 时给现有机器人补装；agent/created 新装；agent/disposed 撤销', () => {
    const made = makeCtx()
    const lifecycle = registerBotToolsLifecycle(made.ctx, { hub: fakeHub(), isBotSession: id => id === 'bot-s' || id === 'bot-t' })
    const dispose = lifecycle.dispose
    expect(made.agents[0]!.registered).toHaveLength(2)  // bot-s
    expect(made.agents[1]!.registered).toHaveLength(0)  // other-s
    const fresh = fakeAgent('bot-t')
    made.fire('agent/created', { agent: fresh, source: 'startup' })
    expect(fresh.registered).toHaveLength(2)
    made.fire('agent/disposed', { agent: fresh })
    expect(fresh.registered).toHaveLength(0)
    dispose()
    expect(made.agents[0]!.registered).toHaveLength(0)  // 插件卸载全撤
  })

  it('agent/created 监听器无返回值（serial 事件不得短路）且吞掉异常', () => {
    const made = makeCtx()
    registerBotToolsLifecycle(made.ctx, { hub: fakeHub(), isBotSession: () => true }).dispose
    const results = made.fire('agent/created', { agent: null })
    expect(results.every(r => r === undefined)).toBe(true)
    const bad = fakeAgent('bot-s')
    ;(bad.ctx.tools.register as any) = () => { throw new Error('boom') }
    expect(() => made.fire('agent/created', { agent: bad })).not.toThrow()
    const disposed = made.fire('agent/disposed', { agent: { id: 'gone' } })
    expect(disposed.every(r => r === undefined)).toBe(true)
  })
})

/** host-port 测试：建会话配方顺序与参数、followup 投递、steer/cancel、状态查询、通知（D05 第 5/8/9/14/16/17 条）。 */
import { describe, expect, it, vi } from 'vitest'
import { createDshHostPort, hubSteerMessage, hubWakeMessage, contextRatioOf, digestFromEvents, titleOfListItem, UNTITLED_SESSION, type DshHostDeps } from '../src/host/host-port.js'

interface Call { op: string; [key: string]: unknown }

/**
 * 造一套假 DSH 服务，记录全部调用。
 * - minted=true 时 create 无视预登记 id 另铸新 id。
 * - createBeforeCreate：create 被调用时记下名册里 req.sessionId 的登记情况（验证预登记先于 create）。
 */
function createFakeDsh(options: { minted?: boolean; noProjections?: boolean; policy?: 'ok' | 'already' | 'set-throws' | 'missing'; selectModelSlow?: boolean } = {}) {
  const calls: Call[] = []
  const agentSession = {
    append: (type: string, data: unknown) => { calls.push({ op: 'append', type, data }) },
  }
  const agent = {
    session: agentSession,
    steer: (message: unknown) => { calls.push({ op: 'steer', message }) },
    followup: (message: unknown) => { calls.push({ op: 'followup', message }) },
    cancel: (cause: unknown, opts: unknown) => { calls.push({ op: 'agentCancel', cause, opts }) },
    inbox: { nextTurn: [] as any[], nextStep: [] as any[] },
  }
  const sc = {
    create: async (req: any) => {
      // 记录 create 执行时名册里是否已有这个 id（D05 第 20 条：预登记必须先于 create）。
      calls.push({ op: 'create', req, preregAtCreate: depsPrereg.get(String(req.sessionId)) ?? null })
      return { sessionId: options.minted === true ? 'session-minted' : req.sessionId }
    },
    rename: async (req: any) => { calls.push({ op: 'rename', req }); return { title: req.title } },
    resolveAgent: async (id: string) => { calls.push({ op: 'resolveAgent', id }); return { agent } },
    selectModel: async (req: any) => {
      calls.push({ op: 'selectModel', req })
      if (options.selectModelSlow) await new Promise(r => setTimeout(r, 10))
      return { selected: true }
    },
    prompt: async (req: any, signal: unknown) => { calls.push({ op: 'prompt', req, hasSignal: signal instanceof AbortSignal }); return { accepted: true } },
    cancel: (req: any) => { calls.push({ op: 'cancel', req }) },
    projections: async (_req: any, signal: unknown) => {
      calls.push({ op: 'projections', hasSignal: signal instanceof AbortSignal })
      if (options.noProjections) return null
      return { kind: 'sequenced', asOfSeq: 1, values: { contextPressure: { projectedTokens: 5_000, pressureTokens: 4_000, contextWindow: 10_000 } } }
    },
    list: async () => ({
      items: [
        // 行形状按手册 3.11 / D05 第 14 条：标题在 projections.values.title，不在顶层。
        { sessionId: 'a', updatedAt: 2, blank: false, origin: 'x', projections: { kind: 'sequenced', asOfSeq: 3, values: { title: '整理周报' } } },
        { sessionId: 'b', updatedAt: 5, blank: true, projections: { values: { title: '空会话' } } },
        { sessionId: 'c', updatedAt: 9, origin: 'subagent', projections: { values: { title: '子代理' } } },
        { sessionId: 'd', updatedAt: 7, projections: { values: { title: null } } },
        { sessionId: 'bot-s', updatedAt: 99, projections: { values: { title: '机器人自己的' } } },
      ],
    }),
    inspect: async () => ({
      events: [
        { type: 'user/message', data: { message: { role: 'user', content: [{ type: 'text', text: '你好' }] } } },
        { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: '好的' }] } } },
      ],
    }),
  }
  const policy = options.policy ?? 'ok'
  const services: Record<string, unknown> = {
    sessionController: sc,
    workspaceRegistry: { create: async (cwd: string, name: string) => { calls.push({ op: 'workspace.create', cwd, name }); return { id: 'ws-1' } } },
    agents: { list: () => [] },
    permissionPresets: policy === 'missing' ? undefined : {
      set: (session: unknown, name: string) => { if (policy === 'set-throws') throw new Error('unknown preset'); calls.push({ op: 'permission.set', name }) },
    },
    sandboxPolicy: policy === 'missing' ? undefined : {
      overrideOf: () => (policy === 'already' ? 'workspace-write' : 'read-only'),
    },
    approval: policy === 'missing' ? undefined : {
      overrideOf: () => (policy === 'already' ? 'never' : 'ask'),
    },
    agentDefaultModel: {
      currentSelection: () => ({ provider: 'p0', model: 'm0' }),
      saveSelection: (s: unknown) => { calls.push({ op: 'saveSelection', s }) },
    },
    sessions: { flush: async () => { calls.push({ op: 'flush' }) } },
  }
  // 名册要先建好（deps 引用它）。
  const depsPrereg = new Map<string, string>()
  const deps = {
    prereg: depsPrereg,
    pushChannel: () => 'dsh',
    onNotified: () => { calls.push({ op: 'onNotified' }) },
    running: (id: string) => id === 'running-1',
    botIdFor: (id: string) => (id === 'bot-s' ? 'b_1' : null),
    wireIfBot: (a: unknown) => { calls.push({ op: 'wireIfBot', agentId: (a as any)?.session !== undefined ? 'agent' : 'agent' }) },
  }
  const ctx = { ...services, get: (name: string) => services[name] }
  return { ctx, calls, deps, sc, services, agent, agentSession }
}

function makePort(overrides: Partial<DshHostDeps> & { ctx: unknown }) {
  const fake = overrides.ctx as any
  return createDshHostPort({
    prereg: overrides.prereg ?? new Map(),
    mints: overrides.mints,
    pushChannel: overrides.pushChannel ?? (() => 'dsh'),
    onNotified: overrides.onNotified ?? (() => undefined),
    running: overrides.running ?? (() => false),
    botIdFor: overrides.botIdFor ?? (() => null),
    wireIfBot: overrides.wireIfBot,
    sendNotification: overrides.sendNotification,
    ctx: fake,
  } as DshHostDeps)
}

const source = { kind: 'agent-hub' as const, wakeId: 'w_1', botId: 'b_1', variant: 'regular' as const }
const createInput = {
  botId: 'b_1', title: '守望', cwd: '/tmp/agent-hub-test/bots/b_1', rolePresetId: 'standard',
  permissionPresetId: 'workspace-write', model: { provider: 'deepseek-official', model: 'deepseek-flash' },
  firstMessage: '【中心通知】醒来', source,
}

describe('host-port：建会话配方（顺序与参数；D05 第 5/9/20 条）', () => {
  it('按 预登记→工作区→create→rename→补装→权限→never→选模型→还原→flush→followup 的顺序调用', async () => {
    const fake = createFakeDsh()
    const port = makePort({ ...fake.deps, ctx: fake.ctx, prereg: fake.deps.prereg, wireIfBot: fake.deps.wireIfBot })
    const { sessionId } = await port.createSession(createInput)
    const ops = fake.calls.map(c => c.op)
    expect(ops).toEqual([
      'workspace.create', 'create', 'rename', 'resolveAgent', 'wireIfBot',
      'permission.set', 'append', 'selectModel', 'saveSelection', 'flush',
      'resolveAgent', 'followup', 'flush',
    ])
    const create = (fake.calls.find(c => c.op === 'create') as any)
    expect(create.agentPreset === undefined ? create.req.agentPreset : create.req.agentPreset).toBe('standard')
    expect(create.req.workspaceId).toBe('ws-1')
    expect(String(create.req.sessionId)).toMatch(/^session-[0-9a-f-]{36}$/) // 预登记 session-<uuid>
    expect(fake.deps.prereg.get(sessionId)).toBe('b_1')    // 名册以返回 id 为准
    expect((fake.calls.find(c => c.op === 'permission.set') as any).name).toBe('workspace-write')
    expect((fake.calls.find(c => c.op === 'append') as any).type).toBe('approval/policy')
    expect((fake.calls.find(c => c.op === 'append') as any).data).toEqual({ policy: 'never' })
    const rename = (fake.calls.find(c => c.op === 'rename') as any).req
    expect(rename).toEqual({ sessionId, title: '守望' })
  })

  it('create 被调用时预登记名册里已有这个 id（预登记先于 create）', async () => {
    const fake = createFakeDsh()
    const port = makePort({ ...fake.deps, ctx: fake.ctx, prereg: fake.deps.prereg })
    await port.createSession(createInput)
    expect((fake.calls.find(c => c.op === 'create') as any).preregAtCreate).toBe('b_1')
  })

  it('selectModel 的请求参数正确：{sessionId, provider, model}', async () => {
    const fake = createFakeDsh()
    const port = makePort({ ...fake.deps, ctx: fake.ctx, prereg: fake.deps.prereg })
    const { sessionId } = await port.createSession(createInput)
    expect((fake.calls.find(c => c.op === 'selectModel') as any).req)
      .toEqual({ sessionId, provider: 'deepseek-official', model: 'deepseek-flash' })
    expect((fake.calls.find(c => c.op === 'saveSelection') as any).s).toEqual({ provider: 'p0', model: 'm0' }) // 立刻还原全局默认
  })

  it('create 另铸新 id 时名册迁移且对新 id 补装 hub 工具（D05 第 9 条）', async () => {
    const fake = createFakeDsh({ minted: true })
    const wire = vi.fn()
    const port = makePort({ ...fake.deps, ctx: fake.ctx, prereg: fake.deps.prereg, wireIfBot: wire })
    const { sessionId } = await port.createSession(createInput)
    expect(sessionId).toBe('session-minted')
    expect(fake.deps.prereg.get('session-minted')).toBe('b_1')
    expect([...fake.deps.prereg.keys()]).toHaveLength(1)
    expect(wire).toHaveBeenCalled() // resolveAgent 之后对实际 id 幂等补装
  })

  it('model 为 null 时不调 selectModel（跟随宿主默认）', async () => {
    const fake = createFakeDsh()
    const port = makePort({ ...fake.deps, ctx: fake.ctx, prereg: fake.deps.prereg })
    await port.createSession({ ...createInput, model: null })
    expect(fake.calls.some(c => c.op === 'selectModel')).toBe(false)
  })

  it('宿主缺 agentDefaultModel 服务时跳过选模型并继续', async () => {
    const fake = createFakeDsh()
    delete (fake.services as any).agentDefaultModel
    const port = makePort({ ...fake.deps, ctx: fake.ctx, prereg: fake.deps.prereg })
    const { sessionId } = await port.createSession(createInput)
    expect(fake.calls.some(c => c.op === 'selectModel')).toBe(false)
    expect(sessionId).toBeTruthy()
  })

  it('权限已是 workspace-write+never 时不再写权限事件（幂等，不刷 3 条日志）', async () => {
    const fake = createFakeDsh({ policy: 'already' })
    const port = makePort({ ...fake.deps, ctx: fake.ctx, prereg: fake.deps.prereg })
    await port.createSession(createInput)
    expect(fake.calls.some(c => c.op === 'permission.set')).toBe(false)
    expect(fake.calls.some(c => c.op === 'append')).toBe(false)
  })

  it('权限档 set 抛错时中止建会话：不选模型、不投递唤醒包（D05 第 5 条）', async () => {
    const fake = createFakeDsh({ policy: 'set-throws' })
    const port = makePort({ ...fake.deps, ctx: fake.ctx, prereg: fake.deps.prereg })
    await expect(port.createSession(createInput)).rejects.toThrow('unknown preset')
    expect(fake.calls.some(c => c.op === 'selectModel')).toBe(false)
    expect(fake.calls.some(c => c.op === 'followup')).toBe(false)
  })

  it('权限服务缺失时同样中止（失败即关闭，不放行无人值守会话）', async () => {
    const fake = createFakeDsh({ policy: 'missing' })
    const port = makePort({ ...fake.deps, ctx: fake.ctx, prereg: fake.deps.prereg })
    await expect(port.createSession(createInput)).rejects.toThrow('权限服务不可用')
    expect(fake.calls.some(c => c.op === 'followup')).toBe(false)
  })
  it('写 approval/policy（append）抛错时同样中止：不选模型、不投递唤醒包（D05 第 5 条 / D07 第 27 条）', async () => {
    const fake = createFakeDsh()
    ;(fake.agentSession.append as any) = () => { throw new Error('append rejected') }
    const port = makePort({ ...fake.deps, ctx: fake.ctx, prereg: fake.deps.prereg })
    await expect(port.createSession(createInput)).rejects.toThrow('append rejected')
    expect(fake.calls.some(c => c.op === 'selectModel')).toBe(false)
    expect(fake.calls.some(c => c.op === 'followup')).toBe(false)
  })
  it('createSession 记录「预登记 id → 实际 id」，且不随名册迁移（D07 第 23 条 H7）', async () => {
    const fake = createFakeDsh({ minted: true })
    const mints = new Map<string, string>()
    const port = makePort({ ...fake.deps, ctx: fake.ctx, prereg: fake.deps.prereg, mints })
    const { sessionId } = await port.createSession(createInput)
    expect(sessionId).toBe('session-minted')
    expect([...mints.entries()]).toEqual([[expect.stringMatching(/^session-/), 'session-minted']])
    // 名册已迁到实际 id；mints 保留预登记 id，能看出「另铸」。
    expect(fake.deps.prereg.has('session-minted')).toBe(true)
    const wanted = [...mints.keys()][0]!
    expect(wanted).not.toBe('session-minted')
  })
})

describe('host-port：串行选模型（D05 第 16 条）', () => {
  it('两次建会话并发时 selectModel 与还原严格交替（全局默认最终保持原值）', async () => {
    const fake = createFakeDsh({ selectModelSlow: true })
    const port = makePort({ ...fake.deps, ctx: fake.ctx, prereg: fake.deps.prereg })
    await Promise.all([port.createSession(createInput), port.createSession(createInput)])
    const order = fake.calls.filter(c => c.op === 'selectModel' || c.op === 'saveSelection').map(c => c.op)
    // 串行链保证：select→save→select→save；若并发直跑会得到 select→select→save→save。
    expect(order).toEqual(['selectModel', 'saveSelection', 'selectModel', 'saveSelection'])
    expect(fake.calls.filter(c => c.op === 'saveSelection').every(c => JSON.stringify(c.s) === JSON.stringify({ provider: 'p0', model: 'm0' }))).toBe(true)
  })
})

describe('host-port：followup 投递（D05 第 8 条，手册 3.3）', () => {
  it('deliver 用 agent.followup：冻结消息、source.kind=agent-hub 带 wakeId/botId/variant、flush；不用 prompt', async () => {
    const fake = createFakeDsh()
    const port = makePort({ ...fake.deps, ctx: fake.ctx })
    await port.deliver('s-1', '正文', source)
    expect(fake.calls.some(c => c.op === 'prompt')).toBe(false)
    const message: any = (fake.calls.find(c => c.op === 'followup') as any).message
    expect(Object.isFrozen(message)).toBe(true)
    expect(message.role).toBe('user')
    expect(message.source).toMatchObject({ kind: 'agent-hub', form: 'notice', wakeId: 'w_1', botId: 'b_1', variant: 'regular' })
    expect(Object.values(message.source).every(v => v !== undefined)).toBe(true)
    expect(message.content[0].text).toBe('正文')
    expect(fake.calls.some(c => c.op === 'flush')).toBe(true)
  })

  it('同一唤醒单已在 nextTurn 队列里时不重复入队（去重）', async () => {
    const fake = createFakeDsh()
    fake.agent.inbox.nextTurn.push({ source: { kind: 'agent-hub', wakeId: 'w_1' } })
    const port = makePort({ ...fake.deps, ctx: fake.ctx })
    await port.deliver('s-1', '正文', source)
    expect(fake.calls.some(c => c.op === 'followup')).toBe(false)
  })
  it('同一唤醒单已被 steer 挪进 nextStep 队列时同样不重复入队（D05 第 8 条 / D07 第 27 条）', async () => {
    const fake = createFakeDsh()
    fake.agent.inbox.nextStep.push({ source: { kind: 'agent-hub', wakeId: 'w_1' } })
    const port = makePort({ ...fake.deps, ctx: fake.ctx })
    await port.deliver('s-1', '正文', source)
    expect(fake.calls.some(c => c.op === 'followup')).toBe(false)
  })

  it('hubWakeMessage 的 source 没有 undefined、kind 固定 agent-hub', () => {
    const message = hubWakeMessage('x', source) as any
    expect(Object.values(message.source).every(v => v !== undefined)).toBe(true)
    expect(message.source.kind).toBe('agent-hub')
  })

  it('steer 构造冻结消息，source.kind=agent-hub、summary 不超过 120 字', async () => {
    const fake = createFakeDsh()
    const port = makePort({ ...fake.deps, ctx: fake.ctx })
    await port.steer('s-1', '【中心通知】请立即收口')
    const message: any = (fake.calls.find(c => c.op === 'steer') as any).message
    expect(Object.isFrozen(message)).toBe(true)
    expect(message.role).toBe('user')
    expect(message.source.kind).toBe('agent-hub')
    expect([...message.source.summary].length).toBeLessThanOrEqual(120)
    expect(message.content[0].text).toBe('【中心通知】请立即收口')
  })

  it('steerMessage 的 source 没有 undefined 值（Session.append 会拒绝）', () => {
    const message = hubSteerMessage('x') as any
    for (const value of Object.values(message.source)) expect(value).not.toBeUndefined()
  })

  it('cancel 主路径（D07 第 4 条）：会话在跑时 resolveAgent 后 agent.cancel 收到 hook 取消原因与 keepInbox', async () => {
    const fake = createFakeDsh()
    const port = makePort({ ...fake.deps, ctx: fake.ctx, running: id => id === 'running-1' })
    await expect(port.cancel('running-1')).resolves.toBeUndefined()
    expect(fake.calls.find(c => c.op === 'resolveAgent')).toMatchObject({ id: 'running-1' })
    const agentCancel = fake.calls.find(c => c.op === 'agentCancel') as any
    expect(agentCancel.cause).toEqual({ kind: 'hook', reason: 'agent-hub:cancel' })
    expect(agentCancel.opts).toEqual({ keepInbox: true })
  })
  it('cancel 对不在跑的会话是空操作：不 resolveAgent、不调 agent.cancel、直接成功（D07 第 4 条）', async () => {
    const fake = createFakeDsh()
    const port = makePort({ ...fake.deps, ctx: fake.ctx, running: () => false })
    await expect(port.cancel('idle-1')).resolves.toBeUndefined()
    expect(fake.calls.some(c => c.op === 'resolveAgent')).toBe(false)
    expect(fake.calls.some(c => c.op === 'agentCancel')).toBe(false)
  })
  it('先对没在跑的会话 cancel、再来一轮被主人停止：不会被吞掉，照样翻译成 interrupted（D07 第 4 条）', async () => {
    // 用真的 host-port + 真的翻译层串起来：旧实现的「中心取消标记」会残留并吞掉
    // 下一次主人停止；无状态识别后这条链路天然不成立。
    const fake = createFakeDsh()
    const running = new Set<string>()
    const port = makePort({ ...fake.deps, ctx: fake.ctx, running: id => running.has(id) })
    // ① 会话空闲时 core 调 cancel（卡住检测误报等）：没有任何可取消的回合。
    await port.cancel('bot-s')
    expect(fake.calls.some(c => c.op === 'agentCancel')).toBe(false)
    // ② 之后主人在 DSH 界面停止这一轮（turn/end 内层 user）。
    const { SessionEventTranslator } = await import('../src/host/turn-events.js')
    const events: any[] = []
    const hub: any = { onTurnEvent: async (e: any) => { events.push(e) } }
    const translator = new SessionEventTranslator({ hub, now: () => 1, botIdFor: () => 'b_1' })
    running.add('bot-s')
    translator.handle({ id: 'bot-s', header: {} }, { type: 'turn/start', data: {}, time: 1 })
    translator.handle({ id: 'bot-s', header: {} }, { type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'user' } } }, time: 2 })
    await Promise.resolve()
    // started 照报；中止翻成 interrupted——没有被残留标记吞掉。
    expect(events).toEqual([
      { type: 'started', sessionId: 'bot-s', at: 1 },
      { type: 'interrupted', sessionId: 'bot-s', at: 2, by: 'owner' },
    ])
  })
})

describe('host-port：状态与摘要', () => {
  it('sessionInfo 用 contextPressure 投影算占用比例，running 读翻译层维护的表', async () => {
    const fake = createFakeDsh()
    const port = makePort({ ...fake.deps, ctx: fake.ctx, running: id => id === 'running-1' })
    expect(await port.sessionInfo('running-1')).toEqual({ exists: true, running: true, contextRatio: 0.5 })
    expect(await port.sessionInfo('idle-1')).toEqual({ exists: true, running: false, contextRatio: 0.5 })
  })
  it('projections 返回 null 时视为会话不存在', async () => {
    const fake = createFakeDsh({ noProjections: true })
    const port = makePort({ ...fake.deps, ctx: fake.ctx })
    expect(await port.sessionInfo('s')).toEqual({ exists: false, running: false, contextRatio: null })
  })
  it('listRecentSessions：标题取 projections.values.title、排除子代理/空白/机器人自己的会话、倒序（D05 第 14 条）', async () => {
    const fake = createFakeDsh()
    const port = makePort({ ...fake.deps, ctx: fake.ctx, botIdFor: fake.deps.botIdFor })
    const rows = await port.listRecentSessions(10)
    expect(rows).toEqual([
      { sessionId: 'd', title: UNTITLED_SESSION, updatedAt: 7 },
      { sessionId: 'a', title: '整理周报', updatedAt: 2 },
    ])
  })
  it('titleOfListItem：顶层 title 与 projections.title 都取不到时用「未命名会话」，绝不用会话 id', () => {
    expect(titleOfListItem({ projections: { values: { title: '周报' } } })).toBe('周报')
    expect(titleOfListItem({ projections: { values: { title: null } } })).toBe(UNTITLED_SESSION)
    expect(titleOfListItem({})).toBe(UNTITLED_SESSION)
    expect(titleOfListItem({ sessionId: 'session-x' })).toBe(UNTITLED_SESSION)
  })
  it('readSessionDigest 只抽对话文本', async () => {
    const fake = createFakeDsh()
    const port = makePort({ ...fake.deps, ctx: fake.ctx })
    const digest = await port.readSessionDigest('s', 1000)
    expect(digest).toContain('用户：你好')
    expect(digest).toContain('机器人：好的')
  })
  it('contextRatioOf 退化到 pressureTokens、无窗口返回 null', () => {
    expect(contextRatioOf({ pressureTokens: 100, contextWindow: 200 })).toBe(0.5)
    expect(contextRatioOf({ projectedTokens: 10 })).toBeNull()
    expect(contextRatioOf(null)).toBeNull()
  })
  it('digestFromEvents 超长时保留尾部（最近内容）', () => {
    const events = [
      { type: 'user/message', data: { message: { role: 'user', content: [{ type: 'text', text: 'a'.repeat(80) }] } } },
      { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: 'b'.repeat(80) }] } } },
    ]
    expect(digestFromEvents(events, 20).startsWith('b')).toBe(true)
  })
})

describe('host-port：通知', () => {
  it('pushChannel=none 时不发系统通知，但仍广播应用内提示', async () => {
    const send = vi.fn(async () => undefined)
    const onNotified = vi.fn()
    const port = makePort({ ctx: {}, pushChannel: () => 'none', onNotified, sendNotification: send })
    await port.notify({ title: 't', body: 'b', level: 'P1', botId: null })
    expect(send).not.toHaveBeenCalled()
    expect(onNotified).toHaveBeenCalled()
  })
  it('pushChannel 非 none 时发送系统通知', async () => {
    const send = vi.fn(async () => undefined)
    const port = makePort({ ctx: {}, pushChannel: () => 'macos', sendNotification: send })
    await port.notify({ title: 't', body: 'b', level: 'P0', botId: 'b_1' })
    expect(send).toHaveBeenCalledWith('t', 'b')
  })
  it('通知发送失败不影响引擎（不抛错）', async () => {
    const port = makePort({ ctx: {}, pushChannel: () => 'dsh', sendNotification: async () => { throw new Error('boom') } })
    await expect(port.notify({ title: 't', body: 'b', level: 'P2', botId: null })).resolves.toBeUndefined()
  })
})

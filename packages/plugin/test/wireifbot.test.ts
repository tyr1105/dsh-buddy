/**
 * D07 第 5 条接线测试：DSH 另铸会话 id 时补装 hub_* 工具。
 * 走真实 apply() + 真引擎 + 假 DSH（假 sessionController.create 先按 DSH 语义
 * 用另铸的 id 派发 agent/created 再返回），断言新会话上真的装上了 hub_commit——
 * 生产代码在 startEngine 里把工具安装器传给 HostPort 的 wireIfBot（迟绑定引用）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/host/index.js'
import { createFakeCtx } from './helpers/fake-ctx.js'
import { safeTempRoot } from './helpers/safe-root.js'

/** 每个会话一个假 agent：tools.register 记录注册（bot-tools 的安装器会调用）。 */
function makeAgent(id: string, onCreated?: (agent: unknown) => void) {
  const registered: string[] = []
  const agent = {
    id,
    session: { header: { origin: 'x' }, append: () => undefined },
    inbox: { nextTurn: [] as unknown[], nextStep: [] as unknown[] },
    followup: () => undefined,
    steer: () => undefined,
    cancel: () => undefined,
    ctx: {
      tools: {
        register: (def: { name: string }) => { registered.push(def.name); return () => { const i = registered.indexOf(def.name); if (i >= 0) registered.splice(i, 1) } },
        get: (name: string) => (['read', 'bash'].includes(name) ? { name } : undefined),
        view: () => ({ visible: new Map(), knownNames: new Set(['read', 'bash']), restrictableNames: new Set(['read', 'bash']) }),
        restrict: () => () => undefined,
      },
    },
    registered,
  }
  onCreated?.(agent)
  return agent
}

/** 假 DSH：create 无视预登记 id 另铸新 id，并且**先用另铸 id 派发 agent/created 再返回**（DSH 语义）。 */
function mintingDsh(emit: (name: string, payload: unknown) => void) {
  const agents = new Map<string, ReturnType<typeof makeAgent>>()
  const createCalls: Array<{ requested: string; returned: string }> = []
  const sc = {
    create: async (req: { sessionId: string; workspaceId: string; agentPreset: string }) => {
      const minted = `session-minted-${createCalls.length + 1}`
      // DSH：agent/created 在 create 返回之前就触发（serial），那时名册里只有预登记 id。
      agents.set(minted, makeAgent(minted, agent => { try { emit('agent/created', { agent }) } catch { /* 监听失败不影响 */ } }))
      createCalls.push({ requested: req.sessionId, returned: minted })
      return { sessionId: minted }
    },
    rename: async () => ({ title: '守望' }),
    resolveAgent: async (id: string) => (agents.has(id) ? { agent: agents.get(id) } : { error: new Error('not found') }),
    projections: async () => null,
    list: async () => ({ items: [] }),
    inspect: async () => ({ events: [] }),
    cancel: () => undefined,
  }
  return { sc, createCalls, agents }
}

describe('D07 第 5 条：DSH 另铸会话 id 时经 wireIfBot 补装工具（真实 apply 接线）', () => {
  let root: string
  beforeEach(() => { root = safeTempRoot('agent-hub-wireifbot-') })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  it('假 create 另铸 id：新会话上装上了 hub_* 工具（含 hub_commit）', { timeout: 30_000 }, async () => {
    const made = createFakeCtx({ agents: { list: () => [] } })
    const dsh = mintingDsh((name, payload) => made.ctx.emit(name, payload))
    made.ctx.sessionController = dsh.sc
    made.ctx.workspaceRegistry = { create: async () => ({ id: 'ws-1' }) }
    made.ctx.get = (name: string) => {
      const services: Record<string, unknown> = {
        permissionPresets: { set: () => undefined },
        sandboxPolicy: { overrideOf: () => 'workspace-write' },
        approval: { overrideOf: () => 'never' },
        sessions: { flush: async () => undefined },
      }
      return services[name]
    }
    apply(made.ctx, { rootDir: root })
    const service = made.provided.get('agentHub') as any
    await vi.waitFor(() => expect(service.status()).toEqual({ ok: true, mode: 'engine' }), { timeout: 15_000 })

    const created = await service.api.command('createBot', {
      name: '守望', role: 'sentinel', persona: '测试', aspirations: ['看好门'],
    })
    expect(created.ok).toBe(true)
    const botId = created.data?.id as string
    const bot = await service.api.bot(botId)
    const sessionId = bot.profile.sessionId as string

    // create 确实另铸了 id（H7 退回分支）。
    const call = dsh.createCalls.find(c => c.returned === sessionId)
    expect(call).toBeDefined()
    expect(call!.requested).not.toBe(sessionId)
    // 另铸的新会话上装上了 hub_* 工具（含 hub_commit）——D05 第 9 条真正接上了。
    const agent = dsh.agents.get(sessionId)!
    expect(agent.registered).toContain('hub_commit')
    expect(agent.registered.some(name => name.startsWith('hub_'))).toBe(true)
    // mints 诊断也记下了「预登记 → 实际」（D07 第 23 条）。
    const mints = (service.sessionMints as () => Array<[string, string]>)()
    expect(mints.some(([wanted, actual]) => actual === sessionId && wanted !== sessionId)).toBe(true)
    await made.ctx.dispose()
  })
})

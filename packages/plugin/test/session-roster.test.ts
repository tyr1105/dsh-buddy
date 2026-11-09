/**
 * 持久化会话名册测试（D07 第 15 条）：
 * - loadSessionRoster：set/delete 落盘，重启（重新 load）后仍认得；
 * - 真实 apply 接线：引擎建的会话写进 <rootDir>/.hub/plugin/session-roster.json，
 *   插件「重启」（dispose 再 apply 同一 rootDir）后名册仍在——被打断解绑的旧会话
 *   的工具照样过闸、事件照样交给 core（core 会忽略已解绑会话）。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { inMemoryRoster, loadSessionRoster, rosterFilePath } from '../src/host/session-roster.js'
import { apply } from '../src/host/index.js'
import { createFakeCtx } from './helpers/fake-ctx.js'
import { safeTempRoot } from './helpers/safe-root.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'agent-hub-roster-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('loadSessionRoster（D07 第 15 条）', () => {
  it('set/delete 落盘；重新 load（重启）后仍认得', () => {
    const file = join(dir, 'session-roster.json')
    const roster = loadSessionRoster(file)
    roster.set('session-a', 'b_1')
    roster.set('session-b', 'b_2')
    roster.delete('session-b')
    expect(existsSync(file)).toBe(true)
    // 「重启」：新的名册实例从文件加载。
    const restarted = loadSessionRoster(file)
    expect(restarted.get('session-a')).toBe('b_1')
    expect(restarted.has('session-b')).toBe(false)
    expect(restarted.sessionIds()).toEqual(['session-a'])
    restarted.delete('session-a')
    expect(loadSessionRoster(file).sessionIds()).toEqual([])
  })
  it('文件不存在或内容坏了：从空名册开始，不抛错', () => {
    expect(loadSessionRoster(join(dir, 'none.json')).sessionIds()).toEqual([])
    const bad = join(dir, 'bad.json')
    // 直接写坏 JSON 不经名册（绕过原子写）。
    const { writeFileSync } = require('node:fs') as typeof import('node:fs')
    writeFileSync(bad, '{oops', 'utf8')
    expect(loadSessionRoster(bad).sessionIds()).toEqual([])
  })
  it('内存版名册行为一致（样例/停用模式用）', () => {
    const roster = inMemoryRoster()
    roster.set('s', 'b')
    expect(roster.get('s')).toBe('b')
    expect([...roster.keys()]).toEqual(['s'])
    roster.delete('s')
    expect(roster.has('s')).toBe(false)
  })
})

describe('apply 接线：会话名册持久化到 <rootDir>/.hub/plugin（D07 第 15 条）', () => {
  it('引擎建的会话写进名册文件；插件重启后名册仍在，旧会话照样被认出', { timeout: 40_000 }, async () => {
    const root = safeTempRoot('agent-hub-roster-apply-')
    try {
      // 最小假 DSH：create 沿用预登记 id，agents.list 为空。
      const makeCtx = () => {
        const made = createFakeCtx({ agents: { list: () => [] } })
        const agent = {
          id: '', session: { header: { origin: 'x' }, append: () => undefined },
          inbox: { nextTurn: [] as unknown[], nextStep: [] as unknown[] },
          followup: () => undefined, steer: () => undefined, cancel: () => undefined,
          ctx: { tools: { register: () => () => undefined, get: () => undefined, view: () => ({ restrictableNames: new Set() }), restrict: () => () => undefined } },
        }
        const agents = new Map<string, typeof agent>()
        made.ctx.sessionController = {
          create: async (req: { sessionId: string }) => { agent.id = req.sessionId; agents.set(req.sessionId, agent); return { sessionId: req.sessionId } },
          rename: async () => ({ title: '守望' }),
          resolveAgent: async (id: string) => (agents.has(id) ? { agent: agents.get(id) } : { error: new Error('nf') }),
          projections: async () => null, list: async () => ({ items: [] }), inspect: async () => ({ events: [] }), cancel: () => undefined,
        }
        made.ctx.workspaceRegistry = { create: async () => ({ id: 'ws-1' }) }
        made.ctx.get = (name: string) => {
          const services: Record<string, unknown> = {
            permissionPresets: { set: () => undefined }, sandboxPolicy: { overrideOf: () => 'workspace-write' },
            approval: { overrideOf: () => 'never' }, sessions: { flush: async () => undefined },
          }
          return services[name]
        }
        return made
      }
      const first = makeCtx()
      apply(first.ctx, { rootDir: root })
      const service = first.provided.get('agentHub') as any
      await vi.waitFor(() => expect(service.status()).toEqual({ ok: true, mode: 'engine' }), { timeout: 15_000 })
      const created = await service.api.command('createBot', { name: '守望', role: 'sentinel', persona: 'p', aspirations: ['a'] })
      expect(created.ok).toBe(true)
      const bot = await service.api.bot(created.data.id)
      const sessionId = bot.profile.sessionId as string
      // 名册文件已写进 <rootDir>/.hub/plugin/session-roster.json。
      const file = rosterFilePath(root)
      expect(existsSync(file)).toBe(true)
      expect(JSON.parse(readFileSync(file, 'utf8')).sessions[sessionId]).toBe(created.data.id)
      expect(service.rosterSessionIds()).toContain(sessionId)
      // 「重启」：旧实例停稳后新实例在同一 rootDir 上加载同一份名册。
      await first.ctx.dispose()
      const second = makeCtx()
      apply(second.ctx, { rootDir: root })
      const service2 = second.provided.get('agentHub') as any
      await vi.waitFor(() => expect(service2.status()).toEqual({ ok: true, mode: 'engine' }), { timeout: 15_000 })
      // 重启后旧会话（哪怕已被 interruptBot 解绑）仍认得出：诊断名册里在。
      expect(service2.rosterSessionIds()).toContain(sessionId)
      await second.ctx.dispose()
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

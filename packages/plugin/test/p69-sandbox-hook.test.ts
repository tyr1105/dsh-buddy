/**
 * P69 B1：工具调用前的钩子把「沙箱档位」和「临时目录」报给 core。
 * 每条都要「改坏即失败」：
 * - 只有 workspace-write 才报 sandboxed: true，其他档位、服务缺失、resolve 抛错、返回形状不对都报 false；
 * - 每次调用现查，不缓存（中途改档马上生效）；
 * - tmpDirs 传过去了，且含 /tmp、/private/tmp 与系统临时目录的真实路径；
 * - 查询出错不会让钩子抛出去，也不会放松（照常调用 guard，sandboxed 为 false）。
 */
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import type { Hub } from '@agent-hub/core'
import { collectTmpDirs, registerGuardHooks } from '../src/host/hooks.js'

const SESSION = { header: { origin: 'x' } }
const botExec = { name: 'bash', arguments: { command: 'ls' }, agent: { id: 'bot-s', session: SESSION } }
const isBot = (id: string) => id === 'bot-s'

/** 假的中心：记下 guardToolCall 收到的第 4 个参数。 */
function makeHub() {
  return { guardToolCall: vi.fn(() => ({ allow: true })), onHostApprovalRequest: vi.fn(() => 'deny' as const) } as any as Hub
}

/** 假的 ctx：on 记录监听，get 由测试决定返回什么服务。 */
function makeCtx(get?: (name: string) => unknown) {
  let handler: ((exec: any, next: () => Promise<unknown>) => Promise<unknown>) | null = null
  const ctx = {
    on: (name: string, cb: any) => { if (name === 'tools/pre-execute') handler = cb; return () => undefined },
    ...(get !== undefined ? { get } : {}),
  }
  return { ctx, run: (exec: any = botExec) => handler!(exec, async () => ({ kind: 'allow' })) }
}

/** 跑一次钩子，返回 core 收到的宿主报告。 */
async function reported(get?: (name: string) => unknown, exec: any = botExec) {
  const hub = makeHub()
  const made = makeCtx(get)
  registerGuardHooks(made.ctx, { hub, isBotSession: isBot })
  const result = await made.run(exec)
  const call = (hub.guardToolCall as any).mock.calls[0]
  return { result, host: call?.[3] as { sandboxed?: boolean; tmpDirs?: string[] } | undefined, hub }
}

const policy = (mode: unknown) => (name: string) => (name === 'sandboxPolicy' ? { resolve: () => ({ mode, workspaceRoot: '/w' }) } : undefined)

describe('B1：沙箱档位报告', () => {
  it('workspace-write 报 sandboxed: true', async () => {
    expect((await reported(policy('workspace-write'))).host?.sandboxed).toBe(true)
  })

  it('其他档位一律 false', async () => {
    for (const mode of ['read-only', 'danger-full-access', 'something-new', undefined, null, 42]) {
      expect((await reported(policy(mode))).host?.sandboxed, String(mode)).toBe(false)
    }
  })

  it('服务取不到（ctx.get 不存在、返回 undefined、get 抛错、没有 resolve）一律 false', async () => {
    expect((await reported(undefined)).host?.sandboxed).toBe(false)
    expect((await reported(() => undefined)).host?.sandboxed).toBe(false)
    expect((await reported(() => { throw new Error('get 炸了') })).host?.sandboxed).toBe(false)
    expect((await reported(() => ({}))).host?.sandboxed).toBe(false)
    expect((await reported(() => ({ resolve: 'not-a-function' }))).host?.sandboxed).toBe(false)
  })

  it('resolve 抛错或返回的形状不对，一律 false，钩子本身不抛出、guard 照常被调用', async () => {
    const throwing = await reported(() => ({ resolve: () => { throw new Error('resolve 炸了') } }))
    expect(throwing.host?.sandboxed).toBe(false)
    expect(throwing.result).toEqual({ kind: 'allow' })
    for (const bad of [null, undefined, 'workspace-write', 42, { mode: { x: 1 } }, { Mode: 'workspace-write' }, ['workspace-write']]) {
      expect((await reported(() => ({ resolve: () => bad }))).host?.sandboxed, JSON.stringify(bad)).toBe(false)
    }
  })

  it('用的是这条会话自己的 session 对象；每次调用现查，不缓存', async () => {
    let mode = 'read-only'
    const seen: unknown[] = []
    const get = () => ({ resolve: (req: any) => { seen.push(req?.session); return { mode, workspaceRoot: '/w' } } })
    const hub = makeHub()
    const made = makeCtx(get)
    registerGuardHooks(made.ctx, { hub, isBotSession: isBot })
    await made.run()
    mode = 'workspace-write'
    await made.run()
    mode = 'danger-full-access'
    await made.run()
    const flags = (hub.guardToolCall as any).mock.calls.map((c: any[]) => c[3].sandboxed)
    expect(flags).toEqual([false, true, false])
    expect(seen).toEqual([SESSION, SESSION, SESSION])
  })

  it('非机器人会话不查沙箱也不调 guard', async () => {
    const resolve = vi.fn(() => ({ mode: 'workspace-write' }))
    const out = await reported(() => ({ resolve }), { name: 'bash', arguments: {}, agent: { id: 'other', session: { header: {} } } })
    expect(resolve).not.toHaveBeenCalled()
    expect(out.hub.guardToolCall).not.toHaveBeenCalled()
  })
})

describe('B1：临时目录报告', () => {
  it('tmpDirs 一并传给 core：含 /tmp、/private/tmp 和系统临时目录的真实路径，且没有重复', async () => {
    const { host } = await reported(policy('workspace-write'))
    const dirs = host?.tmpDirs ?? []
    expect(dirs).toContain('/tmp')
    expect(dirs).toContain('/private/tmp')
    expect(dirs).toContain(tmpdir())
    expect(dirs).toContain(realpathSync(tmpdir()))
    expect(new Set(dirs).size).toBe(dirs.length)
  })

  it('沙箱查询失败时 tmpDirs 依然传过去（sandboxed 为 false，core 自己决定不启用）', async () => {
    const { host } = await reported(() => { throw new Error('x') })
    expect(host?.sandboxed).toBe(false)
    expect(host?.tmpDirs?.length).toBeGreaterThan(0)
  })

  it('collectTmpDirs 取不到真实路径的目录只跳过那一项，不抛错', () => {
    expect(() => collectTmpDirs()).not.toThrow()
    expect(collectTmpDirs().every(dir => typeof dir === 'string' && dir.startsWith('/'))).toBe(true)
  })
})

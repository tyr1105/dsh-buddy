/** 插件入口三模式测试：rootDir 解析、DISABLED 停用、fixture 演示、真引擎启动与卸载（D05 第 4 条）。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, existsSync } from 'node:fs'
import { apply, resolveRootDir, disabledMarkerPath } from '../src/host/index.js'
import { createFakeCtx } from './helpers/fake-ctx.js'
import { REAL_DEFAULT_ROOT, safeTempRoot, assertNotRealRoot } from './helpers/safe-root.js'

const ENV_KEYS = ['AGENT_HUB_ROOT', 'AGENT_HUB_FIXTURE'] as const

beforeEach(() => { for (const key of ENV_KEYS) delete process.env[key] })
afterEach(() => { for (const key of ENV_KEYS) delete process.env[key] })

describe('resolveRootDir（D05 第 1/2 条 + D07 第 22 条测试守护）', () => {
  it('优先级：config.rootDir > AGENT_HUB_ROOT，~ 精确展开', () => {
    expect(resolveRootDir({ rootDir: '/tmp/x' })).toBe('/tmp/x')
    process.env.AGENT_HUB_ROOT = '/tmp/from-env'
    expect(resolveRootDir({})).toBe('/tmp/from-env')
    expect(resolveRootDir({ rootDir: '~/X' })).toBe(join(homedir(), 'X'))
    delete process.env.AGENT_HUB_ROOT
  })
  it('测试守护（D07 第 22 条）：vitest 环境下落到默认 ~/AgentHub 的解析直接抛错', () => {
    expect(process.env.VITEST).toBe('true')
    delete process.env.AGENT_HUB_ROOT
    expect(() => resolveRootDir()).toThrow('测试守护')
    expect(() => resolveRootDir({})).toThrow('测试守护')
    expect(() => resolveRootDir({ rootDir: '~/AgentHub' })).toThrow('测试守护')
    // 显式传别的根目录不受影响。
    expect(resolveRootDir({ rootDir: '/tmp/agent-hub-ok' })).toBe('/tmp/agent-hub-ok')
  })
  it('停用标记文件在 <rootDir>/.hub/DISABLED', () => {
    expect(disabledMarkerPath('/r')).toBe(join('/r', '.hub', 'DISABLED'))
  })
  it('辅助守护同样生效：根目录解析成主人真实 ~/AgentHub 时直接失败', () => {
    expect(() => assertNotRealRoot(REAL_DEFAULT_ROOT)).toThrow('测试守护')
    expect(() => assertNotRealRoot('/tmp/agent-hub-别的地方')).not.toThrow()
  })
  it('测试环境下 apply(ctx, {})（不带 rootDir）必须失败（D07 第 22 条）', async () => {
    delete process.env.AGENT_HUB_ROOT
    const made = createFakeCtx({ sessionController: {}, workspaceRegistry: {}, agents: { list: () => [] } })
    expect(() => apply(made.ctx, {})).toThrow('测试守护')
    await made.ctx.dispose()
  })
})

describe('apply 三模式', () => {
  it('DISABLED 文件存在：只提供界面，不启动引擎', async () => {
    const root = safeTempRoot('agent-hub-disabled-')
    try {
      mkdirSync(join(root, '.hub'), { recursive: true })
      writeFileSync(disabledMarkerPath(root), '')
      const made = createFakeCtx({ sessionController: {}, workspaceRegistry: {}, agents: { list: () => [] } })
      apply(made.ctx, { rootDir: root })
      const service = made.provided.get('agentHub') as any
      expect(service.status()).toEqual({ ok: false, mode: 'disabled' })
      expect(await service.api.command('createBot', {})).toEqual({ ok: false, error: expect.stringContaining('已停用') })
      expect(made.ctx.listenerCount('session/event')).toBe(0)  // 没挂事件翻译
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('AGENT_HUB_FIXTURE=1：样例数据模式（显式传临时 rootDir，D07 第 22 条）', async () => {
    process.env.AGENT_HUB_FIXTURE = '1'
    const root = safeTempRoot('agent-hub-fixture-')
    try {
      const made = createFakeCtx({ sessionController: {}, workspaceRegistry: {}, agents: { list: () => [] } })
      apply(made.ctx, { rootDir: root })
      const service = made.provided.get('agentHub') as any
      expect(service.status()).toEqual({ ok: true, mode: 'engine' })  // fixture 门面视为可用
      const overview = await service.api.overview()
      expect(overview.bots.length).toBeGreaterThan(0)
      await made.ctx.dispose()
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('真引擎模式：启动后挂事件翻译与钩子，卸载时清理', { timeout: 30_000 }, async () => {
    const root = safeTempRoot('agent-hub-e2e-')
    try {
      const made = createFakeCtx({ sessionController: {}, workspaceRegistry: {}, agents: { list: () => [] } })
      apply(made.ctx, { rootDir: root })
      const service = made.provided.get('agentHub') as any
      await vi.waitFor(() => expect(service.status()).toEqual({ ok: true, mode: 'engine' }), { timeout: 15_000 })
      expect(made.ctx.listenerCount('session/event')).toBe(1)
      expect(made.ctx.listenerCount('tools/pre-execute')).toBe(1)
      expect(made.ctx.listenerCount('approval/request')).toBe(1)
      // 根目录初始化出中心数据目录。
      expect(existsSync(join(root, '.hub'))).toBe(true)
      expect(readdirSync(join(root, '.hub')).length).toBeGreaterThan(0)
      await made.ctx.dispose()
      expect(made.ctx.listenerCount('session/event')).toBe(0)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

/** 读出审计目录里全部 jsonl 行（卸载语义测试用：hub_started / hub_stopped 计数）。 */
function auditLines(root: string): string[] {
  const dir = join(root, '.hub', 'logs', 'audit')
  if (!existsSync(dir)) return []
  const lines: string[] = []
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.jsonl')) continue
    for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) {
      if (line.trim() !== '') lines.push(line)
    }
  }
  return lines
}

describe('D05 第 4 条：卸载/重载的引擎生命周期', () => {
  it('清理函数返回 Promise（cordis 会等 hub.stop() 完成后再挂新实例）', { timeout: 30_000 }, async () => {
    const root = safeTempRoot('agent-hub-stop-promise-')
    try {
      const made = createFakeCtx({ sessionController: {}, workspaceRegistry: {}, agents: { list: () => [] } })
      apply(made.ctx, { rootDir: root })
      const service = made.provided.get('agentHub') as any
      await vi.waitFor(() => expect(service.status()).toEqual({ ok: true, mode: 'engine' }), { timeout: 15_000 })
      // fake ctx 把 effect 清理函数登记在 disposers 里；引擎那条清理必须返回 Promise。
      const cleanups = made.disposers.filter((d): d is () => unknown => typeof d === 'function')
      expect(cleanups.length).toBeGreaterThan(0)
      await made.ctx.dispose()
      const audit = auditLines(root)
      expect(audit.filter(l => l.includes('hub_started'))).toHaveLength(1)
      expect(audit.filter(l => l.includes('hub_stopped'))).toHaveLength(1)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('启动期间被卸载：start 完成后立即 stop（不留永不停止的孤儿引擎）', { timeout: 30_000 }, async () => {
    const root = safeTempRoot('agent-hub-dispose-during-start-')
    try {
      const made = createFakeCtx({ sessionController: {}, workspaceRegistry: {}, agents: { list: () => [] } })
      apply(made.ctx, { rootDir: root })
      // 不等就绪，立刻卸载：旧实现里 engine 句柄还是 null，Hub 永远不会 stop。
      await made.ctx.dispose()
      // 给异步 start 留时间跑完（它会发现已卸载并立即 stop）。
      await new Promise(resolve => setTimeout(resolve, 1500))
      const audit = auditLines(root)
      expect(audit.filter(l => l.includes('hub_started')).length).toBeGreaterThanOrEqual(1)
      expect(audit.filter(l => l.includes('hub_stopped')).length).toBeGreaterThanOrEqual(1)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('快速重载：旧实例停稳后新实例能在同一 rootDir 上正常就绪（任何时刻只有一个引擎）', { timeout: 60_000 }, async () => {
    const root = safeTempRoot('agent-hub-reload-')
    try {
      const a = createFakeCtx({ sessionController: {}, workspaceRegistry: {}, agents: { list: () => [] } })
      apply(a.ctx, { rootDir: root })
      const serviceA = a.provided.get('agentHub') as any
      await vi.waitFor(() => expect(serviceA.status()).toEqual({ ok: true, mode: 'engine' }), { timeout: 15_000 })
      await a.ctx.dispose() // 卸载（等 stop 完成）后再立刻挂新实例
      const b = createFakeCtx({ sessionController: {}, workspaceRegistry: {}, agents: { list: () => [] } })
      apply(b.ctx, { rootDir: root })
      const serviceB = b.provided.get('agentHub') as any
      await vi.waitFor(() => expect(serviceB.status()).toEqual({ ok: true, mode: 'engine' }), { timeout: 15_000 })
      await b.ctx.dispose()
      const audit = auditLines(root)
      expect(audit.filter(l => l.includes('hub_started'))).toHaveLength(2)
      expect(audit.filter(l => l.includes('hub_stopped'))).toHaveLength(2)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('引擎启动失败：门面报 failed 并带原因（D07 第 12 条），视图访问报「启动失败」', { timeout: 30_000 }, async () => {
    const root = safeTempRoot('agent-hub-start-fail-')
    // 把根目录换成一个普通文件：initRoot/建目录会失败，startEngine 抛错。
    rmSync(root, { recursive: true, force: true })
    writeFileSync(root, '不是目录')
    try {
      const made = createFakeCtx({ sessionController: {}, workspaceRegistry: {}, agents: { list: () => [] } })
      apply(made.ctx, { rootDir: root })
      const service = made.provided.get('agentHub') as any
      await vi.waitFor(() => expect(service.status().mode).toBe('failed'), { timeout: 15_000 })
      expect(service.status().ok).toBe(false)
      expect(typeof service.status().error).toBe('string')
      await expect(service.api.overview()).rejects.toThrow('启动失败')
      await made.ctx.dispose()
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

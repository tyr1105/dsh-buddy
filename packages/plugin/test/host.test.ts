/** 宿主入口：apply 在假 ctx 上注册路由与 SSE；rootDir 解析顺序正确（精确断言）。 */
import { afterEach, describe, expect, it } from 'vitest'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { createFakeCtx } from './helpers/fake-ctx.js'
import { REAL_DEFAULT_ROOT, safeTempRoot } from './helpers/safe-root.js'
import { apply, resolveRootDir, expandHome, disabledMarkerPath } from '../src/host/index.js'

// 测试绝不让 apply 走默认根目录（那会往主人真实的 ~/AgentHub 起引擎）：统一临时目录。
const ENV_KEYS = ['AGENT_HUB_ROOT', 'AGENT_HUB_FIXTURE'] as const
afterEach(() => { for (const key of ENV_KEYS) delete process.env[key] })

describe('resolveRootDir（config → 环境变量 → ~/AgentHub；D05 第 1 条精确断言）', () => {
  it('config.rootDir 优先（绝对路径原样保留）', () => {
    expect(resolveRootDir({ rootDir: '/tmp/a' })).toBe('/tmp/a')
  })
  it('环境变量 AGENT_HUB_ROOT 次之', () => {
    process.env.AGENT_HUB_ROOT = '/tmp/from-env'
    expect(resolveRootDir()).toBe('/tmp/from-env')
    delete process.env.AGENT_HUB_ROOT
  })
  it('默认 ~/AgentHub 的展开规则（D07 第 22 条：测试环境下默认解析直接抛错，用 expandHome 精确断言）', () => {
    // 测试守护生效：vitest 里任何落到默认 ~/AgentHub 的解析都必须失败。
    expect(() => resolveRootDir({})).toThrow('测试守护')
    expect(() => resolveRootDir()).toThrow('测试守护')
    // 展开规则本身：~ 精确 join 到家目录（不再是 /AgentHub）。
    expect(expandHome('~/AgentHub')).toBe(join(homedir(), 'AgentHub'))
    expect(expandHome('~')).toBe(homedir())
    expect(REAL_DEFAULT_ROOT).toBe(join(homedir(), 'AgentHub'))
  })
  it("'~/X' 展开成 join(homedir(), 'X')", () => {
    expect(resolveRootDir({ rootDir: '~/X' })).toBe(join(homedir(), 'X'))
  })
  it('DISABLED 停用标记路径跟着根目录走', () => {
    expect(disabledMarkerPath('/tmp/r')).toBe(join('/tmp/r', '.hub', 'DISABLED'))
  })
})

describe('apply（假 ctx，rootDir 一律临时目录；D05 第 2 条守护）', () => {
  it('注册 8 条 /api/agent-hub 路由', () => {
    const root = safeTempRoot('agent-hub-routes-')
    try {
      const { ctx, fetchRoutes } = createFakeCtx()
      apply(ctx, { rootDir: root })
      expect(fetchRoutes).toHaveLength(8)
      expect(fetchRoutes.every((r) => r.path.startsWith('/api/agent-hub/'))).toBe(true)
      void ctx.dispose()
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  it('注入 webServer 子插件时注册 SSE 路由', () => {
    const root = safeTempRoot('agent-hub-sse-reg-')
    try {
      const { ctx, webRoutes } = createFakeCtx({ webServer: undefined })
      apply(ctx, { rootDir: root })
      expect(webRoutes.some((r) => r.path === '/agent-hub/events')).toBe(true)
      void ctx.dispose()
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  it('apply 同步完成不抛错、不返回 Promise', () => {
    const root = safeTempRoot('agent-hub-sync-')
    try {
      const { ctx } = createFakeCtx()
      expect(() => apply(ctx, { rootDir: root })).not.toThrow()
      void ctx.dispose()
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

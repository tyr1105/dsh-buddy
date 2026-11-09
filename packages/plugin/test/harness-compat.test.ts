/**
 * E04 harness 适配与版本兼容：
 * - probeHarness 纯探测：外壳 / 引擎 / 可选三档，缺什么就报告什么，永不抛错；
 * - apply 接线：外壳缺 → 直接停用；引擎缺 → 不启动引擎、界面显示中文原因；
 *   可选缺 → 降级继续（例如缺推送鉴权就不注册 SSE）；
 * - package.json 的 engines.dsh 必须是封闭范围（DSH 升级到范围外时宿主会自动停用插件）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { rmSync } from 'node:fs'
import { createFakeCtx, engineHarnessServices } from './helpers/fake-ctx.js'
import { safeTempRoot } from './helpers/safe-root.js'
import {
  engineIncompatibleReason, hasCapability, probeHarness, shellIncompatibleReason,
} from '../src/host/harness-compat.js'
import { apply } from '../src/host/index.js'

/** 读插件 package.json：版本闸门是发布物的一部分，测试守护它不被误删。 */
function pluginManifest(): { engines?: { dsh?: unknown } } {
  return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { engines?: { dsh?: unknown } }
}

describe('probeHarness（纯探测，不调用宿主方法）', () => {
  it('齐全的宿主：外壳与引擎都可用', () => {
    const { ctx } = createFakeCtx(engineHarnessServices())
    const report = probeHarness(ctx)
    expect(report.shellOk).toBe(true)
    expect(report.engineOk).toBe(true)
    expect(report.missingShell).toEqual([])
    expect(report.missingEngine).toEqual([])
    // 假 ctx 没有权限/模型/落盘服务：它们只算可选降级，不影响运行。
    expect(report.degradedOptional).toEqual(expect.arrayContaining([
      '无人值守权限（permissionPresets.set）',
      '会话落盘（sessions.flush）',
      '选模型后还原默认（agentDefaultModel）',
    ]))
  })

  it('缺外壳能力：shellOk 为假，并说清缺哪一项', () => {
    const { ctx } = createFakeCtx(engineHarnessServices())
    delete ctx.inject
    const report = probeHarness(ctx)
    expect(report.shellOk).toBe(false)
    expect(report.missingShell).toContain('服务注入（ctx.inject）')
    expect(hasCapability(report, 'ctx.inject')).toBe(false)
  })

  it('缺引擎能力：engineOk 为假，外壳仍可用', () => {
    const { ctx } = createFakeCtx()
    const report = probeHarness(ctx)
    expect(report.shellOk).toBe(true)
    expect(report.engineOk).toBe(false)
    expect(report.missingEngine).toEqual(expect.arrayContaining([
      '创建会话（sessionController.create）',
      '取会话代理（sessionController.resolveAgent）',
      '创建工作区（workspaceRegistry.create）',
    ]))
  })

  it('属性读取抛错的宿主也不会让探测抛错（按缺失处理）', () => {
    const hostile = {
      get effect(): unknown { throw new Error('proxy 炸了') },
      on: () => undefined,
      inject: () => undefined,
      connection: { fetch: { register: () => undefined } },
    }
    expect(() => probeHarness(hostile)).not.toThrow()
    expect(probeHarness(hostile).shellOk).toBe(false)
    expect(() => probeHarness(null)).not.toThrow()
    expect(() => probeHarness(undefined)).not.toThrow()
    expect(() => probeHarness(42)).not.toThrow()
  })

  it('停用原因以「中心启动失败」开头（界面能识别成 failed 并显示完整原因）', () => {
    const shell = probeHarness({})
    expect(shellIncompatibleReason(shell)).toContain('中心启动失败：插件与当前 DSH 不兼容')
    expect(shellIncompatibleReason(shell)).toContain('界面接口（connection.fetch.register）')
    const engine = probeHarness(createFakeCtx().ctx)
    expect(engineIncompatibleReason(engine)).toContain('创建会话（sessionController.create）')
  })
})

describe('apply 的 E04 接线', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('外壳能力缺失：不抛错，门面停用，路由照常挂上（让界面能显示原因）', async () => {
    const root = safeTempRoot('agent-hub-compat-shell-')
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const made = createFakeCtx(engineHarnessServices())
      delete made.ctx.inject
      expect(() => apply(made.ctx, { rootDir: root })).not.toThrow()
      const service = made.provided.get('agentHub') as any
      expect(service.status()).toEqual({ ok: false, mode: 'disabled' })
      expect(service.compat().shellOk).toBe(false)
      expect(made.fetchRoutes).toHaveLength(13)
      await made.ctx.dispose()
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('引擎能力缺失：不启动引擎，界面显示缺了哪几项', async () => {
    const root = safeTempRoot('agent-hub-compat-engine-')
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const made = createFakeCtx()
      apply(made.ctx, { rootDir: root })
      const service = made.provided.get('agentHub') as any
      expect(service.status()).toEqual({ ok: false, mode: 'disabled' })
      expect(service.compat().engineOk).toBe(false)
      expect(service.compat().missingEngine).toEqual(expect.arrayContaining([
        '创建会话（sessionController.create）',
      ]))
      // 引擎没启动：没有挂会话事件翻译。
      expect(made.ctx.listenerCount('session/event')).toBe(0)
      await made.ctx.dispose()
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('缺推送鉴权（requestRejection）：不注册 SSE，也不影响引擎启动', async () => {
    const root = safeTempRoot('agent-hub-compat-sse-')
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const made = createFakeCtx(engineHarnessServices())
      delete (made.ctx.connection as { requestRejection?: unknown }).requestRejection
      apply(made.ctx, { rootDir: root })
      expect(made.webRoutes).toHaveLength(0)
      const service = made.provided.get('agentHub') as any
      expect(service.compat().degradedOptional).toContain('推送鉴权（connection.requestRejection）')
      await made.ctx.dispose()
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('engines.dsh 是封闭范围（DSH 升到大版本时宿主自动停用插件）', () => {
    const range = pluginManifest().engines?.dsh
    expect(typeof range).toBe('string')
    // 形如 ">=0.2.1-rc.5 <0.3.0-0"：有下界和上界，不能写成 "*" 或 "latest"。
    expect(range).toMatch(/^>=\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)? <\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
  })
})

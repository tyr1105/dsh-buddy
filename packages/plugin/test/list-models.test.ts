/**
 * 宿主模型目录测试（D06 第 6 条 / D07 第 1 条）：
 * - modelCatalog() 必须按方法调用：测试替身是「依赖 this 的类实例」，照 DSH 源码
 *   （dsh-api-session-controller 的 modelCatalog() { return build(this.ctx) }）；
 * - 单个供应商失败不抛错而是进 failures：全部失败（无可路由组）时抛中文错误并带
 *   供应商名与原因；部分失败只列正常的组；真没有模型（failures 空）返回 []；
 * - routableProviders 是空数组时一行都不出（只有字段缺失才不过滤）；
 * - modelCatalog 缺失时退回 llm（真实签名：listProviders 返回 {id,name} 对象数组、
 *   listModels 异步）；
 * - 接线测试：经 createEngineHub 注入真实形状的 sessionController 后，
 *   hub.api.settings() 的 modelOptions 里有宿主模型。
 */
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { testing } from '@agent-hub/core'
import { createEngineHub } from '../src/host/index.js'
import { createHostListModels, modelsFromCatalog, modelsFromLlm, catalogFailureMessage, type CatalogLike } from '../src/host/list-models.js'

/** 目录夹具：两个可路由供应商 + 一个不可路由组（会被剔除）。 */
const catalog: CatalogLike = {
  routableProviders: ['deepseek-official', 'zai-coding-cn'],
  groups: [
    { id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash' }, { id: 'deepseek-v4-pro', name: '' }] },
    { id: 'zai-coding-cn', name: 'GLM 编程套餐', models: [{ id: 'glm-4.7', name: 'GLM-4.7' }] },
    { id: 'not-routable', name: '没配密的', models: [{ id: 'x', name: 'X' }] },
  ],
  failures: [],
}

/**
 * 依赖 this 的假 SessionController（D07 第 1 条：裸调丢 this 的形状）。
 * modelCatalog 读 this.data——取出方法再调用会抛 TypeError，与真实 DSH 同构。
 */
class FakeSessionController {
  constructor(private readonly data: CatalogLike | Error) {}
  modelCatalog(): CatalogLike {
    if (this.data instanceof Error) throw this.data
    return this.data
  }
}

describe('modelsFromCatalog（modelCatalog 优先路径）', () => {
  it('只保留 routableProviders 的组；label 缺省退回模型 id；按 provider/model 去重', () => {
    const rows = modelsFromCatalog(catalog)
    expect(rows).toEqual([
      { provider: 'deepseek-official', model: 'deepseek-flash', label: 'DeepSeek V4.1 Flash' },
      { provider: 'deepseek-official', model: 'deepseek-v4-pro', label: 'deepseek-v4-pro' },
      { provider: 'zai-coding-cn', model: 'glm-4.7', label: 'GLM-4.7' },
    ])
    expect(modelsFromCatalog({ ...catalog, groups: [...catalog.groups!, { id: 'deepseek-official', models: [{ id: 'deepseek-flash', name: '重复' }] }] })).toHaveLength(3)
  })
  it('routableProviders 缺失时不过滤；是空数组时一行都不出（D07 第 1 条）', () => {
    expect(modelsFromCatalog({ groups: [{ id: 'a', models: [{ id: 'm', name: 'M' }] }] }))
      .toEqual([{ provider: 'a', model: 'm', label: 'M' }])
    expect(modelsFromCatalog({ routableProviders: [], groups: catalog.groups })).toEqual([])
  })
  it('非法条目（无 id / 空 id / 非字符串）整条跳过', () => {
    expect(modelsFromCatalog({ groups: [{ id: 'a', models: [{ id: '', name: 'x' }, { name: '没有 id' }, 5 as never, { id: 'ok', name: 'OK' }] }] })).toEqual([{ provider: 'a', model: 'ok', label: 'OK' }])
  })
})

describe('failures：目录坏了不冒充「没有模型」（D07 第 1 条）', () => {
  it('全部供应商失败（无可路由组 + failures 非空）→ 抛中文错误并带供应商名与原因', async () => {
    const broken: CatalogLike = {
      routableProviders: [], groups: [],
      failures: [
        { id: 'deepseek-account', name: 'DeepSeek Account', message: 'llm-deepseek-account: modelOverrides 无效' },
        { id: 'zai-coding-cn', name: 'GLM 编程套餐', message: 'fetch failed' },
      ],
    }
    expect(catalogFailureMessage(broken)).toContain('DeepSeek Account')
    expect(catalogFailureMessage(broken)).toContain('fetch failed')
    const listModels = createHostListModels({ sessionController: new FakeSessionController(broken) })
    await expect(listModels()).rejects.toThrow('宿主模型目录读取失败')
    await expect(listModels()).rejects.toThrow('DeepSeek Account')
  })
  it('部分失败（仍有可路由组）只列正常的供应商，不抛错', () => {
    const partial: CatalogLike = { ...catalog, failures: [{ id: 'other', name: '别的', message: '挂了' }] }
    expect(modelsFromCatalog(partial)).toHaveLength(3)
    expect(catalogFailureMessage(partial)).not.toBeNull() // 消息能拼出来
  })
  it('真没有模型（failures 为空）返回 []，不抛错', async () => {
    const empty: CatalogLike = { routableProviders: [], groups: [], failures: [] }
    expect(catalogFailureMessage(empty)).toBeNull()
    const listModels = createHostListModels({ sessionController: new FakeSessionController(empty) })
    expect(await listModels()).toEqual([])
  })
})

describe('createHostListModels：按方法调用（不丢 this）与 llm 兜底', () => {
  it('sessionController.modelCatalog 按方法调用：依赖 this 的类实例也能取到目录', async () => {
    const listModels = createHostListModels({ sessionController: new FakeSessionController(catalog) })
    expect(await listModels()).toEqual(modelsFromCatalog(catalog))
  })
  it('modelCatalog 抛错时抛中文错误（不返回空数组）', async () => {
    const listModels = createHostListModels({ sessionController: new FakeSessionController(new Error('断了')) })
    await expect(listModels()).rejects.toThrow('读取宿主模型目录失败')
  })
  it('modelCatalog 缺失时退回 llm 服务（真实签名：{id,name} 对象 + 异步 listModels）', async () => {
    const listModels = createHostListModels({
      sessionController: {},
      get: (name: string) => name === 'llm' ? {
        listProviders: () => [{ id: 'zai-coding-cn', name: 'GLM 编程套餐' }, { id: '', name: '坏的' }],
        listModels: async (provider: string) => provider === 'zai-coding-cn' ? [{ id: 'glm-4.7', name: 'GLM-4.7' }] : [],
      } : undefined,
    })
    expect(await listModels()).toEqual([{ provider: 'zai-coding-cn', model: 'glm-4.7', label: 'GLM-4.7' }])
  })
  it('llm 兜底拿不到任何模型时抛中文错误（供应商为空 / 模型为空）', async () => {
    const noProviders = createHostListModels({ sessionController: {}, get: (n: string) => n === 'llm' ? { listProviders: () => [], listModels: async () => [] } : undefined })
    await expect(noProviders()).rejects.toThrow('没有配置任何模型供应商')
    const noModels = createHostListModels({ sessionController: {}, get: (n: string) => n === 'llm' ? { listProviders: () => [{ id: 'p' }], listModels: async () => [] } : undefined })
    await expect(noModels()).rejects.toThrow('宿主模型目录为空')
  })
  it('两个来源都没有时抛中文错误', async () => {
    const listModels = createHostListModels({ sessionController: {}, get: () => undefined })
    await expect(listModels()).rejects.toThrow('宿主没有可用的模型目录服务')
  })
})

describe('modelsFromLlm：provider 允许对象、modelsOf 允许异步', () => {
  it('字符串与 {id} 对象都认；await 异步 modelsOf', async () => {
    const rows = await modelsFromLlm(
      ['deepseek-official', { id: 'zai-coding-cn', name: 'GLM' }, { id: '' }, 5 as never],
      async provider => provider === 'deepseek-official' ? [{ id: 'deepseek-flash', name: 'Flash' }] : [{ id: 'glm-4.7', name: 'GLM-4.7' }],
    )
    expect(rows).toEqual([
      { provider: 'deepseek-official', model: 'deepseek-flash', label: 'Flash' },
      { provider: 'zai-coding-cn', model: 'glm-4.7', label: 'GLM-4.7' },
    ])
  })
})

/** 接线测试用的根目录（每个用例独立，跑完即删）。 */
let rootDir: string
beforeEach(() => { rootDir = mkdtempSync(join(tmpdir(), 'agent-hub-list-models-')) })
afterEach(async () => { await rm(rootDir, { recursive: true, force: true }) })

describe('接线：createEngineHub 注入目录后 settings() 的 modelOptions 里有宿主模型（D07 第 1 条）', () => {
  it('真实形状的 sessionController（依赖 this）→ settings().modelOptions 含 null 项与宿主模型', async () => {
    const host = new testing.FakeHost()
    const fakeCtx = { sessionController: new FakeSessionController(catalog) }
    const { hub } = createEngineHub(rootDir, host, createHostListModels(fakeCtx))
    const view = await hub.api.settings()
    const values = view.modelOptions.map(option => JSON.stringify(option.value))
    expect(values).toContain(JSON.stringify({ provider: 'zai-coding-cn', model: 'glm-4.7' }))
    expect(view.modelOptions.some(option => option.value === null)).toBe(true)
    await hub.stop()
  })
  it('目录回调抛错 → settings() 抛「模型目录读取失败」（core 的中文包装）', async () => {
    const host = new testing.FakeHost()
    const fakeCtx = { sessionController: new FakeSessionController(new Error('服务炸了')) }
    const { hub } = createEngineHub(rootDir, host, createHostListModels(fakeCtx))
    await expect(hub.api.settings()).rejects.toThrow('模型目录读取失败')
    await hub.stop()
  })
})

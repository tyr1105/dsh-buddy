/**
 * 宿主模型目录（D06 第 6 条 / D07 第 1 条）：把 DSH 的模型目录映射成 core 要的
 * `{ provider, model, label }` 三元组（只传可路由模型，不传凭据）。
 * 优先 sessionController.modelCatalog()（必须按方法调用——取出方法再裸调会丢 this，
 * 在真实 DSH 里必抛 TypeError，这是 D07 第 1 条的核心修复）；
 * 没有它时退回 ctx.get('llm') 的 listProviders() + listModels()（provider 是
 * {id,name} 对象、listModels 是异步的，按 dsh-llm 的真实签名）。
 * 任何一步失败都抛中文错误并带上供应商名与原因——绝不返回空数组冒充「没有模型」。
 */

/** core 的目录条目形状（HubModelOption；这里局部声明避免客户端 bundle 引入 core 运行时）。 */
export interface HostModelRow { provider: string; model: string; label: string }

/** modelCatalog() 的返回形状（手册 3.5/Q4；单个供应商失败不抛错而是进 failures）。 */
export interface CatalogLike {
  routableProviders?: unknown
  groups?: Array<{ id?: unknown; name?: unknown; models?: Array<{ id?: unknown; name?: unknown }> }>
  failures?: Array<{ id?: unknown; name?: unknown; message?: unknown }>
}

/** llm 服务的最小形状（手册 Q4 / dsh-llm 源码：listProviders 同步、listModels 异步）。 */
export interface LlmLike {
  listProviders?: () => unknown
  listModels?: (provider: string) => Promise<Array<{ id?: unknown; name?: unknown }>> | Array<{ id?: unknown; name?: unknown }>
}

/**
 * 把 modelCatalog() 的结果映射成目录行：只保留 routableProviders 里的组，label 用宿主显示名。
 * routableProviders 是数组时严格按它过滤（**空数组 = 一行都不出**，D07 第 1 条）；
 * 字段缺失（旧版宿主）才不过滤。
 */
export function modelsFromCatalog(catalog: CatalogLike): HostModelRow[] {
  const raw = catalog.routableProviders
  const routable = Array.isArray(raw)
    ? new Set(raw.filter((p): p is string => typeof p === 'string' && p !== ''))
    : null
  const rows: HostModelRow[] = []
  for (const group of catalog.groups ?? []) {
    if (typeof group?.id !== 'string' || group.id === '') continue
    if (routable !== null && !routable.has(group.id)) continue // 不可路由的供应商不进目录
    for (const model of group.models ?? []) {
      if (typeof model?.id !== 'string' || model.id === '') continue
      const label = typeof model.name === 'string' && model.name.trim() !== '' ? model.name : model.id
      rows.push({ provider: group.id, model: model.id, label })
    }
  }
  // 按 provider/model 去重（core 也会再验一次，这里先保证不重复）。
  return [...new Map(rows.map(row => [`${row.provider}/${row.model}`, row])).values()]
}

/**
 * 目录一个可路由的组都没有、且宿主报告了供应商失败时，拼中文错误：
 * 带上每个失败供应商的显示名与原因（「DeepSeek Account：fetch failed」）。
 * 这是「目录坏了」与「真没有模型」（没配 key、failures 为空）的唯一区分手段。
 */
export function catalogFailureMessage(catalog: CatalogLike): string | null {
  const failures = (catalog.failures ?? []).filter(f => f != null)
  if (failures.length === 0) return null
  const parts = failures.map(f => {
    const name = typeof f?.name === 'string' && f.name !== '' ? f.name : (typeof f?.id === 'string' ? f.id : '未知供应商')
    const reason = typeof f?.message === 'string' && f.message !== '' ? f.message : '未知原因'
    return `${name}：${reason}`
  })
  return `宿主模型目录读取失败（没有任何可路由的模型）：${parts.join('；')}`
}

/**
 * 把 llm.listProviders()+listModels() 的结果映射成目录行（modelCatalog 缺失时的兜底）。
 * provider 允许是字符串或 {id,…} 对象（dsh-llm 返回对象）；modelsOf 可以是异步的。
 */
export async function modelsFromLlm(
  providers: ReadonlyArray<string | { id?: unknown; [key: string]: unknown }>,
  modelsOf: (provider: string) => Promise<Array<{ id?: unknown; name?: unknown }>> | Array<{ id?: unknown; name?: unknown }>,
): Promise<HostModelRow[]> {
  const rows: HostModelRow[] = []
  for (const provider of providers) {
    const id = typeof provider === 'string' ? provider : (typeof provider?.id === 'string' ? provider.id : '')
    if (id === '') continue
    for (const model of (await modelsOf(id)) ?? []) {
      if (typeof model?.id !== 'string' || model.id === '') continue
      const label = typeof model.name === 'string' && model.name.trim() !== '' ? model.name : model.id
      rows.push({ provider: id, model: model.id, label })
    }
  }
  return [...new Map(rows.map(row => [`${row.provider}/${row.model}`, row])).values()]
}

/**
 * 建目录回调（createHub 的 listModels 注入）。返回值交给 core 校验/去重；
 * 拿不到目录（两个来源都没有或都出错）、或目录坏了（failures 且无可路由组）时
 * 抛中文错误，由 core 的视图转成中文报错。
 */
export function createHostListModels(ctx: any): () => Promise<HostModelRow[]> {
  return async (): Promise<HostModelRow[]> => {
    // 1) 首选：sessionController.modelCatalog()。必须按方法调用（sc.modelCatalog()），
    //    摘出方法再裸调会丢 this（cordis 不给影子方法补绑 this）。
    const sc = ctx?.sessionController as { modelCatalog?: () => unknown } | undefined
    if (typeof sc?.modelCatalog === 'function') {
      try {
        const result = await sc.modelCatalog() as CatalogLike
        if (result != null) {
          const rows = modelsFromCatalog(result)
          // D07 第 1 条：全部供应商失败时 DSH 不抛错而是给 failures——必须转成
          // 中文错误，不能返回 [] 冒充「没有模型」。
          const failure = rows.length === 0 ? catalogFailureMessage(result) : null
          if (failure !== null) throw new Error(failure)
          return rows
        }
      } catch (error) {
        throw new Error(`读取宿主模型目录失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    // 2) 兜底：llm.listProviders() + listModels()（只列有适配器、可路由的供应商）。
    let llm: LlmLike | undefined
    try { llm = ctx?.get?.('llm') } catch { llm = undefined }
    if (typeof llm?.listProviders === 'function' && typeof llm.listModels === 'function') {
      try {
        const providersRaw = await llm.listProviders()
        const providers = (Array.isArray(providersRaw) ? providersRaw : []) as Array<string | { id?: unknown }>
        const rows = await modelsFromLlm(providers, provider => llm!.listModels!(provider) ?? [])
        if (rows.length === 0) {
          throw new Error(providers.length === 0
            ? '宿主没有配置任何模型供应商（llm.listProviders 为空）'
            : '宿主模型目录为空：供应商没有返回任何可用模型')
        }
        return rows
      } catch (error) {
        throw new Error(`读取宿主模型目录失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    throw new Error('宿主没有可用的模型目录服务（modelCatalog / llm），无法列出可选模型')
  }
}

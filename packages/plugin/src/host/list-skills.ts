/**
 * 读取 DSH 的技能目录（P55）：给「岗位技能」的选择界面用，也给按队友限定技能用。
 *
 * 为什么要带作用域：DSH 的技能分层存放，读文件的提供方挂在「标准预设」这一层。
 * 不带作用域只能读到全局层，结果是空的（真实环境走查时发现，单元测试的替身发现不了）。
 * 这里照 DSH 自己的做法，先借一个标准预设的作用域，读完立刻归还，不需要真的开一个会话。
 *
 * 用中心根目录当工作目录读取，得到的是主人全局可用的技能，不混入某个项目或队友私有的技能。
 * 宿主没有技能服务时返回空数组，选择界面就只显示「队友自带」这一组。
 */

/** DSH 技能摘要里用得到的字段。 */
export interface HostSkillRow {
  name?: unknown
  description?: unknown
  invocation?: { modelInvocable?: unknown }
}

/**
 * 读全部技能（不含某位队友自己那一层，所以队友的过滤器调用它不会自己调自己）。
 * 借作用域失败时退回不带作用域的读法，宁可列表短一点，也不让页面报错。
 */
export async function readDshSkills(ctx: any, cwd: string, signal?: AbortSignal): Promise<HostSkillRow[]> {
  const skills = ctx.get?.('skills')
  if (typeof skills?.list !== 'function') return []
  let lease: { key: unknown; [Symbol.asyncDispose]?: () => Promise<void> } | undefined
  try {
    lease = await ctx.get?.('agentPresets')?.acquireScope?.('standard')
  } catch {
    lease = undefined
  }
  try {
    return await skills.list({ cwd, signal, ...(lease === undefined ? {} : { scope: lease.key }) }) as HostSkillRow[]
  } finally {
    // 这个作用域是借来的：不归还的话，DSH 无法回收旧版本的预设。
    try { await lease?.[Symbol.asyncDispose]?.() } catch { /* 归还失败不影响这次读取 */ }
  }
}

/** 只列模型能调用的技能：标了不给模型用的，选了也没有意义。 */
export function createHostListSkills(ctx: any, rootDir: string): () => Promise<Array<{ name: string; description: string }>> {
  return async () => {
    const rows = await readDshSkills(ctx, rootDir)
    return rows
      .filter(row => row.invocation?.modelInvocable !== false)
      .flatMap(row => typeof row.name === 'string' && typeof row.description === 'string'
        ? [{ name: row.name, description: row.description }] : [])
  }
}

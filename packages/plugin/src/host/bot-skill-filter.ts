/**
 * 按队友限定 DSH 技能（P55）：每位队友只看得到主人给它选的技能。
 *
 * 为什么要做：DSH 默认把电脑上所有技能的清单发给每个会话。主人电脑上有一百多个技能，
 * 不限定的话，每位队友每次开会话都要带上这张大清单，既费额度，也和「岗位技能」的意思不符。
 *
 * 怎么做到的（不改 DSH，只用它公开的分层规则）：
 * DSH 的技能注册表分层，读取时「离会话最近的一层」赢得同名条目。
 * 我们在队友自己的会话层注册一个提供方，把没被选中的技能各放一条同名记录，
 * 并标成「模型不可调用」。DSH 生成清单时会过滤掉它们，模型想硬加载也会被拒绝。
 * 被选中的技能不放记录，走的还是 DSH 原来的那份内容。
 *
 * 这一层出任何问题都只记日志：最坏结果是队友看到全部技能，不会影响它干活。
 */

/** DSH 技能摘要里用得到的字段。 */
export interface HostSkillSummary {
  name: string
  description: string
}

/** 我们交给 DSH 的「隐藏记录」，字段按 DSH 提供方的校验要求填。 */
export interface HiddenSkillCandidate {
  name: string
  description: string
  invocation: { modelInvocable: false; userInvocable: false }
  source: string
  provider: string
  rank: number
}

export const SKILL_FILTER_PROVIDER = 'dsh-buddy-skill-filter'

/** 算出要隐藏哪些技能：全量减去允许的；描述沿用原文，DSH 要求描述不能为空。 */
export function hiddenSkillCandidates(all: readonly HostSkillSummary[], allowed: ReadonlySet<string>): HiddenSkillCandidate[] {
  return all.filter(skill => !allowed.has(skill.name)).map(skill => ({
    name: skill.name,
    description: skill.description,
    invocation: { modelInvocable: false, userInvocable: false },
    source: 'dsh-buddy',
    provider: SKILL_FILTER_PROVIDER,
    // 同一层里只有我们这一个提供方，rank 取什么值都不影响结果。
    rank: 0,
  }))
}

/** 过滤器的控制柄：撤销，以及「主人改了选择后让 DSH 重新生成清单」。 */
export interface BotSkillFilter {
  dispose(): void
  /** 允许列表有变化时才让 DSH 重算，避免队友状态一变就重扫磁盘上的全部技能。 */
  refresh(): void
}

/**
 * 给一个队友会话装上过滤器；宿主没有技能服务时返回 null。
 * listAll 要读「队友这一层之外」的全部技能（见 list-skills.ts），这样不会自己调自己。
 * allowedNames 每次都现取，返回 null 表示认不出这位队友，此时不隐藏任何技能。
 */
export function installBotSkillFilter(input: {
  agent: any
  listAll: (cwd: string | undefined, signal: AbortSignal | undefined) => Promise<ReadonlyArray<{ name?: unknown; description?: unknown }>>
  allowedNames: () => readonly string[] | null
}): BotSkillFilter | null {
  const { agent, listAll, allowedNames } = input
  // 必须用 get 取服务：直接读 agent.ctx.skills 会被框架拒绝（没有声明依赖）。
  // get 返回的服务带着队友会话的上下文，注册才会落在队友自己这一层，不影响别的会话。
  const scoped = agent?.ctx?.get?.('skills')
  if (typeof scoped?.registerProvider !== 'function') return null

  let invalidate: (() => void) | null = null
  let lastKey = (allowedNames() ?? []).join(',')

  const dispose = scoped.registerProvider((control: { invalidate(): void }) => {
    invalidate = () => control.invalidate()
    return {
      name: SKILL_FILTER_PROVIDER,
      async list(options: { cwd?: string; signal?: AbortSignal }) {
        const allowed = allowedNames()
        if (allowed === null) return []
        const all = (await listAll(options.cwd, options.signal)).flatMap(row =>
          typeof row.name === 'string' && typeof row.description === 'string' && row.description !== ''
            ? [{ name: row.name, description: row.description }] : [])
        return hiddenSkillCandidates(all, new Set(allowed))
      },
      // 隐藏记录不会被加载：DSH 在加载前就按「模型不可调用」拒绝了。
      async get() { return undefined },
    }
  })

  return {
    dispose: () => { if (typeof dispose === 'function') dispose() },
    refresh() {
      const key = (allowedNames() ?? []).join(',')
      if (key === lastKey) return
      lastKey = key
      invalidate?.()
    },
  }
}

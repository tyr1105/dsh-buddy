/**
 * P75e 的测试三（插件侧）：技能过滤器在允许名单变化时调用 invalidate、名单不变（包括只是版本变化）时不调用。
 * 派活说明裁定 2：走方案 A、不需要强制重算，bot-skill-filter.ts 保持「按允许的技能名比较」的现有做法；
 * 自己积累的技能只通过允许名单（active 的目录名）进入清单，版本号变化不改名单、不触发重算。
 */
import { describe, expect, it } from 'vitest'
import { installBotSkillFilter, type HostSkillSummary } from '../src/host/bot-skill-filter.js'

const ALL: HostSkillSummary[] = [
  { name: 'owner-brief', description: '给主人的简报' },
  { name: 'self-abcd0001', description: '表单页做法：做表单页时用' },
  { name: 'self-abcd0002', description: '名单导出：导出名单文件时用' },
  { name: 'office-xlsx', description: '表格' },
]

/** 假的队友会话层：照 DSH 的形状记下提供方与 invalidate 次数。 */
function fakeAgent() {
  let provider: any = null
  let invalidations = 0
  const scoped = {
    registerProvider(create: (control: { invalidate(): void }) => unknown) {
      provider = create({ invalidate: () => { invalidations += 1 } })
      return () => { provider = null }
    },
  }
  const agent = { ctx: { get: (name: string) => name === 'skills' ? scoped : undefined } }
  return { agent, provider: () => provider, invalidations: () => invalidations }
}

describe('P75e 过滤器：名单变化才重算', () => {
  it('允许名单含自己积累的技能时它们不被隐藏；收起（离开名单）后被隐藏', async () => {
    let allowed: readonly string[] = ['owner-brief', 'self-abcd0001', 'self-abcd0002']
    const fake = fakeAgent()
    const filter = installBotSkillFilter({
      agent: fake.agent as any,
      listAll: async () => ALL,
      allowedNames: () => allowed,
    })
    expect(filter).not.toBeNull()
    // 名单内的三条都看得到；office-xlsx 被隐藏记录盖掉（模型不可调用）。
    const merged = new Map(ALL.map(row => [row.name, { invocation: { modelInvocable: true } }]))
    for (const row of await fake.provider().list({ cwd: '/home/bot' })) merged.set(row.name, row)
    const visible = [...merged].filter(([, row]) => (row as any).invocation?.modelInvocable !== false).map(([name]) => name)
    expect(visible).toEqual(['owner-brief', 'self-abcd0001', 'self-abcd0002'])
    // 收起一条（名单少了它）：refresh 触发一次 invalidate；清单里它被隐藏。
    allowed = ['owner-brief', 'self-abcd0002']
    filter!.refresh()
    expect(fake.invalidations()).toBe(1)
    const after = new Map(ALL.map(row => [row.name, { invocation: { modelInvocable: true } }]))
    for (const row of await fake.provider().list({ cwd: '/home/bot' })) after.set(row.name, row)
    expect([...after].filter(([, row]) => (row as any).invocation?.modelInvocable !== false).map(([name]) => name))
      .toEqual(['owner-brief', 'self-abcd0002'])
  })

  it('名单不变（包括只是版本号变化、别的员工变化）时 refresh 不调用 invalidate', () => {
    let allowed: readonly string[] = ['owner-brief', 'self-abcd0001']
    const fake = fakeAgent()
    const filter = installBotSkillFilter({ agent: fake.agent as any, listAll: async () => ALL, allowedNames: () => allowed })
    expect(fake.invalidations()).toBe(0)
    // 名单完全相同：不重算。技能版本从第 1 版变到第 2 版不进名单，同样不重算。
    filter!.refresh()
    filter!.refresh()
    expect(fake.invalidations()).toBe(0)
    // 顺序不同但集合相同：也不重算（比较键是逐名的逗号连接，顺序由中心保证稳定）。
    allowed = ['owner-brief', 'self-abcd0001']
    filter!.refresh()
    expect(fake.invalidations()).toBe(0)
    // 名单真的变了（放回另一条）：重算一次。
    allowed = ['owner-brief', 'self-abcd0001', 'self-abcd0002']
    filter!.refresh()
    expect(fake.invalidations()).toBe(1)
    filter!.dispose()
  })

  it('认不出这位队友（allowedNames 返回 null）时不隐藏任何技能', async () => {
    const fake = fakeAgent()
    installBotSkillFilter({ agent: fake.agent as any, listAll: async () => ALL, allowedNames: () => null })
    expect(await fake.provider().list({ cwd: '/home/bot' })).toEqual([])
  })
})

/**
 * P55 按队友限定 DSH 技能的测试。
 *
 * 这里用一个照着 DSH 规则写的假注册表（离会话最近的一层赢得同名条目，再过滤掉模型不可调用的），
 * 验证「只露出选中的技能」的计算和生命周期。真实 DSH 里的效果另在隔离沙箱走查。
 * 同时核对选择题的选项和 core 一致，避免界面能选、core 不认。
 */
import { describe, expect, it } from 'vitest'
import { hiddenSkillCandidates, installBotSkillFilter, SKILL_FILTER_PROVIDER, type HostSkillSummary } from '../src/host/bot-skill-filter.js'
import { createHostListSkills } from '../src/host/list-skills.js'
import { RHYTHM_OPTIONS, SPEECH_STYLE_OPTIONS, TEMPERAMENT_OPTIONS, ROLE_CARDS } from '../src/client/logic/wizard.js'
import { ROLES, SPEECH_STYLES, TEMPERAMENTS } from '@agent-hub/core'

const ALL: HostSkillSummary[] = [
  { name: 'office-xlsx', description: '表格' },
  { name: 'office-docx', description: '文档' },
  { name: 'lark-doc', description: '飞书文档' },
]

/** 假注册表：按 DSH 的规则合并全局层和队友层，再算模型能看到的目录。 */
function fakeRegistry() {
  let provider: any = null
  const invalidations: number[] = []
  const scoped = {
    registerProvider(create: (control: { invalidate(): void }) => unknown) {
      provider = create({ invalidate: () => { invalidations.push(1) } })
      return () => { provider = null }
    },
  }
  const listAll = async () => ALL
  /** 模型实际看到的技能名：队友层的同名条目盖掉全局层，然后去掉模型不可调用的。 */
  async function modelCatalog(): Promise<string[]> {
    const merged = new Map<string, { invocation?: { modelInvocable: boolean } }>(ALL.map(skill => [skill.name, { invocation: { modelInvocable: true } }]))
    for (const row of provider === null ? [] : await provider.list({ cwd: '/home/bot' })) merged.set(row.name, row)
    return [...merged].filter(([, row]) => row.invocation?.modelInvocable !== false).map(([name]) => name)
  }
  return { scoped, listAll, modelCatalog, invalidations, hasProvider: () => provider !== null }
}

/** 假的队友会话：和真实框架一样只能用 get 取服务，直接读属性会报错。 */
function agentWith(service: unknown) {
  return { ctx: { get: (name: string) => name === 'skills' ? service : undefined,
    get skills(): never { throw new Error('cannot get property "skills" without inject') } } }
}

describe('算出要隐藏的技能', () => {
  it('没选中的都隐藏，选中的不放记录', () => {
    const hidden = hiddenSkillCandidates(ALL, new Set(['office-xlsx']))
    expect(hidden.map(row => row.name)).toEqual(['office-docx', 'lark-doc'])
  })
  it('隐藏记录满足 DSH 对提供方的校验：有描述、标了来源，模型和用户都不可调用', () => {
    const [row] = hiddenSkillCandidates(ALL, new Set())
    expect(row).toEqual({ name: 'office-xlsx', description: '表格', invocation: { modelInvocable: false, userInvocable: false },
      source: 'dsh-buddy', provider: SKILL_FILTER_PROVIDER, rank: 0 })
  })
  it('全选时什么都不隐藏', () => expect(hiddenSkillCandidates(ALL, new Set(ALL.map(row => row.name)))).toEqual([]))
})

describe('队友只看得到选中的技能', () => {
  it('选了一个：模型的目录里只剩这一个', async () => {
    const registry = fakeRegistry()
    installBotSkillFilter({ agent: agentWith(registry.scoped), listAll: registry.listAll, allowedNames: () => ['office-xlsx'] })
    expect(await registry.modelCatalog()).toEqual(['office-xlsx'])
  })

  it('一个都没选：目录是空的，不再把上百个技能发给模型', async () => {
    const registry = fakeRegistry()
    installBotSkillFilter({ agent: agentWith(registry.scoped), listAll: registry.listAll, allowedNames: () => [] })
    expect(await registry.modelCatalog()).toEqual([])
  })

  it('反例：认不出这位队友时不隐藏，宁可多看也不让它什么都用不了', async () => {
    const registry = fakeRegistry()
    installBotSkillFilter({ agent: agentWith(registry.scoped), listAll: registry.listAll, allowedNames: () => null })
    expect(await registry.modelCatalog()).toEqual(ALL.map(row => row.name))
  })

  it('主人改了选择才让 DSH 重算；选择没变时不重扫，队友状态变化很频繁', () => {
    const registry = fakeRegistry()
    let allowed = ['office-xlsx']
    const filter = installBotSkillFilter({ agent: agentWith(registry.scoped), listAll: registry.listAll, allowedNames: () => allowed })!
    filter.refresh()
    filter.refresh()
    expect(registry.invalidations).toHaveLength(0)
    allowed = ['office-docx']
    filter.refresh()
    filter.refresh()
    expect(registry.invalidations).toHaveLength(1)
  })

  it('撤销后恢复原样', async () => {
    const registry = fakeRegistry()
    const filter = installBotSkillFilter({ agent: agentWith(registry.scoped), listAll: registry.listAll, allowedNames: () => [] })!
    filter.dispose()
    expect(registry.hasProvider()).toBe(false)
    expect(await registry.modelCatalog()).toHaveLength(3)
  })

  it('反例：宿主没有技能服务时不装，也不报错', () => {
    expect(installBotSkillFilter({ agent: agentWith(undefined), listAll: async () => [], allowedNames: () => [] })).toBeNull()
  })
})

describe('读取 DSH 技能目录', () => {
  /** 假宿主：技能服务记下每次读取时带的作用域，预设服务记下有没有归还。 */
  const ctx = (rows: unknown[], returned: string[] = [], scopes: unknown[] = []) => ({ get: (name: string) => {
    if (name === 'skills') return { list: async (options: { cwd: string; scope?: unknown }) => { expect(options.cwd).toBe('/root'); scopes.push(options.scope); return rows } }
    if (name === 'agentPresets') return { acquireScope: async (id: string) => ({ key: `scope:${id}`, [Symbol.asyncDispose]: async () => { returned.push(id) } }) }
    return undefined
  } })

  it('只列模型能调用的技能，没写调用策略的按可用算', async () => {
    const list = createHostListSkills(ctx([
      { name: 'a', description: 'A', invocation: { modelInvocable: true } },
      { name: 'b', description: 'B', invocation: { modelInvocable: false } },
      { name: 'c', description: 'C' },
    ]), '/root')
    expect(await list()).toEqual([{ name: 'a', description: 'A' }, { name: 'c', description: 'C' }])
  })
  it('带着标准预设的作用域读取，读完归还：不带作用域在真实 DSH 里读到的是空的', async () => {
    const returned: string[] = []
    const scopes: unknown[] = []
    await createHostListSkills(ctx([], returned, scopes), '/root')()
    expect(scopes).toEqual(['scope:standard'])
    expect(returned).toEqual(['standard'])
  })
  it('反例：借不到作用域时退回不带作用域读取，不报错', async () => {
    const scopes: unknown[] = []
    const host = { get: (name: string) => name === 'skills' ? { list: async (options: { scope?: unknown }) => { scopes.push(options.scope); return [] } }
      : name === 'agentPresets' ? { acquireScope: async () => { throw new Error('没有这个预设') } } : undefined }
    await expect(createHostListSkills(host, '/root')()).resolves.toEqual([])
    expect(scopes).toEqual([undefined])
  })
  it('字段类型不对的行丢掉', async () => {
    expect(await createHostListSkills(ctx([{ name: 1, description: 'A' }, { name: 'b' }]), '/root')()).toEqual([])
  })
  it('反例：宿主没有技能服务时返回空清单', async () => {
    expect(await createHostListSkills({ get: () => undefined }, '/root')()).toEqual([])
  })
})

describe('界面选项和 core 一致', () => {
  it('执行风格、性格、说话风格的 id 完全相同', () => {
    expect(ROLE_CARDS.map(card => card.role).sort()).toEqual([...ROLES].sort())
    expect(TEMPERAMENT_OPTIONS.map(option => option.value).sort()).toEqual([...TEMPERAMENTS].sort())
    expect(SPEECH_STYLE_OPTIONS.map(option => option.value).sort()).toEqual([...SPEECH_STYLES].sort())
  })
  it('节奏只用 core 认识的等级和节奏档', () => {
    for (const option of RHYTHM_OPTIONS) {
      expect(['L0', 'L1', 'L2', 'L3']).toContain(option.autonomy)
      expect(['active', 'normal', 'quiet']).toContain(option.pace)
    }
  })
})

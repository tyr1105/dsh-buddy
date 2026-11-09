/**
 * 资料授权矩阵页纯逻辑测试（V2-PH2-04）：计数一句话、访问结论、chip 文案（含对象
 * 已删除/退役的历史授权）、空态文案、授权对象分组、表单前置校验与命令入参拼装。
 *
 * 为什么单独测：这些函数决定资料页「普通/受限怎么说、历史坏授权怎么显示、什么错误
 * 先拦」，一旦与 core 口径错位，界面会把受限当全队可读、或把路径越界规则复制成
 * 两份。用例基于 shared/fixture-resource.ts，造局部数据只改本地构造，不污染样例。
 * 主人取消编制后授权对象只认队友本人，不再有部门与席位授权。
 */
import { describe, expect, it } from 'vitest'
import type {
  Grant, Lifecycle, Resource, ResourceGrantViewRow, ResourceView, ResourceViewRow,
} from '../src/shared/views.js'
import { fixtureResource } from '../src/shared/fixture-resource.js'
import {
  GRANT_LEVEL_OPTIONS, GRANT_SUBJECT_OPTIONS, RESOURCE_BOUNDARY_TEXT, RESOURCE_KIND_OPTIONS,
  RESOURCE_SENSITIVITY_OPTIONS, accessConclusion, activeRows, archivedRows, buildSetGrantInput,
  buildSaveResourceInput, findGrant, grantChipText, grantSubjectGroups, grantSubjectText,
  grantChanges, resourceEmptyText, resourceSummary, subjectOptionsOf, validateResourceAccess, validateResourceForm,
  validateResourceLocator, validateResourceName,
} from '../src/client/logic/resource-page.js'

/** 造一条资料事实（测试默认值：未归档普通目录）。 */
function resource(over: Partial<Resource> & Pick<Resource, 'id' | 'name'>): Resource {
  return {
    kind: 'dir', locator: '/Users/demo/AgentHub/shared/x',
    sensitivity: 'normal', createdAt: 1, updatedAt: 1, archivedAt: null, ...over,
  }
}

/** 造一条授权展开行（测试默认值：队友 bot_1 只读、对象名叫「某队友」）。 */
function grantRow(over: Omit<Partial<ResourceGrantViewRow>, 'grant'> & { grant?: Partial<Grant> } = {}): ResourceGrantViewRow {
  const subjectKind = over.subjectKind ?? 'bot'
  const level = over.level ?? 'read'
  const grant: Grant = {
    id: 'gr_1', resourceId: 'res_1', subjectKind, subjectId: 'bot_1', level,
    createdAt: 1, createdBy: 'owner', ...over.grant,
  }
  return {
    grant,
    resourceName: over.resourceName ?? '某资料',
    subjectKind,
    subjectKindLabel: over.subjectKindLabel ?? '队友',
    subjectId: over.subjectId ?? grant.subjectId,
    subjectName: over.subjectName === undefined ? '某队友' : over.subjectName,
    level,
    levelLabel: over.levelLabel ?? '只读',
  }
}

/** 造一行资料视图行（测试默认：未归档普通目录、无授权）。 */
function viewRow(over: {
  resource?: Partial<Resource>
  id?: string
  name?: string
  kind?: Resource['kind']
  sensitivity?: Resource['sensitivity']
  archived?: boolean
  grants?: ResourceGrantViewRow[]
} = {}): ResourceViewRow {
  const r = resource({
    id: over.id ?? 'res_1', name: over.name ?? '某资料', kind: over.kind ?? 'dir',
    sensitivity: over.sensitivity ?? 'normal', archivedAt: over.archived ? 9 : null, ...over.resource,
  })
  const sensitivityLabel = r.sensitivity === 'restricted' ? '受限' : '普通'
  const kindLabel = r.kind === 'dir' ? '目录' : r.kind === 'file' ? '文件' : r.kind === 'url' ? '链接' : '笔记'
  return {
    resource: r, kindLabel, sensitivityLabel,
    archived: r.archivedAt !== null,
    grants: over.grants ?? [],
  }
}

/** 造一份资料视图（counts 按行自动数，授权条数取 grants 长度，避免用例自己数错）。 */
function view(rows: ResourceViewRow[]): ResourceView {
  const grants = rows.flatMap(r => r.grants)
  return {
    asOf: 1, resources: rows, grants,
    counts: {
      total: rows.length,
      active: rows.filter(r => !r.archived).length,
      archived: rows.filter(r => r.archived).length,
      grants: grants.length,
    },
  }
}

/** 空资料矩阵（停用时门面给的就是这种形状）。 */
function emptyView(): ResourceView {
  return { asOf: 0, resources: [], grants: [], counts: { total: 0, active: 0, archived: 0, grants: 0 } }
}

describe('resourceSummary：顶部一句话计数', () => {
  it('正例：按样例 counts 拼「资料 N 条·活跃 X·归档 Y·授权 Z 条」', () => {
    expect(resourceSummary(fixtureResource)).toBe('资料 4 条·活跃 3·归档 1·授权 3 条')
  })
  it('反例/边界：空矩阵与全归档都如实报 0，不拿 undefined 充数', () => {
    expect(resourceSummary(emptyView())).toBe('资料 0 条·活跃 0·归档 0·授权 0 条')
    const archived = view([viewRow({ id: 'res_a', archived: true })])
    expect(resourceSummary(archived)).toBe('资料 1 条·活跃 0·归档 1·授权 0 条')
  })
})

describe('activeRows / archivedRows：分行且保持视图顺序', () => {
  it('正例：样例 3 条活跃在前、1 条归档在后，顺序与视图一致（不重排）', () => {
    expect(activeRows(fixtureResource).map(r => r.resource.id)).toEqual(['res_shared', 'res_playbook', 'res_dashboard'])
    expect(archivedRows(fixtureResource).map(r => r.resource.id)).toEqual(['res_old'])
  })
  it('反例：视图顺序被打乱时也不自行排序（排序是 core 的职责）', () => {
    const archived = viewRow({ id: 'res_archived', archived: true })
    const active = viewRow({ id: 'res_active' })
    const shuffled = view([archived, active])
    expect(activeRows(shuffled).map(r => r.resource.id)).toEqual(['res_active'])
    expect(archivedRows(shuffled).map(r => r.resource.id)).toEqual(['res_archived'])
  })
})

describe('accessConclusion：一行资料的访问结论', () => {
  it('全员可读的资料不看授权条数', () => {
    expect(accessConclusion(viewRow({ sensitivity: 'normal', grants: [grantRow()] }))).toBe('在岗队友都能读')
  })
  it('受限资料报授权对象个数（样例手册 2 个、看板 1 个）', () => {
    const playbook = fixtureResource.resources.find(r => r.resource.id === 'res_playbook')!
    const dashboard = fixtureResource.resources.find(r => r.resource.id === 'res_dashboard')!
    expect(accessConclusion(playbook)).toBe('2 位队友能读')
    expect(accessConclusion(dashboard)).toBe('1 位队友能读')
  })
  it('反例：受限资料 0 授权也要如实说，不冒充「全队可读」', () => {
    expect(accessConclusion(viewRow({ sensitivity: 'restricted' }))).toBe('暂未选择队友，当前无人可读')
  })
})

describe('grantSubjectText / grantChipText：授权 chip 文案', () => {
  it('正例：对象类型＋对象名＋级别（队友：探路（只读））', () => {
    const g = grantRow({ subjectKindLabel: '队友', subjectName: '探路', levelLabel: '只读' })
    expect(grantSubjectText(g)).toBe('探路')
    expect(grantChipText(g)).toBe('队友：探路（只读）')
  })
  it('读写级别照样拼出（队友：巡检员（读写））', () => {
    const g = grantRow({ grant: { subjectId: 'bot-xunjian' }, subjectId: 'bot-xunjian', subjectName: '巡检员', level: 'write', levelLabel: '读写' })
    expect(grantChipText(g)).toBe('队友：巡检员（读写）')
  })
  it('反例：subjectName 为 null（对象已删除或退役）显示固定占位，不显示裸 id', () => {
    const gone = fixtureResource.grants.find(g => g.grant.id === 'gr_bot_gone')!
    expect(gone.subjectName).toBeNull()
    expect(grantChipText(gone)).toBe('队友：队友已删除或退役（只读）')
    expect(grantSubjectText(gone)).toBe('队友已删除或退役')
  })
})

describe('resourceEmptyText：空态文案', () => {
  it('一条资料都没有：指引去登记第一条', () => {
    const text = resourceEmptyText(emptyView())
    expect(text).toContain('暂无资料授权')
    expect(text).toContain('新资料')
  })
  it('只剩归档资料：说明数量并指向归档区', () => {
    const text = resourceEmptyText(view([viewRow({ id: 'res_a', archived: true }), viewRow({ id: 'res_b', archived: true })]))
    expect(text).toContain('暂无未归档资料')
    expect(text).toContain('2 条历史资料')
  })
  it('反例：有活跃资料时返回 null（不算空态，不显示空态卡片）', () => {
    expect(resourceEmptyText(view([viewRow()]))).toBeNull()
    expect(resourceEmptyText(fixtureResource)).toBeNull()
  })
})

describe('grantSubjectGroups：授权对象只有队友一组', () => {
  it('队友组：排除 retired，保留 quarantined（保守：授权是配置动作，生效由 core 把关）并标注状态', () => {
    const bots: Array<{ id: string; name: string; lifecycle: Lifecycle }> = [
      { id: 'b_1', name: '探路', lifecycle: 'active' },
      { id: 'b_2', name: '旧将', lifecycle: 'retired' },
      { id: 'b_3', name: '隔离者', lifecycle: 'quarantined' },
      { id: 'b_4', name: '暂停者', lifecycle: 'paused' },
      { id: 'b_5', name: '草稿', lifecycle: 'draft' },
    ]
    const groups = grantSubjectGroups(bots)
    expect(groups.bot.map(o => o.id)).toEqual(['b_1', 'b_3', 'b_4', 'b_5'])
    expect(groups.bot.find(o => o.id === 'b_1')!.label).toBe('探路')
    expect(groups.bot.find(o => o.id === 'b_3')!.label).toBe('隔离者（隔离中）')
    expect(groups.bot.find(o => o.id === 'b_4')!.label).toBe('暂停者（已暂停）')
    expect(groups.bot.find(o => o.id === 'b_5')!.label).toBe('草稿（草稿）')
  })
  it('反例：总览还没加载（空数组）时队友组为空，不抛错', () => {
    const groups = grantSubjectGroups([])
    expect(groups.bot).toEqual([])
  })
  it('subjectOptionsOf 按类型取队友组', () => {
    const groups = grantSubjectGroups([{ id: 'b_1', name: '探路', lifecycle: 'probation' }])
    expect(subjectOptionsOf(groups, 'bot')).toEqual([{ kind: 'bot', id: 'b_1', label: '探路' }])
  })
})

describe('findGrant：识别「改级别」还是「新授权」', () => {
  const row = viewRow({ sensitivity: 'restricted', grants: [grantRow({ grant: { subjectKind: 'bot', subjectId: 'b_9' }, subjectKind: 'bot', subjectId: 'b_9' })] })
  it('正例：同资源+同类型+同 id 命中现有授权', () => {
    expect(findGrant(row, 'bot', 'b_9')?.grant.id).toBe('gr_1')
  })
  it('反例：换队友 id 算新授权（去重自然键含 subjectKind）', () => {
    expect(findGrant(row, 'bot', 'b_other')).toBeNull()
  })
})

describe('validateResourceName：名称前置校验', () => {
  it('反例：空/纯空白报中文错误', () => {
    expect(validateResourceName('')).toBe('资料名称：不能为空')
    expect(validateResourceName('   ')).toBe('资料名称：不能为空')
  })
  it('反例：超过 120 字报超长并带上实际字数', () => {
    const message = validateResourceName('资'.repeat(121))
    expect(message).toContain('不能超过 120 字')
    expect(message).toContain('121')
  })
  it('正例：首尾空白不影响合法判定（提交时 trim）', () => {
    expect(validateResourceName('  手册  ')).toBeNull()
    expect(validateResourceName('资'.repeat(120))).toBeNull()
  })
})

describe('validateResourceLocator：位置前置校验（不复制 core 的越界判定）', () => {
  it('反例：空、超长', () => {
    expect(validateResourceLocator('url', '')).toBe('资料位置：不能为空')
    expect(validateResourceLocator('dir', '  ')).toBe('资料位置：不能为空')
    const message = validateResourceLocator('file', 'a'.repeat(1001))
    expect(message).toContain('不能超过 1000 字')
  })
  it('反例：url 必须是 http(s)：裸域名、ftp、乱填都拒绝', () => {
    expect(validateResourceLocator('url', 'inside.example.com/dashboard')).toContain('http')
    expect(validateResourceLocator('url', 'ftp://inside.example.com/x')).toContain('http')
    expect(validateResourceLocator('url', 'not a url')).toContain('http')
  })
  it('正例：http/https 通过（地址存在性不由前端判）', () => {
    expect(validateResourceLocator('url', 'https://inside.example.com/dashboard')).toBeNull()
    expect(validateResourceLocator('url', 'http://localhost:8787/x')).toBeNull()
  })
  it('反例：dir/file 相对路径拒绝，并说明要绝对路径；绝对路径放行（越界交给 core）', () => {
    expect(validateResourceLocator('dir', 'shared/团队资料')).toContain('绝对路径')
    expect(validateResourceLocator('file', './手册.md')).toContain('绝对路径')
    expect(validateResourceLocator('dir', '/Users/demo/AgentHub/shared/团队资料')).toBeNull()
    expect(validateResourceLocator('file', '/Users/demo/AgentHub/shared/x.md')).toBeNull()
  })
  it('边界纪律：前端不判共享目录越界与凭据路径（/etc 这种明显越界也放行，由 core 拦）', () => {
    expect(validateResourceLocator('file', '/etc/passwd')).toBeNull()
  })
})

describe('validateResourceForm：整表先报第一个出错字段（供聚焦）', () => {
  it('名称先于位置；返回 field 让对话框聚焦', () => {
    expect(validateResourceForm({ name: '', kind: 'dir', locator: '/x', sensitivity: 'normal' }))
      .toEqual({ field: 'name', message: '资料名称：不能为空' })
  })
  it('名称合法后才查位置', () => {
    expect(validateResourceForm({ name: '手册', kind: 'url', locator: '裸域名', sensitivity: 'normal' }))
      .toEqual({ field: 'locator', message: expect.stringContaining('http') })
  })
  it('正例：全部合法返回 null', () => {
    expect(validateResourceForm({ name: '手册', kind: 'file', locator: '/Users/demo/AgentHub/shared/手册.md', sensitivity: 'restricted' })).toBeNull()
  })
})

describe('命令入参拼装（core strictObject，多键会被拒）', () => {
  it('新建：trim 名称/位置、不带 id、不带已取消的归属字段', () => {
    const raw = buildSaveResourceInput({ name: ' 手册 ', kind: 'file', locator: ' /x ', sensitivity: 'normal' })
    expect(raw).toEqual({ name: '手册', kind: 'file', locator: '/x', sensitivity: 'normal' })
  })
  it('编辑：带 id、保留类型；改受限状态也照传', () => {
    const raw = buildSaveResourceInput({ name: '手册', kind: 'url', locator: 'https://x.com', sensitivity: 'restricted' }, 'res_1')
    expect(raw).toEqual({ id: 'res_1', name: '手册', kind: 'url', locator: 'https://x.com', sensitivity: 'restricted' })
  })
  it('setGrant：resourceId+subjectKind+subjectId+level 四键，无多余字段', () => {
    expect(buildSetGrantInput('res_1', 'bot', 'bot-xunjian', 'write'))
      .toEqual({ resourceId: 'res_1', subjectKind: 'bot', subjectId: 'bot-xunjian', level: 'write' })
  })
})

describe('静态选项与边界横幅', () => {
  it('类型选项只有 dir/file/url（note 本期不给入口）；中文标签与 core 对齐', () => {
    expect(RESOURCE_KIND_OPTIONS.map(o => o.value)).toEqual(['dir', 'file', 'url'])
    expect(RESOURCE_KIND_OPTIONS.map(o => o.label)).toEqual(['目录', '文件', '链接'])
    expect(RESOURCE_SENSITIVITY_OPTIONS.map(o => [o.value, o.label])).toEqual([
      ['normal', '全员可读'],
      ['restricted', '指定队友可读'],
    ])
    expect(GRANT_SUBJECT_OPTIONS.map(o => o.value)).toEqual(['bot'])
    expect(GRANT_LEVEL_OPTIONS.map(o => [o.value, o.label])).toEqual([['read', '只读'], ['write', '读写']])
  })
  it('级别枚举是 read/write（不是 read/readwrite），标签为只读/读写', () => {
    // 任务卡文字曾写 read/readwrite；以 core 的实际枚举为准，这里钉死防止漂移。
    expect(GRANT_LEVEL_OPTIONS.map(o => o.value)).not.toContain('readwrite')
  })
  it('边界横幅为 U11 文案定稿：只管插件读资料要不要批准（#30）', () => {
    expect(RESOURCE_BOUNDARY_TEXT).toBe('这里只管一件事：队友通过插件读资料时，要不要你批准。它自己在 DSH 里打开文件，不归这里管。')
  })
})

describe('样例资料夹具形状（fixture-resource）', () => {
  it('3 活跃 + 1 归档、3 授权；counts 与行实际一致', () => {
    expect(fixtureResource.resources).toHaveLength(4)
    expect(activeRows(fixtureResource)).toHaveLength(3)
    expect(archivedRows(fixtureResource)).toHaveLength(1)
    expect(fixtureResource.grants).toHaveLength(3)
    expect(fixtureResource.counts).toEqual({ total: 4, active: 3, archived: 1, grants: 3 })
  })
  it('全部授权对象都是队友；含一条对象找不到的历史授权（subjectName=null）但级别标签齐全', () => {
    expect(fixtureResource.grants.every(g => g.subjectKind === 'bot')).toBe(true)
    expect(fixtureResource.grants.every(g => g.subjectKindLabel === '队友')).toBe(true)
    const gone = fixtureResource.grants.filter(g => g.subjectName === null)
    expect(gone).toHaveLength(1)
    expect(gone[0]!.levelLabel).toBe('只读')
  })
})

describe('P50 谁能读', () => {
  it('必须明确选一项，不能留空', () => {
    expect(validateResourceAccess(null, [])?.field).toBe('access')
    expect(validateResourceAccess('normal', [])).toBeNull()
  })
  it('指定队友至少勾一位', () => {
    expect(validateResourceAccess('restricted', [])?.message).toContain('至少勾选')
    expect(validateResourceAccess('restricted', ['bot_1'])).toBeNull()
  })
  it('算出要新增和要取消的队友', () => {
    const row = viewRow({ sensitivity: 'restricted', grants: [grantRow({ subjectId: 'bot_a' }), grantRow({ subjectId: 'bot_b' })] })
    expect(grantChanges(row, ['bot_b', 'bot_c'])).toEqual({ add: ['bot_c'], remove: ['bot_a'] })
  })
  it('新建资料没有旧授权，勾选的全部新增', () => {
    expect(grantChanges(null, ['bot_a'])).toEqual({ add: ['bot_a'], remove: [] })
  })
})

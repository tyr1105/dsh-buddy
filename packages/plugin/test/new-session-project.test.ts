/**
 * 新会话页「选项目」规则的单元测试（P57 后半段）。
 *
 * 重点钉住输入框标签和选中状态的同步：路径很多（先打字后选项目、换项目、
 * 换回工作区、手动删标签、发送中），任何一条走错，话就会发到错的地方或者草稿丢掉。
 */
import { describe, expect, it } from 'vitest'
import {
  PROJECT_CHIP_IDLE,
  PROJECT_CLAIM_NAME,
  activeProjects,
  buildPickerEntries,
  projectChipStep,
  projectFromToken,
  projectHint,
  projectMentionRows,
  projectMentionSection,
  projectToken,
  type ComposerState,
  type HostWorkspaceRow,
  type ProjectChoice,
} from '../src/client/logic/new-session-project.js'
import { TEAMMATE_CLAIM_NAME } from '../src/client/logic/new-session-mention.js'
import type { BotCard, ProjectView } from '../src/shared/views.js'

const dddd: ProjectChoice = {
  id: 'prj_a',
  name: 'dddd',
  members: [
    { botId: 'b_2', name: '老王', roleLabel: '执行', isOwner: false },
    { botId: 'b_1', name: '小李', roleLabel: '调研', isOwner: true },
  ],
}
const other: ProjectChoice = { id: 'prj_b', name: '另一个项目', members: [] }

function bot(overrides: Partial<BotCard> & Pick<BotCard, 'id' | 'name'>): BotCard {
  return { roleLabel: '调研', lifecycle: 'active', archived: false, color: '#123', initials: '小', ...overrides } as BotCard
}

function viewOf(rows: Array<Record<string, unknown>>): ProjectView {
  return { projects: rows } as unknown as ProjectView
}

describe('能选的项目', () => {
  it('项目视图还没读出来时为空，下拉不显示这一组', () => {
    expect(activeProjects(null)).toEqual([])
  })

  it('只列进行中的项目', () => {
    const view = viewOf([
      { project: { id: 'prj_a', name: '进行中', status: 'active' }, members: [] },
      { project: { id: 'prj_b', name: '暂停', status: 'paused' }, members: [] },
      { project: { id: 'prj_c', name: '完成', status: 'done' }, members: [] },
      { project: { id: 'prj_d', name: '归档', status: 'archived' }, members: [] },
    ])
    expect(activeProjects(view).map(item => item.id)).toEqual(['prj_a'])
  })

  it('成员里失效的（档案已删）跳过，执行风格缺失时留空', () => {
    const view = viewOf([{
      project: { id: 'prj_a', name: 'x', status: 'active' },
      members: [
        { botId: 'b_1', name: '小李', invalid: false, role: 'researcher', roleLabel: '调研', isOwner: true },
        { botId: 'b_gone', name: null, invalid: true, role: null, roleLabel: null, isOwner: false },
        { botId: 'b_3', name: '无风格', invalid: false, role: null, roleLabel: null, isOwner: false },
      ],
    }])
    expect(activeProjects(view)[0]?.members).toEqual([
      { botId: 'b_1', name: '小李', roleLabel: '调研', isOwner: true },
      { botId: 'b_3', name: '无风格', roleLabel: '', isOwner: false },
    ])
  })
})

describe('项目标签', () => {
  it('带尾随空格，后面的字才算正文', () => {
    expect(projectToken('dddd')).toBe('#dddd ')
  })

  it('按标签文字找回项目，名字要完全相等', () => {
    expect(projectFromToken([dddd], '#dddd')?.id).toBe('prj_a')
    expect(projectFromToken([dddd], '#dddd ')?.id).toBe('prj_a')
    expect(projectFromToken([dddd], '#ddd')).toBeUndefined()
  })

  it('反例：不是 # 开头的文字不认', () => {
    expect(projectFromToken([dddd], 'dddd')).toBeUndefined()
    expect(projectFromToken([dddd], '@dddd')).toBeUndefined()
  })

  it('提示写清不 @ 时发给负责人是谁', () => {
    expect(projectHint(dddd)).toBe('发到项目 dddd。不 @ 时默认发给负责人 小李')
  })

  it('还没有负责人时不编名字', () => {
    expect(projectHint(other)).toBe('发到项目 另一个项目。不 @ 时默认发给项目负责人')
  })
})

describe('@ 列项目成员', () => {
  const bots = [bot({ id: 'b_1', name: '小李' }), bot({ id: 'b_2', name: '老王', roleLabel: '执行' })]

  it('负责人排第一并标出来，其余成员不标', () => {
    const rows = projectMentionRows(dddd, bots, '')
    expect(rows.map(row => row.bot.id)).toEqual(['b_1', 'b_2'])
    expect(rows[0]?.description).toBe('负责人 · 调研')
    expect(rows[1]?.description).toBe('执行')
  })

  it('按名字或执行风格搜索', () => {
    expect(projectMentionRows(dddd, bots, '王').map(row => row.bot.id)).toEqual(['b_2'])
    expect(projectMentionRows(dddd, bots, '调研').map(row => row.bot.id)).toEqual(['b_1'])
  })

  it('反例：不在项目里的队友不列', () => {
    const rows = projectMentionRows(dddd, [...bots, bot({ id: 'b_9', name: '局外人' })], '')
    expect(rows.map(row => row.bot.id)).not.toContain('b_9')
  })

  it('反例：已退役、已归档、名册里查不到的成员不列', () => {
    const rows = projectMentionRows(dddd, [bot({ id: 'b_1', name: '小李', lifecycle: 'retired' }), bot({ id: 'b_2', name: '老王', archived: true })], '')
    expect(rows).toEqual([])
    expect(projectMentionRows(dddd, [], '')).toEqual([])
  })

  it('分组标题写明是哪个项目', () => {
    expect(projectMentionSection('dddd')).toContain('dddd')
  })
})

describe('输入框标签跟着选中状态走', () => {
  const plain = (draft: string): ComposerState => ({ phase: 'plain', draft })
  const chip = (draft: string, token = '#dddd '): ComposerState => ({ phase: 'claimed', draft, claim: { name: PROJECT_CLAIM_NAME, token } })

  it('选了项目：标签放到最前面，已打的字留在后面', () => {
    const step = projectChipStep(plain('帮我写周报'), dddd, PROJECT_CHIP_IDLE)
    expect(step.draft).toEqual({ text: '#dddd 帮我写周报', references: [], command: { token: '#dddd ' } })
    expect(step.memo).toEqual({ applied: '#dddd ', sawChip: false })
    expect(step.clearSelection).toBe(false)
  })

  it('空草稿也放标签，提示才看得到；不写尾随空格，否则光标会停在标签和空格中间', () => {
    expect(projectChipStep(plain(''), dddd, PROJECT_CHIP_IDLE).draft).toEqual({ text: '#dddd', references: [], command: { token: '#dddd ' } })
  })

  it('标签还没建好时不重复放，也不当成被删', () => {
    const step = projectChipStep(plain('#dddd 帮我'), dddd, { applied: '#dddd ', sawChip: false })
    expect(step.draft).toBeNull()
    expect(step.clearSelection).toBe(false)
  })

  it('标签建好后记下来，什么都不用动', () => {
    const step = projectChipStep(chip('#dddd 帮我'), dddd, { applied: '#dddd ', sawChip: false })
    expect(step).toEqual({ memo: { applied: '#dddd ', sawChip: true }, draft: null, clearSelection: false, chipAppeared: true })
  })

  it('标签已经在了：之后不再报「刚建好」，光标不会被反复挪走', () => {
    expect(projectChipStep(chip('#dddd 帮我'), dddd, { applied: '#dddd ', sawChip: true }).chipAppeared).toBe(false)
  })

  it('主人删掉标签：等于退出项目，不再塞回去', () => {
    const step = projectChipStep(plain('帮我'), dddd, { applied: '#dddd ', sawChip: true })
    expect(step.clearSelection).toBe(true)
    expect(step.draft).toBeNull()
    expect(step.memo).toEqual(PROJECT_CHIP_IDLE)
  })

  it('换回普通工作区：摘掉标签，正文一字不丢', () => {
    const step = projectChipStep(chip('#dddd 帮我写周报'), null, { applied: '#dddd ', sawChip: true })
    expect(step.draft).toBe('帮我写周报')
    expect(step.memo).toEqual(PROJECT_CHIP_IDLE)
    expect(step.clearSelection).toBe(false)
  })

  it('换成另一个项目：换标签，正文不动', () => {
    const step = projectChipStep(chip('#dddd 帮我'), other, { applied: '#dddd ', sawChip: true })
    expect(step.draft).toEqual({ text: '#另一个项目 帮我', references: [], command: { token: '#另一个项目 ' } })
    expect(step.memo).toEqual({ applied: '#另一个项目 ', sawChip: false })
  })

  it('已经有「发给本人」的标签时选项目：@名字变成正文，放上项目标签', () => {
    const state: ComposerState = { phase: 'claimed', draft: '@小李 帮我', claim: { name: TEAMMATE_CLAIM_NAME, token: '@小李 ' } }
    expect(projectChipStep(state, dddd, PROJECT_CHIP_IDLE).draft).toMatchObject({ text: '#dddd @小李 帮我' })
  })

  it('没选项目时不碰「发给本人」的标签', () => {
    const state: ComposerState = { phase: 'claimed', draft: '@小李 帮我', claim: { name: TEAMMATE_CLAIM_NAME, token: '@小李 ' } }
    expect(projectChipStep(state, null, PROJECT_CHIP_IDLE).draft).toBeNull()
  })

  it('没选项目、没有标签：什么都不动', () => {
    expect(projectChipStep(plain('普通的话'), null, PROJECT_CHIP_IDLE)).toEqual({ memo: PROJECT_CHIP_IDLE, draft: null, clearSelection: false, chipAppeared: false })
  })

  it('发送中不动输入框，也不改记录', () => {
    const memo = { applied: '#dddd ', sawChip: true }
    for (const phase of ['submitting', 'sending', 'adjudicating']) {
      expect(projectChipStep({ phase, draft: '#dddd 帮我' }, null, memo)).toEqual({ memo, draft: null, clearSelection: false, chipAppeared: false })
    }
  })
})

describe('下拉内容', () => {
  const rows: HostWorkspaceRow[] = [{ workspaceId: 'w1', title: 'code', path: '/Users/me/code' }]
  const input = { projects: [dddd], workspaces: rows, selectedWorkspaceId: 'w1', selectedProjectId: null, defaultWorkspaceName: '默认工作区' }

  it('项目行带上发给谁的说明', () => {
    const { projects } = buildPickerEntries(input)
    expect(projects[0]).toMatchObject({ label: 'dddd', projectId: 'prj_a', workspaceId: null, title: projectHint(dddd) })
  })

  it('没选项目时勾当前工作区', () => {
    const entries = buildPickerEntries(input)
    expect(entries.workspaces[0]?.selected).toBe(true)
    expect(entries.projects[0]?.selected).toBe(false)
  })

  it('选了项目时只勾项目，工作区不再打勾', () => {
    const entries = buildPickerEntries({ ...input, selectedProjectId: 'prj_a' })
    expect(entries.projects[0]?.selected).toBe(true)
    expect(entries.workspaces[0]?.selected).toBe(false)
  })

  it('没有进行中的项目时这一组为空', () => {
    expect(buildPickerEntries({ ...input, projects: [] }).projects).toEqual([])
  })

  it('内部默认标题显示成本地化名字', () => {
    const entries = buildPickerEntries({ ...input, workspaces: [{ workspaceId: 'w1', title: 'default-workspace', path: '/x/default-workspace' }] })
    expect(entries.workspaces[0]?.label).toBe('默认工作区')
  })

  it('同名工作区带路径片段区分，不同名的不带', () => {
    const workspaces: HostWorkspaceRow[] = [
      { workspaceId: 'w1', title: 'app', path: '/a/one/app' },
      { workspaceId: 'w2', title: 'app', path: '/b/two/app' },
      { workspaceId: 'w3', title: 'solo', path: '/c/solo' },
    ]
    expect(buildPickerEntries({ ...input, workspaces }).workspaces.map(item => item.suffix)).toEqual(['one/app', 'two/app', null])
  })
})

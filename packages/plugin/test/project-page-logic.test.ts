/**
 * 项目页纯逻辑测试（P60，决策 DC35）：四块内容的行和文案、项目状态动作、
 * 编辑表单的默认负责人、校验和命令入参。
 *
 * 用例基于 shared/fixture-project.ts；造局部数据只改本地构造，不污染样例。
 */
import { describe, expect, it } from 'vitest'
import type { ProjectView, ProjectViewRow } from '../src/shared/views.js'
import { fixtureProject } from '../src/shared/fixture-project.js'
import {
  PROJECT_EMPTY_TEXT, backgroundMetaText, botOptions, canManageProject, canOpenTopic, projectMemberRows,
  projectPathRows, projectPickRows, projectStatusActions, projectTaskRows, type BotOption,
} from '../src/client/logic/project-page.js'
import {
  PROJECT_BACKGROUND_MAX, PROJECT_MEMBER_MAX, PROJECT_NAME_MAX, PROJECT_SHARED_DIR_MAX,
  buildSaveBackgroundInput, buildSaveProjectInput, canBeOwner, defaultOwnerId, initialProjectForm, ownerChoices,
  validateProjectForm, withMembers, type ProjectFormValues,
} from '../src/client/logic/project-form.js'

const rowWeekly = fixtureProject.projects[0]!
const rowEmpty = fixtureProject.projects[1]!

/** 一位候选队友；默认在岗、执行风格。 */
function option(botId: string, patch: Partial<BotOption> = {}): BotOption {
  return { botId, name: botId, lifecycle: 'active', role: 'executor', ...patch }
}

describe('项目名列表（没选项目时）', () => {
  it('每个项目一行，顺序沿用 core 给的，归档沉底', () => {
    const rows = projectPickRows(fixtureProject)
    expect(rows.map(row => row.id)).toEqual(['prj_weekly', 'prj_empty', 'prj_migrate', 'prj_onboard', 'prj_old'])
    expect(rows[0]).toEqual({ id: 'prj_weekly', name: '竞品周报自动化', statusLabel: '进行中' })
  })

  it('一个项目都没有时有一句说明', () => {
    expect(projectPickRows({ ...fixtureProject, projects: [] })).toEqual([])
    expect(PROJECT_EMPTY_TEXT).toContain('新项目')
  })
})

describe('有哪些队友', () => {
  it('负责人排第一，带执行风格', () => {
    const rows = projectMemberRows(rowWeekly)
    expect(rows[0]).toMatchObject({ botId: 'bot-tanlu', name: '探路', roleLabel: '调研', isOwner: true, invalid: false })
    expect(rows[1]).toMatchObject({ botId: 'bot-xunjian', roleLabel: '盯守', isOwner: false })
  })

  it('反例：队友已删除时写固定说法，不露内部 id', () => {
    const gone = projectMemberRows(rowWeekly).find(row => row.botId === 'bot-gone')!
    expect(gone).toMatchObject({ name: '队友已删除或退役', roleLabel: null, invalid: true })
  })
})

describe('当前事务清单', () => {
  it('事务名、谁在跟进、状态；有主题的带上主题 id', () => {
    const first = projectTaskRows(rowWeekly)[0]!
    expect(first).toMatchObject({ title: '抓取本周竞品动态', assignee: '探路', statusLabel: '进行中', topicId: 'ptp_weekly_price' })
  })

  it('反例：没人跟进时写「待安排」；老事务没有主题时 topicId 为 null', () => {
    const rows = projectTaskRows(rowWeekly)
    expect(rows.find(row => row.title === '整理历史发布记录格式')).toMatchObject({ assignee: '待安排', topicId: null })
  })
})

describe('项目背景的署名', () => {
  it('谁、什么时候更新', () => {
    expect(backgroundMetaText(rowWeekly.background)).toBe('探路 更新于 今天 12:20')
  })

  it('反例：没有记录时不编造', () => {
    expect(backgroundMetaText(rowEmpty.background)).toBeNull()
  })
})

describe('项目文件路径', () => {
  it('工作目录和共享目录相同时只列一行', () => {
    expect(projectPathRows({ workspaceDir: '/a/', sharedDir: '/a/' })).toEqual([{ label: '项目目录', value: '/a/' }])
  })

  it('反例：不同时两行都列', () => {
    expect(projectPathRows({ workspaceDir: '/a/', sharedDir: '/b/' }).map(row => row.value)).toEqual(['/a/', '/b/'])
  })
})

describe('项目状态能做什么', () => {
  it('进行中：暂停、完成；暂停：恢复、完成', () => {
    expect(projectStatusActions('active').map(action => action.command)).toEqual(['pauseProject', 'completeProject'])
    expect(projectStatusActions('paused').map(action => action.command)).toEqual(['resumeProject', 'completeProject'])
  })

  it('反例：已完成、已归档没有这些动作', () => {
    expect(projectStatusActions('done')).toEqual([])
    expect(projectStatusActions('archived')).toEqual([])
  })

  it('只有进行中能开新会话；只有归档后不能再编辑', () => {
    expect(canOpenTopic('active')).toBe(true)
    expect(canOpenTopic('paused')).toBe(false)
    expect(canManageProject('done')).toBe(true)
    expect(canManageProject('archived')).toBe(false)
  })
})

describe('botOptions：成员和负责人的候选', () => {
  const view = { projects: [{ members: [
    { botId: 'b_seen', name: '只在项目里', invalid: false, role: 'chief' },
    { botId: 'b_gone', name: null, invalid: true, role: null },
    { botId: 'b_retired', name: '退了', invalid: false, role: 'executor' },
  ] }] } as unknown as ProjectView
  const bots = [
    { id: 'b_1', name: '甲', lifecycle: 'active' as const, role: 'executor' as const },
    { id: 'b_retired', name: '退了', lifecycle: 'retired' as const, role: 'executor' as const },
  ]

  it('总览里的队友加上项目里出现的有效成员', () => {
    expect(botOptions(bots, view).map(item => item.botId)).toEqual(['b_1', 'b_seen'])
  })

  it('反例：退役和失效的队友不进候选，哪怕项目视图还没刷新', () => {
    expect(botOptions(bots, view).some(item => item.botId === 'b_retired' || item.botId === 'b_gone')).toBe(false)
  })
})

describe('默认负责人', () => {
  const chief = option('b_chief', { role: 'chief' })
  const advisor = option('b_adv', { role: 'advisor' })
  const worker = option('b_work')

  it('有总管选总管，不管排在第几', () => {
    expect(defaultOwnerId(['b_work', 'b_chief'], [worker, chief])).toBe('b_chief')
  })

  it('没有总管选第一位非建议风格的成员', () => {
    expect(defaultOwnerId(['b_adv', 'b_work'], [advisor, worker])).toBe('b_work')
  })

  it('反例：只有建议风格、或都不在岗时选不出来', () => {
    expect(defaultOwnerId(['b_adv'], [advisor])).toBe('')
    expect(defaultOwnerId(['b_p'], [option('b_p', { lifecycle: 'paused' })])).toBe('')
    expect(defaultOwnerId([], [worker])).toBe('')
  })

  it('canBeOwner：建议风格不能当', () => {
    expect(canBeOwner(advisor)).toBe(false)
    expect(canBeOwner(worker)).toBe(true)
  })
})

describe('成员变化时的负责人', () => {
  const options = [option('b_1'), option('b_chief', { role: 'chief' })]
  const values: ProjectFormValues = { name: 'x', ownerBotId: 'b_1', memberBotIds: ['b_1'], sharedDir: '', background: '' }

  it('现任还在成员里就不动，主人选过的不被默认规则覆盖', () => {
    expect(withMembers(values, ['b_1', 'b_chief'], options).ownerBotId).toBe('b_1')
  })

  it('现任被移出：按默认规则重选', () => {
    expect(withMembers(values, ['b_chief'], options).ownerBotId).toBe('b_chief')
  })

  it('还没选时勾上第一位成员就自动填上', () => {
    expect(withMembers({ ...values, ownerBotId: '', memberBotIds: [] }, ['b_1'], options).ownerBotId).toBe('b_1')
  })
})

describe('负责人下拉', () => {
  const options = [option('b_1'), option('b_adv', { role: 'advisor', name: '老顾' }), option('b_out')]
  const values: ProjectFormValues = { name: 'x', ownerBotId: 'b_1', memberBotIds: ['b_1', 'b_adv'], sharedDir: '', background: '' }

  it('只列已勾选的成员，建议风格不可选并写明原因', () => {
    expect(ownerChoices(values, options, 'b_1')).toEqual([
      { botId: 'b_1', name: 'b_1', disabled: false },
      { botId: 'b_adv', name: '老顾（建议风格不能当）', disabled: true },
    ])
  })

  it('例外：旧项目的现任负责人本来就是建议风格，仍然可选，否则改不了项目', () => {
    expect(ownerChoices(values, options, 'b_adv').find(item => item.botId === 'b_adv')?.disabled).toBe(false)
  })
})

describe('表单初值', () => {
  const options = [option('bot-tanlu'), option('bot-xunjian')]

  it('新建：全空', () => {
    expect(initialProjectForm(null, options)).toEqual({ name: '', ownerBotId: '', memberBotIds: [], sharedDir: '', background: '' })
  })

  it('编辑：成员剔除失效队友，负责人、路径、背景都带上', () => {
    const values = initialProjectForm(rowWeekly, options)
    expect(values).toMatchObject({ name: '竞品周报自动化', ownerBotId: 'bot-tanlu', memberBotIds: ['bot-tanlu', 'bot-xunjian'] })
    expect(values.background).toContain('竞品动态')
  })

  it('负责人已失效：按默认规则补一位，保存即修好', () => {
    const broken = { ...rowWeekly, ownerInvalid: true } as ProjectViewRow
    expect(initialProjectForm(broken, options).ownerBotId).toBe('bot-tanlu')
  })
})

describe('表单校验', () => {
  const options = [option('b_1'), option('b_adv', { role: 'advisor' })]
  const ok: ProjectFormValues = { name: '项目', ownerBotId: 'b_1', memberBotIds: ['b_1'], sharedDir: '', background: '' }
  const fieldOf = (patch: Partial<ProjectFormValues>, initialOwner = '') => validateProjectForm({ ...ok, ...patch }, options, initialOwner)?.field ?? null

  it('正例：五项合法', () => {
    expect(fieldOf({})).toBeNull()
  })

  it('名称不能空、不能超长', () => {
    expect(fieldOf({ name: '  ' })).toBe('name')
    expect(fieldOf({ name: '字'.repeat(PROJECT_NAME_MAX + 1) })).toBe('name')
  })

  it('负责人必选，且必须是成员', () => {
    expect(fieldOf({ ownerBotId: '' })).toBe('owner')
    expect(fieldOf({ ownerBotId: 'b_other', memberBotIds: ['b_1'] })).toBe('owner')
  })

  it('建议风格不能当负责人；旧项目现任不换人时放行', () => {
    expect(fieldOf({ ownerBotId: 'b_adv', memberBotIds: ['b_adv'] })).toBe('owner')
    expect(fieldOf({ ownerBotId: 'b_adv', memberBotIds: ['b_adv'] }, 'b_adv')).toBeNull()
  })

  it('成员、路径、背景都有上限', () => {
    expect(fieldOf({ memberBotIds: Array.from({ length: PROJECT_MEMBER_MAX + 1 }, (_, i) => (i === 0 ? 'b_1' : `b_${i + 1}`)) })).toBe('members')
    expect(fieldOf({ sharedDir: 'a'.repeat(PROJECT_SHARED_DIR_MAX + 1) })).toBe('sharedDir')
    expect(fieldOf({ background: 'a'.repeat(PROJECT_BACKGROUND_MAX + 1) })).toBe('background')
  })
})

describe('命令入参', () => {
  const values: ProjectFormValues = { name: ' 新名字 ', ownerBotId: 'b_1', memberBotIds: ['b_1'], sharedDir: '', background: '' }

  it('新建：不带 id；目录留空就不带这个键，走中心默认路径', () => {
    expect(buildSaveProjectInput(values, null)).toEqual({ name: '新名字', charter: '', ownerBotId: 'b_1', memberBotIds: ['b_1'] })
  })

  it('编辑：带 id，并把原来的一句话目标带上，否则 core 会清空它', () => {
    expect(buildSaveProjectInput({ ...values, sharedDir: ' /x/ ' }, rowWeekly)).toEqual({
      id: 'prj_weekly', name: '新名字', charter: rowWeekly.project.charter, ownerBotId: 'b_1', memberBotIds: ['b_1'], sharedDir: '/x/',
    })
  })

  it('背景改了才发命令，内容照 trim 后的提交', () => {
    expect(buildSaveBackgroundInput('prj_weekly', { ...values, background: ' 新背景 ' }, rowWeekly)).toEqual({ projectId: 'prj_weekly', background: '新背景' })
  })

  it('反例：背景没改不发，不留一条假的更新记录', () => {
    expect(buildSaveBackgroundInput('prj_weekly', { ...values, background: rowWeekly.background.text }, rowWeekly)).toBeNull()
    expect(buildSaveBackgroundInput('prj_new', values, null)).toBeNull()
  })
})

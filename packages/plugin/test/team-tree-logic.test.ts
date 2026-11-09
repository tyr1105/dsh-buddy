/**
 * 团队树纯逻辑测试（P28）：办公室固定第一、队友稳定排序、项目挂载与展开状态。
 *
 * 为什么单测：左栏顺序和加号位置是主人每天看到的导航；一旦依赖组件里的
 * 隐式排序，队友改名或活动时间相同就会让树跳来跳去。这里用固定输入把规则钉死。
 */
import { describe, expect, it } from 'vitest'
import {
  buildTeamTree, isExpanded, TEAM_TREE_ADD_BOT, toggleExpanded,
  type TeamTreeBotInput, type TeamTreeProjectInput,
} from '../src/client/logic/team-tree.js'

/** 造一个队友，只覆盖本用例关心的字段。 */
function bot(id: string, patch: Partial<TeamTreeBotInput> = {}): TeamTreeBotInput {
  return {
    id,
    name: id,
    color: '#888888',
    initials: id.slice(0, 1),
    lifecycle: 'active',
    activity: 'resting',
    unread: 0,
    waitingOwner: false,
    lastActiveAt: 100,
    ...patch,
  }
}

/** 造一个项目，成员默认包含 bot-a 与 bot-b。 */
function project(id: string, patch: Partial<TeamTreeProjectInput> = {}): TeamTreeProjectInput {
  return {
    id,
    name: id,
    status: 'active',
    memberBotIds: ['bot-a', 'bot-b'],
    openTaskCount: 0,
    doingTaskCount: 0,
    ...patch,
  }
}

const office = { workingCount: 1, waitingCount: 2, blockedCount: 0 }

describe('buildTeamTree：办公室永远第一', () => {
  it('正例：即使没有任何队友，办公室节点也在树上并带汇总数字', () => {
    const tree = buildTeamTree({ office, bots: [], projects: [] })
    expect(tree.office.kind).toBe('office')
    expect(tree.office.name).toBe('办公室')
    expect(tree.office.waitingCount).toBe(2)
    expect(tree.teammateGroup.bots).toEqual([])
  })

  it('反例：办公室不会被塞进队友分组', () => {
    const tree = buildTeamTree({
      office, bots: [bot('bot-a', { name: '阿蓝' })], projects: [],
    })
    expect(tree.teammateGroup.bots.map(node => node.botId)).toEqual(['bot-a'])
    expect(tree.teammateGroup.bots.some(node => (node as { kind?: string }).kind === 'office')).toBe(false)
  })
})

describe('buildTeamTree：队友稳定排序', () => {
  it('最近活动的在前，退役的沉底', () => {
    const tree = buildTeamTree({
      office,
      bots: [
        bot('bot-retired', { name: '旧队友', lifecycle: 'retired', lastActiveAt: 999 }),
        bot('bot-old', { name: '乙', lastActiveAt: 100 }),
        bot('bot-new', { name: '甲', lastActiveAt: 300 }),
      ],
      projects: [],
    })
    expect(tree.teammateGroup.bots.map(node => node.botId)).toEqual(['bot-new', 'bot-old', 'bot-retired'])
  })

  it('活动时间相同按名字，再相同按 id，顺序永远一致', () => {
    const first = buildTeamTree({
      office,
      bots: [bot('b2', { name: '同名' }), bot('b1', { name: '同名' }), bot('a1', { name: '阿' })],
      projects: [],
    })
    const second = buildTeamTree({
      office,
      bots: [bot('a1', { name: '阿' }), bot('b1', { name: '同名' }), bot('b2', { name: '同名' })],
      projects: [],
    })
    expect(first.teammateGroup.bots.map(node => node.botId)).toEqual(['a1', 'b1', 'b2'])
    expect(second.teammateGroup.bots.map(node => node.botId)).toEqual(['a1', 'b1', 'b2'])
  })

  it('没有活动时间的队友排在有过活动的队友之后', () => {
    const tree = buildTeamTree({
      office,
      bots: [bot('bot-never', { lastActiveAt: null }), bot('bot-active', { lastActiveAt: 1 })],
      projects: [],
    })
    expect(tree.teammateGroup.bots.map(node => node.botId)).toEqual(['bot-active', 'bot-never'])
  })
})

describe('buildTeamTree：项目只挂在成员名下', () => {
  it('正例：队友看到自己参与的项目，并保留待领数量', () => {
    const tree = buildTeamTree({
      office,
      bots: [bot('bot-a')],
      projects: [project('prj-one', { name: '进市场', openTaskCount: 3, doingTaskCount: 1 })],
    })
    const node = tree.teammateGroup.bots[0]
    expect(node?.projects.map(item => item.projectId)).toEqual(['prj-one'])
    expect(node?.projects[0]?.openCount).toBe(3)
    expect(node?.projects[0]?.doingCount).toBe(1)
  })

  it('反例：不是成员的项目不出现在这个队友下面', () => {
    const tree = buildTeamTree({
      office,
      bots: [bot('bot-a')],
      projects: [project('prj-outsider', { memberBotIds: ['bot-b'] })],
    })
    expect(tree.teammateGroup.bots[0]?.projects).toEqual([])
  })

  it('归档项目单独放，不混进在做列表', () => {
    const tree = buildTeamTree({
      office,
      bots: [bot('bot-a')],
      projects: [
        project('prj-active', { name: '在做' }),
        project('prj-archived', { name: '旧项目', status: 'archived' }),
      ],
    })
    const node = tree.teammateGroup.bots[0]
    expect(node?.projects.map(item => item.projectId)).toEqual(['prj-active'])
    expect(node?.archivedProjects.map(item => item.projectId)).toEqual(['prj-archived'])
    expect(node?.archivedProjects[0]?.archived).toBe(true)
  })
})

describe('展开状态与加号位置', () => {
  it('默认全部队友展开、项目收起；显式传入时按传入来', () => {
    const tree = buildTeamTree({
      office,
      bots: [bot('bot-a'), bot('bot-b')],
      projects: [project('prj-one')],
    })
    expect(tree.teammateGroup.bots.map(node => node.expanded)).toEqual([true, true])
    expect(tree.teammateGroup.bots[0]?.projects[0]?.expanded).toBe(false)

    const collapsed = buildTeamTree({
      office,
      bots: [bot('bot-a')],
      projects: [project('prj-one')],
      expandedBotIds: [],
      expandedProjectIds: ['prj-one'],
    })
    expect(collapsed.teammateGroup.bots[0]?.expanded).toBe(false)
    expect(collapsed.teammateGroup.bots[0]?.projects[0]?.expanded).toBe(true)
  })

  it('toggleExpanded 返回新数组，重复 id 不会累加', () => {
    expect(toggleExpanded([], 'bot-a')).toEqual(['bot-a'])
    expect(toggleExpanded(['bot-a', 'bot-b'], 'bot-a')).toEqual(['bot-b'])
    expect(toggleExpanded(['bot-a'], 'bot-a')).toEqual([])
    expect(isExpanded(undefined, 'bot-a', true)).toBe(true)
    expect(isExpanded([], 'bot-a', true)).toBe(false)
  })

  it('加号位置由分组元数据给出：队友分组标题右侧', () => {
    const tree = buildTeamTree({ office, bots: [], projects: [] })
    expect(tree.teammateGroup.addBot).toEqual(TEAM_TREE_ADD_BOT)
    expect(tree.teammateGroup.addBot).toEqual({
      groupId: 'teammates',
      anchor: 'group-header',
      label: '新建队友',
    })
  })

  it('当前选中节点会高亮对应节点，且只有一个节点 active', () => {
    const tree = buildTeamTree({
      office,
      bots: [bot('bot-a')],
      projects: [project('prj-one')],
      expandedProjectIds: ['prj-one'],
      active: { kind: 'project', id: 'prj-one' },
    })
    expect(tree.office.active).toBe(false)
    expect(tree.teammateGroup.bots[0]?.active).toBe(false)
    expect(tree.teammateGroup.bots[0]?.projects[0]?.active).toBe(true)
  })
})

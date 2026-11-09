/**
 * 左栏三组导航的纯逻辑测试（P44）。
 *
 * 主人定的 IA 是「一套左栏、办公室 → 队友 → 工作区」；这里锁定三件事：
 * 组顺序固定、工作区只收「已指派且还在推进」的会话、项目展开规则稳定。
 * 只测纯函数，不渲染组件；组件形状由源码契约测试与浏览器走查覆盖。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { BotCard, ProjectTask, ProjectTaskView, ProjectView, ProjectViewRow, TaskStatus } from '../src/shared/views.js'
import { fixtureOverview } from '../src/shared/fixtures.js'
import { rowActivityText } from '../src/client/components/sidebar-teammates-group.js'
import {
  SIDEBAR_GROUP_ORDER,
  SIDEBAR_GROUP_TITLES,
  buildWorkspaceProjects,
  collectSidebarProjects,
  isGroupExpanded,
  isSidebarSessionCandidate,
  projectsForBot,
  shouldShowWorkspaceScrollHint,
  toSidebarSession,
  toggleGroup,
} from '../src/client/logic/sidebar-groups.js'

/**
 * U01 第 45 轮：左栏从单文件拆成「主组件 + 共享零件 + 图标列 + 内联表单 + 两个分组」
 * 六个文件，源码契约改为对整组文件拼接生效，断言数量与强度不削弱；
 * 办公室组专属断言仍读主组件（它作为组合根保留了办公室组与页脚）。
 */
const sidebarNavFileNames = [
  'team-sidebar-nav.tsx',
  'sidebar-nav-parts.tsx',
  'sidebar-nav-rail.tsx',
  'sidebar-session-form.tsx',
  'sidebar-teammates-group.tsx',
  'sidebar-workspaces-group.tsx',
]
const navComponentUrl = (name: string): URL => new URL(`../src/client/components/${name}`, import.meta.url)
const navSource = sidebarNavFileNames.map(name => readFileSync(navComponentUrl(name), 'utf8')).join('\n')
const navMainSource = readFileSync(navComponentUrl('team-sidebar-nav.tsx'), 'utf8')
const sidebarSource = readFileSync(new URL('../src/client/components/team-sidebar.tsx', import.meta.url), 'utf8')
const cssSource = readFileSync(new URL('../src/client/workspace.css', import.meta.url), 'utf8')

/** 造一条任务展开行；默认已指派给 bot-1、进行中。 */
function taskView(over: {
  id?: string
  title?: string
  status?: TaskStatus
  assigneeBotId?: string | null
  updatedAt?: number
  wakes?: ProjectTaskView['wakes']
} = {}): ProjectTaskView {
  const task: ProjectTask = {
    id: over.id ?? 'pt_1',
    projectId: 'prj_1',
    title: over.title ?? '某任务',
    detail: '',
    assigneeBotId: over.assigneeBotId === undefined ? 'bot-1' : over.assigneeBotId,
    status: over.status ?? 'doing',
    wakeIds: [],
    artifactIds: [],
    createdAt: 1,
    updatedAt: over.updatedAt ?? 1,
    dueAt: null,
  }
  return {
    task,
    statusLabel: '进行中',
    assigneeBotId: task.assigneeBotId,
    assigneeBotName: task.assigneeBotId === null ? null : '小观',
    assigneeInvalid: false,
    artifactCount: 0,
    wakes: over.wakes ?? [],
    artifacts: [],
    acceptance: { hints: [] },
  }
}

/** 造一个项目视图行；project 字段只填本测试用到的部分。 */
function row(over: {
  id?: string
  name?: string
  status?: ProjectViewRow['project']['status']
  members?: string[]
  tasks?: ProjectTaskView[]
} = {}): ProjectViewRow {
  const id = over.id ?? 'prj_1'
  return {
    project: {
      id,
      name: over.name ?? '某项目',
      status: over.status ?? 'active',
      memberBotIds: over.members ?? ['bot-1'],
    },
    tasks: over.tasks ?? [],
  } as unknown as ProjectViewRow
}

function view(rows: ProjectViewRow[]): ProjectView {
  return { asOf: 1, projects: rows, counts: {} } as unknown as ProjectView
}

describe('三组的顺序与标题', () => {
  it('顺序固定为办公室 → 队友 → 工作区', () => {
    expect([...SIDEBAR_GROUP_ORDER]).toEqual(['office', 'teammates', 'workspaces'])
    expect(SIDEBAR_GROUP_TITLES.office).toBe('办公室')
    expect(SIDEBAR_GROUP_TITLES.teammates).toBe('队友')
    expect(SIDEBAR_GROUP_TITLES.workspaces).toBe('工作区')
  })
})

describe('工作会话口径（DC17 / P33）', () => {
  it('已指派且已开工的三种状态才算会话：doing / blocked / done_pending_check', () => {
    for (const status of ['doing', 'blocked', 'done_pending_check'] as const) {
      expect(isSidebarSessionCandidate(status, 'bot-1')).toBe(true)
    }
  })

  it('todo 还没开工，不算会话；未指派、已验收、已驳回也都不进左栏', () => {
    // P1-2：左栏展开的是工作会话，不是任务记录；待领任务留在项目页。
    expect(isSidebarSessionCandidate('todo', 'bot-1')).toBe(false)
    expect(isSidebarSessionCandidate('doing', null)).toBe(false)
    expect(isSidebarSessionCandidate('doing', '')).toBe(false)
    expect(isSidebarSessionCandidate('accepted', 'bot-1')).toBe(false)
    expect(isSidebarSessionCandidate('rejected', 'bot-1')).toBe(false)
  })

  it('同一任务转出的会话 id 就是 task id，且状态、项目、下钻唤醒与 work-session 一致', () => {
    const task = taskView({
      wakes: [
        { wakeId: 'w-1', botId: 'bot-1' },
        { wakeId: 'w-2', botId: null },
        { wakeId: 'w-3', botId: 'bot-1' },
      ] as ProjectTaskView['wakes'],
    })
    const session = toSidebarSession(row({ name: '周报项目' }), task)
    expect(session).toMatchObject({
      id: 'pt_1',
      projectId: 'prj_1',
      projectName: '周报项目',
      title: '某任务',
      assigneeBotId: 'bot-1',
      latestWakeId: 'w-3',
    })
    // 不符合口径的任务不产出会话，调用方直接跳过。
    expect(toSidebarSession(row(), taskView({ status: 'todo' }))).toBeNull()
  })
})

describe('collectSidebarProjects：从项目视图摊平工作区', () => {
  it('归档项目整组不出现', () => {
    const out = collectSidebarProjects(view([
      row({ id: 'prj_live', name: '在推进' }),
      row({ id: 'prj_old', name: '已归档', status: 'archived' }),
    ]))
    expect(out.map(p => p.id)).toEqual(['prj_live'])
  })

  it('只保留符合条件的任务，待领任务不冒充工作会话', () => {
    const out = collectSidebarProjects(view([row({
      tasks: [
        taskView({ id: 'pt_todo', status: 'todo' }),
        taskView({ id: 'pt_doing', status: 'doing' }),
        taskView({ id: 'pt_unassigned', status: 'doing', assigneeBotId: null }),
        taskView({ id: 'pt_accepted', status: 'accepted' }),
        taskView({ id: 'pt_rejected', status: 'rejected' }),
      ],
    })]))
    expect(out[0]!.sessions.map(s => s.id)).toEqual(['pt_doing'])
  })

  it('项目视图还没加载时返回空数组，不抛错', () => {
    expect(collectSidebarProjects(null)).toEqual([])
  })
})

describe('buildWorkspaceProjects：项目排序与展开规则', () => {
  const projects = [
    { id: 'prj_done', name: '已完成', status: 'done' as const, memberBotIds: [], sessions: [] },
    { id: 'prj_b', name: '乙项目', status: 'active' as const, memberBotIds: [], sessions: [] },
    { id: 'prj_a', name: '甲项目', status: 'active' as const, memberBotIds: [], sessions: [] },
  ]

  it('状态优先、同状态按名字排序，不随输入顺序漂移', () => {
    expect(buildWorkspaceProjects({ projects }).map(p => p.projectId))
      .toEqual(['prj_a', 'prj_b', 'prj_done'])
  })

  it('没有显式展开集合时，有会话的项目默认展开、空项目收起', () => {
    const nodes = buildWorkspaceProjects({
      projects: [
        { id: 'prj_full', name: '有活', status: 'active', memberBotIds: [], sessions: [
          { id: 'pt_1', projectId: 'prj_full', projectName: '有活', title: '活', status: 'doing', statusLabel: '进行中', assigneeBotId: 'bot-1', latestWakeId: null, blocked: false, pendingCheck: false, updatedAt: 1 },
        ] },
        { id: 'prj_empty', name: '空', status: 'active', memberBotIds: [], sessions: [] },
      ],
    })
    expect(nodes.find(n => n.projectId === 'prj_full')!.expanded).toBe(true)
    expect(nodes.find(n => n.projectId === 'prj_empty')!.expanded).toBe(false)
  })

  it('显式展开集合优先：可以手动展开空项目，也可以收起有会话的项目', () => {
    const nodes = buildWorkspaceProjects({
      projects: [
        { id: 'prj_full', name: '有活', status: 'active', memberBotIds: [], sessions: [
          { id: 'pt_1', projectId: 'prj_full', projectName: '有活', title: '活', status: 'doing', statusLabel: '进行中', assigneeBotId: 'bot-1', latestWakeId: null, blocked: false, pendingCheck: false, updatedAt: 1 },
        ] },
        { id: 'prj_empty', name: '空', status: 'active', memberBotIds: [], sessions: [] },
      ],
      expandedProjectIds: ['prj_empty'],
    })
    expect(nodes.find(n => n.projectId === 'prj_full')!.expanded).toBe(false)
    expect(nodes.find(n => n.projectId === 'prj_empty')!.expanded).toBe(true)
  })

  it('组内会话按最近变动倒序，时间相同按 id 稳定', () => {
    const nodes = buildWorkspaceProjects({
      projects: [{
        id: 'prj_1', name: '项目', status: 'active', memberBotIds: [],
        sessions: [
          { id: 'pt_old', projectId: 'prj_1', projectName: '项目', title: '旧', status: 'doing', statusLabel: '进行中', assigneeBotId: 'bot-1', latestWakeId: null, blocked: false, pendingCheck: false, updatedAt: 10 },
          { id: 'pt_new', projectId: 'prj_1', projectName: '项目', title: '新', status: 'blocked', statusLabel: '卡住了', assigneeBotId: 'bot-1', latestWakeId: null, blocked: true, pendingCheck: false, updatedAt: 20 },
        ],
      }],
    })
    expect(nodes[0]!.sessions.map(s => s.id)).toEqual(['pt_new', 'pt_old'])
  })

  it('停在项目页时高亮对应项目', () => {
    const nodes = buildWorkspaceProjects({ projects, activeProjectId: 'prj_b' })
    expect(nodes.find(n => n.projectId === 'prj_b')!.active).toBe(true)
    expect(nodes.find(n => n.projectId === 'prj_a')!.active).toBe(false)
  })
})

describe('折叠与按队友找项目', () => {
  it('分组默认展开，收起后只记这一组', () => {
    expect(isGroupExpanded([], 'teammates')).toBe(true)
    const collapsed = toggleGroup([], 'teammates')
    expect(collapsed).toEqual(['teammates'])
    expect(isGroupExpanded(collapsed, 'teammates')).toBe(false)
    expect(toggleGroup(collapsed, 'teammates')).toEqual([])
  })

  it('projectsForBot 只列该队友是成员的项目', () => {
    const projects = [
      { id: 'prj_1', name: '一', status: 'active' as const, memberBotIds: ['bot-1'], sessions: [] },
      { id: 'prj_2', name: '二', status: 'active' as const, memberBotIds: ['bot-2'], sessions: [] },
    ]
    expect(projectsForBot(projects, 'bot-1').map(p => p.id)).toEqual(['prj_1'])
    expect(projectsForBot(projects, 'bot-9')).toEqual([])
  })

  describe('shouldShowWorkspaceScrollHint 只认真实裁切（U01 第 43 轮）', () => {
    it('正例：内层限高溢出或外层视口裁切，展开态都提示', () => {
      expect(shouldShowWorkspaceScrollHint({ rowsOverflow: true, outerClip: false, groupExpanded: true })).toBe(true)
      expect(shouldShowWorkspaceScrollHint({ rowsOverflow: false, outerClip: true, groupExpanded: true })).toBe(true)
      expect(shouldShowWorkspaceScrollHint({ rowsOverflow: true, outerClip: true, groupExpanded: true })).toBe(true)
    })
    it('反例：两个容器都放得下时，哪怕项目多也不报假警', () => {
      expect(shouldShowWorkspaceScrollHint({ rowsOverflow: false, outerClip: false, groupExpanded: true })).toBe(false)
    })
    it('反例：工作区组收起后没有列表可滚，任何溢出都不提示', () => {
      expect(shouldShowWorkspaceScrollHint({ rowsOverflow: true, outerClip: true, groupExpanded: false })).toBe(false)
      expect(shouldShowWorkspaceScrollHint({ rowsOverflow: false, outerClip: false, groupExpanded: false })).toBe(false)
    })
  })
})

/**
 * 组件与样式的源码契约（P44 复审的 P1/P2）：
 * 这些规则靠 DOM 走查也能发现，但放到单测里，回归时能在 CI 就先拦住。
 */
describe('左栏组件契约（P44 复审）', () => {
  it('办公室组只报「N 人在忙」，不再重复「待你处理」总数（P2-3 / U11 #03）', () => {
    // 去掉注释再断言：注释里解释「待你处理归底部」不算界面文案。
    // 第 45 轮拆分后队友组在独立文件，主组件里的下一个边界是 <TeammatesGroup> JSX 挂载点；
    // 不能只写 TeammatesGroup，否则会命中文件顶部的 import 语句，切片直接变空。
    const navCode = navMainSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    const officeSection = navCode.slice(
      navCode.indexOf('SIDEBAR_GROUP_TITLES.office'),
      navCode.indexOf('<TeammatesGroup'),
    )
    expect(officeSection).toContain('人在忙')
    // 三个计数入口里，只有底部那一个负责「待你处理」；办公室组出现它最容易被读成待办数。
    expect(officeSection).not.toContain('inbox.total')
    expect(officeSection).not.toContain('待你处理')
  })

  it('工作区组有组内限高，滚动提示改由真实裁切测量驱动（U01 第 43 轮 P2-L1）', () => {
    expect(cssSource).toMatch(/\.ah-nav-group-workspaces \.ah-nav-rows \{[^}]*max-height:[^}]*overflow-y: auto/)
    expect(navSource).toContain('ah-nav-scroll-hint')
    // 旧的「项目数 > 4」猜测阈值必须消失：4 个项目在矮视口被裁时同样要提示。
    expect(navSource).not.toMatch(/workspaceProjects\.length > 4/)
    // 新机制：纯函数判定 + 两个容器的几何实测 + ResizeObserver 兜视口变化。
    expect(navSource).toContain('shouldShowWorkspaceScrollHint')
    expect(navSource).toContain('new ResizeObserver')
    expect(navSource).toMatch(/rowsRef/)
    expect(navSource).toMatch(/scrollRef/)
  })

  it('办公室组头用 24px 占位对齐三组计数右缘，占位不可见不进 Tab（U01 第 43 轮 P2-O1）', () => {
    expect(navSource).toContain('ah-nav-group-head-spacer')
    expect(navSource).toMatch(/<span className="ah-nav-group-head-spacer" aria-hidden="true" \/>/)
    expect(cssSource).toMatch(/\.ah-nav-group-head-spacer \{[^}]*width: 24px/)
    expect(cssSource).toMatch(/\.ah-nav-group-head-spacer \{[^}]*visibility: hidden/)
  })

  it('左栏宽度跟随宿主，没有写死 280px 托底（P1-3）', () => {
    expect(cssSource).not.toContain('width: 280px')
    expect(cssSource).not.toContain('min-width: 280px')
    // 宿主容器里宽度交给宿主（100%），独立预览才用固定兜底值。
    expect(cssSource).toMatch(/\.ah-host-botlist \.ah-botlist \{[^}]*width: 100%/)
  })

  it('打开工作会话必须把任务 id 放在第三参数，避免子行落错线程（P1-2）', () => {
    expect(sidebarSource).toContain('requestWorkSession(session.assigneeBotId, session.projectId, session.id, session.latestWakeId)')
    expect(sidebarSource).not.toContain('requestWorkSession(session.assigneeBotId, session.projectId, session.latestWakeId)')
  })
})

/**
 * 队友行第三行活动句（U01 第 46 轮）：退役时 core 把活动句改写成「已退役」，
 * 名字旁标签已经是「已退役」，第三行再写一遍是纯重复。正例反例各锁一条，
 * 防止去重时误伤非退役队友的真实活动句。
 */
describe('队友行活动句 rowActivityText', () => {
  const tanlu = fixtureOverview.bots.find(b => b.id === 'bot-tanlu') as BotCard
  const retired = (over: Partial<BotCard>): BotCard =>
    ({ ...tanlu, lifecycle: 'retired' as const, activity: 'resting' as const, activityText: '已退役', ...over })

  it('在岗队友：原样返回活动句，不做任何改写', () => {
    expect(rowActivityText(tanlu)).toBe('正在处理：数据日报没出（第 12/30 步）')
  })

  it('退役且活动句与标签重复：改成「最后活动：…」，不再出现第二遍已退役', () => {
    const text = rowActivityText(retired({ lastActiveText: '2 天前' }))
    expect(text).toBe('最后活动：2 天前')
    expect(text).not.toContain('已退役')
  })

  it('退役但没有最后活动时间：返回空串（调用方整行不渲染，不用空话占位）', () => {
    expect(rowActivityText(retired({ lastActiveText: null }))).toBe('')
  })

  it('退役但活动句不是「已退役」（例如预览桩的归档演示句）：原样保留', () => {
    expect(rowActivityText(retired({ activityText: '已归档' }))).toBe('已归档')
  })
})

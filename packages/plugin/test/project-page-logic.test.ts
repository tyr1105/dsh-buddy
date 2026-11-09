/**
 * 项目页纯逻辑测试（V2-PH4-02）：分区与任务分组、状态流转动作表、队友目录与失效点名、
 * 指派人/负责人/成员一句话、项目/任务/驳回三类表单的前置校验与命令入参拼装。
 *
 * 为什么单独测：这些函数决定项目页「待验收任务给不给按钮、失效队友怎么点名、什么错误
 * 先在前端拦住、发给 core 的入参是否多一个键」。口径必须和 core 的 zod/状态机一致；
 * 用例基于 shared/fixture-project.ts，造局部数据只改本地构造，不污染样例。
 * 编制取消后负责人、成员与任务指派全部是队友 bot id，不再有席位这一层。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import type {
  Project, ProjectMemberView, ProjectTask, ProjectTaskArtifactView, ProjectTaskView, ProjectTaskWakeView, ProjectView, ProjectViewRow, TaskStatus,
} from '../src/shared/views.js'
import { fixtureProject } from '../src/shared/fixture-project.js'
import {
  PROJECT_ZONES, TASK_GROUP_ORDER, DISPATCH_MODE_COPY, artifactBrief, assigneeBrief, canAttachArtifact, canEditTask, canManageProject, suggestArtifactBot,
  canNudgeTask, canRestoreProject, issueLevelLabel, memberBrief, ownerBrief, progressPercent,
  projectEmptyText, projectSections, projectSummary, projectSummaryParts, botCatalogue, taskAssigneeOptions, taskGroups,
  taskTransitionActions, wakeLinkState, wakeLinkTitle, workspaceDirDisplay,
  type DispatchMode,
} from '../src/client/logic/project-page.js'
import {
  PROJECT_CHARTER_MAX, PROJECT_CONVENTIONS_MAX, PROJECT_CRITERION_MAX, PROJECT_CRITERION_TEXT_MAX, PROJECT_CRITERION_VERIFY_MAX,
  PROJECT_MEMBER_MAX, PROJECT_NAME_MAX, PROJECT_SHARED_DIR_MAX, PROJECT_VISION_MAX,
  TASK_DETAIL_MAX, TASK_REJECT_REASON_MAX, TASK_TITLE_MAX, DISPATCH_NOTE_MAX,
  buildAttachTaskArtifactInput, buildDispatchTaskInput, buildIdInput, buildRejectTaskInput, buildSaveProjectInput, buildSaveTaskInput,
  initialProjectForm, initialTaskForm, validateArtifactChoice, validateDispatchNote, validateDispatchBot,
  validateProjectCharter, validateProjectCriteria, validateProjectForm,
  validateProjectConventions, validateProjectVision,
  validateProjectName, validateProjectSharedDir, validateRejectReason, validateTaskDetail,
  validateTaskForm, validateTaskTitle,
  type CriterionFormValues,
} from '../src/client/logic/project-form.js'

/** 夹具里五个项目行的快捷取用（顺序即 projectView 的排序）。 */
const rows = fixtureProject.projects
const rowWeekly = rows[0]!
const rowEmpty = rows[1]!
const rowMigrate = rows[2]!
const rowOnboard = rows[3]!
const rowOld = rows[4]!

/** 造一条任务事实（测试默认：prj_1 的进行中任务、待认领）。 */
function task(over: Partial<ProjectTask> = {}): ProjectTask {
  return {
    id: over.id ?? 'pt_1', projectId: over.projectId ?? 'prj_1', title: over.title ?? '某任务',
    detail: over.detail ?? '', assigneeBotId: over.assigneeBotId ?? null,
    status: over.status ?? 'doing', wakeIds: [], artifactIds: [],
    createdAt: 1, updatedAt: 1, dueAt: null, ...over,
  }
}

/** 造一条任务展开行（测试默认：未指派、无在岗队友）。 */
function taskView(over: {
  task?: Partial<ProjectTask>
  status?: TaskStatus
  assigneeBotId?: string | null
  assigneeBotName?: string | null
  assigneeInvalid?: boolean
} = {}): ProjectTaskView {
  // 注意 null 与 undefined 语义不同：null 是「显式待认领」，undefined 是「沿用默认」。
  const t = task({
    ...over.task,
    status: over.status ?? over.task?.status ?? 'doing',
    assigneeBotId: over.assigneeBotId === undefined
      ? (over.task?.assigneeBotId ?? null)
      : over.assigneeBotId,
  })
  const botId = t.assigneeBotId
  return {
    task: t,
    statusLabel: '进行中',
    assigneeBotId: botId,
    assigneeBotName: over.assigneeBotName ?? (botId === null ? null : '某队友'),
    assigneeInvalid: over.assigneeInvalid ?? false,
    artifactCount: 0,
    wakes: [],
    artifacts: [],
    acceptance: { hints: [] },
  }
}

/** 造一条任务关联唤醒链接（测试默认：账本在、队友在岗）。 */
function wakeLink(over: Partial<ProjectTaskWakeView> = {}): ProjectTaskWakeView {
  return {
    wakeId: over.wakeId ?? 'w_1',
    botId: over.botId === undefined ? 'b_1' : over.botId,
    botName: over.botName === undefined ? '小观' : over.botName,
    ledgerId: over.ledgerId === undefined ? 'wl_1' : over.ledgerId,
    variantLabel: over.variantLabel === undefined ? '常规' : over.variantLabel,
    statusLabel: over.statusLabel === undefined ? '已交账' : over.statusLabel,
    triggerLabel: over.triggerLabel === undefined ? '感知' : over.triggerLabel,
    summary: over.summary === undefined ? '资料有更新' : over.summary,
    openedAt: over.openedAt === undefined ? 1 : over.openedAt,
    openedText: over.openedText === undefined ? '今天 10:00' : over.openedText,
  }
}

/** 造一条成员展开行（测试默认：有效队友、有名字）。 */
function member(over: Partial<ProjectMemberView> = {}): ProjectMemberView {
  return {
    botId: over.botId ?? 'bot_1', name: over.name === undefined ? '某队友' : over.name,
    invalid: over.invalid ?? false,
  }
}

/** 造一个项目事实（测试默认：进行中）。 */
function project(over: Partial<Project> = {}): Project {
  return {
    id: 'prj_1', name: '某项目', charter: '', vision: '', conventions: '', status: 'active', ownerBotId: null,
    memberBotIds: [], sharedDir: '/tmp/prj_1/', acceptanceCriteria: [],
    context: { background: '', conventions: '', decisions: [], glossary: [] },
    contextRevisions: [],
    createdAt: 1, updatedAt: 1, archivedAt: null, ...over,
  }
}

/** 造一个项目视图行（测试默认：无负责人/成员/任务/问题）。 */
function viewRow(over: Partial<ProjectViewRow> & { project?: Partial<Project> } = {}): ProjectViewRow {
  const p = project(over.project)
  return {
    project: p, statusLabel: '进行中',
    ownerBotId: p.ownerBotId, ownerName: null, ownerInvalid: false,
    members: [], criteria: [], tasks: [],
    taskCounts: { todo: 0, doing: 0, blocked: 0, done_pending_check: 0, accepted: 0, rejected: 0, total: 0 },
    progress: 0, issues: [],
    layers: {
      original: { readOnly: true, workspaceDir: p.sharedDir },
      team: {
        readOnly: false, vision: p.vision, conventions: p.conventions,
        memberCount: p.memberBotIds.length, sharedDir: p.sharedDir,
        criterionCount: p.acceptanceCriteria.length,
      },
    },
    context: p.context,
    contextEmpty: true,
    contextFilePath: `${p.sharedDir}context.md`,
    contextRevisions: [],
    contextProposals: [],
    ...over,
  }
}

/** 造一份只含给定行的项目视图，计数由用例显式给。 */
function viewOf(projects: ProjectViewRow[], counts: ProjectView['counts']): ProjectView {
  return { asOf: 1, projects, counts }
}

describe('projectSummary / projectSections / projectEmptyText：顶栏计数与四分区', () => {
  it('一句话计数全部取自 core 视图（项目分状态 + 任务总数 + 待验收数）', () => {
    const text = projectSummary(fixtureProject)
    // 开头不再重复"项目"——页面 <h2>项目</h2> 已经给过标题
    expect(text).toContain('5 个')
    expect(text).toContain('进行中 2')
    expect(text).toContain('暂停 1')
    expect(text).toContain('完成 1')
    expect(text).toContain('归档 1')
    expect(text).toContain('任务 10 个')
    expect(text).toContain('待验收 1 个')
  })
  it('分区按项目状态归类，键顺序固定为 active/paused/done/archived', () => {
    const sections = projectSections(fixtureProject)
    expect(Object.keys(sections)).toEqual(['active', 'paused', 'done', 'archived'])
    expect(sections.active.map(r => r.project.id)).toEqual(['prj_weekly', 'prj_empty'])
    expect(sections.paused.map(r => r.project.id)).toEqual(['prj_migrate'])
    expect(sections.done.map(r => r.project.id)).toEqual(['prj_onboard'])
    expect(sections.archived.map(r => r.project.id)).toEqual(['prj_old'])
  })
  it('PROJECT_ZONES 铺陈顺序：进行中 → 已暂停 → 已完成 → 已归档（归档区单独折叠）', () => {
    expect(PROJECT_ZONES.map(z => z.zone)).toEqual(['active', 'paused', 'done', 'archived'])
  })
  it('空态：一个项目都没有时指引新建；只剩归档项目时指向归档区；有活项目返回 null', () => {
    const empty = viewOf([], { active: 0, paused: 0, done: 0, archived: 0, total: 0, tasksTotal: 0, tasksPendingCheck: 0 })
    expect(projectEmptyText(empty)).toContain('＋ 新项目')
    const onlyArchived = viewOf([rowOld], { active: 0, paused: 0, done: 0, archived: 1, total: 1, tasksTotal: 1, tasksPendingCheck: 0 })
    expect(projectEmptyText(onlyArchived)).toContain('归档区还留着 1 个')
    expect(projectEmptyText(fixtureProject)).toBeNull()
  })
})

describe('projectSummaryParts：顶栏计数分段（U01 第 41 轮，归档锚点的唯一事实源）', () => {
  it('固定七段且键顺序为 total/active/paused/done/archived/tasks/pending', () => {
    const parts = projectSummaryParts(fixtureProject)
    expect(parts.map(p => p.key)).toEqual(['total', 'active', 'paused', 'done', 'archived', 'tasks', 'pending'])
    expect(parts).toHaveLength(7)
  })
  it('每段文本与计数都取自 core 视图，archived 段带视图里的归档数', () => {
    const parts = projectSummaryParts(fixtureProject)
    const byKey = new Map(parts.map(p => [p.key, p]))
    expect(byKey.get('total')).toMatchObject({ text: '5 个', count: 5 })
    expect(byKey.get('active')).toMatchObject({ text: '进行中 2', count: 2 })
    expect(byKey.get('paused')).toMatchObject({ text: '暂停 1', count: 1 })
    expect(byKey.get('done')).toMatchObject({ text: '完成 1', count: 1 })
    expect(byKey.get('archived')).toMatchObject({ text: '归档 1', count: 1 })
    expect(byKey.get('tasks')).toMatchObject({ text: '任务 10 个', count: 10 })
    expect(byKey.get('pending')).toMatchObject({ text: '待验收 1 个', count: 1 })
  })
  it('归档为 0 时 archived 段 count 为 0（页面据此不渲染跳转，只显纯文本）', () => {
    const noArchived = viewOf([rowWeekly], { active: 1, paused: 0, done: 0, archived: 0, total: 1, tasksTotal: 0, tasksPendingCheck: 0 })
    const archived = projectSummaryParts(noArchived).find(p => p.key === 'archived')
    expect(archived).toEqual({ key: 'archived', text: '归档 0', count: 0 })
  })
  it('空项目视图下七段仍齐全且全部计数为 0', () => {
    const empty = viewOf([], { active: 0, paused: 0, done: 0, archived: 0, total: 0, tasksTotal: 0, tasksPendingCheck: 0 })
    const parts = projectSummaryParts(empty)
    expect(parts.every(p => p.count === 0)).toBe(true)
    expect(parts.map(p => p.text)).toEqual(['0 个', '进行中 0', '暂停 0', '完成 0', '归档 0', '任务 0 个', '待验收 0 个'])
  })
  it('projectSummary() 的拼接结果与分段文本严格一致：前五段 · 连接，任务两段前用 ｜', () => {
    for (const view of [fixtureProject, viewOf([], { active: 0, paused: 0, done: 0, archived: 0, total: 0, tasksTotal: 0, tasksPendingCheck: 0 })]) {
      const parts = projectSummaryParts(view)
      const rejoined = `${parts.slice(0, 5).map(p => p.text).join('·')}｜${parts.slice(5).map(p => p.text).join('·')}`
      expect(projectSummary(view)).toBe(rejoined)
    }
  })
})

describe('workspaceDirDisplay：项目卡目录改人话（U05）', () => {
  it('绝对路径正文只留最后一段并补结尾斜杠，完整路径放进悬停提示', () => {
    expect(workspaceDirDisplay('/Users/x/projects/prj_weekly'))
      .toEqual({ label: 'prj_weekly/', title: '/Users/x/projects/prj_weekly' })
    expect(workspaceDirDisplay('/Users/x/projects/prj_weekly/'))
      .toEqual({ label: 'prj_weekly/', title: '/Users/x/projects/prj_weekly/' })
    // 兼容 Windows 分隔符，避免只认 `/` 时把整条路径当目录名。
    expect(workspaceDirDisplay('C:\\work\\prj_weekly'))
      .toEqual({ label: 'prj_weekly/', title: 'C:\\work\\prj_weekly' })
  })
  it('空路径显示「未设置」且不挂悬停提示', () => {
    expect(workspaceDirDisplay('')).toEqual({ label: '未设置', title: undefined })
    expect(workspaceDirDisplay('   ')).toEqual({ label: '未设置', title: undefined })
  })
  it('根路径没有目录名时照实显示，不伪装成未设置', () => {
    expect(workspaceDirDisplay('/')).toEqual({ label: '/', title: '/' })
  })
  it('项目页正文用格式化结果，不再整行插值绝对路径', () => {
    const source = readFileSync(new URL('../src/client/pages/ProjectPage.tsx', import.meta.url), 'utf8')
    expect(source).toContain('workspaceDirDisplay(row.layers.original.workspaceDir)')
    expect(source).toContain('工作区：{workspaceDir.label}')
    expect(source).not.toContain('工作区：{row.layers.original.workspaceDir}')
  })
})

describe('夹具形状：计数与行内容一致（core 改口径时类型与这里一起报警）', () => {
  it('五个项目：2 进行中 / 1 暂停 / 1 完成 / 1 归档；归档沉底', () => {
    expect(fixtureProject.projects).toHaveLength(5)
    expect(fixtureProject.projects.at(-1)!.project.status).toBe('archived')
    expect(fixtureProject.counts).toEqual({
      active: 2, paused: 1, done: 1, archived: 1, total: 5, tasksTotal: 10, tasksPendingCheck: 1,
    })
  })
  it('tasksTotal 等于各行任务数之和；各项目问题数为 2/0/0/1/0（归档项目不报问题）', () => {
    const total = fixtureProject.projects.reduce((n, r) => n + r.tasks.length, 0)
    expect(total).toBe(fixtureProject.counts.tasksTotal)
    expect(fixtureProject.projects.map(r => r.issues.length)).toEqual([2, 0, 0, 1, 0])
    // 富项目里问题级别：一条警告（失效成员队友）+ 一条错误（失效任务指派）。
    expect(rowWeekly.issues.map(i => i.level).sort()).toEqual(['error', 'warning'])
  })
  it('富项目任务行已按 core 分组顺序排好：doing/blocked → todo → 待验收 → accepted', () => {
    expect(rowWeekly.tasks.map(t => t.task.status)).toEqual([
      'doing', 'doing', 'blocked', 'todo', 'done_pending_check', 'accepted',
    ])
  })
})

describe('taskGroups：按状态分组并保持组序', () => {
  it('富项目分出五组（无 rejected 空组），组序对齐 TASK_GROUP_ORDER，标签取视图中文', () => {
    const groups = taskGroups(rowWeekly.tasks)
    expect(groups.map(g => g.status)).toEqual(['doing', 'blocked', 'todo', 'done_pending_check', 'accepted'])
    expect(groups.map(g => g.tasks.length)).toEqual([2, 1, 1, 1, 1])
    expect(groups[0]!.label).toBe('进行中')
    expect(groups[3]!.label).toBe('待验收')
  })
  it('空任务列表给空数组；TASK_GROUP_ORDER 覆盖六个任务状态且 accepted/rejected 沉底', () => {
    expect(taskGroups([])).toEqual([])
    expect(TASK_GROUP_ORDER).toEqual(['doing', 'blocked', 'todo', 'done_pending_check', 'accepted', 'rejected'])
  })
})

describe('taskTransitionActions：状态 × 项目状态 × 承接队友的派活动作表（V2-PH4-04）', () => {
  /** 取动作的 dispatch 模式（非派活动作为 null）。 */
  const modes = (actions: ReturnType<typeof taskTransitionActions>) => actions.map(a => a.dispatchMode)

  it('todo + active：只给 primary「派活」，命令统一走 dispatchTask/assign 模式', () => {
    const actions = taskTransitionActions(taskView({ status: 'todo' }), 'active')
    expect(actions).toHaveLength(1)
    expect(actions[0]!.kind).toBe('dispatch')
    expect(actions[0]!.command).toBe('dispatchTask')
    expect(actions[0]!.dispatchMode).toBe('assign')
    expect(actions[0]!.label).toBe('派活')
    expect(actions[0]!.tone).toBe('primary')
  })
  it('blocked + active：只给 primary「恢复并派活」(resume)；旧的裸 taskResume 按钮已下线', () => {
    const actions = taskTransitionActions(taskView({ status: 'blocked' }), 'active')
    expect(actions.map(a => a.command)).toEqual(['dispatchTask'])
    expect(actions[0]!.dispatchMode).toBe('resume')
    expect(actions[0]!.label).toBe('恢复并派活')
    expect(actions[0]!.tone).toBe('primary')
  })
  it('rejected + active：给 primary「重新派活」(rework)，驳回返工走同一入口', () => {
    const actions = taskTransitionActions(taskView({ status: 'rejected' }), 'active')
    expect(actions).toHaveLength(1)
    expect(actions[0]!.dispatchMode).toBe('rework')
    expect(actions[0]!.label).toBe('重新派活')
  })
  it('doing + active + 有承接人：标记受阻 / 催办(nudge,ghost) / 改派(reassign,ghost) / 交账待验收', () => {
    const held = taskView({ status: 'doing', assigneeBotId: 'bot_1' })
    const actions = taskTransitionActions(held, 'active')
    expect(actions.map(a => a.label)).toEqual(['标记受阻', '催办', '改派', '交账待验收'])
    expect(actions.map(a => a.command)).toEqual(['taskBlock', 'dispatchTask', 'dispatchTask', 'reportDone'])
    expect(modes(actions)).toEqual([null, 'nudge', 'reassign', null])
    expect(actions.map(a => a.tone)).toEqual(['ghost', 'ghost', 'ghost', 'primary'])
  })
  it('doing + active + 待认领/指派失效：只有标记受阻与交账，不给催办/改派', () => {
    const unassigned = taskView({ status: 'doing', assigneeBotId: null })
    const gone = taskView({
      status: 'doing', assigneeBotId: 'bot-gone', assigneeBotName: null, assigneeInvalid: true,
    })
    for (const t of [unassigned, gone]) {
      const actions = taskTransitionActions(t, 'active')
      expect(actions.map(a => a.kind)).toEqual(['block', 'reportDone'])
      expect(modes(actions)).toEqual([null, null])
    }
  })
  it('done_pending_check：验收通过（primary）+ 驳回（danger 且 needsReason，先开理由弹框）', () => {
    const actions = taskTransitionActions(taskView({ status: 'done_pending_check' }), 'active')
    expect(actions.map(a => a.kind)).toEqual(['accept', 'reject'])
    expect(actions[0]!.command).toBe('acceptTask')
    expect(actions[0]!.tone).toBe('primary')
    expect(actions[0]!.needsReason).toBe(false)
    expect(actions[1]!.command).toBe('rejectTask')
    expect(actions[1]!.tone).toBe('danger')
    expect(actions[1]!.needsReason).toBe(true)
  })
  it('accepted：任何项目状态下都没有动作（终态）', () => {
    expect(taskTransitionActions(taskView({ status: 'accepted' }), 'active')).toEqual([])
    expect(taskTransitionActions(taskView({ status: 'accepted' }), 'archived')).toEqual([])
  })
  it('反例：项目暂停/完成/归档时，派活类动作全部不出现（core 只接受 active）', () => {
    for (const projectStatus of ['paused', 'done', 'archived'] as const) {
      expect(taskTransitionActions(taskView({ status: 'todo' }), projectStatus)).toEqual([])
      expect(taskTransitionActions(taskView({ status: 'blocked' }), projectStatus)).toEqual([])
      expect(taskTransitionActions(taskView({ status: 'rejected' }), projectStatus)).toEqual([])
      // doing 的非派活动作保留（与历史口径一致，合法性由 core 兜底），催办/改派必须消失。
      const held = taskView({ status: 'doing', assigneeBotId: 'bot_1' })
      const actions = taskTransitionActions(held, projectStatus)
      expect(actions.some(a => a.kind === 'dispatch')).toBe(false)
      expect(actions.map(a => a.kind)).toEqual(['block', 'reportDone'])
      // 待验收的验收动作不属于派活类，照常出现。
      expect(taskTransitionActions(taskView({ status: 'done_pending_check' }), projectStatus)).toHaveLength(2)
    }
  })
  it('样例夹具：富项目的进行中任务挂着探路 → 有催办/改派；指到失效队友的 doing 任务没有', () => {
    const [held, gone] = rowWeekly.tasks
    expect(held!.task.status).toBe('doing')
    expect(modes(taskTransitionActions(held!, 'active'))).toContain('nudge')
    expect(modes(taskTransitionActions(held!, 'active'))).toContain('reassign')
    expect(gone!.assigneeInvalid).toBe(true)
    expect(modes(taskTransitionActions(gone!, 'active'))).not.toContain('nudge')
  })
})

describe('canNudgeTask：doing 任务出现催办/改派的硬条件', () => {
  const held = () => taskView({ status: 'doing', assigneeBotId: 'bot_1' })
  it('正例：doing + 有效承接队友', () => {
    expect(canNudgeTask(held())).toBe(true)
  })
  it('反例：非 doing（含 blocked/todo/待验收/已通过）一律 false', () => {
    for (const status of ['todo', 'blocked', 'done_pending_check', 'accepted', 'rejected'] as const) {
      expect(canNudgeTask(taskView({ status, assigneeBotId: 'bot_1' }))).toBe(false)
    }
  })
  it('反例：待认领与指派失效都不给', () => {
    expect(canNudgeTask(taskView({ status: 'doing', assigneeBotId: null }))).toBe(false)
    expect(canNudgeTask(taskView({
      status: 'doing', assigneeBotId: 'bot-gone', assigneeBotName: null, assigneeInvalid: true,
    }))).toBe(false)
  })
})

describe('DISPATCH_MODE_COPY：五种模式文案齐全且后果说明如实', () => {
  const modes: DispatchMode[] = ['assign', 'resume', 'rework', 'nudge', 'reassign']
  it('每个模式都有动作名/确认/进行中/后果解释/成功提示五段文案', () => {
    for (const mode of modes) {
      const copy = DISPATCH_MODE_COPY[mode]
      for (const key of ['verb', 'confirm', 'busy', 'explain', 'success'] as const) {
        expect(copy[key].length > 0, `${mode}.${key} 不能为空`).toBe(true)
      }
    }
  })
  it('催办明确「不新建议程、状态不变」；改派明确旧队友议程会被撤销', () => {
    expect(DISPATCH_MODE_COPY.nudge.explain).toContain('不新建议程')
    expect(DISPATCH_MODE_COPY.reassign.explain).toContain('撤销')
  })
  it('成功轻提示按模式区分', () => {
    expect(DISPATCH_MODE_COPY.assign.success).toContain('已派活')
    expect(DISPATCH_MODE_COPY.resume.success).toContain('已恢复')
    expect(DISPATCH_MODE_COPY.rework.success).toContain('已重新派活')
    expect(DISPATCH_MODE_COPY.nudge.success).toBe('已催办')
    expect(DISPATCH_MODE_COPY.reassign.success).toBe('已改派')
  })
})

describe('canEditTask / canManageProject / progressPercent / issueLevelLabel', () => {
  it('归档项目不能改任务；accepted 终态不能改；其余可改', () => {
    const doingTask = taskView({ status: 'doing' })
    const acceptedTask = taskView({ status: 'accepted' })
    expect(canEditTask(doingTask, 'active')).toBe(true)
    expect(canEditTask(doingTask, 'archived')).toBe(false)
    expect(canEditTask(acceptedTask, 'active')).toBe(false)
  })
  it('只有归档项目只读陈列；完成未归档的项目仍可管理', () => {
    expect(canManageProject('active')).toBe(true)
    expect(canManageProject('paused')).toBe(true)
    expect(canManageProject('done')).toBe(true)
    expect(canManageProject('archived')).toBe(false)
  })
  it('只有归档项目给「恢复项目」入口（与 core restoreProject 白名单一致）', () => {
    expect(canRestoreProject('archived')).toBe(true)
    expect(canRestoreProject('active')).toBe(false)
    expect(canRestoreProject('paused')).toBe(false)
    expect(canRestoreProject('done')).toBe(false)
  })
  it('进度百分比四舍五入到 0–100（空任务 0）', () => {
    expect(progressPercent(rowWeekly)).toBe(17) // 1/6
    expect(progressPercent(rowMigrate)).toBe(100)
    expect(progressPercent(rowEmpty)).toBe(0)
  })
  it('问题级别中文：错误 / 提醒', () => {
    expect(issueLevelLabel('error')).toBe('错误')
    expect(issueLevelLabel('warning')).toBe('提醒')
  })
})

describe('wakeLinkState / wakeLinkTitle：任务行关联唤醒', () => {
  it('账本在、队友在岗：open，标题含类目标签与唤醒理由', () => {
    const link = wakeLink()
    expect(wakeLinkState(link)).toBe('open')
    const title = wakeLinkTitle(link)
    expect(title).toContain('常规')
    expect(title).toContain('已交账')
    expect(title).toContain('感知')
    expect(title).toContain('资料有更新')
  })
  it('账本查不到：missing，禁用并说明可能超出保留期', () => {
    const link = wakeLink({ botId: null, botName: null, ledgerId: null })
    expect(wakeLinkState(link)).toBe('missing')
    expect(wakeLinkTitle(link)).toContain('保留期')
  })
  it('队友已删除：bot_gone，账本仍在但右栏打不开', () => {
    const link = wakeLink({ botName: null })
    expect(wakeLinkState(link)).toBe('bot_gone')
    expect(wakeLinkTitle(link)).toContain('已删除')
  })
  it('没有唤醒理由时标题只有标签，不拖一个空冒号', () => {
    const title = wakeLinkTitle(wakeLink({ summary: null }))
    expect(title).toContain('常规')
    expect(title).not.toContain('：')
  })
})

describe('ownerBrief / memberBrief / assigneeBrief：人员一句话', () => {
  it('负责人：未指定 / 有效队友给名字 / 失效队友说人话且 id 只走 botId', () => {
    expect(ownerBrief(rowEmpty).text).toBe('未指定负责人')
    expect(ownerBrief(rowEmpty).botId).toBeNull()
    const weekly = ownerBrief(rowWeekly)
    expect(weekly.invalid).toBe(false)
    expect(weekly.text).toBe('探路')
    expect(ownerBrief(rowOnboard).text).toBe('总管')
    const invalid = ownerBrief(viewRow({
      ownerBotId: 'bot-gone', ownerName: null, ownerInvalid: true,
    }))
    expect(invalid.invalid).toBe(true)
    // 正文说人话、绝不露内部 id；id 单独放在 botId 里，只供界面放进悬停 title。
    expect(invalid.text).toBe('负责人已删除或退役，请重新指定')
    expect(invalid.text).not.toContain('bot-gone')
    expect(invalid.botId).toBe('bot-gone')
  })
  it('成员：有效队友给名字；失效队友用固定占位，id 只在 botId 里', () => {
    expect(memberBrief(member({ botId: 'bot_1', name: '探路' }))).toEqual({
      text: '探路', invalid: false, botId: 'bot_1',
    })
    const gone = memberBrief(member({ botId: 'bot-gone', name: null, invalid: true }))
    expect(gone.invalid).toBe(true)
    expect(gone.text).toBe('队友已删除或退役')
    expect(gone.text).not.toContain('bot-gone')
    expect(gone.botId).toBe('bot-gone')
  })
  it('指派人：待认领 / 有效队友 / 失效固定占位（三态语义）', () => {
    const unassigned = taskView({ assigneeBotId: null })
    expect(assigneeBrief(unassigned)).toEqual({ text: '待认领', invalid: false, botId: null })
    const valid = taskView({ assigneeBotId: 'bot_1', assigneeBotName: '探路' })
    expect(assigneeBrief(valid)).toEqual({ text: '探路', invalid: false, botId: 'bot_1' })
    const invalid = taskView({ assigneeBotId: 'bot-gone', assigneeBotName: null, assigneeInvalid: true })
    const got = assigneeBrief(invalid)
    expect(got.invalid).toBe(true)
    expect(got.text).toBe('指派的队友已删除或退役')
    expect(got.text).not.toContain('bot-gone')
    expect(got.botId).toBe('bot-gone')
  })
})

describe('botCatalogue / taskAssigneeOptions：可选队友与失效点名', () => {
  it('总览队友进 options；项目引用的 bot-gone 收进 invalid，绝不进 options', () => {
    const bots = [
      { id: 'bot-tanlu', name: '探路', lifecycle: 'active' as const },
      { id: 'bot-xunjian', name: '巡检员', lifecycle: 'probation' as const },
    ]
    const catalogue = botCatalogue(bots, fixtureProject)
    const ids = catalogue.options.map(o => o.botId)
    expect(ids).toContain('bot-tanlu')
    expect(ids).toContain('bot-xunjian')
    expect(ids).not.toContain('bot-gone')
    expect(catalogue.invalid.map(i => i.botId)).toContain('bot-gone')
    // 失效点名表的 label 也不许带内部 id；id 留在 botId 字段供界面放 title。
    const goneRef = catalogue.invalid.find(i => i.botId === 'bot-gone')!
    expect(goneRef.label).toBe('队友已删除或退役')
    expect(goneRef.label).not.toContain('bot-gone')
  })
  it('总览未加载（空数组）：有效成员队友防御性补进 options，失效队友仍只点名', () => {
    const catalogue = botCatalogue([], fixtureProject)
    const ids = catalogue.options.map(o => o.botId)
    expect(ids).toContain('bot-tanlu')
    expect(ids).toContain('bot-xunjian')
    expect(ids).toContain('bot-zongguan')
    expect(ids).not.toContain('bot-gone')
    expect(catalogue.invalid.map(i => i.botId)).toEqual(['bot-gone'])
  })
  it('退役队友绝不进选项', () => {
    const catalogue = botCatalogue([
      { id: 'bot-tanlu', name: '探路', lifecycle: 'retired' },
    ], null)
    expect(catalogue.options).toEqual([])
  })
  // 真机回归：项目视图行可能晚于总览一拍，退役队友的成员行仍写着 invalid=false；
  // 这时也绝不能把它当成可选成员（「力工 · 已退役」曾被塞回成员候选）。
  it('退役队友即使成员行还没刷新（invalid=false）也不进成员候选', () => {
    const row = viewRow({ members: [member({ botId: 'bot_lifu', name: '力工', invalid: false })] })
    const catalogue = botCatalogue([
      { id: 'bot_lifu', name: '力工', lifecycle: 'retired' },
      { id: 'bot_tanlu', name: '探路', lifecycle: 'active' },
    ], viewOf([row], { active: 1, paused: 0, done: 0, archived: 0, total: 1, tasksTotal: 0, tasksPendingCheck: 0 }))
    expect(catalogue.options.map(o => o.botId)).toEqual(['bot_tanlu'])
    const retiredRef = catalogue.invalid.find(i => i.botId === 'bot_lifu')!
    expect(retiredRef.label).toBe('队友已退役')
    expect(retiredRef.label).not.toContain('bot_lifu')
  })
  it('任务指派选项只含项目的有效成员队友（失效成员与非成员都不出现）', () => {
    const catalogue = botCatalogue([], fixtureProject)
    const weeklyOptions = taskAssigneeOptions(rowWeekly, catalogue).map(o => o.botId)
    expect(weeklyOptions.sort()).toEqual(['bot-tanlu', 'bot-xunjian'])
    // prj_onboard 的成员是 bot-zongguan/bot-tanlu，其他队友不出现在它的选项里。
    expect(taskAssigneeOptions(rowOnboard, catalogue).map(o => o.botId).sort()).toEqual(['bot-tanlu', 'bot-zongguan'])
    // 没有成员的项目：选项为空（任务建出来是「待认领」）。
    expect(taskAssigneeOptions(rowEmpty, catalogue)).toEqual([])
  })
  it('任务指派选项排除退役/暂停等不在岗队友，只留在岗与试岗', () => {
    const bots = [
      { id: 'bot_active', name: '在岗者', lifecycle: 'active' as const },
      { id: 'bot_probation', name: '试岗者', lifecycle: 'probation' as const },
      { id: 'bot_paused', name: '暂停者', lifecycle: 'paused' as const },
    ]
    const row = viewRow({
      members: [member({ botId: 'bot_active' }), member({ botId: 'bot_probation' }), member({ botId: 'bot_paused' })],
    })
    const catalogue = botCatalogue(bots, null)
    expect(taskAssigneeOptions(row, catalogue).map(o => o.botId).sort()).toEqual(['bot_active', 'bot_probation'])
  })
})

describe('项目表单：前置校验（空、超长、成员上限、负责人必须是成员）', () => {
  it('名称：trim 后非空且 ≤120 字', () => {
    expect(validateProjectName('')).not.toBeNull()
    expect(validateProjectName('   ')).not.toBeNull()
    expect(validateProjectName('名'.repeat(PROJECT_NAME_MAX + 1))).not.toBeNull()
    expect(validateProjectName('名'.repeat(PROJECT_NAME_MAX))).toBeNull()
    expect(validateProjectName('  周报 ')).toBeNull()
  })
  it('一句话目标：允许为空，≤500 字', () => {
    expect(validateProjectCharter('')).toBeNull()
    expect(validateProjectCharter('字'.repeat(PROJECT_CHARTER_MAX))).toBeNull()
    expect(validateProjectCharter('字'.repeat(PROJECT_CHARTER_MAX + 1))).not.toBeNull()
  })
  it('P34 愿景与约定：都允许为空，各 ≤2000 字；超出时整表按 目标→愿景→约定 顺序报错', () => {
    expect(validateProjectVision('')).toBeNull()
    expect(validateProjectVision('字'.repeat(PROJECT_VISION_MAX))).toBeNull()
    expect(validateProjectVision('字'.repeat(PROJECT_VISION_MAX + 1))).toContain('愿景')
    expect(validateProjectConventions('')).toBeNull()
    expect(validateProjectConventions('字'.repeat(PROJECT_CONVENTIONS_MAX))).toBeNull()
    expect(validateProjectConventions('字'.repeat(PROJECT_CONVENTIONS_MAX + 1))).toContain('约定')
    // 两栏同时超长：愿景先报；目标也超长时目标最先报。
    const values = {
      name: '名', charter: '', vision: '字'.repeat(PROJECT_VISION_MAX + 1),
      conventions: '字'.repeat(PROJECT_CONVENTIONS_MAX + 1), ownerBotId: '', memberBotIds: [],
      sharedDir: '', acceptanceCriteria: [],
    }
    expect(validateProjectForm(values)?.field).toBe('vision')
    expect(validateProjectForm({ ...values, charter: '字'.repeat(PROJECT_CHARTER_MAX + 1) })?.field).toBe('charter')
  })
  it('目录：允许为空，非空时 ≤1000 字', () => {
    expect(validateProjectSharedDir('')).toBeNull()
    expect(validateProjectSharedDir('/x/y/')).toBeNull()
    expect(validateProjectSharedDir('x'.repeat(PROJECT_SHARED_DIR_MAX))).toBeNull()
    expect(validateProjectSharedDir('x'.repeat(PROJECT_SHARED_DIR_MAX + 1))).not.toBeNull()
  })
  it('整表：成员超过 20 个报 members；负责人不是成员报 owner；一次只报第一个错', () => {
    const tooMany = {
      name: '名', charter: '', vision: '', conventions: '', ownerBotId: '', sharedDir: '', acceptanceCriteria: [],
      memberBotIds: Array.from({ length: PROJECT_MEMBER_MAX + 1 }, (_, i) => `bot_${i}`),
    }
    const membersError = validateProjectForm(tooMany)
    expect(membersError?.field).toBe('members')
    expect(membersError?.message).toContain(String(PROJECT_MEMBER_MAX))
    const ownerError = validateProjectForm({
      name: '名', charter: '', vision: '', conventions: '', sharedDir: '', acceptanceCriteria: [], memberBotIds: ['bot_1'], ownerBotId: 'bot_2',
    })
    expect(ownerError?.field).toBe('owner')
    // 名称为空时先报名称，不报到后面的成员/负责人。
    expect(validateProjectForm({ ...tooMany, name: '' })?.field).toBe('name')
    // 合法表单（负责人是成员之一、验收项为空）。
    expect(validateProjectForm({
      name: '名', charter: '', vision: '', conventions: '', sharedDir: '', acceptanceCriteria: [], memberBotIds: ['bot_1'], ownerBotId: 'bot_1',
    })).toBeNull()
  })
  it('验收项：标准不能为空，两个文本字段各 ≤300 字，整表最多 20 条', () => {
    const base: CriterionFormValues = { id: null, text: '周报按时出现在项目目录', verify: '打开文件看时间', status: 'open' }
    expect(validateProjectCriteria([])).toBeNull()
    expect(validateProjectCriteria([base])).toBeNull()
    expect(validateProjectCriteria([{ ...base, text: '   ' }])).toContain('第 1 条')
    expect(validateProjectCriteria([base, { ...base, text: '字'.repeat(PROJECT_CRITERION_TEXT_MAX + 1) }]))
      .toContain('第 2 条')
    expect(validateProjectCriteria([{ ...base, verify: '字'.repeat(PROJECT_CRITERION_VERIFY_MAX + 1) }]))
      .toContain('验证方式不能超过')
    expect(validateProjectCriteria(Array.from({ length: PROJECT_CRITERION_MAX + 1 }, () => base)))
      .toContain(`不能超过 ${PROJECT_CRITERION_MAX} 条`)
    // 验收项出错时排在目录错之前：一次只报第一个错。
    const error = validateProjectForm({
      name: '名', charter: '', vision: '', conventions: '', ownerBotId: '', memberBotIds: [],
      acceptanceCriteria: [{ ...base, text: '' }], sharedDir: 'x'.repeat(PROJECT_SHARED_DIR_MAX + 1),
    })
    expect(error?.field).toBe('criteria')
  })
})

describe('任务表单与驳回理由：边界校验', () => {
  it('任务标题：trim 后非空且 ≤120 字', () => {
    expect(validateTaskTitle('')).not.toBeNull()
    expect(validateTaskTitle('  ')).not.toBeNull()
    expect(validateTaskTitle('字'.repeat(TASK_TITLE_MAX + 1))).not.toBeNull()
    expect(validateTaskTitle('字'.repeat(TASK_TITLE_MAX))).toBeNull()
  })
  it('任务说明：允许为空，≤2000 字', () => {
    expect(validateTaskDetail('')).toBeNull()
    expect(validateTaskDetail('字'.repeat(TASK_DETAIL_MAX))).toBeNull()
    expect(validateTaskDetail('字'.repeat(TASK_DETAIL_MAX + 1))).not.toBeNull()
  })
  it('整表先标题后说明', () => {
    expect(validateTaskForm({ title: '', detail: '', assigneeBotId: '' })?.field).toBe('title')
    expect(validateTaskForm({ title: '好', detail: '字'.repeat(TASK_DETAIL_MAX + 1), assigneeBotId: '' })?.field).toBe('detail')
    expect(validateTaskForm({ title: '好', detail: '', assigneeBotId: '' })).toBeNull()
  })
  it('驳回理由：trim 后 1–500 字；500 字合法、501 字被拦', () => {
    expect(validateRejectReason('')).not.toBeNull()
    expect(validateRejectReason('   ')).not.toBeNull()
    expect(validateRejectReason('字'.repeat(TASK_REJECT_REASON_MAX))).toBeNull()
    expect(validateRejectReason('字'.repeat(TASK_REJECT_REASON_MAX + 1))).not.toBeNull()
    // 前后空白不算字数：498 个字 + 两端空格仍合法。
    expect(validateRejectReason(` ${'字'.repeat(TASK_REJECT_REASON_MAX - 2)} `)).toBeNull()
  })
})

describe('initial*Form：编辑初值（失效队友不预选）', () => {
  it('编辑富项目：成员预选剔除失效队友 bot-gone；负责人保留有效队友；验收项带 id 与勾选状态', () => {
    const values = initialProjectForm(rowWeekly)
    expect(values.name).toBe('竞品周报自动化')
    // P34 两层：编辑时直接回填队友项目版本的愿景与约定。
    expect(values.vision).toContain('竞品监控')
    expect(values.conventions).toContain('公开信息')
    expect(values.memberBotIds.sort()).toEqual(['bot-tanlu', 'bot-xunjian'])
    expect(values.ownerBotId).toBe('bot-tanlu')
    expect(values.sharedDir).toBe('/Users/demo/AgentHub/projects/prj_weekly/')
    expect(values.acceptanceCriteria.map(c => c.id)).toEqual(['ac_weekly_1', 'ac_weekly_2', 'ac_weekly_3'])
    expect(values.acceptanceCriteria.map(c => c.status)).toEqual(['met', 'open', 'open'])
    expect(values.acceptanceCriteria[0]!.verify).toBe('核对信源清单')
  })
  it('失效负责人的项目：负责人回到未指定（空串）', () => {
    const values = initialProjectForm(viewRow({
      ownerBotId: 'bot-gone', ownerName: null, ownerInvalid: true,
      members: [member({ botId: 'bot-gone', name: null, invalid: true })],
    }))
    expect(values.ownerBotId).toBe('')
    expect(values.memberBotIds).toEqual([])
  })
  it('新建初值全空；编辑任务保留标题/说明，失效指派回到待认领', () => {
    expect(initialProjectForm(null)).toEqual({
      name: '', charter: '', vision: '', conventions: '', ownerBotId: '', memberBotIds: [], sharedDir: '', acceptanceCriteria: [],
    })
    const ok = initialTaskForm(taskView({ status: 'doing' }))
    expect(ok.title).toBe('某任务')
    const invalid = initialTaskForm(taskView({ assigneeBotId: 'bot-gone', assigneeBotName: null, assigneeInvalid: true }))
    expect(invalid.assigneeBotId).toBe('')
    expect(initialTaskForm(null)).toEqual({ title: '', detail: '', assigneeBotId: '' })
  })
})

describe('build*Input：命令入参严格对齐 core strictObject（不多键、不缺键）', () => {
  it('saveProject 新建：空目录不带 sharedDir 键；未指定负责人显式 null；无 id 键', () => {
    const raw = buildSaveProjectInput({
      name: ' 周报 ', charter: ' 目标 ', vision: '', conventions: '', ownerBotId: '', memberBotIds: [], sharedDir: '   ',
      acceptanceCriteria: [],
    })
    expect(raw).toEqual({
      name: '周报', charter: '目标', vision: '', conventions: '',
      ownerBotId: null, memberBotIds: [], acceptanceCriteria: [],
    })
    expect(Object.keys(raw).sort()).toEqual(['acceptanceCriteria', 'charter', 'conventions', 'memberBotIds', 'name', 'ownerBotId', 'vision'])
  })
  it('saveProject 编辑：带 id、目录与负责人（trim 生效）', () => {
    const raw = buildSaveProjectInput(
      {
        name: '名', charter: '', vision: '', conventions: '', ownerBotId: 'bot_1', memberBotIds: ['bot_1'], sharedDir: ' /x ',
        acceptanceCriteria: [],
      },
      'prj_9',
    )
    expect(raw).toEqual({
      name: '名', charter: '', vision: '', conventions: '', ownerBotId: 'bot_1', memberBotIds: ['bot_1'],
      sharedDir: '/x', id: 'prj_9', acceptanceCriteria: [],
    })
    expect(Object.keys(raw).sort()).toEqual([
      'acceptanceCriteria', 'charter', 'conventions', 'id', 'memberBotIds', 'name', 'ownerBotId', 'sharedDir', 'vision',
    ])
  })
  it('saveProject 验收项：已有项带 id 与勾选状态，新增项不带；愿景与约定两栏 trim', () => {
    const raw = buildSaveProjectInput({
      name: '名', charter: '', vision: ' 为什么存在 ', conventions: ' 怎么配合 ', ownerBotId: '', memberBotIds: [], sharedDir: '',
      acceptanceCriteria: [
        { id: 'ac_1', text: ' 已有标准 ', verify: ' 核对清单 ', status: 'met' },
        { id: null, text: '新标准', verify: '', status: 'open' },
      ],
    })
    expect(raw.acceptanceCriteria).toEqual([
      { id: 'ac_1', text: '已有标准', verify: '核对清单', status: 'met' },
      { text: '新标准', verify: '' },
    ])
    expect(raw.vision).toBe('为什么存在')
    expect(raw.conventions).toBe('怎么配合')
  })
  it('saveTask：projectId 必填；待认领显式 null；编辑带 id；不带 status', () => {
    const created = buildSaveTaskInput('prj_1', { title: ' 标题 ', detail: '', assigneeBotId: '' })
    expect(created).toEqual({ projectId: 'prj_1', title: '标题', detail: '', assigneeBotId: null })
    expect(Object.keys(created).sort()).toEqual(['assigneeBotId', 'detail', 'projectId', 'title'])
    const edited = buildSaveTaskInput('prj_1', { title: 't', detail: 'd', assigneeBotId: 'bot_1' }, 'pt_8')
    expect(edited).toEqual({ id: 'pt_8', projectId: 'prj_1', title: 't', detail: 'd', assigneeBotId: 'bot_1' })
    expect(edited).not.toHaveProperty('status')
  })
  it('rejectTask：只有 id 与 trim 后的理由', () => {
    expect(buildRejectTaskInput('pt_1', ' 返工 ')).toEqual({ id: 'pt_1', rejectReason: '返工' })
  })
  it('dispatchTask：三 id 必填且不多带字段；留言 trim 后为空不带 note；空队友在前端拦住', () => {
    // 无留言：严格只有 projectId/taskId/botId 三个键。
    const bare = buildDispatchTaskInput('prj_1', 'pt_1', 'bot_1', '')
    expect(bare).toEqual({ projectId: 'prj_1', taskId: 'pt_1', botId: 'bot_1' })
    expect(Object.keys(bare).sort()).toEqual(['botId', 'projectId', 'taskId'])
    // 纯空白留言同样不传 note（trim 后为空）。
    expect(buildDispatchTaskInput('prj_1', 'pt_1', 'bot_1', '   ')).not.toHaveProperty('note')
    // 有留言：trim 后作为第四个键，不出现第五个键。
    const withNote = buildDispatchTaskInput('prj_1', 'pt_1', 'bot_1', ' 今天先出初稿 ')
    expect(withNote).toEqual({ projectId: 'prj_1', taskId: 'pt_1', botId: 'bot_1', note: '今天先出初稿' })
    expect(Object.keys(withNote).sort()).toEqual(['botId', 'note', 'projectId', 'taskId'])
    // 队友空值前端拦住（具体在岗/成员/议程名额由 core 兜底）。
    expect(validateDispatchBot('')).toBe('派活队友：请选择一个队友')
    expect(validateDispatchBot('   ')).toBe('派活队友：请选择一个队友')
    expect(validateDispatchBot('bot_1')).toBeNull()
  })
  it('dispatchTask 留言：可选；500 字合法，501 字中文拦截且报出当前字数', () => {
    expect(validateDispatchNote('')).toBeNull()
    expect(validateDispatchNote('   ')).toBeNull()
    expect(validateDispatchNote('字'.repeat(DISPATCH_NOTE_MAX))).toBeNull()
    const over = validateDispatchNote('字'.repeat(DISPATCH_NOTE_MAX + 1))
    expect(over).toContain(String(DISPATCH_NOTE_MAX))
    expect(over).toContain(String(DISPATCH_NOTE_MAX + 1))
    // 两端空白不计字数：498 个字加空格仍合法。
    expect(validateDispatchNote(` ${'字'.repeat(DISPATCH_NOTE_MAX - 2)} `)).toBeNull()
    // 拼入参时 500 字留言原样带上。
    const raw = buildDispatchTaskInput('prj_1', 'pt_1', 'bot_1', '字'.repeat(DISPATCH_NOTE_MAX))
    expect(raw.note).toHaveLength(DISPATCH_NOTE_MAX)
  })
  it('id 命令统一入参：暂停/恢复/完成/归档/卡住/恢复/交账/验收共用', () => {
    expect(buildIdInput('prj_1')).toEqual({ id: 'prj_1' })
  })
  it('attachTaskArtifact：任务 id + 版本 id，trim 后不多带键；空选择在前端拦住', () => {
    expect(buildAttachTaskArtifactInput('pt_1', ' av_2 ')).toEqual({ taskId: 'pt_1', artifactId: 'av_2' })
    expect(Object.keys(buildAttachTaskArtifactInput('pt_1', 'av_2')).sort()).toEqual(['artifactId', 'taskId'])
    expect(validateArtifactChoice('')).toContain('请选择一个产物版本')
    expect(validateArtifactChoice('   ')).toContain('请选择一个产物版本')
    expect(validateArtifactChoice('av_2')).toBeNull()
  })
})

describe('canAttachArtifact：归档与已通过是终态，其余状态都可补挂', () => {
  const statuses: TaskStatus[] = ['todo', 'doing', 'blocked', 'done_pending_check', 'rejected']
  it('未归档项目的五种任务状态都允许关联（验收前补交新产物）', () => {
    for (const status of statuses) {
      for (const projectStatus of ['active', 'paused', 'done'] as const) {
        expect(canAttachArtifact(taskView({ status }), projectStatus)).toBe(true)
      }
    }
  })
  it('已通过验收的任务不允许再关联（core 同样拒绝）', () => {
    expect(canAttachArtifact(taskView({ status: 'accepted' }), 'active')).toBe(false)
  })
  it('归档项目一律只读，即使是进行中的任务', () => {
    expect(canAttachArtifact(taskView({ status: 'doing' }), 'archived')).toBe(false)
  })
})

describe('artifactBrief：版本号、标题与验收结论', () => {
  it('有结论时给中文标签', () => {
    expect(artifactBrief(artifactView({ reviewLabel: '通过' }))).toBe('v2 · 第 45 周周报初稿 · 通过')
  })
  it('还没结论时明确写「未验收」，不留空', () => {
    expect(artifactBrief(artifactView({ reviewLabel: null }))).toBe('v2 · 第 45 周周报初稿 · 未验收')
  })
})

describe('suggestArtifactBot：默认队友空仓时建议第一位有产物的队友（U01 第 7 轮）', () => {
  const order = ['bot-a', 'bot-b', 'bot-c']
  const has = (id: string): boolean => id === 'bot-c'
  it('正例：默认队友没有版本时，按顺序挑第一位有版本的队友', () => {
    expect(suggestArtifactBot('bot-a', false, order, has)).toBe('bot-c')
  })
  it('反例：默认队友自己有版本时不换人', () => {
    expect(suggestArtifactBot('bot-c', false, order, has)).toBeNull()
  })
  it('反例：用户已手动换过人，即使当前队友空仓也绝不抢选择', () => {
    expect(suggestArtifactBot('bot-a', true, order, has)).toBeNull()
  })
  it('反例：全员空仓、空队友 id、空目录都给 null', () => {
    expect(suggestArtifactBot('bot-a', false, order, () => false)).toBeNull()
    expect(suggestArtifactBot('', false, order, has)).toBeNull()
    expect(suggestArtifactBot('bot-a', false, [], has)).toBeNull()
  })
})

describe('样例项目的产物面板与验收提醒（fixture 与 core 口径一致）', () => {
  it('待验收任务挂两版：最新在前且未验收，旧版本标 isLatest=false 且已有通过结论', () => {
    const pending = rowWeekly.tasks.find(t => t.task.id === 'pt_weekly_5')!
    expect(pending.artifacts.map(a => a.versionId)).toEqual(['av_weekly_2', 'av_weekly_1'])
    expect(pending.artifacts[0]!.isLatest).toBe(true)
    expect(pending.artifacts[0]!.reviewVerdict).toBeNull()
    expect(pending.artifacts[1]!.isLatest).toBe(false)
    expect(pending.artifacts[1]!.reviewVerdict).toBe('passed')
    expect(pending.artifactCount).toBe(2)
    // 验收提醒来自 core evaluateAcceptance：最新版还没有单独验收。
    expect(pending.acceptance.hints).toHaveLength(1)
    expect(pending.acceptance.hints[0]).toContain('还没有单独验收')
  })
  it('已通过任务挂的产物带「通过」结论，不再给验收提醒', () => {
    const accepted = rowWeekly.tasks.find(t => t.task.id === 'pt_weekly_6')!
    expect(accepted.artifacts.map(a => a.versionId)).toEqual(['av_dedup_3'])
    expect(accepted.artifacts[0]!.reviewLabel).toBe('通过')
    expect(accepted.acceptance.hints).toEqual([])
  })
})

/** 造一条产物视图行：只关心一句话展示所需字段，其余给固定值。 */
function artifactView(over: Partial<ProjectTaskArtifactView> = {}): ProjectTaskArtifactView {
  return {
    versionId: 'av_2',
    artifactId: 'art_weekly',
    number: 2,
    title: '第 45 周周报初稿',
    bytes: 2048,
    createdAt: 1,
    createdText: '今天 14:10',
    sha256: 'a'.repeat(64),
    reviewVerdict: null,
    reviewLabel: null,
    isLatest: true,
    ...over,
  }
}

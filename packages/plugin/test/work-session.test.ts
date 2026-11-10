/**
 * 工作会话投影测试（P33）：任务状态 → 在做/已归档、按项目母子分组。
 *
 * 为什么单独测：右侧边栏和左栏的每一行都对应一条真实项目任务（DC17 同一记录同一 id），
 * 分区一旦算错，主人就会在「在办的事」里看到已经交出去的活。
 * 用例基于 shared/fixture-project.ts 的样例项目视图。
 */
import { describe, expect, it } from 'vitest'
import type { ProjectTaskView, ProjectViewRow } from '../src/shared/views.js'
import { fixtureProject } from '../src/shared/fixture-project.js'
import {
  collectWorkSessions, groupSessionsByProject, phaseOf, sessionsForBot, toWorkSession,
} from '../src/client/logic/work-session.js'

const allSessions = collectWorkSessions(fixtureProject)

describe('任务状态落到哪个分区', () => {
  it('正例：进行中与受阻在「在做」，待验收与已通过归「已归档」', () => {
    expect(phaseOf('doing')).toBe('doing')
    expect(phaseOf('blocked')).toBe('doing')
    expect(phaseOf('done_pending_check')).toBe('archived')
    expect(phaseOf('accepted')).toBe('archived')
  })

  it('反例：还没开工的待办与瞬时驳回不算工作会话', () => {
    expect(phaseOf('todo')).toBeNull()
    expect(phaseOf('rejected')).toBeNull()
  })
})

describe('事务所在的主题（P63）', () => {
  it('有主题的事务带上主题 id，右侧边栏点了才能进那条讨论', () => {
    expect(allSessions.find(session => session.id === 'pt_weekly_2')?.topicId).toBe('ptp_weekly_price')
  })

  it('反例：老事务没有主题时是 null，不是空字符串', () => {
    expect(allSessions.find(session => session.id === 'pt_migrate_1')?.topicId).toBeNull()
  })
})

describe('collectWorkSessions：只收已经指派且开工的任务', () => {
  it('正例：样例项目里 7 条已指派且开工的任务被投影出来', () => {
    const ids = allSessions.map(session => session.id).sort()
    expect(ids).toEqual([
      'pt_migrate_1', 'pt_onboard_1', 'pt_weekly_2', 'pt_weekly_3',
      'pt_weekly_4', 'pt_weekly_5', 'pt_weekly_6',
    ].sort())
  })

  it('反例：待办任务与未指派任务不出现', () => {
    expect(allSessions.some(session => session.id === 'pt_weekly_1')).toBe(false) // 待办
    expect(allSessions.some(session => session.id === 'pt_onboard_2')).toBe(false) // 待办
    expect(allSessions.some(session => session.id === 'pt_old_1')).toBe(false) // 未指派
  })

  it('反例：未开工的任务即使指派了队友也不是工作会话', () => {
    const row = fixtureProject.projects[3]! // 新队友入职流程
    const todo = row.tasks[0]!
    expect(toWorkSession(row, todo)).toBeNull()
  })
})

describe('项目归档：任务一律沉到已归档', () => {
  it('正例：归档项目里的进行中任务只读陈列', () => {
    const base = fixtureProject.projects[4]! // v1 值班机器人上线（已归档）
    const original = base.tasks[0]!
    const doingTask: ProjectTaskView = {
      ...original,
      task: { ...original.task, assigneeBotId: 'bot-tanlu', status: 'doing' },
      statusLabel: '进行中',
      assigneeBotId: 'bot-tanlu',
      assigneeBotName: '探路',
      assigneeInvalid: false,
    }
    const row: ProjectViewRow = { ...base, tasks: [doingTask] }
    const session = toWorkSession(row, doingTask)
    expect(session).not.toBeNull()
    expect(session!.phase).toBe('archived')
    expect(session!.projectArchived).toBe(true)
  })
})

describe('sessionsForBot：只看自己的活', () => {
  const tanlu = sessionsForBot(allSessions, 'bot-tanlu')
  const xunjian = sessionsForBot(allSessions, 'bot-xunjian')

  it('正例：探路有一条在做、两条已归档', () => {
    expect(tanlu.map(session => session.id).sort()).toEqual(['pt_weekly_2', 'pt_weekly_5', 'pt_weekly_6'].sort())
    expect(tanlu.filter(session => session.phase === 'doing')).toHaveLength(1)
    expect(tanlu.filter(session => session.phase === 'archived')).toHaveLength(2)
  })

  it('反例：别的队友的任务不会混进来', () => {
    expect(xunjian.map(session => session.id).sort()).toEqual(['pt_migrate_1', 'pt_weekly_3'].sort())
    expect(xunjian.some(session => session.id === 'pt_weekly_2')).toBe(false)
  })
})

describe('groupSessionsByProject：项目是母、会话是子', () => {
  const groups = groupSessionsByProject(allSessions)

  it('正例：项目组按状态排序（进行中 → 暂停 → 已完成），同项目合成一组', () => {
    expect(groups.map(group => group.projectId)).toEqual(['prj_weekly', 'prj_migrate', 'prj_onboard'])
    const weekly = groups[0]!
    expect(weekly.projectName).toBe('竞品周报自动化')
    expect(weekly.sessions).toHaveLength(5)
  })

  it('正例：组内按最近变动倒序，最近交的排最前', () => {
    const weekly = groups[0]!
    expect(weekly.sessions.map(session => session.id)).toEqual([
      'pt_weekly_5', 'pt_weekly_3', 'pt_weekly_4', 'pt_weekly_2', 'pt_weekly_6',
    ])
  })

  it('反例：空输入给空数组，不造空组', () => {
    expect(groupSessionsByProject([])).toEqual([])
  })
})

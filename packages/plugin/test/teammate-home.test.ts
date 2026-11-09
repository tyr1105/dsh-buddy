/**
 * 队友主页与工作会话测试（P33）：任务状态 → 在做/已归档、按项目母子分组、
 * 摘要数字与「完成并归档」的可做条件。
 *
 * 为什么单独测：主页上的每一行都对应一条真实项目任务（DC17 同一记录同一 id），
 * 分区一旦算错，主人就会在「已归档」里看到还在做的活，或者在「在做」里
 * 看到已经交出去的活。用例基于 shared/fixture-project.ts 的样例项目视图。
 */
import { describe, expect, it } from 'vitest'
import type { ProjectTaskView, ProjectViewRow } from '../src/shared/views.js'
import { fixtureProject } from '../src/shared/fixture-project.js'
import {
  canCompleteWorkSession, collectWorkSessions, groupSessionsByProject, phaseOf,
  sessionsForBot, summarizeWorkSessions, toWorkSession,
} from '../src/client/logic/work-session.js'
import {
  buildTeammateHome, TEAMMATE_HOME_EMPTY, workSummaryText,
} from '../src/client/logic/teammate-home.js'

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

describe('项目归档：任务一律沉到已归档且不能再交账', () => {
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
    expect(session!.canComplete).toBe(false)
  })

  it('反例：受阻任务不能直接交账，要先恢复', () => {
    expect(canCompleteWorkSession('blocked', 'active')).toBe(false)
    expect(canCompleteWorkSession('doing', 'active')).toBe(true)
    expect(canCompleteWorkSession('doing', 'archived')).toBe(false)
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

describe('summarizeWorkSessions 与队友主页摘要', () => {
  it('正例：数字与受阻、待验收分开点出来', () => {
    const xunjian = summarizeWorkSessions(sessionsForBot(allSessions, 'bot-xunjian'))
    expect(xunjian).toEqual({ doing: 1, blocked: 1, archived: 1, pendingCheck: 0, total: 2 })
    expect(workSummaryText(xunjian)).toBe('在做 1 件（1 件受阻） · 已归档 1 件')

    const tanlu = summarizeWorkSessions(sessionsForBot(allSessions, 'bot-tanlu'))
    expect(tanlu).toEqual({ doing: 1, blocked: 0, archived: 2, pendingCheck: 1, total: 3 })
    expect(workSummaryText(tanlu)).toBe('在做 1 件 · 已归档 2 件（1 件待验收）')
  })

  it('反例：没有工作时不编数字，给明确空态', () => {
    const home = buildTeammateHome({
      botId: 'bot-none', botName: '新人', roleLabel: null, activityText: null, unread: 0, sessions: allSessions,
    })
    expect(home.summary.total).toBe(0)
    expect(home.doing).toEqual([])
    expect(home.archived).toEqual([])
    expect(home.emptyText).toBe(TEAMMATE_HOME_EMPTY)
    expect(home.summaryText).toBe('暂无工作会话。派发任务后在此显示。')
  })

  it('正例：主页模型只放自己的会话，母子分组与摘要一致', () => {
    const home = buildTeammateHome({
      botId: 'bot-tanlu', botName: '探路', roleLabel: '研究员', activityText: '正在处理周报', unread: 2, sessions: allSessions,
    })
    expect(home.doing.map(group => group.projectId)).toEqual(['prj_weekly'])
    expect(home.archived).toHaveLength(1)
    expect(home.archived[0]!.projectId).toBe('prj_weekly')
    expect(home.archived[0]!.sessions.map(session => session.id)).toEqual(['pt_weekly_5', 'pt_weekly_6'])
    expect(home.emptyText).toBeNull()
  })
})

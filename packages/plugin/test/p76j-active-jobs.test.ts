/**
 * P76j 第 5 节第 1 条：右侧栏「在办的事」的界面规则（纯函数）。
 * 视图行在前、旧任务在后并带「其他事务」、都没有时的空态、旧宿主退回工作会话列表；
 * 消耗条宽度只在有预计（costRatio 不为 null）时给值。
 */
import { describe, expect, it } from 'vitest'
import { OTHER_WORK_TITLE, buildActiveWorkPanel, costBarWidth } from '../src/client/logic/active-jobs.js'
import { NO_ACTIVE_WORK_TEXT } from '../src/client/logic/teammate-panel.js'
import type { ActiveJobsView } from '../src/shared/views.js'
import type { WorkSession } from '../src/client/logic/work-session.js'

/** 两行视图（一行在等你、一行不在等你）；顺序就是 core 给的顺序。 */
const VIEW: ActiveJobsView = {
  headText: '在办的事　2 件　共用 9 回合，1.4M token',
  footerText: '查看全部记录',
  rows: [
    { key: 'job_a', topicId: 'ptp_a', title: '活动报名页', stateLabel: '受阻', stateTone: 'you', waitText: '在等：你　选一个办法　已等 6 小时　交付：待定', costText: '4 / 8 回合　640K token', costRatio: 0.5, waitingOwner: true },
    { key: 'job_b', topicId: 'ptp_b', title: '嘉宾介绍页', stateLabel: '核对中', stateTone: 'run', waitText: '在等：评审员　第 1 轮，共 3 轮　交付：11月17日 18:00 前', costText: '已用 3 回合　300K token', costRatio: null, waitingOwner: false },
  ],
}

/** 一条在做的工作会话（旧的项目任务）。 */
const SESSION: WorkSession = {
  id: 'pt_old', projectId: 'prj_1', projectName: '旧项目', projectStatus: 'active', projectArchived: false,
  title: '往期名单导出', status: 'doing', statusLabel: '进行中', phase: 'doing', blocked: false, pendingCheck: false,
  assigneeBotId: 'bot_1', topicId: null, createdAt: 1, updatedAt: 2,
}

describe('1 在办的事的界面规则', () => {
  it('有视图行、也有旧任务：视图行在前，旧任务带「其他事务」，底部入口来自视图', () => {
    const panel = buildActiveWorkPanel(VIEW, [SESSION])
    expect(panel.rows.map(row => row.key)).toEqual(['job_a', 'job_b'])
    expect(panel.headText).toBe(VIEW.headText)
    expect(panel.showOtherTitle).toBe(true)
    expect(panel.groups.flatMap(group => group.sessions.map(session => session.id))).toEqual(['pt_old'])
    expect(panel.empty).toBe(false)
    expect(panel.footerText).toBe('查看全部记录')
    expect(OTHER_WORK_TITLE).toBe('其他事务')
  })

  it('只有视图行：不画「其他事务」', () => {
    const panel = buildActiveWorkPanel(VIEW, [])
    expect(panel.showOtherTitle).toBe(false)
    expect(panel.groups).toEqual([])
  })

  it('视图行为空、旧任务也没有：显示空态，标题不再用视图的整句', () => {
    const panel = buildActiveWorkPanel({ headText: NO_ACTIVE_WORK_TEXT, rows: [], footerText: '查看全部记录' }, [])
    expect(panel.empty).toBe(true)
    expect(panel.headText).toBe('在办的事')
  })

  it('旧宿主（没有视图）：退回工作会话列表，不报错、没有底部入口', () => {
    const panel = buildActiveWorkPanel(null, [SESSION])
    expect(panel.rows).toEqual([])
    expect(panel.empty).toBe(false)
    expect(panel.groups).toHaveLength(1)
    expect(panel.showOtherTitle).toBe(false)
    expect(panel.footerText).toBeNull()
    expect(panel.loading).toBe(false)
  })

  it('旧宿主、项目视图还没到：画骨架而不是空态', () => {
    const panel = buildActiveWorkPanel(null, null)
    expect(panel.loading).toBe(true)
    expect(panel.empty).toBe(true)
  })
})

describe('2 消耗条宽度', () => {
  it('有比例时换算成百分数，超出范围夹到 0 到 100', () => {
    expect(costBarWidth(0)).toBe('0%')
    expect(costBarWidth(0.5)).toBe('50%')
    expect(costBarWidth(1)).toBe('100%')
    expect(costBarWidth(1.4)).toBe('100%')
    expect(costBarWidth(-0.2)).toBe('0%')
  })

  it('没有预计（null）时不画条', () => {
    expect(costBarWidth(null)).toBeNull()
    expect(costBarWidth(Number.NaN)).toBeNull()
  })
})

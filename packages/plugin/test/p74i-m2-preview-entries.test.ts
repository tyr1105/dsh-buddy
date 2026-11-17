/**
 * P74i-m2 第 1 节的测试：预览「按入口准备样例状态」的纯函数（shared/preview-job-state.ts）。
 *
 * 为什么测它：这段逻辑此前只在预览脚本里，出了「先用后赋值」这类错（复走查 R-1，十个 ?job= 入口
 * 全部白屏）四条验收命令都发现不了。现在整理成纯函数，对十个入口各调用一次，断言不抛错、
 * 得到的状态里有这个入口该有的线程或条目。
 * 另守住两个样例缺口：私聊入口进入时样例总管是员工名单里唯一的总管（R-4，顶部状态行看得到）；
 * ?job=delivery 的项目页同一张清单里既有「一件事」新行也有旧事务行（S-5）。
 */
import { describe, expect, it } from 'vitest'
import { PREVIEW_JOB_ENTRIES, applyPreviewJobEntry, basePreviewState, previewJobThreadOf } from '../src/shared/preview-job-state.js'

const NOW = Date.parse('2026-11-18T10:00:00+08:00')

/** 私聊样例的入口（样例总管的私聊线程）与主题样例的入口，两边的断言不同。 */
const CHIEF_ENTRIES = ['b2', 'ask', 'escalation', 'stop', 'approval', 'escalation-states'] as const
const TOPIC_ENTRIES = ['topic', 'review', 'delivery', 'delivery-states', 'retro'] as const

describe('预览按入口准备样例状态（P74i-m2 第 1 节）', () => {
  it('十三个入口（P75k 的 retro、P74r20 的 launch、P81r1 的 localdir）各调用一次都不抛错，选中的线程就是该入口的样例线程', () => {
    expect(PREVIEW_JOB_ENTRIES).toHaveLength(13)
    for (const entry of PREVIEW_JOB_ENTRIES) {
      const state = applyPreviewJobEntry(basePreviewState(), entry, NOW)
      const thread = previewJobThreadOf(entry)
      expect(state.selectedThread, entry).toBe(thread.threadId)
      expect(state.threads[thread.threadId], entry).toBeDefined()
      expect(state.view, entry).toBe('main')
    }
  })

  it('私聊入口（R-4）：员工名单里保留且只保留这一位总管，就是样例线程的总管', () => {
    for (const entry of CHIEF_ENTRIES) {
      const state = applyPreviewJobEntry(basePreviewState(), entry, NOW)
      const chiefs = state.overview!.bots.filter(bot => bot.role === 'chief')
      expect(chiefs, entry).toHaveLength(1)
      expect(chiefs[0]!.id, entry).toBe(state.selectedThread)
      // 界面判断总管入口的条件：在岗（isChiefEntry 的口径：非归档）。
      expect(chiefs[0]!.staffStatus, entry).not.toBe('archived')
    }
  })

  it('主题入口：不动员工名单；主题挂在一个项目名下（delivery 挂「活动报名页」项目）', () => {
    const base = basePreviewState()
    for (const entry of TOPIC_ENTRIES) {
      const state = applyPreviewJobEntry(base, entry, NOW)
      // 名单不换人（只可能按入口给总管行补「n 件在办」那一行，走查 S-6/D-13 的既有行为）。
      expect(state.overview!.bots.map(bot => bot.id), entry).toEqual(base.overview!.bots.map(bot => bot.id))
      const attached = state.project!.projects.filter(row => row.topics.some(topic => topic.id === state.selectedThread))
      expect(attached, entry).toHaveLength(1)
      if (entry === 'delivery') expect(attached[0]!.project.id, entry).toBe('prj_signup')
    }
  })

  it('加「待你处理」条目的入口：条目进了列表，左栏与顶部的计数与条数一致（走查 D-13）', () => {
    const base = basePreviewState()
    // P74i-m5（第 7 节）：条目总数的净增量。b2、stop 各加一条约定确认条目、同时去掉基础样例里原有的那一条（净增 0）；
    // delivery 加四类条目与一条没有主题编号的验收条目（5）；approval 加两条审批与一条提议（3）；
    // escalation-states 加一条已选过办法的说明卡条目（1）。原来是 b2: 1、delivery: 4、stop: 1、approval: 2。
    // P74i-m6（第 1 节第 2 条）：escalation-states 再加一条「没有进展」条目，净增由 1 变为 2。
    // P74i-m7（第 1、2 节）：escalation-states 再加一条员工被中心停用的告警，净增由 2 变为 3。
    const added: Record<string, number> = { b2: 0, delivery: 5, stop: 0, approval: 3, 'escalation-states': 3 }
    for (const [entry, count] of Object.entries(added)) {
      const state = applyPreviewJobEntry(base, entry as (typeof PREVIEW_JOB_ENTRIES)[number], NOW)
      expect(state.inbox!.items.length, entry).toBe(base.inbox!.items.length + count)
      expect(state.overview!.inbox.total, entry).toBe(state.inbox!.items.length)
    }
    // 不加条目的入口：计数保持夹具原值。
    const untouched = applyPreviewJobEntry(base, 'topic', NOW)
    expect(untouched.inbox!.items.length).toBe(base.inbox!.items.length)
    expect(untouched.overview!.inbox.total).toBe(base.overview!.inbox.total)
  })

  it('S-5：?job=delivery 的项目页同一张清单里既有「一件事」新行也有旧事务行', () => {
    const state = applyPreviewJobEntry(basePreviewState(), 'delivery', NOW)
    const row = state.project!.projects.find(item => item.project.id === 'prj_signup')!
    expect(row.jobRows!.length).toBeGreaterThan(0)
    expect(row.tasks.length).toBe(1)
    expect(row.tasks[0]!.title).toBe('往期名单导出')
    // 与「一件事」新行不同的旧样式字段也在（状态词来自核心对照表）。
    expect(row.tasks[0]!.statusLabel).toBe('执行中')
  })

  it('delivery 与 escalation：总管那一行换成样例的「2 件在办」（chiefJobLine）', () => {
    for (const entry of ['delivery', 'escalation'] as const) {
      const state = applyPreviewJobEntry(basePreviewState(), entry, NOW)
      const chief = state.overview!.bots.find(bot => bot.role === 'chief')!
      expect(chief.chiefJobLine, entry).toBe('2 件在办')
    }
  })
})

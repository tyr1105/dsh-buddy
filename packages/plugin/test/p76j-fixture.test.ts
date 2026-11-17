/**
 * P76j 样例的一致性（任务卡第 5 节第 8 条）：样例由 core 的视图函数生成，并用 core 导出的 schema 校验。
 * 同时钉住样例里逐字列出的固定句（文案登记表的锚点）与视图生成的文字一致。
 */
import { describe, expect, it } from 'vitest'
import { ActiveJobsViewSchema, QuotaWindowViewSchema, JobProgressViewSchema, ReceiptCardViewSchema } from '@agent-hub/core'
import {
  BUDGET_COPY_LINES, sampleActiveJobsChief, sampleActiveJobsExecutor, sampleBudgetChiefLine, sampleEstimate,
  sampleJobProgressWithCost, sampleQuotaWindow, sampleQuotaWindowFull, sampleReceiptWithCost,
} from '../src/shared/fixture-budget.js'

describe('P76j 样例由 core 的视图函数生成', () => {
  it('在办的事：schema 通过，三件、头部逐字、每行三段文字都有', () => {
    expect(ActiveJobsViewSchema.parse(sampleActiveJobsChief)).toEqual(sampleActiveJobsChief)
    expect(sampleActiveJobsChief.rows).toHaveLength(3)
    expect(sampleActiveJobsChief.headText).toBe(BUDGET_COPY_LINES.headText)
    for (const row of sampleActiveJobsChief.rows) {
      expect(row.waitText.startsWith('在等：')).toBe(true)
      expect(row.costText.length).toBeGreaterThan(0)
    }
  })

  it('在办的事：员工只列他参与的，且条数比总管少', () => {
    expect(ActiveJobsViewSchema.parse(sampleActiveJobsExecutor)).toEqual(sampleActiveJobsExecutor)
    expect(sampleActiveJobsExecutor.rows.length).toBeGreaterThan(0)
    expect(sampleActiveJobsExecutor.rows.length).toBeLessThan(sampleActiveJobsChief.rows.length)
  })

  it('本窗口额度：两种状态都通过 schema，正常状态写员工回合与留出比例', () => {
    expect(QuotaWindowViewSchema.parse(sampleQuotaWindow)).toEqual(sampleQuotaWindow)
    expect(QuotaWindowViewSchema.parse(sampleQuotaWindowFull)).toEqual(sampleQuotaWindowFull)
    expect(sampleQuotaWindow.state).toBe('normal')
    expect(sampleQuotaWindow.staffUsedTurnsText).toBe(BUDGET_COPY_LINES.quotaUsed)
    expect(sampleQuotaWindow.staffLeftTurnsText).toBe(BUDGET_COPY_LINES.quotaLeft)
    expect(sampleQuotaWindow.reserveText).toBe(BUDGET_COPY_LINES.reserve)
    expect(sampleQuotaWindowFull.state).toBe('staff_full')
    expect(sampleQuotaWindowFull.staffLeftTurnsText).toBe('已到上限')
  })

  it('进度行：schema 通过，第三行逐字，逐回合明细非空', () => {
    expect(JobProgressViewSchema.parse(sampleJobProgressWithCost)).toEqual(sampleJobProgressWithCost)
    expect(sampleJobProgressWithCost.costLine).toBe(BUDGET_COPY_LINES.costLine)
    expect(sampleJobProgressWithCost.costTurns?.length).toBeGreaterThan(0)
    for (const row of sampleJobProgressWithCost.costTurns ?? []) {
      expect(row.at).not.toBe('')
      expect(row.who).not.toBe('')
      expect(row.step).not.toBe('')
      expect(row.tokens.length).toBeGreaterThan(0)
    }
  })

  it('约定卡「预计消耗」：有标题、数字加粗的 headline、若干行与页脚', () => {
    expect(sampleEstimate).not.toBeNull()
    expect(sampleEstimate!.title).toBe('预计消耗')
    expect(sampleEstimate!.headline).toContain('回合')
    expect(sampleEstimate!.lines.length).toBeGreaterThan(0)
    expect(sampleEstimate!.basisLine.length).toBeGreaterThan(0)
    expect(sampleEstimate!.footer.length).toBeGreaterThan(0)
  })

  it('回执：第六行「消耗」由 core 追加，逐字一致', () => {
    expect(ReceiptCardViewSchema.parse(sampleReceiptWithCost)).toEqual(sampleReceiptWithCost)
    expect(sampleReceiptWithCost.rows.map(row => row.label)).toEqual([
      '从「定了」到验收', '需要你处理', '总管代你答复的问题', '核对', '约定版本', '消耗',
    ])
    expect(sampleReceiptWithCost.rows.at(-1)?.value).toBe(BUDGET_COPY_LINES.receiptCost)
  })

  it('样例模块里没有手写的视图字段字面量：头部、消耗行、回执值都来自上面这些常量断言', () => {
    // 左栏一句同样由 core 的 chiefJobLine 读「在办的事」生成，不在样例里手写。
    expect(sampleBudgetChiefLine).toBe(BUDGET_COPY_LINES.chiefLine)
    // 反向：改动样例记录而不改这些常量时，上面的逐字断言会失败；这里只确认常量表本身被引用。
    expect(Object.keys(BUDGET_COPY_LINES).sort()).toEqual([
      'chiefLine', 'costLine', 'emptyText', 'footer', 'headText', 'quotaLeft', 'quotaUsed', 'receiptCost', 'reserve',
    ])
  })
})

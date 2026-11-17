/**
 * P76j：预览快照与 core 视图逐字一致（做法同 p74i-m2 的预览快照测试）。
 * 预览拖不进整个 core，只能带一份快照；快照一旦与 fixture-budget.ts 生成的结果不同，这里先失败。
 */
import { describe, expect, it } from 'vitest'
import { PREVIEW_BUDGET, PREVIEW_BUDGET_CHIEF_LINE } from '../src/shared/fixture-budget-preview.js'
import {
  sampleActiveJobsChief, sampleBudgetChiefLine, sampleBudgetReceiptThread, sampleBudgetThread, sampleBudgetTweetThread,
  sampleEstimate, sampleJobProgressWithCost, sampleQuotaWindow, sampleReceiptWithCost,
} from '../src/shared/fixture-budget.js'

describe('P76j 预览快照与 core 生成的样例逐字相同', () => {
  it('右栏、额度、进度行、预计、回执五项一致', () => {
    expect(PREVIEW_BUDGET.activeJobs).toEqual(sampleActiveJobsChief)
    expect(PREVIEW_BUDGET.quota).toEqual(sampleQuotaWindow)
    expect(PREVIEW_BUDGET.progress).toEqual(sampleJobProgressWithCost)
    expect(PREVIEW_BUDGET.estimate).toEqual(sampleEstimate)
    expect(PREVIEW_BUDGET.receipt).toEqual(sampleReceiptWithCost)
  })

  it('三个主题与左栏一句一致', () => {
    expect(PREVIEW_BUDGET.report).toEqual(sampleBudgetThread)
    expect(PREVIEW_BUDGET.receiptThread).toEqual(sampleBudgetReceiptThread)
    expect(PREVIEW_BUDGET.tweetThread).toEqual(sampleBudgetTweetThread)
    expect(PREVIEW_BUDGET_CHIEF_LINE).toBe(sampleBudgetChiefLine)
  })
})

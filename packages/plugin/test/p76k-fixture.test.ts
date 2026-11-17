/**
 * P76k 样例一致性：预览快照（fixture-budget-preview.ts）必须与 core 视图函数实时生成的
 * 结果逐字相同——快照只是浏览器包拉不进 core 的替身，不能变成手写的第二份口径。
 * 另外钉住三种额度状态与摘要的关键文字，防止样例被改成与真实情形不符的样子。
 */
import { describe, expect, it } from 'vitest'
import { QuotaWindowViewSchema, WeeklyUsageViewSchema } from '@agent-hub/core'
import { fixtureAwaySummary, fixtureQuotaWindow, fixtureWeeklyUsage } from '../src/shared/fixture-budget.js'
import {
  PREVIEW_QUOTA_NOW, previewAwaySummary, previewQuotaNormal, previewQuotaOwnerHold, previewQuotaStaffFull, previewWeeklyUsage,
} from '../src/shared/fixture-budget-preview.js'

describe('P76k 样例由 core 的视图函数生成', () => {
  it('离开期间摘要快照与实时生成逐字相同', () => {
    expect(previewAwaySummary).toEqual(fixtureAwaySummary())
  })

  it('三种额度窗口快照与实时生成逐字相同，且都过 core 的 schema', () => {
    expect(previewQuotaNormal).toEqual(fixtureQuotaWindow('normal', PREVIEW_QUOTA_NOW))
    expect(previewQuotaStaffFull).toEqual(fixtureQuotaWindow('staff_full', PREVIEW_QUOTA_NOW))
    expect(previewQuotaOwnerHold).toEqual(fixtureQuotaWindow('owner_hold', PREVIEW_QUOTA_NOW))
    for (const view of [previewQuotaNormal, previewQuotaStaffFull, previewQuotaOwnerHold]) {
      expect(() => QuotaWindowViewSchema.parse(view)).not.toThrow()
    }
  })

  it('用量表快照与实时生成逐字相同，且过 core 的 schema', () => {
    expect(previewWeeklyUsage).toEqual(fixtureWeeklyUsage())
    expect(() => WeeklyUsageViewSchema.parse(previewWeeklyUsage)).not.toThrow()
  })

  it('摘要内容与场景 F 对得上：三件事、通知两次、末行给合计', () => {
    const lines = fixtureAwaySummary().lines
    expect(lines[0]).toContain('你离开的')
    expect(lines.some(line => line.includes('已交付，在等你验收'))).toBe(true)
    expect(lines.some(line => line.includes('核对第 1 轮退回 1 条'))).toBe(true)
    expect(lines.some(line => line.includes('仍在等你确认约定第 2 版'))).toBe(true)
    expect(lines.at(-1)).toContain('通知过你 2 次。')
  })
})

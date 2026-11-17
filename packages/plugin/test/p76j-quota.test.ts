/**
 * P76j 第 5 节第 7 条：顶栏额度文字。
 * 新宿主（有额度窗口视图）时五种状态逐字取视图的 lightLabel、lightHint；
 * 旧宿主退回原来的四档文字，红灯说明里不再出现「明天」。
 */
import { describe, expect, it } from 'vitest'
import { quotaMeaning } from '../src/client/logic/quota.js'
import { sampleQuotaWindow, sampleQuotaWindowFull } from '../src/shared/fixture-budget.js'
import type { Light, QuotaWindowView } from '../src/shared/views.js'

/** 把样例视图换成某种灯（文字由 core 给，这里只验证界面原样显示）。 */
function windowWith(light: Light, label: string, hint: string): QuotaWindowView {
  return { ...sampleQuotaWindow, light, lightLabel: label, lightHint: hint }
}

describe('1 新宿主：读额度窗口视图', () => {
  it('正常状态：结论与说明逐字取视图', () => {
    expect(quotaMeaning('green', sampleQuotaWindow)).toEqual({
      label: sampleQuotaWindow.lightLabel, hint: sampleQuotaWindow.lightHint,
    })
  })

  it('五种灯的文字各自照视图显示（绿、黄、橙、两种红）', () => {
    const cases: Array<[Light, string, string]> = [
      ['green', '额度充足', '员工按正常节奏开工。'],
      ['yellow', '额度过半', '员工份额用过一半，员工自己发起的工作放慢节奏。'],
      ['orange', '额度紧张', '员工份额用到八成，只有你交代的事和你发起的对话继续。'],
      ['red', '员工份额已用完', '员工在 18:20 前不开新回合；你发起的对话不受影响。'],
      ['red', '额度已用完', '约 18:25 恢复，到时先试一个回合。'],
    ]
    for (const [light, label, hint] of cases) {
      expect(quotaMeaning(light, windowWith(light, label, hint))).toEqual({ label, hint })
    }
  })

  it('员工份额用完的那一种：视图里带恢复时刻', () => {
    expect(sampleQuotaWindowFull.lightLabel).toBe('员工份额已用完')
    expect(sampleQuotaWindowFull.lightHint).toContain('前不开新回合')
  })
})

describe('2 旧宿主：退回四档文字', () => {
  it('绿、黄、橙沿用原来的两句', () => {
    expect(quotaMeaning('green').label).toBe('额度充足')
    expect(quotaMeaning('yellow').hint).toContain('放慢节奏')
    expect(quotaMeaning('orange').label).toBe('额度紧张')
  })

  it('红灯说明不再写「明天」：改成等额度窗口恢复', () => {
    const red = quotaMeaning('red')
    expect(red.label).toBe('额度用完')
    expect(red.hint).not.toContain('明天')
    expect(red.hint).toContain('额度窗口恢复')
  })

  it('null 与 undefined 都按旧宿主处理', () => {
    expect(quotaMeaning('green', null)).toEqual(quotaMeaning('green'))
    expect(quotaMeaning('green', undefined)).toEqual(quotaMeaning('green'))
  })
})

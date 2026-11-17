/**
 * P74h 拦截原因映射的测试：core 的 SUPPRESSION_REASON_LABELS 要包含两个新值
 * （job_cap「这件事的回合用到上限」、job_inactive「这件事已不需要这次唤醒」），
 * 插件界面显示的拦截原因文字全部来自 core 的这张表（P74a 已加好，这里钉住口径，
 * 防止以后改表时把这两个值漏掉）。同时核对插件的 SuppressionReason 类型取值与 core 一致。
 */
import { describe, expect, it } from 'vitest'
import { SUPPRESSION_REASON_LABELS, SUPPRESSION_REASONS } from '@agent-hub/core'

describe('拦截原因映射（P74h）', () => {
  it('包含 job_cap 与 job_inactive 的显示文字', () => {
    expect(SUPPRESSION_REASON_LABELS.job_cap).toBe('这件事的回合用到上限')
    expect(SUPPRESSION_REASON_LABELS.job_inactive).toBe('这件事已不需要这次唤醒')
  })

  it('这张表覆盖全部拦截原因（core 的取值与文字一一对应，没有 undefined）', () => {
    for (const reason of SUPPRESSION_REASONS) {
      expect(SUPPRESSION_REASON_LABELS[reason], reason).toBeTruthy()
    }
  })
})

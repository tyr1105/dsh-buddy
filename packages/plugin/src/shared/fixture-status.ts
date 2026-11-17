/**
 * 样例员工的状态字段（P73f）：员工状态的三个字段（状态、标签、停用原因）不手写，
 * 一律调用 core 的 staffStatus 生成，样例与真实引擎对同样输入的结果始终一致。
 *
 * 为什么单独成文件：总览样例（fixtures.ts）、办公室样例（fixture-office.ts）、预览桩都要用，
 * 放在一处，core 改了状态的叫法或停用原因的写法，所有样例跟着变（第一块教训：样例不手写视图字段）。
 * 一致性由 test/p73f-staff-status.test.ts 校验。
 */
import { staffStatus } from '@agent-hub/core'
import type { Lifecycle, StaffStatus } from './views.js'

/** 样例员工状态的三个字段，形状与 BotCard、OfficeOccupantView 里的同名字段一致。 */
export interface SampleStaffFields {
  staffStatus: StaffStatus
  staffStatusLabel: string
  staffStatusReason: string | null
}

/**
 * 按存储用的 lifecycle（以及可选的归档时间、隔离原因）算出员工状态三个字段。
 * archivedAt 传数字表示已归档；quarantineReason 只在 lifecycle 为 quarantined 时有意义。
 */
export function sampleStaffFields(
  lifecycle: Lifecycle,
  extra: { archivedAt?: number | null; quarantineReason?: string | null } = {},
): SampleStaffFields {
  const result = staffStatus({
    lifecycle,
    archivedAt: extra.archivedAt ?? null,
    quarantineReason: extra.quarantineReason ?? null,
  })
  return { staffStatus: result.status, staffStatusLabel: result.label, staffStatusReason: result.reason }
}

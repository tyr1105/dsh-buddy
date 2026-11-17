/**
 * 员工状态按钮的纯逻辑（P73f 重写；原为 D07 第 24 条）：编辑员工弹窗、线程头部、设置页三处共用，
 * 保证「按员工当前状态只显示合法的选项」这条规则只有一份实现、可单测。
 *
 * 背景：界面上员工状态只有三种：在岗、停用、归档（core 的 staffStatus 把存储用的六种 lifecycle 合并而成）。
 * 试岗、转正、解除隔离、退役这些旧步骤和按钮都去掉了：
 * - 从在岗选停用，发 lifecycleAction 的 suspend；
 * - 从停用选在岗，发 reinstate；
 * - 选归档，先弹二次确认（先调用 archiveBotCheck 看能不能归档），确认后发 archive；归档不能恢复为在岗。
 * 所以这里没有任何和 lifecycle 六种取值有关的判断，一律读 staffStatus。
 */
import type { Lifecycle, StaffStatus } from '../../shared/views.js'

/**
 * 是不是已归档的员工（P73f：旧的「已退役」判断统一为归档）。
 * 优先读 core 给的 staffStatus；只有旧形状的数据（没有 staffStatus，只有 lifecycle 或 archived 标记）时，
 * 退而求其次：存储里的 retired 和归档标记在 core 里都等于归档，所以这样判断结果一致。
 */
export function isArchivedBot(bot: { lifecycle?: Lifecycle; staffStatus?: StaffStatus; archived?: boolean }): boolean {
  if (bot.staffStatus !== undefined) return bot.staffStatus === 'archived'
  return bot.archived === true || bot.lifecycle === 'retired'
}

/** 只有存储用的 lifecycle 时（授权对象、项目成员选项等），按 core 的合并规则翻成三种状态的显示名。 */
export function staffLabelOfLifecycle(lifecycle: Lifecycle): string {
  if (lifecycle === 'retired') return '归档'
  if (lifecycle === 'paused' || lifecycle === 'quarantined') return '停用'
  return '在岗'
}

/** 归档二次确认框出现期间，「保存」旁边的说明（P73r4）。 */
export const SAVE_BLOCKED_BY_ARCHIVE_NOTE = '先确认或取消归档'

/**
 * 编辑弹窗里「保存」要不要置灰（P73r4）：归档二次确认框出现期间（含检查中、不能归档的提示）不可用。
 * 原因：保存只提交表单里的字段，不会提交「归档」这个待确认的选择；允许保存的话，弹窗会静默关闭、员工没有归档、也没有任何提示。
 * 点「确认归档」或「取消」后确认框消失，这里随之恢复为可用。
 */
export function saveBlockedByArchive(archive: unknown | null): boolean {
  return archive !== null
}

/** 状态变更对应的 lifecycleAction 动作名（与 core 的 LifecycleActionSchema 一致）。 */
export type StatusAction = 'suspend' | 'reinstate' | 'archive'

/** 单选组里的一个选项：value 是三种状态之一，selected 是当前状态，disabled 时旁边的 note 说明原因。 */
export interface StaffStatusOption {
  value: StaffStatus
  label: string
  selected: boolean
  disabled: boolean
  /** 不可选时写在选项旁边的原因；可选时为 null。 */
  note: string | null
}

/** 单选组下面的一行说明（设计稿场景 D 原文）。 */
export const STAFF_STATUS_HINT = '停用：保留记忆和工位，不接新活。归档：腾出名额，记录保留可查。'

/** 总管的归档选项旁边的原因。 */
export const CHIEF_NO_ARCHIVE_NOTE = '总管不能归档'

/** 已归档员工的状态不能再改：所有选项都不可选，原因写在归档旁。 */
export const ARCHIVED_NO_CHANGE_NOTE = '已归档，不能恢复为在岗'

/** 三种状态的显示名；编辑弹窗、状态行共用，和 core 的 STAFF_STATUS_LABELS 一致。 */
const OPTION_LABELS: Readonly<Record<StaffStatus, string>> = { on_duty: '在岗', suspended: '停用', archived: '归档' }

/**
 * 编辑弹窗里状态单选组的三个选项，顺序固定：在岗、停用、归档。
 * - 总管（chief 为 true）的「归档」不可选，旁边写「总管不能归档」；
 * - 已归档的员工三个选项都不可选（归档不可逆）。
 */
export function staffStatusOptions(status: StaffStatus, opts: { chief?: boolean } = {}): StaffStatusOption[] {
  const order: StaffStatus[] = ['on_duty', 'suspended', 'archived']
  return order.map(value => {
    const selected = value === status
    let disabled = false
    let note: string | null = null
    if (status === 'archived') {
      disabled = !selected
      // 原因只写在「在岗」旁边，一处说清，不在每个选项旁重复。
      note = value === 'on_duty' ? ARCHIVED_NO_CHANGE_NOTE : null
    } else if (value === 'archived' && opts.chief === true) {
      disabled = true
      note = CHIEF_NO_ARCHIVE_NOTE
    }
    return { value, label: OPTION_LABELS[value], selected, disabled, note }
  })
}

/**
 * 从当前状态改成目标状态要发的动作；不需要发（选了当前状态、已归档）返回 null。
 * 选归档时调用方要先弹二次确认，确认后才真的发 archive。
 */
export function statusChangeAction(from: StaffStatus, to: StaffStatus): StatusAction | null {
  if (from === to || from === 'archived') return null
  if (to === 'archived') return 'archive'
  if (to === 'suspended') return from === 'on_duty' ? 'suspend' : null
  return from === 'suspended' ? 'reinstate' : null
}

/** 线程头部只放「停用」「恢复在岗」两个快捷按钮；当前状态没有合法动作（已归档）时返回 null。 */
export function headerStatusAction(status: StaffStatus | null): 'suspend' | 'reinstate' | null {
  if (status === 'on_duty') return 'suspend'
  if (status === 'suspended') return 'reinstate'
  return null
}

/** 线程头部快捷按钮的文字。 */
export function headerStatusLabel(action: 'suspend' | 'reinstate'): string {
  return action === 'suspend' ? '停用' : '恢复在岗'
}

/** 「全部停用 / 全部恢复在岗」要操作的员工 id：停用只动在岗的，恢复只动停用的（已归档的不动）。 */
export function staffAllTargets(bots: ReadonlyArray<{ id: string; staffStatus: StaffStatus }>, target: 'suspend' | 'reinstate'): string[] {
  const wanted: StaffStatus = target === 'suspend' ? 'on_duty' : 'suspended'
  return bots.filter(bot => bot.staffStatus === wanted).map(bot => bot.id)
}

/** 各动作成功后的提示语。 */
export const STATUS_OK_TEXT: Readonly<Record<StatusAction, string>> = {
  suspend: '已停用。记忆和工位保留，可随时恢复在岗。',
  reinstate: '已恢复在岗。',
  archive: '已归档。记录保留可查。',
}

/** 归档检查结果里二次确认要用到的部分（与 core 的 ArchiveBotCheck 同形，memberProjects 旧宿主可能没有）。 */
export interface ArchiveConfirmInfo {
  canArchive: boolean
  reason: string | null
  memberProjects?: ReadonlyArray<{ projectId: string; projectName: string }>
}

/** 二次确认弹出的文字：不能归档时只有原因；能归档时有主句，有项目成员身份时再多一行。 */
export interface ArchiveConfirmLines {
  /** 不能归档的原因；能归档时为 null。 */
  blocked: string | null
  /** 主句：不能归档时为 null。 */
  main: string | null
  /** 「将移出项目：…」；没有项目成员身份时为 null。 */
  projects: string | null
}

export function archiveConfirmLines(name: string, info: ArchiveConfirmInfo): ArchiveConfirmLines {
  if (!info.canArchive) return { blocked: info.reason ?? '现在不能归档。', main: null, projects: null }
  const names = (info.memberProjects ?? []).map(project => project.projectName)
  return {
    blocked: null,
    main: `归档后${name}不再接活，腾出 1 个名额；记录保留可查。归档后不能恢复为在岗。`,
    projects: names.length === 0 ? null : `将移出项目：${names.join('、')}`,
  }
}

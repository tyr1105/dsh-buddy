/**
 * 设置页的分区清单与「改了哪些」判断（纯函数，P51）。
 *
 * 为什么单独成文件：左边的分区导航、分区上的改动圆点、底部保存条的件数都依赖同一份
 * 「哪个字段属于哪个分区」。放在一处，新增设置项时只改这张表，界面不会各算各的。
 */
import type { SettingsDraft } from './settings.js'

export type SettingsSectionId = 'notify' | 'usage' | 'resources' | 'knowledge' | 'status'

export interface SettingsSection {
  id: SettingsSectionId
  title: string
  /** 分区顶部的一句话：说清这里管什么，不重复标题。 */
  summary: string
}

/** 左边分区的顺序：先放最常改的，只看不改的运行状态放最后。 */
export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  { id: 'notify', title: '打扰与日报', summary: '队友可发起通知的时段与每日上限。' },
  { id: 'usage', title: '模型与用量', summary: '队友默认用什么模型，每天最多用多少。' },
  { id: 'resources', title: '资料', summary: '登记全队共用的资料，并决定谁能读。' },
  { id: 'knowledge', title: '公共知识库', summary: '接入一个外部知识库，全队只读。' },
  { id: 'status', title: '运行状态', summary: '后台是否正常，以及一键暂停全队。' },
]

/** 每个分区管哪些草稿字段；资料和运行状态没有草稿，立刻生效。 */
const SECTION_FIELDS: Readonly<Partial<Record<SettingsSectionId, ReadonlyArray<keyof SettingsDraft>>>> = {
  notify: ['quietStart', 'quietEnd', 'digestAt', 'pushChannel', 'dailyPushCap', 'botDailyPushCap'],
  usage: ['defaultModel', 'botDailyTurnBudget', 'botDailyTokenBudget'],
  knowledge: ['kbEnabled', 'kbEndpoint', 'kbAuthRef', 'kbProtocol', 'kbScope', 'kbMaxBytes'],
}

/** 输入框里是字符串、加载来的可能是数字，统一成字符串比较，避免「没改却算改了」。 */
function changed(draft: SettingsDraft, loaded: SettingsDraft, field: keyof SettingsDraft): boolean {
  return String(draft[field]) !== String(loaded[field])
}

/** 改动的字段数，给底部保存条用。 */
export function changedFieldCount(draft: SettingsDraft, loaded: SettingsDraft | null): number {
  if (loaded === null) return 0
  return Object.values(SECTION_FIELDS).flat().filter(field => changed(draft, loaded, field)).length
}

/** 有改动的分区，给左边导航的圆点用。 */
export function changedSections(draft: SettingsDraft, loaded: SettingsDraft | null): SettingsSectionId[] {
  if (loaded === null) return []
  return (Object.keys(SECTION_FIELDS) as SettingsSectionId[])
    .filter(id => (SECTION_FIELDS[id] ?? []).some(field => changed(draft, loaded, field)))
}

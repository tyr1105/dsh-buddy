/**
 * 设置页的分区清单与「改了哪些」判断（纯函数，P51）。
 *
 * 为什么单独成文件：左边的分区导航、分区上的改动圆点、底部保存条的件数都依赖同一份
 * 「哪个字段属于哪个分区」。放在一处，新增设置项时只改这张表，界面不会各算各的。
 *
 * P76k 按方案 7.10.1 精简：第一区改名为「通知」（只剩免打扰与通知方式），
 * 第二区改名为「模型与额度」（默认模型、给你自己留出、员工自己发起的工作）。
 */
import type { SettingsDraft } from './settings.js'

export type SettingsSectionId = 'notify' | 'usage' | 'resources' | 'knowledge' | 'memory' | 'status'

export interface SettingsSection {
  id: SettingsSectionId
  title: string
  /** 分区顶部的一句话：说清这里管什么，不重复标题。 */
  summary: string
}

/** 左边分区的顺序：先放最常改的，只看不改的运行状态放最后。 */
export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  { id: 'notify', title: '通知', summary: '哪些事会通知你，什么时段不打扰。' },
  { id: 'usage', title: '模型与额度', summary: '员工默认用的模型，以及额度窗口怎样分给员工和你。' },
  { id: 'resources', title: '资料', summary: '登记全队共用的资料，并决定谁能读。' },
  { id: 'knowledge', title: '公共知识库', summary: '接入一个外部知识库，全队只读。' },
  // P86：「关于你的记忆」收进设置页（原来在左栏员工列表底部与总管右侧栏各有一个常驻入口）。
  // 这一分区没有需要保存的设置项（不在下面的 SECTION_FIELDS 里），所以没有改动圆点，也不出现保存条；
  // 摆在给主人改的分区之后、只读的运行状态之前。分区页头由记忆页自己带（标题与说明由 core 给），这里的 summary 只在清单里占位。
  { id: 'memory', title: '关于你的记忆', summary: '系统记住的关于你的内容，可以更正或删除。' },
  { id: 'status', title: '运行状态', summary: '后台是否正常，以及一键全部停用。' },
]

/**
 * P86：页面状态（PageView）与设置页分区的对应关系，左栏高亮与设置页选中分区共用这一处：
 * - settings：设置页，不指定分区；
 * - resource：设置页停在「资料」分区；
 * - memory：设置页停在「关于你的记忆」分区（约定卡出处跳转、「已记住」一行跳转、从上次页面状态恢复都落在这里）。
 * 其余页面状态不是设置页，返回 undefined。
 */
export function settingsSectionOfView(view: string): SettingsSectionId | null | undefined {
  if (view === 'resource') return 'resources'
  if (view === 'memory') return 'memory'
  if (view === 'settings') return null
  return undefined
}

/** 页面状态是否落在设置页里（左栏据此高亮「设置」）。 */
export function isSettingsPageView(view: string): boolean {
  return settingsSectionOfView(view) !== undefined
}

/** 每个分区管哪些草稿字段；资料和运行状态没有草稿，立刻生效。 */
const SECTION_FIELDS: Readonly<Partial<Record<SettingsSectionId, ReadonlyArray<keyof SettingsDraft>>>> = {
  notify: ['quietStart', 'quietEnd', 'pushChannel'],
  usage: ['defaultModel', 'botQuotaShare', 'botDailyTurnBudget'],
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

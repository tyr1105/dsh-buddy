/**
 * 设置页「改了哪些」的判断（P51）：保存条的件数和左边分区的圆点都依赖它，
 * 算错的话，要么没改却提示未保存，要么改了却看不到保存按钮。
 */
import { describe, expect, it } from 'vitest'
import { SETTINGS_SECTIONS, changedFieldCount, changedSections } from '../src/client/logic/settings-sections.js'
import type { SettingsDraft } from '../src/client/logic/settings.js'

const base: SettingsDraft = {
  quietStart: '23:00', quietEnd: '08:00', digestAt: '08:30', pushChannel: 'macos',
  dailyPushCap: '3', botDailyPushCap: '2', botDailyTurnBudget: '6', botDailyTokenBudget: '250000',
  defaultModel: '', kbEnabled: false, kbEndpoint: '', kbAuthRef: '', kbProtocol: '', kbScope: '', kbMaxBytes: '262144',
}

describe('设置分区', () => {
  it('资料和运行状态都有独立分区，资料属于全局配置', () => {
    expect(SETTINGS_SECTIONS.map(section => section.id)).toEqual(['notify', 'usage', 'resources', 'knowledge', 'status'])
  })
  it('没有改动时件数为 0，也没有分区带圆点', () => {
    expect(changedFieldCount({ ...base }, base)).toBe(0)
    expect(changedSections({ ...base }, base)).toEqual([])
  })
  it('数字和字符串写法相同不算改动', () => {
    expect(changedFieldCount({ ...base, dailyPushCap: 3 }, base)).toBe(0)
  })
  it('改动按字段计数，并归到各自的分区', () => {
    const draft = { ...base, quietStart: '22:00', digestAt: '09:00', botDailyTurnBudget: '8' }
    expect(changedFieldCount(draft, base)).toBe(3)
    expect(changedSections(draft, base)).toEqual(['notify', 'usage'])
  })
  it('知识库的改动归到知识库分区', () => {
    expect(changedSections({ ...base, kbEndpoint: 'https://wiki.example.com' }, base)).toEqual(['knowledge'])
  })
  it('基线还没加载时不提示修改', () => {
    expect(changedFieldCount(base, null)).toBe(0)
    expect(changedSections(base, null)).toEqual([])
  })
})

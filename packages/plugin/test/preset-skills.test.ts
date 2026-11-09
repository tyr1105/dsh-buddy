/**
 * P40 预置 skill 的界面逻辑与样例门面测试：
 * 勾选切换、三档条件分组、只读摘要不泄露内部 id，
 * 以及 FixtureHub 在沙箱里真的保存档案勾选（浏览器走查靠它）。
 */
import { describe, expect, it } from 'vitest'
import {
  groupPresetSkillOptions, knownPresetSkillIds, presetSkillNames, presetSkillSummary, togglePresetSkill,
} from '../src/client/logic/preset-skills.js'
import { fixtureSettings } from '../src/shared/fixtures.js'
import { FixtureHub } from '../src/host/hub-facade.js'

const options = fixtureSettings.presetSkillOptions

describe('预置 skill：勾选与摘要', () => {
  it('勾选追加到末尾，取消只移除自己，重复取消无副作用', () => {
    expect(togglePresetSkill([], 'owner-brief')).toEqual(['owner-brief'])
    expect(togglePresetSkill(['owner-brief'], 'data-check')).toEqual(['owner-brief', 'data-check'])
    expect(togglePresetSkill(['owner-brief', 'data-check'], 'owner-brief')).toEqual(['data-check'])
    expect(togglePresetSkill(['data-check'], 'missing')).toEqual(['data-check', 'missing'])
  })
  it('提交前过滤已下线的 id，保留原有顺序', () => {
    expect(knownPresetSkillIds(['data-check', 'gone', 'owner-brief'], options)).toEqual(['data-check', 'owner-brief'])
    expect(knownPresetSkillIds([], options)).toEqual([])
  })
  it('只读摘要用名称、不留内部 id；未选说「未启用」', () => {
    expect(presetSkillSummary([], options)).toBe('未启用')
    expect(presetSkillSummary(['data-check', 'owner-brief'], options)).toBe('给主人的简报、数据核对清单')
    // 旧记录里可能有已下线的 id：不把内部 id 露给主人。
    expect(presetSkillSummary(['gone'], options)).toBe('未启用')
    expect(presetSkillNames(['gone', 'owner-brief'], options)).toEqual(['给主人的简报'])
  })
  it('按三档加载条件分组，组标题是中文，组内保持清单顺序', () => {
    const groups = groupPresetSkillOptions(options)
    expect(groups.map(group => group.condition)).toEqual(['every_wake', 'project_work', 'task_type'])
    expect(groups.map(group => group.label)).toEqual(['每次唤醒', '仅项目工作', '特定任务类型'])
    expect(groups[2]!.items.map(item => item.id)).toEqual(['incident-triage', 'data-check'])
  })
})

describe('样例门面：档案里保存预置 skill', () => {
  it('保存后重新读取能看到勾选，重复 id 合并，其他队友不受影响', async () => {
    const hub = new FixtureHub()
    const beforeOther = (await hub.bot('bot-zongguan')).profile.presetSkillIds
    const result = await hub.command('updateBot', {
      botId: 'bot-xunjian', patch: { presetSkillIds: ['data-check', 'data-check', 'owner-brief'] },
    })
    expect(result.ok).toBe(true)
    expect((await hub.bot('bot-xunjian')).profile.presetSkillIds).toEqual(['data-check', 'owner-brief'])
    expect((await hub.bot('bot-zongguan')).profile.presetSkillIds).toEqual(beforeOther)
  })
  it('取消全部勾选保存空数组，即回到未启用', async () => {
    const hub = new FixtureHub()
    expect((await hub.command('updateBot', { botId: 'bot-xunjian', patch: { presetSkillIds: [] } })).ok).toBe(true)
    expect((await hub.bot('bot-xunjian')).profile.presetSkillIds).toEqual([])
  })
  it('未知 id 与非法形状都拒绝，并给中文原因', async () => {
    const hub = new FixtureHub()
    const unknown = await hub.command('updateBot', { botId: 'bot-xunjian', patch: { presetSkillIds: ['gone'] } })
    expect(unknown.ok).toBe(false)
    expect(unknown.ok ? '' : unknown.error).toContain('没有「gone」')
    const bad = await hub.command('updateBot', { botId: 'bot-xunjian', patch: { presetSkillIds: 'owner-brief' } })
    expect(bad.ok).toBe(false)
    expect(bad.ok ? '' : bad.error).toContain('id 列表')
    // 拒绝后原有勾选保持不变。
    expect((await hub.bot('bot-xunjian')).profile.presetSkillIds).toEqual(['owner-brief', 'incident-triage'])
  })
  it('候选清单只给名称、用途与条件，不带正文', () => {
    const view = fixtureSettings.presetSkillOptions[0]!
    expect(Object.keys(view).sort()).toEqual(['condition', 'conditionLabel', 'id', 'name', 'purpose'])
  })
})

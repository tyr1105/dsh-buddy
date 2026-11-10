/**
 * 岗位技能选择的界面逻辑与样例门面测试：
 * 勾选切换、搜索、DSH 技能的显示顺序、只读摘要不泄露内部 id，
 * 以及 FixtureHub 在沙箱里真的保存档案勾选（浏览器走查靠它）。
 */
import { describe, expect, it } from 'vitest'
import {
  knownPresetSkillIds, matchesSkillQuery, orderDshSkills, selectedSkillNames, skillSummary, toggleSkill,
} from '../src/client/logic/preset-skills.js'
import { fixtureSettings } from '../src/shared/fixtures.js'
import { FixtureHub } from '../src/host/hub-facade.js'

const options = fixtureSettings.presetSkillOptions

describe('技能：勾选与摘要', () => {
  it('勾选追加到末尾，取消只移除自己，重复取消无副作用', () => {
    expect(toggleSkill([], 'owner-brief')).toEqual(['owner-brief'])
    expect(toggleSkill(['owner-brief'], 'data-check')).toEqual(['owner-brief', 'data-check'])
    expect(toggleSkill(['owner-brief', 'data-check'], 'owner-brief')).toEqual(['data-check'])
    expect(toggleSkill(['data-check'], 'missing')).toEqual(['data-check', 'missing'])
  })
  it('提交前过滤已下线的 id，保留原有顺序', () => {
    expect(knownPresetSkillIds(['data-check', 'gone', 'owner-brief'], options)).toEqual(['data-check', 'owner-brief'])
    expect(knownPresetSkillIds([], options)).toEqual([])
  })
  it('只读摘要：自带技能用中文名，DSH 技能用它自己的名字；都没选说「未选择」', () => {
    expect(skillSummary([], [], options)).toBe('未选择')
    expect(skillSummary(['data-check', 'owner-brief'], [], options)).toBe('给主人的简报、数据核对清单')
    expect(skillSummary(['data-check'], ['office-xlsx'], options)).toBe('数据核对清单、office-xlsx')
    // 旧记录里可能有已下线的自带技能：不把内部 id 露给主人。
    expect(skillSummary(['gone'], [], options)).toBe('未选择')
    expect(selectedSkillNames(['gone', 'owner-brief'], [], options)).toEqual(['给主人的简报'])
  })
})

describe('技能：搜索和显示顺序', () => {
  it('搜索不区分大小写，名字和用途都搜，空关键词不过滤', () => {
    expect(matchesSkillQuery('EXCEL', 'office-xlsx', 'Read Excel workbooks')).toBe(true)
    expect(matchesSkillQuery('简报', '给主人的简报', '')).toBe(true)
    expect(matchesSkillQuery('  ', 'x', 'y')).toBe(true)
    expect(matchesSkillQuery('word', 'office-xlsx', 'Read Excel workbooks')).toBe(false)
  })
  const dsh = [{ name: 'a-skill', description: 'A' }, { name: 'b-skill', description: 'B' }, { name: 'c-skill', description: 'C' }]
  it('已选的排最前，其余保持原顺序', () => {
    expect(orderDshSkills(dsh, ['c-skill']).map(row => row.name)).toEqual(['c-skill', 'a-skill', 'b-skill'])
  })
  it('已选但 DSH 里已经没有的技能也要显示，否则主人取消不掉', () => {
    const ordered = orderDshSkills(dsh, ['gone-skill'])
    expect(ordered[0]).toEqual({ name: 'gone-skill', description: '这个技能已经不在 DSH 里了' })
    expect(ordered).toHaveLength(4)
  })
  it('反例：没选时顺序不变', () => expect(orderDshSkills(dsh, []).map(row => row.name)).toEqual(['a-skill', 'b-skill', 'c-skill']))
})

describe('样例门面：档案里保存技能', () => {
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
  it('候选清单只给名称和用途，不带正文', () => {
    const view = fixtureSettings.presetSkillOptions[0]!
    expect(Object.keys(view).sort()).toEqual(['id', 'name', 'purpose'])
  })
  it('样例数据里有 DSH 技能，走查时能看到这一组', () => {
    expect(fixtureSettings.dshSkillOptions.map(row => row.name)).toContain('office-xlsx')
  })
})

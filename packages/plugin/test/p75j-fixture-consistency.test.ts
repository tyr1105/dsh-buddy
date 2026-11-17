/**
 * P75j 一致性测试（第一块的教训）：样例技能库必须由 core 的视图生成，并与设计稿场景 C、H 的数据一致。
 * 手写的样例与真实数据的约定不一致时，预览和测试都发现不了，所以这里补上这一层：
 * 1. 样例视图由 core 的界面接口生成（core 生成视图时已用自己的 schema 校验过一遍，格式不对会直接抛错）；
 * 2. 「表单页做法」的四句逐字等于设计稿 C；三版、两版、一版、学习写出的、不常用三种原因、岗位技能两条都在；
 * 3. 刻度八道，长短与颜色对得上出处，11月24日 一道是整理合并且是新刻的；
 * 4. fixture-skill.ts 的源码里没有手写的视图字段；
 * 5. 预览快照（fixture-skill-preview.ts）与实时生成的视图逐字相同。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  SAMPLE_SKILL_IDS, createSkillSample, sampleSkillDetail, sampleSkillLibrary,
} from '../src/shared/fixture-skill.js'
import { previewEmptySkillLibrary, previewSkillDetails, previewSkillLibrary } from '../src/shared/fixture-skill-preview.js'

const sample = createSkillSample()
const library = sampleSkillLibrary(sample)
const group = (key: 'self' | 'role' | 'collapsed') => library.groups.find(row => row.key === key)!

// 设计稿 C「表单页做法」正文的四句（逐字）。
const DESIGN_FORM_SENTENCES = [
  '提交后显示明确的成功提示，名单写入前先校验必填项。',
  '页面上的提示和按钮文字，与约定逐字一致；交回前逐字比对一次。',
  '自测数据要覆盖选填项填写和不填两种情况。',
  '日期和时间段的选择框，默认值不能落在已过去的时间。',
]

describe('样例视图由 core 生成并与设计稿一致', () => {
  it('表单页做法的句子与设计稿 C 逐字相同，出处逐句写明；历史版本三条，当前版没有回退，其余有', () => {
    const detail = sampleSkillDetail(SAMPLE_SKILL_IDS.form, sample)
    expect(detail.sentences.map(row => row.text)).toEqual(DESIGN_FORM_SENTENCES)
    expect(detail.sentences.map(row => row.sourceText)).toEqual([
      '第 1 版　来自评审意见：「数据核对」任务第 1 轮',
      '第 2 版　来自评审意见：活动报名页第 1 轮退回第 3 条',
      '第 2 版　来自你的纠正：活动报名页验收第 4 条',
      '第 3 版　来自你的纠正：会议室预约页验收第 2 条',
    ])
    expect(detail.headText).toBe('第 3 版　11月20日 17:12')
    expect(detail.versions.map(row => [row.no, row.current, row.canRollback])).toEqual([[3, true, false], [2, false, true], [1, false, true]])
    expect(detail.versions[0]!.text).toBe('11月20日　新增 1 句。评审员核对通过。')
  })

  it('同类任务对比：表头五列、两行、结论与设计稿 C 一致；没有同类任务的技能没有对比', () => {
    const compare = sampleSkillDetail(SAMPLE_SKILL_IDS.form, sample).compare!
    expect(compare.title).toBe('同类任务：表单页')
    expect(compare.headers).toEqual(['第几次', '哪件事', '核对轮数', '验收返工', '回合'])
    expect(compare.rows).toEqual([
      { seqText: '第 1 次', title: '活动报名页', rounds: 2, reworks: 1, turns: 14 },
      { seqText: '第 2 次', title: '会议室预约页', rounds: 1, reworks: 1, turns: 9 },
    ])
    expect(compare.note).toBe('第 2 次核对一次通过；验收仍返工 1 次，原因已记入第 3 版。')
    expect(sampleSkillDetail(SAMPLE_SKILL_IDS.roster, sample).compare).toBeNull()
  })

  it('三组：自己积累四条（三版、两版、一版、学习写出的），岗位技能两条，不常用三条（久未使用、来源不明、已并入）', () => {
    expect(library.title).toBe('技能库')
    // P75r7（A4）：有不常用的技能时，顶部写成「在用 n 条，不常用 m 条」，与下面三组的合计对得上。
    expect(library.countText).toBe('在用 6 条，不常用 3 条')
    expect(library.lastTidyText).toBe('上次整理：11月24日')
    expect(group('self').note).toBe('4 条，林舟自己维护')
    const byTitle = Object.fromEntries(group('self').items.map(row => [row.title, row]))
    expect(byTitle['表单页做法']!.versionText).toBe('第 3 版')
    expect(byTitle['表单页做法']!.sourceText).toBe('来自 3 件事　评审意见 2、你的纠正 2')
    expect(byTitle['名单导出']!.versionText).toBe('第 2 版')
    expect(byTitle['手机端适配']!.versionText).toBe('第 1 版')
    expect(byTitle['手机端适配']!.supplementsText).toBe('补充自「动手前后自查」')
    // 学习写出的技能：出处是会话，详情里每句的出处写着会话名。
    expect(sampleSkillDetail(SAMPLE_SKILL_IDS.minutes, sample).sentences[0]!.sourceText).toBe('第 1 版　来自你的指示：会话『周会记录整理』')
    // 本周更新的小标只出现在 11月24日 整理合并过的那一条上。
    expect(group('self').items.filter(row => row.badge === '本周更新').map(row => row.title)).toEqual(['会议纪要格式'])
    expect(group('role').roleItems).toEqual([
      { title: '动手前后自查', note: '工程师岗位自带' }, { title: '异常排查四步', note: '通用，入职时选定' },
    ])
    expect(group('role').items).toEqual([])
    expect(group('collapsed').items.map(row => row.title).sort()).toEqual(['交付前检查', '周报排版', '纪要模板'])
    const states = Object.fromEntries(Object.entries(SAMPLE_SKILL_IDS).map(([key, id]) => [key, sampleSkillDetail(id, sample)]))
    expect(states.report!.stateText).toMatch(/^\d+ 天内没有用到，移到「不常用」。$/)
    expect(states.legacy!.stateText).toBe('来源不明，已收起。')
    expect(states.template!.stateText).toBe('已并入「会议纪要格式」。')
    expect([states.report!.canRestore, states.legacy!.canRestore, states.template!.canRestore, states.form!.canRestore]).toEqual([true, true, true, false])
  })

  it('刻度：八道；长短按出处（评审意见短、验收结果中、你的纠正长），整理合并为主色且是新刻的一道', () => {
    const { ticks } = library
    expect(ticks.headText).toBe('刻度　8 道　入职 45 天')
    expect(ticks.ticks).toHaveLength(8)
    expect(ticks.ticks.map(row => row.length)).toEqual(['short', 'mid', 'long', 'long', 'short', 'long', 'long', 'main'])
    expect(ticks.ticks.filter(row => row.fresh)).toHaveLength(1)
    expect(ticks.ticks.at(-1)).toMatchObject({ length: 'main', fresh: true })
    expect(ticks.lastText).toBe('最近一道：11月24日 每周整理，合并 1 条')
    expect(ticks.legend).toBe('短：评审意见　中：验收结果　长：你的纠正　主色：整理合并')
  })

  it('空状态：没有任何自己积累的技能时，自己积累一组没有条目', () => {
    const empty = sampleSkillLibrary(createSkillSample('探路', { empty: true }))
    expect(empty.groups.find(row => row.key === 'self')!.items).toEqual([])
    expect(empty.ticks.ticks).toEqual([])
  })
})

describe('回退与放回在样例环境里走 core 的命令', () => {
  it('回退到第 2 版：当前版本变成第 2 版，第 3 版仍保留并可以再回到它', async () => {
    const own = createSkillSample()
    expect((await own.api.rollbackSkill({ skillId: SAMPLE_SKILL_IDS.form, versionNo: 2 })).ok).toBe(true)
    const detail = sampleSkillDetail(SAMPLE_SKILL_IDS.form, own)
    expect(detail.versions.map(row => [row.no, row.current])).toEqual([[3, false], [2, true], [1, false]])
    expect(detail.sentences).toHaveLength(3)
    expect((await own.api.rollbackSkill({ skillId: SAMPLE_SKILL_IDS.form, versionNo: 3 })).ok).toBe(true)
    expect(sampleSkillDetail(SAMPLE_SKILL_IDS.form, own).versions[0]!.current).toBe(true)
  })

  it('放回一条不常用的技能：移回自己积累', async () => {
    const own = createSkillSample()
    expect((await own.api.restoreSkill({ skillId: SAMPLE_SKILL_IDS.report })).ok).toBe(true)
    const next = sampleSkillLibrary(own)
    expect(next.groups.find(row => row.key === 'self')!.items.map(row => row.title)).toContain('周报排版')
    expect(next.groups.find(row => row.key === 'collapsed')!.items.map(row => row.title)).not.toContain('周报排版')
  })
})

describe('源码纪律与预览快照', () => {
  it('fixture-skill.ts 的源码里没有手写的视图字段，视图经 core 的界面接口生成', () => {
    const source = readFileSync(fileURLToPath(new URL('../src/shared/fixture-skill.ts', import.meta.url)), 'utf8')
    // 这些字段只能由 core 的视图函数生成。
    for (const forbidden of ['versionText', 'countText', 'sourceText', 'supplementsText', 'headText', 'bodyTitle', 'stateText', 'lastText', 'lastTidyText', 'canRollback', 'canRestore', 'legend']) {
      expect(source, `不应手写：${forbidden}`).not.toContain(forbidden)
    }
    expect(source).toContain('createUiApi(')
    expect(source).toContain('.skillLibrary(')
    expect(source).toContain('.skillDetail(')
  })

  it('预览快照与实时生成的视图逐字相同（预览不会悄悄用旧口径）', () => {
    expect(JSON.stringify(previewSkillLibrary)).toBe(JSON.stringify(library))
    expect(JSON.stringify(previewEmptySkillLibrary)).toBe(JSON.stringify(sampleSkillLibrary(createSkillSample('探路', { empty: true }))))
    for (const [key, id] of Object.entries(SAMPLE_SKILL_IDS)) {
      expect(JSON.stringify(previewSkillDetails[key as keyof typeof previewSkillDetails]), `详情 ${key}`).toBe(JSON.stringify(sampleSkillDetail(id, sample)))
    }
  })
})

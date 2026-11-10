/**
 * 队友配置表单的纯逻辑测试（P55 精简后）。
 *
 * 主人把配置收成八项，这里钉住：校验顺序、入参拼装、节奏合并后的换算、
 * 编辑时只提交改过的字段、草稿读写，以及和 core 的选项保持一致。
 */
import { describe, expect, it } from 'vitest'
import {
  BRIEF_MAX, MBTI_OPTIONS, RHYTHM_OPTIONS, ROLE_CARDS, SPEECH_STYLE_OPTIONS, TEMPERAMENT_OPTIONS,
  buildCreateBotInput, buildProfilePatch, choiceLabel, clearDraft, configProblem, draftFromProfile, emptyDraft, loadDraft,
  problemField, rhythmAllowed, rhythmOf, saveDraft, validateMbti, validateName, type BotConfigDraft,
} from '../src/client/logic/wizard.js'

const base: BotConfigDraft = { ...emptyDraft(), name: '巡检员', role: 'sentinel' }
const DRAFT_KEY = 'dsh-buddy:wizard-draft:v2'

/** 内存版 localStorage（node 环境没有真的 localStorage）。 */
function memoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v) },
    removeItem: (k: string) => { map.delete(k) },
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() { return map.size },
  } as Storage
}

describe('表单校验', () => {
  it('空名字报错', () => expect(validateName('', [])).toContain('不能为空'))
  it('超过 20 字报错', () => expect(validateName('一'.repeat(21), [])).toContain('20 字'))
  it('正好 20 字通过', () => expect(validateName('一'.repeat(20), [])).toBeNull())
  it('重名实时提示', () => expect(validateName('探路', ['巡检员', '探路'])).toContain('已经有叫「探路」'))
  it('不重名通过', () => expect(validateName('观澜', ['探路'])).toBeNull())

  it('按从上到下的顺序报第一个问题：先名字，再执行风格', () => {
    expect(configProblem(emptyDraft(), [])).toContain('名字')
    expect(configProblem({ ...emptyDraft(), name: '探路' }, [])).toContain('执行风格')
    expect(configProblem(base, [])).toBeNull()
  })

  it('员工说明正好到上限通过，超过报错', () => {
    expect(configProblem({ ...base, brief: '说'.repeat(BRIEF_MAX) }, [])).toBeNull()
    expect(configProblem({ ...base, brief: '说'.repeat(BRIEF_MAX + 1) }, [])).toContain('员工说明')
  })

  it('错误文案能对应到字段，错误才显示得到正确的位置', () => {
    expect(problemField('名字：不能为空')).toBe('name')
    expect(problemField('执行风格：选一张卡片')).toBe('role')
    expect(problemField('员工说明：不能超过 1000 字')).toBe('brief')
    expect(problemField('MBTI：请从列表里选一个类型')).toBeNull()
    expect(problemField(null)).toBeNull()
  })

  it('性格、说话风格、技能都可以不选', () => expect(configProblem(base, [])).toBeNull())
})

describe('执行风格和自主节奏', () => {
  it('五种执行风格，新增的建议在最后', () => {
    expect(ROLE_CARDS.map(card => card.label)).toEqual(['总管', '调研', '执行', '盯守', '建议'])
  })

  it('四档节奏对应到等级和节奏：听吩咐是硬规则，其他三档不是', () => {
    expect(RHYTHM_OPTIONS.map(option => [option.value, option.autonomy, option.pace, option.onDemand])).toEqual([
      ['on_demand', 'L1', 'quiet', true],
      ['advise', 'L1', 'normal', false],
      ['act', 'L2', 'normal', false],
      ['drive', 'L2', 'active', false],
    ])
  })

  it('建议风格只能选不动手的两档', () => {
    expect(rhythmAllowed('advisor', 'on_demand')).toBe(true)
    expect(rhythmAllowed('advisor', 'advise')).toBe(true)
    expect(rhythmAllowed('advisor', 'act')).toBe(false)
    expect(rhythmAllowed('advisor', 'drive')).toBe(false)
    expect(rhythmAllowed('executor', 'drive')).toBe(true)
    expect(rhythmAllowed('', 'act')).toBe(true)
  })

  it('从档案反推选中哪一档；老队友的组合取最接近的', () => {
    expect(rhythmOf({ autonomy: 'L1', pace: 'quiet', onDemand: true })).toBe('on_demand')
    expect(rhythmOf({ autonomy: 'L1', pace: 'normal', onDemand: false })).toBe('advise')
    expect(rhythmOf({ autonomy: 'L0', pace: 'quiet', onDemand: false })).toBe('advise')
    expect(rhythmOf({ autonomy: 'L2', pace: 'normal', onDemand: false })).toBe('act')
    expect(rhythmOf({ autonomy: 'L2', pace: 'active', onDemand: false })).toBe('drive')
    expect(rhythmOf({ autonomy: 'L3', pace: 'normal', onDemand: false })).toBe('drive')
  })

  it('选项标签查得到，查不到时用兜底文字，不显示内部 id', () => {
    expect(choiceLabel(TEMPERAMENT_OPTIONS, 'calm', '未选择')).toBe('冷静寡言')
    expect(choiceLabel(SPEECH_STYLE_OPTIONS, null, '未选择')).toBe('未选择')
  })
})

describe('createBot 入参', () => {
  it('八项都提交；persona 和志向交给 core 生成', () => {
    const input = buildCreateBotInput({
      ...base, temperament: 'rigorous', speechStyle: 'conclusion_first', mbti: 'ISFJ', rhythm: 'on_demand',
      brief: '  每天看日志  ', presetSkillIds: ['owner-brief'], dshSkillNames: ['office-xlsx'],
    })
    expect(input).toEqual({
      name: '巡检员', role: 'sentinel', temperament: 'rigorous', speechStyle: 'conclusion_first', mbti: 'ISFJ',
      autonomy: 'L1', pace: 'quiet', onDemand: true, brief: '每天看日志', model: null,
      presetSkillIds: ['owner-brief'], dshSkillNames: ['office-xlsx'],
    })
    expect('persona' in input).toBe(false)
    expect('aspirations' in input).toBe(false)
  })

  it('没选的项提交 null，没选技能时不带技能字段', () => {
    const input = buildCreateBotInput(base)
    expect(input.temperament).toBeNull()
    expect(input.speechStyle).toBeNull()
    expect(input.mbti).toBeNull()
    expect('presetSkillIds' in input).toBe(false)
    expect('dshSkillNames' in input).toBe(false)
  })

  it('「跟随 DSH 默认」显式提交 model:null，选了模型提交对象', () => {
    expect(buildCreateBotInput({ ...base, model: '' }).model).toBe(null)
    expect(buildCreateBotInput({ ...base, model: 'null' }).model).toBe(null)
    expect('model' in buildCreateBotInput({ ...base, model: '' })).toBe(true)
    expect(buildCreateBotInput({ ...base, model: '{"provider":"zai-coding-cn","model":"glm-4.7"}' }).model)
      .toEqual({ provider: 'zai-coding-cn', model: 'glm-4.7' })
  })

  it('MBTI：未设置提交 null，选了类型提交类型码', () => {
    expect(buildCreateBotInput({ ...base, mbti: '' }).mbti).toBeNull()
    expect(buildCreateBotInput({ ...base, mbti: 'ISTJ' }).mbti).toBe('ISTJ')
  })
})

describe('编辑档案：只提交改过的字段', () => {
  const profile = {
    persona: '性格：冷静寡言。', mbti: 'ISFJ' as const, autonomy: 'L3' as const, pace: 'normal' as const, onDemand: false,
    temperament: 'calm' as const, speechStyle: 'brief' as const, brief: '原来的说明',
    model: { provider: 'p', model: 'm' }, presetSkillIds: ['owner-brief'], dshSkillNames: ['office-xlsx'],
  }
  const card = { name: '巡检员', role: 'sentinel' as const }
  const initial = draftFromProfile(card, profile)

  it('什么都没改时补丁是空的', () => expect(buildProfilePatch(initial, initial)).toEqual({}))

  it('反例：没动节奏时不提交等级，老队友的 L3 不会被悄悄改掉', () => {
    const patch = buildProfilePatch({ ...initial, brief: '新说明' }, initial)
    expect(patch).toEqual({ brief: '新说明' })
  })

  it('改了节奏时三个字段一起提交', () => {
    expect(buildProfilePatch({ ...initial, rhythm: 'on_demand' }, initial)).toEqual({ autonomy: 'L1', pace: 'quiet', onDemand: true })
  })

  it('只有模型变了才提交模型；已下架的旧模型不会挡住别的修改', () => {
    expect('model' in buildProfilePatch({ ...initial, name: '改名了' }, initial)).toBe(false)
    expect(buildProfilePatch({ ...initial, model: '' }, initial)).toEqual({ model: null })
  })

  it('取消选择提交 null；改选择题时带上员工说明', () => {
    expect(buildProfilePatch({ ...initial, temperament: '' }, initial)).toEqual({ temperament: null, brief: '原来的说明' })
  })

  it('技能列表变了才提交', () => {
    expect(buildProfilePatch({ ...initial, dshSkillNames: [] }, initial)).toEqual({ dshSkillNames: [] })
    expect(buildProfilePatch({ ...initial, presetSkillIds: ['owner-brief', 'data-check'] }, initial)).toEqual({ presetSkillIds: ['owner-brief', 'data-check'] })
  })

  it('老队友的性格长文字先放进员工说明，改选择题时不会丢', () => {
    const legacy = { ...profile, persona: '我一直是这样说话的', temperament: null, speechStyle: null, brief: '' }
    const form = draftFromProfile(card, legacy)
    expect(form.brief).toBe('我一直是这样说话的')
    // 什么都不改：persona 原样保留，也不会多存一份员工说明。
    expect(buildProfilePatch(form, form)).toEqual({})
    // 选了性格：persona 会被重算，这时要把原文存进员工说明。
    expect(buildProfilePatch({ ...form, temperament: 'gentle' }, form)).toEqual({ temperament: 'gentle', brief: '我一直是这样说话的' })
  })

  it('反例：已经用选择题的队友，员工说明不会被 persona 填充', () => {
    expect(draftFromProfile(card, { ...profile, brief: '' }).brief).toBe('')
  })
})

describe('草稿持久化', () => {
  it('保存后能读回；清掉后读不到', () => {
    const store = memoryStorage()
    saveDraft({ ...base, brief: '写到一半' }, store)
    expect(loadDraft(store)?.brief).toBe('写到一半')
    clearDraft(store)
    expect(loadDraft(store)).toBeNull()
  })
  it('坏草稿读回 null（不把表单卡死）', () => {
    const store = memoryStorage()
    store.setItem(DRAFT_KEY, '{oops')
    expect(loadDraft(store)).toBeNull()
  })
  it('storage 为 null（隐私模式）也不抛错', () => {
    expect(() => saveDraft(base, null)).not.toThrow()
    expect(loadDraft(null)).toBeNull()
    expect(() => clearDraft(null)).not.toThrow()
  })
  it('技能字段的脏数据被过滤', () => {
    const store = memoryStorage()
    store.setItem(DRAFT_KEY, JSON.stringify({ ...base, presetSkillIds: ['owner-brief', 1, null, 'data-check'], dshSkillNames: 'not-a-list' }))
    expect(loadDraft(store)?.presetSkillIds).toEqual(['owner-brief', 'data-check'])
    expect(loadDraft(store)?.dshSkillNames).toEqual([])
  })
  it('缺字段的草稿按默认值补齐，坏 MBTI 读回未设置', () => {
    const store = memoryStorage()
    store.setItem(DRAFT_KEY, JSON.stringify({ name: '小王', mbti: 'ZZZZ' }))
    expect(loadDraft(store)).toMatchObject({ name: '小王', mbti: '', rhythm: 'advise', brief: '' })
  })
  it('六步向导的旧草稿不再读取，也不会把表单卡死', () => {
    const store = memoryStorage()
    store.setItem('dsh-buddy:wizard-draft:v1', JSON.stringify({ step: 3, name: '旧的', aspirations: ['a'] }))
    expect(loadDraft(store)).toBeNull()
  })
})

describe('MBTI 选项', () => {
  it('正好 16 型、取值不重复、每型都有一句人话解释', () => {
    expect(MBTI_OPTIONS).toHaveLength(16)
    expect(new Set(MBTI_OPTIONS.map(o => o.value)).size).toBe(16)
    for (const option of MBTI_OPTIONS) {
      expect(option.label.startsWith(option.value)).toBe(true)
      expect([...option.desc].length).toBeGreaterThan(6)
    }
  })

  it('四个维度各自都有分布在选项里（E/I、S/N、T/F、J/P）', () => {
    expect([...new Set(MBTI_OPTIONS.map(o => o.value[0]))].sort()).toEqual(['E', 'I'])
    expect([...new Set(MBTI_OPTIONS.map(o => o.value[1]))].sort()).toEqual(['N', 'S'])
    expect([...new Set(MBTI_OPTIONS.map(o => o.value[2]))].sort()).toEqual(['F', 'T'])
    expect([...new Set(MBTI_OPTIONS.map(o => o.value[3]))].sort()).toEqual(['J', 'P'])
  })

  it('未设置通过；合法 16 型通过；非法值报错', () => {
    expect(validateMbti('')).toBeNull()
    expect(validateMbti('INTJ')).toBeNull()
    expect(validateMbti('XXXX')).toContain('MBTI')
    expect(configProblem({ ...base, mbti: 'ABCD' as unknown as '' }, [])).toContain('MBTI')
  })
})

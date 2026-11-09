/**
 * 新建向导纯逻辑测试（任务卡「测试」一节：向导每步校验、复述文案生成）。
 */
import { describe, expect, it } from 'vitest'
import {
  ASPIRATION_EXAMPLES, PERSONA_EXAMPLES, PRESET_COLORS, ROLE_CARDS,
  buildCreateBotInput, emptyDraft, loadDraft, parseAspirations, saveDraft, clearDraft,
  stepError, validateAspirations, validateName, validatePersona, validateWatchTarget, wizardSummary,
} from '../src/client/logic/wizard.js'

const base = { ...emptyDraft(), name: '巡检员', role: 'sentinel' as const }

describe('向导：名字与重名（第 1 步）', () => {
  it('空名字报错', () => expect(validateName('', [])).toContain('不能为空'))
  it('超过 20 字报错', () => expect(validateName('一'.repeat(21), [])).toContain('20 字'))
  it('正好 20 字通过', () => expect(validateName('一'.repeat(20), [])).toBeNull())
  it('重名实时提示', () => expect(validateName('探路', ['巡检员', '探路'])).toContain('已经有叫「探路」'))
  it('不重名通过', () => expect(validateName('观澜', ['探路'])).toBeNull())
  it('没选角色时第 1 步不能下一步', () => expect(stepError({ ...base, role: '' }, [])).toContain('角色'))
})

describe('向导：性格与志向（第 2、3 步）', () => {
  it('性格 300 字以内通过、超过报错', () => {
    expect(validatePersona('稳')).toBeNull()
    expect(validatePersona('一'.repeat(301))).toContain('300 字')
  })
  it('多行志向解析成非空列表', () => {
    expect(parseAspirations('甲\n\n 乙 \n丙')).toEqual(['甲', '乙', '丙'])
  })
  it('志向 0 条报错、4 条报错、1–3 条通过', () => {
    expect(validateAspirations([])).toContain('至少')
    expect(validateAspirations(['a', 'b', 'c', 'd'])).toContain('最多 3 条')
    expect(validateAspirations(['a'])).toBeNull()
    expect(validateAspirations(['a', 'b', 'c'])).toBeNull()
  })
  it('第 3 步全是空行时按 0 条报错', () => {
    expect(stepError({ ...base, step: 2, aspirations: ['', '  '] }, [])).toContain('志向')
  })
  it('四种角色各有 2 条性格示例与志向示例；8 个预设色板', () => {
    for (const card of ROLE_CARDS) {
      expect(PERSONA_EXAMPLES[card.role]).toHaveLength(2)
      expect(ASPIRATION_EXAMPLES[card.role].length).toBeGreaterThan(0)
    }
    expect(PRESET_COLORS).toHaveLength(8)
  })
})

describe('向导：起步关注（第 5 步）', () => {
  it('网页/RSS 校验 URL：坏的报错、https 通过', () => {
    expect(validateWatchTarget('http', 'not-a-url')).toContain('网址')
    expect(validateWatchTarget('rss', 'ftp://x/y')).toContain('网址')
    expect(validateWatchTarget('http', 'https://example.com/feed')).toBeNull()
  })
  it('文件/日志要 / 或 ~ 开头的完整路径', () => {
    expect(validateWatchTarget('file', 'data/x.csv')).toContain('路径')
    expect(validateWatchTarget('log', '~/logs/a.log')).toBeNull()
    expect(validateWatchTarget('log', '/var/log/system.log')).toBeNull()
  })
  it('目标为空一律报错', () => {
    expect(validateWatchTarget('script', '  ')).toContain('不能为空')
  })
  it('跳过起步关注时第 5 步无错', () => {
    expect(stepError({ ...base, step: 4, watch: null }, [])).toBeNull()
  })
})

describe('向导：复述与 createBot 入参（第 6 步）', () => {
  it('复述文案按「我是 {名字}，{角色}。我的志向是…。我会先盯着…」拼装', () => {
    const draft = {
      ...base,
      aspirations: ['自动线按时跑完', '异常第一时间知道'],
      watch: { kind: 'log' as const, target: '/var/log/line.log', note: '' },
    }
    const text = wizardSummary(draft, '盯守')
    expect(text).toContain('我是巡检员，盯守。我的志向是自动线按时跑完；异常第一时间知道。我会先盯着/var/log/line.log，有事会在这里找你。')
  })
  it('没填起步关注时复述写「先熟悉家目录」', () => {
    expect(wizardSummary({ ...base, aspirations: ['一件事'] }, '盯守')).toContain('我会先熟悉自己的家目录')
  })
  it('createBot 入参：必填齐、性格为空给兜底、可选目标与关注按需出现', () => {
    const input = buildCreateBotInput({
      ...base, aspirations: ['志向一'], goal: { title: '周目标', doneWhen: '主人验收', period: 'week' },
      watch: { kind: 'http', target: 'https://example.com', note: '盯发布' }, model: '',
    })
    expect(input).toMatchObject({ name: '巡检员', role: 'sentinel', aspirations: ['志向一'] })
    expect(input.persona).toContain('巡检员')
    expect(input.goals).toEqual([{ aspirationIndex: 0, title: '周目标', doneWhen: '主人验收', period: 'week' }])
    expect(input.watches).toEqual([{ kind: 'http', target: 'https://example.com', why: '盯发布' }])
    // D07 第 8 条：「跟随 DSH 默认」现在显式提交 model:null（不再省略）。
    expect(input.model).toBe(null)
  })
  it('选了模型时入参带解析后的模型对象', () => {
    const input = buildCreateBotInput({ ...base, aspirations: ['a'], model: '{"provider":"deepseek-official","model":"deepseek-flash"}' })
    expect(input.model).toEqual({ provider: 'deepseek-official', model: 'deepseek-flash' })
  })
})

describe('向导：草稿持久化（读写 try/catch，测试注入内存版 storage）', () => {
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

  it('保存后能读回；清掉后读不到', () => {
    const store = memoryStorage()
    saveDraft({ ...base, step: 3 }, store)
    expect(loadDraft(store)?.step).toBe(3)
    clearDraft(store)
    expect(loadDraft(store)).toBeNull()
  })
  it('坏草稿读回 null（不把向导卡死）', () => {
    const store = memoryStorage()
    store.setItem('dsh-buddy:wizard-draft:v1', '{oops')
    expect(loadDraft(store)).toBeNull()
  })
  it('storage 为 null（隐私模式）也不抛错', () => {
    expect(() => saveDraft(base, null)).not.toThrow()
    expect(loadDraft(null)).toBeNull()
    expect(() => clearDraft(null)).not.toThrow()
  })
})

describe('D07 第 8 条：「跟随 DSH 默认」提交 model:null（不是省略）', () => {
  it("草稿停在跟随默认（model 为 '' 或 'null'）→ buildCreateBotInput 的 model 严格等于 null", () => {
    expect(buildCreateBotInput({ ...base, model: '' }).model).toBe(null)
    expect(buildCreateBotInput({ ...base, model: 'null' }).model).toBe(null)
    expect('model' in buildCreateBotInput({ ...base, model: '' })).toBe(true)
  })
  it('选了具体模型 → 提交 {provider, model}', () => {
    expect(buildCreateBotInput({ ...base, model: '{"provider":"zai-coding-cn","model":"glm-4.7"}' }).model)
      .toEqual({ provider: 'zai-coding-cn', model: 'glm-4.7' })
  })
})

describe('D04 3c-1：色板中文名（无障碍标签）', () => {
  it('每个预设颜色都有中文名', async () => {
    const { PRESET_COLORS, COLOR_NAMES } = await import('../src/client/logic/wizard.js')
    for (const color of PRESET_COLORS) expect(typeof COLOR_NAMES[color]).toBe('string')
  })
})

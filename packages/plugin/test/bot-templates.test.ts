/**
 * P52 模板库测试。
 *
 * 分三层，因为三层各自抓不同的问题：
 * 1. 模板数据的底线：名字、字数、禁用词、不用真人名字，改模板时第一时间报错；
 * 2. 选择规则与批量添加：已添加、总管、人数上限、重名、部分失败，用记录调用的假 hub；
 * 3. 用真实 core 把 15 个模板全建一遍：假 hub 发现不了字段不合法、技能 id 不存在这类问题，
 *    项目早期就吃过「替身抓不到真实行为」的亏，所以这一层必须走真实引擎。
 */
import { mkdtempSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { testing, type Hub } from '@agent-hub/core'
import { createEngineHub } from '../src/host/index.js'
import { RealHubFacade } from '../src/host/real-hub.js'
import {
  BOT_TEMPLATES, BOT_TEMPLATE_GROUPS, MAX_TEAM_SIZE, buildTemplateInput, defaultDetailTemplate, draftHasContent, freeTemplateName,
  hasLiveChief, isTemplateAdded, pickWholeGroup, templateBlock, templateById, templateDetailRows, templateDetailTitle, templateMeta,
  templateSkillNames, templatesInGroup, toggleTemplatePick, type BotTemplate,
} from '../src/client/logic/bot-templates.js'
import { addTeammatesFromTemplates, templateBatchError, templateBatchNotice, type WizardCreateHub } from '../src/client/logic/wizard-create.js'
import { splitPresetSkillOptions } from '../src/client/logic/preset-skills.js'
import { BRIEF_MAX, MBTI_OPTIONS, RHYTHM_OPTIONS, SPEECH_STYLE_OPTIONS, TEMPERAMENT_OPTIONS, emptyDraft, rhythmAllowed } from '../src/client/logic/wizard.js'
import type { CommandResult, PresetSkillOption } from '../src/shared/views.js'

/** 文案审计定下的禁用词，主人看得到的文字都不能出现。 */
const JARGON = ['产物', '交账', '唤醒', '上下文', '治理', '投影', '额度保护', '套路']
const template = (id: string): BotTemplate => templateById(id)!
/** 名册里的一位队友，只带选择规则用得到的字段。 */
const bot = (name: string, role: 'chief' | 'researcher' | 'executor' | 'sentinel' | 'advisor' = 'executor', lifecycle: 'active' | 'retired' | 'probation' = 'active') => ({ name, role, lifecycle })

describe('模板数据的底线', () => {
  it('一共 15 个，5 组都有模板，id 和名字都不重复', () => {
    expect(BOT_TEMPLATES).toHaveLength(15)
    for (const group of BOT_TEMPLATE_GROUPS) expect(templatesInGroup(group.id).length).toBeGreaterThan(0)
    expect(new Set(BOT_TEMPLATES.map(item => item.id)).size).toBe(15)
    expect(new Set(BOT_TEMPLATES.map(item => item.name)).size).toBe(15)
  })

  it('字段都在 core 的限制内：名字 20 字、员工说明不超上限、志向 1 到 3 条', () => {
    for (const item of BOT_TEMPLATES) {
      expect([...item.name].length, item.name).toBeLessThanOrEqual(20)
      expect([...item.brief].length, `${item.name} 的员工说明`).toBeLessThanOrEqual(BRIEF_MAX)
      expect(item.aspirations.length, item.name).toBeGreaterThanOrEqual(1)
      expect(item.aspirations.length, item.name).toBeLessThanOrEqual(3)
      expect(item.presetSkillIds.length, item.name).toBeLessThanOrEqual(8)
    }
  })

  it('性格、说话风格、MBTI、节奏都来自现有选项，头像色是合法颜色', () => {
    for (const item of BOT_TEMPLATES) {
      expect(TEMPERAMENT_OPTIONS.some(option => option.value === item.temperament), item.name).toBe(true)
      expect(SPEECH_STYLE_OPTIONS.some(option => option.value === item.speechStyle), item.name).toBe(true)
      expect(MBTI_OPTIONS.some(option => option.value === item.mbti), item.name).toBe(true)
      expect(RHYTHM_OPTIONS.some(option => option.value === item.rhythm), item.name).toBe(true)
      expect(item.color, item.name).toMatch(/^#[0-9a-f]{6}$/)
    }
  })

  it('总管最多一个，推荐的正好是一个做事、一个挑毛病', () => {
    expect(BOT_TEMPLATES.filter(item => item.role === 'chief').map(item => item.name)).toEqual(['项目经理'])
    expect(BOT_TEMPLATES.filter(item => item.recommended).map(item => item.name)).toEqual(['工程师', '评审员'])
  })

  it('不用真人名字', () => {
    expect(JSON.stringify(BOT_TEMPLATES)).not.toContain('易立竞')
  })

  it('主人看得到的文字不带内部黑话，卡片一句话不用分号', () => {
    for (const item of BOT_TEMPLATES) {
      for (const word of JARGON) {
        expect(item.tagline, item.name).not.toContain(word)
        expect(item.brief, item.name).not.toContain(word)
      }
      expect(item.tagline, item.name).not.toMatch(/[;；]/)
    }
  })

  it('节奏换算到位：听吩咐是硬规则，模板都不放权（等级都是 L1）', () => {
    for (const item of BOT_TEMPLATES) {
      const input = buildTemplateInput(item)
      const rhythm = RHYTHM_OPTIONS.find(option => option.value === item.rhythm)!
      expect(input.pace, item.name).toBe(rhythm.pace)
      expect(input.onDemand, item.name).toBe(rhythm.onDemand)
      expect(input.autonomy, item.name).toBe('L1')
      expect(input.brief, item.name).toBe(item.brief)
    }
    expect(buildTemplateInput(template('engineer')).onDemand).toBe(true)
    expect(buildTemplateInput(template('inspector')).onDemand).toBe(false)
  })

  it('外脑三位和评审员是建议风格，节奏都不会动手', () => {
    for (const item of templatesInGroup('advisor')) expect(item.role, item.name).toBe('advisor')
    expect(template('reviewer').role).toBe('advisor')
    for (const item of BOT_TEMPLATES) expect(rhythmAllowed(item.role, item.rhythm), item.name).toBe(true)
  })

  it('对外两位的员工说明写明红线，其余没有', () => {
    for (const item of BOT_TEMPLATES) {
      expect(item.brief.includes('红线：'), item.name).toBe(item.group === 'external')
    }
  })

  it('入参：L1、不传模型（跟随设置默认）、不传关注和目标', () => {
    const input = buildTemplateInput(template('inspector'))
    expect(input.autonomy).toBe('L1')
    expect('model' in input).toBe(false)
    expect('watches' in input).toBe(false)
    expect('goals' in input).toBe(false)
    expect(input.mbti).toBe('ISFJ')
    expect(buildTemplateInput(template('inspector'), '巡检员2').name).toBe('巡检员2')
  })
})

describe('名字占用', () => {
  it('没人用就用原名', () => expect(freeTemplateName('巡检员', ['工程师'])).toBe('巡检员'))
  it('被占用时从 2 开始加序号', () => expect(freeTemplateName('巡检员', ['巡检员'])).toBe('巡检员2'))
  it('序号也被占用时继续往后找', () => expect(freeTemplateName('巡检员', ['巡检员', '巡检员2', '巡检员3'])).toBe('巡检员4'))
})

describe('选择规则', () => {
  const engineer = template('engineer')
  const manager = template('project-manager')

  it('在岗同名算已添加', () => expect(templateBlock(engineer, [bot('工程师')], [])).toBe('added'))
  it('带序号的也算已添加，避免一直加出工程师3、工程师4', () => expect(isTemplateAdded(engineer, [bot('工程师2')])).toBe(true))
  it('反例：名字只是开头相同不算', () => expect(isTemplateAdded(engineer, [bot('工程师傅')])).toBe(false))
  it('反例：退役的同名队友不算已添加，还能再加', () => expect(templateBlock(engineer, [bot('工程师', 'executor', 'retired')], [])).toBeNull())

  it('已有在岗总管时项目经理不能选', () => expect(templateBlock(manager, [bot('老总管', 'chief')], [])).toBe('chief_taken'))
  it('反例：退役的总管不占名额', () => {
    expect(hasLiveChief([bot('老总管', 'chief', 'retired')])).toBe(false)
    expect(templateBlock(manager, [bot('老总管', 'chief', 'retired')], [])).toBeNull()
  })

  it('在岗人数加已选人数到上限后，其他卡片不能选', () => {
    const team = [bot('甲'), bot('乙'), bot('丙'), bot('丁')]
    expect(templateBlock(engineer, team, ['reviewer'])).toBeNull()
    expect(templateBlock(engineer, team, ['reviewer', 'acceptor'])).toBe('cap_reached')
  })
  it('已选中的不会被上限挡住，否则取消不掉', () => {
    const team = [bot('甲'), bot('乙'), bot('丙'), bot('丁'), bot('戊')]
    expect(templateBlock(engineer, team, ['engineer'])).toBeNull()
    expect(toggleTemplatePick(['engineer'], engineer, team)).toEqual([])
  })
  it('反例：不能选的卡片点了也不会被选中', () => {
    expect(toggleTemplatePick([], engineer, [bot('工程师')])).toEqual([])
  })
  it('点选保持点击顺序（第一位的对话会先打开）', () => {
    expect(toggleTemplatePick(['reviewer'], engineer, [])).toEqual(['reviewer', 'engineer'])
  })

  it('选上这一组：跳过已添加和总管冲突的，并在名额用完时停下', () => {
    expect(pickWholeGroup('growth', [], [])).toEqual(['seo-specialist', 'video-planner'])
    expect(pickWholeGroup('product', [], [bot('工程师'), bot('老总管', 'chief')])).toEqual(['product-manager', 'designer', 'reviewer', 'acceptor'])
    const team = [bot('甲'), bot('乙'), bot('丙'), bot('丁'), bot('戊')]
    expect(pickWholeGroup('growth', [], team)).toEqual(['seo-specialist'])
    expect(MAX_TEAM_SIZE).toBe(6)
  })

  it('草稿里填过东西才回到表单，空草稿先看模板库', () => {
    expect(draftHasContent(emptyDraft())).toBe(false)
    expect(draftHasContent({ ...emptyDraft(), name: '小王' })).toBe(true)
    expect(draftHasContent({ ...emptyDraft(), role: 'chief' })).toBe(true)
    expect(draftHasContent({ ...emptyDraft(), name: '   ' })).toBe(false)
  })
})

describe('详情面板', () => {
  const options: PresetSkillOption[] = [
    { id: 'external-voice', name: '对外口径', purpose: '', audience: 'role' },
    { id: 'owner-brief', name: '给主人的简报', purpose: '' },
  ]

  it('标题写清部门和对内对外', () => {
    expect(templateDetailTitle(template('spokesperson'))).toBe('发言人 · 对外')
    expect(templateDetailTitle(template('engineer'))).toBe('工程师 · 产品研发 · 对内')
  })
  it('切到有推荐的组先看推荐的，没有推荐就看第一个', () => {
    expect(defaultDetailTemplate('product').name).toBe('工程师')
    expect(defaultDetailTemplate('growth').name).toBe('SEO 专员')
  })
  it('卡片底部写执行风格、MBTI 和自主节奏', () => expect(templateMeta(template('engineer'))).toBe('执行 · ISTP · 听吩咐'))
  it('详情就是表单里的那几项：对外角色的红线在员工说明里，技能按模板顺序显示中文名', () => {
    const rows = templateDetailRows(template('spokesperson'), options)
    expect(rows.map(row => row.label)).toEqual(['执行风格', '性格', '说话风格', 'MBTI', '自主节奏', '岗位技能', '员工说明'])
    expect(rows.find(row => row.label === '员工说明')?.value).toContain('先经主人批准')
    expect(rows.find(row => row.label === '岗位技能')?.value).toBe('对外口径')
    expect(rows.find(row => row.label === '自主节奏')?.value).toBe('听吩咐：你点名或派活才动')
  })
  it('反例：技能清单没加载时不显示技能行', () => {
    const rows = templateDetailRows(template('engineer'), [])
    expect(rows.some(row => row.label === '岗位技能')).toBe(false)
    expect(templateSkillNames(template('engineer'), [])).toEqual([])
  })
  it('岗位专属技能和通用项分开，旧夹具没有分组字段时按通用项', () => {
    const split = splitPresetSkillOptions(options)
    expect(split.general.map(option => option.id)).toEqual(['owner-brief'])
    expect(split.role.map(option => option.id)).toEqual(['external-voice'])
  })
})

/** 记录调用的假 hub：按「命令名 + 队友名」安排失败，其余返回新 id。 */
function fakeHub(failures: Record<string, CommandResult | Error> = {}): WizardCreateHub & { calls: Array<{ name: string; arg: Record<string, unknown> }> } {
  const calls: Array<{ name: string; arg: Record<string, unknown> }> = []
  let serial = 0
  return {
    calls,
    command: async (name, input) => {
      calls.push({ name, arg: input })
      const failure = failures[`${name}:${String(input.name ?? '')}`] ?? failures[name]
      if (failure instanceof Error) throw failure
      if (failure) return failure
      serial += 1
      return { ok: true, data: { id: `b_${serial}` } }
    },
    refreshOverview: async () => undefined,
  }
}

describe('批量添加', () => {
  it('按选择顺序建，每位都存头像色', async () => {
    const hub = fakeHub()
    const result = await addTeammatesFromTemplates(hub, [template('reviewer'), template('engineer')], [])
    expect(hub.calls.map(call => call.name)).toEqual(['createBot', 'updateBot', 'createBot', 'updateBot'])
    expect(hub.calls[0]!.arg.name).toBe('评审员')
    expect(hub.calls[1]!.arg).toEqual({ botId: 'b_1', patch: { color: template('reviewer').color } })
    expect(result.added.map(item => item.name)).toEqual(['评审员', '工程师'])
    expect(result.failed).toEqual([])
  })

  it('对外角色的红线随员工说明一起创建，不再单独写规矩', async () => {
    const hub = fakeHub()
    await addTeammatesFromTemplates(hub, [template('spokesperson')], [])
    expect(hub.calls[0]!.arg.brief).toContain('先经主人批准')
    expect(hub.calls.some(call => call.name === 'upsertRule')).toBe(false)
  })

  it('名字被退役队友占用时自动加序号', async () => {
    const hub = fakeHub()
    const result = await addTeammatesFromTemplates(hub, [template('inspector')], [bot('巡检员', 'sentinel', 'retired')])
    expect(hub.calls[0]!.arg.name).toBe('巡检员2')
    expect(result.added[0]!.name).toBe('巡检员2')
  })

  it('一位失败不影响其他几位', async () => {
    const hub = fakeHub({ 'createBot:评审员': { ok: false, error: '额度不够' } })
    const result = await addTeammatesFromTemplates(hub, [template('engineer'), template('reviewer'), template('acceptor')], [])
    expect(result.added.map(item => item.name)).toEqual(['工程师', '验收员'])
    expect(result.failed).toEqual([{ name: '评审员', error: '额度不够' }])
  })

  it('命令直接抛错（比如连接断了）也算这一位失败，不丢已经加上的', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    const hub = fakeHub({ 'createBot:评审员': new Error('连接断开') })
    const result = await addTeammatesFromTemplates(hub, [template('engineer'), template('reviewer')], [])
    expect(result.added.map(item => item.name)).toEqual(['工程师'])
    expect(result.failed).toEqual([{ name: '评审员', error: '连接断开' }])
    errorLog.mockRestore()
  })

  it('提示文案：一位成功不用说，多位列名字，失败写原因', () => {
    expect(templateBatchNotice({ added: [{ botId: 'a', name: '工程师' }], failed: [], warnings: [] })).toBeUndefined()
    expect(templateBatchNotice({ added: [{ botId: 'a', name: '工程师' }, { botId: 'b', name: '评审员' }], failed: [], warnings: [] }))
      .toBe('已添加 2 位队友：工程师、评审员。')
    expect(templateBatchNotice({ added: [{ botId: 'a', name: '工程师' }], failed: [{ name: '评审员', error: '额度不够' }], warnings: [] }))
      .toBe('「评审员」没加上：额度不够')
    expect(templateBatchError({ added: [], failed: [{ name: '评审员', error: '额度不够' }], warnings: [] })).toBe('「评审员」没加上：额度不够')
  })
})

describe('用真实 core 建一遍全部模板', () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => {
    // 先等引擎收口再删目录，否则异步落盘会写到已删除的目录里。
    for (const cleanup of cleanups.splice(0)) await cleanup()
  })

  /** 起一个真实引擎（模型用 FakeHost），并把 facade 适配成批量添加需要的最小 hub。 */
  async function startEngine(): Promise<{ hub: Hub; rootDir: string; adapter: WizardCreateHub }> {
    const rootDir = mkdtempSync(join(tmpdir(), 'agent-hub-templates-'))
    const parts = createEngineHub(rootDir, new testing.FakeHost())
    await parts.hub.start()
    cleanups.push(async () => { await parts.hub.stop(); await rm(rootDir, { recursive: true, force: true }) })
    const facade = new RealHubFacade(parts.hub)
    return { hub: parts.hub, rootDir, adapter: { command: (name, input) => facade.command(name, input), refreshOverview: () => undefined } }
  }

  /** 名额是 6 位，15 个模板分三批建。 */
  const batches: BotTemplate[][] = [BOT_TEMPLATES.slice(0, 6), BOT_TEMPLATES.slice(6, 12), BOT_TEMPLATES.slice(12)]

  it.each(batches.map((batch, index) => [index + 1, batch] as const))('第 %i 批全部建成，设定和模板一致', async (_index, batch) => {
    const { hub, rootDir, adapter } = await startEngine()
    const result = await addTeammatesFromTemplates(adapter, batch, [])
    expect(result.failed).toEqual([])
    expect(result.warnings).toEqual([])
    expect(result.added).toHaveLength(batch.length)

    for (const [index, item] of batch.entries()) {
      const added = result.added[index]!
      const view = await hub.api.bot(added.botId)
      expect(view.card.name).toBe(item.name)
      expect(view.card.role).toBe(item.role)
      expect(view.profile.temperament).toBe(item.temperament)
      expect(view.profile.speechStyle).toBe(item.speechStyle)
      expect(view.profile.brief).toBe(item.brief)
      expect(view.profile.mbti).toBe(item.mbti)
      expect(view.profile.autonomy).toBe('L1')
      const rhythm = RHYTHM_OPTIONS.find(option => option.value === item.rhythm)!
      expect(view.profile.pace).toBe(rhythm.pace)
      expect(view.profile.onDemand).toBe(rhythm.onDemand)
      expect(view.profile.presetSkillIds).toEqual([...item.presetSkillIds])
      // 技能真的写进了家目录，队友才读得到。
      for (const id of item.presetSkillIds) {
        await expect(readFile(join(rootDir, 'bots', added.botId, '.agents/skills', id, 'SKILL.md'), 'utf8')).resolves.toContain(`dsh-buddy:preset-skill:${id}`)
      }
      // 身份文件里要有选择题拼出的性格和员工说明；对外角色的红线就在员工说明里。
      const identity = await readFile(join(rootDir, 'bots', added.botId, 'AGENTS.md'), 'utf8')
      expect(identity).toContain(view.profile.persona)
      expect(identity).toContain(item.brief)
      expect(identity.includes('听吩咐：'), item.name).toBe(rhythm.onDemand)
    }
    const overview = await hub.api.overview()
    expect(overview.bots.map(row => row.name).sort()).toEqual(batch.map(item => item.name).sort())
    // 头像色要覆盖 core 按角色给的默认色。
    for (const item of batch) expect(overview.bots.find(row => row.name === item.name)?.color).toBe(item.color)
  })

  it('真实核对：名额满了之后再加，失败原因会带回来，已建成的不受影响', async () => {
    const { adapter } = await startEngine()
    await addTeammatesFromTemplates(adapter, BOT_TEMPLATES.slice(0, 6), [])
    const result = await addTeammatesFromTemplates(adapter, [template('researcher')], [])
    expect(result.added).toEqual([])
    expect(result.failed[0]!.error).toContain('上限')
  })

  it('真实核对：退役队友还占着名字时，再加同一个模板会自动改名', async () => {
    const { hub, adapter } = await startEngine()
    const first = await addTeammatesFromTemplates(adapter, [template('engineer')], [])
    const retired = await adapter.command('lifecycleAction', { botId: first.added[0]!.botId, action: 'retire' })
    expect(retired.ok).toBe(true)
    const roster = (await hub.api.overview()).bots
    // 选择规则和 core 的名字校验要对得上：退役的不算已添加，但名字确实被占着。
    expect(templateBlock(template('engineer'), roster, [])).toBeNull()
    const again = await addTeammatesFromTemplates(adapter, [template('engineer')], roster)
    expect(again.failed).toEqual([])
    expect(again.added[0]!.name).toBe('工程师2')
  })

  it('员工教练读得到别的队友的工作日志，但改不了（模板说的能力要真实成立）', async () => {
    const { hub, rootDir, adapter } = await startEngine()
    const result = await addTeammatesFromTemplates(adapter, [template('team-coach'), template('engineer')], [])
    const [coach, engineer] = result.added
    const coachView = await hub.api.bot(coach!.botId)
    const journal = join(rootDir, 'bots', engineer!.botId, 'memory/journal/2026-11-09.md')
    expect(hub.guardToolCall(coachView.profile.sessionId!, 'read_file', { path: journal }).allow).toBe(true)
    expect(hub.guardToolCall(coachView.profile.sessionId!, 'write_file', { path: journal, content: 'x' }).allow).toBe(false)
  })
})

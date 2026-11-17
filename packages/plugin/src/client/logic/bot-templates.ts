/**
 * 新建员工的模板库（界面侧逻辑）。
 *
 * P73b 起，模板的数据（16 个模板的角色、性格、员工说明、适合做什么等）和与名册无关的纯函数
 * 移到了 core 的 `team/templates.ts`：组队服务、总管工具、唤醒包都要读同一份，数据只能有一份。
 * 这个文件从 core 导入后原名再导出，插件其余文件的导入路径不变，界面行为不变。
 *
 * 留在这里的是与界面状态有关的部分：哪些模板现在不能选、选中与取消、详情面板的行、
 * 从模板拼创建入参。这个文件只放数据转换和纯函数，组件和测试共用。
 */
import type { BotCard, PresetSkillOption } from '../../shared/views.js'
// 这里不能写 from '@agent-hub/core'：那是 core 的总入口，会把 node:fs、node:child_process 等
// 只有 Node 才有的模块一起拉进浏览器端产物，构建会失败。改用 core 的子路径出口 '@agent-hub/core/team'：
// 它只导出纯数据和纯函数（由 core 的 p73b-team-entry 测试守住），浏览器端可用，数据仍然只有 core 一份。
import {
  BOT_TEMPLATES, BOT_TEMPLATE_GROUPS, INITIAL_TEAM_TABLE, findTemplate, freeTemplateName, isTemplateAdded as isTemplateAddedInRoster,
  mbtiBehaviorLines, templateById, templatesInGroup,
  type BotTemplate, type BotTemplateGroup, type BotTemplateGroupId,
} from '@agent-hub/core/team'
import { MBTI_OPTIONS, RHYTHM_OPTIONS, ROLE_CARDS, SPEECH_STYLE_OPTIONS, TEMPERAMENT_OPTIONS, choiceLabel } from './wizard.js'

// 数据和纯函数来自 core，原名再导出，保证其余文件的导入路径不变。
export { BOT_TEMPLATES, BOT_TEMPLATE_GROUPS, findTemplate, freeTemplateName, templateById, templatesInGroup }
export type { BotTemplate, BotTemplateGroup, BotTemplateGroupId }

// ---------- 从模板拼出创建队友的入参 ----------

/**
 * 拼 createBot 入参。model 故意不传：省略时 core 用设置里的默认模型，没设置就跟随 DSH 默认。
 * 模板只用「听吩咐」和「提建议」两档，都是 L1：模板不替主人放权。
 */
export function buildTemplateInput(template: BotTemplate, name: string = template.name): Record<string, unknown> {
  const rhythm = RHYTHM_OPTIONS.find(option => option.value === template.rhythm)!
  return {
    name,
    // P73e：带上模板标识，core 据此记来历，并在总管私聊落一条「你从模板库添加了…」的旁白。
    templateId: template.id,
    role: template.role,
    temperament: template.temperament,
    speechStyle: template.speechStyle,
    mbti: template.mbti,
    aspirations: [...template.aspirations],
    autonomy: rhythm.autonomy,
    pace: rhythm.pace,
    onDemand: rhythm.onDemand,
    brief: template.brief,
    presetSkillIds: [...template.presetSkillIds],
  }
}

// ---------- 名字与可选状态 ----------

/** 在岗人数上限，和向导、core 的默认值一致。 */
export const MAX_TEAM_SIZE = 6

type RosterBot = Pick<BotCard, 'name' | 'role' | 'lifecycle'>

/** 还占名额的队友：退役和归档的不算，和 core 创建时的口径一致。 */
export function liveBots<T extends Pick<BotCard, 'lifecycle'>>(bots: readonly T[]): T[] {
  return bots.filter(bot => bot.lifecycle !== 'retired')
}

/** 名单上有没有在岗的总管：core 只限制没退役的总管，退役总管不占名额。 */
export function hasLiveChief(bots: readonly Pick<BotCard, 'role' | 'lifecycle'>[]): boolean {
  return liveBots(bots).some(bot => bot.role === 'chief')
}

/** 这个模板是否已经加过：在岗队友里有同名的，或者同名加序号的（规则在 core，这里只换一下参数形状）。 */
export function isTemplateAdded(template: BotTemplate, bots: readonly RosterBot[]): boolean {
  return isTemplateAddedInRoster(template, bots.map(bot => ({ name: bot.name, archived: bot.lifecycle === 'retired' })))
}

/**
 * 模板当前不能选的原因；null 表示可以选。
 * P73e：新增 unique_taken——「全队一位」的模板（评审员）已有人时写「全队一位，已有」，
 * 与总管的「已有总管」同一套规则，不再写「已添加」。
 */
export type TemplateBlock = 'added' | 'chief_taken' | 'unique_taken' | 'cap_reached'

export const TEMPLATE_BLOCK_LABELS: Readonly<Record<TemplateBlock, string>> = {
  added: '已添加',
  chief_taken: '已有总管',
  unique_taken: '全队一位，已有',
  cap_reached: `已到 ${MAX_TEAM_SIZE} 位上限`,
}

/** 判断一个模板现在能不能选：已选中的不会被「名额满了」挡住，否则就取消不掉了。 */
export function templateBlock(template: BotTemplate, bots: readonly RosterBot[], pickedIds: readonly string[]): TemplateBlock | null {
  if (isTemplateAdded(template, bots)) return template.uniquePerTeam ? 'unique_taken' : 'added'
  if (pickedIds.includes(template.id)) return null
  // 总管全队只能有一个：已在岗的算，这次已经选中的也算。
  const pickedChief = pickedIds.some(id => templateById(id)?.role === 'chief')
  if (template.role === 'chief' && (hasLiveChief(bots) || pickedChief)) return 'chief_taken'
  if (liveBots(bots).length + pickedIds.length >= MAX_TEAM_SIZE) return 'cap_reached'
  return null
}

/** 点一下卡片：选中或取消；不能选的不变。 */
export function toggleTemplatePick(pickedIds: readonly string[], template: BotTemplate, bots: readonly RosterBot[]): string[] {
  if (pickedIds.includes(template.id)) return pickedIds.filter(id => id !== template.id)
  return templateBlock(template, bots, pickedIds) === null ? [...pickedIds, template.id] : [...pickedIds]
}

/** 一键选上这一组：逐个加入，每加一个都重新判断，名额用完就停。 */
export function pickWholeGroup(groupId: BotTemplateGroupId, pickedIds: readonly string[], bots: readonly RosterBot[]): string[] {
  let next = [...pickedIds]
  for (const template of templatesInGroup(groupId)) {
    if (!next.includes(template.id) && templateBlock(template, bots, next) === null) next = [...next, template.id]
  }
  return next
}

/** 切到某一组时详情先显示谁：优先推荐的，让第一次来的人先看到建议选的。 */
export function defaultDetailTemplate(groupId: BotTemplateGroupId): BotTemplate {
  const group = templatesInGroup(groupId)
  return group.find(template => template.recommended) ?? group[0]!
}

/** 向导草稿里有没有填过东西：有就回到表单，不让模板页盖住主人写到一半的内容。 */
export function draftHasContent(draft: { name: string; role: string }): boolean {
  return draft.name.trim() !== '' || draft.role !== ''
}

// ---------- 详情面板 ----------

/** 按模板写的顺序取技能中文名；清单还没加载时返回空，界面不显示这一行。 */
export function templateSkillNames(template: BotTemplate, options: readonly PresetSkillOption[]): string[] {
  return template.presetSkillIds.flatMap(id => {
    const name = options.find(option => option.id === id)?.name
    return name === undefined ? [] : [name]
  })
}

export function templateGroup(template: BotTemplate): BotTemplateGroup {
  return BOT_TEMPLATE_GROUPS.find(group => group.id === template.group)!
}

/** 详情标题：对内写岗位 · 部门 · 对内；「对外」本身就是分组名，不重复写两遍。 */
export function templateDetailTitle(template: BotTemplate): string {
  const group = templateGroup(template)
  return group.facing === 'external' ? `${template.name} · 对外` : `${template.name} · ${group.label} · 对内`
}

/** 模型档位在模板库里的名字。 */
export const TIER_LABELS = { standard: '标准档', light: '轻档' } as const

/**
 * 模板在规则表里的默认档位：取表里第一次出现的建议档位，表里没有的取标准档。
 * 轻档不可用（模型目录里没有轻量模型）时一律写标准档，与组队卡同一口径。
 */
export function templateTierLabel(template: BotTemplate, lightAvailable: boolean): string {
  let tier: 'standard' | 'light' = 'standard'
  for (const seeds of Object.values(INITIAL_TEAM_TABLE)) {
    const seed = seeds.find(item => item.templateId === template.id)
    if (seed !== undefined) { tier = seed.modelTier; break }
  }
  return tier === 'light' && lightAvailable ? TIER_LABELS.light : TIER_LABELS.standard
}

/** 卡片底部的一行属性（P73e）：角色 · MBTI · 模型档位，角色取模板的显示标签（评审员写「评审」）。 */
export function templateMeta(template: BotTemplate, lightAvailable: boolean = true): string {
  return `${template.dutyLabel} · ${template.mbti} · ${templateTierLabel(template, lightAvailable)}`
}

/** 模板库底部的汇总句：已选几位、谁、添加后在册多少；没选时为空串。 */
export function templatePickSummary(picked: ReadonlyArray<Pick<BotTemplate, 'name'>>, liveCount: number, maxBots: number = MAX_TEAM_SIZE): string {
  if (picked.length === 0) return ''
  return `已选 ${picked.length} 位：${picked.map(template => template.name).join('、')}。添加后在册 ${liveCount + picked.length} / ${maxBots} 位。不另跑试用，第一件事就是试用。`
}

function roleLabel(template: BotTemplate): string {
  return ROLE_CARDS.find(card => card.role === template.role)?.label ?? ''
}

/** 详情面板的一行；lines 不为空时在值下面画性格四句话（P73e）。 */
export interface TemplateDetailRow { label: string; value: string; lines?: ReadonlyArray<{ code: string; text: string }> }

/**
 * 详情面板逐行内容：和表单同样的几项，加进来后不会有意外。
 * P73e 两处改动：
 * - 「MBTI」一行除了类型，还带四句话（说明这个性格做事时的实际表现），文字取 core 的性格总表；
 * - 去掉「自主节奏」一行：执行类模板固定「听吩咐」，没有可看的内容；值守类等模板仍然保留这一行。
 */
export function templateDetailRows(template: BotTemplate, options: readonly PresetSkillOption[]): TemplateDetailRow[] {
  const skills = templateSkillNames(template, options)
  const rhythm = RHYTHM_OPTIONS.find(option => option.value === template.rhythm)!
  return [
    { label: '执行风格', value: roleLabel(template) },
    { label: '性格', value: choiceLabel(TEMPERAMENT_OPTIONS, template.temperament, '') },
    { label: '说话风格', value: choiceLabel(SPEECH_STYLE_OPTIONS, template.speechStyle, '') },
    { label: 'MBTI', value: MBTI_OPTIONS.find(option => option.value === template.mbti)?.label ?? template.mbti, lines: mbtiBehaviorLines(template.mbti) ?? [] },
    ...(template.rhythm === 'on_demand' ? [] : [{ label: '自主节奏', value: `${rhythm.label}：${rhythm.desc}` }]),
    ...(skills.length > 0 ? [{ label: '岗位技能', value: skills.join('、') }] : []),
    { label: '员工说明', value: template.brief },
  ]
}

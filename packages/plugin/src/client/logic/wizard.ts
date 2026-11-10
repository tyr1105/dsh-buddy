/**
 * 队友配置的纯逻辑（P55 精简后）：选项表、校验、入参拼装、草稿读写。
 *
 * 主人把配置收成八项：名字、执行风格、性格、说话风格、MBTI、自主节奏、模型、岗位技能，
 * 其余要求都写进员工说明。新建队友和编辑队友共用这里的规则，两边不会各说各话。
 *
 * 除了 localStorage 的两个小函数，这里全是纯函数，组件和测试共用。
 */
import type { MbtiType, Role, SpeechStyle, Temperament } from '../../shared/views.js'

// ---------- 选项表 ----------

/** 五种执行风格；总管全队只能有一个，建议风格不能选会动手的节奏。 */
export interface RoleCard { role: Role; label: string; desc: string }

export const ROLE_CARDS: readonly RoleCard[] = [
  { role: 'chief', label: '总管', desc: '统筹分派，最多 1 个' },
  { role: 'researcher', label: '调研', desc: '查资料、写结论' },
  { role: 'executor', label: '执行', desc: '把事情做完' },
  { role: 'sentinel', label: '盯守', desc: '盯着运行，异常就报' },
  { role: 'advisor', label: '建议', desc: '提意见，不动手' },
]

/** 一道选择题的选项：value 提交给 core，desc 说清选了之后它会怎样。 */
export interface ChoiceOption<T extends string> { value: T; label: string; desc: string }

/** 性格选择题；每项写进身份文件的话在 core 的 persona-choices.ts，id 由测试保证一致。 */
export const TEMPERAMENT_OPTIONS: ReadonlyArray<ChoiceOption<Temperament>> = [
  { value: 'steady', label: '稳重靠谱', desc: '按事实和流程办事，不冒进。' },
  { value: 'rigorous', label: '严谨较真', desc: '证据不够不下结论，细节不放过。' },
  { value: 'cheerful', label: '开朗热情', desc: '积极回应，愿意鼓励别人。' },
  { value: 'inventive', label: '点子很多', desc: '爱提新想法，敢试不同的路。' },
  { value: 'calm', label: '冷静寡言', desc: '话不多，只说关键的。' },
  { value: 'gentle', label: '温和细心', desc: '替别人着想，说话留余地。' },
]

/** 说话风格选择题。 */
export const SPEECH_STYLE_OPTIONS: ReadonlyArray<ChoiceOption<SpeechStyle>> = [
  { value: 'conclusion_first', label: '结论先行', desc: '第一句给结论，再说依据。' },
  { value: 'brief', label: '简短干脆', desc: '能一句说完就不说两句。' },
  { value: 'detailed', label: '详细周到', desc: '把背景和理由讲清楚。' },
  { value: 'gentle', label: '温和客气', desc: '语气柔和，多用商量的口吻。' },
  { value: 'blunt', label: '直来直去', desc: '有问题直接指出，不绕弯。' },
  { value: 'playful', label: '轻松幽默', desc: '可以开点小玩笑，但不耽误正事。' },
]

/** 自主节奏：把原来的自主等级和节奏合成一道题。 */
export type Rhythm = 'on_demand' | 'advise' | 'act' | 'drive'
export type PaceValue = 'active' | 'normal' | 'quiet'
export type AutonomyValue = 'L0' | 'L1' | 'L2' | 'L3'

export interface RhythmOption extends ChoiceOption<Rhythm> {
  autonomy: 'L1' | 'L2'
  pace: PaceValue
  onDemand: boolean
}

export const RHYTHM_OPTIONS: readonly RhythmOption[] = [
  { value: 'on_demand', label: '听吩咐', desc: '你点名或派活才动', autonomy: 'L1', pace: 'quiet', onDemand: true },
  { value: 'advise', label: '提建议', desc: '动手前先问你', autonomy: 'L1', pace: 'normal', onDemand: false },
  { value: 'act', label: '主动做', desc: '常规事直接做', autonomy: 'L2', pace: 'normal', onDemand: false },
  { value: 'drive', label: '全力推进', desc: '自己找事往前推', autonomy: 'L2', pace: 'active', onDemand: false },
]

/** 建议风格只提意见，不能选会动手的两档；core 也有同样的校验。 */
export function rhythmAllowed(role: Role | '', rhythm: Rhythm): boolean {
  return role !== 'advisor' || rhythm === 'on_demand' || rhythm === 'advise'
}

/**
 * 从已有档案反推选中哪一档。老队友可能是 L0、L3 或别的组合，这里取最接近的一档显示；
 * 只要主人不改这一项，保存时就不会动它原来的等级（见 buildProfilePatch）。
 */
export function rhythmOf(profile: { autonomy: AutonomyValue; pace: PaceValue; onDemand: boolean }): Rhythm {
  if (profile.onDemand) return 'on_demand'
  if (profile.autonomy === 'L0' || profile.autonomy === 'L1') return 'advise'
  return profile.autonomy === 'L3' || profile.pace === 'active' ? 'drive' : 'act'
}

/** MBTI 草稿：空字符串表示未设置（旧机器人保持未设置，不替主人猜一个类型）。 */
export type MbtiDraft = '' | MbtiType

/** 一个 MBTI 选项：value 提交给 core，desc 是给主人看的一句人话解释。 */
export interface MbtiOption { value: MbtiType; label: string; desc: string }

/** 16 型选项与一句人话解释；这些文案只描述说话与做事的习惯，不涉及权限和审批。 */
export const MBTI_OPTIONS: readonly MbtiOption[] = [
  { value: 'INTJ', label: 'INTJ 建筑师', desc: '先想全局再动手，判断独立，喜欢长线布局。' },
  { value: 'INTP', label: 'INTP 逻辑学家', desc: '爱刨根问底，结论慢一点，但逻辑要严丝合缝。' },
  { value: 'ENTJ', label: 'ENTJ 指挥官', desc: '目标第一，擅长把人和事排成计划往前推。' },
  { value: 'ENTP', label: 'ENTP 辩论家', desc: '点子多，先试新路，边讨论边收敛。' },
  { value: 'INFJ', label: 'INFJ 提倡者', desc: '先看人和影响，再给一个有意义的方向。' },
  { value: 'INFP', label: 'INFP 调停者', desc: '在意价值和感受，语气温和，立场不含糊。' },
  { value: 'ENFJ', label: 'ENFJ 主人公', desc: '先照顾大家的状态，再把事情组织起来。' },
  { value: 'ENFP', label: 'ENFP 竞选者', desc: '热情、点子多，先聊可能性再落地。' },
  { value: 'ISTJ', label: 'ISTJ 物流师', desc: '照事实和流程办事，交付稳、有据可查。' },
  { value: 'ISFJ', label: 'ISFJ 守卫者', desc: '细心可靠，先保证不影响到别人。' },
  { value: 'ESTJ', label: 'ESTJ 总经理', desc: '讲效率和规则，结论明确，说干就干。' },
  { value: 'ESFJ', label: 'ESFJ 执政官', desc: '先确认大家的感受和分工，再把事办妥。' },
  { value: 'ISTP', label: 'ISTP 鉴赏家', desc: '先上手试，边拆边修，话不多。' },
  { value: 'ISFP', label: 'ISFP 探险家', desc: '温和务实，按自己的节奏把事做好。' },
  { value: 'ESTP', label: 'ESTP 企业家', desc: '反应快，先行动再调整，擅长救场。' },
  { value: 'ESFP', label: 'ESFP 表演者', desc: '外向有现场感，边做边把气氛带起来。' },
]

/** 判断任意值是不是 16 型之一（读旧草稿时用，避免把脏数据带进表单）。 */
export function isMbtiType(value: unknown): value is MbtiType {
  return typeof value === 'string' && MBTI_OPTIONS.some(option => option.value === value)
}

// ---------- 表单草稿 ----------

/** 八项配置的表单状态；新建队友和编辑队友用同一份形状。 */
export interface BotConfigDraft {
  name: string
  role: Role | ''
  temperament: Temperament | ''
  speechStyle: SpeechStyle | ''
  mbti: MbtiDraft
  rhythm: Rhythm
  /** ''/'null' = 跟随 DSH 默认；否则是模型选项 value 的 JSON。 */
  model: string
  presetSkillIds: string[]
  dshSkillNames: string[]
  brief: string
}

export function emptyDraft(): BotConfigDraft {
  return {
    name: '', role: '', temperament: '', speechStyle: '', mbti: '', rhythm: 'advise',
    model: '', presetSkillIds: [], dshSkillNames: [], brief: '',
  }
}

/** 六步向导的旧草稿形状对不上，换一个键，旧内容不再读取。 */
const DRAFT_KEY = 'dsh-buddy:wizard-draft:v2'

/** 可注入的持久层（默认用浏览器 localStorage；测试传内存版）。 */
type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

function storage(): DraftStorage | null {
  try {
    const s = (globalThis as { localStorage?: DraftStorage }).localStorage
    return s ?? null
  } catch {
    return null
  }
}

/** 草稿存 localStorage（读写全部 try/catch：隐私模式或超额时当没有草稿）。 */
export function saveDraft(draft: BotConfigDraft, store: DraftStorage | null = storage()): void {
  try { store?.setItem(DRAFT_KEY, JSON.stringify(draft)) } catch { /* 存不进去就算了 */ }
}

/** 只留字符串；旧草稿里的脏数据不带进表单。 */
function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

/** 读回草稿；坏数据返回 null（不把表单卡死在别人的旧草稿上）。 */
export function loadDraft(store: DraftStorage | null = storage()): BotConfigDraft | null {
  try {
    const raw = store?.getItem(DRAFT_KEY) ?? null
    if (raw === null) return null
    const value = JSON.parse(raw) as Partial<BotConfigDraft>
    if (typeof value?.name !== 'string') return null
    return { ...emptyDraft(), ...value, mbti: isMbtiType(value.mbti) ? value.mbti : '',
      presetSkillIds: stringList(value.presetSkillIds), dshSkillNames: stringList(value.dshSkillNames) }
  } catch {
    return null
  }
}

/** 上岗成功或放弃后清草稿。 */
export function clearDraft(store: DraftStorage | null = storage()): void {
  try { store?.removeItem(DRAFT_KEY) } catch { /* 忽略 */ }
}

// ---------- 校验 ----------

/** 名字：1–20 字、不与现有机器人重名（重名实时提示）。 */
export function validateName(name: string, existingNames: readonly string[]): string | null {
  const trimmed = name.trim()
  if (trimmed === '') return '名字：不能为空'
  if ([...trimmed].length > 20) return '名字：不能超过 20 字'
  if (existingNames.some(n => n === trimmed)) return `名字：已经有叫「${trimmed}」的队友了，换一个吧`
  return null
}

/** 员工说明的字数上限，和 core 的校验一致。 */
export const BRIEF_MAX = 1000

/** MBTI：可跳过（''），选了必须是 16 型之一。 */
export function validateMbti(mbti: string): string | null {
  return mbti === '' || isMbtiType(mbti) ? null : 'MBTI：请从列表里选一个类型，或选「不设置」'
}

/** 整张表单的第一个问题；按从上到下的顺序，主人先看到最上面的那一项。 */
export function configProblem(draft: BotConfigDraft, existingNames: readonly string[]): string | null {
  return validateName(draft.name, existingNames)
    ?? (draft.role === '' ? '执行风格：选一张卡片' : null)
    ?? validateMbti(draft.mbti)
    ?? ([...draft.brief.trim()].length > BRIEF_MAX ? `员工说明：不能超过 ${BRIEF_MAX} 字` : null)
}

/** 错误文案前缀对应到字段，错误才能显示在对应字段旁边。 */
export type ConfigField = 'name' | 'role' | 'brief'

export function problemField(problem: string | null): ConfigField | null {
  if (problem === null) return null
  if (problem.startsWith('名字')) return 'name'
  if (problem.startsWith('执行风格')) return 'role'
  if (problem.startsWith('员工说明')) return 'brief'
  return null
}

// ---------- 拼入参 ----------

/** 选中的那一档节奏；传了不存在的值就退回默认档，不让表单崩掉。 */
function rhythmOption(rhythm: Rhythm): RhythmOption {
  return RHYTHM_OPTIONS.find(option => option.value === rhythm) ?? RHYTHM_OPTIONS[1]!
}

/** 表单里的模型字符串翻成 core 要的值：跟随默认是 null，其余是 {provider, model}。 */
function modelValue(model: string): unknown {
  return model === '' || model === 'null' ? null : JSON.parse(model) as unknown
}

/** 把表单拼成 createBot 的入参；persona 和志向由 core 自动生成。 */
export function buildCreateBotInput(draft: BotConfigDraft): Record<string, unknown> {
  const rhythm = rhythmOption(draft.rhythm)
  const input: Record<string, unknown> = {
    name: draft.name.trim(),
    role: draft.role,
    temperament: draft.temperament === '' ? null : draft.temperament,
    speechStyle: draft.speechStyle === '' ? null : draft.speechStyle,
    // MBTI 可跳过：未设置显式提交 null，让 core 保持「未设置」而不是补默认型。
    mbti: draft.mbti === '' ? null : draft.mbti,
    autonomy: rhythm.autonomy,
    pace: rhythm.pace,
    onDemand: rhythm.onDemand,
    brief: draft.brief.trim(),
    // 「跟随 DSH 默认」显式提交 null：省略会继承中心设置里的默认模型，并不跟随 DSH。
    model: modelValue(draft.model),
  }
  if (draft.presetSkillIds.length > 0) input.presetSkillIds = [...draft.presetSkillIds]
  if (draft.dshSkillNames.length > 0) input.dshSkillNames = [...draft.dshSkillNames]
  return input
}

/** 从详情生成编辑用的表单，字段只取这里用得到的。 */
export function draftFromProfile(card: { name: string; role: Role }, profile: {
  persona: string; mbti: MbtiType | null; autonomy: AutonomyValue; pace: PaceValue; onDemand: boolean
  temperament: Temperament | null; speechStyle: SpeechStyle | null; brief: string
  model: unknown; presetSkillIds: readonly string[]; dshSkillNames: readonly string[]
}): BotConfigDraft {
  // 老队友的性格是一段自由文字，选择题表达不了。先放进员工说明，主人改选择题时这段话才不会丢。
  const legacyPersona = profile.temperament === null && profile.speechStyle === null && profile.brief === '' ? profile.persona : ''
  return {
    name: card.name, role: card.role,
    temperament: profile.temperament ?? '', speechStyle: profile.speechStyle ?? '',
    mbti: profile.mbti ?? '', rhythm: rhythmOf(profile),
    model: profile.model === null ? '' : JSON.stringify(profile.model),
    presetSkillIds: [...profile.presetSkillIds], dshSkillNames: [...profile.dshSkillNames],
    brief: profile.brief === '' ? legacyPersona : profile.brief,
  }
}

/** 两份字符串列表内容是否相同（顺序也算）。 */
function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index])
}

/**
 * 只提交主人真正改过的字段：
 * - 没动节奏时不提交等级，老队友的 L0、L3 不会被悄悄改掉；
 * - 没动模型时不重交，已下架的旧模型不会挡住单独改别的；
 * - 改了选择题时带上员工说明，老队友写在性格里的长文字才不会随 persona 重算而丢失。
 */
export function buildProfilePatch(draft: BotConfigDraft, initial: BotConfigDraft): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  if (draft.name.trim() !== initial.name) patch.name = draft.name.trim()
  if (draft.role !== initial.role) patch.role = draft.role
  const temperamentChanged = draft.temperament !== initial.temperament
  const speechChanged = draft.speechStyle !== initial.speechStyle
  if (temperamentChanged) patch.temperament = draft.temperament === '' ? null : draft.temperament
  if (speechChanged) patch.speechStyle = draft.speechStyle === '' ? null : draft.speechStyle
  if (draft.brief !== initial.brief || temperamentChanged || speechChanged) patch.brief = draft.brief.trim()
  if (draft.mbti !== initial.mbti) patch.mbti = draft.mbti === '' ? null : draft.mbti
  if (draft.rhythm !== initial.rhythm) {
    const rhythm = rhythmOption(draft.rhythm)
    Object.assign(patch, { autonomy: rhythm.autonomy, pace: rhythm.pace, onDemand: rhythm.onDemand })
  }
  if (draft.model !== initial.model) patch.model = modelValue(draft.model)
  if (!sameList(draft.presetSkillIds, initial.presetSkillIds)) patch.presetSkillIds = [...draft.presetSkillIds]
  if (!sameList(draft.dshSkillNames, initial.dshSkillNames)) patch.dshSkillNames = [...draft.dshSkillNames]
  return patch
}

/** 选项表查标签；旧数据里找不到时返回兜底文字，不显示内部 id。 */
export function choiceLabel<T extends string>(options: ReadonlyArray<ChoiceOption<T>>, value: T | '' | null, fallback: string): string {
  return options.find(option => option.value === value)?.label ?? fallback
}

/**
 * 新建队友向导的纯逻辑：步骤校验、示例文案、复述一句话、createBot 入参拼装、
 * 草稿的内存与 localStorage 读写（读写包 try/catch，坏了当没有草稿）。
 * 全部是纯函数（除了 localStorage 两个小函数），供 NewBotWizard 组件与测试共用。
 */

/** 四种角色卡片（向导第 1 步展示；文案与任务卡一致）。 */
export interface RoleCard { role: 'chief' | 'researcher' | 'executor' | 'sentinel'; label: string; desc: string }

export const ROLE_CARDS: readonly RoleCard[] = [
  { role: 'chief', label: '总管', desc: '统筹全队、分派与跟进，最多 1 个' },
  { role: 'researcher', label: '调研', desc: '盯信息源、做研究、写结论' },
  { role: 'executor', label: '执行', desc: '把事情做完，按规矩交付' },
  { role: 'sentinel', label: '盯守', desc: '盯运行记录与期望，异常就报' },
]

/** 8 个预设头像色板（数据驱动的颜色，允许以值存在；渲染时走内联样式）。 */
export const PRESET_COLORS: readonly string[] = [
  '#6366f1', '#0ea5e9', '#10b981', '#84cc16',
  '#f59e0b', '#ef4444', '#ec4899', '#8b5cf6',
]

/** 色板的中文名（无障碍标签用，如「头像颜色：绿色」；颜色本体仍走内联样式）。 */
export const COLOR_NAMES: Readonly<Record<string, string>> = {
  '#6366f1': '靛蓝', '#0ea5e9': '天蓝', '#10b981': '绿色', '#84cc16': '黄绿',
  '#f59e0b': '琥珀', '#ef4444': '红色', '#ec4899': '粉色', '#8b5cf6': '紫色',
}

/** 自主等级（L3 不出现在向导里，只能主人手动设）。 */
export const AUTONOMY_OPTIONS: ReadonlyArray<{ value: 'L0' | 'L1' | 'L2'; label: string }> = [
  { value: 'L0', label: 'L0 只观察' },
  { value: 'L1', label: 'L1 建议（默认）' },
  { value: 'L2', label: 'L2 执行' },
]

/** 节奏档。 */
export const PACE_OPTIONS: ReadonlyArray<{ value: 'active' | 'normal' | 'quiet'; label: string }> = [
  { value: 'active', label: '积极' },
  { value: 'normal', label: '适中（默认）' },
  { value: 'quiet', label: '安静' },
]

/** 关注项类型（向导第 5 步「起步关注」）。 */
export type WatchKindLite = 'file' | 'log' | 'http' | 'rss' | 'script'

/** 按角色给的性格示例（向导第 2 步可一键填入，每角色 2 条）。 */
export const PERSONA_EXAMPLES: Readonly<Record<RoleCard['role'], readonly string[]>> = {
  chief: [
    '先结论后过程；分派时写清「谁、做什么、什么时候要」；每天汇总一次全队进展。',
    '不催人，只催事：交接超时先自己想办法，找不到办法才找主人。',
  ],
  researcher: [
    '结论先行，证据附后；引用外部内容时注明「外部内容」并只当数据看。',
    '宁可少下结论，不下没证据的结论；查不到就明说查不到。',
  ],
  executor: [
    '交付前自查一遍完成标准；做不到的当天说，不拖到最后。',
    '一次只做一件事；做完一件交一件账，不攒。',
  ],
  sentinel: [
    '只报异常和期望落空，正常的不打扰主人；日报里一句话带过。',
    '描述问题带上时间、位置和影响面，不写「好像出问题了」。',
  ],
}

/** 按角色给的志向示例（向导第 3 步展示，点击可填入）。 */
export const ASPIRATION_EXAMPLES: Readonly<Record<RoleCard['role'], readonly string[]>> = {
  chief: ['全队的事都有人跟、有回音，没有一件事悄悄掉在地上', '主人只被必要的事打扰，其余的我们内部消化'],
  researcher: ['把主人关心的信息源盯全，出的结论都有出处', '重要变化当天给出一段能直接用的摘要'],
  executor: ['答应的事按时做完，做不完提前说', '每次交付都附「怎么验证做对了」'],
  sentinel: ['我的自动线每天按时跑完，出问题第一时间知道', '异常在影响变大之前被看见'],
}

/** 向导草稿（内存与 localStorage 各存一份；字段与 createBot 入参对应）。 */
export interface WatchDraft { kind: WatchKindLite; target: string; note: string }
export interface GoalDraft { title: string; doneWhen: string; period: 'day' | 'week' | 'month' | 'one_off' }
export interface WizardDraft {
  step: number                       // 0–5，当前走到哪一步
  name: string
  role: RoleCard['role'] | ''
  color: string
  persona: string
  aspirations: string[]              // 志向 1–3 条
  goal: GoalDraft | null             // 可选的第一个目标
  autonomy: 'L0' | 'L1' | 'L2'
  pace: 'active' | 'normal' | 'quiet'
  model: string                      // ''/'null' = 跟随宿主默认（提交 model:null）；否则 modelOptions 的 value 序列化
  watch: WatchDraft | null           // 起步关注（可跳过）
}

export function emptyDraft(): WizardDraft {
  return {
    step: 0, name: '', role: '', color: PRESET_COLORS[0]!, persona: '', aspirations: [''],
    goal: null, autonomy: 'L1', pace: 'normal', model: '', watch: null,
  }
}

const DRAFT_KEY = 'dsh-agent-hub:wizard-draft:v1'

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
export function saveDraft(draft: WizardDraft, store: DraftStorage | null = storage()): void {
  try { store?.setItem(DRAFT_KEY, JSON.stringify(draft)) } catch { /* 存不进去就算了 */ }
}

/** 读回草稿；坏数据返回 null（不把向导卡死在别人的旧草稿上）。 */
export function loadDraft(store: DraftStorage | null = storage()): WizardDraft | null {
  try {
    const raw = store?.getItem(DRAFT_KEY) ?? null
    if (raw === null) return null
    const value = JSON.parse(raw) as WizardDraft
    return typeof value?.name === 'string' && typeof value?.step === 'number' ? value : null
  } catch {
    return null
  }
}

/** 上岗成功或放弃后清草稿。 */
export function clearDraft(store: DraftStorage | null = storage()): void {
  try { store?.removeItem(DRAFT_KEY) } catch { /* 忽略 */ }
}

// ---------- 每步校验（错误信息中文、说清哪一项不对） ----------

/** 名字：1–20 字、不与现有机器人重名（重名实时提示）。 */
export function validateName(name: string, existingNames: readonly string[]): string | null {
  const trimmed = name.trim()
  if (trimmed === '') return '名字：不能为空'
  if ([...trimmed].length > 20) return '名字：不能超过 20 字'
  if (existingNames.some(n => n === trimmed)) return `名字：已经有叫「${trimmed}」的队友了，换一个吧`
  return null
}

/** 性格与说话风格：可空，但填了不超过 300 字。 */
export function validatePersona(persona: string): string | null {
  if ([...persona.trim()].length > 300) return '性格与说话风格：不能超过 300 字'
  return null
}

/** 志向文本（多行，一行一条）解析成非空列表。 */
export function parseAspirations(text: string): string[] {
  return text.split(/\r?\n/).map(line => line.trim()).filter(line => line !== '')
}

/** 志向：必须 1–3 条、每条非空。 */
export function validateAspirations(lines: readonly string[]): string | null {
  if (lines.length < 1) return '志向：至少写 1 条（它是队友存在的理由）'
  if (lines.length > 3) return '志向：最多 3 条，挑最重要的'
  return null
}

/** 起步关注：file/log 要绝对路径（给「选择路径」输入框）；http/rss 校验 URL；script 给命令。 */
export function validateWatchTarget(kind: WatchKindLite, target: string): string | null {
  const t = target.trim()
  if (t === '') return '关注目标：不能为空'
  if (kind === 'http' || kind === 'rss') {
    try {
      const url = new URL(t)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error()
    } catch {
      return '关注目标：网页 / RSS 要填 http(s) 开头的完整网址'
    }
  }
  if ((kind === 'file' || kind === 'log') && !t.startsWith('/') && !t.startsWith('~')) {
    return '关注目标：文件 / 日志要填以 / 或 ~ 开头的完整路径'
  }
  return null
}

/** 向导某一步整体能否点「下一步」（第 0 步名字 + 角色 + 颜色）。 */
export function stepError(draft: WizardDraft, existingNames: readonly string[]): string | null {
  switch (draft.step) {
    case 0:
      if (draft.role === '') return '角色：选一张卡片'
      return validateName(draft.name, existingNames)
    case 1: return validatePersona(draft.persona)
    case 2: {
      const lines = draft.aspirations.map(l => l.trim()).filter(l => l !== '')
      return validateAspirations(lines)
    }
    case 4:
      return draft.watch === null ? null : validateWatchTarget(draft.watch.kind, draft.watch.target)
    default: return null
  }
}

// ---------- 复述与入参 ----------

/** 确认页的一段话复述（任务卡原文格式）。 */
export function wizardSummary(draft: WizardDraft, roleLabel: string): string {
  const aspirations = draft.aspirations.map(l => l.trim()).filter(l => l !== '')
  const aspirationText = aspirations.length > 0 ? `我的志向是${aspirations.join('；')}` : ''
  const watchText = draft.watch && draft.watch.target.trim() !== ''
    ? `我会先盯着${draft.watch.target.trim()}`
    : '我会先熟悉自己的家目录，再自己提议要盯什么'
  return `我是${draft.name.trim() || '（还没起名）'}，${roleLabel}。${aspirationText}。${watchText}，有事会在这里找你。`
}

/** 把草稿拼成 createBot 命令的 input（关注项与目标可选；颜色随后用 updateBot 存）。 */
export function buildCreateBotInput(draft: WizardDraft): Record<string, unknown> {
  const aspirations = draft.aspirations.map(l => l.trim()).filter(l => l !== '')
  const input: Record<string, unknown> = {
    name: draft.name.trim(),
    role: draft.role,
    persona: draft.persona.trim() === '' ? `我是${draft.name.trim()}，按${draft.role === 'chief' ? '总管' : draft.role === 'researcher' ? '调研' : draft.role === 'executor' ? '执行' : '盯守'}的方式做事。` : draft.persona.trim(),
    aspirations,
    autonomy: draft.autonomy,
    pace: draft.pace,
  }
  // D07 第 8 条：「跟随 DSH 默认」显式提交 model:null（不是省略——省略会继承中心
  // 设置里的默认模型，并不跟随 DSH）；选了具体模型则提交 {provider, model}。
  input.model = draft.model === '' || draft.model === 'null' ? null : JSON.parse(draft.model) as unknown
  if (draft.goal && draft.goal.title.trim() !== '') {
    input.goals = [{
      aspirationIndex: 0,
      title: draft.goal.title.trim(),
      doneWhen: draft.goal.doneWhen.trim() || '主人验收通过',
      period: draft.goal.period,
    }]
  }
  if (draft.watch && draft.watch.target.trim() !== '') {
    input.watches = [{
      kind: draft.watch.kind,
      target: draft.watch.target.trim(),
      why: draft.watch.note.trim() === '' ? '起步关注：主人建队时指定' : draft.watch.note.trim(),
    }]
  }
  return input
}

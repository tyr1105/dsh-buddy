/**
 * 设置页的校验与拼装（纯函数）：免打扰时段、通知方式、默认模型、
 * 给你自己留出（员工份额）、员工自己发起的工作（每日回合上限）、公共知识库连接（P38）。
 *
 * P76k 按方案 7.10.1 精简：日报时间、全队与每位的通知条数上限、每位每天的 token 上限
 * 都已取消（对应的机制在 P76c、P76h 里删掉了），设置页不再显示这些项，草稿与 patch 里也不再带。
 * 界面先校验再 POST updateSettings；非法值给中文提示、不能保存。
 */
import type { KnowledgeBaseConfig, Settings } from '@agent-hub/core'
import type { ModelChoice } from '../../shared/views.js'

/**
 * P38 知识库界面侧边界：与 core 的 model/knowledge-base.ts 逐项保持一致。
 * client 不能从 @agent-hub/core 做值导入（会把 node 专用模块打进浏览器包），
 * 所以这里按既有预算常量的惯例在插件侧另存一份；改边界时两处同步。
 */
export const KB_ENDPOINT_MAX = 2000
export const KB_AUTH_REF_MAX = 120
export const KB_PROTOCOL_MAX = 40
export const KB_SCOPE_MAX = 200
export const KB_MAX_BYTES_MIN = 1024
export const KB_MAX_BYTES_MAX = 1024 * 1024
export const KB_DEFAULT_MAX_BYTES = 256 * 1024
/** 旧设置缺 knowledgeBase 段时的界面兜底（默认关闭、全空），不写回设置。 */
const KB_DEFAULTS: KnowledgeBaseConfig = {
  enabled: false, endpoint: '', authRef: '', protocol: '', scope: '',
  readOnly: true, maxBytes: KB_DEFAULT_MAX_BYTES,
}

/**
 * P76k「员工自己发起的工作」的界面上下限（core 迁移后默认 2）：1 到 10。
 * 上限 10 是方案 7.10.3 给的新界面上限；下限 1 防止误填 0 让员工全天不自己开工。
 */
export const BOT_DAILY_TURN_MIN = 1
export const BOT_DAILY_TURN_MAX = 10

/**
 * P76k「给你自己留出」三档：显示的是一成、三成、五成，写回的是员工份额 botQuotaShare。
 * 三成是默认（员工用七成，与你留出的三成对应）。
 */
export interface QuotaShareChoice { value: number; label: string; isDefault: boolean }
export const QUOTA_SHARE_CHOICES: readonly QuotaShareChoice[] = [
  { value: 0.9, label: '一成', isDefault: false },
  { value: 0.7, label: '三成', isDefault: true },
  { value: 0.5, label: '五成', isDefault: false },
]

/**
 * 当前值不在三档里时，额外一项的显示文字：「{百分数}（自定义）」。
 * 百分数说的是「给你自己留出」的比例（1 − botQuotaShare），与三档同一口径。
 */
export function customShareLabel(share: number): string {
  return `${Math.round((1 - share) * 100)}%（自定义）`
}

/** HH:mm 校验（5 分钟为单位由输入控件 step 保证，这里只查形状）。 */
export function validateClockTime(value: string, field: string): string | null {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value.trim())) return `${field}：请填写 HH:mm 格式（例如 23:00）。`
  return null
}

export interface SettingsDraft {
  quietStart: string
  quietEnd: string
  pushChannel: string
  /** P76k「给你自己留出」写回的员工份额（0.9、0.7、0.5，或旧设置里的自定义值）。 */
  botQuotaShare: number | string
  /** P76k「员工自己发起的工作」：每位每天最多几个自己发起的回合。 */
  botDailyTurnBudget: number | string
  defaultModel: string            // '' = 跟随 DSH 默认
  // P38 公共知识库（可选、默认关）；kbMaxBytes 输入框期间允许字符串。
  kbEnabled: boolean
  kbEndpoint: string
  kbAuthRef: string   // 只存凭据引用（宿主安全存储里的键名），界面也绝不收明文凭据
  kbProtocol: string
  kbScope: string
  kbMaxBytes: number | string
}

/** 从 SettingsView 的 settings 派生表单草稿；旧设置缺 knowledgeBase 时补默认，不崩。 */
export function draftFromSettings(settings: Settings): SettingsDraft {
  // 旧版本设置可能没有 knowledgeBase 段（P38 之前的数据），缺了按默认关闭补空。
  const kb = settings.knowledgeBase ?? KB_DEFAULTS
  return {
    quietStart: settings.quietHours.start,
    quietEnd: settings.quietHours.end,
    pushChannel: settings.pushChannel,
    botQuotaShare: String(settings.botQuotaShare),
    botDailyTurnBudget: String(settings.botDailyTurnBudget),
    defaultModel: settings.defaultModel === null ? '' : JSON.stringify(settings.defaultModel),
    kbEnabled: kb.enabled,
    kbEndpoint: kb.endpoint,
    kbAuthRef: kb.authRef,
    kbProtocol: kb.protocol,
    kbScope: kb.scope,
    kbMaxBytes: String(kb.maxBytes),
  }
}

/** 校验整份草稿；返回第一条错误（中文、说清哪一项不对）。 */
export function validateSettingsDraft(draft: SettingsDraft): string | null {
  const start = validateClockTime(draft.quietStart, '免打扰开始')
  if (start !== null) return start
  const end = validateClockTime(draft.quietEnd, '免打扰结束')
  if (end !== null) return end
  if (!['dsh', 'macos', 'none'].includes(draft.pushChannel)) return '通知方式：请选择 macOS 通知、DSH 内通知或不发通知。'
  // 「给你自己留出」照三档写回；旧设置里的自定义值原样保留（>0 且 <1 才算合法份额）。
  const share = Number(draft.botQuotaShare)
  if (!Number.isFinite(share) || share <= 0 || share >= 1) return '给你自己留出：请选择一成、三成或五成。'
  const turns = Number(draft.botDailyTurnBudget)
  if (!Number.isInteger(turns) || turns < BOT_DAILY_TURN_MIN || turns > BOT_DAILY_TURN_MAX) {
    return '员工自己发起的工作：请填写 1 到 10 的整数。'
  }
  return validateKnowledgeDraft(draft)
}

/**
 * P38 知识库分区校验（界面侧先挡一层，core schema 是最终权威）：
 * - 关着也不允许存非法 https 地址（避免一开就炸）；开着则地址与协议名都必填；
 * - authRef 只接受据引用形状，明文形状（含空格）直接拦下；
 * - 协议名只收小写标识；maxBytes 收 core 同一上下限的整数。
 */
export function validateKnowledgeDraft(draft: SettingsDraft): string | null {
  const endpoint = draft.kbEndpoint.trim()
  if (endpoint.length > KB_ENDPOINT_MAX) return `知识库连接地址：不能超过 ${KB_ENDPOINT_MAX} 字`
  if (endpoint !== '') {
    let url: URL | null = null
    try { url = new URL(endpoint) } catch { url = null }
    if (url === null || url.protocol !== 'https:' || url.hostname === '') {
      return '知识库连接地址：必须是 https:// 开头的绝对地址（含主机名），不支持 http 或相对地址'
    }
  }
  if (draft.kbEnabled && endpoint === '') return '知识库：启用前必须填写 https 连接地址'
  const protocol = draft.kbProtocol.trim()
  if (protocol.length > KB_PROTOCOL_MAX) return `知识库协议名：不能超过 ${KB_PROTOCOL_MAX} 字`
  if (protocol !== '' && !/^[a-z][a-z0-9_-]*$/.test(protocol)) {
    return '知识库协议名：只能是小写字母开头的小写字母、数字、下划线或短横线'
  }
  if (draft.kbEnabled && protocol === '') {
    return '知识库：启用前必须填写协议适配名（实际访问方式确认前请保持关闭）。'
  }
  const authRef = draft.kbAuthRef.trim()
  if (authRef.length > KB_AUTH_REF_MAX) return `知识库凭据引用：不能超过 ${KB_AUTH_REF_MAX} 字。`
  if (!/^[\w.\-:/@]*$/.test(authRef)) {
    return '知识库凭据引用：请填写凭据在宿主安全存储中的名称（字母数字与 . - : / @ _），不要粘贴明文。'
  }
  if (draft.kbScope.length > KB_SCOPE_MAX) return `知识库检索范围：不能超过 ${KB_SCOPE_MAX} 字。`
  const bytes = Number(draft.kbMaxBytes)
  if (!Number.isInteger(bytes) || bytes < KB_MAX_BYTES_MIN || bytes > KB_MAX_BYTES_MAX) {
    return `知识库单条读取上限：请填写 ${KB_MAX_BYTES_MIN} 到 ${KB_MAX_BYTES_MAX} 字节的整数（默认 262144，即 256 KiB）。`
  }
  return null
}

/** 把表单里的知识库字段收成 core 配置形状；readOnly 锁死 true，本界面没有关闭只读的入口。 */
export function knowledgeConfigFromDraft(draft: SettingsDraft): KnowledgeBaseConfig {
  return {
    enabled: draft.kbEnabled,
    endpoint: draft.kbEndpoint.trim(),
    authRef: draft.kbAuthRef.trim(),
    protocol: draft.kbProtocol.trim(),
    scope: draft.kbScope.trim(),
    readOnly: true,
    maxBytes: Number(draft.kbMaxBytes),
  }
}

/**
 * 模型下拉的选项表（D07 第 7 条）：视图的 modelOptions（value 为 null 的那一项表示
 * 「跟随宿主默认模型」）加上「当前值已不在宿主目录」的额外项——否则下架的模型匹配
 * 不到任何选项，select 会显示成第一项，主人看到的与实际不符、也没法直接改回。
 */
export interface ModelOption { value: unknown; label: string }

export function modelSelectOptions(current: ModelChoice | undefined, options: ReadonlyArray<ModelOption>): ModelOption[] {
  const list = [...options]
  if (current == null) return list
  const present = list.some(option => JSON.stringify(option.value) === JSON.stringify(current))
  if (!present) {
    // 额外一项：当前值原样显示，并提示需要重新选择（它已不在宿主目录里）。
    list.push({ value: current, label: `${current.provider} / ${current.model}（已不在宿主目录，请重新选择）` })
  }
  return list
}

// ---------- 未保存草稿的本地暂存（第 8 轮巡检）----------
// 问题：设置页一切走就卸载，主人改了几项再点别的导航去看一眼，回来改动全没、没有任何提示。
// 做法与新建向导一致：编辑中把草稿落 localStorage，重新挂载时若「基线设置」没变就恢复，
// 保存成功后清掉。基线变了（设置在别处被改过）则丢弃旧草稿，避免把新设置覆盖回旧值。

// v3（P76k）：删去日报时间、两个通知上限与每位每天 token 上限，新增 botQuotaShare；
// v1、v2 的暂存缺这些字段，读到一律作废旧草稿（沿用权限字段变化时的写法）。
const SETTINGS_DRAFT_KEY = 'dsh-buddy:settings-draft:v3'

/** 可注入的持久层（默认浏览器 localStorage；测试传内存版）。 */
type SettingsDraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

function settingsStorage(): SettingsDraftStorage | null {
  try {
    const s = (globalThis as { localStorage?: SettingsDraftStorage }).localStorage
    return s ?? null
  } catch {
    return null
  }
}

/** 草稿相对的基线签名：序列化整份草稿做全等比较，任一字段不同即视为有改动。 */
function draftSignature(draft: SettingsDraft): string {
  return JSON.stringify(draft)
}

/** 暂存里的数据形状（version 字段留给以后字段变更时丢弃旧草稿）。 */
interface StashedSettingsDraft {
  version: 3
  baseSignature: string
  draft: SettingsDraft
}

/** 校验读回的对象确实是一份完整草稿（文本字段为字符串、开关为布尔、数字项为数字或数字串），坏数据一律当没有。 */
function isSettingsDraft(value: unknown): value is SettingsDraft {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  const textKeys = ['quietStart', 'quietEnd', 'pushChannel', 'defaultModel', 'kbEndpoint', 'kbAuthRef', 'kbProtocol', 'kbScope']
  return textKeys.every(key => typeof v[key] === 'string')
    && typeof v.kbEnabled === 'boolean'
    && ['botQuotaShare', 'botDailyTurnBudget', 'kbMaxBytes'].every(key => ['string', 'number'].includes(typeof v[key]))
}

/**
 * 暂存当前草稿；草稿与基线一致（没有未保存改动）时清掉暂存。
 * 读写全部 try/catch：隐私模式或超额时静默降级为不暂存，不影响设置页本身。
 */
export function stashSettingsDraft(draft: SettingsDraft, base: SettingsDraft, store: SettingsDraftStorage | null = settingsStorage()): void {
  try {
    if (draftSignature(draft) === draftSignature(base)) {
      store?.removeItem(SETTINGS_DRAFT_KEY)
      return
    }
    const payload: StashedSettingsDraft = { version: 3, baseSignature: draftSignature(base), draft }
    store?.setItem(SETTINGS_DRAFT_KEY, JSON.stringify(payload))
  } catch { /* 存不进去就算了，绝不能挡主人改设置 */ }
}

/**
 * 读回未保存草稿；读不到、数据坏、版本不认或基线设置已在别处变更时返回 null。
 * 基线不一致时顺手清掉这份过期草稿，免得以后一直带着。
 */
export function restoreSettingsDraft(base: SettingsDraft, store: SettingsDraftStorage | null = settingsStorage()): SettingsDraft | null {
  let raw: string | null
  try {
    raw = store?.getItem(SETTINGS_DRAFT_KEY) ?? null
  } catch {
    return null
  }
  if (raw === null) return null
  try {
    const value = JSON.parse(raw) as Partial<StashedSettingsDraft>
    if (value.version !== 3 || !isSettingsDraft(value.draft) || value.baseSignature !== draftSignature(base)) {
      store?.removeItem(SETTINGS_DRAFT_KEY)
      return null
    }
    return value.draft
  } catch {
    // JSON 本身坏掉：这份暂存永远读不开，顺手清掉，免得以后每次进设置都带着它。
    try { store?.removeItem(SETTINGS_DRAFT_KEY) } catch { /* 忽略 */ }
    return null
  }
}

/** 保存成功或主人放弃恢复后清掉暂存。 */
export function dropSettingsDraft(store: SettingsDraftStorage | null = settingsStorage()): void {
  try { store?.removeItem(SETTINGS_DRAFT_KEY) } catch { /* 忽略 */ }
}

/**
 * 拼成 updateSettings 的 patch（只带会改的字段；rootDir 不允许从这里改）。
 * D07 第 7 条：defaultModel 只在与加载值不同时才放进 patch——core 对带这个键的
 * 更新会按宿主目录重新校验，默认模型已下架时「只改通知方式」也会被拒。
 */
export function buildSettingsPatch(draft: SettingsDraft, loaded?: SettingsDraft): Record<string, unknown> {
  const patch: Record<string, unknown> = {
    quietHours: { start: draft.quietStart.trim(), end: draft.quietEnd.trim() },
    pushChannel: draft.pushChannel,
    botQuotaShare: Number(draft.botQuotaShare),
    // 每次带当前值（输入框始终渲染，不存在缺键场景）；core 闸门下一次判定即读新值。
    botDailyTurnBudget: Number(draft.botDailyTurnBudget),
  }
  if (loaded === undefined || loaded.defaultModel !== draft.defaultModel) {
    if (draft.defaultModel === '') patch.defaultModel = null
    else {
      try { patch.defaultModel = JSON.parse(draft.defaultModel) as unknown } catch { /* 校验已保证来源 */ }
    }
  }
  // P38：知识库配置只有相对已加载值发生变化时才进 patch（与 defaultModel 同口径），
  // 只改通知方式这类无关操作不重写知识库配置。形状由 core schema 最终校验。
  if (loaded === undefined
    || JSON.stringify(knowledgeConfigFromDraft(loaded)) !== JSON.stringify(knowledgeConfigFromDraft(draft))) {
    patch.knowledgeBase = knowledgeConfigFromDraft(draft)
  }
  return patch
}

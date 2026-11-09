/**
 * 设置页的校验与拼装（纯函数）：免打扰时段、日报时间、推送渠道、单推上限、默认模型。
 * 界面先校验再 POST updateSettings；非法值给中文提示、不能保存。
 */
import type { Settings } from '@agent-hub/core'
import type { ModelChoice } from '../../shared/views.js'

/** HH:mm 校验（5 分钟为单位由输入控件 step 保证，这里只查形状）。 */
export function validateClockTime(value: string, field: string): string | null {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value.trim())) return `${field}：要写成 HH:mm（例如 23:00）`
  return null
}

export interface SettingsDraft {
  quietStart: string
  quietEnd: string
  digestAt: string
  pushChannel: string
  dailyPushCap: number | string   // 字符串是输入框原样，保存前转数字
  botDailyPushCap: number | string
  defaultModel: string            // '' = 跟随 DSH 默认
}

/** 从 SettingsView 的 settings 派生表单草稿。 */
export function draftFromSettings(settings: Settings): SettingsDraft {
  return {
    quietStart: settings.quietHours.start,
    quietEnd: settings.quietHours.end,
    digestAt: settings.digestAt,
    pushChannel: settings.pushChannel,
    dailyPushCap: String(settings.dailyPushCap),
    botDailyPushCap: String(settings.botDailyPushCap),
    defaultModel: settings.defaultModel === null ? '' : JSON.stringify(settings.defaultModel),
  }
}

/** 校验整份草稿；返回第一条错误（中文、说清哪一项不对）。 */
export function validateSettingsDraft(draft: SettingsDraft): string | null {
  const start = validateClockTime(draft.quietStart, '免打扰开始')
  if (start !== null) return start
  const end = validateClockTime(draft.quietEnd, '免打扰结束')
  if (end !== null) return end
  const digest = validateClockTime(draft.digestAt, '日报时间')
  if (digest !== null) return digest
  if (!['dsh', 'macos', 'none'].includes(draft.pushChannel)) return '推送渠道：只能选 macOS 通知 / 不推 / 宿主'
  const whole = Number(draft.dailyPushCap)
  if (!Number.isInteger(whole) || whole < 0 || whole > 10) return '每日单推上限（全体）：0 到 10 的整数'
  const perBot = Number(draft.botDailyPushCap)
  if (!Number.isInteger(perBot) || perBot < 0 || perBot > 3) return '每日单推上限（每个队友）：0 到 3 的整数'
  if (perBot > whole) return '每个队友的单推上限不能超过全体上限'
  return null
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
    // 额外一项：当前值原样显示，并提示需要换一个（它已不在宿主目录里）。
    list.push({ value: current, label: `${current.provider} / ${current.model}（已不在宿主目录，请换一个）` })
  }
  return list
}

/**
 * 拼成 updateSettings 的 patch（只带会改的字段；rootDir 不允许从这里改）。
 * D07 第 7 条：defaultModel 只在与加载值不同时才放进 patch——core 对带这个键的
 * 更新会按宿主目录重新校验，默认模型已下架时「只改推送渠道」也会被拒。
 */
export function buildSettingsPatch(draft: SettingsDraft, loaded?: SettingsDraft): Record<string, unknown> {
  const patch: Record<string, unknown> = {
    quietHours: { start: draft.quietStart.trim(), end: draft.quietEnd.trim() },
    digestAt: draft.digestAt.trim(),
    pushChannel: draft.pushChannel,
    dailyPushCap: Number(draft.dailyPushCap),
    botDailyPushCap: Number(draft.botDailyPushCap),
  }
  if (loaded === undefined || loaded.defaultModel !== draft.defaultModel) {
    if (draft.defaultModel === '') patch.defaultModel = null
    else {
      try { patch.defaultModel = JSON.parse(draft.defaultModel) as unknown } catch { /* 校验已保证来源 */ }
    }
  }
  return patch
}

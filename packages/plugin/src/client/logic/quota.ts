/**
 * 额度灯的人话翻译（交互审查第 4 条；P76j 改读额度窗口视图）。
 *
 * 有 core 的 quotaWindowView（新宿主）时，文字一律取视图的 lightLabel、lightHint：
 * 灯的四档不再按「额度是否紧张」笼统地说，而是说清「员工份额用到几成、红灯时员工什么时候恢复」。
 * 旧宿主没有这个视图时退回原来的四档文字；红灯那句原来写「员工会等到明天恢复」，
 * 与事实不符（额度窗口 5 小时一滚，不是按天），P76j 按任务卡改成「员工会等额度窗口恢复」。
 */
import type { Light, QuotaWindowView } from '../../shared/views.js'
import { formatTokenTitle } from '../../shared/token-format.js'

export interface QuotaMeaning {
  /** 顶栏直接显示的一句话结论。 */
  label: string
  /** 悬停或读屏时使用的解释，说明这个状态意味着什么。 */
  hint: string
}

/** 旧宿主（没有额度窗口视图）的四档文字。 */
function legacyMeaning(light: Light): QuotaMeaning {
  switch (light) {
    case 'green':
      return { label: '额度充足', hint: '今天的模型额度够用，员工可以正常思考' }
    case 'yellow':
      return { label: '额度偏紧', hint: '今天的模型额度开始吃紧，员工会放慢节奏' }
    case 'orange':
      return { label: '额度紧张', hint: '模型额度即将用尽，仅紧急事项会唤醒员工。' }
    case 'red':
      // P76j：原句「员工会等到明天恢复」与事实不符——额度窗口 5 小时一滚，不是按天恢复。
      return { label: '额度用完', hint: '今天的模型额度已经用完，员工会等额度窗口恢复' }
    default:
      return { label: '额度状态未知', hint: '暂时读不到额度状态' }
  }
}

/** 顶栏额度文字：新宿主读视图，旧宿主退回四档。 */
export function quotaMeaning(light: Light, window?: QuotaWindowView | null): QuotaMeaning {
  if (window === undefined || window === null) return legacyMeaning(light)
  return { label: window.lightLabel, hint: window.lightHint }
}

/**
 * P86：顶栏额度文字里「用量」的那一段：`{员工已用回合}（{token 文字}），{员工还可用回合}`。
 * 例：「员工已用约 8 回合（1.76M token），员工还可用约 32 回合」。
 *
 * - 有窗口视图且视图带 token 文字：把 token 文字插在「已用回合」之后；
 * - 视图没有 token 文字（旧宿主）：退回原写法「已用回合，还可用回合」，不报错；
 * - 没有窗口视图（更老的宿主）：用宿主给的 usedText 原样显示。
 * full 为真时 token 写完整数字（悬停提示用，带千位分隔符），否则写换算后的短写法（顶栏、无障碍标签用）。
 * 文字全部由 core 的视图给出，这里只负责拼接，不换算、不另算数字。
 */
export function quotaUsedLine(window: QuotaWindowView | null | undefined, legacyUsedText: string, full: boolean): string {
  if (window === undefined || window === null) return legacyUsedText
  const tokenText = window.staffUsedTokensText
  if (tokenText === undefined) return `${window.staffUsedTurnsText}，${window.staffLeftTurnsText}`
  const shown = full && window.staffUsedTokens !== undefined ? formatTokenTitle(window.staffUsedTokens) : tokenText
  return `${window.staffUsedTurnsText}（${shown}），${window.staffLeftTurnsText}`
}

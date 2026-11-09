/**
 * 额度灯的人话翻译（交互审查第 4 条）：
 * core 返回 green/yellow/orange/red 与「充足/留意/紧张/暂停」这种单词，主人只看单词
 * 不知道它指的是「模型额度」、也不知道后果。这里只做展示层翻译：结论加「额度」前缀，
 * 再配一句后果解释；颜色与状态仍来自 OverviewView.quota.light，不改变任何数据来源。
 */
import type { Light } from '../../shared/views.js'

export interface QuotaMeaning {
  /** 顶栏直接显示的一句话结论。 */
  label: string
  /** 悬停或读屏时使用的解释，说明这个状态意味着什么。 */
  hint: string
}

export function quotaMeaning(light: Light): QuotaMeaning {
  switch (light) {
    case 'green':
      return { label: '额度充足', hint: '今天的模型额度够用，队友可以正常思考' }
    case 'yellow':
      return { label: '额度偏紧', hint: '今天的模型额度开始吃紧，队友会放慢节奏' }
    case 'orange':
      return { label: '额度紧张', hint: '模型额度即将用尽，仅紧急事项会唤醒队友。' }
    case 'red':
      return { label: '额度用完', hint: '今天的模型额度已经用完，队友会等到明天恢复' }
    default:
      return { label: '额度状态未知', hint: '暂时读不到额度状态' }
  }
}

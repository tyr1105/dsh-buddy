/**
 * 界面现在会画的卡片视图种类（白名单）与类型守卫。
 *
 * 做什么：把核心的卡片视图联合类型（JobCardView）收窄到「界面会画的几种」。
 * 为什么用白名单而不是「排除 retro」：核心以后再增加新的种类（例如 skill_check）时，
 *   白名单之外的种类自动被视为「不会画」，插件不用再改也能通过类型检查，
 *   运行时也不会因为取不到字段而抛错。
 *
 * 复盘卡（retro）、技能核对卡（skill_check）原本由 P75k 才画，在那之前不显示；
 *   P75k 画出这两种卡（components/SkillCards.tsx）之后，把它们加进白名单。
 *   这两种卡没有证据清单、没有截图编号（与三轮不过卡、回执一样），折叠组里的截图定位逻辑据此跳过它们。
 * 以后核心再增加新的种类时，仍然是「画好了才加进白名单」：白名单之外的种类自动被视为「不会画」。
 */
import type { JobCardView } from './views.js'

/** 界面现在会画的种类。新增种类并画好界面后，才把它加进这里。 */
export const DRAWABLE_JOB_CARD_KINDS = ['submission', 'review', 'delivery', 'escalation', 'receipt', 'retro', 'skill_check'] as const

/** 界面会画的卡片视图（从核心联合里按白名单取出）。 */
export type DrawableJobCardView = Extract<JobCardView, { kind: (typeof DRAWABLE_JOB_CARD_KINDS)[number] }>

/** 类型守卫：card 的种类在白名单内才为真；其余（含将来核心新增的种类）一律为假。 */
export function isDrawableJobCard(card: JobCardView | null | undefined): card is DrawableJobCardView {
  if (card === null || card === undefined) return false
  return (DRAWABLE_JOB_CARD_KINDS as readonly string[]).includes(card.kind)
}

/**
 * 唤醒记录的展示规则（交互审查第 4 轮，抬高上限）：
 * 右栏「为什么醒 / 为什么没醒」默认折叠，但当机器人此刻有进行中的唤醒
 * （running：正在想和做；delivering：正要把东西交给主人）时，
 * 主人最想知道的是「它现在在干什么」——分区应自动展开并亮出「进行中」标记。
 * 规则做成纯函数，输入显式、可单测（AGENTS.md：规则计算写成纯函数）。
 */
import type { WakeRow, WakeStatus } from '../../shared/views.js'

/** 表示唤醒还在进行中的状态：已提交（committed）等终态不算。 */
const LIVE_WAKE_STATUSES: ReadonlySet<WakeStatus> = new Set<WakeStatus>(['running', 'delivering'])

/** 最近唤醒里是否有一条还在进行中。 */
export function hasLiveWake(wakes: readonly WakeRow[]): boolean {
  return wakes.some(w => LIVE_WAKE_STATUSES.has(w.status))
}

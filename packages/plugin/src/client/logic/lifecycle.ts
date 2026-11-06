/**
 * 生命周期按钮的纯逻辑（D07 第 24 条）：右栏、线程头部、设置页三处共用，
 * 保证「按机器人当前状态只显示合法的按钮」这条规则只有一份实现、可单测。
 * 资格与 core 的 lifecycleAction 一致（api/bots.ts）：
 * - pause 限在岗（active）/ 试岗（probation）；
 * - resume 限暂停（paused）；
 * - promote（提前转正）限试岗；
 * - release_quarantine（解除停用）限隔离（quarantined）；
 * - retire 除了已退役都显示（退役不可逆，二次确认在组件里做）。
 */
import type { Lifecycle } from '../../shared/views.js'

/** 一个生命周期按钮：动作名（lifecycleAction 的 action）+ 中文标签。 */
export interface LifecycleButton { action: 'pause' | 'resume' | 'promote' | 'release_quarantine' | 'retire'; label: string }

/** 右栏详情的按钮全集（含退役）；按当前状态只返回合法项。 */
export function lifecycleButtons(lifecycle: Lifecycle): LifecycleButton[] {
  const buttons: LifecycleButton[] = []
  if (lifecycle === 'active' || lifecycle === 'probation') buttons.push({ action: 'pause', label: '暂停' })
  if (lifecycle === 'paused') buttons.push({ action: 'resume', label: '恢复' })
  if (lifecycle === 'quarantined') buttons.push({ action: 'release_quarantine', label: '解除停用' })
  if (lifecycle === 'probation') buttons.push({ action: 'promote', label: '提前转正' })
  if (lifecycle !== 'retired') buttons.push({ action: 'retire', label: '退役' })
  return buttons
}

/** 线程头部只放暂停/恢复（其余去右栏）；当前状态没有合法动作时返回 null。 */
export function pauseResumeAction(lifecycle: Lifecycle): 'pause' | 'resume' | null {
  if (lifecycle === 'active' || lifecycle === 'probation') return 'pause'
  if (lifecycle === 'paused') return 'resume'
  return null
}

/** 「全部暂停 / 全部恢复」要操作的机器人 id（D07 第 24 条：选目标也是纯函数）。 */
export function lifecycleAllTargets(bots: ReadonlyArray<{ id: string; lifecycle: Lifecycle }>, target: 'paused' | 'active'): string[] {
  const wanted: Lifecycle[] = target === 'paused' ? ['active', 'probation'] : ['paused']
  return bots.filter(bot => wanted.includes(bot.lifecycle)).map(bot => bot.id)
}

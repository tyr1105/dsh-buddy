/**
 * 键盘切换空间后的焦点归位（P43）。
 *
 * 为什么单独成文件：生产入口与隔离预览都要同一套行为，复制两份容易走样；
 * 这里只依赖一个最小的 querySelector 接口，便于用假文档单测重试与兜底。
 *
 * 规则：队友侧优先把焦点交给队友导航第一行（侧栏或页面内列表都可能晚一两帧挂载，
 * 因此最多重试 10 帧）；对话侧不去碰宿主原生列表，只把焦点放回「对话」按钮；
 * 都找不到时同样退回切换按钮，保证焦点不会丢在 body 上。
 */
import type { SpaceMode } from './space-capability.js'

/** 只要一个 querySelector：真实调用传 document，测试传假对象。 */
export interface FocusDoc {
  querySelector(selector: string): Element | null
}

/** 下一帧调度器：默认用 requestAnimationFrame，测试可传同步队列。 */
export type FrameScheduler = (run: () => void) => void

/** 队友侧的第一可操作项，按优先级排列（P44 起首项是办公室入口，不再是旧列表的第一行）。 */
const TEAM_TARGETS = ['.ah-team-sidebar .ah-nav-office', '.ah-team-sidebar .ah-sidebar-nav button', '.ah-team-sidebar button']
/** 最多等多少帧：约 160ms，足够侧栏/页面完成挂载，又不会让键盘用户等太久。 */
const MAX_RETRIES = 10

/** 当前模式的切换按钮选择器：最后的焦点兜底。 */
function switchButtonSelector(mode: SpaceMode): string {
  return `.ah-space-switch-btn[data-space-mode="${mode}"]`
}

/**
 * 把焦点归位到当前模式的第一个可操作项。
 * 返回是否成功落到内容区（false 表示退回了切换按钮或找不到任何节点）。
 */
export function focusAfterSwitch(mode: SpaceMode, doc: FocusDoc, schedule?: FrameScheduler): boolean {
  const nextFrame = schedule ?? (typeof requestAnimationFrame === 'function'
    ? (run: () => void) => { requestAnimationFrame(run) }
    : null)
  const focus = (selector: string): boolean => {
    try {
      const node = doc.querySelector(selector)
      if (node && typeof (node as HTMLElement).focus === 'function') {
        (node as HTMLElement).focus()
        return true
      }
    } catch { /* 焦点归位失败不影响切换本身 */ }
    return false
  }
  const fallback = (): boolean => focus(switchButtonSelector(mode))

  // 对话侧没有可安全聚焦的宿主节点：直接回切换按钮，不越权聚焦原生列表。
  if (mode !== 'team') return fallback()

  // 没有下一帧能力时只能立即尝试一次。
  if (nextFrame === null) {
    for (const selector of TEAM_TARGETS) if (focus(selector)) return true
    return fallback()
  }

  let tries = 0
  let landed = false
  const run = (): void => {
    for (const selector of TEAM_TARGETS) {
      if (focus(selector)) { landed = true; return }
    }
    if (tries < MAX_RETRIES) {
      tries += 1
      nextFrame(run)
      return
    }
    fallback()
  }
  // 等两帧再找：切换触发的渲染与挂载先落定，避免抓到即将卸载的旧节点。
  nextFrame(() => nextFrame(run))
  return landed
}

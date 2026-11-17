/**
 * 页面可见时的「你正在看」上报（P76k，方案 7.9）：挂载时一次、之后每 5 分钟一次，
 * 页面由隐藏变为可见时立刻再报一次，隐藏时停。
 *
 * 为什么单独成文件：这套节奏要能用假计时器写测试（挂载一次、每 5 分钟一次、隐藏时不报），
 * 塞在页面组件里只能靠真浏览器点；这里只做计时与开关，发不发命令、失败怎么处理由页面决定。
 * 间隔与 core 的 `BUDGET_DEFAULTS.OWNER_SEEN_INTERVAL_MS`（5 分钟）相同，两处同步。
 */
export const OWNER_SEEN_INTERVAL_MS = 5 * 60 * 1000

export interface OwnerSeenReporter {
  /** 现在上报一次（挂载与由隐藏变为可见时各调一次）。 */
  reportNow: () => void
  /** 开始按间隔上报；已经在上报时什么都不做。 */
  start: () => void
  /** 停止按间隔上报；没有在跑时什么都不做。 */
  stop: () => void
  /** 可见性变化：隐藏就停，可见就先报一次再开始。 */
  onVisibilityChange: () => void
  /** 当前是否在按间隔上报（测试与页面排错用）。 */
  isRunning: () => boolean
}

/** 造一个上报节奏控制器；定时器与「是否隐藏」都从外面给，测试用假计时器与假判断。 */
export function createOwnerSeenReporter(options: {
  report: () => void
  hidden: () => boolean
  everyMs?: number
  setInterval?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>
  clearInterval?: (timer: ReturnType<typeof setInterval>) => void
}): OwnerSeenReporter {
  const everyMs = options.everyMs ?? OWNER_SEEN_INTERVAL_MS
  const setTimer = options.setInterval ?? ((fn, ms) => setInterval(fn, ms))
  const clearTimer = options.clearInterval ?? ((timer) => clearInterval(timer))
  let timer: ReturnType<typeof setInterval> | null = null
  const reportNow = (): void => {
    try { options.report() } catch { /* 上报失败只影响这一次，不能抛出 */ }
  }
  const stop = (): void => {
    if (timer === null) return
    clearTimer(timer)
    timer = null
  }
  const start = (): void => {
    if (timer !== null) return
    timer = setTimer(reportNow, everyMs)
  }
  return {
    reportNow,
    start,
    stop,
    onVisibilityChange() {
      if (options.hidden()) { stop(); return }
      reportNow()
      start()
    },
    isRunning: () => timer !== null,
  }
}

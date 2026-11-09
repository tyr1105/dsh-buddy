/**
 * 引擎心跳：ctx.effect 包 setInterval，每 intervalMs 调一次 hub.tick()。
 * 防重入：tick 上一轮没结束就跳过本次（core 内部也有防重入，这里是宿主侧第二道，
 * 避免串行队列里堆积无意义的排队 Promise）。回调里的同步与异步异常都兜住
 * （未捕获异常会让整个 DSH 退出，红线第 5 条）。定时器 unref，不挂住进程退出。
 */
import type { Hub } from '@agent-hub/core'

export interface TickScheduler {
  start(): void
  stop(): void
  /** 当前是否正有一次 tick 在跑（测试断言用）。 */
  isTicking(): boolean
}

export function createTickScheduler(hub: Pick<Hub, 'tick'>, intervalMs: number): TickScheduler {
  let timer: ReturnType<typeof setInterval> | null = null
  let ticking = false
  const run = () => {
    if (ticking) return
    ticking = true
    // 手册 2.6：先把 tick 调用推迟一拍再兜错——hub.tick 若同步抛错（当前 core 不会，
    // 但要按契约防御），Promise.resolve(hub.tick()) 接不住，会让整个 DSH 退出。
    Promise.resolve().then(() => hub.tick())
      .catch(error => console.error('[agent-hub] tick 失败:', error))
      .finally(() => { ticking = false })
  }
  return {
    start() {
      if (timer !== null) return
      timer = setInterval(run, intervalMs)
      if (typeof (timer as { unref?: () => void }).unref === 'function') (timer as { unref: () => void }).unref()
    },
    stop() {
      if (timer === null) return
      clearInterval(timer)
      timer = null
    },
    isTicking: () => ticking,
  }
}

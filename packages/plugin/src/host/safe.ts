/**
 * safe()：把「脱离 apply 的回调」包起来，一个机器人出错绝不带崩 DSH。
 * 照 verified-T1 Q4 的结论实现：
 * - 同步异常与异步拒绝都只记日志（console.*，前缀 [agent-hub]）；
 * - 一律返回 undefined：serial/bail 派发的事件（如 agent/created）会把非空返回值当短路值；
 * - waterfall 钩子（tools/pre-execute、agent/pre-step）不要用它，必须自己 return next()。
 */

/** 包装函数：fn 抛错或 reject 只记日志，调用方永远拿到 undefined（或 undefined 的 Promise 也不给，直接 undefined）。 */
export function safe<TArgs extends unknown[]>(
  label: string,
  fn: (...args: TArgs) => unknown,
): (...args: TArgs) => undefined {
  return function guarded(this: unknown, ...args: TArgs): undefined {
    try {
      const result = fn.apply(this, args)
      if (result && typeof (result as { then?: unknown }).then === 'function') {
        // 异步拒绝也要有人接，否则成为未处理拒绝，宿主 installFailLoud 会 exit(1)。
        void (result as Promise<unknown>).then(undefined, (error: unknown) => {
          console.error(`[agent-hub] ${label} failed:`, error)
        })
      }
    } catch (error) {
      console.error(`[agent-hub] ${label} failed:`, error)
    }
    // 关键：永远返回 undefined，避免 serial/bail 事件被短路。
    return undefined
  }
}

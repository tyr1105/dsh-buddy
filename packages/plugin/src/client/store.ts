/**
 * 最小可观察仓库：订阅、快照、useSyncExternalStore 钩子。
 * 为什么自己写：不能 require 任何 Harness 客户端包（官方 practices 禁止），
 * 而数据仓库只需要「一处状态、多处订阅」这一点点能力。
 */
import { useSyncExternalStore } from 'react'

export interface Store<T> {
  getSnapshot(): T
  subscribe(fn: () => void): () => void
  set(next: T): void
  update(fn: (prev: T) => T): void
}

/** 建一个仓库；set 会浅比较旧值，相同引用不通知，避免无谓重渲染。 */
export function createStore<T>(initial: T): Store<T> {
  let snapshot = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe(fn) {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
    set(next) {
      if (next === snapshot) return
      snapshot = next
      for (const fn of [...listeners]) {
        try { fn() } catch (error) { console.error('[agent-hub] store 通知出错:', error) }
      }
    },
    update(fn) { this.set(fn(snapshot)) },
  }
}

/** 在组件里读仓库；getServerSnapshot 与客户端一致（本插件只跑浏览器）。 */
export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}

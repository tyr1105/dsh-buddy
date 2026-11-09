/**
 * 右栏内联编辑的键盘与焦点约定（U01 第 10 轮巡检）：
 * - 输入框 / 文本域里按 Esc 等于点「取消」：丢弃未保存修改并退出编辑态；
 *   输入法组词期间（isComposing / keyCode 229）不抢 Esc，先让输入法自己收词。
 * - 编辑态退出（保存或取消）后，把焦点还给打开它的触发按钮，键盘主人不用重新找位置；
 *   触发按钮已不在 DOM（如条目被收起、目标状态变化）时不硬抢，交给浏览器默认。
 * 与 use-dialog-focus 的分工：那个管模态弹窗（Tab 困守、遮罩不点穿），本文件只管
 * 右栏就地展开的内联编辑（改志向、编辑档案、套路步骤、目标放弃 / 验收二次确认）。
 */
import { useEffect, useRef, type KeyboardEvent } from 'react'

/** 文本控件的 Esc 转「取消」：组词期让位；stopPropagation 防止冒泡成右栏整体收起。 */
export function escToCancel(event: KeyboardEvent, close: () => void): void {
  if (event.key !== 'Escape') return
  // 中文输入法组词时 Esc 用来取消候选词，这一下不能被我们解释成「退出编辑」。
  if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
  event.preventDefault()
  event.stopPropagation()
  close()
}

/**
 * 内联编辑开关的焦点归还。editingId 从非 null 变 null 的那一刻，把焦点还给同 id
 * 的触发按钮。触发按钮在编辑期间卸载、关闭后重挂，而 ref 回调在 passive effect
 * 之前执行，所以 effect 里从 Map 拿到的已经是重挂后的新节点，直接 focus 即可。
 * 布尔型编辑态（如「编辑档案」）请传固定 id（例：editing ? 'profile' : null）。
 */
export function useReturnFocus(editingId: string | null): {
  /** 挂在触发按钮上的 ref 回调：挂载登记、卸载移除，同一个 id 始终拿到最新节点。 */
  registerTrigger: (id: string) => (el: HTMLButtonElement | null) => void
} {
  const triggers = useRef(new Map<string, HTMLButtonElement>())
  const prevIdRef = useRef<string | null>(editingId)
  useEffect(() => {
    const closedId = prevIdRef.current
    if (closedId !== null && editingId === null) {
      const trigger = triggers.current.get(closedId)
      // 节点已不在（条目被收起 / 删除 / 状态切换）就交给浏览器默认，绝不硬焦点。
      if (trigger?.isConnected) trigger.focus()
    }
    prevIdRef.current = editingId
  }, [editingId])
  const registerTrigger = (id: string) => (el: HTMLButtonElement | null): void => {
    if (el) triggers.current.set(id, el)
    else triggers.current.delete(id)
  }
  return { registerTrigger }
}

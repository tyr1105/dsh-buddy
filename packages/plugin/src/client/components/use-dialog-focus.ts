/**
 * 对话框键盘与模态管理：打开时聚焦内部控件，Tab 不逃到背景，Esc 关闭并把焦点还给
 * 触发按钮；提交期间不关闭，避免异步结果返回时主人误以为已经取消。
 *
 * 两个时序细节（U01 第 9 轮巡检实测得出，别轻易改回去）：
 * 1. 触发按钮必须在「渲染期」缓存：各弹窗主字段都带 autoFocus，React 在 commit 阶段
 *    就把焦点移进了弹窗，等到 useEffect 里再读 document.activeElement，读到的是弹窗内
 *    字段；卸载时该字段已随弹窗一起消失，焦点就只能落回 body，没法还给触发按钮。
 * 2. 打开后若 autoFocus 已把焦点放进弹窗，就不要再抢（旧逻辑无条件聚焦第一个可聚焦
 *    元素=头部「关闭」，既盖掉了字段的 autoFocus，还让误触回车直接关掉整个弹窗）。
 *
 * 背景 inert（U01 第 13 轮）：遮罩是 fixed 全屏，视觉上盖住一切，但屏幕阅读器的虚拟
 * 光标仍能读到遮罩下层。弹窗打开期间沿「插件页面根 → 遮罩」的祖先链，把每一层不在
 * 链上的兄弟节点打 inert（含顶栏），遮罩子树保持可用；关闭时按记录的原值逐节点还原。
 * 与右栏抽屉的 useDrawerFocus 各自记录、各自还原：弹窗叠在抽屉上时两套 inert 叠加，
 * 弹窗关闭只撤自己打过的标记，抽屉的背景隔离仍然成立。
 */
import { useEffect, useRef } from 'react'

export function useDialogFocus(onClose: () => void, busy: boolean) {
  const ref = useRef<HTMLDivElement>(null)
  const latest = useRef({ onClose, busy })
  latest.current = { onClose, busy }
  /**
   * 弹窗打开前的焦点主人（一般是被点的那个按钮）。用惰性 ref 在首次渲染时读一次：
   * 此刻弹窗尚未进 DOM、子节点的 autoFocus 还没发生，读到的正是触发按钮。
   * 只读取不修改，SSR 无影响；本插件只在宿主渲染进程里用。
   */
  const previousRef = useRef<HTMLElement | null | undefined>(undefined)
  if (previousRef.current === undefined) {
    previousRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
  }

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    const controls = () => Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]')).filter(el => el.getClientRects().length > 0)
    // autoFocus 已把焦点放进弹窗就尊重它；否则优先首个表单字段，再退到非头部按钮
    // （避免焦点落在头部「关闭」上，误触回车即关窗），最后才是弹窗自身。
    if (!dialog.contains(document.activeElement)) {
      const field = dialog.querySelector<HTMLElement>('input:not(:disabled), textarea:not(:disabled), select:not(:disabled)')
      const nonHeaderButton = Array.from(dialog.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')).find(b => b.closest('header') === null)
      ;(field ?? nonHeaderButton ?? dialog).focus()
    }
    const keydown = (event: KeyboardEvent): void => {
      try {
        if (event.key === 'Escape') {
          // 中文输入法组词时 Esc 是用来取消候选词的，不能当成关窗（编辑队友的表单在弹窗里，主人常在这里打字）。
          if (event.isComposing || event.keyCode === 229) return
          event.preventDefault(); event.stopPropagation()
          if (!latest.current.busy) latest.current.onClose()
        }
        if (event.key !== 'Tab') return
        const items = controls()
        const first = items[0], last = items.at(-1)
        if (!first) { event.preventDefault(); dialog.focus(); return }
        if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) { event.preventDefault(); first.focus() }
      } catch { /* 单个控件失效不影响宿主。 */ }
    }
    dialog.addEventListener('keydown', keydown)

    // ---------- 背景 inert：把弹窗祖先链之外的页面内容全部移出无障碍树与 Tab 序列 ----------
    // 页面根带 data-plugin-page；找不到时退化为遮罩的父节点，保证逻辑在任何挂载点都不报错。
    const root = dialog.closest<HTMLElement>('[data-plugin-page]') ?? dialog.parentElement
    // 每个被本 hook 打过 inert 的节点及其原值：还原时一个不差地恢复，不替别的主人改状态。
    const inerted = new Map<HTMLElement, boolean>()
    let observer: MutationObserver | null = null
    if (root) {
      // 祖先链：根之下、遮罩之上（含遮罩）每一层的直系节点。链上节点保持可用，
      // 同一层的其他兄弟就是这一层「弹窗之外的世界」，全部 inert。
      const chain: HTMLElement[] = []
      let cursor: HTMLElement | null = dialog
      while (cursor && cursor !== root) {
        chain.unshift(cursor)
        cursor = cursor.parentElement
      }
      /** 幂等同步：重复调用只补打新增节点，原值只在第一次命中时记录。全程 try/catch 兜底。 */
      const applyInert = (): void => {
        try {
          let parent: HTMLElement = root
          for (const current of chain) {
            for (const kid of Array.from(parent.children)) {
              if (!(kid instanceof HTMLElement) || kid === current) continue
              if (!inerted.has(kid)) inerted.set(kid, kid.inert)
              kid.inert = true
            }
            parent = current
          }
        } catch { /* 节点被替换时由 MutationObserver 下一轮补齐，绝不带崩宿主 */ }
      }
      applyInert()
      // SSE 刷新/重渲染可能替换背景子树：新节点不会自带 inert，监听根下子节点增删后补打。
      try {
        if (typeof MutationObserver !== 'undefined') {
          observer = new MutationObserver(() => applyInert())
          observer.observe(root, { childList: true, subtree: true })
        }
      } catch { /* 老环境没有 MO 时退化为打开时刻一次性同步，键盘困守仍独立生效 */ }
    }

    return () => {
      dialog.removeEventListener('keydown', keydown)
      try { observer?.disconnect() } catch { /* 忽略 */ }
      try {
        for (const [kid, prev] of inerted) kid.inert = prev
      } catch { /* 节点已随弹窗一起卸载时无需还原 */ }
      // 还给当初打开弹窗的按钮（节点已不在则交给浏览器默认，不强焦点）。
      const previous = previousRef.current
      if (previous?.isConnected) previous.focus()
    }
  }, [])
  return ref
}

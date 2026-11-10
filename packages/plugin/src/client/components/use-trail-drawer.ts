/**
 * 员工动线抽屉的键盘与读屏规则（P62）。
 *
 * 背景：动线面板在窄窗（容器 760 及以下）是盖在办公室上的抽屉，带遮罩——视觉上已经是
 * 模态。如果不处理，Tab 键和读屏软件还能走到遮罩下面的房间按钮上，这是右栏抽屉在
 * U01 巡检里修过的同一类问题。本 hook 只在抽屉模式下补齐这些语义：
 * 1. 面板带上 role="dialog" aria-modal="true"，背景打 inert（读屏和 Tab 都进不去）；
 * 2. Tab 困在面板里，打开时焦点移进面板；
 * 3. 收起后把焦点还给点开它的那个小人或图例按钮。
 * 宽屏是普通侧栏，不抢焦点、背景不 inert，主人可以一边开着一边点别的小人。
 *
 * 为什么不直接用右栏的 useDrawerFocus：那个 hook 写死了右栏的遮罩类名，并把 .ah-body 的
 * 直接子节点全部打 inert；动线面板就在其中一个子节点里面，直接用会把自己也禁掉。
 *
 * 判断抽屉模式的办法和右栏一样：读遮罩的实时样式（宽屏 CSS 把它设成 display:none），
 * 不在脚本里再抄一遍断点。所有回调都有兜底，这里出错只影响焦点，不能带崩宿主。
 */
import { useEffect, useRef, type RefObject } from 'react'

/** 面板里可以 Tab 到的控件。 */
const FOCUSABLE = 'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]'

/**
 * @param triggerKey 面板当前对应的队友 id：换人时重新记录「是谁打开的」。
 */
export function useTrailDrawer(triggerKey: string): {
  panelRef: RefObject<HTMLElement>
  scrimRef: RefObject<HTMLDivElement>
} {
  const panelRef = useRef<HTMLElement>(null)
  const scrimRef = useRef<HTMLDivElement>(null)
  /** 打开这个面板的控件；收起后焦点还给它。 */
  const triggerRef = useRef<HTMLElement | null>(null)

  // 必须排在下面那个 effect 前面：先记下触发按钮，再把焦点移进抽屉。
  useEffect(() => {
    try {
      const active = document.activeElement
      if (active instanceof HTMLElement && active !== document.body && !panelRef.current?.contains(active)) {
        triggerRef.current = active
      }
    } catch { /* 读不到焦点只影响收起后的焦点归还 */ }
  }, [triggerKey])

  useEffect(() => {
    const panel = panelRef.current
    const scrim = scrimRef.current
    if (panel === null || scrim === null) return

    /** 遮罩显示就是抽屉模式；每次用时实时读，拖动窗口变宽变窄都能跟上。 */
    const drawerMode = (): boolean => getComputedStyle(scrim).display !== 'none'

    /** 面板以外的整个背景：从面板往上走到 .ah-body，沿路的兄弟节点都算，遮罩自己除外。 */
    const backgroundNodes = (): HTMLElement[] => {
      const nodes: HTMLElement[] = []
      const body = panel.closest<HTMLElement>('.ah-body')
      let current: HTMLElement = panel
      while (body !== null && current !== body && current.parentElement !== null) {
        for (const sibling of Array.from(current.parentElement.children)) {
          if (sibling !== current && sibling !== scrim && sibling instanceof HTMLElement) nodes.push(sibling)
        }
        current = current.parentElement
      }
      return nodes
    }

    // 记下每个节点原来的 inert 值，还原时一个不差。
    const inerted = new Map<HTMLElement, boolean>()
    const restoreBackground = (): void => {
      for (const [node, previous] of inerted) node.inert = previous
      inerted.clear()
    }

    /** 按当前模式同步模态语义；可以重复调用，不会叠加。 */
    const syncModal = (): void => {
      try {
        if (drawerMode()) {
          panel.setAttribute('role', 'dialog')
          panel.setAttribute('aria-modal', 'true')
          for (const node of backgroundNodes()) {
            if (!inerted.has(node)) inerted.set(node, node.inert)
            node.inert = true
          }
        } else {
          panel.removeAttribute('role')
          panel.removeAttribute('aria-modal')
          restoreBackground()
        }
      } catch { /* 个别节点失效时，下一次同步再补 */ }
    }

    /** Tab 困守：挂在 document 捕获阶段，焦点掉到背景时也能拦住。 */
    const keydown = (event: KeyboardEvent): void => {
      try {
        if (event.key !== 'Tab' || !drawerMode()) return
        // 面板上又开了弹窗时，键盘归弹窗自己管。
        if (document.querySelector('.ah-dialog-mask') !== null) return
        const controls = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE))
          .filter(element => element.getClientRects().length > 0)
        const first = controls[0]
        const last = controls.at(-1)
        if (first === undefined || last === undefined) {
          event.preventDefault()
          panel.focus({ preventScroll: true })
          return
        }
        if (!panel.contains(document.activeElement)) {
          event.preventDefault()
          ;(event.shiftKey ? last : first).focus()
        } else if (event.shiftKey && (document.activeElement === first || document.activeElement === panel)) {
          event.preventDefault()
          last.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first.focus()
        }
      } catch { /* 单个控件失效不影响宿主 */ }
    }

    let observer: ResizeObserver | null = null
    try {
      // 遮罩的显示状态随容器宽度切换，display 一变 ResizeObserver 就会收到通知，不用轮询。
      if (typeof ResizeObserver !== 'undefined') {
        observer = new ResizeObserver(syncModal)
        observer.observe(scrim)
      }
      syncModal()
      if (drawerMode() && !panel.contains(document.activeElement)) panel.focus({ preventScroll: true })
      document.addEventListener('keydown', keydown, true)
    } catch { /* 环境缺少这些能力时退化成普通面板，点击收起照常可用 */ }

    return () => {
      try {
        document.removeEventListener('keydown', keydown, true)
        observer?.disconnect()
        restoreBackground()
        panel.removeAttribute('role')
        panel.removeAttribute('aria-modal')
        // 只在焦点已经无处可去时归还：主人正操作别处（比如倒带滑块）时不抢焦点。
        const active = document.activeElement
        const trigger = triggerRef.current
        if ((active === null || active === document.body) && trigger?.isConnected === true) trigger.focus()
      } catch { /* 节点已随面板卸载时无需还原 */ }
    }
  }, [])

  return { panelRef, scrimRef }
}

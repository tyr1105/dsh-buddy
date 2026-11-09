/**
 * 轻提示防焦点遮挡（WCAG 2.4.11 Focus Not Obscured，AA）。
 *
 * 为什么需要：轻提示默认挂在视口顶部中间，顶栏导航按钮恰好落在同一区域；提示出现的
 * 2.2 秒里，键盘用户当前聚焦的按钮可能被提示完全罩住，既看不见也无法预期焦点位置。
 * 本 hook 在提示存活期间监听 focusin：顶部提示盒会「完全」罩住当前焦点元素时，把提示
 * 翻到视口底部（挂 ah-toast-layer-below 类，纯 CSS 换位）；若底部同样会全罩（极端小
 * 视口），维持顶部而不是制造第二个违规。焦点在提示自身内部、焦点在 body、或元素已不可
 * 见时不翻转。提示消失后状态自动复位，不保留任何全局副作用。
 *
 * 设计约束：只读焦点元素与提示层的几何，不移动焦点、不拦截事件、不改提示时长与文案。
 */
import { useLayoutEffect, useRef, useState, type RefObject } from 'react'

/** 提示距视口顶/底的距离，与 styles.css 里 .ah-toast-layer 的 top:40px 保持一致。 */
const TOP_OFFSET = 40
const BOTTOM_OFFSET = 40

export function useToastPlacement(active: boolean): {
  // 与 use-drawer-focus/useDialogFocus 同口径：React 18 类型下 useRef<T>(null)
  // 得到可直接挂到 JSX 的 RefObject<T>，泛型里带 | null 反而与 LegacyRef 不兼容。
  layerRef: RefObject<HTMLDivElement>
  below: boolean
} {
  const layerRef = useRef<HTMLDivElement>(null)
  const [below, setBelow] = useState(false)

  useLayoutEffect(() => {
    if (!active) {
      // 提示消失即复位，避免下一条提示出现时先闪一下底部位置。
      setBelow(false)
      return
    }
    const decide = (): void => {
      const layer = layerRef.current
      const focused = document.activeElement
      if (!(focused instanceof HTMLElement) || focused === document.body || !layer || layer.contains(focused)) {
        setBelow(false)
        return
      }
      // 只取尺寸：宽高不随上/下换位变化，位置按常量重新推导，保证重复进入时判定可重入。
      const size = layer.getBoundingClientRect()
      const fr = focused.getBoundingClientRect()
      if (size.width < 2 || size.height < 2 || fr.width < 2 || fr.height < 2) {
        setBelow(false)
        return
      }
      const fullyCovers = (top: number): boolean => {
        const left = (window.innerWidth - size.width) / 2
        const box = { left, right: left + size.width, top, bottom: top + size.height }
        return fr.left >= box.left - 1 && fr.right <= box.right + 1
          && fr.top >= box.top - 1 && fr.bottom <= box.bottom + 1
      }
      if (!fullyCovers(TOP_OFFSET)) {
        setBelow(false)
        return
      }
      // 顶部会全罩才考虑翻底；底部也全罩时维持顶部（极小视口下两害相权，不新增违规面）。
      const bottomTop = window.innerHeight - BOTTOM_OFFSET - size.height
      setBelow(fullyCovers(bottomTop) ? false : true)
    }
    decide()
    // 提示存活期间用户继续 Tab：每一次焦点变化都即时重判，覆盖提示出现后才移动焦点的场景。
    window.addEventListener('focusin', decide)
    return () => window.removeEventListener('focusin', decide)
  }, [active])

  return { layerRef, below }
}

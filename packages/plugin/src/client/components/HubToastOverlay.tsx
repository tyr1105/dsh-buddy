/**
 * 根级应用内提示层（D03：新的待处理收件箱项，挂在宿主 shell.overlay 插槽）。
 *
 * 为什么 live 区域必须常驻（WCAG 4.1.3 状态消息）：读屏软件只监听页面加载时
 * 已经存在的 live 区域；如果「有提示时才把整个区域连同文字一起挂载」，区域与
 * 消息同时出现在 DOM 里，VoiceOver 等读屏不会稳定播报，NVDA/JAWS 的行为也因
 * 版本而异。因此这里空态也渲染同一个 .ah-toast-layer（fixed 定位、
 * pointer-events:none、空 grid 无任何视觉盒），消息到来时只往这个已存在的
 * 节点里增删子元素，各读屏都能在焦点不移动的前提下念出提示。
 *
 * P43 起：点提示不仅要打开中心页，还要切到队友模式并把焦点落到那条收件箱项；
 * 模式与面板由调用方的 onOpen 统一处理，本组件只负责收件箱视图与刷新。
 */
import type { ReactNode } from 'react'
import { useStore } from '../store.js'
import type { HubStore } from '../hub-state.js'
import { useToastPlacement } from './use-toast-placement.js'

export function HubToastOverlay(props: { hub: HubStore; onOpen: (inboxItemId: string) => void }): ReactNode {
  const state = useStore(props.hub)
  // WCAG 2.4.11：提示会完全罩住键盘焦点时自动翻到底部，避免焦点组件不可见。
  const toastPlacement = useToastPlacement(state.toasts.length > 0)
  return (
    // role=status 隐含 aria-live=polite，再显式写一遍是给人和工具看的契约；
    // aria-atomic=false：多条提示时只播报新插入的那一条，不重读整层。
    <div ref={toastPlacement.layerRef}
      className={`ah-toast-layer${toastPlacement.below ? ' ah-toast-layer-below' : ''}`}
      role="status" aria-live="polite" aria-atomic="false">
      {state.toasts.map(toast => (
        <div key={toast.id} className="ah-toast">
          <button type="button" className="ah-toast-btn"
            onClick={() => {
              props.hub.dismissToast(toast.id)
              props.hub.setView('inbox')
              void props.hub.refreshInbox()
              // 主人可能停在别的空间或页面：交给调用方切队友模式、开中心页并定位这一项。
              try { props.onOpen(toast.inboxItemId) } catch { /* 定位失败时收件箱视图仍已打开 */ }
            }}>
            {toast.text}
          </button>
        </div>
      ))}
    </div>
  )
}

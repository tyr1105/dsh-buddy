/**
 * 右栏抽屉的模态管理（U01 第 11、12 轮巡检）。
 *
 * 背景：容器宽度 ≤1100px 时（workspace.css 的容器查询），右栏从并排分栏变成
 * 盖在内容上的抽屉，并出现遮罩 .ah-right-scrim——视觉上已经是模态，但最初背景里的
 * 线程输入框、队友列表按钮仍可被 Tab 聚焦、屏幕阅读器虚拟光标也能读到遮罩下层。
 * 本 hook 把抽屉的模态语义补齐，分两块：
 * 1. 键盘（第 11 轮）：抽屉模式下 Tab 困守在右栏内，关闭后焦点还给触发按钮。
 * 2. 无障碍（第 12 轮）：抽屉模式下给背景兄弟节点打 inert（移出可聚焦序列与
 *    无障碍树，屏幕阅读器虚拟光标不再穿透遮罩），面板自身动态带上
 *    role="dialog" aria-modal="true"；宽屏分栏不是模态，全部原样还原。
 *
 * 设计取舍（最保守做法）：
 * - 只在「抽屉模式」生效：宽屏下右栏是普通分栏，Tab 自然流动、背景不 inert。
 *   模式判断读遮罩的实时计算样式（display:none=宽屏），不手抄断点像素。
 * - 不重构 HubPage、不加包裹容器：inert 直接打在 .ah-body 的既有背景子节点上
 *   （DOM 属性，React 不管这个属性，重渲染不会抹掉；节点被整体替换时由
 *   MutationObserver 补打），收起时按记录的原值还原，不留副作用。
 * - 顶栏不在 .ah-body 内、遮罩也盖不到它，刻意保持可交互（与视觉遮罩范围一致）；
 *   遮罩自己要接收点击关闭，不能 inert；面板自身不能 inert。
 * - 不碰 Esc：右栏第 10 轮已定好三层 Esc 语义（控件内取消编辑、确认条收条、
 *   普通区域收起整栏），本 hook 不重复处理，避免两个监听器打架。
 * - 键盘监听挂在 document 捕获阶段：焦点若已落到背景或 body，按键事件不经过
 *   面板，面板级监听接不住；捕获阶段能在浏览器默认跳焦点之前拦下。面板之上再开
 *   模态弹窗（如「教它技能」）时主动让位，弹窗自己的 useDialogFocus 才是那一层
 *   的键盘主人，两个困守不能同时生效。
 * - 关闭后把焦点还给触发按钮（通常是线程头的「查看状态」）。该按钮在右栏打开期间条件
 *   卸载、关闭后重挂成新节点，渲染期缓存的旧引用必然失联，因此旧引用不可用时
 *   按稳定锚点 [data-testid="ah-detail-open"] 找重挂后的新按钮；锚点也不存在
 *   则交给浏览器默认，绝不硬焦点。
 * - 折叠的 <details> 里的控件有布局盒但不可点、也不在浏览器原生 Tab 序列里，
 *   困守计算时显式排除 details:not([open]) 内部元素，首尾不能取到隐形控件。
 */
import { useEffect, useRef, type RefObject } from 'react'

/**
 * 右栏内可被 Tab 聚焦的控件。比 useDialogFocus 多收一个 summary：右栏各分区是
 * <details>，summary 无论分区折叠与否都可见、都是浏览器原生 Tab 停靠点，漏掉它
 * 困守首尾就会和真实 Tab 序列错位。折叠 details 内部的普通控件仍要排除，但
 * summary 是 details 的 disclosure 头、永远可见，不受该过滤影响。
 */
const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"], summary'

/** 右栏现在是不是抽屉：遮罩显示就是抽屉，宽屏 CSS 把它设成 display:none。每次实时读，天然响应拖拽变宽变窄。 */
export function isDrawerMode(): boolean {
  const scrim = document.querySelector<HTMLElement>('.ah-right-scrim')
  return !!scrim && getComputedStyle(scrim).display !== 'none'
}

export function useDrawerFocus(): { panelRef: RefObject<HTMLElement> } {
  // 与 useDialogFocus 同口径：React 18 类型下 useRef<T>(null) 得到可挂到 JSX 的 RefObject<T>。
  const panelRef = useRef<HTMLElement>(null)
  /**
   * 打开右栏前持有焦点的节点。和 useDialogFocus 同样的时序：在首次渲染期惰性
   * 读取一次——此刻本轮 DOM 提交还没发生，线程头「详情」按钮仍在文档里且持焦。
   */
  const previousRef = useRef<HTMLElement | null | undefined>(undefined)
  if (previousRef.current === undefined) {
    previousRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
  }

  useEffect(() => {
    const panel = panelRef.current
    if (!panel) return
    const drawerMode = isDrawerMode
    /** 当前真正可 Tab 到的控件：排除折叠 details 内部与无布局盒的节点（summary 除外）。 */
    const controls = (): HTMLElement[] => Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE))
      .filter(el => el.getClientRects().length > 0
        && (el.tagName === 'SUMMARY' || el.closest('details:not([open])') === null))

    // ---------- 第 12 轮：背景 inert 与面板 dialog 语义的同步 ----------
    // 记录每个被本 hook 打过 inert 的背景节点及其原值，还原时一个不差地恢复。
    const inerted = new Map<HTMLElement, boolean>()
    const body = panel.closest<HTMLElement>('.ah-body')
    /** 背景 = .ah-body 里除面板与遮罩之外的全部子节点（队友列表、当前视图等）。 */
    const backgroundKids = (): HTMLElement[] => body === null
      ? []
      : Array.from(body.children).filter((el): el is HTMLElement => el instanceof HTMLElement
        && el !== panel && !el.classList.contains('ah-right-scrim'))

    /**
     * 按当前是否抽屉模式，同步模态语义。幂等：重复调用不会叠加状态；
     * 每一步都 try/catch，单个节点失效不影响宿主（红线：右栏报错不带崩 DSH）。
     */
    const syncModal = (): void => {
      let modal = false
      try { modal = drawerMode() } catch { modal = false }
      try {
        if (modal) {
          // 面板在窄屏是模态对话框：补 role/aria-modal（JSX 没写这两个属性，
          // React 不会与这里争抢；宽屏还原时移除，恢复 aside 原生 complementary 语义）。
          panel.setAttribute('role', 'dialog')
          panel.setAttribute('aria-modal', 'true')
        } else {
          panel.removeAttribute('role')
          panel.removeAttribute('aria-modal')
        }
      } catch { /* 属性操作失败不阻断键盘逻辑 */ }
      try {
        if (modal) {
          for (const kid of backgroundKids()) {
            // 只记录第一次命中时的原值，避免重复同步把本 hook 自己打的 true 当成原值。
            if (!inerted.has(kid)) inerted.set(kid, kid.inert)
            kid.inert = true
          }
        } else {
          for (const [kid, prev] of inerted) kid.inert = prev
          inerted.clear()
        }
      } catch { /* 个别节点被替换时以 MutationObserver 的下一轮同步为准 */ }
    }

    // 遮罩的 display 随容器查询切换：display 变化会触发 ResizeObserver
    // （none 时布局盒为 0，切回 block 时重新有盒），用它响应拖拽变宽变窄，无需轮询。
    let resizeObserver: ResizeObserver | null = null
    try {
      const scrim = document.querySelector<HTMLElement>('.ah-right-scrim')
      if (scrim && typeof ResizeObserver !== 'undefined') {
        resizeObserver = new ResizeObserver(() => syncModal())
        resizeObserver.observe(scrim)
      }
    } catch { /* 老环境没有 RO 时退化为挂载/卸载两点同步，键盘困守仍独立生效 */ }
    // 背景子树可能被 React 整体替换（如视图切换、BlockBoundary 重挂）：新节点不会
    // 自动带 inert，监听 .ah-body 的直接子节点增删，换一批就重新同步一次。
    let mutationObserver: MutationObserver | null = null
    try {
      if (body && typeof MutationObserver !== 'undefined') {
        mutationObserver = new MutationObserver(() => syncModal())
        mutationObserver.observe(body, { childList: true })
      }
    } catch { /* 同上， observer 不可用不影响主链路 */ }
    syncModal()

    // ---------- 第 11 轮：键盘困守 ----------
    // 抽屉模式打开时把焦点收进右栏容器（tabIndex=-1，仅可编程聚焦、不进 Tab 序列）；
    // 宽屏分栏不抢焦点，保留主人在线程里的原位置。preventScroll 避免面板自动滚走。
    if (drawerMode() && !panel.contains(document.activeElement)) {
      panel.focus({ preventScroll: true })
    }

    const keydown = (event: KeyboardEvent): void => {
      try {
        if (event.key !== 'Tab' || !drawerMode()) return
        // 模态弹窗（教导、新建向导等）盖在抽屉上时，键盘交给 useDialogFocus，不双层困守。
        if (document.querySelector('.ah-dialog-mask')) return
        const items = controls()
        const first = items[0]
        const last = items.at(-1)
        if (!first || !last) {
          // 抽屉里没有任何可聚焦控件时，Tab 不能落到背景，留在容器自身。
          event.preventDefault()
          panel.focus({ preventScroll: true })
          return
        }
        // 焦点本就不在面板内（如拖拽变窄前焦点停在背景）：先收进抽屉，正向进首、反向进尾。
        if (!panel.contains(document.activeElement)) {
          event.preventDefault()
          ;(event.shiftKey ? last : first).focus()
          return
        }
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          last.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first.focus()
        }
      } catch {
        /* 单个控件失效不影响宿主，兜底原则：右栏报错不带崩 DSH。 */
      }
    }
    // 捕获阶段：在浏览器默认 Tab 跳焦点、以及任何组件自己的 keydown 之前先拦住。
    document.addEventListener('keydown', keydown, true)
    return () => {
      document.removeEventListener('keydown', keydown, true)
      try { resizeObserver?.disconnect() } catch { /* 忽略 */ }
      try { mutationObserver?.disconnect() } catch { /* 忽略 */ }
      // 还原所有背景节点的 inert 原值与面板的临时 ARIA 属性。
      try {
        for (const [kid, prev] of inerted) kid.inert = prev
        panel.removeAttribute('role')
        panel.removeAttribute('aria-modal')
      } catch { /* 节点已随面板一起卸载时无需还原 */ }
      // 优先还给当初打开右栏的触发按钮；它在打开期间已卸载时，按锚点找重挂后的新节点。
      const previous = previousRef.current
      if (previous?.isConnected) {
        previous.focus()
        return
      }
      const remounted = document.querySelector<HTMLElement>('[data-testid="ah-detail-open"]')
      if (remounted?.isConnected) remounted.focus()
    }
  }, [])

  return { panelRef }
}

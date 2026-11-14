/**
 * 给 DSH 原生功能导航加一个可折叠的分组标题，让队友和工作区拥有更多空间。
 * 只追加自有按钮、给原 nav 加独立属性；不移动菜单，卸载时恢复原来的 DOM。
 * 状态只存在本机界面存储里，存储被禁用或宿主结构变化时也能继续使用。
 */
import { findHostNavigation } from './host-sidebar.js'

export const navigationStorageKey = 'dsh-buddy:host-navigation-collapsed:v1'
const collapsedAttribute = 'data-dsh-buddy-nav-collapsed'
type LocalStorage = Pick<Storage, 'getItem' | 'setItem'>
type StorageAccess = () => LocalStorage | null

/** 只接受本功能写入的布尔文本；旧数据、损坏数据和权限异常都默认展开。 */
export function readNavigationCollapsed(storage: StorageAccess): boolean {
  try { return storage()?.getItem(navigationStorageKey) === 'true' }
  catch { return false }
}

/** 写入失败只影响下次打开时的记忆，不阻止本次折叠。 */
export function saveNavigationCollapsed(storage: StorageAccess, collapsed: boolean): void {
  try { storage()?.setItem(navigationStorageKey, String(collapsed)) }
  catch { /* 隐私模式或配额不足时继续使用内存状态 */ }
}

/** 宿主整条侧栏已收起时恢复原导航，由 DSH 自己处理图标模式。 */
function hasExpandedSidebar(nav: HTMLElement): boolean {
  const parent = nav.parentElement
  const marker = nav.closest('[data-sidebar-collapsed]')
  if (marker && marker.getAttribute('data-sidebar-collapsed') !== 'false') return false
  const bounds = parent?.getBoundingClientRect()
  return !!bounds && bounds.width >= 140 && bounds.height > 0
}

/**
 * 观察导航是否重建及侧栏是否变窄；属性值不变时不重复写 DOM，避免观察器自循环。
 * 所有事件都有异常兜底，卸载移除按钮、监听器和本功能添加的属性。
 */
export function watchHostNavigation(doc: Document): () => void {
  const win = doc.defaultView
  const storage: StorageAccess = () => win?.localStorage ?? null
  let collapsed = readNavigationCollapsed(storage)
  let nav: HTMLElement | null = null
  let button: HTMLButtonElement | null = null
  let previousId: string | null = null
  let previousCollapsed: string | null = null
  let mutations: MutationObserver | null = null
  let sizes: ResizeObserver | null = null
  let watchedParent: HTMLElement | null = null
  let stopped = false
  let scheduled = false
  let removals = 0
  let removalWindowStart = 0

  // 还原原值而不是一律删属性，确保卸载不改宿主已有的语义。
  const clear = (): void => {
    button?.removeEventListener('click', toggle)
    button?.remove()
    button = null
    if (nav) {
      if (previousId === null) nav.removeAttribute('id')
      else nav.setAttribute('id', previousId)
      if (previousCollapsed === null) nav.removeAttribute(collapsedAttribute)
      else nav.setAttribute(collapsedAttribute, previousCollapsed)
    }
    nav = null
  }
  const render = (): void => {
    if (!nav || !button) return
    const value = String(collapsed)
    if (nav.getAttribute(collapsedAttribute) !== value) nav.setAttribute(collapsedAttribute, value)
    button.setAttribute('aria-expanded', String(!collapsed))
    button.setAttribute('aria-label', collapsed ? '展开功能导航' : '收起功能导航')
    button.title = collapsed ? '展开功能导航' : '收起功能导航'
  }
  function toggle(): void {
    try {
      collapsed = !collapsed
      render()
      saveNavigationCollapsed(storage, collapsed)
    } catch (error) { console.error('[agent-hub] 切换功能导航失败:', error) }
  }
  const dispose = (): void => {
    stopped = true
    try {
      mutations?.disconnect()
      sizes?.disconnect()
      win?.removeEventListener('resize', schedule)
      clear()
    } catch (error) { console.error('[agent-hub] 清理功能折叠开关失败:', error) }
  }
  /**
   * MutationObserver 的回调是微任务：在回调里同步写 DOM 会立刻再触发一次回调，
   * 形成永不 yield 的微任务链。0.2.2-rc.2 的侧栏会被这条链占满渲染主线程，
   * 启动屏永远停在 Loading plugins。所以观察器一律只回这个调度器，
   * 真正的 DOM 写入推迟到下一帧。
   */
  const schedule = (): void => {
    if (stopped || scheduled) return
    scheduled = true
    const run = (): void => { scheduled = false; sync() }
    const raf = win?.requestAnimationFrame
    if (typeof raf === 'function') raf.call(win, run)
    else setTimeout(run, 0)
  }
  const sync = (): void => {
    if (stopped) return
    try {
      const candidate = findHostNavigation(doc)
      const parent = candidate?.parentElement ?? null
      if (parent !== watchedParent) {
        sizes?.disconnect()
        if (parent) sizes?.observe(parent)
        watchedParent = parent
      }
      const next = candidate && hasExpandedSidebar(candidate) ? candidate : null
      if (next === nav && button?.nextElementSibling === next) return
      if (nav && next === nav) {
        // 同一个 nav 但按钮不在了：宿主重渲染把我方节点摘掉了。偶尔补回没问题，
        // 但每帧都摘说明宿主正在接管这层 DOM，继续插只会互相打断并烧掉主线程。
        const now = Date.now()
        if (now - removalWindowStart > 2000) { removalWindowStart = now; removals = 0 }
        removals += 1
        if (removals > 8) {
          console.warn('[agent-hub] 宿主反复移除功能折叠按钮，本次运行不再挂载它')
          dispose()
          return
        }
      }
      if (!next && !nav) return
      clear()
      if (!next) return
      nav = next
      previousId = nav.getAttribute('id')
      previousCollapsed = nav.getAttribute(collapsedAttribute)
      if (!previousId) nav.id = 'dsh-buddy-host-navigation'
      button = doc.createElement('button')
      button.type = 'button'
      button.className = 'ah-host-navigation-toggle'
      button.setAttribute('aria-controls', nav.id)
      const icon = doc.createElementNS('http://www.w3.org/2000/svg', 'svg')
      icon.setAttribute('viewBox', '0 0 16 16')
      icon.setAttribute('aria-hidden', 'true')
      const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path')
      path.setAttribute('d', 'M6 3l5 5-5 5')
      path.setAttribute('fill', 'none')
      path.setAttribute('stroke', 'currentColor')
      path.setAttribute('stroke-width', '1.5')
      path.setAttribute('stroke-linecap', 'round')
      path.setAttribute('stroke-linejoin', 'round')
      icon.append(path)
      const label = doc.createElement('span')
      label.textContent = '功能'
      button.append(icon, label)
      button.addEventListener('click', toggle)
      nav.before(button)
      render()
    } catch (error) {
      try { clear() } catch { /* 宿主重建过程中清理失败也不向外抛错 */ }
      console.error('[agent-hub] 挂载功能折叠开关失败:', error)
    }
  }
  try {
    if (win && 'ResizeObserver' in win) sizes = new win.ResizeObserver(schedule)
    if (win && 'MutationObserver' in win) {
      mutations = new win.MutationObserver(schedule)
      mutations.observe(doc.body, {
        childList: true, subtree: true, attributes: true,
        attributeFilter: ['class', 'data-sidebar-collapsed'],
      })
    }
    win?.addEventListener('resize', schedule)
    sync()
  } catch (error) {
    try { clear() } catch { /* 保留宿主导航，不传播挂载异常 */ }
    console.error('[agent-hub] 观察功能导航失败:', error)
  }
  return dispose
}

/**
 * 宿主一级侧栏的结构锚点与面板导航。
 * 宿主没有工作区上方的 list 插槽，只能借助入口图标找到导航与工作区区域；
 * 空间挂载与模式切换已迁到 host-mount.ts，本文件只保留共用的结构探测和打开面板。
 */

/** 只认我们的入口图标和紧接导航的工作区区域，不依赖宿主随版本变化的 CSS 哈希。 */
export function findHostNavigation(doc: Document): HTMLElement | null {
  const nav = doc.querySelector('.ah-entry-icon')?.closest('nav')
  const region = nav?.nextElementSibling as HTMLElement | null | undefined
  if (!region || !Array.from(region.classList).some(name => name.endsWith('_regionArea'))) return null
  return nav ?? null
}

/** 主人可能正在别的页面：先导航到队友面板，成功后才切换内部视图。 */
export function openHubPanel(ctx: unknown, navigate: () => void): boolean {
  try {
    const layout = (ctx as { get?: (name: string) => { selectPanel?: (key: string) => void } } | null)?.get?.('layout')
    if (typeof layout?.selectPanel !== 'function') return false
    layout.selectPanel('agent-hub')
    navigate()
    return true
  } catch (error) {
    console.error('[agent-hub] 打开队友面板失败:', error)
    return false
  }
}

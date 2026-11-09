/**
 * 宿主一级侧栏的空间挂载（P41/P42）：顶部「对话 / 队友」切换器、
 * 队友模式下整根侧栏换成队友导航，以及「有没有空间位」的只读判断。
 *
 * 为什么用 DOM 挂载：手册 8.4 里宿主没有「侧栏顶部」插槽，只有 sidebar.panellist
 * 这类功能行插槽。我们注册的入口行是唯一稳定锚点，所以有空间位时入口行仍留在
 * DOM 里，只用 display:none 从视觉与无障碍树移除，绝不删节点；否则锚点没了，
 * 下一次结构同步就找不到侧栏，顶部切换器和队友导航会一起消失。
 *
 * 切换器的落点（P27 主人定稿）：侧栏内部「deepseek HARNESS 标识行」之下、
 * 「新会话」按钮之上，单独一行。宿主真实结构（0.2.1-rc.5，从 app.asar 核对）是
 * root > [topStrip] > logoRow > newSession > panelList > regionArea > footArea，
 * 三个锚点都是 root 的直接子节点，类名带哈希前缀，所以只认 logoRow / newSession /
 * panelList 这些稳定词根。找不到锚点时逐级往前退，最后落在侧栏顶部，保证任何
 * 宿主版本都还能用；结构每次变化都会重新对齐，节点被宿主重建也会原地补回。
 *
 * 只做三件事：追加自有节点、给自己的容器和侧栏根加 data-* 标记、按模式加
 * 属性让 CSS 隐藏原生列表。不改写宿主节点的结构，不轮询。
 */
import { findHostNavigation } from './host-sidebar.js'
import { detectSpaceCapability, type SpaceFallbackReason, type SpaceMode } from './space-capability.js'

/** 侧栏根上的标记：true 表示这棵子树已由本插件接管模式。 */
export const SPACE_ROOT_ATTR = 'data-ah-space-root'
/** 当前模式：chat | team；CSS 只认这两个值。 */
export const SPACE_MODE_ATTR = 'data-ah-space-mode'
/** 队友模式下要保留的自有节点（切换器、队友导航）。 */
export const SPACE_KEEP_ATTR = 'data-ah-space-keep'
/** 自有节点的归属：team 表示队友导航，对话模式下隐藏。 */
export const SPACE_OWN_ATTR = 'data-ah-space-own'
/** 旧「团队空间」入口行：有顶部双 Tab 时隐藏，仍留在 DOM 里当锚点。 */
export const SPACE_HIDE_ENTRY_ATTR = 'data-ah-space-hide-entry'
/**
 * 队友模式下显式标在宿主原生列表上的隐藏标记（P44）：
 * 功能/库/技能列表与工作区区域都带上，和原生会话入口去重。
 * 不删节点、不改宿主结构，切回对话模式时立即移除。
 */
export const SPACE_HIDE_NATIVE_ATTR = 'data-ah-space-hide-native'
/** 切换器实际落点的来源：after-logo / before-new-session / before-panel-list / root-top。 */
export const SPACE_ANCHOR_ATTR = 'data-ah-space-anchor'
/** 侧栏是否收起：'true' 时切换器退化成图标列（与原生「新会话」同宽）。 */
export const SPACE_COMPACT_ATTR = 'data-ah-space-compact'

/** 空间挂载的当前状态：slot 可直接挂；fallback 走页面内降级。 */
export type HostSpaceState =
  | { kind: 'slot'; switcher: HTMLElement; team: HTMLElement | null; compact: boolean }
  | { kind: 'fallback'; reason: SpaceFallbackReason }

/** 降级状态的构造器：每次给新对象，避免调用方误改共享常量。 */
export function fallbackSpace(reason: SpaceFallbackReason): HostSpaceState {
  return { kind: 'fallback', reason }
}

/**
 * 侧栏根：导航与工作区区域共同的父节点，也就是顶部切换器该待的地方。
 *
 * 主路径仍只认已验证的相邻结构（导航紧接工作区区域），不靠宿主随版本变化的
 * CSS 哈希；但真实宿主里区域常被再包一层，严格相邻会判定失败、整根侧栏降级，
 * 结果就是主人截图里的「原生侧栏 + 我们页面内又画一列」。因此补两级只读回退：
 * 1) 从入口图标所在导航向上找同时含功能列表与工作区区域的容器（找不到再用父节点）；
 * 2) 从标识行/新会话按钮向上找同一形状的容器。
 * 找不到才返回 null，交给页面内降级。
 */
export function findHostSpaceRoot(doc: Document): HTMLElement | null {
  const nav = findHostNavigation(doc)
  if (nav?.parentElement) return nav.parentElement
  // 入口图标所在的导航可能被包在功能列表内部：直接取父节点会把「侧栏根」认成
  // 一小段面板，原生工作区区域就不在根下，去重时漏掉它。所以从这个节点向上找
  // 同时含功能列表与工作区区域的祖先，找不到才退回第一父节点。
  const entryNav = doc.querySelector('.ah-entry-icon')?.closest('nav') as HTMLElement | null
  if (entryNav) {
    const wideRoot = enclosingSidebarRoot(entryNav)
    if (wideRoot) return wideRoot
    if (entryNav.parentElement) return entryNav.parentElement
  }
  const anchor = (doc.querySelector('[class*="logoRow"]')
    ?? doc.querySelector('button[class*="newSession"]')) as HTMLElement | null
  return enclosingSidebarRoot(anchor?.parentElement ?? null)
}

/**
 * 向上找同时含「功能列表」与「工作区区域」的容器；找不到返回 null。
 * 只读，不依赖类名哈希前缀，宿主换版本时仍然有效。
 */
function enclosingSidebarRoot(start: HTMLElement | null): HTMLElement | null {
  let current: HTMLElement | null = start
  while (current) {
    const hasPanels = current.querySelector('[class*="panelList"]') !== null
    const hasRegion = current.querySelector('[class*="regionArea"]') !== null
    if (hasPanels && hasRegion) return current
    current = current.parentElement
  }
  return null
}

/** 供空间能力探测使用：探针只读，找不到就返回 null。 */
export function createSpaceProbe(doc: Document): { findMount(): HTMLElement | null } {
  return { findMount: () => findHostSpaceRoot(doc) }
}

/** 侧栏是否处于收起态（图标轨道）：切换器与团队导航都退化为图标列。 */
export function isSidebarCompact(root: HTMLElement): boolean {
  const marker = root.closest('[data-sidebar-collapsed]')
  if (marker && marker.getAttribute('data-sidebar-collapsed') !== 'false') return true
  const width = root.getBoundingClientRect().width
  return width > 0 && width < 140
}

/** 切换器落点：锚点节点与来源名；node 为 null 表示退到侧栏最顶部。 */
export type SwitcherPlacement = {
  kind: 'after-logo' | 'before-new-session' | 'before-panel-list' | 'root-top'
  node: HTMLElement | null
}

/**
 * 把任意后代折回「侧栏根的直接子节点」：我们只往根的直接子级插节点。
 * 这样队友模式下 `> :not([data-ah-space-keep])` 的隐藏规则不会把切换器
 * 连同外层包装一起藏掉；锚点被包在更深的容器里时也不会插错层级。
 */
function directChildOf(root: HTMLElement, node: HTMLElement): HTMLElement | null {
  let current: HTMLElement | null = node
  while (current && current.parentElement !== root) current = current.parentElement
  return current
}

/**
 * 找切换器该插在哪。按产品口径只认三件事，顺序即降级顺序：
 * 1) 标识行之后（主人指定的位置）；
 * 2) 「新会话」按钮之前（标识行暂缺时至少保持在新会话上方）；
 * 3) 功能行列表（panelList）之前；
 * 4) 都不认识就退回侧栏顶部，宁可位置不完美也不消失。
 */
export function findSwitcherPlacement(root: HTMLElement): SwitcherPlacement {
  const locate = (selector: string): HTMLElement | null => {
    const found = root.querySelector<HTMLElement>(`:scope > ${selector}`)
      ?? root.querySelector<HTMLElement>(selector)
    return found ? directChildOf(root, found) : null
  }
  const logo = locate('[class*="logoRow"]')
  if (logo) return { kind: 'after-logo', node: logo }
  const newSession = locate('button[class*="newSession"]')
  if (newSession) return { kind: 'before-new-session', node: newSession }
  const panelList = locate('[class*="panelList"]')
  if (panelList) return { kind: 'before-panel-list', node: panelList }
  return { kind: 'root-top', node: null }
}

/** 切换器目前是否已经在对的位置：宿主动过 DOM 后用它决定要不要重新插。 */
export function switcherPlacedAt(root: HTMLElement, switcher: HTMLElement): boolean {
  const place = findSwitcherPlacement(root)
  if (place.kind === 'root-top') return root.firstElementChild === switcher
  if (!place.node || place.node.parentElement !== root) return false
  if (switcher.parentElement !== root) return false
  return place.kind === 'after-logo'
    ? place.node.nextElementSibling === switcher
    : place.node.previousElementSibling === switcher
}

/** 把切换器插到当前锚点；返回实际采用的落点名，写进 data-* 便于走查核对。 */
export function placeSwitcher(root: HTMLElement, switcher: HTMLElement): SwitcherPlacement['kind'] {
  const place = findSwitcherPlacement(root)
  if (place.kind === 'root-top' || !place.node) root.insertBefore(switcher, root.firstChild)
  else if (place.kind === 'after-logo') root.insertBefore(switcher, place.node.nextSibling)
  else root.insertBefore(switcher, place.node)
  const current = switcher.getAttribute(SPACE_ANCHOR_ATTR)
  if (current !== place.kind) switcher.setAttribute(SPACE_ANCHOR_ATTR, place.kind)
  return place.kind
}

/** 找到入口行本身（图标所在的可点击容器），用于整行隐藏。 */
export function findSpaceEntryRow(doc: Document): HTMLElement | null {
  const icon = doc.querySelector('.ah-entry-icon')
  if (!icon) return null
  return (icon.closest('button, a, [role="listitem"], [role="button"], li') as HTMLElement | null) ?? null
}

/** 把当前模式写到侧栏根上；没有接管过侧栏时什么都不做。 */
export function applySpaceMode(doc: Document, mode: SpaceMode): void {
  const root = doc.querySelector(`[${SPACE_ROOT_ATTR}='true']`)
  if (root && root.getAttribute(SPACE_MODE_ATTR) !== mode) root.setAttribute(SPACE_MODE_ATTR, mode)
}

export interface HostSpaceOptions {
  /** 当前模式，由 mode 仓库提供；挂载时直接写属性，避免首帧闪一下原生列表。 */
  getMode(): SpaceMode
  /** 状态变化时回调；同一份 DOM 与模式不重复通知，防止 React 反复换 portal 目标。 */
  onChange(state: HostSpaceState): void
}

/**
 * 观察宿主侧栏：挂切换器、按模式挂/卸队友导航、隐藏旧入口行。
 * 所有观察器回调都有异常兜底；结构漂移时清掉自有节点并降级，绝不把异常抛给宿主。
 */
export function watchHostSpace(doc: Document, options: HostSpaceOptions): () => void {
  const win = doc.defaultView
  let root: HTMLElement | null = null
  let switcher: HTMLElement | null = null
  let team: HTMLElement | null = null
  let compact = false
  let hiddenRow: HTMLElement | null = null
  /** 本轮被标上「原生隐藏」的宿主节点：切模式/卸载时逐个还原属性。 */
  let hiddenNative: HTMLElement[] = []
  let watchedRoot: HTMLElement | null = null
  let stopped = false
  let mutations: MutationObserver | null = null
  let sizes: ResizeObserver | null = null
  // 版本号让「同一形态但节点已重建」也能触发通知，React 才会把 portal 换到新节点。
  let version = 0
  let lastKey = ''

  const notify = (state: HostSpaceState): void => {
    const key = state.kind === 'slot' ? `slot:${state.compact ? 'rail' : 'wide'}:${version}` : `fallback:${state.reason}:${version}`
    if (key === lastKey) return
    lastKey = key
    try { options.onChange(state) } catch (error) { console.error('[agent-hub] 更新空间挂载失败:', error) }
  }

  // 还原入口行：只移除我们加的属性，不动宿主自己的节点与类名。
  const restoreEntry = (): void => {
    try { hiddenRow?.removeAttribute(SPACE_HIDE_ENTRY_ATTR) } catch { /* 节点已随宿主重建时忽略 */ }
    hiddenRow = null
  }
  const hideEntry = (): void => {
    const row = findSpaceEntryRow(doc)
    if (!row || row === hiddenRow) return
    restoreEntry()
    hiddenRow = row
    row.setAttribute(SPACE_HIDE_ENTRY_ATTR, 'true')
  }

  const createSwitcher = (): HTMLElement => {
    const node = doc.createElement('div')
    node.className = 'ah-space-switch-host'
    node.setAttribute('data-plugin-space', 'dsh-buddy')
    node.setAttribute(SPACE_KEEP_ATTR, 'true')
    return node
  }
  const createTeam = (): HTMLElement => {
    const node = doc.createElement('div')
    node.className = 'ah-host-botlist ah-team-sidebar'
    node.setAttribute('data-plugin-sidebar', 'dsh-buddy')
    node.setAttribute(SPACE_KEEP_ATTR, 'true')
    node.setAttribute(SPACE_OWN_ATTR, 'team')
    return node
  }

  /**
   * 队友模式：给宿主原生功能列表与工作区区域打上隐藏标记，和团队工作区去重；
   * 对话模式：逐个移除，原生列表原样恢复。只加 data 属性，不删节点、不改类名。
   */
  const markNative = (on: boolean): void => {
    for (const node of hiddenNative) node.removeAttribute(SPACE_HIDE_NATIVE_ATTR)
    hiddenNative = []
    if (!on || !root) return
    const selectors = ['[class*="panelList"]', '[class*="regionArea"]']
    for (const selector of selectors) {
      root.querySelectorAll<HTMLElement>(selector).forEach((node) => {
        // 不碰我们自己的容器（团队导航也在根下，类名里可能恰好含这些词根）。
        if (node.closest(`[${SPACE_KEEP_ATTR}]`) !== null) return
        node.setAttribute(SPACE_HIDE_NATIVE_ATTR, 'true')
        hiddenNative.push(node)
      })
    }
  }

  // 清掉自有节点与标记，回到「宿主原样」；降级或卸载时调用。
  const teardown = (): void => {
    restoreEntry()
    markNative(false)
    switcher?.remove()
    team?.remove()
    switcher = null
    team = null
    if (root) {
      root.removeAttribute(SPACE_ROOT_ATTR)
      root.removeAttribute(SPACE_MODE_ATTR)
      root.removeAttribute(SPACE_COMPACT_ATTR)
    }
    root = null
    compact = false
    version += 1
  }

  const sync = (): void => {
    if (stopped) return
    try {
      const capability = detectSpaceCapability(createSpaceProbe(doc))
      if (capability.kind === 'fallback') {
        if (root) teardown()
        notify(fallbackSpace(capability.reason))
        return
      }
      const nextRoot = capability.mount
      if (nextRoot !== root) {
        teardown()
        root = nextRoot
        root.setAttribute(SPACE_ROOT_ATTR, 'true')
        version += 1
      }
      // 先写模式再挂节点：首帧就按正确模式渲染，不出现原生列表闪一下。
      const currentMode = options.getMode()
      root.setAttribute(SPACE_MODE_ATTR, currentMode)
      hideEntry()
      // 队友模式显式藏掉原生功能列表与工作区区域；对话模式恢复，避免两套工作区并存。
      markNative(currentMode === 'team')
      if (!switcher) {
        switcher = createSwitcher()
        version += 1
      }
      // 宿主重渲染可能把我们插的行挪走或丢掉；对不上就立刻按锚点补回原位。
      // 落点来源每轮都重算：即使节点没动（比如标识行被宿主抽走后，正好落在新会话之前），
      // data-* 也要如实反映当前降级层级，便于走查和排障。
      const placement = findSwitcherPlacement(nextRoot)
      if (!switcherPlacedAt(nextRoot, switcher)) {
        placeSwitcher(nextRoot, switcher)
        version += 1
      }
      if (switcher.getAttribute(SPACE_ANCHOR_ATTR) !== placement.kind) {
        switcher.setAttribute(SPACE_ANCHOR_ATTR, placement.kind)
      }
      const nextCompact = isSidebarCompact(nextRoot)
      const compactValue = nextCompact ? 'true' : 'false'
      if (root.getAttribute(SPACE_COMPACT_ATTR) !== compactValue) root.setAttribute(SPACE_COMPACT_ATTR, compactValue)
      // 队友导航常驻 DOM：收起态由 compact 属性交给 CSS 画成图标列，
      // 不再 remove——否则收起一次再展开就找不到节点，图标列也无处渲染。
      if (!team) {
        team = createTeam()
        root.append(team)
        version += 1
      }
      compact = nextCompact
      notify({ kind: 'slot', switcher, team, compact })
      if (watchedRoot !== nextRoot) {
        sizes?.disconnect()
        if (sizes) sizes.observe(nextRoot)
        watchedRoot = nextRoot
      }
    } catch (error) {
      console.error('[agent-hub] 同步一级空间失败:', error)
      try { teardown() } catch { /* 清理也出错时仍继续降级 */ }
      notify(fallbackSpace('probe-error'))
    }
  }

  try {
    // 侧栏宽度变化（收起/展开）要立即换形态；根节点重建由 MutationObserver 兜住。
    if (win && 'ResizeObserver' in win) sizes = new win.ResizeObserver(sync)
    if (win && 'MutationObserver' in win) {
      mutations = new win.MutationObserver(sync)
      mutations.observe(doc.body, {
        childList: true, subtree: true, attributes: true,
        attributeFilter: ['class', 'data-sidebar-collapsed'],
      })
    }
    win?.addEventListener('resize', sync)
    sync()
  } catch (error) {
    console.error('[agent-hub] 观察一级空间失败:', error)
    try { teardown() } catch { /* 忽略 */ }
    notify(fallbackSpace('probe-error'))
  }
  return () => {
    stopped = true
    try {
      mutations?.disconnect()
      sizes?.disconnect()
      win?.removeEventListener('resize', sync)
      teardown()
    } catch (error) { console.error('[agent-hub] 清理一级空间失败:', error) }
  }
}

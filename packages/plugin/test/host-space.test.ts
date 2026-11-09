/**
 * P41 宿主空间挂载测试：模式持久化、面板目标、侧栏根与收起态判断、
 * 以及「入口行只隐藏不删除」等必须遵守的形状。
 *
 * 为什么用假对象和静态契约：测试环境没有真实 DOM 与宿主侧栏，
 * 这里验证的是纯判断与源码契约；真实侧栏的挂载行为由 P41 验收里的浏览器走查覆盖。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  applySpaceMode,
  fallbackSpace,
  findHostSpaceRoot,
  findSpaceEntryRow,
  isSidebarCompact,
  SPACE_COMPACT_ATTR,
  SPACE_HIDE_ENTRY_ATTR,
  SPACE_HIDE_NATIVE_ATTR,
  SPACE_MODE_ATTR,
  SPACE_ROOT_ATTR,
} from '../src/client/logic/host-mount.js'
import { readSpaceMode, saveSpaceMode, spaceModeStorageKey, targetPanel } from '../src/client/logic/mode-nav.js'

const clientRoot = new URL('../src/client/', import.meta.url)
const read = (path: string): string => readFileSync(new URL(path, clientRoot), 'utf8')

/** 只实现被调用的几个方法，避免为了纯判断引入 DOM 依赖。 */
function fakeDoc(icon: unknown, root: unknown = null): Document {
  return {
    querySelector: (selector: string) => selector === '.ah-entry-icon' ? icon : root,
  } as unknown as Document
}
function fakeNav(parent: unknown, regionClass: string | null = 'abc_regionArea'): Record<string, unknown> {
  return {
    parentElement: parent,
    nextElementSibling: regionClass === null ? null : { classList: [regionClass] },
    // 根判定会从入口导航向上查祖先（P45），桩对象给空实现。
    querySelector: () => null,
  }
}

describe('空间模式持久化', () => {
  function memoryStorage(initial: string | null): { getItem(key: string): string | null; setItem(key: string, value: string): void } {
    const data = new Map<string, string>()
    if (initial !== null) data.set(spaceModeStorageKey, initial)
    return {
      getItem: key => data.get(key) ?? null,
      setItem: (key, value) => { data.set(key, value) },
    }
  }

  it('没有记录时默认对话模式', () => {
    expect(readSpaceMode(() => memoryStorage(null))).toBe('chat')
    expect(readSpaceMode(() => null)).toBe('chat')
  })

  it('只认写入过的 team，损坏值与旧值都落回对话', () => {
    expect(readSpaceMode(() => memoryStorage('team'))).toBe('team')
    expect(readSpaceMode(() => memoryStorage('TEAM'))).toBe('chat')
    expect(readSpaceMode(() => memoryStorage('{"mode":"team"}'))).toBe('chat')
  })

  it('存储抛错时读写都不外抛', () => {
    const broken = () => ({ getItem: () => { throw new Error('隐私模式') }, setItem: () => { throw new Error('配额不足') } })
    expect(() => readSpaceMode(broken)).not.toThrow()
    expect(readSpaceMode(broken)).toBe('chat')
    expect(() => saveSpaceMode(broken, 'team')).not.toThrow()
  })

  it('写入后能读回同一模式', () => {
    const storage = memoryStorage(null)
    saveSpaceMode(() => storage, 'team')
    expect(readSpaceMode(() => storage)).toBe('team')
  })

  it('队友模式选中中心页，对话模式回到会话界面（null 不换会话）', () => {
    expect(targetPanel('team')).toBe('agent-hub')
    expect(targetPanel('chat')).toBeNull()
  })
})

describe('侧栏根与入口行', () => {
  it('导航紧接工作区区域时，根是导航的父节点', () => {
    const root = {}
    const nav = fakeNav(root)
    expect(findHostSpaceRoot(fakeDoc({ closest: () => nav }))).toBe(root)
  })

  it('相邻结构不符时回退到导航父节点；连锚点都没有才返回 null（走降级）', () => {
    expect(findHostSpaceRoot(fakeDoc(null))).toBeNull()
    // 真实宿主里区域常被再包一层：严格相邻失败时不能整根降级，否则页面内会再画一列。
    const fallbackRoot = { querySelector: () => null }
    expect(findHostSpaceRoot(fakeDoc({ closest: () => fakeNav(fallbackRoot, 'other') }))).toBe(fallbackRoot)
    expect(findHostSpaceRoot(fakeDoc({ closest: () => fakeNav(null) }))).toBeNull()
  })

  it('入口导航被包进功能列表时，根取同时含功能列表与工作区区域的祖先（P45）', () => {
    // 直接取入口导航的父节点可能只是 panelList，regionArea 不在其下，
    // 原生工作区就漏掉了；必须向上找整根侧栏。
    const wideRoot = { parentElement: null, querySelector: () => ({}) }
    const nav = { parentElement: wideRoot, querySelector: () => null }
    expect(findHostSpaceRoot(fakeDoc({ closest: () => nav }))).toBe(wideRoot)
  })

  it('入口行取图标所在的可点击容器', () => {
    const row = { tag: 'button' }
    expect(findSpaceEntryRow(fakeDoc({ closest: () => row }))).toBe(row)
    expect(findSpaceEntryRow(fakeDoc(null))).toBeNull()
  })

  it('收起态：宿主标记为准，无标记时按宽度小于 140 判断', () => {
    const collapsed = { closest: () => ({ getAttribute: () => 'true' }), getBoundingClientRect: () => ({ width: 240 }) }
    const wide = { closest: () => null, getBoundingClientRect: () => ({ width: 240 }) }
    const rail = { closest: () => null, getBoundingClientRect: () => ({ width: 56 }) }
    expect(isSidebarCompact(collapsed as unknown as HTMLElement)).toBe(true)
    expect(isSidebarCompact(wide as unknown as HTMLElement)).toBe(false)
    expect(isSidebarCompact(rail as unknown as HTMLElement)).toBe(true)
  })

  it('applySpaceMode 只改已接管侧栏的模式属性', () => {
    const attrs = new Map<string, string>()
    const root = {
      getAttribute: (name: string) => attrs.get(name) ?? null,
      setAttribute: (name: string, value: string) => { attrs.set(name, value) },
    }
    applySpaceMode(fakeDoc(null, root), 'team')
    expect(attrs.get(SPACE_MODE_ATTR)).toBe('team')
    applySpaceMode(fakeDoc(null, root), 'chat')
    expect(attrs.get(SPACE_MODE_ATTR)).toBe('chat')
    // 没有接管过的侧栏（找不到根）：什么都不做，也不抛错。
    expect(() => applySpaceMode(fakeDoc(null, null), 'team')).not.toThrow()
  })

  it('降级状态每次都是新对象，原因如实带回', () => {
    expect(fallbackSpace('no-anchor')).toEqual({ kind: 'fallback', reason: 'no-anchor' })
    expect(fallbackSpace('probe-error')).toEqual({ kind: 'fallback', reason: 'probe-error' })
    expect(fallbackSpace('no-anchor')).not.toBe(fallbackSpace('no-anchor'))
  })
})

describe('宿主挂载契约（源码形状）', () => {
  const mount = read('logic/host-mount.ts')
  const index = read('index.tsx')
  const modeSwitch = read('components/mode-switch.tsx')
  const teamSidebar = read('components/team-sidebar.tsx')
  const css = read('workspace.css')

  it('切换器插在标识行之后、新会话之前，队友导航追加在根上', () => {
    // P27 主人定稿：宿主真实结构是 root > logoRow > newSession > panelList，
    // 只认稳定词根，不认带哈希前缀的完整类名。
    expect(mount).toContain('[class*="logoRow"]')
    expect(mount).toContain('button[class*="newSession"]')
    expect(mount).toContain("kind: 'after-logo'")
    expect(mount).toContain('switcherPlacedAt(nextRoot, switcher)')
    // 不能再直接挂到侧栏最顶部（会压到窗口标题栏/红绿灯那一行）。
    expect(mount).not.toContain('root.prepend(switcher)')
    expect(mount).toContain('root.append(team)')
    expect(mount).toContain(SPACE_ROOT_ATTR)
    expect(mount).toContain(SPACE_MODE_ATTR)
    expect(mount).toContain(SPACE_COMPACT_ATTR)
  })

  it('旧入口行只隐藏不删除：保留锚点，卸载时还原属性', () => {
    expect(mount).toContain('removeAttribute(SPACE_HIDE_ENTRY_ATTR)')
    expect(mount).toContain('row.setAttribute(SPACE_HIDE_ENTRY_ATTR')
    // 不允许对入口行调用 remove()（删掉就没有 .ah-entry-icon 锚点了）。
    expect(mount).not.toContain('hiddenRow?.remove()')
    expect(css).toContain(`[${SPACE_HIDE_ENTRY_ATTR}='true'] { display: none !important; }`)
  })

  it('退出时清理自有节点与侧栏标记', () => {
    expect(mount).toContain('switcher?.remove()')
    expect(mount).toContain('team?.remove()')
    expect(mount).toContain('root.removeAttribute(SPACE_ROOT_ATTR)')
    expect(mount).toContain('root.removeAttribute(SPACE_MODE_ATTR)')
    expect(mount).toContain('root.removeAttribute(SPACE_COMPACT_ATTR)')
  })

  it('顶部双 Tab 只在 slot 时渲染，并复用共享切换控件', () => {
    expect(modeSwitch).toContain("space.kind !== 'slot'")
    expect(modeSwitch).toContain('<SpaceSwitch')
    expect(modeSwitch).toContain('compact={space.compact}')
  })

  it('队友导航只在队友模式且挂载点存在时渲染', () => {
    expect(teamSidebar).toContain('space.team')
    expect(teamSidebar).toContain("mode !== 'team'")
    expect(teamSidebar).toContain('<TeamSidebarNav')
  })

  it('团队模式下显式隐藏原生功能列表与工作区区域，对话模式原样恢复（P44）', () => {
    // 主人截图里的两套侧栏并存：原生 panelList / regionArea 还在，团队工作区另起一列。
    // 现在由 markNative 打属性隐藏，切回对话模式逐个移除，不删宿主节点。
    expect(mount).toContain('SPACE_HIDE_NATIVE_ATTR')
    expect(mount).toContain("const selectors = ['[class*=\"panelList\"]', '[class*=\"regionArea\"]']")
    expect(mount).toContain("markNative(currentMode === 'team')")
    expect(mount).toContain('markNative(false)')
    expect(css).toContain(`[${SPACE_HIDE_NATIVE_ATTR}='true'] { display: none !important; }`)
    // 原生「新会话」入口在团队模式下保留：隐藏规则必须给它例外。
    expect(css).toContain(":not([class*='newSession'])")
    // 收起态不再删掉团队导航节点，否则图标列无处渲染。
    expect(mount).toContain('队友导航常驻 DOM')
  })

  it('入口行文案改为「团队空间」，不再按收件箱数改 label', () => {
    expect(index).toContain("label: '团队空间'")
    expect(index).not.toContain('entryLabel')
  })

  it('切换空间同时更新模式与中栏页面', () => {
    expect(index).toContain('saveSpaceMode(storage, next)')
    expect(index).toContain('layout.selectPanel(targetPanel(next))')
    expect(index).toContain('watchHostSpace(document')
  })
})

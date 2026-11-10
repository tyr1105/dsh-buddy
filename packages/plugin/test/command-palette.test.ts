/**
 * 跳转面板契约（WCAG 2.4.5 多种查找方式）。
 *
 * 两条线一起锁：
 * 1. 纯逻辑：七个视图一个不少、中文与别名都能搜到、上下移动会绕回；
 * 2. 组件与挂载：面板必须是模态对话框、只在打开时渲染（关闭不占布局）、
 *    键盘能搜能选能回车，顶栏没有「跳转」按钮（只靠 ⌘K / Ctrl+K 进入），旧的整行快速导航彻底删除。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  COMMAND_ACTIONS, COMMAND_ITEMS, COMMAND_VIEWS, filterCommands, stepActiveIndex,
} from '../src/client/logic/command-palette.js'

const clientRoot = new URL('../src/client/', import.meta.url)
const source = readFileSync(new URL('components/command-palette.tsx', clientRoot), 'utf8')
const logicSource = readFileSync(new URL('logic/command-palette.ts', clientRoot), 'utf8')
const hubSource = readFileSync(new URL('pages/HubPage.tsx', clientRoot), 'utf8')
const topBarSource = readFileSync(new URL('components/TopBar.tsx', clientRoot), 'utf8')
const cssSource = readFileSync(new URL('styles.css', clientRoot), 'utf8')
// 顶栏布局规则写在 workspace.css（P61 的断言要查这一份，只查 styles.css 永远为真）。
const workspaceCssSource = readFileSync(new URL('workspace.css', clientRoot), 'utf8')

describe('跳转面板清单', () => {
  it('七个一级视图全部可达，id 与仓库视图一一对应', () => {
    expect(COMMAND_VIEWS.map(item => item.id)).toEqual(
      ['main', 'office', 'inbox', 'activity', 'resource', 'project', 'settings'],
    )
  })

  it('视图文案稳定，与左栏主入口共用同一套中文名（3.2.4 一致标识）', () => {
    expect(COMMAND_VIEWS.map(item => item.label)).toEqual(
      ['队友', '办公室', '待你处理', '动态', '资料', '项目', '设置'],
    )
  })

  it('附带两个常用动作，不让面板变成第二个设置页', () => {
    expect(COMMAND_ACTIONS.map(item => item.id)).toEqual(['new-bot', 'refresh'])
    expect(COMMAND_ITEMS.length).toBe(COMMAND_VIEWS.length + COMMAND_ACTIONS.length)
  })
})

describe('跳转面板搜索', () => {
  it('空查询返回全部目的地', () => {
    expect(filterCommands('').length).toBe(COMMAND_ITEMS.length)
    expect(filterCommands('   ').length).toBe(COMMAND_ITEMS.length)
  })

  it('按页面名精确命中', () => {
    expect(filterCommands('办公室').map(item => item.id)).toEqual(['office'])
  })

  it('旧名与口语别名也能命中', () => {
    expect(filterCommands('收件箱').map(item => item.id)).toEqual(['inbox'])
    expect(filterCommands('看板').map(item => item.id)).toEqual(['project'])
    expect(filterCommands('偏好').map(item => item.id)).toEqual(['settings'])
  })

  it('动作可搜，多个词要同时命中', () => {
    expect(filterCommands('刷新').map(item => item.id)).toEqual(['refresh'])
    expect(filterCommands('新建 队友').map(item => item.id)).toEqual(['new-bot'])
  })

  it('没有匹配时返回空数组，不退回全部', () => {
    expect(filterCommands('zzz-not-exist')).toEqual([])
  })
})

describe('跳转面板键盘下标', () => {
  it('向下越过末尾回到第一条，向上越过开头回到最后一条', () => {
    expect(stepActiveIndex(0, 3, 1)).toBe(1)
    expect(stepActiveIndex(2, 3, 1)).toBe(0)
    expect(stepActiveIndex(0, 3, -1)).toBe(2)
  })

  it('没有结果时下标为 -1，不会选中不存在的条目', () => {
    expect(stepActiveIndex(0, 0, 1)).toBe(-1)
  })
})

describe('跳转面板组件契约', () => {
  it('是带可访问名的模态对话框，读屏能识别为「跳转」', () => {
    expect(source).toContain('role="dialog"')
    expect(source).toContain('aria-modal="true"')
    expect(source).toContain('aria-label="跳转"')
    expect(source).toContain('role="listbox"')
  })

  it('关闭时不渲染任何节点，因此不占常驻布局', () => {
    expect(source).toContain('if (!props.open) return null')
  })

  it('键盘可搜可选可回车：箭头、Enter、Esc 都有处理', () => {
    for (const key of ['ArrowDown', 'ArrowUp', 'Enter', 'Escape']) {
      expect(source).toContain(`event.key === '${key}'`)
    }
    expect(source).toContain('inputRef.current?.focus()')
    expect(source).toContain('aria-activedescendant')
  })

  it('不在组件里直接碰仓库或网络，只通过回调交回宿主', () => {
    expect(source).not.toContain('useStore')
    expect(source).not.toContain('fetch(')
    expect(source).toContain('props.onNavigate')
    expect(source).toContain('props.onAction')
  })

  it('逻辑文件不依赖 DOM，检索与下标都是纯函数', () => {
    expect(logicSource).not.toContain('document.')
    expect(logicSource).not.toContain('window.')
  })
})

describe('跳转面板挂载契约', () => {
  it('HubPage 挂载 CommandPalette，旧的 QuickNav 彻底删除', () => {
    expect(hubSource).toContain("from '../components/command-palette.js'")
    expect(hubSource).toContain('<CommandPalette')
    expect(hubSource).not.toContain('QuickNav')
    expect(hubSource).not.toContain('quick-nav')
  })

  it('⌘K / Ctrl+K 可在任意视图打开或收起面板', () => {
    expect(hubSource).toContain("event.key.toLowerCase() === 'k'")
    expect(hubSource).toContain('event.metaKey || event.ctrlKey')
    expect(hubSource).toContain('setPaletteOpen(open => !open)')
  })

  it('面板切视图与顶栏同口径：刷新对应表面，收件箱走 openInbox', () => {
    expect(hubSource).toContain('handlePaletteNavigate')
    expect(hubSource).toContain('hub.setView(target)')
    expect(hubSource).toContain("if (target === 'inbox') { openInbox(); return }")
  })

  it('顶栏没有「跳转」和「新建队友」按钮，也不再接收这两个回调（P61）', () => {
    // 主人 2026-11-10 要求删除：顶栏只留标题、状态句和额度灯。
    expect(topBarSource).not.toContain('>跳转</button>')
    expect(topBarSource).not.toContain('>新建队友</button>')
    expect(topBarSource).not.toContain('onOpenPalette')
    expect(topBarSource).not.toContain('onNewBot')
    expect(topBarSource).not.toContain('aria-haspopup')
    expect(topBarSource).not.toContain('aria-keyshortcuts')
    // HubPage 调用 TopBar 时不再传回调。
    expect(hubSource).toMatch(/<TopBar overview=\{overview\} \/>/)
  })

  it('跳转面板仍由 ⌘K / Ctrl+K 快捷键打开，不依赖顶栏按钮（P61）', () => {
    expect(hubSource).toContain('setPaletteOpen(open => !open)')
    expect(hubSource).toContain('<CommandPalette')
  })

  it('新建队友入口仍在左栏队友组（P61）', () => {
    const sidebarSource = readFileSync(new URL('components/team-sidebar.tsx', clientRoot), 'utf8')
    const groupSource = readFileSync(new URL('components/sidebar-teammates-group.tsx', clientRoot), 'utf8')
    expect(sidebarSource).toContain('props.hub.requestNewBot()')
    expect(groupSource).toContain('aria-label="新建队友"')
  })

  it('顶栏不放任何页面切换，导航只留左栏一套（P61）', () => {
    // 主人 2026-11-10 要求删除：所有页面的「队友 / 当前页 | 动态 | 项目」都不再显示。
    expect(topBarSource).not.toContain('onOpenOffice')
    expect(topBarSource).not.toContain('onOpenInbox')
    expect(topBarSource).not.toContain('onOpenActivity')
    expect(topBarSource).not.toContain('onOpenProject')
    expect(topBarSource).not.toContain('>办公室</button>')
    expect(topBarSource).not.toContain('>动态</button>')
    expect(topBarSource).not.toContain('>项目</button>')
    expect(topBarSource).not.toContain('PAGE_TITLES')
    expect(topBarSource).not.toContain('ah-topbar-here')
    expect(topBarSource).not.toContain('ah-topbar-nav')
    // 样式也要一起清掉，不留下没人用的规则。
    expect(workspaceCssSource).not.toContain('.ah-topbar-nav')
    expect(workspaceCssSource).not.toContain('.ah-topbar-here')
  })

  it('动态页在顶栏删除后仍能从跳转面板进入（P61）', () => {
    expect(COMMAND_VIEWS.map(item => item.id)).toContain('activity')
  })
})

describe('跳转面板样式契约', () => {
  it('遮罩固定覆盖，面板限定宽度并可内部滚动', () => {
    expect(cssSource).toMatch(/\.ah-cmdk-mask\s*\{[^}]*position:\s*fixed/)
    expect(cssSource).toMatch(/\.ah-cmdk\s*\{[^}]*max-height:\s*70vh/)
    expect(cssSource).toMatch(/\.ah-cmdk-list\s*\{[^}]*overflow-y:\s*auto/)
  })

  it('旧的整行快速导航样式已删除', () => {
    expect(cssSource).not.toContain('.ah-quick-nav')
  })
})

describe('跳转面板模态语义（U01 r42：与五个弹窗同一套焦点与背景隔离）', () => {
  it('接入 useDialogFocus 并把 ref 挂到对话框：Tab 困守、背景 inert、还焦都走统一实现', () => {
    expect(source).toContain("from './use-dialog-focus.js'")
    expect(source).toContain('useDialogFocus(props.onClose, false)')
    expect(source).toContain('ref={dialogRef}')
  })

  it('HubPage 只在打开时挂载面板：hook 在挂载渲染期抓住的才是触发钮', () => {
    // 旧写法常驻挂载，hook 的 previousRef 首次渲染时抓到 body，关闭后无法还焦触发钮。
    expect(hubSource).toContain('{paletteOpen ?')
    expect(hubSource).toContain('<CommandPalette')
  })
})

describe('顶栏额度的窄窗收纳（U01 r42：状态信号按优先级降级，不整条消失）', () => {
  it('额度文案包在 ah-quota-text 里，整条补读屏全名与悬停全文', () => {
    expect(topBarSource).toContain('className="ah-quota-text"')
    expect(topBarSource).toMatch(/aria-label=\{`额度：/)
    expect(topBarSource).toContain('title=')
  })

  it('≤1100 容器只收起文案；灯点节点保留，禁止再整条 display:none', () => {
    expect(workspaceCssSource).toContain('.ah-quota-text { display: none; }')
    expect(workspaceCssSource).not.toMatch(/\.ah-quota\s*\{\s*display:\s*none/)
  })
})

/**
 * 跳转面板契约（WCAG 2.4.5 多种查找方式）。
 *
 * 两条线一起锁：
 * 1. 纯逻辑：七个视图一个不少、中文与别名都能搜到、上下移动会绕回；
 * 2. 组件与挂载：面板必须是模态对话框、只在打开时渲染（关闭不占布局）、
 *    键盘能搜能选能回车，顶栏只有一个「跳转」按钮，旧的整行快速导航彻底删除。
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

  it('顶栏只有一个「跳转」按钮，带对话框语义与快捷键说明', () => {
    expect(topBarSource).toContain('>跳转</button>')
    expect(topBarSource).toContain('aria-haspopup="dialog"')
    expect(topBarSource).toContain('aria-keyshortcuts="Meta+K Control+K"')
    expect(topBarSource).toContain('onOpenPalette')
  })

  it('顶栏不再重复办公室/待你处理入口，原位置显示当前位置（P1-1）', () => {
    // 主入口只有左栏一套：顶栏删掉这两个同名同目的地的按钮与其 props。
    expect(topBarSource).not.toContain('onOpenOffice')
    expect(topBarSource).not.toContain('onOpenInbox')
    expect(topBarSource).not.toContain('>办公室</button>')
    // 原位置是「队友 / 当前页」面包屑，离开主视图也能知道自己在哪。
    expect(topBarSource).toContain('PAGE_TITLES')
    expect(topBarSource).toContain('ah-topbar-here')
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

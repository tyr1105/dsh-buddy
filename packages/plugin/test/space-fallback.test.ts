/**
 * P42 降级路径测试：宿主没有一级空间位时，功能导航只多一行「团队空间」入口；
 * 点开这一行落在队友侧，页内切换条可切回对话，切回时不动原生会话状态。
 *
 * 为什么用静态契约：测试环境把 react 指到桩（见 vitest.config.ts），组件不渲染；
 * 这里锁定「降级形态必须遵守的形状」，真实侧栏的显示/隐藏由浏览器走查覆盖。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const clientRoot = new URL('../src/client/', import.meta.url)
const read = (path: string): string => readFileSync(new URL(path, clientRoot), 'utf8')

describe('降级入口', () => {
  const index = read('index.tsx')
  const page = read('pages/TeamSpacePage.tsx')

  it('功能导航只注册一行「团队空间」，不另造第二个入口', () => {
    expect(index.match(/name: 'sidebar\.panellist'/g)?.length).toBe(1)
    expect(index).toContain("label: '团队空间'")
  })

  it('点开入口行时，降级且对话侧才自动落到队友', () => {
    expect(index).toContain("props.space.getSnapshot().kind === 'fallback'")
    expect(index).toContain("props.mode.getSnapshot() === 'chat'")
    expect(index).toContain("switchSpace('team', 'pointer')")
    // 只认 active 由假变真的边沿：切回对话时不能被入口行再拽回队友。
    expect(index).toContain('justActivated')
    expect(index).toContain('wasActive')
  })

  it('切模式只改中栏与本地模式，不碰会话选择与页面内部状态', () => {
    const body = index.slice(index.indexOf('const switchSpace'), index.indexOf('const backToChat'))
    expect(body).toContain('targetPanel')
    expect(body).not.toContain('selectThread')
    expect(body).not.toContain('setView')
  })
})

describe('降级页面', () => {
  const page = read('pages/TeamSpacePage.tsx')

  it('对话侧只说明原生界面保持原样，不在页面内复制会话列表', () => {
    expect(page).not.toContain('BotList')
    expect(page).not.toContain('ThreadPane')
    expect(page).toContain('对话界面保持原生')
    expect(page).toContain('onBackToChat')
  })

  it('页内切换条复用共享控件，不伪造宿主顶部双 Tab', () => {
    expect(page).toContain('<SpaceSwitch')
    expect(page).not.toContain('ah-space-switch-host')
  })
})

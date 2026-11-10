/**
 * 左栏字号层级的源码契约（P59）。
 *
 * 为什么要有这组测试：主人截图指出左栏目录字号不对。根因是每种行各写一个数字
 * （9/10/11/12/13px），字重也在 400、500、600、650 之间跳，分组标题反而比下面的条目小。
 * 对照 DSH 自带左栏（分组标题和条目都是 14px/400，副信息 12px/400）一眼就不协调。
 *
 * 这里把修复后的规则锁住，后面谁再加一种行，也不能各写各的数字：
 * 1. 左栏只有两档字号，集中定义在 .ah-sidebar-nav 的两个变量上；
 * 2. 三组标题的字号字重只在组开关上定义一次，标题文字本身不另写；
 * 3. 分组标题和一级条目同档同字重，不能再出现「标题比条目小」；
 * 4. 次要文字统一 12px，不能回到 9/10/11px；
 * 5. 字变大之后，省略号规则不能丢。
 *
 * 只读 CSS 和组件源码，不渲染；真实界面的字号用隔离预览实测，记录在 docs/progress/P59.md。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('../src/client/workspace.css', import.meta.url), 'utf8')
const navMain = readFileSync(new URL('../src/client/components/team-sidebar-nav.tsx', import.meta.url), 'utf8')

/**
 * 取某个选择器在样式表顶层的声明块。
 * - 选择器必须从行首开始：否则 .ah-nav-session-title 会误中
 *   「.ah-nav-session-current .ah-nav-session-title」这种选中态规则；
 * - 选择器后面只允许空白再接大括号：否则 .ah-nav-session 会误中 .ah-nav-session-current；
 * - 窄屏档 @container 里的规则都有缩进，不是行首开头，天然不会被取到。
 */
const block = (selector: string): string => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = css.match(new RegExp('(?:^|\\n)' + escaped + '\\s*\\{([^}]*)\\}'))
  return match?.[1] ?? ''
}

const MAIN = 'font-size: var(--ah-nav-font-main)'
const MINOR = 'font-size: var(--ah-nav-font-minor)'

describe('P59 左栏字号层级', () => {
  it('只定义两档字号，取值和 DSH 自带左栏一致', () => {
    const root = block('.ah-sidebar-nav')
    expect(root).toContain('--ah-nav-font-main: 14px')
    expect(root).toContain('--ah-nav-font-minor: 12px')
  })

  it('三组标题的字号字重只在组开关上定义一次', () => {
    const toggle = block('.ah-nav-group-toggle')
    expect(toggle).toContain(MAIN)
    expect(toggle).toContain('font-weight: 400')
    // 反例：标题文字一旦自己写字号字重，三组标题就可能各不相同。
    const title = block('.ah-nav-group-title')
    expect(title).not.toBe('')
    expect(title).not.toMatch(/font-(size|weight)/)
  })

  it('一级条目和分组标题同档，字重回到常规', () => {
    for (const selector of ['.ah-nav-item', '.ah-nav-project-name', '.ah-nav-session']) {
      expect(block(selector), `${selector} 没有用主字号`).toContain(MAIN)
    }
    const botName = block('.ah-sidebar-nav .ah-bot-row-name')
    expect(botName).toContain(MAIN)
    expect(botName).toContain('font-weight: 400')
    expect(block('.ah-sidebar-nav .ah-inbox-entry-name')).toContain(MAIN)
    // 反例：项目名以前单独加粗到 600，「工作区」标题就被它压下去了。
    expect(block('.ah-nav-project-name')).toContain('font-weight: 400')
    expect(block('.ah-nav-project-name')).not.toContain('font-weight: 600')
  })

  it('次要文字统一 12px，不能回到 9/10/11px', () => {
    const minorSelectors = [
      '.ah-nav-group-count',
      '.ah-nav-project-count',
      '.ah-nav-scroll-hint',
      '.ah-nav-empty',
      '.ah-nav-row-text',
      '.ah-nav-archived-toggle',
    ]
    for (const selector of minorSelectors) {
      const declarations = block(selector)
      expect(declarations, `${selector} 没有用次要字号`).toContain(MINOR)
      expect(declarations, `${selector} 又写死了小字号`).not.toMatch(/font-size:\s*(9|10|11)px/)
    }
    // 角色和动态是合写的一条规则；窄档里同名选择器另有一条，所以按整段匹配这一条。
    expect(css).toMatch(/\.ah-sidebar-nav \.ah-bot-row-role,\s*\.ah-sidebar-nav \.ah-bot-row-activity\s*\{[^}]*font-size: var\(--ah-nav-font-minor\)/)
    // 「待验收」小标签和项目其他标签同为 11px，不能回到 9px。
    expect(block('.ah-nav-session-flag')).toContain('font-size: 11px')
  })

  it('字变大后省略规则不变，办公室那句灰字能悬停读全文', () => {
    // 这些文字可能很长，放不下时必须省略，不能撑破左栏或逐字竖排。
    for (const selector of ['.ah-nav-group-count', '.ah-nav-item-name', '.ah-nav-project-label', '.ah-nav-session-title']) {
      const declarations = block(selector)
      expect(declarations, `${selector} 丢了省略号`).toContain('text-overflow: ellipsis')
      expect(declarations, `${selector} 丢了 overflow`).toContain('overflow: hidden')
    }
    // 办公室组的灰字会被省略，必须带 title（另外两组的计数本来就有）。
    expect(navMain).toContain('className="ah-nav-group-count" title={status}')
  })
})

/**
 * 「对话 / 队友」切换器的选中样式契约（P57）。
 *
 * 为什么用读样式表的方式测：这条 bug 的根因不是逻辑，而是「切换器挂在宿主侧栏里，
 * 插件的颜色别名只在页面子树内声明」——变量一失效，选中态、轨道、焦点环全部消失，
 * 组件代码看起来却完全正常。所以直接钉住样式表里的三件事：
 * 1) 别名层覆盖到切换器的挂载点；
 * 2) 选中项有不只靠文字颜色的区分（实底 + 描边 + 加粗），未选中项没有；
 * 3) 键盘焦点环单独声明，不依赖 .ah-page 的全站规则。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const clientRoot = new URL('../src/client/', import.meta.url)
const styles = readFileSync(new URL('styles.css', clientRoot), 'utf8')
const workspace = readFileSync(new URL('workspace.css', clientRoot), 'utf8')

/** 取出某条规则的声明部分；找不到时返回 null，让断言报得清楚。 */
function ruleBody(css: string, selector: string): string | null {
  const at = css.indexOf(`${selector} {`)
  if (at < 0) return null
  const open = css.indexOf('{', at)
  return css.slice(open + 1, css.indexOf('}', open))
}

/** 别名层的选择器：声明 --dsw-alias-separator 的那条规则花括号之前的部分。 */
function aliasLayerSelector(): string {
  const declaration = styles.indexOf('--dsw-alias-separator:')
  expect(declaration).toBeGreaterThan(0)
  const open = styles.lastIndexOf('{', declaration)
  return styles.slice(styles.lastIndexOf('}', open) + 1, open)
}

describe('切换器在宿主侧栏里也能取到颜色别名', () => {
  it('别名层覆盖切换器挂载点 .ah-space-switch-host', () => {
    expect(aliasLayerSelector()).toContain('.ah-space-switch-host')
  })

  it('原有的页面、提示层、侧栏队友列表不受影响', () => {
    const selector = aliasLayerSelector()
    expect(selector).toContain('.ah-page')
    expect(selector).toContain('.ah-toast-layer')
    expect(selector).toContain('.ah-host-botlist')
  })
})

describe('选中态一眼可辨', () => {
  const selected = ruleBody(workspace, ".ah-space-switch-btn[aria-pressed='true']")
  const base = ruleBody(workspace, '.ah-space-switch-btn')

  it('选中项同时有实底、描边和加粗', () => {
    expect(selected).not.toBeNull()
    expect(selected).toContain('background:')
    expect(selected).toContain('box-shadow:')
    expect(selected).toContain('font-weight: 700')
  })

  it('用宿主选中色，不用 brand-primary（宿主深色下它是白色，和普通文字分不开）', () => {
    expect(selected).toContain('--dsw-alias-state-business-primary')
    expect(selected).not.toContain('--dsw-alias-brand-primary')
  })

  it('未选中的默认样式没有描边和实底，选中与否才看得出差别', () => {
    expect(base).not.toBeNull()
    expect(base).not.toContain('box-shadow:')
    expect(base).toContain('background: transparent')
  })

  it('选中项图标跟随选中色', () => {
    expect(ruleBody(workspace, ".ah-space-switch-btn[aria-pressed='true'] svg")).toContain('var(--ah-space-selected)')
  })
})

describe('键盘焦点', () => {
  it('切换器自己声明焦点环：全站规则只覆盖 .ah-page / .ah-host-botlist，够不到侧栏顶部', () => {
    const focus = ruleBody(workspace, '.ah-space-switch-btn:focus-visible')
    expect(focus).not.toBeNull()
    expect(focus).toContain('outline: 2px solid')
  })
})

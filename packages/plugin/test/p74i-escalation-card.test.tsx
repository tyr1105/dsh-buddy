/**
 * P74i 三轮不过卡测试（第三类）：初始选中建议项；单选；提交参数（jobId、stage、option、revision）；
 * 提交后按钮不再可点、失败复位；主人选过的旧卡只读；办法整行可点（原生 button，键盘可选）；
 * changeLine 在做法下面另起一行，与做法同一个样式类（同字号、正文颜色）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EscalationCard, type JobCommands } from '../src/client/components/JobCard.js'
import { sampleEscalationCard, sampleEscalationOldCard } from '../src/shared/fixture-job.js'
import type { EscalationCardView } from '../src/shared/views.js'
import { createHookHost } from './helpers/hook-host.js'
import { findElements, type StubElement } from './helpers/jsx-runtime-stub.js'

vi.mock('react', async () => (await import('./helpers/hook-host.js')).reactFacade)

function textOf(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object' && node !== null && 'props' in node) return textOf((node as StubElement).props.children)
  return ''
}
const classOf = (node: StubElement): string => String(node.props.className ?? '')
const buttons = (tree: unknown): StubElement[] => findElements(tree, 'button')
const optionButtons = (tree: unknown): StubElement[] => buttons(tree).filter(node => classOf(node).startsWith('ah-esc-option'))
const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

const newCard: EscalationCardView = sampleEscalationCard.kind === 'escalation' ? sampleEscalationCard : (() => { throw new Error('应是三轮不过卡') })()
const oldCard: EscalationCardView = sampleEscalationOldCard.kind === 'escalation' ? sampleEscalationOldCard : (() => { throw new Error('应是三轮不过卡') })()
const commandsOf = (choose: JobCommands['choose']): JobCommands => ({ accept: vi.fn(async () => ({ ok: true as const })), choose, preview: vi.fn(async () => ({ ok: true as const })) })

afterEach(() => vi.clearAllMocks())

describe('三轮不过卡（P74i）', () => {
  it('四段都在：受阻原因、已尝试的办法、可选的办法、按钮行加建议理由', () => {
    const tree = createHookHost().render(EscalationCard, { card: newCard })
    const text = textOf(tree)
    expect(text).toContain('提问')
    expect(text).toContain('林舟无法继续')
    expect(text).toContain('等你决定')
    // P74i-m3（第 7 节）：两个小标题改为书面表达（原「卡在哪」「试过什么」）。
    expect(text).toContain('受阻原因')
    expect(text).toContain('已尝试的办法')
    expect(text).toContain('按所选办法处理')
    expect(text).toContain('建议 A 的理由：换一家服务商比再改约定更快。')
    // P74r5 之后 core 的小标题在字母之间加了空格（「B 或 C」）。
    expect(text).toContain('可选的办法　选 B 或 C 即记为约定第 2 版，不再另外请你确认')
  })

  it('初始选中建议项（A），单选：点别的办法换选中，aria-checked 跟着换（P74i-m2 低-6 起按单选语义）', () => {
    const host = createHookHost()
    const first = host.render(EscalationCard, { card: newCard, commands: commandsOf(vi.fn(async () => ({ ok: true as const }))) })
    const options = optionButtons(first)
    expect(options).toHaveLength(3)
    // 外层是 radiogroup（以小标题命名），每个办法是 role=radio 的单选项。
    expect(findElements(first, 'div').find(node => node.props.role === 'radiogroup')!.props['aria-label']).toContain('可选的办法')
    expect(options[0]!.props.role).toBe('radio')
    expect(options[0]!.props['aria-checked']).toBe(true)
    expect(options[1]!.props['aria-checked']).toBe(false)
    // 建议项带「建议」小标签；第二个办法的标题与做法都在行里。
    expect(textOf(options[0])).toContain('建议')
    expect(textOf(options[1])).toContain('B　把这一条改为允许提交、后台补全')
    // 点 C：选中换到 C（单选），A 不再选中。
    ;(options[2]!.props.onClick as () => void)()
    const second = host.render(EscalationCard, { card: newCard, commands: commandsOf(vi.fn(async () => ({ ok: true as const }))) })
    const changed = optionButtons(second)
    expect(changed[2]!.props['aria-checked']).toBe(true)
    expect(changed[0]!.props['aria-checked']).toBe(false)
  })

  it('方向键在办法之间移动并选中（P74i-m2 低-6：单选的键盘操作），不可选的卡不暴露为单选', () => {
    const host = createHookHost()
    const first = host.render(EscalationCard, { card: newCard, commands: commandsOf(vi.fn(async () => ({ ok: true as const }))) })
    const options = optionButtons(first)
    const keys: Array<[string, number]> = [['ArrowDown', 1], ['ArrowRight', 2], ['ArrowUp', 1], ['ArrowLeft', 0]]
    let tree = first
    for (const [key, expected] of keys) {
      const current = optionButtons(tree).findIndex(node => node.props['aria-checked'] === true)
      ;(optionButtons(tree)[current]!.props.onKeyDown as (event: { key: string; preventDefault(): void; currentTarget: HTMLElement }) => void)({ key, preventDefault: () => {}, currentTarget: {} as HTMLElement })
      tree = host.render(EscalationCard, { card: newCard, commands: commandsOf(vi.fn(async () => ({ ok: true as const }))) })
      expect(optionButtons(tree)[expected]!.props['aria-checked'], key).toBe(true)
    }
    // 主人选过的旧卡（不可选）：办法不是单选项，外层也不是 radiogroup。
    const readonlyTree = createHookHost().render(EscalationCard, { card: oldCard })
    expect(findElements(readonlyTree, 'div').some(node => node.props.role === 'radiogroup')).toBe(false)
    expect(findElements(readonlyTree, 'div').some(node => node.props.role === 'radio')).toBe(false)
  })

  it('changeLine 在做法下面另起一行，与做法同一个样式类（同字号、正文颜色）', () => {
    const tree = createHookHost().render(EscalationCard, { card: newCard })
    const optionB = optionButtons(tree)[1] as StubElement
    const detail = findElements(optionB, 'span').filter(node => classOf(node).startsWith('ah-esc-option-detail'))
    // B 办法：一行做法 + 一行 changeLine，两行同一个样式类。
    expect(detail).toHaveLength(2)
    expect(textOf(detail[0]!)).toBe('页面不再拦格式，名单由后台整理。')
    expect(textOf(detail[1]!)).toBe('选了会把「怎样算做完」第 3 条改为：手机号少填一位时，允许提交，由后台补全。')
    expect(classOf(detail[1]!).startsWith('ah-esc-option-detail')).toBe(true)
    expect(classOf(detail[0]!).startsWith('ah-esc-option-detail')).toBe(true)
    // A 办法不带改动：没有 changeLine 行。
    const optionA = optionButtons(tree)[0] as StubElement
    expect(findElements(optionA, 'span').filter(node => classOf(node).startsWith('ah-esc-option-detail'))).toHaveLength(1)
  })

  it('提交参数：jobId、stage、option（从 0 起）与修订号；不会自动提交，必须主人点按钮', () => {
    const choose = vi.fn(async () => ({ ok: true as const }))
    const host = createHookHost()
    const commands = commandsOf(choose)
    const first = host.render(EscalationCard, { card: newCard, commands })
    // 初始选中 A，先点 C 再提交：option 是 2。
    const options = optionButtons(first)
    ;(options[2]!.props.onClick as () => void)()
    const picked = host.render(EscalationCard, { card: newCard, commands })
    ;(buttons(picked).find(node => textOf(node) === '按所选办法处理')!.props.onClick as () => void)()
    expect(choose).toHaveBeenCalledTimes(1) // 点击后立即发出，参数在下面校验。
    return flush().then(() => {
      expect(choose).toHaveBeenCalledWith({ jobId: 'job_sample0006', stage: 1, option: 2, revision: 1 })
    })
  })

  it('提交中按钮写「正在记下…」并置灰；成功后保持到视图刷新（10 秒兜底在 p74i-m1 里单测）；失败恢复并显示错误', async () => {
    // 失败：按钮恢复、显示 core 的中文错误。
    const failing = vi.fn(async () => ({ ok: false as const, error: '这张卡已不是最新的一张，请看新的说明' }))
    const host = createHookHost()
    const commands = commandsOf(failing)
    const first = host.render(EscalationCard, { card: newCard, commands })
    ;(buttons(first).find(node => textOf(node) === '按所选办法处理')!.props.onClick as () => void)()
    // P74i-m1（走查 E-7）：提交中的文字与交付卡一致——「正在记下…」。
    const busy = host.render(EscalationCard, { card: newCard, commands })
    expect(buttons(busy).find(node => textOf(node) === '正在记下…')!.props.disabled).toBe(true)
    await flush()
    const after = host.render(EscalationCard, { card: newCard, commands })
    const restored = buttons(after).find(node => textOf(node) === '按所选办法处理')!
    expect(restored.props.disabled).toBe(false)
    expect(textOf(after)).toContain('这张卡已不是最新的一张，请看新的说明')
    // 成功：按钮保持「正在记下…」（防止重复提交），没有错误。
    const ok = vi.fn(async () => ({ ok: true as const }))
    const host2 = createHookHost()
    const commands2 = commandsOf(ok)
    const t = host2.render(EscalationCard, { card: newCard, commands: commands2 })
    ;(buttons(t).find(node => textOf(node) === '按所选办法处理')!.props.onClick as () => void)()
    await flush()
    const done = host2.render(EscalationCard, { card: newCard, commands: commands2 })
    expect(buttons(done).find(node => textOf(node) === '正在记下…')!.props.disabled).toBe(true)
    expect(textOf(done)).not.toContain('这张卡')
  })

  it('主人选过的旧卡只读：办法不是按钮、「按所选办法处理」消失、状态是「你选了 B」', () => {
    const tree = createHookHost().render(EscalationCard, { card: oldCard })
    expect(textOf(tree)).toContain('你选了 B')
    expect(buttons(tree)).toHaveLength(0)
    // 办法还在（普通一行），选过的那个办法仍在列表里。
    expect(textOf(tree)).toContain('B　把这一条改为允许提交、后台补全')
  })

  it('键盘可选：办法是原生 button（type=button，Tab 能到，Enter 或空格由浏览器触发 click）；方向键另有处理（P74i-m2 低-6）', () => {
    const tree = createHookHost().render(EscalationCard, { card: newCard, commands: commandsOf(vi.fn(async () => ({ ok: true as const }))) })
    for (const option of optionButtons(tree)) {
      expect(option.type).toBe('button')
      expect(option.props.type).toBe('button')
      expect(option.props.tabIndex).toBeUndefined()
      // 方向键（上下左右）现在由组件处理：在办法之间移动并选中（单选的键盘操作）。
      expect(typeof option.props.onKeyDown).toBe('function')
    }
  })
})

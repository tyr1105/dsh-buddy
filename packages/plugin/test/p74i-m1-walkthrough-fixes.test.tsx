/**
 * P74i-m1 走查修复的测试（第一次）：
 * - 大图弹窗（走查 D-11，必须新增的测试第 6 条）：全屏遮罩、role="dialog"、aria-modal="true"、
 *   打开时焦点进入弹窗（弹窗可聚焦）、Esc 和点遮罩关闭、焦点回到缩略图（returnFocus）；
 *   Tab 的焦点圈抽成纯函数 trapTabIn 单测（循环、刚打开时回到第一个、没有可聚焦元素时不拦）。
 * - 提交中的状态（走查 D-7、E-7，必须新增的测试第 7 条）：两张卡一致——提交中写「正在记下…」并不可点；
 *   失败恢复并显示原因；成功后保持到卡片状态变化；成功后 10 秒卡片仍是原状就恢复可点（假时钟）。
 * - 项目页状态标签（走查 S-3，必须新增的测试第 8 条前半）：四种 stateTone 对应四个不同的类名。
 * 样例取自 fixture-job.ts（core 的视图函数生成）；命令与定时器用假实现。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DeliveryCard, EscalationCard, type JobCommands } from '../src/client/components/JobCard.js'
import { ShotThumb } from '../src/client/components/EvidenceList.js'
import { clearShotCache, returnFocus, toneClass, trapTabIn } from '../src/client/logic/job.js'
import {
  SAMPLE_SHOT_REF, sampleDeliveryAwaitingCard, sampleEscalationCard,
} from '../src/shared/fixture-job.js'
import type { DeliveryCardView, EscalationCardView } from '../src/shared/views.js'
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

const deliveryCard: DeliveryCardView = sampleDeliveryAwaitingCard.kind === 'delivery' ? sampleDeliveryAwaitingCard : (() => { throw new Error('应是交付卡') })()
const escalationCard: EscalationCardView = sampleEscalationCard.kind === 'escalation' ? sampleEscalationCard : (() => { throw new Error('应是三轮不过卡') })()
const okCommands = (over: Partial<JobCommands> = {}): JobCommands => ({
  accept: vi.fn(async () => ({ ok: true as const })),
  choose: vi.fn(async () => ({ ok: true as const })),
  preview: vi.fn(async () => ({ ok: true as const })),
  ...over,
})

// ---------------------------------------------------------------------------
// 大图弹窗（走查 D-11）
// ---------------------------------------------------------------------------

/** 打开大图的前置：等截图读取完成（进入视口 + 一次微任务），返回带弹窗的那次渲染树。 */
async function openLightbox(): Promise<{ host: ReturnType<typeof createHookHost>; tree: unknown; overlay: StubElement; dialog: StubElement }> {
  const observer = fakeObserver()
  vi.stubGlobal('IntersectionObserver', observer.Ctor)
  const readShot = vi.fn(async () => ({ ok: true as const, data: { dataUrl: 'data:image/png;base64,AAA' } }))
  const host = createHookHost()
  const render = () => host.render(ShotThumb, { shotRef: SAMPLE_SHOT_REF, evidence: EVIDENCE, readShot })
  render()
  observer.enterView()
  render()
  await new Promise(resolve => setTimeout(resolve, 0))
  const loaded = render()
  ;(buttons(loaded).find(node => classOf(node).startsWith('ah-shot-btn'))!.props.onClick as () => void)()
  const tree = render()
  const overlay = findElements(tree, 'div').find(node => classOf(node) === 'ah-shot-overlay')
  const dialog = findElements(tree, 'div').find(node => node.props.role === 'dialog')
  if (overlay === undefined || dialog === undefined) throw new Error('遮罩与弹窗都应在')
  return { host, tree, overlay: overlay!, dialog: dialog! }
}

const EVIDENCE = {
  id: 'ev1', kind: 'image' as const, label: '手机　390 宽', path: '证据/手机.png', url: null,
  summary: '手机　390 宽', checkText: null,
}

/** 复刻 p74h-evidence 的假 IntersectionObserver：enterView() 让所有观察目标进入视口。 */
function fakeObserver() {
  const callbacks: Array<(records: Array<{ isIntersecting: boolean }>) => void> = []
  const Ctor = class {
    constructor(callback: (records: Array<{ isIntersecting: boolean }>) => void) { callbacks.push(callback) }
    observe(): void { /* 等 enterView */ }
    disconnect(): void { /* 测试里不用 */ }
  }
  return { Ctor, enterView: () => { for (const callback of callbacks) callback([{ isIntersecting: true }]) } }
}

describe('大图弹窗（P74i-m1，走查 D-11）', () => {
  beforeEach(() => { vi.useFakeTimers(); clearShotCache() })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); clearShotCache() })

  it('大图是全屏遮罩弹窗：遮罩层、role=dialog、aria-modal、弹窗本身可聚焦（焦点进入的落点）、右上角「关闭」', async () => {
    vi.useRealTimers() // 这一条只看结构，不需要假时钟。
    const { overlay, dialog } = await openLightbox()
    // 遮罩在弹窗外层，点击空白处关闭（onClick 挂在遮罩上）；弹窗拦截自己的点击。
    expect(classOf(overlay)).toBe('ah-shot-overlay')
    expect(typeof overlay.props.onClick).toBe('function')
    expect(dialog.props.role).toBe('dialog')
    expect(dialog.props['aria-modal']).toBe('true')
    expect(dialog.props.tabIndex).toBe(-1) // 打开时焦点进入弹窗的落点（useEffect 调 focus）
    expect(typeof dialog.props.onClick).toBe('function')
    expect(typeof dialog.props.onKeyDown).toBe('function')
    // 右上角的「关闭」按钮也在焦点圈里（trapTabIn 的第二个元素）。
    const close = buttons(dialog).find(node => classOf(node).includes('ah-shot-dialog-close'))!
    expect(textOf(close)).toBe('关闭')
  })

  it('Esc 关闭、点遮罩空白处关闭；点弹窗自身不关闭', async () => {
    vi.useRealTimers()
    const { host, overlay, dialog } = await openLightbox()
    const render = () => host.render(ShotThumb, { shotRef: SAMPLE_SHOT_REF, evidence: EVIDENCE, readShot: vi.fn(async () => ({ ok: true as const, data: { dataUrl: 'data:image/png;base64,AAA' } })) })
    // 点弹窗自身（stopPropagation）：不关闭。
    ;(dialog.props.onClick as (event: { stopPropagation(): void }) => void)({ stopPropagation: () => { /* 拦下冒泡 */ } })
    expect(findElements(render(), 'div').some(node => node.props.role === 'dialog')).toBe(true)
    // Esc：关闭。
    ;(dialog.props.onKeyDown as (event: { key: string }) => void)({ key: 'Escape' })
    expect(findElements(render(), 'div').some(node => node.props.role === 'dialog')).toBe(false)
    // 重新打开后点遮罩空白处：关闭。
    const again = render()
    ;(buttons(again).find(node => classOf(node).startsWith('ah-shot-btn'))!.props.onClick as () => void)()
    ;(overlay.props.onClick as () => void)()
    expect(findElements(render(), 'div').some(node => node.props.role === 'dialog')).toBe(false)
  })

  it('焦点圈（trapTabIn）：Tab 循环、Shift+Tab 反向、焦点不在圈里回到第一个；没有可聚焦元素时不拦', () => {
    const a = { focus: vi.fn() }
    const b = { focus: vi.fn() }
    expect(trapTabIn([a, b], a, false)).toBe(true) // 在第一个上按 Tab → 第二个
    expect(b.focus).toHaveBeenCalledTimes(1)
    expect(trapTabIn([a, b], b, false)).toBe(true) // 在最后一个上按 Tab → 回到第一个（循环）
    expect(a.focus).toHaveBeenCalledTimes(1)
    expect(trapTabIn([a, b], a, true)).toBe(true) // 在第一个上按 Shift+Tab → 最后一个（反向循环）
    expect(b.focus).toHaveBeenCalledTimes(2)
    expect(trapTabIn([a, b], null, false)).toBe(true) // 焦点不在圈里（刚打开）→ 第一个
    expect(a.focus).toHaveBeenCalledTimes(2)
    expect(trapTabIn([null, {}], null, false)).toBe(false) // 没有可聚焦元素：不拦，交给浏览器
    // 关闭后焦点回到缩略图（returnFocus）：元素有 focus 就调用。
    const thumb = { focus: vi.fn() }
    returnFocus(thumb)
    expect(thumb.focus).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// 提交中的状态（走查 D-7、E-7）
// ---------------------------------------------------------------------------

describe('提交中的状态（P74i-m1，走查 D-7、E-7）', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  /** 等 Promise 微任务跑完（命令的 then 回调在微任务里，不走定时器）。 */
  const drain = async (): Promise<void> => { for (let i = 0; i < 5; i += 1) await Promise.resolve() }

  it('交付卡：成功后保持「正在记下…」；卡片状态变化后复位；10 秒仍是原状就恢复可点（不显示错误）', async () => {
    const commands = okCommands()
    const host = createHookHost()
    const render = (card: DeliveryCardView) => host.render(DeliveryCard, { card, commands })
    ;(buttons(render(deliveryCard)).find(node => textOf(node) === '验收通过')!.props.onClick as () => void)()
    await drain()
    // 成功后：按钮保持「正在记下…」且不可点（等视图刷新成只读）。
    const holding = render(deliveryCard)
    const busy = buttons(holding).find(node => textOf(node) === '正在记下…')!
    expect(busy.props.disabled).toBe(true)
    // 卡片状态变化（视图刷新：待你验收 → 已完成）：按钮复位，卡片变只读的一行。
    const doneCard = { ...deliveryCard, stateText: '已完成　11月17日 18:05', phase: 'accepted' as const, doneHint: '6 条全部符合，你已验收。', actions: { ...deliveryCard.actions, accept: false, hint: null } }
    const refreshed = render(doneCard)
    expect(textOf(refreshed)).toContain('6 条全部符合，你已验收。')
    expect(textOf(refreshed)).not.toContain('正在记下…')
    // 另一张卡走满 10 秒：视图一直没变，按钮恢复可点，不显示错误。
    const commands2 = okCommands()
    const host2 = createHookHost()
    const render2 = (card: DeliveryCardView) => host2.render(DeliveryCard, { card, commands: commands2 })
    ;(buttons(render2(deliveryCard)).find(node => textOf(node) === '验收通过')!.props.onClick as () => void)()
    await drain()
    expect(buttons(render2(deliveryCard)).find(node => textOf(node) === '正在记下…')!.props.disabled).toBe(true)
    await vi.advanceTimersByTimeAsync(10_000)
    const restored = render2(deliveryCard)
    const again = buttons(restored).find(node => textOf(node) === '验收通过')!
    expect(again.props.disabled).toBe(false)
    expect(textOf(restored)).not.toContain('错误')
  })

  it('三轮不过卡：成功后保持「正在记下…」；卡片变成「你选了 X」后复位；10 秒仍是原状就恢复可点', async () => {
    const commands = okCommands()
    const host = createHookHost()
    const render = (card: EscalationCardView) => host.render(EscalationCard, { card, commands })
    ;(buttons(render(escalationCard)).find(node => textOf(node) === '按所选办法处理')!.props.onClick as () => void)()
    await drain()
    expect(buttons(render(escalationCard)).find(node => textOf(node) === '正在记下…')!.props.disabled).toBe(true)
    // 视图刷新：状态变成「你选了 A」、chosen 不再是 null——卡片只读，提交按钮消失。
    const chosenCard = { ...escalationCard, stateText: '你选了 A', chosen: 'A' }
    const refreshed = render(chosenCard)
    expect(textOf(refreshed)).toContain('你选了 A')
    expect(buttons(refreshed).some(node => textOf(node) === '正在记下…')).toBe(false)
    expect(buttons(refreshed).some(node => textOf(node) === '按所选办法处理')).toBe(false)
    // 另一张卡走满 10 秒：视图一直没变，按钮恢复可点。
    const commands2 = okCommands()
    const host2 = createHookHost()
    const render2 = (card: EscalationCardView) => host2.render(EscalationCard, { card, commands: commands2 })
    ;(buttons(render2(escalationCard)).find(node => textOf(node) === '按所选办法处理')!.props.onClick as () => void)()
    await drain()
    await vi.advanceTimersByTimeAsync(10_000)
    const restored = render2(escalationCard)
    const again = buttons(restored).find(node => textOf(node) === '按所选办法处理')!
    expect(again.props.disabled).toBe(false)
  })

  it('失败恢复并显示原因（两张卡同一条规则，失败路径不涉及时钟）', async () => {
    for (const [Component, label, pick] of [
      [DeliveryCard, '验收通过', (card: DeliveryCardView) => card] as const,
      [EscalationCard, '按所选办法处理', (card: EscalationCardView) => card] as const,
    ]) {
      const commands = okCommands({ accept: vi.fn(async () => ({ ok: false as const, error: '中心正忙，请再试一次' })), choose: vi.fn(async () => ({ ok: false as const, error: '中心正忙，请再试一次' })) })
      const host = createHookHost()
      const render = (card: unknown) => host.render(Component as typeof DeliveryCard, { card, commands } as never)
      const card = label === '验收通过' ? deliveryCard : escalationCard
      ;(buttons(render(card)).find(node => textOf(node) === label)!.props.onClick as () => void)()
      await drain()
      const failed = render(card)
      const restored = buttons(failed).find(node => textOf(node) === label)!
      expect(restored.props.disabled).toBe(false)
      expect(textOf(failed)).toContain('中心正忙，请再试一次')
    }
  })
})

// ---------------------------------------------------------------------------
// 项目页状态标签（走查 S-3）
// ---------------------------------------------------------------------------

describe('项目页状态标签（P74i-m1，走查 S-3）', () => {
  it('四种 stateTone 对应四个不同的类名（run、you、ok、受阻单列的第四种）', () => {
    const classes = [toneClass('run'), toneClass('you'), toneClass('ok'), toneClass('blocked')]
    expect(classes).toEqual(['is-run', 'is-you', 'is-ok', 'is-blocked'])
    expect(new Set(classes).size).toBe(4)
  })
})

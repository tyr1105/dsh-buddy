/**
 * P74i 交付卡测试（第二类）：三种状态（待你验收、已完成、未通过）的渲染；失效的卡只读；
 * 「验收通过」的调用参数（含 stage 与修订号）、失败后按钮复位并显示错误；
 * 打开预览的三种返回（成功、失败带路径、只有错误）。
 * 样例取自 fixture-job.ts（core 的视图函数生成）；命令用假实现注入。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DeliveryCard } from '../src/client/components/JobCard.js'
import type { JobCommands } from '../src/client/components/JobCard.js'
import { EvidenceList } from '../src/client/components/EvidenceList.js'
import {
  sampleDeliveryAwaitingCard, sampleDeliveryDoneCard, sampleDeliveryExpiredCard, sampleDeliveryRedeliveredCard,
  sampleDeliveryReturnedCard, sampleDeliveryStoppedCard, sampleEvidenceItems,
} from '../src/shared/fixture-job.js'
import type { DeliveryCardView } from '../src/shared/views.js'
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
const buttonTexts = (tree: unknown): string[] => buttons(tree).map(node => textOf(node))
/** 等 Promise 链跑完（命令的 then 回调）。 */
const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

const cardOf = (view: typeof sampleDeliveryAwaitingCard): DeliveryCardView => {
  if (view.kind !== 'delivery') throw new Error('应是交付卡')
  return view
}

afterEach(() => vi.clearAllMocks())

describe('交付卡（P74i）', () => {
  it('待你验收：证据清单、两个按钮与提示一行；状态普通色', () => {
    const tree = createHookHost().render(DeliveryCard, { card: cardOf(sampleDeliveryAwaitingCard) })
    const text = textOf(tree)
    expect(text).toContain('交付')
    expect(text).toContain('活动报名页　按约定第 4 版')
    expect(text).toContain('待你验收')
    expect(text).toContain('验收通过')
    expect(text).toContain('在你的电脑上打开预览')
    expect(text).toContain('哪条不符合，直接写序号和问题。')
    // 状态文字不带成功色或警示色。
    const state = findElements(tree, 'span').find(node => classOf(node) === 'ah-job-state')!
    expect(classOf(state)).toBe('ah-job-state')
    expect(findElements(tree, EvidenceList)).toHaveLength(1)
  })

  it('已完成：收起为一行结论加「展开证据」，展开后显示清单与「收起证据」', () => {
    const host = createHookHost()
    const first = host.render(DeliveryCard, { card: cardOf(sampleDeliveryDoneCard) })
    const text = textOf(first)
    expect(text).toContain('已完成　11月17日 18:05')
    expect(text).toContain('6 条全部符合，你已验收。')
    expect(text).toContain('展开证据')
    expect(findElements(first, EvidenceList)).toHaveLength(0)
    // 点击展开：证据清单出现，按钮换成收起。
    ;(buttons(first).find(node => textOf(node) === '展开证据')!.props.onClick as () => void)()
    const opened = host.render(DeliveryCard, { card: cardOf(sampleDeliveryDoneCard) })
    expect(findElements(opened, EvidenceList)).toHaveLength(1)
    expect(buttonTexts(opened)).toContain('收起证据')
    // 完成的卡没有「验收通过」按钮（能不能验收以视图的 actions.accept 为准）。
    expect(buttonTexts(opened)).not.toContain('验收通过')
  })

  it('未通过：只列被指出的条目（你判不符），下方一行 returnedHint', () => {
    const tree = createHookHost().render(DeliveryCard, { card: cardOf(sampleDeliveryReturnedCard) })
    const text = textOf(tree)
    expect(text).toContain('未通过：第 4 条')
    const list = findElements(tree, EvidenceList)[0]!
    expect((list.props.items as Array<{ verdict: { label: string }; note: string | null }>)[0]!.verdict.label).toBe('你判不符')
    expect((list.props.items as Array<{ note: string | null }>)[0]!.note).toBe('名单只有 2 行，少一行。')
    expect(text).toContain('其余 5 条：你未提出问题，保持通过。')
    expect(sampleEvidenceItems(sampleDeliveryReturnedCard)).toHaveLength(1)
  })

  it('三种失效的卡都只读：没有任何按钮', () => {
    for (const view of [sampleDeliveryExpiredCard, sampleDeliveryRedeliveredCard, sampleDeliveryStoppedCard]) {
      const card = cardOf(view)
      const tree = createHookHost().render(DeliveryCard, { card })
      expect(textOf(tree)).toContain(card.stateText)
      expect(buttons(tree)).toHaveLength(0)
    }
  })

  it('「验收通过」调用参数带 jobId、stage 与修订号；点击后置灰，失败后复位并显示 core 的错误', async () => {
    const accept = vi.fn(async () => ({ ok: true as const }))
    const commands: JobCommands = { accept, choose: vi.fn(async () => ({ ok: true as const })), preview: vi.fn(async () => ({ ok: true as const })) }
    const host = createHookHost()
    const card = cardOf(sampleDeliveryAwaitingCard)
    const first = host.render(DeliveryCard, { card, commands })
    const button = buttons(first).find(node => textOf(node) === '验收通过')!
    ;(button.props.onClick as () => void)()
    // 提交中：按钮禁用、文字变「正在记下…」，不会重复发命令。
    const busy = host.render(DeliveryCard, { card, commands })
    const busyButton = buttons(busy).find(node => textOf(node) === '正在记下…')!
    expect(busyButton.props.disabled).toBe(true)
    ;(busyButton.props.onClick as () => void)()
    await flush()
    expect(accept).toHaveBeenCalledTimes(1)
    expect(accept).toHaveBeenCalledWith({ jobId: 'job_sample0004', stage: 1, revision: 0 })

    // 失败：按钮恢复可点、显示 core 返回的中文错误。
    const failing = vi.fn(async () => ({ ok: false as const, error: '这件事已经验收过了' }))
    const host2 = createHookHost()
    const tree2 = host2.render(DeliveryCard, { card, commands: { ...commands, accept: failing } })
    ;(buttons(tree2).find(node => textOf(node) === '验收通过')!.props.onClick as () => void)()
    await flush()
    const after = host2.render(DeliveryCard, { card, commands: { ...commands, accept: failing } })
    const restored = buttons(after).find(node => textOf(node) === '验收通过')!
    expect(restored.props.disabled).toBe(false)
    expect(textOf(after)).toContain('这件事已经验收过了')
  })

  it('打开预览三种返回：成功短暂显示「已打开」；失败显示错误和可复制的路径；没有路径时只显示错误', async () => {
    const card = cardOf(sampleDeliveryAwaitingCard)
    // 1. 成功。
    const okPreview = vi.fn(async () => ({ ok: true as const, path: '/x' }))
    const host1 = createHookHost()
    const t1 = host1.render(DeliveryCard, { card, commands: { accept: vi.fn(async () => ({ ok: true as const })), choose: vi.fn(async () => ({ ok: true as const })), preview: okPreview } })
    ;(buttons(t1).find(node => textOf(node) === '在你的电脑上打开预览')!.props.onClick as () => void)()
    await flush()
    expect(textOf(host1.render(DeliveryCard, { card, commands: { accept: vi.fn(async () => ({ ok: true as const })), choose: vi.fn(async () => ({ ok: true as const })), preview: okPreview } }))).toContain('已打开')
    // 2. 失败带路径。
    const failPreview = vi.fn(async () => ({ ok: false as const, path: '/样例/交付/index.html', error: '没能自动打开，可以复制这个路径自己打开' }))
    const host2 = createHookHost()
    const commands2 = { accept: vi.fn(async () => ({ ok: true as const })), choose: vi.fn(async () => ({ ok: true as const })), preview: failPreview }
    const t2 = host2.render(DeliveryCard, { card, commands: commands2 })
    ;(buttons(t2).find(node => textOf(node) === '在你的电脑上打开预览')!.props.onClick as () => void)()
    await flush()
    const after2 = host2.render(DeliveryCard, { card, commands: commands2 })
    expect(textOf(after2)).toContain('没能自动打开，可以复制这个路径自己打开')
    expect(textOf(findElements(after2, 'code').find(node => classOf(node) === 'ah-job-preview-path')!)).toBe('/样例/交付/index.html')
    // 3. 只有错误（没有路径）。
    const errorPreview = vi.fn(async () => ({ ok: false as const, error: '这件事没有可打开的预览' }))
    const host3 = createHookHost()
    const commands3 = { accept: vi.fn(async () => ({ ok: true as const })), choose: vi.fn(async () => ({ ok: true as const })), preview: errorPreview }
    const t3 = host3.render(DeliveryCard, { card, commands: commands3 })
    ;(buttons(t3).find(node => textOf(node) === '在你的电脑上打开预览')!.props.onClick as () => void)()
    await flush()
    const after3 = host3.render(DeliveryCard, { card, commands: commands3 })
    expect(textOf(after3)).toContain('这件事没有可打开的预览')
    expect(findElements(after3, 'code')).toHaveLength(0)
    // 打开预览失败不影响「验收通过」。
    expect(buttonTexts(after3)).toContain('验收通过')
  })
})

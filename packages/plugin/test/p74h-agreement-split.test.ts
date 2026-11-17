/**
 * P74h 约定卡两栏（B2）与起因一行的测试：
 * - 卡片视图有 jobSplit 时显示两栏（「不受影响，照常在做」「暂停，等你确认」）、
 *   暂停栏下的交付时间一行、按钮旁的退路一行小字；
 * - 没有 jobSplit 时与改动前完全一致（多出来的可选字段不改变卡片）；
 * - 起因一行（originLine）：有值时显示在「来源」那一行的下面、样式相同；为 null 时不显示。
 * 样例取自 fixture-job.ts 的 B2 约定卡（core 的视图函数生成，不手写视图字段）。
 */
import { describe, expect, it, vi } from 'vitest'
import { AgreementCard } from '../src/client/components/AgreementCard.js'
import { sampleAskCard, sampleB2Card } from '../src/shared/fixture-job.js'
import type { AgreementCardView } from '../src/shared/views.js'
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

const card = sampleB2Card!
const render = (view: AgreementCardView, props: { onConfirm?: () => Promise<string | null> } = {}) =>
  createHookHost().render(AgreementCard, { card: view, onConfirm: props.onConfirm ?? (async () => null), startExpanded: true })

describe('约定卡两栏（P74h，B2）', () => {
  it('有 jobSplit 时显示两栏、暂停栏下的交付时间一行、按钮旁的退路一行小字', () => {
    const tree = render(card)
    const headings = findElements(tree, 'p').filter(node => classOf(node) === 'ah-agr-sec-h').map(textOf)
    expect(headings).toContain('不受影响，照常在做')
    expect(headings).toContain('暂停，等你确认')
    const text = textOf(tree)
    expect(text).toContain('页面排版与活动信息')
    expect(text).toContain('名额计数与「名额已满」')
    expect(text).toContain('交付时间不变：11月17日 18:00 前')
    expect(text).toContain('如果「限 80 人」只是文案说法、页面不需要限制，回复「不限」，我保留第 3 版。')
    // 两栏沿用约定卡「这次做 / 这次不做」的版式（同一个两栏容器）。
    expect(findElements(tree, 'div').some(node => classOf(node) === 'ah-agr-split ah-job-split')).toBe(true)
  })

  it('退路显示在「定了」按钮旁（操作区里的一行小字）', () => {
    const tree = render(card)
    const actions = findElements(tree, 'div').find(node => classOf(node) === 'ah-agr-actions')!
    expect(textOf(actions)).toContain('定了')
    expect(textOf(findElements(actions, 'p').find(node => classOf(node) === 'ah-agr-hint ah-job-fallback')))
      .toBe('如果「限 80 人」只是文案说法、页面不需要限制，回复「不限」，我保留第 3 版。')
  })

  it('没有 jobSplit 时卡片与改动前完全一致（两栏标题不出现）', () => {
    const without: AgreementCardView = { ...card, jobSplit: null }
    const tree = render(without)
    const headings = findElements(tree, 'p').filter(node => classOf(node) === 'ah-agr-sec-h').map(textOf)
    expect(headings).not.toContain('不受影响，照常在做')
    expect(headings).not.toContain('暂停，等你确认')
    expect(textOf(tree)).not.toContain('交付时间不变')
    // 与一个根本没有这两个可选字段的视图逐字相同：多出来的字段不改变卡片。
    const bare = { ...card } as Partial<AgreementCardView>
    delete bare.jobSplit
    const stripped = bare as AgreementCardView
    expect(textOf(render(stripped))).toBe(textOf(tree))
  })
})

describe('约定卡的起因一行（P74h，P74r2b；P74h-m1 起样例取提问样例的卡）', () => {
  // P74h-m1 第 5 处：带起因的卡换到提问样例（B2 样例改回主人的材料引起，没有起因一行）。
  const askCard = sampleAskCard!

  it('originLine 有值时显示在「来源」那一行的下面，样式与「来源」一行相同', () => {
    const tree = render(askCard)
    const origin = findElements(tree, 'div').find(node => classOf(node) === 'ah-agr-origin')!
    const lines = findElements(origin, 'p').map(node => ({ class: classOf(node), text: textOf(node) }))
    expect(lines).toEqual([
      { class: 'ah-agr-src', text: '来源：执行中的提问，约定里没有写' },
      { class: 'ah-agr-src', text: '起因：林舟在做这件事时问「同一手机号第二次提交时，页面应该提示「你已报名」，还是照常接受？」，约定里没有写。' },
    ])
  })

  it('P74h-m1 第 5 处：「来源」「起因」两行在卡片内容的最上面（卡头之下、「本版改动」之前）', () => {
    const tree = render(askCard)
    // 卡头用的是行内元素（span），正文里的块从这里开始：第一个 p 就是「来源」一行。
    const paragraphs = findElements(tree, 'p')
    expect(textOf(paragraphs[0]!)).toBe('来源：执行中的提问，约定里没有写')
    // 「来源/起因」块在「本版改动」块之前。
    const order = findElements(tree, 'div')
    const origin = order.find(node => classOf(node) === 'ah-agr-origin')!
    const changes = order.find(node => classOf(node) === 'ah-agr-sec ah-agr-changes')!
    expect(order.indexOf(origin)).toBeLessThan(order.indexOf(changes))
  })

  it('originLine 为 null 时不显示，卡片与原来完全一样', () => {
    // B2 样例（P74h-m1 起为主人的材料引起）与提问样例去掉起因后都不显示这两行。
    expect(card.originLine).toBeNull()
    for (const view of [card, { ...askCard, originLine: null } as AgreementCardView]) {
      const tree = render(view)
      expect(findElements(tree, 'div').some(node => classOf(node) === 'ah-agr-origin')).toBe(false)
      expect(textOf(tree)).not.toContain('起因：')
      expect(textOf(tree)).not.toContain('来源：')
    }
  })
})

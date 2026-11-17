/**
 * P76j 第 5 节第 6 条：约定卡「预计消耗」一段、回执第六行「消耗」、预计消耗条目三个选项与「已等」。
 * 文字全部来自视图（core 生成），这里只检查界面照原样画、按钮点下去发出的是条目的选项。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgreementCard } from '../src/client/components/AgreementCard.js'
import { ReceiptCard } from '../src/client/components/JobCard.js'
import { InboxCard } from '../src/client/components/Cards.js'
import { InboxPane, itemToCard } from '../src/client/components/InboxPane.js'
import { sampleBudgetTweetThread, sampleReceiptWithCost } from '../src/shared/fixture-budget.js'
import type { CardPayload } from '../src/client/logic/cards.js'
import type { InboxItemView, InboxView } from '../src/shared/views.js'
import { createHookHost } from './helpers/hook-host.js'
import { findElements, type StubElement } from './helpers/jsx-runtime-stub.js'

vi.mock('react', async () => (await import('./helpers/hook-host.js')).reactFacade)

function textOf(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object' && node !== null && 'props' in node) return textOf((node as StubElement).props.children)
  return ''
}

function allElements(node: unknown): StubElement[] {
  if (Array.isArray(node)) return node.flatMap(allElements)
  if (typeof node !== 'object' || node === null || !('props' in node)) return []
  const element = node as StubElement
  return [element, ...allElements(element.props.children)]
}

/** 待确认的约定卡（第 1 版完整展开，带预计消耗一段）。 */
const tweetCard = sampleBudgetTweetThread.messages.find(message => message.agreement != null)?.agreement
if (tweetCard === null || tweetCard === undefined) throw new Error('样例里没有待确认的约定卡')

afterEach(() => { vi.unstubAllGlobals() })

describe('1 约定卡「预计消耗」一段', () => {
  it('标题、headline、逐步的行、依据一句与页脚都在，文字与视图逐字一致', () => {
    expect(tweetCard.estimate).not.toBeNull()
    const estimate = tweetCard.estimate!
    const text = textOf(createHookHost().render(AgreementCard, { card: tweetCard }))
    expect(text).toContain(estimate.title)
    expect(text).toContain(estimate.headline)
    for (const line of estimate.lines) expect(text).toContain(line)
    expect(text).toContain(estimate.basisLine)
    expect(text).toContain(estimate.footer)
  })

  it('headline 里的数字加粗，其余文字保持正文', () => {
    const tree = createHookHost().render(AgreementCard, { card: tweetCard })
    const head = allElements(tree).find(element => String(element.props.className).includes('ah-agr-estimate-head'))!
    const strong = allElements(head).filter(element => element.type === 'strong')
    expect(strong.length).toBeGreaterThan(0)
    for (const item of strong) expect(textOf(item)).toMatch(/\d/)
    expect(textOf(head)).toBe(tweetCard.estimate!.headline)
  })

  it('没有预计（旧数据）时这一段不出现', () => {
    const { estimate: _estimate, ...withoutEstimate } = tweetCard
    const text = textOf(createHookHost().render(AgreementCard, { card: withoutEstimate }))
    expect(text).not.toContain('预计消耗')
  })
})

describe('2 回执第六行「消耗」', () => {
  it('六行都在，最后一行的标签与值逐字来自视图', () => {
    const tree = createHookHost().render(ReceiptCard, { card: sampleReceiptWithCost })
    const text = textOf(tree)
    for (const row of sampleReceiptWithCost.rows) {
      expect(text).toContain(row.label)
      expect(text).toContain(row.value)
    }
    expect(sampleReceiptWithCost.rows.at(-1)!.label).toBe('消耗')
    // 与前五行同一个组件、同一种行结构。
    expect(findElements(tree, 'dt')).toHaveLength(sampleReceiptWithCost.rows.length)
  })
})

describe('3 预计消耗条目：三个选项与「已等」', () => {
  const card: CardPayload = {
    inboxId: 'i_cap1', approvalId: null, type: 'question', status: 'open', goalId: null,
    title: '嘉宾介绍页：消耗将超出预计', body: '已用 5 回合，预计 8，估计共需 9 回合。\n多出来的部分：执行多用了 1 回合。',
    options: ['追加 2 个回合', '缩小范围', '暂停'], defaultOption: null, answer: null, expiresText: null,
    jobEntry: { kind: 'cap', jobId: 'job_budget0002' },
  }

  it('三个选项横排、都可点；点第一个原样发出选项文字，正文按换行逐行', () => {
    const onPick = vi.fn(async () => null)
    const tree = createHookHost().render(InboxCard, { card, actions: { onPick }, busy: false })
    const buttons = allElements(tree).filter(element => element.type === 'button')
    expect(buttons.map(button => textOf(button))).toEqual(['追加 2 个回合', '缩小范围', '暂停'])
    expect(textOf(tree)).toContain(card.body)
    ;(buttons[0]!.props.onClick as () => void)()
    expect(onPick).toHaveBeenCalledWith(card, '追加 2 个回合', undefined)
  })

  it('条目正文里的换行原样保留（CSS 按换行分行显示）', () => {
    expect(card.body).toContain('\n')
    const text = textOf(createHookHost().render(InboxCard, { card, actions: { onPick: async () => null }, busy: false }))
    expect(text).toContain('估计共需 9 回合。\n多出来的部分')
  })

  it('「待你处理」里显示视图给的「已等 {时长}」；没有这一项时不编一句', () => {
    vi.stubGlobal('document', { getElementById: () => null, querySelector: () => null, documentElement: {} })
    const item: InboxItemView = {
      id: 'i_cap1', botId: 'b_chief', botName: '总管', botColor: '#5b6b8c', type: 'question', typeLabel: '提问',
      priority: 'P1', approvalId: null, title: card.title, body: card.body, options: card.options, defaultOption: null,
      createdAt: 1, createdText: '11月17日 08:00', expiresText: null, jobEntry: { kind: 'cap', jobId: 'job_budget0002' },
      waitedText: '已等 6 小时',
    }
    const inbox: InboxView = { items: [item] }
    const tree = createHookHost().render(InboxPane, {
      inbox, loading: false, error: null, onRetry: () => undefined, actions: { onPick: async () => null }, busyId: null,
    })
    const text = textOf(tree)
    expect(text).toContain('已等 6 小时')
    expect(itemToCard(item).options).toEqual(card.options)
  })
})

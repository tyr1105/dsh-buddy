/**
 * P74i-m2 第二次的测试（第 4 节与补充的两处界面改动）：
 *
 * - 4.1：「待你处理」里约定确认条目下面的说明只看条目自己带的 agreementJobSplit、agreementStop（对话没有加载也对）；
 * - 4.2：交付卡的只读、着色、收起只看 phase，状态文字换成没见过的字，表现不变；
 * - 约定卡画出对外发布那一行（launchLine）：有、没有、这一版去掉、有改动标记各一条，位置在「怎样算做完」之后；
 * - 说明卡：主人已选的卡与失效的卡是两种样子（类名不同，已选的卡没有失效类）。
 * 样例取自 fixture-job.ts（core 的视图函数生成），只在需要的地方改一两个字段。
 */
import { describe, expect, it, vi } from 'vitest'
import { AgreementCard } from '../src/client/components/AgreementCard.js'
import { DeliveryCard, EscalationCard } from '../src/client/components/JobCard.js'
import { InboxCard } from '../src/client/components/Cards.js'
import { itemToCard } from '../src/client/components/InboxPane.js'
import { expiryMeaningOf } from '../src/client/logic/cards.js'
import { deliveryIsExpired, deliveryStateClass } from '../src/client/logic/job.js'
import {
  sampleB2Card, sampleDeliveryAwaitingCard, sampleDeliveryDoneCard, sampleDeliveryReturnedCard, sampleDeliveryExpiredCard,
  sampleEscalationOldCard, sampleEscalationStatesCards, sampleStopInboxEntry, sampleApprovalThread,
} from '../src/shared/fixture-job.js'
import { createHookHost } from './helpers/hook-host.js'
import { findElements, type StubElement } from './helpers/jsx-runtime-stub.js'
import type { AgreementCardView, InboxItemView } from '../src/shared/views.js'

vi.mock('react', async () => (await import('./helpers/hook-host.js')).reactFacade)

function textOf(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object' && node !== null && 'props' in node) return textOf((node as StubElement).props.children)
  return ''
}
const classOf = (node: StubElement): string => String(node.props.className ?? '')
const buttons = (tree: unknown): StubElement[] => findElements(tree as StubElement, 'button')

// ---------- 4.1 约定确认条目下面的说明只看条目上的两个字段 ----------

describe('4.1 约定确认条目的说明只看 agreementJobSplit、agreementStop', () => {
  const base = { ...(sampleStopInboxEntry as unknown as InboxItemView), agreementJobSplit: false, agreementStop: false }

  it('对话没有加载（这里根本没有任何线程数据）：带两栏标记的条目写「你确认前，暂停的部分不会做。」', () => {
    const card = itemToCard({ ...base, agreementJobSplit: true })
    expect(expiryMeaningOf(card)).toBe('不会自动按建议处理。你确认前，暂停的部分不会做。')
  })

  it('带停止标记的条目写「你确认后这件事停止；确认前照常在做。」（优先于两栏那句）', () => {
    expect(expiryMeaningOf(itemToCard({ ...base, agreementStop: true }))).toBe('不会自动按建议处理。你确认后这件事停止；确认前照常在做。')
    expect(expiryMeaningOf(itemToCard({ ...base, agreementStop: true, agreementJobSplit: true }))).toBe('不会自动按建议处理。你确认后这件事停止；确认前照常在做。')
  })

  it('两个标记都没有（或字段缺省）：保持原句；样例里的停止条目本身带 agreementStop', () => {
    expect(expiryMeaningOf(itemToCard(base))).toBe('不会自动按建议处理。你确认前不会开工。')
    const { agreementJobSplit: _a, agreementStop: _b, ...bare } = base
    expect(expiryMeaningOf(itemToCard(bare as InboxItemView))).toBe('不会自动按建议处理。你确认前不会开工。')
    expect((sampleStopInboxEntry as { agreementStop?: boolean }).agreementStop).toBe(true)
  })
})

// ---------- 4.2 交付卡只看 phase ----------

describe('4.2 交付卡的只读、着色、收起只看 phase', () => {
  const rootOf = (tree: unknown): StubElement => findElements(tree as StubElement, 'div').find(node => classOf(node).includes('ah-card-job'))!
  const stateOf = (tree: unknown): StubElement => findElements(tree as StubElement, 'span').find(node => classOf(node).startsWith('ah-job-state'))!
  const weird = '这是核心以后才会写的新状态词'

  it('phase 为 void：状态文字换成没见过的字，仍是弱化、灰色状态、没有任何按钮', () => {
    if (sampleDeliveryExpiredCard.kind !== 'delivery') throw new Error('样例不是交付卡')
    expect(sampleDeliveryExpiredCard.phase).toBe('void')
    const tree = createHookHost().render(DeliveryCard, { card: { ...sampleDeliveryExpiredCard, stateText: weird } })
    expect(textOf(tree)).toContain(weird)
    expect(classOf(rootOf(tree))).toContain('is-void')
    expect(classOf(stateOf(tree))).toContain('is-na')
    expect(buttons(tree).filter(button => textOf(button) === '验收通过')).toHaveLength(0)
  })

  it('phase 为 accepted：状态文字换成没见过的字，仍收起为一行结论、状态成功色', () => {
    if (sampleDeliveryDoneCard.kind !== 'delivery') throw new Error('样例不是交付卡')
    expect(sampleDeliveryDoneCard.phase).toBe('accepted')
    const tree = createHookHost().render(DeliveryCard, { card: { ...sampleDeliveryDoneCard, stateText: weird } })
    expect(textOf(tree)).toContain(sampleDeliveryDoneCard.doneHint!)
    expect(classOf(stateOf(tree))).toContain('is-ok')
    expect(classOf(rootOf(tree))).not.toContain('is-void')
  })

  it('phase 为 returned：状态文字换成没见过的字，仍是警示色；awaiting 与 waiting_agreement 是普通色且不弱化', () => {
    if (sampleDeliveryReturnedCard.kind !== 'delivery' || sampleDeliveryAwaitingCard.kind !== 'delivery') throw new Error('样例不是交付卡')
    const returned = createHookHost().render(DeliveryCard, { card: { ...sampleDeliveryReturnedCard, stateText: weird } })
    expect(classOf(stateOf(returned))).toContain('is-bad')
    for (const phase of ['awaiting', 'waiting_agreement'] as const) {
      const tree = createHookHost().render(DeliveryCard, { card: { ...sampleDeliveryAwaitingCard, phase, stateText: weird } })
      expect(classOf(stateOf(tree))).not.toContain('is-')
      expect(classOf(rootOf(tree))).not.toContain('is-void')
    }
  })

  it('纯函数：着色与只读只由 phase 决定', () => {
    expect(['awaiting', 'waiting_agreement', 'accepted', 'returned', 'void'].map(phase => deliveryStateClass(phase as never))).toEqual(['', '', 'is-ok', 'is-bad', 'is-na'])
    expect(deliveryIsExpired('void')).toBe(true)
    expect(deliveryIsExpired('awaiting')).toBe(false)
  })
})

// ---------- 约定卡的对外发布一行 ----------

describe('约定卡画出对外发布那一行（launchLine、launchChanged）', () => {
  if (sampleB2Card === null) throw new Error('缺 B2 样例约定卡')
  const card: AgreementCardView = sampleB2Card
  const LINE = '验收之后对外发布：发到内网演示地址，把地址发给你。发布前单独请你批准。'
  const render = (view: AgreementCardView, expanded = true): StubElement =>
    createHookHost().render(AgreementCard, { card: view, onConfirm: async () => null, startExpanded: expanded }) as StubElement
  const launchNodes = (tree: StubElement): StubElement[] => findElements(tree, 'p').filter(node => textOf(node).includes('对外发布') && classOf(node).includes('ah-agr-one'))

  it('有这一行：样例（?job=b2）的约定卡带 launchLine，原文逐字显示，位置在「怎样算做完」之后，前面没有图标', () => {
    expect(card.launchLine).toBe(LINE)
    const tree = render(card)
    const nodes = launchNodes(tree)
    expect(nodes).toHaveLength(1)
    expect(textOf(nodes[0])).toBe(LINE)
    // 位置：整张卡的文字里，怎样算做完的最后一条在这一行之前。
    const all = textOf(tree)
    const lastDone = card.doneWhen.at(-1)!.text
    expect(all.indexOf(lastDone)).toBeGreaterThan(-1)
    expect(all.indexOf(LINE)).toBeGreaterThan(all.indexOf(lastDone))
    // 前面不加图标：这一行所在的块里除这个段落外没有别的元素（没有 svg、没有图标 span）。
    const block = findElements(tree, 'div').find(node => classOf(node).includes('ah-agr-launch'))!
    expect(findElements(block, 'svg')).toHaveLength(0)
    expect(findElements(block, 'span')).toHaveLength(0)
    // 收起模式（第 2 版起默认只看改动）下同样显示。
    expect(launchNodes(render(card, false))).toHaveLength(1)
  })

  it('没有这一行（launchLine 为 null 或缺省）：整行不画', () => {
    expect(launchNodes(render({ ...card, launchLine: null, launchChanged: false }))).toHaveLength(0)
    const { launchLine: _l, launchChanged: _c, ...old } = card
    expect(launchNodes(render(old as AgreementCardView))).toHaveLength(0)
    expect(findElements(render({ ...card, launchLine: null }), 'div').some(node => classOf(node).includes('ah-agr-launch'))).toBe(false)
  })

  it('这一版去掉：显示核心给的「这一版去掉了对外发布这一步。」原文，界面不改写', () => {
    const removed = '这一版去掉了对外发布这一步。'
    const nodes = launchNodes(render({ ...card, launchLine: removed, launchChanged: true }))
    expect(nodes).toHaveLength(1)
    expect(textOf(nodes[0])).toBe(removed)
  })

  it('有改动标记：launchChanged 为真时带「本版改动」同样的标记类，为假时不带', () => {
    expect(classOf(launchNodes(render({ ...card, launchChanged: true }))[0]!)).toContain('ah-agr-changed')
    expect(classOf(launchNodes(render({ ...card, launchChanged: false }))[0]!)).not.toContain('ah-agr-changed')
    // 与别的内容项的标记方式一致：改动的条目用的就是同一个类名。
    const others = ['li', 'p', 'div'].flatMap(tag => findElements(render({ ...card, launchChanged: false }), tag))
      .filter(node => classOf(node).includes('ah-agr-changed'))
    expect(others.length).toBeGreaterThan(0)
  })
})

// ---------- 已选的说明卡与失效的说明卡 ----------

describe('说明卡：已选与失效是两种样子', () => {
  const rootOf = (tree: unknown): StubElement => findElements(tree as StubElement, 'div').find(node => classOf(node).includes('ah-card-escalation'))!

  it('已选的卡（chosen 不为空）：类名 is-chosen，没有失效的类，被选的办法有「已选」标签', () => {
    const chosen = sampleEscalationStatesCards.find(card => card.kind === 'escalation' && card.chosen === 'A')
    if (chosen === undefined || chosen.kind !== 'escalation') throw new Error('缺已选的样例卡')
    const tree = createHookHost().render(EscalationCard, { card: chosen })
    expect(classOf(rootOf(tree))).toContain('is-chosen')
    expect(classOf(rootOf(tree))).not.toContain('is-void')
    const state = findElements(tree as StubElement, 'span').find(node => classOf(node).startsWith('ah-job-state'))!
    expect(classOf(state)).not.toContain('is-na')
    const optionA = findElements(tree as StubElement, 'div').find(node => node.props['data-option-letter'] === 'A')!
    expect(textOf(optionA)).toContain('已选')
    // 场景 E 的旧卡（选过 B）同样。
    if (sampleEscalationOldCard.kind !== 'escalation') throw new Error('样例不是说明卡')
    const old = createHookHost().render(EscalationCard, { card: sampleEscalationOldCard })
    expect(classOf(rootOf(old))).not.toContain('is-void')
  })

  it('失效的卡（没选过而 selectable 为假）：类名 is-void，不带 is-chosen；两种卡的类名不同', () => {
    const invalid = sampleEscalationStatesCards.find(card => card.kind === 'escalation' && card.chosen === null && card.selectable === false)
    const chosen = sampleEscalationStatesCards.find(card => card.kind === 'escalation' && card.chosen !== null)
    if (invalid === undefined || invalid.kind !== 'escalation' || chosen === undefined || chosen.kind !== 'escalation') throw new Error('缺样例卡')
    const invalidRoot = rootOf(createHookHost().render(EscalationCard, { card: invalid }))
    const chosenRoot = rootOf(createHookHost().render(EscalationCard, { card: chosen }))
    expect(classOf(invalidRoot)).toContain('is-void')
    expect(classOf(invalidRoot)).not.toContain('is-chosen')
    expect(classOf(invalidRoot)).not.toBe(classOf(chosenRoot))
  })
})

// ---------- 已作废的发布审批（launch 与 voided 同时为真） ----------

describe('审批卡：launch 为真且已作废（核心会作废发布这一步结束时还开着的发布审批）', () => {
  const messages = sampleApprovalThread.messages.filter(message => message.card?.approval !== undefined)
  const pick = (predicate: (card: NonNullable<typeof messages[number]['card']>) => boolean) => {
    const found = messages.find(message => message.card !== null && predicate(message.card))
    if (found === undefined || found.card === null) throw new Error('缺审批样例卡')
    return found.card
  }
  // 手造：以样例里已作废的普通审批卡为底，只把 launch 改成真，状态保持已过期。
  const voidedNormal = pick(card => card.approval!.voided === true)
  const voidedLaunch = { ...voidedNormal, approval: { ...voidedNormal.approval!, launch: true, voided: true } }
  const openLaunch = pick(card => card.approval!.launch === true && card.approval!.voided !== true && card.status === 'open')
  const actions = { onPick: async () => null }
  const render = (card: typeof voidedLaunch) => createHookHost().render(InboxCard, { card, actions, busy: false })
  const buttonTexts = (tree: unknown): string[] => buttons(tree).map(textOf)

  it('已作废的发布审批：显示「已作废」；没有任何按钮；不显示「过期视为拒绝」', () => {
    expect(voidedLaunch.status).toBe('expired')
    const tree = render(voidedLaunch)
    const text = textOf(tree)
    expect(text).toContain('已作废')
    expect(text).not.toContain('已拒绝')
    expect(text).not.toContain('视为拒绝')
    expect(buttonTexts(tree)).toEqual([])
    for (const label of ['批准发布', '暂不发布', '批准', '拒绝']) expect(text).not.toContain(label)
  })

  it('三行说明：发布审批与已作废的普通审批做法一致（都显示或都不显示）', () => {
    const notes = voidedNormal.approval!.notes
    expect(notes).not.toBeNull()
    const normalText = textOf(render(voidedNormal as typeof voidedLaunch))
    const launchText = textOf(render(voidedLaunch))
    for (const line of [notes!.cost, notes!.undo, notes!.after]) {
      expect(launchText.includes(line)).toBe(normalText.includes(line))
    }
  })

  it('对照：launch 为真、未作废、待处理的卡有「批准发布」「暂不发布」，也有有效期一句', () => {
    const tree = render(openLaunch as typeof voidedLaunch)
    expect(buttonTexts(tree)).toEqual(['批准发布', '暂不发布'])
    expect(textOf(tree)).toContain('前有效，过期视为拒绝')
  })
})

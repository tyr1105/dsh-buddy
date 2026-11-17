/**
 * P74i-m1（第二次）必须新增的测试：
 * 1. 说明条目带 escalationCard 时画出完整卡片（做法、代价、「选了会……」、「按所选办法处理」），
 *    没有只有标题的小按钮、正文不重复；提交参数取卡里的 jobId、stage、所选序号、revision；
 *    escalationCard 为 null 时只显示正文、没有可提交的按钮。
 * 2. 说明卡：selectable 为假时办法不可点、没有提交按钮；七种 stateText 原样显示；已选的办法有「已选」标签。
 * 4. 审批卡：launch 为真时两个按钮是「批准发布」「暂不发布」（答复处理不变）；voided 为真时状态写「已作废」、没有按钮。
 * 5. 打开预览：返回一句没见过的文字时原样显示。
 * 9.（第二次的样例）审批三种、说明卡七种状态全部由 core 的视图函数生成并通过 schema；快照与实时视图逐字相同。
 * 第 3 条（按 jobEntry.kind 识别）在 test/p74i-inbox.test.tsx。
 */
import { describe, expect, it, vi } from 'vitest'
import { ApprovalCardPartsSchema, EscalationCardViewSchema, JobCardViewSchema } from '@agent-hub/core'
import { EscalationCard, DeliveryCard, type JobCommands } from '../src/client/components/JobCard.js'
import { InboxCard } from '../src/client/components/Cards.js'
import { InboxPane, itemToCard } from '../src/client/components/InboxPane.js'
import { JOB_TEXT } from '../src/client/logic/job.js'
import type { CardActions } from '../src/client/components/Cards.js'
import type { EscalationCardView, InboxItemView } from '../src/shared/views.js'
import {
  sampleApprovalInboxEntries, sampleApprovalThread, sampleDeliveryAwaitingCard, sampleEscalationStatesCards,
  sampleEscalationStatesThread, sampleJobInboxEntries,
} from '../src/shared/fixture-job.js'
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
const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))
const actions: CardActions = { onPick: async () => null }

const escalateItem = sampleJobInboxEntries[1]! as InboxItemView
const approvalEntries = sampleApprovalInboxEntries as unknown as InboxItemView[]
const launchEntry = approvalEntries.find(item => item.approval?.launch === true)!
const normalEntry = approvalEntries.find(item => item.approval?.launch === false)!

/** 在渲染树里找「传了某个 card prop 的子组件桩」（测试宿主不执行子组件，只留元素桩）。 */
function stubWithCard(tree: unknown, card: unknown): StubElement | undefined {
  const found: StubElement[] = []
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (typeof node !== 'object' || node === null || !('props' in node)) return
    const props = (node as StubElement).props as Record<string, unknown>
    if ('card' in props) found.push(node as StubElement)
    walk(props.children)
  }
  walk(tree)
  return found.find(node => (node.props as Record<string, unknown>).card === card)
}

describe('说明条目画完整卡片（任务卡 1.1，走查 I-4）', () => {
  it('带 escalationCard：条目里渲染的就是那张卡（同一个组件、同一份数据），不再渲染普通卡片，正文不重复', () => {
    const tree = createHookHost().render(InboxPane, {
      inbox: { items: [escalateItem] }, loading: false, error: null, onRetry: () => undefined, actions, busyId: null,
      onOpenThread: () => undefined,
    })
    const card = escalateItem.escalationCard!
    // 渲染的是完整卡片组件，传的正是条目带的那个视图（与总管私聊里那张卡同一份数据）。
    expect(stubWithCard(tree, card)).toBeDefined()
    // 没有普通卡片（InboxCard）——只有标题的小按钮随之消失；正文不重复显示。
    expect(stubWithCard(tree, itemToCard(escalateItem))).toBeUndefined()
    expect(textOf(tree)).not.toContain(escalateItem.body)
    expect(buttonTexts(tree)).toContain('查看对话')
    expect(buttonTexts(tree).filter(label => /^[A-Z]　/.test(label))).toHaveLength(0)
  })

  it('那张卡本身：办法的做法、代价和「选了会……」都在，有「按所选办法处理」（走查 I-4 的依据都在）', () => {
    const card = escalateItem.escalationCard!
    const tree = createHookHost().render(EscalationCard, { card: card as never })
    const text = textOf(tree)
    expect(text).toContain('受阻原因')
    expect(text).toContain('已尝试的办法')
    expect(text).toContain(JOB_TEXT.escalationSubmit)
    expect(text).toContain('不改约定，用现成服务替代自己写的校验。')
    expect(text).toContain('选了会把「怎样算做完」第 3 条改为：手机号少填一位时，允许提交，由后台补全。')
    // 建议项预先选中但不自动提交。
    const options = buttons(tree).filter(node => classOf(node).startsWith('ah-esc-option'))
    expect(options).toHaveLength(3)
    // P74i-m2（低-6）：办法改按单选语义暴露（role=radio + aria-checked），不再用 aria-pressed。
    expect(options[0]!.props.role).toBe('radio')
    expect(options[0]!.props['aria-checked']).toBe(true)
  })

  it('提交走 chooseJobOption：参数是卡里的 jobId、stage、所选序号、revision（与对话里的卡同一条路）', () => {
    const choose = vi.fn(async () => ({ ok: true as const }))
    const commands: JobCommands = { accept: vi.fn(async () => ({ ok: true as const })), choose, preview: vi.fn(async () => ({ ok: true as const })) }
    const card = escalateItem.escalationCard as EscalationCardView
    const host = createHookHost()
    const first = host.render(EscalationCard, { card, commands })
    // 点 B（序号 1）再提交。
    const options = buttons(first).filter(node => classOf(node).startsWith('ah-esc-option'))
    ;(options[1]!.props.onClick as () => void)()
    const picked = host.render(EscalationCard, { card, commands })
    ;(buttons(picked).find(node => textOf(node) === JOB_TEXT.escalationSubmit)!.props.onClick as () => void)()
    expect(choose).toHaveBeenCalledTimes(1)
    return flush().then(() => {
      expect(choose).toHaveBeenCalledWith({ jobId: 'job_sample0006', stage: 1, option: 1, revision: 1 })
    })
  })

  it('escalationCard 为 null（不应出现）：只显示正文，没有任何可提交的按钮，保留「查看对话」', () => {
    const broken: InboxItemView = { ...escalateItem, escalationCard: null }
    const tree = createHookHost().render(InboxPane, {
      inbox: { items: [broken] }, loading: false, error: null, onRetry: () => undefined, actions, busyId: null,
      onOpenThread: () => undefined,
    })
    const text = textOf(tree)
    expect(text).toContain(broken.body)
    expect(text).toContain(broken.title)
    expect(text).not.toContain(JOB_TEXT.escalationSubmit)
    expect(text).not.toContain('受阻原因')
    expect(buttonTexts(tree)).toContain('查看对话')
    expect(buttonTexts(tree).filter(label => /^[A-Z]　/.test(label))).toHaveLength(0)
  })
})

describe('说明卡的状态（任务卡 1.2）', () => {
  it('七种 stateText 原样显示（等你决定、你选了 A、五种失效），全部通过 core 的 schema', () => {
    expect(sampleEscalationStatesCards).toHaveLength(7)
    expect(sampleEscalationStatesCards.map(card => card.kind === 'escalation' ? card.stateText : '')).toEqual([
      '等你决定', '你选了 A',
      '已失效：约定在重新确认', '已失效：约定已更新', '已失效：约定修改已撤销', '已失效：这件事已继续进行', '已失效：这件事已停止',
    ])
    for (const card of sampleEscalationStatesCards) {
      expect(() => JobCardViewSchema.parse(card)).not.toThrow()
      expect(() => EscalationCardViewSchema.parse(card)).not.toThrow()
      const tree = createHookHost().render(EscalationCard, { card: card as never })
      // 状态文字原样显示，界面不写死、不按字面判断。
      expect(textOf(tree)).toContain(card.kind === 'escalation' ? card.stateText : '')
    }
  })

  it('selectable 为假的卡：办法不可点（不是按钮）、没有「按所选办法处理」、没有建议理由，整体弱化（is-void）', () => {
    const invalid = sampleEscalationStatesCards.find(card => card.kind === 'escalation' && card.stateText === '已失效：约定已更新')
    if (invalid === undefined || invalid.kind !== 'escalation') throw new Error('缺已失效的样例卡')
    const tree = createHookHost().render(EscalationCard, { card: invalid })
    expect(buttons(tree)).toHaveLength(0)
    const text = textOf(tree)
    expect(text).not.toContain(JOB_TEXT.escalationSubmit)
    expect(text).not.toContain(invalid.reasonHint)
    // 卡片根节点带弱化样式类；右侧状态用与交付卡失效相同的灰样式。
    const root = findElements(tree, 'div').find(node => classOf(node).includes('ah-card-escalation'))!
    expect(classOf(root)).toContain('is-void')
    expect(classOf(findElements(root, 'span').find(node => classOf(node).startsWith('ah-job-state'))!)).toContain('is-na')
    // 办法仍在（只读一行），「选了会……」仍显示（失效只影响可不可选）。
    expect(text).toContain('选了会把「怎样算做完」第 3 条改为')
  })

  it('主人已选的卡：被选的那个办法上有「已选」小标签（走查 E-5）', () => {
    const chosen = sampleEscalationStatesCards.find(card => card.kind === 'escalation' && card.chosen === 'A')
    if (chosen === undefined || chosen.kind !== 'escalation') throw new Error('缺已选的样例卡')
    const tree = createHookHost().render(EscalationCard, { card: chosen })
    const optionA = findElements(tree, 'div').find(node => classOf(node).startsWith('ah-esc-option') && node.props['data-option-letter'] === 'A')
    expect(optionA).toBeDefined()
    expect(textOf(optionA)).toContain(JOB_TEXT.escalationChosen)
    // 没选的办法没有这个标签。
    const optionB = findElements(tree, 'div').find(node => classOf(node).startsWith('ah-esc-option') && node.props['data-option-letter'] === 'B')
    expect(textOf(optionB)).not.toContain(JOB_TEXT.escalationChosen)
  })

  it('「可选的办法」小标题直接显示视图的 optionsTitle（不可选的卡只写「可选的办法」）', () => {
    const open = sampleEscalationStatesCards.find(card => card.kind === 'escalation' && card.stateText === '等你决定')
    const invalid = sampleEscalationStatesCards.find(card => card.kind === 'escalation' && card.stateText === '已失效：约定已更新')
    if (open === undefined || invalid === undefined) throw new Error('缺少样例卡')
    const openText = textOf(createHookHost().render(EscalationCard, { card: open as never }))
    const invalidText = textOf(createHookHost().render(EscalationCard, { card: invalid as never }))
    expect(openText).toContain('可选的办法　选 B 或 C 即记为约定第 2 版，不再另外请你确认')
    expect(invalidText).toContain('可选的办法')
    expect(invalidText).not.toContain('即记为约定第')
  })
})

describe('审批卡的两个按钮与已作废（任务卡 1.4）', () => {
  it('launch 为真：按钮写「批准发布」「暂不发布」；答复处理不变（仍是批准、拒绝两个动作）', () => {
    const onPick = vi.fn(async () => null)
    const host = createHookHost()
    const tree = host.render(InboxCard, { card: itemToCard(launchEntry), actions: { ...actions, onPick }, busy: false })
    expect(buttonTexts(tree)).toEqual(['批准发布', '暂不发布'])
    // 点「批准发布」提交的仍是原始选项「批准」（decideApproval 的 approve 为真；附言为空串）。
    ;(buttons(tree).find(node => textOf(node) === '批准发布')!.props.onClick as () => void)()
    expect(onPick).toHaveBeenCalledWith(itemToCard(launchEntry), '批准', '')
    // 点「暂不发布」提交的是「拒绝」。
    const onPick2 = vi.fn(async () => null)
    const host2 = createHookHost()
    const tree2 = host2.render(InboxCard, { card: itemToCard(launchEntry), actions: { ...actions, onPick: onPick2 }, busy: false })
    ;(buttons(tree2).find(node => textOf(node) === '暂不发布')!.props.onClick as () => void)()
    expect(onPick2).toHaveBeenCalledWith(itemToCard(launchEntry), '拒绝', '')
  })

  it('launch 为假（普通审批）：按钮不变，仍是「批准」「拒绝」；三行说明与「由某某执行」都在（F-1 的样例）', () => {
    const tree = createHookHost().render(InboxCard, { card: itemToCard(normalEntry), actions, busy: false })
    expect(buttonTexts(tree)).toEqual(['批准', '拒绝'])
    // 三行说明与「由某某执行」在结构化内容里（渲染由 ApprovalBlock 画，见 p74i-approval 测试）。
    const approval = itemToCard(normalEntry).approval!
    expect(approval.notes).toEqual({ cost: '不花钱，约 1 分钟', undo: '可以删掉这份文件', after: '共享目录里多一份交接文件' })
    expect(approval.onBehalfOf).toBe('由林舟执行')
  })

  it('voided 为真：状态写「已作废」，不写「已过期」「已拒绝」，没有按钮', () => {
    // 从审批样例线程里取已作废那张（收件箱里没有它）。
    const voidedMessage = sampleApprovalThread.messages.find(message => message.card?.approval?.voided === true)
    if (voidedMessage === undefined || voidedMessage.card === null) throw new Error('缺已作废的审批样例')
    const tree = createHookHost().render(InboxCard, { card: voidedMessage.card, actions, busy: false })
    const text = textOf(tree)
    expect(text).toContain('已作废')
    expect(text).not.toContain('已过期')
    expect(text).not.toContain('已拒绝')
    expect(buttons(tree)).toHaveLength(0)
  })
})

describe('打开预览的返回文字（任务卡 1.5）', () => {
  it('返回一句没见过的文字时原样显示（界面不认内容）', async () => {
    const preview = vi.fn(async () => ({ ok: false as const, error: '预览服务此刻不可用，稍后再试' }))
    const commands: JobCommands = { accept: vi.fn(async () => ({ ok: true as const })), choose: vi.fn(async () => ({ ok: true as const })), preview }
    if (sampleDeliveryAwaitingCard.kind !== 'delivery') throw new Error('应是交付卡')
    const host = createHookHost()
    const tree = host.render(DeliveryCard, { card: sampleDeliveryAwaitingCard, commands })
    ;(buttons(tree).find(node => textOf(node).includes('打开预览'))!.props.onClick as () => void)()
    await flush()
    const after = host.render(DeliveryCard, { card: sampleDeliveryAwaitingCard, commands })
    expect(textOf(after)).toContain('预览服务此刻不可用，稍后再试')
  })
})

describe('第二次新增样例的一致性（必须新增测试第 9 条的第二次部分）', () => {
  it('审批样例：四张卡的分段内容全部通过 core 的 schema；发布审批与已作废的标记正确；已作废的不进「待你处理」', () => {
    // P74i-m3（第 8 节第 2 条）：对话里多了一张最早的「已过期」普通审批（状态已过期、不是已作废），共四张。
    const cards = sampleApprovalThread.messages.filter(message => message.card !== null).map(message => message.card!)
    expect(cards).toHaveLength(4)
    for (const card of cards) {
      expect(card.type).toBe('approval')
      expect(() => ApprovalCardPartsSchema.parse(card.approval)).not.toThrow()
    }
    const [expired, normal, launch, voided] = cards.map(card => {
      const approval = card.approval
      return approval !== undefined && approval.launch !== undefined && approval.voided !== undefined ? approval : undefined
    })
    if (expired === undefined || normal === undefined || launch === undefined || voided === undefined) throw new Error('审批分段内容不完整')
    expect(cards[0]!.status).toBe('expired')
    expect(expired.voided).toBe(false)
    expect(expired.launch).toBe(false)
    expect(normal.launch).toBe(false)
    expect(launch.launch).toBe(true)
    // P74r6（N10）起 launch 只对这件事记录上记下的那一张发布审批为真；被作废的是普通审批，launch 为假。
    expect(voided.launch).toBe(false)
    expect(voided.voided).toBe(true)
    expect(cards.map(card => card.approval!.voided)).toEqual([false, false, false, true])
    // 「待你处理」里只有普通与发布审批两条（已作废的只在对话里）。
    expect(sampleApprovalInboxEntries).toHaveLength(2)
    expect(sampleApprovalInboxEntries.every(item => item.type === 'approval' && item.approval !== undefined)).toBe(true)
    expect(sampleApprovalInboxEntries.map(item => item.approval!.launch)).toEqual([false, true])
  })

  it('说明卡状态样例与审批样例的预览快照与实时生成的视图逐字相同', async () => {
    const { previewApprovalInboxEntries, previewApprovalThread, previewEscalationStatesThread } = await import('../src/shared/fixture-job-preview.js')
    expect(JSON.stringify(previewApprovalThread)).toBe(JSON.stringify(sampleApprovalThread))
    expect(JSON.stringify(previewApprovalInboxEntries)).toBe(JSON.stringify(sampleApprovalInboxEntries))
    expect(JSON.stringify(previewEscalationStatesThread)).toBe(JSON.stringify(sampleEscalationStatesThread))
  })
})

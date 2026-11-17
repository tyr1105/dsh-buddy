/**
 * P69 B2：审批卡的话。用 hook 宿主渲染真实组件（子组件不展开，只看这一层交出了什么）。
 * 断言：新记录显示「一句话 / 原因 / 风险 / 收起的原始命令」，点开后可见；
 * 没有原因、没有风险的行不出现；旧记录（没有 approval）照旧显示标题和正文；键盘可操作。
 */
import { describe, expect, it, vi } from 'vitest'
import { ApprovalBlock } from '../src/client/components/ApprovalBlock.js'
import { InboxCard, type CardActions, type CardPayload } from '../src/client/components/Cards.js'
import { InboxPane } from '../src/client/components/InboxPane.js'
import { approvalPartsOf } from '../src/client/logic/cards.js'
import type { InboxItemView } from '../src/shared/views.js'
import { createHookHost } from './helpers/hook-host.js'
import { findElements, type StubElement } from './helpers/jsx-runtime-stub.js'

vi.mock('react', async () => (await import('./helpers/hook-host.js')).reactFacade)

const parts = {
  actionText: '把代码推送到远端仓库（origin main）',
  ownerReason: '推送本周的报表脚本，方便你查看',
  riskNote: '推送后远端仓库的内容会变化',
  argsPreview: 'git push origin main --tags',
  // P74i：三行说明与「由谁执行」加入 ApprovalParts；旧记录（没有这两项）按 null 处理。
  notes: null,
  onBehalfOf: null,
  // P74i-m1（第二次）：发布审批与已作废的标记加入 ApprovalParts；这里是一张普通审批，都为假。
  launch: false,
  voided: false,
}

function textOf(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object' && node !== null && 'props' in node) return textOf((node as StubElement).props.children)
  return ''
}
const byClass = (tree: unknown, tag: string, cls: string) => findElements(tree, tag).filter(n => n.props.className === cls)
const toggleOf = (tree: unknown) => byClass(tree, 'button', 'ah-approval-toggle')[0]

describe('ApprovalBlock：四段显示', () => {
  it('第一行是那句话，第二行「原因：…」，然后风险提示；原始命令默认收起', () => {
    const tree = createHookHost().render(ApprovalBlock, { approval: parts, idBase: 'i1' })
    expect(textOf(byClass(tree, 'p', 'ah-approval-action'))).toBe(parts.actionText)
    expect(textOf(byClass(tree, 'p', 'ah-approval-reason'))).toBe('原因：推送本周的报表脚本，方便你查看')
    expect(textOf(byClass(tree, 'p', 'ah-approval-risk'))).toBe(parts.riskNote)
    // 默认收起：原始命令的文字不在树里，按钮写「查看原始命令」，读屏状态为未展开。
    expect(textOf(tree)).not.toContain('git push origin main --tags')
    expect(byClass(tree, 'pre', 'ah-approval-raw')).toHaveLength(0)
    expect(textOf(toggleOf(tree))).toBe('查看原始命令')
    expect(toggleOf(tree)!.props['aria-expanded']).toBe(false)
  })

  it('点开后原始命令可见（pre 等宽可换行的样式类）、按钮变「收起原始命令」、aria-expanded 为 true；再点收起', () => {
    const host = createHookHost()
    const props = { approval: parts, idBase: 'i1' }
    const first = host.render(ApprovalBlock, props)
    ;(toggleOf(first)!.props.onClick as () => void)()
    const open = host.render(ApprovalBlock, props)
    const raw = byClass(open, 'pre', 'ah-approval-raw')[0]!
    expect(textOf(raw)).toBe('git push origin main --tags')
    expect(toggleOf(open)!.props['aria-expanded']).toBe(true)
    expect(toggleOf(open)!.props['aria-controls']).toBe(raw.props.id)
    expect(textOf(toggleOf(open))).toBe('收起原始命令')
    ;(toggleOf(open)!.props.onClick as () => void)()
    const closed = host.render(ApprovalBlock, props)
    expect(byClass(closed, 'pre', 'ah-approval-raw')).toHaveLength(0)
    expect(toggleOf(closed)!.props['aria-expanded']).toBe(false)
  })

  it('键盘可操作：开关是原生 button（type=button，Tab 可达，回车和空格由浏览器触发 click），没有 tabIndex=-1', () => {
    const tree = createHookHost().render(ApprovalBlock, { approval: parts, idBase: 'i1' })
    const toggle = toggleOf(tree)!
    expect(toggle.type).toBe('button')
    expect(toggle.props.type).toBe('button')
    expect(toggle.props.tabIndex).toBeUndefined()
    expect(toggle.props.disabled).toBeUndefined()
    expect(toggle.props.onKeyDown).toBeUndefined() // 不自己拦键盘，交给原生按钮行为
  })

  it('没有原因就不显示「原因」行，没有风险就不显示风险行；没有原始命令就没有开关', () => {
    const tree = createHookHost().render(ApprovalBlock, { approval: { actionText: '运行一条需要确认的命令', ownerReason: null, riskNote: null, argsPreview: '', notes: null, onBehalfOf: null, launch: false, voided: false }, idBase: 'i2' })
    expect(byClass(tree, 'p', 'ah-approval-reason')).toHaveLength(0)
    expect(byClass(tree, 'p', 'ah-approval-risk')).toHaveLength(0)
    expect(toggleOf(tree)).toBeUndefined()
    expect(textOf(tree)).not.toContain('原因：')
  })
})

describe('approvalPartsOf：旧记录与异常数据', () => {
  it('没有 approval 字段、不是审批卡、形状不对都返回 null，不抛错', () => {
    expect(approvalPartsOf({ type: 'approval' })).toBeNull()
    expect(approvalPartsOf({ type: 'question', approval: parts })).toBeNull()
    expect(approvalPartsOf({ type: 'approval', approval: 'x' })).toBeNull()
    expect(approvalPartsOf({ type: 'approval', approval: { actionText: '' } })).toBeNull()
    // P74i：结构化内容多三行说明与「由谁执行」两个字段（没有时为 null）；
    // P74i-m1（第二次）：再加 launch（发布审批）与 voided（已作废）两个布尔（缺省按假）。
    expect(approvalPartsOf({ type: 'approval', approval: { actionText: 'a' } })).toEqual({ actionText: 'a', ownerReason: null, riskNote: null, argsPreview: '', notes: null, onBehalfOf: null, launch: false, voided: false })
    expect(approvalPartsOf({ type: 'approval', approval: parts })).toEqual(parts)
  })
})

function card(patch: Partial<CardPayload> = {}): CardPayload {
  return {
    inboxId: 'i_a', approvalId: 'a_1', type: 'approval', status: 'open', title: '批准：运行命令 git push', body: '队友申请运行命令。\n风险：会改动远端',
    options: ['批准', '拒绝'], defaultOption: null, answer: null, expiresText: null, ...patch,
  }
}
const actions: CardActions = { onPick: async () => null }
const render = (c: CardPayload) => createHookHost().render(InboxCard, { card: c, actions, busy: false })

describe('InboxCard：新旧审批记录', () => {
  it('新记录：交给 ApprovalBlock 显示，不再显示旧正文和重复的标题', () => {
    const tree = render(card({ approval: parts }))
    const blocks = findElements(tree, ApprovalBlock)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.props.approval).toEqual(parts)
    expect(byClass(tree, 'span', 'ah-card-title')).toHaveLength(0)
    expect(byClass(tree, 'p', 'ah-card-body')).toHaveLength(0)
  })

  it('旧记录（没有 approval）：标题和正文照旧，不报错，批准和拒绝按钮仍在', () => {
    const tree = render(card())
    expect(findElements(tree, ApprovalBlock)).toHaveLength(0)
    expect(textOf(byClass(tree, 'span', 'ah-card-title'))).toBe('批准：运行命令 git push')
    expect(textOf(byClass(tree, 'p', 'ah-card-body'))).toContain('队友申请运行命令')
    expect(findElements(tree, 'button').map(textOf)).toEqual(['批准', '拒绝'])
  })

  it('新记录里批准和拒绝按钮不受影响', () => {
    expect(findElements(render(card({ approval: parts })), 'button').map(textOf)).toEqual(['批准', '拒绝'])
  })

  it('非审批卡即使带了 approval 也不走审批块', () => {
    expect(findElements(render(card({ type: 'question', approvalId: null, approval: parts })), ApprovalBlock)).toHaveLength(0)
  })
})

describe('待你处理：收件箱项把 approval 带进卡片', () => {
  const item = (patch: Partial<InboxItemView> = {}): InboxItemView => ({
    id: 'i_a', botId: 'bot-1', botName: '探路', botColor: null, type: 'approval', typeLabel: '审批', priority: 'P1',
    approvalId: 'a_1', title: '批准：x', body: 'b', options: ['批准', '拒绝'], defaultOption: null, createdAt: 1, createdText: '刚刚', expiresText: null, ...patch,
  })
  const paneProps = (items: InboxItemView[]) => ({ inbox: { items }, loading: false, error: null, onRetry: () => undefined, actions, busyId: null })

  it('新记录带 approval；旧记录没有这个字段（不是 undefined 占位）', () => {
    const withNew = findElements(createHookHost().render(InboxPane, paneProps([item({ approval: parts })])), InboxCard)[0]!
    expect((withNew.props.card as CardPayload).approval).toEqual(parts)
    const legacy = findElements(createHookHost().render(InboxPane, paneProps([item()])), InboxCard)[0]!
    expect('approval' in (legacy.props.card as CardPayload)).toBe(false)
  })
})

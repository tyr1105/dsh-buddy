/**
 * P74i 审批卡三行测试（第五类）：三行（费用、能否撤回、批准之后）的顺序在原因与风险之后、
 * 「查看原始命令」之前；notes 为 null 时整块不显示；onBehalfOf 一行；原始命令默认收起。
 * 「待你处理」里的审批条目同样显示这三行与 onBehalfOf。
 */
import { describe, expect, it, vi } from 'vitest'
import { ApprovalBlock } from '../src/client/components/ApprovalBlock.js'
import { InboxCard } from '../src/client/components/Cards.js'
import { approvalPartsOf } from '../src/client/logic/cards.js'
import type { ApprovalParts } from '../src/client/logic/cards.js'
import type { InboxItemView } from '../src/shared/views.js'
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

const parts: ApprovalParts = {
  actionText: '把报名页发布到公司内网',
  ownerReason: '活动页已通过你的验收',
  riskNote: '发布后内网上的同事都能访问',
  argsPreview: 'node scripts/release/publish-copy.mjs --target intranet',
  notes: { cost: '不额外花钱', undo: '发布后 24 小时内可以撤回', after: '链接会发到活动群' },
  onBehalfOf: '由林舟执行',
  // P74i-m1（第二次）：发布审批与已作废的标记；ApprovalBlock 只画分段内容，不看这两项。
  launch: false,
  voided: false,
}

describe('审批卡三行与「由谁执行」（P74i）', () => {
  it('三行顺序在原因与风险之后、「查看原始命令」之前；原始命令默认收起', () => {
    const tree = createHookHost().render(ApprovalBlock, { approval: parts, idBase: 'i1' })
    const text = textOf(tree)
    const order = ['把报名页发布到公司内网', '原因：活动页已通过你的验收', '发布后内网上的同事都能访问', '由林舟执行', '费用', '能否撤回', '批准之后', '查看原始命令']
    let at = -1
    for (const piece of order) {
      const found = text.indexOf(piece)
      expect(found, piece).toBeGreaterThan(at)
      at = found
    }
    // 三行的值逐行显示。
    expect(text).toContain('不额外花钱')
    expect(text).toContain('发布后 24 小时内可以撤回')
    expect(text).toContain('链接会发到活动群')
    // 原始命令默认收起。
    expect(text).not.toContain('--target intranet')
  })

  it('notes 为 null 时整块不显示；onBehalfOf 为 null 时没有那一行', () => {
    const tree = createHookHost().render(ApprovalBlock, { approval: { ...parts, notes: null, onBehalfOf: null }, idBase: 'i2' })
    const text = textOf(tree)
    expect(text).not.toContain('费用')
    expect(text).not.toContain('能否撤回')
    expect(text).not.toContain('批准之后')
    expect(text).not.toContain('由林舟执行')
    expect(findElements(tree, 'dl')).toHaveLength(0)
  })

  it('「待你处理」里的审批条目同样显示三行与「由谁执行」（InboxCard 走同一个 ApprovalBlock）', () => {
    // 直接用 InboxCard 渲染一张带结构化内容的审批卡（与 itemToCard 拼出的形状一致）。
    const tree = createHookHost().render(InboxCard, {
      card: {
        inboxId: 'i_appr1', approvalId: 'apv_1', type: 'approval', status: 'open',
        title: '发布审批', body: '……', options: ['批准', '拒绝'], defaultOption: null, answer: null, expiresText: null,
        approval: parts,
      },
      actions: { onPick: async () => null }, busy: false,
    })
    const block = findElements(tree, ApprovalBlock)[0]!
    // InboxCard 把 approval 原样交给 ApprovalBlock（notes 与 onBehalfOf 都在）。
    expect(block.props.approval).toEqual(parts)
  })
})

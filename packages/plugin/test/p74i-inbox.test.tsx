/**
 * P74i「待你处理」四类条目测试（第四类）：验收、向主人说明、回合上限、停住了各自的按钮
 * （文字取条目的 options，不写死数字）；都没有自由文本输入、没有「到期」字样；
 * 都归在「提问」筛选下（type 为 question）；回答统一走 answerInbox（core 分流到各自的专用命令）。
 * 另有：带「确认后这件事停止」一行的约定条目与总管私聊状态行的两句新文字（补充要求第 5 条）。
 */
import { describe, expect, it, vi } from 'vitest'
import { InboxCard } from '../src/client/components/Cards.js'
import { InboxPane } from '../src/client/components/InboxPane.js'
import { itemToCard } from '../src/client/components/InboxPane.js'
import { cardSubmission, expiryMeaningOf, jobEntryKindOf } from '../src/client/logic/cards.js'
import { chiefPendingStatusOf } from '../src/client/logic/agreement.js'
import { sampleJobInboxEntries } from '../src/shared/fixture-job.js'
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
const buttons = (tree: unknown): StubElement[] => findElements(tree, 'button')
const buttonTexts = (tree: unknown): string[] => buttons(tree).map(node => textOf(node))
const inputs = (tree: unknown): StubElement[] => findElements(tree, 'input')

const [acceptItem, escalateItem, capItem, stallItem] = sampleJobInboxEntries
const actions = { onPick: async () => null }

describe('四类条目的识别（jobEntryKindOf，P74i-m1 第二次：只看 jobEntry.kind）', () => {
  it('验收、向主人说明、回合上限、没有进展各归各类；没有 jobEntry 的条目按普通条目处理', () => {
    expect(jobEntryKindOf(itemToCard(acceptItem!))).toBe('accept')
    expect(jobEntryKindOf(itemToCard(escalateItem!))).toBe('escalate')
    expect(jobEntryKindOf(itemToCard(capItem!))).toBe('cap')
    expect(jobEntryKindOf(itemToCard(stallItem!))).toBe('stall')
    // 按钮文字形状与四类相同但没有 jobEntry（普通提问、审批、告警）：不误判。
    expect(jobEntryKindOf({ jobEntry: null })).toBeNull()
    expect(jobEntryKindOf({})).toBeNull()
    expect(jobEntryKindOf({ jobEntry: { kind: 'accept', jobId: 'job_x' } })).toBe('accept')
    expect(jobEntryKindOf({ jobEntry: { kind: 'cap', jobId: 'job_x' } })).toBe('cap')
    // 回合上限的按钮文字换了说法（P74r5「先停下」改「暂停」）也不影响识别。
    expect(jobEntryKindOf(itemToCard({ ...capItem!, options: ['再给 5 个回合', '暂停'] }))).toBe('cap')
  })
})

describe('四类条目的渲染（P74i；说明条目改画完整卡片，见 p74i-m1-second 测试）', () => {
  it.each([
    ['验收', acceptItem!, ['验收通过']],
    ['回合上限', capItem!, ['再给 8 个回合', '暂停']],
    ['没有进展', stallItem!, ['再提醒一次', '暂停']],
  ])('%s：按钮文字取条目的 options，没有自由文本输入，没有「到期」文字', (_name, item, options) => {
    const tree = createHookHost().render(InboxCard, { card: itemToCard(item), actions, busy: false })
    // 按钮文字与 options 逐字相同（回合上限的数字来自条目，不写死）。
    expect(buttonTexts(tree)).toEqual(options)
    // 没有自由文本输入（「或填写回答」的输入框不出现）。
    expect(inputs(tree)).toHaveLength(0)
    expect(textOf(tree)).not.toContain('或填写回答')
    // 没有期限：不显示任何「到期」类文字。
    expect(expiryMeaningOf(itemToCard(item))).toBeNull()
    expect(textOf(tree)).not.toContain('到期')
    expect(textOf(tree)).not.toContain('过期')
    expect(textOf(tree)).not.toContain('前未答复')
  })

  it('验收条目的正文自带「哪条不符合，在对话里写序号和问题。」', () => {
    const tree = createHookHost().render(InboxCard, { card: itemToCard(acceptItem!), actions, busy: false })
    expect(textOf(tree)).toContain('哪条不符合，在对话里写序号和问题。')
    expect(textOf(tree)).toContain('待你验收')
  })

  it('四类都归在「提问」筛选下（type 为 question），「提问」的计数把它们全算进去', () => {
    const inbox = { items: sampleJobInboxEntries.map(item => ({ ...item })) }
    const tree = createHookHost().render(InboxPane, {
      inbox, loading: false, error: null, onRetry: () => undefined, actions, busyId: null,
    })
    const questionTab = buttons(tree).find(node => textOf(node).startsWith('提问'))!
    expect(textOf(questionTab)).toBe('提问 4')
    // 卡片标签也是「提问」。
    const types = findElements(tree, 'span').filter(node => String(node.props.className ?? '') === 'ah-card-type').map(node => textOf(node))
    expect(types.every(label => label === '提问')).toBe(true)
  })

  it('回答统一走 answerInbox：core 的 answerJobInbox 按事项键分流（视图不带事项键，见 questions.md）', () => {
    // 验收条目点「验收通过」。
    expect(cardSubmission(itemToCard(acceptItem!), '验收通过')).toEqual({ name: 'answerInbox', input: { id: 'i_sampleview1', answer: '验收通过' } })
    // 回合上限点第二个按钮（P74r5 之后按钮文字是「暂停」）。
    expect(cardSubmission(itemToCard(capItem!), '暂停')).toEqual({ name: 'answerInbox', input: { id: 'i_sampleview3', answer: '暂停' } })
    // 没有进展条目点第一个按钮（P74r5 之后是「再提醒一次」）。
    expect(cardSubmission(itemToCard(stallItem!), '再提醒一次')).toEqual({ name: 'answerInbox', input: { id: 'i_sampleview4', answer: '再提醒一次' } })
    // 向主人说明的条目不再走按钮提交（P74i-m1 第二次：画完整卡片，经 chooseJobOption 提交，见 p74i-m1-second 测试）。
  })
})

describe('带「确认后这件事停止」一行的约定（补充要求第 5 条）', () => {
  const pendingCard = { canConfirm: true as const, state: 'pending' as const, jobSplit: null, stopLine: '确认后这件事停止，已经做出来的东西保留在项目文件夹里。' }

  it('总管私聊顶部状态行换新句（新编号，不改已有编号的原文）', () => {
    expect(chiefPendingStatusOf([{ agreement: pendingCard }])).toBe('等你确认约定。确认后这件事停止。')
    // 没有这一行时照旧（两栏句、原句）。
    expect(chiefPendingStatusOf([{ agreement: { ...pendingCard, stopLine: null, jobSplit: { continuing: [], paused: [], dueText: '', fallback: null } } }]))
      .toBe('等你确认约定。确认前，暂停的部分不会做。')
    expect(chiefPendingStatusOf([{ agreement: { ...pendingCard, stopLine: null } }])).toBe('等你确认约定。确认前不会开工。')
  })

  it('「待你处理」里约定条目的说明换新句', () => {
    const card = itemToCard({ ...(acceptItem as unknown as InboxItemView), agreementId: 'agr_x', options: ['按建议，定了'], agreementStop: true })
    expect(expiryMeaningOf(card)).toBe('不会自动按建议处理。你确认后这件事停止；确认前照常在做。')
    // 没有这一行时保持原来的两句。
    expect(expiryMeaningOf({ ...card, agreementStop: false, agreementJobSplit: true })).toBe('不会自动按建议处理。你确认前，暂停的部分不会做。')
    expect(expiryMeaningOf({ ...card, agreementStop: false, agreementJobSplit: false })).toBe('不会自动按建议处理。你确认前不会开工。')
  })
})

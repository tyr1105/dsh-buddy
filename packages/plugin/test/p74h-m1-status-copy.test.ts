/**
 * P74h-m1 维护卡的文案测试（走查第 6 处）：
 * 约定有一件正在做的事、新版本在等确认时，工作是照常在做的（只暂停被改动涉及的部分），
 * 界面上两句「确认前不会开工」要换成「确认前，暂停的部分不会做。」——
 * - 总管私聊顶部的状态行（chiefPendingStatusOf / ThreadPane）；
 * - 「待你处理」里约定条目的有效期说明（itemToCard / expiryMeaningOf）。
 * 每句各一条：待确认卡带两栏（jobSplit 不为空）时显示新句子，不带时保持原句。
 * 样例取自 fixture-job.ts（core 的视图函数生成）：提问样例的卡带两栏，去掉两栏后就是反例。
 */
import { describe, expect, it, vi } from 'vitest'
import { ThreadPane } from '../src/client/components/ThreadPane.js'
import { itemToCard } from '../src/client/components/InboxPane.js'
import { AGR_TEXT, chiefPendingStatusOf, hasPendingAgreement, pendingAgreementHasJobSplit } from '../src/client/logic/agreement.js'
import { expiryMeaningOf } from '../src/client/logic/cards.js'
import { fixtureInbox } from '../src/shared/fixtures.js'
import { sampleAskThread } from '../src/shared/fixture-job.js'
import type { ThreadView } from '../src/shared/views.js'
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

/** 与 p72g-ui.test.ts 同一份 ThreadPane 最小入参（只看顶部状态行）。 */
function paneProps(thread: ThreadView): Parameters<typeof ThreadPane>[0] {
  return {
    threadId: thread.threadId, thread, loading: false,
    header: { name: '总管', roleLabel: '总管', activityText: '空闲。', nextThinkText: null, staffStatus: 'on_duty', thinking: false },
    inputPlaceholderName: '总管', banner: null, onBannerDismiss: () => undefined, onLoadEarlier: () => undefined, onSend: async () => undefined,
    actions: { onPick: async () => null }, busyInboxId: null, onRetry: () => undefined, error: null,    onOpenSession: () => undefined, onTogglePause: () => undefined, onInterrupt: () => undefined, chiefEntry: true,
  }
}

describe('走查第 6 处：待确认约定带两栏时的两句说明（P74h-m1）', () => {
  const askMessages = sampleAskThread.messages
  // 反例：同一份消息，把待确认卡的两栏剥掉（其余不动）。
  const withoutSplit = askMessages.map(message => message.agreement != null && message.agreement.jobSplit != null
    ? { ...message, agreement: { ...message.agreement, jobSplit: null } }
    : message)

  it('正例：卡带两栏时，总管私聊顶部状态行是「确认前，暂停的部分不会做。」', () => {
    expect(hasPendingAgreement(askMessages)).toBe(true)
    expect(pendingAgreementHasJobSplit(askMessages)).toBe(true)
    expect(chiefPendingStatusOf(askMessages)).toBe('等你确认约定。确认前，暂停的部分不会做。')
    const tree = createHookHost().render(ThreadPane, paneProps(sampleAskThread))
    const statuses = findElements(tree, 'p').filter(node => classOf(node) === 'ah-thread-status')
    expect(statuses.map(textOf)).toEqual(['等你确认约定。确认前，暂停的部分不会做。'])
    expect(AGR_TEXT.chiefPendingJobSplitStatus).toBe('等你确认约定。确认前，暂停的部分不会做。')
  })

  it('反例：没有两栏时保持原句「确认前不会开工。」', () => {
    expect(pendingAgreementHasJobSplit(withoutSplit)).toBe(false)
    expect(chiefPendingStatusOf(withoutSplit)).toBe('等你确认约定。确认前不会开工。')
    const thread: ThreadView = { ...sampleAskThread, messages: withoutSplit }
    const tree = createHookHost().render(ThreadPane, paneProps(thread))
    const statuses = findElements(tree, 'p').filter(node => classOf(node) === 'ah-thread-status')
    expect(statuses.map(textOf)).toEqual(['等你确认约定。确认前不会开工。'])
    expect(AGR_TEXT.chiefPendingStatus).toBe('等你确认约定。确认前不会开工。')
  })

  it('正例：卡带两栏时，「待你处理」里约定条目的说明是「你确认前，暂停的部分不会做。」', () => {
    const agreementItem = fixtureInbox.items.find(item => item.agreementId !== undefined && item.agreementId !== null)!
    expect(expiryMeaningOf(itemToCard({ ...agreementItem, agreementJobSplit: true }))).toBe('不会自动按建议处理。你确认前，暂停的部分不会做。')
    expect(AGR_TEXT.noAutoAdoptJobSplit).toBe('不会自动按建议处理。你确认前，暂停的部分不会做。')
  })

  it('反例：没有两栏时说明保持原句；普通提问条目不受影响', () => {
    const agreementItem = fixtureInbox.items.find(item => item.agreementId !== undefined && item.agreementId !== null)!
    expect(expiryMeaningOf(itemToCard(agreementItem))).toBe('不会自动按建议处理。你确认前不会开工。')
    expect(expiryMeaningOf(itemToCard({ ...agreementItem, agreementJobSplit: false }))).toBe('不会自动按建议处理。你确认前不会开工。')
    const plainItem = fixtureInbox.items.find(item => item.type === 'question' && !item.agreementId)!
    expect(expiryMeaningOf(itemToCard({ ...plainItem, agreementJobSplit: true }))).toBe('周五 09:00 按默认处理')
  })
})

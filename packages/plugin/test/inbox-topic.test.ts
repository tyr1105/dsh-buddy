/**
 * P65「待你处理」里来自项目主题的事项：名字后面写「来自主题：主题名」，
 * 「查看对话」和处理后的「查看会话」直接进主题（队友回到主题里接着做）；不来自主题的照旧进私聊。
 *
 * 用 hook 宿主渲染真实的 InboxPane：子组件（卡片）不执行，只看这一层交给下一层什么、按钮点了去哪。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InboxCard, type CardActions, type CardPayload } from '../src/client/components/Cards.js'
import { InboxPane } from '../src/client/components/InboxPane.js'
import { inboxThreadId } from '../src/client/logic/feeds.js'
import type { InboxItemView } from '../src/shared/views.js'
import { createHookHost } from './helpers/hook-host.js'
import { findElements, type StubElement } from './helpers/jsx-runtime-stub.js'

vi.mock('react', async () => (await import('./helpers/hook-host.js')).reactFacade)

/** 造一张收件箱卡：默认是探路的提问，不来自主题。 */
function item(patch: Partial<InboxItemView> = {}): InboxItemView {
  return {
    id: 'i_question', botId: 'bot-tanlu', botName: '探路', botColor: null, type: 'question', typeLabel: '提问', priority: 'P1',
    approvalId: null, title: '选 A 还是 B', body: '两种做法成本不同', options: ['A', 'B'], defaultOption: 'A',
    createdAt: 1, createdText: '刚刚', expiresText: null, ...patch,
  }
}

/** InboxPane 的入参：动作和「打开线程」都用假函数记下调用。 */
function paneProps(items: InboxItemView[], onOpenThread: (threadId: string) => void, onPick: CardActions['onPick'] = async () => null) {
  return { inbox: { items }, loading: false, error: null, onRetry: () => undefined, actions: { onPick }, busyId: null, onOpenThread }
}

/** 把元素树里的文字拼起来；子组件不展开。 */
function textOf(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object' && node !== null && 'props' in node) return textOf((node as StubElement).props.children)
  return ''
}

/** 按可见文字找按钮。 */
function buttonNamed(tree: unknown, label: string): StubElement | undefined {
  return findElements(tree, 'button').find(node => textOf(node) === label)
}

/** 来自主题标签那个元素。 */
function topicLabels(tree: unknown): StubElement[] {
  return findElements(tree, 'span').filter(node => node.props.className === 'ah-inbox-topic')
}

const fromTopic = item({ id: 'i_topic', topicId: 'ptp_weekly_price', topicTitle: '竞品周报怎么做' })

describe('inboxThreadId：查看对话去哪条线程', () => {
  it('来自主题的去主题', () => {
    expect(inboxThreadId(fromTopic)).toBe('ptp_weekly_price')
  })

  it('反例：不来自主题（没有这一项或为空）的去队友私聊；全队事项没有入口', () => {
    expect(inboxThreadId(item())).toBe('bot-tanlu')
    expect(inboxThreadId(item({ topicId: null }))).toBe('bot-tanlu')
    expect(inboxThreadId(item({ botId: null }))).toBeNull()
  })
})

describe('InboxPane：来自主题的事项', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('名字后面写「来自主题：主题名」，悬停能看全名；点「查看对话」进主题', () => {
    const onOpenThread = vi.fn()
    const tree = createHookHost().render(InboxPane, paneProps([fromTopic], onOpenThread))
    const [label] = topicLabels(tree)
    expect(textOf(label)).toBe('来自主题：竞品周报怎么做')
    expect(label!.props.title).toBe('竞品周报怎么做')
    ;(buttonNamed(tree, '查看对话')!.props.onClick as () => void)()
    expect(onOpenThread).toHaveBeenCalledWith('ptp_weekly_price')
  })

  it('反例：不来自主题的没有这句，「查看对话」照旧进队友私聊', () => {
    const onOpenThread = vi.fn()
    const tree = createHookHost().render(InboxPane, paneProps([item()], onOpenThread))
    expect(topicLabels(tree)).toEqual([])
    expect(textOf(tree)).not.toContain('来自主题')
    ;(buttonNamed(tree, '查看对话')!.props.onClick as () => void)()
    expect(onOpenThread).toHaveBeenCalledWith('bot-tanlu')
  })

  it('处理成功后「查看会话」也进主题：队友在那里接着做', async () => {
    const onOpenThread = vi.fn()
    const host = createHookHost()
    const props = paneProps([fromTopic], onOpenThread)
    const card = findElements(host.render(InboxPane, props), InboxCard)[0]!
    const actions = card.props.actions as CardActions
    expect(await actions.onPick(card.props.card as CardPayload, 'A')).toBeNull()
    const after = host.render(InboxPane, props)
    expect(textOf(after)).toContain('已提交。下一步：继续执行，负责人 探路。')
    ;(buttonNamed(after, '查看会话')!.props.onClick as () => void)()
    expect(onOpenThread).toHaveBeenCalledWith('ptp_weekly_price')
  })

  it('反例：不来自主题的，处理后「查看会话」照旧进私聊', async () => {
    const onOpenThread = vi.fn()
    const host = createHookHost()
    const props = paneProps([item()], onOpenThread)
    const card = findElements(host.render(InboxPane, props), InboxCard)[0]!
    await (card.props.actions as CardActions).onPick(card.props.card as CardPayload, 'A')
    ;(buttonNamed(host.render(InboxPane, props), '查看会话')!.props.onClick as () => void)()
    expect(onOpenThread).toHaveBeenCalledWith('bot-tanlu')
  })
})

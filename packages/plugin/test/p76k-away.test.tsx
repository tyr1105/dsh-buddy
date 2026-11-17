/**
 * P76k 离开期间摘要（界面）：画在消息列表最上方、第一条消息之前；首行加粗；
 * 「知道了，收起」调用收起命令；员工私聊没有这个字段时不画；它不是消息，不增加消息条数。
 */
import { describe, expect, it, vi } from 'vitest'
import { ThreadPane } from '../src/client/components/ThreadPane.js'
import type { ThreadMessageView, ThreadView } from '../src/shared/views.js'
import { fixtureAwaySummary } from '../src/shared/fixture-budget.js'
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

/** 两条普通消息：一条总管说的，一条主人说的。 */
function message(id: string, from: 'owner' | string, text: string): ThreadMessageView {
  return {
    id, thread: 'bot-zongguan', from, fromName: from === 'owner' ? '你' : '总管', fromColor: null,
    kind: 'chat', text, createdAt: 1, timeText: '10:00', card: null,
  }
}

function threadView(extra: Partial<ThreadView> = {}): ThreadView {
  return {
    threadId: 'bot-zongguan', title: '总管',
    messages: [message('m1', 'hub', '早上好。'), message('m2', 'owner', '看一下报名页。')],
    hasMore: false, oldestId: 'm1', ...extra,
  }
}

/** ThreadPane 必需的回调：本测试只看摘要块，其余给空实现。 */
function renderPane(thread: ThreadView, onDismissAway?: () => Promise<void>) {
  const host = createHookHost()
  const tree = host.render(ThreadPane, {
    threadId: thread.threadId, thread, loading: false,
    header: { name: '总管', roleLabel: null, activityText: null, nextThinkText: null, staffStatus: null, thinking: false },
    inputPlaceholderName: '总管', banner: null, onBannerDismiss: () => {}, onLoadEarlier: () => {},
    onSend: async () => {}, actions: { onPick: async () => null }, busyInboxId: null,
    onRetry: () => {}, error: null, onTeach: () => {}, onOpenSession: () => {}, onTogglePause: () => {}, onInterrupt: () => {},
    onDismissAway,
  })
  return { host, tree }
}

/** 消息列表容器：摘要画在它的第一个子节点。 */
function messagesContainer(tree: unknown): StubElement {
  const found = findElements(tree, 'div').find(node => classOf(node) === 'ah-thread-messages')
  if (found === undefined) throw new Error('找不到消息列表容器')
  return found
}

describe('P76k 离开期间摘要', () => {
  it('画在第一条消息之前，首行加粗，每一行都显示', () => {
    const away = fixtureAwaySummary()
    const { tree } = renderPane(threadView({ awaySummary: away }))
    const container = messagesContainer(tree)
    const children = container.props.children as unknown[]
    const first = children.find(child => typeof child === 'object' && child !== null && 'type' in child) as StubElement
    expect(first.type).toBe('section')
    expect(classOf(first)).toBe('ah-away')
    const text = textOf(first)
    for (const line of away.lines) expect(text).toContain(line)
    // 首行在 <strong> 里。
    const strong = findElements(first, 'strong')
    expect(strong).toHaveLength(1)
    expect(textOf(strong[0])).toBe(away.lines[0])
  })

  it('live 区域常驻：没有摘要时也在 DOM 里，有摘要时包含摘要文字', () => {
    const empty = findElements(renderPane(threadView()).tree, 'div').find(node => classOf(node) === 'ah-away-live')!
    expect(empty).toBeDefined()
    expect(empty.props.role).toBe('status')
    expect(empty.props['aria-live']).toBe('polite')
    expect(textOf(empty)).toBe('')

    const withAway = findElements(renderPane(threadView({ awaySummary: fixtureAwaySummary() })).tree, 'div')
      .find(node => classOf(node) === 'ah-away-live')!
    expect(textOf(withAway)).toContain('你离开的')
  })

  it('不是消息：消息条数不变，摘要不进消息列表', () => {
    const { tree } = renderPane(threadView({ awaySummary: fixtureAwaySummary() }))
    const container = messagesContainer(tree)
    const messageNodes = findElements(container, 'div').filter(node => classOf(node).split(' ')[0] === 'ah-msg')
    expect(messageNodes).toHaveLength(2)
    // 摘要里的「你离开的」不进任何一条消息气泡。
    for (const node of messageNodes) expect(textOf(node)).not.toContain('你离开的')
  })

  it('员工私聊没有 awaySummary：不画这一块', () => {
    const { tree } = renderPane(threadView())
    expect(findElements(tree, 'section').some(node => classOf(node) === 'ah-away')).toBe(false)
  })

  it('点「知道了，收起」调用收起；进行中按钮不可点；失败把原因留在块里', async () => {
    let resolveDismiss: () => void = () => {}
    const pending = new Promise<void>(resolve => { resolveDismiss = resolve })
    const onDismiss = vi.fn(() => pending)
    const { host, tree } = renderPane(threadView({ awaySummary: fixtureAwaySummary() }), onDismiss)
    const away = findElements(tree, 'section').find(node => classOf(node) === 'ah-away')!
    const button = findElements(away, 'button').find(node => textOf(node) === '知道了，收起')!
    expect(button).toBeDefined()
    ;(button.props.onClick as () => void)()
    expect(onDismiss).toHaveBeenCalledTimes(1)
    const during = host.render(ThreadPane, {
      threadId: 'bot-zongguan', thread: threadView({ awaySummary: fixtureAwaySummary() }), loading: false,
      header: { name: '总管', roleLabel: null, activityText: null, nextThinkText: null, staffStatus: null, thinking: false },
      inputPlaceholderName: '总管', banner: null, onBannerDismiss: () => {}, onLoadEarlier: () => {},
      onSend: async () => {}, actions: { onPick: async () => null }, busyInboxId: null,
      onRetry: () => {}, error: null, onTeach: () => {}, onOpenSession: () => {}, onTogglePause: () => {}, onInterrupt: () => {},
      onDismissAway: onDismiss,
    })
    const busy = findElements(during, 'button').find(node => textOf(node) === '知道了，收起')!
    expect(busy.props.disabled).toBe(true)
    resolveDismiss()
    await new Promise(resolve => setTimeout(resolve, 0))
  })

  it('收起失败：块里写明原因，按钮恢复可点', async () => {
    const onDismiss = vi.fn(async () => { throw new Error('连接中断') })
    const { host, tree } = renderPane(threadView({ awaySummary: fixtureAwaySummary() }), onDismiss)
    const away = findElements(tree, 'section').find(node => classOf(node) === 'ah-away')!
    const button = findElements(away, 'button').find(node => textOf(node) === '知道了，收起')!
    ;(button.props.onClick as () => void)()
    await new Promise(resolve => setTimeout(resolve, 0))
    const after = host.render(ThreadPane, {
      threadId: 'bot-zongguan', thread: threadView({ awaySummary: fixtureAwaySummary() }), loading: false,
      header: { name: '总管', roleLabel: null, activityText: null, nextThinkText: null, staffStatus: null, thinking: false },
      inputPlaceholderName: '总管', banner: null, onBannerDismiss: () => {}, onLoadEarlier: () => {},
      onSend: async () => {}, actions: { onPick: async () => null }, busyInboxId: null,
      onRetry: () => {}, error: null, onTeach: () => {}, onOpenSession: () => {}, onTogglePause: () => {}, onInterrupt: () => {},
      onDismissAway: onDismiss,
    })
    expect(textOf(after)).toContain('没收起：连接中断')
    const retry = findElements(after, 'button').find(node => textOf(node) === '知道了，收起')!
    expect(retry.props.disabled).toBe(false)
  })
})

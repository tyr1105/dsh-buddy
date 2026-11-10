/**
 * 看着私聊时新消息自动标已读的回归测试（P68）。
 *
 * 事故：主人开着和某位队友的私聊，队友又回了新消息，左栏这位队友的未读点不消失。
 * 原因：仓库的 selectThread 只在「点进去」那一下标已读，之后进来的新消息一直算未读。
 * 修法：中心页照项目主题（P63）的写法，页面摆着私聊且名册里未读数大于 0 时，再标一次已读并刷新名册。
 *
 * 这里用真实的 HubPage 和真实的仓库，只把 command / refreshOverview 换成可观察的假函数，
 * 然后改仓库里的名册来模拟「队友回了新消息，未读数变化」。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHubStore, type HubStore } from '../src/client/hub-state.js'
import { HubPage } from '../src/client/pages/HubPage.js'
import { fixtureOverview } from '../src/shared/fixtures.js'
import type { OverviewView } from '../src/shared/views.js'
import { createHookHost } from './helpers/hook-host.js'

// 把 react 换成 hook 宿主的替身；HubPage 里的 hook 都会走到这里。
vi.mock('react', async () => (await import('./helpers/hook-host.js')).reactFacade)

/** 把某位队友的未读数改成 n，返回新的名册（其余字段照旧）。 */
function withBotUnread(botId: string, unread: number): OverviewView {
  return { ...fixtureOverview, bots: fixtureOverview.bots.map(b => (b.id === botId ? { ...b, unread } : b)) }
}

/**
 * 建仓库：名册已到手、选中某个线程；
 * command 记录调用并成功，refreshOverview 只计数（不去联网）。
 */
function setup(options: { overview: OverviewView; selected: string; view?: 'main' | 'office' }) {
  const hub: HubStore = createHubStore()
  hub.update(prev => ({
    ...prev, overview: options.overview, selectedThread: options.selected, view: options.view ?? 'main',
  }))
  const command = vi.fn(async () => ({ ok: true as const }))
  const refreshOverview = vi.fn(async () => undefined)
  ;(hub as unknown as { command: unknown }).command = command
  ;(hub as unknown as { refreshOverview: unknown }).refreshOverview = refreshOverview
  return { hub, command, refreshOverview }
}

/** 只数 markThreadRead 的调用（页面挂载时可能还有别的命令）。 */
function markCalls(command: ReturnType<typeof vi.fn>): unknown[][] {
  return command.mock.calls.filter(call => call[0] === 'markThreadRead')
}

/** 等 effect 里 then 链上的微任务跑完。 */
const flush = () => new Promise(resolve => setTimeout(resolve, 0))

beforeEach(() => {
  // 中心页挂载时会拉数据，这里的断言用不到结果：永远等待，也不产生网络访问。
  vi.stubGlobal('fetch', () => new Promise(() => undefined))
  vi.stubGlobal('window', { addEventListener: () => undefined, removeEventListener: () => undefined })
})
afterEach(() => { vi.unstubAllGlobals() })

describe('私聊开着时的已读', () => {
  it('未读从 0 变成 1：再标一次已读，并刷新名册', async () => {
    const { hub, command, refreshOverview } = setup({ overview: withBotUnread('bot-tanlu', 0), selected: 'bot-tanlu' })
    const host = createHookHost()
    host.render(HubPage, { hub, clientCtx: null })
    await flush()
    expect(markCalls(command)).toHaveLength(0)

    // 队友回了新消息：名册里这位的未读变成 1。
    hub.update(prev => ({ ...prev, overview: withBotUnread('bot-tanlu', 1) }))
    host.render(HubPage, { hub, clientCtx: null })
    await flush()
    expect(markCalls(command)).toEqual([['markThreadRead', { threadId: 'bot-tanlu' }]])
    expect(refreshOverview).toHaveBeenCalled()
  })

  it('标完后名册未读归 0：不再重复发（不循环）', async () => {
    const { hub, command } = setup({ overview: withBotUnread('bot-tanlu', 2), selected: 'bot-tanlu' })
    const host = createHookHost()
    host.render(HubPage, { hub, clientCtx: null })
    await flush()
    expect(markCalls(command)).toHaveLength(1)

    hub.update(prev => ({ ...prev, overview: withBotUnread('bot-tanlu', 0) }))
    host.render(HubPage, { hub, clientCtx: null })
    // 同样的状态再渲染几次，也不会多发。
    host.render(HubPage, { hub, clientCtx: null })
    await flush()
    expect(markCalls(command)).toHaveLength(1)
  })

  it('反例：未读为 0 不发', async () => {
    const { hub, command } = setup({ overview: withBotUnread('bot-tanlu', 0), selected: 'bot-tanlu' })
    createHookHost().render(HubPage, { hub, clientCtx: null })
    await flush()
    expect(markCalls(command)).toHaveLength(0)
  })

  it('反例：不在对话页（在办公室页）时不发', async () => {
    const { hub, command } = setup({ overview: withBotUnread('bot-tanlu', 3), selected: 'bot-tanlu', view: 'office' })
    createHookHost().render(HubPage, { hub, clientCtx: null })
    await flush()
    expect(markCalls(command)).toHaveLength(0)
  })

  it('反例：已删除的队友（名册里查不到）不发，守住 P58', async () => {
    const { hub, command } = setup({ overview: withBotUnread('bot-tanlu', 3), selected: 'bot-gone' })
    createHookHost().render(HubPage, { hub, clientCtx: null })
    await flush()
    expect(markCalls(command)).toHaveLength(0)
  })

  it('团队线程同样处理：team 未读大于 0 时标已读', async () => {
    const { hub, command, refreshOverview } = setup({
      overview: { ...fixtureOverview, team: { ...fixtureOverview.team, unread: 2 } }, selected: 'team',
    })
    createHookHost().render(HubPage, { hub, clientCtx: null })
    await flush()
    expect(markCalls(command)).toEqual([['markThreadRead', { threadId: 'team' }]])
    expect(refreshOverview).toHaveBeenCalled()
  })
})

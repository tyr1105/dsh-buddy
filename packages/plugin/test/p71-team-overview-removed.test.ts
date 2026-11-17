/**
 * P71「砍掉团队全景」的界面回归测试。
 *
 * 主人决定：左栏「队友」组最上面那条「团队全景」会话（引擎里线程 id 是 'team'）没有意义，先砍掉。
 * 这里锁住四件事：
 * 1. 左栏「队友」组不再画团队全景那一行，第一行就是队友；
 * 2. 刚打开、什么都没选时，中栏默认落在办公室，不是一页空对话；
 * 3. 选中的队友被删掉时退回办公室（P58 的落点改了）；
 * 4. 界面源码里不再有能跳到团队线程的入口。
 * 「团队消息改投私聊」「日报不进会话」是引擎行为，在 core 的 p71-team-thread-retired.test.ts 里测。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHubStore } from '../src/client/hub-state.js'
import { TeammatesGroup, type TeammatesGroupProps } from '../src/client/components/sidebar-teammates-group.js'
import { ThreadPane } from '../src/client/components/ThreadPane.js'
import { exitMissingSelection } from '../src/client/logic/missing-teammate.js'
import { HubPage } from '../src/client/pages/HubPage.js'
import { OfficeReplayPage } from '../src/client/pages/office-replay-page.js'
import { fixtureOverview } from '../src/shared/fixtures.js'
import { createHookHost } from './helpers/hook-host.js'
import { findElements, type StubElement } from './helpers/jsx-runtime-stub.js'

vi.mock('react', async () => (await import('./helpers/hook-host.js')).reactFacade)
vi.mock('react-dom', () => ({ createPortal: () => null }))

beforeEach(() => {
  // 中心页挂载时会拉数据、挂快捷键；这里只看页面结构，请求永远挂起，window 给空函数。
  vi.stubGlobal('fetch', () => new Promise(() => undefined))
  vi.stubGlobal('window', { addEventListener: () => undefined, removeEventListener: () => undefined })
})
afterEach(() => { vi.unstubAllGlobals() })

/** 把元素树里所有字符串和 className 收集起来（子组件不展开，只看这一层画了什么）。 */
function collect(node: unknown, out: { texts: string[]; classes: string[] } = { texts: [], classes: [] }) {
  if (typeof node === 'string' || typeof node === 'number') { out.texts.push(String(node)); return out }
  if (Array.isArray(node)) { node.forEach(child => collect(child, out)); return out }
  if (typeof node !== 'object' || node === null || !('props' in node)) return out
  const props = (node as StubElement).props
  if (typeof props.className === 'string') out.classes.push(props.className)
  for (const key of ['title', 'aria-label']) if (typeof props[key] === 'string') out.texts.push(props[key] as string)
  collect(props.children, out)
  return out
}

/** 「队友」组展开、选中某位队友时的完整属性。 */
function groupProps(): TeammatesGroupProps {
  return {
    expanded: true, onToggle: () => undefined, totalBots: fixtureOverview.bots.length,
    query: '', onQueryChange: () => undefined, view: 'main', selectedThread: 'bot-tanlu',
    bots: fixtureOverview.bots, archivedBots: [], archivedOpen: false, onToggleArchived: () => undefined,
    notice: null, onBeginDelete: () => undefined,
    onSelectBot: () => undefined, onNewBot: () => undefined, onOpenBotForm: () => undefined,
    onBotFormProjectChange: () => undefined, form: null, botFormProjects: [], formBot: null, formNode: null,
  }
}

describe('左栏「队友」组不再有团队全景', () => {
  it('正例：组里只有队友行，没有「团队全景」文字，也没有团队行的样式', () => {
    const tree = TeammatesGroup(groupProps())
    const { texts, classes } = collect(tree)
    expect(texts.join('')).not.toContain('团队全景')
    expect(texts.join('')).not.toContain('全队的汇报和提问')
    expect(classes.some(name => name.includes('ah-nav-team'))).toBe(false)
    // 每位队友各一行。
    const botRows = classes.filter(name => name.includes('ah-tree-bot'))
    expect(botRows).toHaveLength(fixtureOverview.bots.length)
  })

  it('反例：没有队友时也不会冒出团队全景，只给新建第一位的提示', () => {
    const { texts } = collect(TeammatesGroup({ ...groupProps(), bots: [], totalBots: 0 }))
    expect(texts.join('')).not.toContain('团队全景')
    expect(texts.join('')).toContain('这儿还没人')
  })
})

describe('默认落点是办公室', () => {
  it('刚打开、什么都没选：仓库停在办公室，中栏摆办公室，不摆对话', () => {
    const hub = createHubStore()
    expect(hub.getSnapshot()).toMatchObject({ view: 'office', selectedThread: '' })
    hub.update(prev => ({ ...prev, overview: fixtureOverview }))
    const tree = createHookHost().render(HubPage, { hub, clientCtx: null })
    expect(findElements(tree, OfficeReplayPage)).toHaveLength(1)
    expect(findElements(tree, ThreadPane)).toEqual([])
  })

  it('正在看的队友被删除：退回办公室，不是团队全景', () => {
    const hub = createHubStore()
    hub.update(prev => ({ ...prev, overview: fixtureOverview, view: 'main', selectedThread: 'bot-tanlu' }))
    const host = createHookHost()
    expect(findElements(host.render(HubPage, { hub, clientCtx: null }), ThreadPane)).toHaveLength(1)
    hub.update(exitMissingSelection)
    const tree = host.render(HubPage, { hub, clientCtx: null })
    expect(hub.getSnapshot()).toMatchObject({ view: 'office', selectedThread: '' })
    expect(findElements(tree, OfficeReplayPage)).toHaveLength(1)
    expect(findElements(tree, ThreadPane)).toEqual([])
  })

  it('反例：选了真实的队友照常进对话', () => {
    const hub = createHubStore()
    hub.update(prev => ({ ...prev, overview: fixtureOverview }))
    hub.selectThread('bot-tanlu')
    const pane = findElements(createHookHost().render(HubPage, { hub, clientCtx: null }), ThreadPane)[0]
    expect(pane?.props.threadId).toBe('bot-tanlu')
  })
})

describe('界面源码里没有通往团队线程的入口', () => {
  const clientDir = fileURLToPath(new URL('../src/client', import.meta.url))
  /** 递归读出 client 下全部 .ts/.tsx 源码。 */
  function sources(dir: string): Array<{ path: string; code: string }> {
    return readdirSync(dir).flatMap(name => {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) return sources(path)
      return /\.(ts|tsx)$/.test(name) ? [{ path, code: readFileSync(path, 'utf8') }] : []
    })
  }
  /** 去掉注释，只看真正会执行或显示的代码。 */
  function stripComments(code: string): string {
    return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1').replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  }

  it('没有「团队全景」字样，也没有把 team 当线程选中、刷新或发消息的写法', () => {
    for (const { path, code } of sources(clientDir)) {
      const live = stripComments(code)
      expect(live, path).not.toContain('团队全景')
      expect(live, path).not.toMatch(/selectThread\(\s*'team'\s*\)|onSelectBot\(\s*'team'\s*\)|onSelect\(\s*'team'\s*\)/)
      expect(live, path).not.toMatch(/refreshThread\(\s*'team'|threadId:\s*'team'|=== 'team' \? teamUnread/)
    }
  })
})

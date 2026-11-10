/**
 * 左栏收起崩溃的回归测试（P53）。
 *
 * 事故：team-sidebar-nav 的收起分支提前 return，排在两个 useEffect 前面。
 * 展开时比收起时多跑两个 hook，把窗口缩窄的瞬间 React 报 #300（渲染的 hook 比预期少），
 * 整个左栏变成「这块没显示出来，刷新试试」，而且要刷新页面才能恢复。
 *
 * 这个文件防两层：
 * 1. 在同一次挂载上来回切换 compact，确认不崩，并确认尺寸监听跟着重新挂上；
 * 2. 用语法树扫全部界面代码，「提前 return 之后还调用 hook」的写法一处都不许有。
 *    依赖里没有 eslint-plugin-react-hooks，而且项目约定不联网装新依赖，所以这里只查这一类问题。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, relative } from 'node:path'
import { useEffect, useState } from 'react'
import ts from 'typescript'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fixtureOverview } from '../src/shared/fixtures.js'
import { TeamSidebarNav, type TeamSidebarNavProps } from '../src/client/components/team-sidebar-nav.js'
import { CompactRail } from '../src/client/components/sidebar-nav-rail.js'
import { TeammatesGroup } from '../src/client/components/sidebar-teammates-group.js'
import { createHookHost } from './helpers/hook-host.js'
import { findElements, type StubElement } from './helpers/jsx-runtime-stub.js'

// 把 react 换成 hook 宿主的替身；组件文件里的 useState、useEffect 都会走到这里。
vi.mock('react', async () => (await import('./helpers/hook-host.js')).reactFacade)

/** 记录每个 ResizeObserver 的去向：是否断开、盯着哪些元素。 */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = []
  targets: unknown[] = []
  disconnected = false
  constructor() { FakeResizeObserver.instances.push(this) }
  observe(target: unknown): void { this.targets.push(target) }
  disconnect(): void { this.disconnected = true }
}

/** 还在工作的监听：没有断开的那些。 */
function liveObservers(): FakeResizeObserver[] {
  return FakeResizeObserver.instances.filter(observer => !observer.disconnected)
}

function navProps(compact: boolean): TeamSidebarNavProps {
  return {
    overview: fixtureOverview,
    project: null,
    view: 'main',
    selectedThread: 'team',
    compact,
    onOpenOffice: () => undefined,
    onSelectBot: () => undefined,
    onOpenInbox: () => undefined,
    onOpenSettings: () => undefined,
    onNewBot: () => undefined,
    onOpenProject: () => undefined,
    onOpenTopic: () => undefined,
  }
}

describe('左栏展开与收起来回切换', () => {
  beforeEach(() => {
    FakeResizeObserver.instances = []
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('展开变收起再变展开：同一次挂载不崩，收起时只画图标列', () => {
    const host = createHookHost()
    const expanded = host.render(TeamSidebarNav, navProps(false)) as StubElement
    expect(expanded.type).toBe('nav')
    const compact = host.render(TeamSidebarNav, navProps(true)) as StubElement
    expect(compact.type).toBe(CompactRail)
    const expandedAgain = host.render(TeamSidebarNav, navProps(false)) as StubElement
    expect(expandedAgain.type).toBe('nav')
  })

  it('一打开就是收起态，再展开：反方向也不崩（React #310）', () => {
    const host = createHookHost()
    expect((host.render(TeamSidebarNav, navProps(true)) as StubElement).type).toBe(CompactRail)
    expect((host.render(TeamSidebarNav, navProps(false)) as StubElement).type).toBe('nav')
  })

  it('尺寸监听跟着切换：收起时断开，展开时盯住新的滚动区', () => {
    const host = createHookHost()
    host.render(TeamSidebarNav, navProps(false))
    // 展开态盯两个容器：外层滚动区和工作区内层列表。
    expect(liveObservers()).toHaveLength(1)
    expect(liveObservers()[0]?.targets).toHaveLength(2)

    host.render(TeamSidebarNav, navProps(true))
    // 收起后这两个元素已经卸载，继续盯着只会泄漏。
    expect(liveObservers()).toHaveLength(0)

    host.render(TeamSidebarNav, navProps(false))
    // 重新展开是全新的 DOM：必须新建监听。否则窗口再怎么变，滚动提示都不会更新。
    expect(FakeResizeObserver.instances).toHaveLength(2)
    expect(liveObservers()).toHaveLength(1)
    expect(liveObservers()[0]?.targets).toHaveLength(2)
  })
})

describe('收起态图标列不吃展开态的搜索过滤（U01 第 46 轮，P53 遗留）', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('展开态搜过名字再收起：rail 仍列全部在岗队友；搜无命中词也不会清空 rail', () => {
    const host = createHookHost()
    const allIds = fixtureOverview.bots.filter(bot => bot.archived !== true).map(bot => bot.id)
    expect(allIds).toEqual(['bot-xunjian', 'bot-tanlu', 'bot-zongguan'])

    // 先展开，在队友组搜索框里输入只命中一个人的词。
    let tree = host.render(TeamSidebarNav, navProps(false)) as StubElement
    const group = findElements(tree, TeammatesGroup)[0]
    expect(group).toBeDefined()
    ;(group!.props.onQueryChange as (query: string) => void)('巡检员')

    // 再渲染一次展开态：先确认过滤真的生效（只剩巡检员），
    // 否则下面 rail 仍是全员也可能是状态没改造成的假通过。
    tree = host.render(TeamSidebarNav, navProps(false)) as StubElement
    const filteredGroup = findElements(tree, TeammatesGroup)[0]!
    expect((filteredGroup.props.bots as Array<{ id: string }>).map(bot => bot.id)).toEqual(['bot-xunjian'])

    // 收起：rail 必须无视残留搜索词，列出全部在岗队友（旧实现这里只剩巡检员）。
    let rail = host.render(TeamSidebarNav, navProps(true)) as StubElement
    expect(rail.type).toBe(CompactRail)
    expect((rail.props.bots as Array<{ id: string }>).map(bot => bot.id)).toEqual(allIds)

    // 换成无命中词再收起：旧实现 rail 会一个人都不剩，且收起态无处清除搜索。
    tree = host.render(TeamSidebarNav, navProps(false)) as StubElement
    const groupAgain = findElements(tree, TeammatesGroup)[0]!
    ;(groupAgain.props.onQueryChange as (query: string) => void)('查无此人的关键词')
    rail = host.render(TeamSidebarNav, navProps(true)) as StubElement
    expect((rail.props.bots as Array<{ id: string }>).map(bot => bot.id)).toEqual(allIds)
  })
})

describe('hook 宿主自身能抓到这类错误（防止上面的测试永远通过）', () => {
  /** 故意写错的组件：和事故一样，提前 return 排在 useEffect 前面。 */
  function BrokenNav(props: { compact: boolean }): null {
    useState(0)
    if (props.compact) return null
    useEffect(() => undefined)
    return null
  }

  it('展开变收起：抓到 hook 变少', () => {
    const host = createHookHost()
    host.render(BrokenNav, { compact: false })
    expect(() => host.render(BrokenNav, { compact: true })).toThrow(/fewer hooks/)
  })

  it('收起变展开：抓到 hook 变多', () => {
    const host = createHookHost()
    host.render(BrokenNav, { compact: true })
    expect(() => host.render(BrokenNav, { compact: false })).toThrow(/more hooks/)
  })
})

/** 函数类节点：扫描时每个函数单独算，内层回调里的 return 不影响外层。 */
function isFunctionLike(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)
    || ts.isMethodDeclaration(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node) || ts.isConstructorDeclaration(node)
}

/** 取 hook 名字：useState 或 React.useState 这两种写法；不是 hook 返回 null。 */
function hookName(node: ts.CallExpression): string | null {
  const callee = node.expression
  const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : ''
  return /^use[A-Z0-9]/.test(name) ? name : null
}

/** 这些语法结构里的代码不是每次渲染都会执行，写在里面的 hook 次数就不稳定。 */
function isBranching(node: ts.Node): boolean {
  if (ts.isBinaryExpression(node)) {
    const operator = node.operatorToken.kind
    return operator === ts.SyntaxKind.AmpersandAmpersandToken
      || operator === ts.SyntaxKind.BarBarToken
      || operator === ts.SyntaxKind.QuestionQuestionToken
  }
  return ts.isIfStatement(node) || ts.isConditionalExpression(node) || ts.isSwitchStatement(node) || ts.isTryStatement(node)
    || ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node)
}

/**
 * 找出一段源码里 hook 次数可能不稳定的位置：
 * 条件 return 之后的 hook（这次事故），以及写在 if、循环、三目里的 hook。
 * 返回中文描述，测试失败时主人能直接看懂是哪个文件哪一行。
 */
function findHookOrderViolations(code: string, fileName: string): string[] {
  const source = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const lineOf = (node: ts.Node): number => source.getLineAndCharacterOfPosition(node.getStart()).line + 1
  const violations: string[] = []

  const checkFunction = (fn: ts.FunctionLikeDeclaration): void => {
    if (fn.body === undefined || !ts.isBlock(fn.body)) return
    let earlyReturnLine: number | null = null
    // depth 是当前所在的分支层数；0 表示这一行每次渲染都一定会走到。
    const walk = (node: ts.Node, depth: number): void => {
      if (isFunctionLike(node)) return
      if (ts.isCallExpression(node)) {
        const name = hookName(node)
        if (name !== null && earlyReturnLine !== null) {
          violations.push(`${fileName}:${lineOf(node)} 的 ${name} 排在第 ${earlyReturnLine} 行的提前 return 之后`)
        } else if (name !== null && depth > 0) {
          violations.push(`${fileName}:${lineOf(node)} 的 ${name} 写在了条件或循环里`)
        }
      }
      if (ts.isReturnStatement(node) && depth > 0 && earlyReturnLine === null) earlyReturnLine = lineOf(node)
      const nextDepth = depth + (isBranching(node) ? 1 : 0)
      ts.forEachChild(node, child => walk(child, nextDepth))
    }
    fn.body.statements.forEach(statement => walk(statement, 0))
  }

  const visit = (node: ts.Node): void => {
    if (isFunctionLike(node)) checkFunction(node)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return violations
}

/** 列出界面目录下全部 ts/tsx 源文件（不含类型声明）。 */
function listClientSources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return listClientSources(path)
    return /\.tsx?$/.test(name) && !name.endsWith('.d.ts') ? [path] : []
  })
}

describe('界面代码的 hook 顺序纪律', () => {
  it('全部界面代码：没有排在提前 return 之后、或写在分支里的 hook', () => {
    const clientDir = fileURLToPath(new URL('../src/client', import.meta.url))
    const files = listClientSources(clientDir)
    // 文件数做个下限：目录搬家导致一个文件都没扫到时，这条不能悄悄通过。
    expect(files.length).toBeGreaterThan(50)
    const violations = files.flatMap(file => findHookOrderViolations(readFileSync(file, 'utf8'), relative(clientDir, file)))
    expect(violations).toEqual([])
  })

  it('反例：提前 return 之后的 useEffect 会被抓到', () => {
    const code = `function Nav(props) {
      const [a] = useState(0)
      if (props.compact) { return null }
      useEffect(() => {})
      return null
    }`
    expect(findHookOrderViolations(code, 'demo.tsx')).toEqual(['demo.tsx:4 的 useEffect 排在第 3 行的提前 return 之后'])
  })

  it('反例：写在条件里的 hook 会被抓到', () => {
    const code = `function Nav(props) {
      if (props.compact) { useEffect(() => {}) }
      return null
    }`
    expect(findHookOrderViolations(code, 'demo.tsx')).toEqual(['demo.tsx:2 的 useEffect 写在了条件或循环里'])
  })

  it('正例：hook 都排在分支前面，回调里的 return 也不算提前返回', () => {
    const code = `function Nav(props) {
      const [a] = useState(0)
      useEffect(() => {
        if (a === 0) return
        run()
      }, [a])
      if (props.compact) return <Rail />
      return <Full />
    }`
    expect(findHookOrderViolations(code, 'demo.tsx')).toEqual([])
  })
})

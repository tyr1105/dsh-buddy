/**
 * P75k：「关于你的记忆」一页（任务卡第 4、5 节，第 12 节第 2、3 条）。
 * 页面视图取自 shared/fixture-memory.ts（core 的 memoryPage 生成）。覆盖：
 * - 类型筛选的数量；
 * - 更正：输入框失去焦点、按 Tab 不提交，点「保存」才提交；空内容与超长时「保存」不可点并说明原因；Esc 等同取消；
 * - 删除：直接调用命令（不弹确认），之后页面顶部出现「已删除」一行与「撤销」；
 * - 固定规则没有操作；项目背景与项目页决策显示「去项目页」，点后打开对应项目页；
 * - 约定卡的出处：带 memoryId 时是按钮，点后打开记忆页并定位到那一条（高亮 2 秒，焦点移过去）；没有时是文字；
 * - 仓库：requestMemory、clearMemoryFocus、memory 范围的刷新计划；上限与 core 的值一致。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryEntry, type MemoryEntryCommands } from '../src/client/components/MemoryEntry.js'
import { AgreementCard } from '../src/client/components/AgreementCard.js'
import { DeletedRow, MemoryPage } from '../src/client/pages/MemoryPage.js'
import { createHubStore } from '../src/client/hub-state.js'
import { refreshPlan } from '../src/client/logic/scopes.js'
import { MEMORY_TEXT_LIMIT, editProblemOf, entryActionsOf, groupsForTab, hasMemoryEntry, memoryEntryDomId } from '../src/client/logic/memory.js'
import { sampleB2Card } from '../src/shared/fixture-job.js'
import { createMemorySample, sampleMemoryPage, SAMPLE_MEMORY_IDS } from '../src/shared/fixture-memory.js'
import type { AgreementCardView, MemoryEntryView, MemoryPageView } from '../src/shared/views.js'
import { MEMORY_DEFAULTS } from '@agent-hub/core'
import { createHookHost } from './helpers/hook-host.js'
import { findElements, type StubElement } from './helpers/jsx-runtime-stub.js'

vi.mock('react', async () => (await import('./helpers/hook-host.js')).reactFacade)
afterEach(() => { vi.useRealTimers() })

function textOf(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object' && node !== null && 'props' in node) return textOf((node as StubElement).props.children)
  return ''
}
const flush = async (): Promise<void> => { for (let i = 0; i < 5; i++) await Promise.resolve() }

const page = sampleMemoryPage()
const entryById = (id: string): MemoryEntryView => page.groups.flatMap(group => group.entries).find(entry => entry.memoryId === id)!
const fixedRule = page.groups.find(group => group.key === 'rule')!.entries.find(entry => entry.memoryId === null)!
const backgroundEntry = page.groups.find(group => group.key === 'background')!.entries[0]!
const decisionEntry = page.groups.find(group => group.key === 'precedent')!.entries.find(entry => entry.link !== null)!

function commands(overrides: Partial<MemoryEntryCommands> = {}): MemoryEntryCommands {
  return { correct: async () => null, remove: async () => null, openProject: () => undefined, ...overrides }
}
const pageCommands = (overrides: Partial<MemoryEntryCommands & { undoDelete: (id: string) => Promise<string | null> }> = {}) =>
  ({ ...commands(), undoDelete: async () => null, ...overrides })
const buttonsOf = (tree: unknown): StubElement[] => findElements(tree, 'button')
const buttonText = (tree: unknown, label: string): StubElement => buttonsOf(tree).find(button => textOf(button) === label)!

describe('类型筛选与分组', () => {
  it('筛选按钮的数量来自 core：全部 13、偏好 3、规矩 6、决定和先例 2、项目背景 2；点一类只剩这一组', () => {
    const host = createHookHost()
    const view = (): unknown => host.render(MemoryPage, { page, error: null, onRetry: () => undefined, focusMemoryId: null, onFocusDone: () => undefined, commands: pageCommands() })
    const tabs = buttonsOf(view()).filter(button => button.props['aria-pressed'] !== undefined).map(button => textOf(button))
    expect(tabs).toEqual(['全部　13', '偏好　3', '规矩　6', '决定和先例　2', '项目背景　2'])
    expect(findElements(view(), MemoryEntry)).toHaveLength(13)
    ;(buttonsOf(view()).find(button => textOf(button) === '偏好　3')!.props.onClick as () => void)()
    expect(findElements(view(), MemoryEntry)).toHaveLength(3)
    ;(buttonsOf(view()).find(button => textOf(button) === '规矩　6')!.props.onClick as () => void)()
    expect(findElements(view(), MemoryEntry)).toHaveLength(6)
  })

  it('页面标题与说明一句原样来自 core；groupsForTab 与 hasMemoryEntry 的判断', () => {
    const tree = createHookHost().render(MemoryPage, { page, error: null, onRetry: () => undefined, focusMemoryId: null, onFocusDone: () => undefined, commands: pageCommands() })
    expect(textOf(tree)).toContain('关于你的记忆')
    expect(textOf(tree)).toContain(page.intro)
    expect(groupsForTab(page, 'background').map(group => group.key)).toEqual(['background'])
    expect(groupsForTab(page, 'all').map(group => group.key)).toEqual(['rule', 'precedent', 'preference', 'background'])
    expect(hasMemoryEntry(page, SAMPLE_MEMORY_IDS.rulePlease)).toBe(true)
    expect(hasMemoryEntry(page, 'mem_nothere001')).toBe(false)
  })

  it('读不到时在页内给原因与「重试」；还没取到时是骨架；一条都没有时是空态', () => {
    const failed = createHookHost().render(MemoryPage, { page: null, error: '连接中断', onRetry: () => undefined, focusMemoryId: null, onFocusDone: () => undefined, commands: pageCommands() })
    expect(JSON.stringify(failed)).toContain('记忆读取失败：连接中断。点击「重试」；仍失败请检查 DSH 运行状态。')
    const empty: MemoryPageView = { ...page, total: 0, tabs: page.tabs.map(tab => ({ ...tab, count: 0 })), groups: page.groups.map(group => ({ ...group, entries: [] })), deleted: [] }
    const emptyTree = createHookHost().render(MemoryPage, { page: empty, error: null, onRetry: () => undefined, focusMemoryId: null, onFocusDone: () => undefined, commands: pageCommands() })
    expect(JSON.stringify(emptyTree)).toContain('暂无记忆。你说过以后都照做的话、定下的约定，会记在这里。')
  })
})

describe('更正：只在点「保存」时提交', () => {
  const entry = entryById(SAMPLE_MEMORY_IDS.prefShort)

  it('点「更正」后正文变输入框；输入框没有失去焦点处理器，Tab、失去焦点都不提交', async () => {
    const correct = vi.fn(async () => null)
    const host = createHookHost()
    const view = (): unknown => host.render(MemoryEntry, { entry, commands: commands({ correct }), focused: false })
    ;(buttonsOf(view()).find(button => textOf(button) === '更正')!.props.onClick as () => void)()
    const input = findElements(view(), 'input')[0]!
    expect(input.props.value).toBe(entry.text)
    expect(input.props.onBlur).toBeUndefined()
    // 改字、按 Tab 键：都不提交。
    ;(input.props.onChange as (event: unknown) => void)({ target: { value: '汇报控制在两句话以内。' } })
    ;(findElements(view(), 'input')[0]!.props.onKeyDown as (event: unknown) => void)({ key: 'Tab', preventDefault: () => undefined, stopPropagation: () => undefined })
    await flush()
    expect(correct).not.toHaveBeenCalled()
    // 只有点「保存」才提交，参数是记忆编号与新文字。
    ;(buttonText(view(), '保存').props.onClick as () => void)()
    await flush()
    expect(correct).toHaveBeenCalledTimes(1)
    expect(correct).toHaveBeenCalledWith(SAMPLE_MEMORY_IDS.prefShort, '汇报控制在两句话以内。')
    // 保存成功后退出编辑态，回到「更正」「删除」。
    expect(findElements(view(), 'input')).toHaveLength(0)
    expect(textOf(view())).toContain('更正')
  })

  it('内容为空或超过上限时「保存」不可点，并写明原因；恢复合法后可点', () => {
    const host = createHookHost()
    const view = (): unknown => host.render(MemoryEntry, { entry, commands: commands(), focused: false })
    ;(buttonsOf(view()).find(button => textOf(button) === '更正')!.props.onClick as () => void)()
    const change = (value: string): void => { (findElements(view(), 'input')[0]!.props.onChange as (event: unknown) => void)({ target: { value } }) }
    change('   ')
    expect(buttonText(view(), '保存').props.disabled).toBe(true)
    expect(textOf(view())).toContain('内容不能为空。')
    change('字'.repeat(MEMORY_TEXT_LIMIT + 1))
    expect(buttonText(view(), '保存').props.disabled).toBe(true)
    expect(textOf(view())).toContain(`最多 ${MEMORY_TEXT_LIMIT} 字，现在 ${MEMORY_TEXT_LIMIT + 1} 字。`)
    change('字'.repeat(MEMORY_TEXT_LIMIT))
    expect(buttonText(view(), '保存').props.disabled).toBe(false)
    // 提示一句始终在。
    expect(textOf(view())).toContain('保存后，从下一次开始照新说法做。')
  })

  it('不合法时即使强行调用保存也不提交；取消与 Esc 退出编辑且不提交；失败时显示原因、输入保留', async () => {
    const correct = vi.fn(async () => '只能更正生效中的记忆')
    const host = createHookHost()
    const view = (): unknown => host.render(MemoryEntry, { entry, commands: commands({ correct }), focused: false })
    ;(buttonsOf(view()).find(button => textOf(button) === '更正')!.props.onClick as () => void)()
    ;(findElements(view(), 'input')[0]!.props.onChange as (event: unknown) => void)({ target: { value: '' } })
    ;(buttonText(view(), '保存').props.onClick as () => void)()
    await flush()
    expect(correct).not.toHaveBeenCalled()
    // 合法内容但 core 拒绝：显示原因，仍在编辑态，输入保留。
    ;(findElements(view(), 'input')[0]!.props.onChange as (event: unknown) => void)({ target: { value: '新的说法' } })
    ;(buttonText(view(), '保存').props.onClick as () => void)()
    await flush()
    expect(textOf(view())).toContain('只能更正生效中的记忆')
    expect(findElements(view(), 'input')[0]!.props.value).toBe('新的说法')
    // Esc 等同取消。
    ;(findElements(view(), 'input')[0]!.props.onKeyDown as (event: unknown) => void)({ key: 'Escape', preventDefault: () => undefined, stopPropagation: () => undefined })
    expect(findElements(view(), 'input')).toHaveLength(0)
    expect(correct).toHaveBeenCalledTimes(1)
  })

  it('editProblemOf 的边界：恰好上限不报错；上限与 core 的 TEXT_MAX_CHARS 一致', () => {
    expect(MEMORY_TEXT_LIMIT).toBe(MEMORY_DEFAULTS.TEXT_MAX_CHARS)
    expect(editProblemOf('字'.repeat(MEMORY_TEXT_LIMIT))).toBeNull()
    expect(editProblemOf('字'.repeat(MEMORY_TEXT_LIMIT + 1))).not.toBeNull()
    expect(editProblemOf('')).toBe('内容不能为空。')
  })
})

describe('删除、固定规则、项目页', () => {
  it('点「删除」直接调用命令（不弹确认），参数是记忆编号', async () => {
    const remove = vi.fn(async () => null)
    const host = createHookHost()
    const entry = entryById(SAMPLE_MEMORY_IDS.prefTime)
    const view = (): unknown => host.render(MemoryEntry, { entry, commands: commands({ remove }), focused: false })
    ;(buttonsOf(view()).find(button => textOf(button) === '删除')!.props.onClick as () => void)()
    await flush()
    expect(remove).toHaveBeenCalledWith(SAMPLE_MEMORY_IDS.prefTime)
    // 全客户端没有确认弹窗介入：页面里没有 confirm 相关节点。
    expect(JSON.stringify(view())).not.toContain('确认删除')
  })

  it('真实路径：删除之后 core 的页面视图顶部有「已删除」一行，点「撤销」后回到列表（命令走宿主路由）', async () => {
    const { dispatchCommand } = await import('../src/host/real-hub.js')
    const world = createMemorySample()
    const before = world.api.memoryPage()
    expect(before.deleted.map(row => row.memoryId)).toEqual([SAMPLE_MEMORY_IDS.deleted])
    expect((await dispatchCommand(world.api, 'deleteMemory', { memoryId: SAMPLE_MEMORY_IDS.prefTime })).ok).toBe(true)
    const after = world.api.memoryPage()
    expect(after.deleted.map(row => row.text)).toContain('已删除「时间一律写成月日加时分」。')
    expect(after.total).toBe(before.total - 1)
    // 页面顶部的一行：文字原样来自 core，带「撤销」按钮，点后调用撤销删除。
    const undoDelete = vi.fn(async () => null)
    const tree = createHookHost().render(MemoryPage, { page: after, error: null, onRetry: () => undefined, focusMemoryId: null, onFocusDone: () => undefined, commands: pageCommands({ undoDelete }) })
    const deletedList = findElements(tree, 'ul').find(list => list.props['aria-label'] === '已删除，可撤销')!
    const rows = (Array.isArray(deletedList.props.children) ? deletedList.props.children : [deletedList.props.children]) as StubElement[]
    expect(rows.map(row => (row.props.row as { text: string }).text)).toEqual(['已删除「时间一律写成月日加时分」。', '已删除「回复里加表情」。'])
    // 每一行是 DeletedRow：文字原样来自 core，点「撤销」调用撤销删除（参数是记忆编号）。
    const rowTree = createHookHost().render(DeletedRow, { row: after.deleted[0]!, onUndo: undoDelete })
    expect(textOf(rowTree)).toContain('已删除「时间一律写成月日加时分」。')
    ;(buttonsOf(rowTree)[0]!.props.onClick as () => void)()
    await flush()
    expect(undoDelete).toHaveBeenCalledWith(SAMPLE_MEMORY_IDS.prefTime)
    expect((await dispatchCommand(world.api, 'undoDeleteMemory', { memoryId: SAMPLE_MEMORY_IDS.prefTime })).ok).toBe(true)
    expect(world.api.memoryPage().total).toBe(before.total)
  })

  it('固定规则：没有「更正」「删除」，显示 core 给的「不能更正或删除」（出处一行已写「产品固定规则」）', () => {
    expect(entryActionsOf(fixedRule)).toEqual({ correct: false, remove: false })
    const tree = createHookHost().render(MemoryEntry, { entry: fixedRule, commands: commands(), focused: false })
    expect(buttonsOf(tree)).toHaveLength(0)
    expect(textOf(tree)).toContain('不能更正或删除')
    expect(textOf(tree)).not.toContain('产品固定规则，不能更正或删除')
  })

  it('项目背景与项目页决策：不显示更正、删除，显示「在项目页里修改」与「去项目页」；点后打开对应项目页', () => {
    const openProject = vi.fn()
    for (const entry of [backgroundEntry, decisionEntry]) {
      const tree = createHookHost().render(MemoryEntry, { entry, commands: commands({ openProject }), focused: false })
      expect(textOf(tree)).toContain('在项目页里修改')
      expect(buttonsOf(tree).map(button => textOf(button))).toEqual(['去项目页'])
      ;(buttonText(tree, '去项目页').props.onClick as () => void)()
      expect(openProject).toHaveBeenLastCalledWith(entry.link!.projectId)
    }
    expect(openProject).toHaveBeenCalledTimes(2)
  })

  it('出处、原话、范围、被引用、原为：全部是 core 给的句子，界面原样显示', () => {
    const rule = entryById(SAMPLE_MEMORY_IDS.rulePlease)
    const text = textOf(createHookHost().render(MemoryEntry, { entry: rule, commands: commands(), focused: false }))
    for (const line of [rule.sourceLine, rule.quoteLine!, rule.scopeLine!, rule.citedText!]) expect(text).toContain(line)
    const corrected = entryById(SAMPLE_MEMORY_IDS.ruleConclusion)
    expect(textOf(createHookHost().render(MemoryEntry, { entry: corrected, commands: commands(), focused: false }))).toContain(corrected.historyNote!)
  })
})

describe('从约定卡的出处跳到这一条', () => {
  it('带 memoryId 的已定事项出处是按钮（点后打开记忆页并带上编号）；没有 memoryId 或没有接线时是文字', () => {
    const open = vi.fn()
    const card: AgreementCardView = {
      ...sampleB2Card!, decided: [
        { text: '提示文字按你的规矩写。', basisLabel: '你的规矩（11月18日）', changed: false, memoryId: SAMPLE_MEMORY_IDS.rulePlease },
        { text: '同一手机号只保留最后一次。', basisLabel: '你定的约定', changed: false },
      ],
    }
    const tree = createHookHost().render(AgreementCard, { card, onOpenMemory: open, readOnly: true, startExpanded: true })
    const linkButtons = findElements(tree, 'button').filter(button => String(button.props.className).includes('ah-agr-basis-link'))
    expect(linkButtons).toHaveLength(1)
    expect(textOf(linkButtons[0])).toBe('你的规矩（11月18日）')
    expect(linkButtons[0]!.props['aria-label']).toBe('在「关于你的记忆」里查看：你的规矩（11月18日）')
    ;(linkButtons[0]!.props.onClick as () => void)()
    expect(open).toHaveBeenCalledWith(SAMPLE_MEMORY_IDS.rulePlease)
    // 没有 memoryId 的那一项是文字；没有接线时两项都是文字。
    const spans = findElements(tree, 'span').filter(span => span.props.className === 'ah-agr-basis')
    expect(spans.map(span => textOf(span))).toEqual(['你定的约定'])
    const noWire = createHookHost().render(AgreementCard, { card, readOnly: true, startExpanded: true })
    expect(findElements(noWire, 'button').filter(button => String(button.props.className).includes('ah-agr-basis-link'))).toHaveLength(0)
  })

  it('定位：页面加载出那一条后切到「全部」、高亮那一条、通知上层清掉请求；找不到时静默放弃', () => {
    vi.useFakeTimers()
    const done = vi.fn()
    const host = createHookHost()
    const view = (id: string | null): unknown => host.render(MemoryPage, { page, error: null, onRetry: () => undefined, focusMemoryId: id, onFocusDone: done, commands: pageCommands() })
    const tree = view(SAMPLE_MEMORY_IDS.rulePlease)
    expect(done).toHaveBeenCalledTimes(1)
    const focused = findElements(view(null), MemoryEntry).filter(row => row.props.focused === true)
    expect(focused.map(row => (row.props.entry as MemoryEntryView).memoryId)).toEqual([SAMPLE_MEMORY_IDS.rulePlease])
    expect(tree).toBeDefined()
    // 条目元素的编号可被定位与聚焦（MemoryEntry 的 li 带稳定编号和 tabIndex，高亮时带高亮样式类）。
    const li = createHookHost().render(MemoryEntry, { entry: entryById(SAMPLE_MEMORY_IDS.rulePlease), commands: commands(), focused: true }) as StubElement
    expect(memoryEntryDomId(SAMPLE_MEMORY_IDS.rulePlease)).toBe('ah-memory-mem_samplerul1')
    expect(li.props.id).toBe('ah-memory-mem_samplerul1')
    expect(li.props.tabIndex).toBe(-1)
    expect(String(li.props.className)).toContain('ah-memory-entry-focus')
    // 找不到这一条：不报错，只通知上层清掉请求。
    const other = vi.fn()
    createHookHost().render(MemoryPage, { page, error: null, onRetry: () => undefined, focusMemoryId: 'mem_nothere001', onFocusDone: other, commands: pageCommands() })
    expect(other).toHaveBeenCalledTimes(1)
  })

  it('高亮 2 秒后撤掉；减少动态效果时只有边框（样式表规则）', async () => {
    vi.useFakeTimers()
    const host = createHookHost()
    const view = (): unknown => host.render(MemoryPage, { page, error: null, onRetry: () => undefined, focusMemoryId: SAMPLE_MEMORY_IDS.prefScreenshot, onFocusDone: () => undefined, commands: pageCommands() })
    view()
    const focusedCount = (): number => findElements(view(), MemoryEntry).filter(row => row.props.focused === true).length
    expect(focusedCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(2000)
    expect(focusedCount()).toBe(0)
    const { readFileSync } = await import('node:fs')
    const css = readFileSync(new URL('../src/client/workspace.css', import.meta.url), 'utf8')
    expect(css).toMatch(/\.ah-memory-entry-focus \{[^}]*border-color/)
    // 动画只在没有减少动态效果的偏好下才加；减少时明确关掉。
    expect(css).toMatch(/@media \(prefers-reduced-motion: no-preference\) \{\s*\.ah-memory-entry-focus \{ animation:/)
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.ah-memory-entry-focus \{ animation: none; \}/)
  })
})

describe('仓库：打开记忆页、记忆事件的刷新计划', () => {
  it('requestMemory：切到记忆页并记下要定位的那一条；clearMemoryFocus 清掉；入口不带编号时不定位', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(page), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    try {
      const hub = createHubStore()
      hub.requestMemory(SAMPLE_MEMORY_IDS.precedent)
      expect(hub.getSnapshot().view).toBe('memory')
      expect(hub.getSnapshot().memoryFocusId).toBe(SAMPLE_MEMORY_IDS.precedent)
      await vi.waitFor(() => expect(hub.getSnapshot().memoryPage?.total).toBe(page.total))
      hub.clearMemoryFocus()
      expect(hub.getSnapshot().memoryFocusId).toBeNull()
      hub.requestMemory()
      expect(hub.getSnapshot().memoryFocusId).toBeNull()
    } finally { vi.unstubAllGlobals() }
  })

  it('记忆页读不到：原因记在 memoryError 里，不标整页断开；旧数据保留', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: '中心引擎启动失败' }), { status: 500, headers: { 'Content-Type': 'application/json' } }))
    try {
      const hub = createHubStore()
      await hub.refreshMemory()
      expect(hub.getSnapshot().memoryError).toBe('中心引擎启动失败')
      expect(hub.getSnapshot().connectionDown).toBe(false)
      expect(hub.getSnapshot().memoryPage).toBeNull()
    } finally { vi.unstubAllGlobals() }
  })

  it('memory 范围的刷新计划：刷总览（条数）与记忆页、当前线程；其余范围的计划里没有 memory 这一项', () => {
    expect(refreshPlan('memory', null)).toEqual({
      overview: true, bots: [], threads: [], ledgers: false, inbox: false, activity: false, settings: false, office: false, resource: false, project: false, memory: true,
    })
    for (const scope of ['overview', 'bot', 'thread', 'inbox', 'activity', 'settings', 'ledger', 'office', 'project', 'unknown']) {
      expect('memory' in refreshPlan(scope, null), scope).toBe(false)
    }
  })

})

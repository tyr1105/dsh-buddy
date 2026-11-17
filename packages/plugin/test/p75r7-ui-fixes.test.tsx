/**
 * P75r7：界面修复（B1 到 B13、C1）的单元测试。
 *
 * 覆盖：私聊欢迎语；删除与两种撤销之后的焦点落点（用 document.activeElement 断言）与「已删除」容器的 aria-live；
 * 定位时名称不被覆盖而是加一段读过即忘的说明；定位目标不存在时页顶的一行及其消失；历史版本行与回退按钮的名称；
 * 线程学习卡调用 chooseLearnSession、「待你处理」里的学习卡保留自由文本；技能详情的 Esc 只在焦点在 body 或侧栏内时生效；
 * 失败原因去掉英文键名（三种情形）；主题顶部约定面板的出处可点；办公室列表里评审员显示「评审」；
 * 活动流「技能库」样例行等于核心的输出。
 *
 * 为什么用假 document：测试环境没有 jsdom（插件运行时的 react 由宿主提供），组件只用到
 * getElementById、activeElement 与元素自身的 focus()；这里用最小的假实现记录焦点落点。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ThreadPane } from '../src/client/components/ThreadPane.js'
import { MemoryEntry } from '../src/client/components/MemoryEntry.js'
import { MemoryNoteRow } from '../src/client/components/MemoryNoteRow.js'
import { DeletedRow, MemoryPage } from '../src/client/pages/MemoryPage.js'
import { InboxCard } from '../src/client/components/Cards.js'
import { itemToCard } from '../src/client/components/InboxPane.js'
import { AgreementPanel } from '../src/client/components/AgreementPanel.js'
import { AgreementCard } from '../src/client/components/AgreementCard.js'
import { SeatCard } from '../src/client/pages/OfficePage.js'
import { cardSubmission } from '../src/client/logic/cards.js'
import { stripFailureKey } from '../src/client/logic/failure-text.js'
import { OBJECTION_TEXT, objectionOf } from '../src/client/logic/inbox-objection.js'
import { shouldCloseSkillDetailOnEscape, rollbackLabelOf, versionLineText } from '../src/client/logic/skill-library.js'
import { SAMPLE_SKILL_ACTIVITY_ROWS, fixtureSkillActivityRows } from '../src/shared/fixture-activity-skill.js'
import { sampleSkillActivityRows } from '../src/shared/fixture-skill.js'
import { sampleAgreementPanel } from '../src/shared/fixture-agreement.js'
import { fixtureInbox } from '../src/shared/fixtures.js'
import { fixtureOffice } from '../src/shared/fixture-office.js'
import { SAMPLE_MEMORY_IDS, sampleMemoryPage, sampleMemoryThread, SAMPLE_MEMORY_MESSAGE_IDS } from '../src/shared/fixture-memory.js'
import type { MemoryEntryView, ThreadView } from '../src/shared/views.js'
import { FixtureHub } from '../src/host/hub-facade.js'
import { createHookHost } from './helpers/hook-host.js'
import { findElements, type StubElement } from './helpers/jsx-runtime-stub.js'

vi.mock('react', async () => (await import('./helpers/hook-host.js')).reactFacade)
afterEach(() => { vi.unstubAllGlobals() })

function textOf(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object' && node !== null && 'props' in node) return textOf((node as StubElement).props.children)
  return ''
}
const flush = async (): Promise<void> => { for (let i = 0; i < 5; i++) await Promise.resolve() }
const buttonsOf = (tree: unknown): StubElement[] => findElements(tree, 'button')
const buttonText = (tree: unknown, label: string): StubElement | undefined => buttonsOf(tree).find(button => textOf(button) === label)

/** 假 document：按编号给出可聚焦元素，focus() 时把 activeElement 指到自己。 */
function stubFocusDocument(ids: string[]) {
  const elements = new Map(ids.map(id => {
    const element = { id, focus(): void { doc.activeElement = element } }
    return [id, element] as const
  }))
  const doc: { activeElement: unknown; body: object; getElementById: (id: string) => unknown; querySelector: () => unknown } = {
    activeElement: null, body: {}, getElementById: (id: string) => elements.get(id) ?? null, querySelector: () => null,
  }
  vi.stubGlobal('document', doc)
  return { doc, elements }
}

const page = sampleMemoryPage()
const entryOf = (id: string): MemoryEntryView => page.groups.flatMap(group => group.entries).find(entry => entry.memoryId === id)!
const pageCommands = (overrides: Record<string, unknown> = {}) =>
  ({ correct: async () => null, remove: async () => null, openProject: () => undefined, undoDelete: async () => null, ...overrides })

describe('B1 私聊欢迎语', () => {
  it('员工私聊没有消息时写新的欢迎语，不再提已经删掉的「教它一个技能」', () => {
    const thread = { threadId: 'bot-tanlu', title: '探路', messages: [], hasMore: false, oldestId: null } as unknown as ThreadView
    const tree = createHookHost().render(ThreadPane, {
      threadId: thread.threadId, thread, loading: false,
      header: { name: '探路', roleLabel: null, activityText: null, nextThinkText: null, staffStatus: null, thinking: false },
      inputPlaceholderName: '探路', banner: null, onBannerDismiss: () => undefined, onLoadEarlier: () => undefined,
      onSend: async () => undefined, actions: { onPick: async () => null }, busyInboxId: null, onRetry: () => undefined,
      error: null, onOpenSession: () => undefined, onTogglePause: () => undefined, onInterrupt: () => undefined,
    } as never)
    expect(textOf(tree)).toContain('说明目标和已知的线索。完成后会在这里汇报。')
    expect(textOf(tree)).not.toContain('教它一个技能')
  })
})

describe('B2 删除、撤销之后的焦点与播报', () => {
  it('删除成功：焦点移到顶部新出现的「已删除」行的「撤销」按钮；「已删除」容器带 aria-live', async () => {
    const target = SAMPLE_MEMORY_IDS.prefShort
    const { doc } = stubFocusDocument([`ah-memory-deleted-undo-${target}`])
    const host = createHookHost()
    const props = { page, error: null, onRetry: () => undefined, focusMemoryId: null, onFocusDone: () => undefined, commands: pageCommands() }
    const view = (): unknown => host.render(MemoryPage, props)
    const tree = view()
    expect(findElements(tree, 'div').some(row => row.props['aria-live'] === 'polite')).toBe(true)
    const entry = findElements(tree, MemoryEntry).find(row => (row.props.entry as MemoryEntryView).memoryId === target)!
    const commands = entry.props.commands as { remove: (id: string) => Promise<string | null> }
    await commands.remove(target)
    view()
    expect((doc.activeElement as { id?: string } | null)?.id).toBe(`ah-memory-deleted-undo-${target}`)
  })

  it('「已删除」行撤销成功：焦点移到恢复的那一条的「更正」按钮', async () => {
    const target = SAMPLE_MEMORY_IDS.deleted
    const { doc } = stubFocusDocument([`ah-memory-correct-${target}`])
    const host = createHookHost()
    const props = { page, error: null, onRetry: () => undefined, focusMemoryId: null, onFocusDone: () => undefined, commands: pageCommands() }
    const view = (): unknown => host.render(MemoryPage, props)
    const row = findElements(view(), DeletedRow)[0]!
    await (row.props.onUndo as (id: string) => Promise<string | null>)((row.props.row as { memoryId: string }).memoryId)
    view()
    expect((doc.activeElement as { id?: string } | null)?.id).toBe(`ah-memory-correct-${target}`)
  })

  it('「已记住」行撤销成功：焦点落回这一行本身（tabIndex=-1），不留在被卸掉的按钮上', async () => {
    const { doc } = stubFocusDocument([])
    const note = sampleMemoryThread().messages.find(row => row.id === SAMPLE_MEMORY_MESSAGE_IDS.ownerReply)!.memoryNotes![0]!
    const host = createHookHost()
    const view = (): unknown => host.render(MemoryNoteRow, { note, onUndo: async () => null })
    const tree = view()
    const root = findElements(tree, 'div').find(row => String(row.props.className).includes('ah-memory-note'))!
    expect(root.props.tabIndex).toBe(-1)
    // 这一行的根节点（ref 指向的假元素）就是撤销成功后应当拿到焦点的那一个。
    const rowElement = (root.props.ref as { current: unknown }).current
    ;(buttonsOf(tree)[0]!.props.onClick as () => void)()
    await flush()
    expect(doc.activeElement).not.toBeNull()
    expect(doc.activeElement).toBe(rowElement)
  })

  it('操作失败时焦点不动（没有设为焦点请求），错误照旧显示在这一条旁边', async () => {
    const { doc } = stubFocusDocument([`ah-memory-deleted-undo-${SAMPLE_MEMORY_IDS.prefShort}`])
    const host = createHookHost()
    const props = { page, error: null, onRetry: () => undefined, focusMemoryId: null, onFocusDone: () => undefined, commands: pageCommands({ remove: async () => '这一条记忆不存在' }) }
    const view = (): unknown => host.render(MemoryPage, props)
    const entry = findElements(view(), MemoryEntry).find(row => (row.props.entry as MemoryEntryView).memoryId === SAMPLE_MEMORY_IDS.prefShort)!
    await (entry.props.commands as { remove: (id: string) => Promise<string | null> }).remove(SAMPLE_MEMORY_IDS.prefShort)
    view()
    expect(doc.activeElement).toBeNull()
    // B10：命令失败的原因去掉英文键名之后再显示。
    const direct = createHookHost()
    const failed = (): unknown => direct.render(MemoryEntry, { entry: entryOf(SAMPLE_MEMORY_IDS.prefShort), commands: pageCommands({ remove: async () => 'memoryId：这一条记忆不存在' }), focused: false })
    ;(buttonText(failed(), '删除')!.props.onClick as () => void)()
    await flush()
    expect(textOf(failed())).toContain('这一条记忆不存在')
    expect(textOf(failed())).not.toContain('memoryId：')
  })
})

describe('B3 定位时的读屏名称', () => {
  it('不用 aria-label 覆盖这一条的名称，改用 aria-describedby 指向一段隐藏说明；不高亮时说明去掉', () => {
    const entry = entryOf(SAMPLE_MEMORY_IDS.rulePlease)
    const focused = createHookHost().render(MemoryEntry, { entry, commands: pageCommands(), focused: true })
    const li = findElements(focused, 'li')[0]!
    expect(li.props['aria-label']).toBeUndefined()
    expect(li.props['aria-describedby']).toBe(`ah-memory-hint-${SAMPLE_MEMORY_IDS.rulePlease}`)
    const hint = findElements(focused, 'span').find(row => row.props.id === `ah-memory-hint-${SAMPLE_MEMORY_IDS.rulePlease}`)!
    expect(textOf(hint)).toBe('从约定卡跳转到这一条')
    expect(String(hint.props.className)).toContain('ah-visually-hidden')
    const resting = createHookHost().render(MemoryEntry, { entry, commands: pageCommands(), focused: false })
    expect(findElements(resting, 'li')[0]!.props['aria-describedby']).toBeUndefined()
  })
})

describe('B4 定位目标不存在时的一行', () => {
  it('页顶出现「这一条记忆已删除或已被取代。」；下一次定位成功或切换筛选后消失', () => {
    const host = createHookHost()
    const props = { page, error: null, onRetry: () => undefined, focusMemoryId: 'mem_doesnotexist', onFocusDone: () => undefined, commands: pageCommands() }
    const view = (): unknown => host.render(MemoryPage, props)
    const tree = view()
    expect(textOf(tree)).toContain('这一条记忆已删除或已被取代。')
    const status = findElements(tree, 'div').find(row => row.props.role === 'status')!
    expect(status).toBeDefined()
    // 切换筛选：这一行消失。
    const tab = buttonsOf(tree).find(button => textOf(button) === '偏好　3')!
    ;(tab.props.onClick as () => void)()
    expect(textOf(view())).not.toContain('这一条记忆已删除或已被取代。')
  })
})

describe('B5 历史版本行与回退按钮', () => {
  it('版本行开头写「第 n 版」加全角空格；按钮的可达名称包含可见文字并注明版本', () => {
    expect(versionLineText(2, '11月17日　新增 2 句。评审员核对通过。')).toBe('第 2 版　11月17日　新增 2 句。评审员核对通过。')
    expect(rollbackLabelOf(2)).toBe('回退到这一版（第 2 版）')
  })
})

describe('B6、B7 学习选会话卡', () => {
  const inboxItem = fixtureInbox.items.find(item => item.learnRunId !== undefined)!
  it('线程里的学习卡走 chooseLearnSession；「待你处理」里的仍走 answerInbox（自由文本也只能走这条）', () => {
    const threadCard = { inboxId: 'i_thread', approvalId: null, type: 'question' as const, status: 'open' as const, title: '林舟要学的会话', body: '一句话。', options: ['名单整理（11月19日）'], defaultOption: null, answer: null, expiresAt: null, expiresText: null, learnRunId: 'sr_samplelearn' }
    expect(cardSubmission(threadCard, '名单整理（11月19日）')).toEqual({ name: 'chooseLearnSession', input: { runId: 'sr_samplelearn', option: '名单整理（11月19日）' } })
    const inboxCard = itemToCard(inboxItem)
    expect(inboxCard.learnRunId).toBe(inboxItem.learnRunId)
    expect(inboxCard.fromInbox).toBe(true)
    expect(cardSubmission(inboxCard, inboxItem.options[0]!)).toEqual({ name: 'answerInbox', input: { id: inboxItem.id, answer: inboxItem.options[0] } })
  })

  it('「待你处理」里的学习卡保留自由文本输入框；线程里的没有；学习条目上没有「要修改」这类次要按钮', () => {
    const withInput = createHookHost().render(InboxCard, { card: itemToCard(inboxItem), actions: { onPick: async () => null }, busy: false })
    expect(findElements(withInput, 'input')).toHaveLength(1)
    const threadCard = { ...itemToCard(inboxItem), fromInbox: undefined }
    const withoutInput = createHookHost().render(InboxCard, { card: threadCard, actions: { onPick: async () => null }, busy: false })
    expect(findElements(withoutInput, 'input')).toHaveLength(0)
    expect(objectionOf(inboxItem)).toBeNull()
    // 卡片上也不出现三种条目各自的次要按钮文字（要修改、有不符、都不合适）。
    const labels = buttonsOf(withInput).map(textOf)
    for (const spec of [OBJECTION_TEXT.agreement, OBJECTION_TEXT.accept, OBJECTION_TEXT.escalate]) {
      expect(labels).not.toContain(spec.buttonLabel)
    }
  })

  it('离线门面的样例收件箱里有这条学习条目（七条），条目带学习记录编号', async () => {
    const items = (await new FixtureHub().inbox()).items
    expect(items).toHaveLength(7)
    expect(items.find(item => item.id === inboxItem.id)?.learnRunId).toBe(inboxItem.learnRunId)
  })
})

describe('B9 技能详情的 Esc', () => {
  const body = { tag: 'body' }
  const inside = { tag: 'inside' }
  const outside = { tag: 'outside' }
  const panel = { contains: (node: object) => node === inside }
  it('只在焦点在 body（或没有元素持焦）或在侧栏之内时处理', () => {
    expect(shouldCloseSkillDetailOnEscape(body, body, panel as never)).toBe(true)
    expect(shouldCloseSkillDetailOnEscape(null, body, panel as never)).toBe(true)
    expect(shouldCloseSkillDetailOnEscape(inside, body, panel as never)).toBe(true)
    expect(shouldCloseSkillDetailOnEscape(outside, body, panel as never)).toBe(false)
    expect(shouldCloseSkillDetailOnEscape(outside, body, null)).toBe(false)
  })
})

describe('B10 给主人看的失败原因去掉英文键名', () => {
  it('有键名时去掉；没有键名时原样；中文开头带冒号（不是键名）时原样', () => {
    expect(stripFailureKey('memoryId：这一条记忆不存在')).toBe('这一条记忆不存在')
    expect(stripFailureKey('skillId：这条技能不存在')).toBe('这条技能不存在')
    expect(stripFailureKey('这一条记忆不存在')).toBe('这一条记忆不存在')
    expect(stripFailureKey('记忆：这一条不存在')).toBe('记忆：这一条不存在')
    expect(stripFailureKey('runId：找不到这次学习')).toBe('找不到这次学习')
  })
})

describe('B11 主题顶部约定面板的出处可点', () => {
  it('展开全文后，只读的约定卡也拿到 onOpenMemory（出处按钮据此可点）', () => {
    const current = sampleAgreementPanel.current
    const panel = { ...sampleAgreementPanel, current: { ...current, decided: [
      ...current.decided,
      { text: '汇报控制在三句话以内。', basisLabel: '出处：你的偏好（11月15日）', changed: false, memoryId: SAMPLE_MEMORY_IDS.prefShort },
    ] } }
    const opened: string[] = []
    const onOpenMemory = (id: string): void => { opened.push(id) }
    const host = createHookHost()
    const view = (): unknown => host.render(AgreementPanel, { panel, onOpenMemory })
    ;(buttonText(view(), '查看全文')!.props.onClick as () => void)()
    const card = findElements(view(), AgreementCard)[0]!
    expect(card.props.readOnly).toBe(true)
    expect(card.props.onOpenMemory).toBe(onOpenMemory)
    // 记忆编号确实在这些已定事项里（界面那边由 AgreementCard 画成按钮）。
    expect((card.props.card as { decided: Array<{ memoryId?: string }> }).decided.some(item => item.memoryId === SAMPLE_MEMORY_IDS.prefShort)).toBe(true)
  })
})

describe('B13 办公室列表里的角色标签', () => {
  it('评审员一行显示模板的「评审」，不写角色的「建议」', () => {
    const seat = fixtureOffice.seats[0]!
    const reviewer = { ...seat, occupant: { ...seat.occupant, name: '评审员', role: 'advisor' as const, roleLabel: '建议', templateLabel: '评审' } }
    const tree = createHookHost().render(SeatCard, { seat: reviewer, onOpenBot: () => undefined, onOpenInbox: () => undefined })
    const text = textOf(tree)
    expect(text).toContain('评审员')
    expect(text).toContain('评审')
    expect(text).not.toContain('建议')
  })
})

describe('C2 预览里的约定卡出处', () => {
  it('总管私聊样例里有一张已定事项带记忆出处的约定卡（由核心的约定卡视图生成）', () => {
    const message = sampleMemoryThread().messages.find(row => row.id === SAMPLE_MEMORY_MESSAGE_IDS.cardAgreement)!
    expect(message.agreement).not.toBeUndefined()
    const decided = message.agreement!.decided
    expect(decided.some(item => item.memoryId === SAMPLE_MEMORY_IDS.prefShort)).toBe(true)
    expect(decided.find(item => item.memoryId === SAMPLE_MEMORY_IDS.prefShort)!.basisLabel).toBe('出处：你的偏好（11月15日）')
  })
})

describe('C1 活动流「技能库」样例由核心生成', () => {
  it('冻结的样例行逐字等于核心的输出（整理一条、更新七条、回退一条）', () => {
    const live = sampleSkillActivityRows()
    expect(SAMPLE_SKILL_ACTIVITY_ROWS).toEqual(live)
    expect(SAMPLE_SKILL_ACTIVITY_ROWS).toHaveLength(9)
    expect(SAMPLE_SKILL_ACTIVITY_ROWS.filter(row => row.lines !== undefined)).toHaveLength(1)
    expect(SAMPLE_SKILL_ACTIVITY_ROWS.filter(row => row.text.startsWith('技能回退'))).toHaveLength(1)
  })

  it('拼接时只平移时间（句子原样），最新一行落在调用方 now 的 6 小时 15 分前', () => {
    const now = Date.parse('2026-11-19T10:00:00+08:00')
    const shifted = fixtureSkillActivityRows(now)
    const newest = Math.max(...shifted.map(row => row.at))
    expect(now - newest).toBe(6 * 60 * 60_000 + 15 * 60_000)
    expect(shifted.map(row => row.text)).toEqual(SAMPLE_SKILL_ACTIVITY_ROWS.map(row => row.text))
    // 时间文字按平移后的时刻重算，形态与 core 的 shortTime 相同（M月D日 HH:mm）。
    const rollback = shifted.find(row => row.id === 'au_sampleroll1')!
    expect(rollback.at).toBe(SAMPLE_SKILL_ACTIVITY_ROWS.find(row => row.id === 'au_sampleroll1')!.at + (now - Date.parse('2026-11-24T09:30:00+08:00')))
    expect(rollback.timeText).toMatch(/^\d+月\d+日 \d{2}:\d{2}$/)
  })
})

/**
 * P75k：总管回复下面的「已记住」「已删除」「已更正」一行与「撤销」（任务卡第 3 节、第 12 节第 1 条）。
 * 样例取自 shared/fixture-memory.ts（core 的 thread 视图生成，不手写视图字段）。
 * 覆盖：三种动作与已撤销状态的文字；点「撤销」调用对应命令且参数正确；失败时在这一行旁显示原因；
 * 总管私聊与主题线程两处都渲染；已撤销的行没有按钮；没有接线时只显示行不显示按钮。
 */
import { describe, expect, it, vi } from 'vitest'
import { MemoryNoteRow, MemoryNotes } from '../src/client/components/MemoryNoteRow.js'
import { TopicFloor } from '../src/client/components/TopicThreadBody.js'
import { ThreadPane } from '../src/client/components/ThreadPane.js'
import { undoCommandOf } from '../src/client/logic/memory.js'
import { dispatchCommand } from '../src/host/real-hub.js'
import { createMemorySample, sampleMemoryThread, SAMPLE_MEMORY_IDS, SAMPLE_MEMORY_MESSAGE_IDS } from '../src/shared/fixture-memory.js'
import type { MemoryNoteView, ThreadMessageView, ThreadView } from '../src/shared/views.js'
import { createHookHost } from './helpers/hook-host.js'
import { findElements, type StubElement } from './helpers/jsx-runtime-stub.js'

vi.mock('react', async () => (await import('./helpers/hook-host.js')).reactFacade)

function textOf(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object' && node !== null && 'props' in node) return textOf((node as StubElement).props.children)
  return ''
}
const flush = async (): Promise<void> => { for (let i = 0; i < 5; i++) await Promise.resolve() }

/** 样例总管私聊里三条带行的回复：已记住、已更正、已删除（行由 core 生成）。 */
const sample = createMemorySample()
const thread = sampleMemoryThread(sample)
const noteOf = (messageId: string): MemoryNoteView => thread.messages.find(row => row.id === messageId)!.memoryNotes![0]!
const noted = noteOf(SAMPLE_MEMORY_MESSAGE_IDS.ownerReply)
const corrected = noteOf(SAMPLE_MEMORY_MESSAGE_IDS.correctReply)
const deleted = noteOf(SAMPLE_MEMORY_MESSAGE_IDS.forgetReply)

describe('「已记住」一行：三种动作与已撤销状态', () => {
  it('已记住：小标、类型、正文、「撤销」按钮；下面是 core 给的原话一行与范围一行', () => {
    const tree = createHookHost().render(MemoryNoteRow, { note: noted, onUndo: async () => null })
    const text = textOf(tree)
    expect(text).toContain('已记住')
    expect(text).toContain('规矩')
    expect(text).toContain('页面提示文字以「请」字开头。')
    expect(text).toContain('撤销')
    // 原话一行与范围一行原样显示 core 的句子（不在界面里拼）。
    expect(text).toContain(noted.quoteLine!)
    expect(text).toContain('用于全部员工、全部项目')
    expect(findElements(tree, 'button')).toHaveLength(1)
  })

  it('已删除：小标「已删除」加被删的文字与「撤销」，不写类型小标', () => {
    const tree = createHookHost().render(MemoryNoteRow, { note: deleted, onUndo: async () => null })
    const text = textOf(tree)
    expect(text).toContain('已删除')
    expect(text).toContain('回复里加表情。')
    expect(text).not.toContain('偏好')
    expect(findElements(tree, 'button')).toHaveLength(1)
  })

  it('已更正：小标「已更正」加更正后的新文字与「撤销」', () => {
    const tree = createHookHost().render(MemoryNoteRow, { note: corrected, onUndo: async () => null })
    expect(textOf(tree)).toContain('已更正')
    expect(textOf(tree)).toContain('汇报先给结论，再说原因。')
    expect(findElements(tree, 'button')).toHaveLength(1)
  })

  it('已撤销：三种动作撤销之后都写「已撤销」加原文，没有按钮', () => {
    for (const note of [noted, corrected, deleted]) {
      const undone = { ...note, state: 'undone' as const, canUndo: false }
      const tree = createHookHost().render(MemoryNoteRow, { note: undone, onUndo: async () => null })
      const text = textOf(tree)
      expect(text).toContain('已撤销')
      expect(text).toContain(note.text)
      expect(findElements(tree, 'button')).toHaveLength(0)
    }
  })

  it('canUndo 为假（超过 24 小时）时没有按钮；没有接线（不传 onUndo）时行照样显示、没有按钮', () => {
    const expired = { ...deleted, canUndo: false }
    expect(findElements(createHookHost().render(MemoryNoteRow, { note: expired, onUndo: async () => null }), 'button')).toHaveLength(0)
    const tree = createHookHost().render(MemoryNoteRow, { note: noted })
    expect(textOf(tree)).toContain('已记住')
    expect(findElements(tree, 'button')).toHaveLength(0)
  })
})

describe('点「撤销」：调用对应命令，参数正确', () => {
  it('三种动作对应的命令名：记住 undoMemory，删除 undoDeleteMemory，更正 undoCorrectMemory', () => {
    expect(undoCommandOf(noted)).toBe('undoMemory')
    expect(undoCommandOf(deleted)).toBe('undoDeleteMemory')
    expect(undoCommandOf(corrected)).toBe('undoCorrectMemory')
  })

  it('点按钮：先置灰防重复点击，成功后复位；传给上层的是这一行的视图（含 memoryId）', async () => {
    const calls: MemoryNoteView[] = []
    const onUndo = vi.fn(async (note: MemoryNoteView) => { calls.push(note); return null })
    const host = createHookHost()
    const view = (): unknown => host.render(MemoryNoteRow, { note: noted, onUndo })
    ;(findElements(view(), 'button')[0]!.props.onClick as () => void)()
    expect(findElements(view(), 'button')[0]!.props.disabled).toBe(true)
    await flush()
    expect(findElements(view(), 'button')[0]!.props.disabled).toBe(false)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.memoryId).toBe(SAMPLE_MEMORY_IDS.rulePlease)
  })

  it('失败：在这一行旁显示错误文字，按钮复位可再点；成功则不显示错误', async () => {
    const host = createHookHost()
    const view = (): unknown => host.render(MemoryNoteRow, { note: noted, onUndo: async () => '这一条已经撤销或删除了' })
    ;(findElements(view(), 'button')[0]!.props.onClick as () => void)()
    await flush()
    const tree = view()
    expect(textOf(tree)).toContain('这一条已经撤销或删除了')
    expect(findElements(tree, 'p').some(row => row.props.role === 'alert')).toBe(true)
    expect(findElements(tree, 'button')[0]!.props.disabled).toBe(false)
  })

  it('按钮真的走宿主命令：命令名与参数交给 core，撤销之后线程视图里这一行变成「已撤销」', async () => {
    // 与界面同一条路径：undoCommandOf 选命令，宿主 dispatchCommand 检查参数后交给 core 的界面接口。
    const world = createMemorySample()
    const note = sampleMemoryThread(world).messages.find(row => row.id === SAMPLE_MEMORY_MESSAGE_IDS.ownerReply)!.memoryNotes![0]!
    const result = await dispatchCommand(world.api, undoCommandOf(note), { memoryId: note.memoryId })
    expect(result.ok).toBe(true)
    const after = sampleMemoryThread(world).messages.find(row => row.id === SAMPLE_MEMORY_MESSAGE_IDS.ownerReply)!.memoryNotes![0]!
    expect(after.state).toBe('undone')
    expect(after.canUndo).toBe(false)
    const tree = createHookHost().render(MemoryNoteRow, { note: after, onUndo: async () => null })
    expect(textOf(tree)).toContain('已撤销')
    // 缺参数是中文错误，不进 core。
    const missing = await dispatchCommand(world.api, 'undoMemory', {})
    expect(missing).toMatchObject({ ok: false })
    expect((missing as { error: string }).error).toBe('memoryId：缺少这一项')
  })
})

describe('总管私聊与主题线程两处都渲染', () => {
  it('私聊：ThreadPane 在带 memoryNotes 的消息后面画 MemoryNotes，并把 onUndoMemory 交给它', () => {
    const onUndoMemory = async (): Promise<string | null> => null
    const props = {
      threadId: thread.threadId, thread: thread as ThreadView, loading: false,
      header: { name: '总管', roleLabel: null, activityText: null, nextThinkText: null, staffStatus: null, thinking: false },
      inputPlaceholderName: '总管', banner: null, onBannerDismiss: () => undefined, onLoadEarlier: () => undefined, onSend: async () => undefined,
      actions: { onPick: async () => null, onUndoMemory }, busyInboxId: null, onRetry: () => undefined, error: null,
      onOpenSession: () => undefined, onTogglePause: () => undefined, onInterrupt: () => undefined,
    }
    const tree = createHookHost().render(ThreadPane, props as never)
    const rows = findElements(tree, MemoryNotes)
    // 样例里三条回复各带一行。
    expect(rows).toHaveLength(thread.messages.length)
    const withNotes = rows.filter(row => (row.props.notes as unknown[] | undefined)?.length)
    expect(withNotes).toHaveLength(3)
    expect(withNotes.every(row => row.props.onUndo === onUndoMemory)).toBe(true)
  })

  it('主题线程：楼层里也画 MemoryNotes（消息视图自带的行，或楼层项带的行）', () => {
    const message = thread.messages.find(row => row.id === SAMPLE_MEMORY_MESSAGE_IDS.ownerReply) as ThreadMessageView
    const tree = TopicFloor({ message, actions: { onPick: async () => null }, busyInboxId: null })
    const floorNotes = findElements(tree, MemoryNotes)
    expect(floorNotes).toHaveLength(1)
    expect((floorNotes[0]!.props.notes as MemoryNoteView[])[0]!.action).toBe('noted')
    // 消息视图里没有行时，用楼层项（core 的 floors）带的行。
    const plain = { ...message, memoryNotes: undefined } as ThreadMessageView
    const viaItem = TopicFloor({ message: plain, actions: { onPick: async () => null }, busyInboxId: null, notes: message.memoryNotes })
    expect((findElements(viaItem, MemoryNotes)[0]!.props.notes as MemoryNoteView[])).toHaveLength(1)
  })

  it('MemoryNotes 没有行时返回空，不占位置', () => {
    expect(MemoryNotes({ notes: undefined })).toBeNull()
    expect(MemoryNotes({ notes: [] })).toBeNull()
  })
})

/**
 * 「已记住」一行与「关于你的记忆」一页的纯逻辑与固定文字（P75k）。
 *
 * 做什么：
 * - 「已记住」「已删除」「已更正」「已撤销」一行用什么小标、点「撤销」调用哪个命令，由 core 的视图（action、state、canUndo）决定，
 *   这里只做对照，不自己拼 core 已经生成的句子（正文、出处一行、范围一行、原话一行都原样显示）；
 * - 记忆页的类型筛选、更正输入框的合法性判断（空内容、超过上限）、「保存」能不能点、从约定卡跳来时的定位条件；
 * - 界面自己的固定文字（按钮、提示、空态），集中在 MEM_TEXT，登记在 docs/copy/strings.json 的 MEM- 前缀下。
 * 为什么放纯函数：规则计算输入显式、可单测；组件只负责画。
 */
import type { MemoryEntryView, MemoryNoteView, MemoryPageView, MemoryTabKey } from '../../shared/views.js'

/** 界面自己的固定文字。core 生成的句子（出处、范围、原话、被引用、原为、已删除一行）不在这里，界面原样显示。 */
export const MEM_TEXT = {
  /** 「已记住」一行的小标：随动作和状态变化。 */
  noted: '已记住',
  deleted: '已删除',
  corrected: '已更正',
  undone: '已撤销',
  /** 一行下面的「撤销」按钮，以及记忆页「已删除」一行旁的同名按钮。 */
  undo: '撤销',
  /** 撤销按钮正在处理时的文字（防重复点击，同时让读屏知道状态）。 */
  undoing: '撤销中…',
  /** 撤销按钮的可达名称（同一页有多行时要分得清；{} 为这一行的正文）。 */
  undoLabel: '撤销：{}',
  /** 记忆页的可访问名（P86 起记忆页是设置页的一个分区，左栏与总管右侧栏不再有入口，条数也不再写在入口上）。 */
  entry: '关于你的记忆',
  /** 记忆页。 */
  pageLoadFailed: '记忆读取失败：{}。点击「重试」；仍失败请检查 DSH 运行状态。',
  emptyTab: '暂无这一类的记忆。',
  emptyAll: '暂无记忆。你说过以后都照做的话、定下的约定，会记在这里。',
  tabsLabel: '记忆类型',
  correct: '更正',
  correctLabel: '更正：{}',
  remove: '删除',
  removing: '删除中…',
  removeLabel: '删除：{}',
  /** 项目背景、项目页决策这类条目（带「去项目页」）的说明；core 给的 readonlyNote 是同一句。 */
  editInProject: '在项目页里修改',
  save: '保存',
  saving: '保存中…',
  cancel: '取消',
  editLabel: '更正这一条的说法',
  saveHint: '保存后，从下一次开始照新说法做。',
  emptyError: '内容不能为空。',
  tooLongError: '最多 {} 字，现在 {} 字。',
  openProject: '去项目页',
  openProjectLabel: '去项目页：{}',
  deletedListLabel: '已删除，可撤销',
  /** 约定卡上「出处」按钮的可达名称：点后打开记忆页并定位到那一条。 */
  citeLabel: '在「关于你的记忆」里查看：{}',
  /** 从约定卡跳来的那一条，读屏用的补充说明（视觉上是高亮边框）；用 aria-describedby 关联，不覆盖这一条自己的名称。 */
  focusedHint: '从约定卡跳转到这一条',
  /** 从约定卡点过来，但那一条记忆已删除或已被取代时，页顶显示的一行。 */
  entryMissing: '这一条记忆已删除或已被取代。',
  /** 操作没有成功又没带原因时的兜底说法（三段式：现象、动作、建议）。 */
  failed: '操作没有成功。请重试；仍失败请确认 DSH 是否已关闭。',
} as const

/**
 * 更正文字的上限：与 core 的 MEMORY_DEFAULTS.TEXT_MAX_CHARS 同一个数（120），按完整字符计。
 * 为什么抄一个数而不 import：客户端包不能引入 core 的主入口（会把 Node 半边的代码一起打进浏览器包，构建失败）；
 * test/p75k-memory-page.test.ts 有一条断言守着它与 core 的值一致，core 改了这个数测试会立刻报出来。
 */
export const MEMORY_TEXT_LIMIT = 120

/** 把 {} 占位依次换成给定的值（登记表用 {} 占位，文字写在一处，组件和测试读同一份）。 */
export function fill(template: string, ...values: Array<string | number>): string {
  let index = 0
  return template.replace(/\{\}/g, () => String(values[index++] ?? ''))
}

/** 撤销按钮调用的命令名：记住 → undoMemory，删除 → undoDeleteMemory，更正 → undoCorrectMemory。 */
export type MemoryUndoCommand = 'undoMemory' | 'undoDeleteMemory' | 'undoCorrectMemory'

export function undoCommandOf(note: Pick<MemoryNoteView, 'action'>): MemoryUndoCommand {
  if (note.action === 'deleted') return 'undoDeleteMemory'
  if (note.action === 'corrected') return 'undoCorrectMemory'
  return 'undoMemory'
}

/**
 * 一行的小标：
 * - 已撤销（state 为 undone）：不论原来是记住、删除还是更正，都写「已撤销」，没有按钮；
 * - 记住的那条后来被删掉（state 为 deleted）：写「已删除」，没有按钮（要恢复去记忆页撤销删除）；
 * - 其余按动作写「已记住」「已删除」「已更正」。
 */
export function noteLabelOf(note: Pick<MemoryNoteView, 'action' | 'state'>): string {
  if (note.state === 'undone') return MEM_TEXT.undone
  if (note.action === 'deleted' || note.state === 'deleted') return MEM_TEXT.deleted
  return note.action === 'corrected' ? MEM_TEXT.corrected : MEM_TEXT.noted
}

/** 这一行有没有「撤销」按钮：只看 core 给的 canUndo，且状态已经是撤销以外的。 */
export function noteShowsUndo(note: Pick<MemoryNoteView, 'canUndo' | 'state'>): boolean {
  return note.canUndo && note.state !== 'undone'
}

/** 类型小标（规矩、偏好）只在「已记住」一行写；删除、更正、已撤销的行不写。 */
export function noteKindText(note: Pick<MemoryNoteView, 'action' | 'state' | 'kindLabel'>): string | null {
  return note.action === 'noted' && note.state === 'active' ? note.kindLabel : null
}

/** 记忆页某一类的条目（key 为 all 时是全部四组的条目，保持分组顺序）；组为空的不出现。 */
export function groupsForTab(page: MemoryPageView, tab: MemoryTabKey): MemoryPageView['groups'] {
  const groups = tab === 'all' ? page.groups : page.groups.filter(group => group.key === tab)
  return groups.filter(group => group.entries.length > 0)
}

/** 更正输入框里的内容有没有问题：返回给主人看的一句原因，没有问题返回 null（「保存」可点）。 */
export function editProblemOf(text: string): string | null {
  const trimmed = text.trim()
  if (trimmed === '') return MEM_TEXT.emptyError
  const count = [...trimmed].length
  if (count > MEMORY_TEXT_LIMIT) return fill(MEM_TEXT.tooLongError, MEMORY_TEXT_LIMIT, count)
  return null
}

/**
 * 这一条要不要显示「更正」「删除」：core 的 actions 为准；固定规则、项目页内容两项都为假。
 * 项目背景与项目页决策（link 不为空）不显示这两个按钮，改显示「去项目页」。
 */
export function entryActionsOf(entry: Pick<MemoryEntryView, 'actions' | 'memoryId'>): { correct: boolean; remove: boolean } {
  // memoryId 为空的条目（固定规则、项目页内容）没有可以更正、删除的记录，即使视图误给了 actions 也不显示。
  const hasId = entry.memoryId !== null
  return { correct: hasId && entry.actions.correct, remove: hasId && entry.actions.delete }
}

/** 记忆页里一条的稳定元素编号：从约定卡跳来时按它定位、聚焦。 */
export function memoryEntryDomId(memoryId: string): string {
  return `ah-memory-${memoryId}`
}

/** 定位说明那一段隐藏文字的元素编号（这一条用 aria-describedby 指向它）。 */
export function memoryFocusHintDomId(memoryId: string): string {
  return `ah-memory-hint-${memoryId}`
}

/** 「已删除」行里「撤销」按钮的元素编号：删除成功后焦点移到这里。 */
export function memoryDeletedUndoDomId(memoryId: string): string {
  return `ah-memory-deleted-undo-${memoryId}`
}

/** 一条里「更正」按钮的元素编号：撤销删除成功后焦点移到恢复的那一条的这个按钮。 */
export function memoryCorrectDomId(memoryId: string): string {
  return `ah-memory-correct-${memoryId}`
}

/** 全部条目里有没有这一条（从约定卡跳来时，没有就不定位也不报错）。 */
export function hasMemoryEntry(page: MemoryPageView, memoryId: string): boolean {
  return page.groups.some(group => group.entries.some(entry => entry.memoryId === memoryId))
}

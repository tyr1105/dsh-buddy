/**
 * P73e 三问卡的组件测试：选项与说明行、点选发出的命令参数、已答与当前问的按钮状态、
 * 第二问「有」先选文件夹（取消不发命令、选择器不可用时给提示）、命令失败的错误显示，
 * 以及总管私聊输入框的占位文字。用 hook 宿主渲染真实组件，子组件不展开。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FOLDER_WAIT_MS, TeamQuestionCard } from '../src/client/components/TeamQuestionCard.js'
import { ThreadPane } from '../src/client/components/ThreadPane.js'
import { TEAM_TEXT, answerInput, needsFolder, questionInProgress } from '../src/client/logic/team-card.js'
import { sampleQuestionViews, sampleSetup } from '../src/shared/fixture-team.js'
import { fixtureThreads } from '../src/shared/fixtures.js'
import type { ThreadView } from '../src/shared/views.js'
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
const buttonsOf = (tree: unknown): StubElement[] => findElements(tree, 'button')
const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

const [q1, q2, q3] = sampleQuestionViews(sampleSetup)

describe('三问卡：渲染', () => {
  it('第三问：三个选项、说明行、建议项旁标「建议」，当前问的按钮可点', () => {
    const tree = createHookHost().render(TeamQuestionCard, { question: q3, onAnswer: async () => null })
    const buttons = buttonsOf(tree)
    expect(buttons.map(textOf)).toEqual(['只在需要你拍板时建议', '每件事做完都告诉我', '每个关键步骤都告诉我'])
    expect(buttons.every(button => button.props.disabled === false)).toBe(true)
    const note = findElements(tree, 'p').find(node => node.props.className === 'ah-team-note')!
    expect(textOf(note)).toBe('第 3 问，共 3 问。答完我就给出推荐。')
    // 选项按钮用提问卡的 ah-card-options 外框。
    expect(findElements(tree, 'div').some(node => node.props.className === 'ah-card-options')).toBe(true)
  })

  it('已答的问题：按钮全部不可点，选中项保持高亮', () => {
    const tree = createHookHost().render(TeamQuestionCard, { question: q1, onAnswer: async () => null })
    const buttons = buttonsOf(tree)
    expect(buttons).toHaveLength(4)
    expect(buttons.every(button => button.props.disabled === true)).toBe(true)
    const pressed = buttons.filter(button => button.props['aria-pressed'] === true)
    expect(pressed.map(textOf)).toEqual(['做软件产品：网页、小工具、插件'])
    expect(String(pressed[0]!.props.className)).toContain('ah-btn-primary')
  })

  it('第二问已答：同样全部不可点，选中「有，我选一下项目文件夹」', () => {
    const tree = createHookHost().render(TeamQuestionCard, { question: q2, onAnswer: async () => null })
    expect(buttonsOf(tree).every(button => button.props.disabled === true)).toBe(true)
    expect(buttonsOf(tree).filter(button => button.props['aria-pressed'] === true).map(textOf)).toEqual(['有，我选一下项目文件夹'])
  })
})

describe('三问卡：点选', () => {
  it('点选发出 answerTeamQuestion 的参数：setupId、step、choice', async () => {
    const onAnswer = vi.fn(async () => null)
    const tree = createHookHost().render(TeamQuestionCard, { question: q3, onAnswer })
    ;(buttonsOf(tree)[1]!.props.onClick as () => void)()
    await flush()
    expect(onAnswer).toHaveBeenCalledWith({ setupId: sampleSetup.id, step: 3, choice: 'each_done' })
    expect(answerInput(q3, 'each_done')).toEqual({ setupId: sampleSetup.id, step: 3, choice: 'each_done' })
  })

  it('已答问题的按钮点了也不发命令（反例）', async () => {
    const onAnswer = vi.fn(async () => null)
    const tree = createHookHost().render(TeamQuestionCard, { question: q1, onAnswer })
    ;(buttonsOf(tree)[0]!.props.onClick as () => void)()
    await flush()
    expect(onAnswer).not.toHaveBeenCalled()
  })

  it('命令失败：卡下显示错误文字，按钮恢复可点', async () => {
    const host = createHookHost()
    const props = { question: q3, onAnswer: vi.fn(async () => '这个问题已经回答过了') }
    ;(buttonsOf(host.render(TeamQuestionCard, props))[0]!.props.onClick as () => void)()
    await flush()
    const after = host.render(TeamQuestionCard, props)
    const alert = findElements(after, 'p').find(node => node.props.role === 'alert')
    expect(alert && textOf(alert)).toBe('这个问题已经回答过了')
    expect(buttonsOf(after).every(button => button.props.disabled === false)).toBe(true)
  })

  it('命令抛错也显示错误文字', async () => {
    const host = createHookHost()
    const props = { question: q3, onAnswer: vi.fn(async () => { throw new Error('网络断开') }) }
    ;(buttonsOf(host.render(TeamQuestionCard, props))[0]!.props.onClick as () => void)()
    await flush()
    const alert = findElements(host.render(TeamQuestionCard, props), 'p').find(node => node.props.role === 'alert')
    expect(alert && textOf(alert)).toBe('网络断开')
  })
})

describe('三问卡：第二问「有」先选文件夹', () => {
  /** 第二问还没答时的视图：用样例记录改成「正在问第二问」，再交给 core 生成。 */
  const [, open2] = sampleQuestionViews({
    ...sampleSetup, step: 2, answers: { ...sampleSetup.answers, hasProject: null, projectFolder: null, projectId: null, notify: null },
  })

  it('只有第二问的「有」需要文件夹，「暂时没有」不需要', () => {
    expect(needsFolder(open2!, 'yes')).toBe(true)
    expect(needsFolder(open2!, 'no')).toBe(false)
    expect(needsFolder(q3, 'decisions')).toBe(false)
  })

  it('选好文件夹：命令带上 folderPath', async () => {
    const onAnswer = vi.fn(async () => null)
    const pickFolder = vi.fn(async () => '/sample/projects/demo')
    const tree = createHookHost().render(TeamQuestionCard, { question: open2!, onAnswer, pickFolder })
    ;(buttonsOf(tree)[0]!.props.onClick as () => void)()
    await flush()
    expect(pickFolder).toHaveBeenCalledTimes(1)
    expect(onAnswer).toHaveBeenCalledWith({ setupId: sampleSetup.id, step: 2, choice: 'yes', folderPath: '/sample/projects/demo' })
  })

  // P73r4 改了预期：原来「取消选择（返回 null）」什么提示都不给；沙箱走查发现这样用户看不到任何反应，
  // 现在没有返回结果（含关掉窗口）也要写一行提示，所以此条的预期由「没有提示」改为「有提示」。
  it('关掉窗口（返回 null）：不发命令，卡下写提示，这一问仍可重新点选', async () => {
    const host = createHookHost()
    const onAnswer = vi.fn(async () => null)
    const props = { question: open2!, onAnswer, pickFolder: async () => null }
    ;(buttonsOf(host.render(TeamQuestionCard, props))[0]!.props.onClick as () => void)()
    await flush()
    expect(onAnswer).not.toHaveBeenCalled()
    const after = host.render(TeamQuestionCard, props)
    const alert = findElements(after, 'p').find(node => node.props.role === 'alert')
    expect(alert && textOf(alert)).toBe(TEAM_TEXT.folderUnavailable)
    expect(buttonsOf(after).every(button => button.props.disabled === false)).toBe(true)
  })

  it('选择器不可用（抛错或没有传入）：卡下显示提示句，不发命令', async () => {
    for (const pickFolder of [async () => { throw new Error('当前环境不支持选择文件夹。') }, undefined]) {
      const host = createHookHost()
      const onAnswer = vi.fn(async () => null)
      const props = { question: open2!, onAnswer, pickFolder }
      ;(buttonsOf(host.render(TeamQuestionCard, props))[0]!.props.onClick as () => void)()
      await flush()
      const alert = findElements(host.render(TeamQuestionCard, props), 'p').find(node => node.props.role === 'alert')
      // P73r4 改了预期：提示句改为「没有选到文件夹……」。
      expect(alert && textOf(alert)).toBe('没有选到文件夹。请再点一次，或在输入框里写出项目文件夹的完整路径。')
      expect(onAnswer).not.toHaveBeenCalled()
    }
  })

  it('P73r4：返回空字符串或空白也算没有选到，提示且不发命令', async () => {
    for (const empty of ['', '   ']) {
      const host = createHookHost()
      const onAnswer = vi.fn(async () => null)
      const props = { question: open2!, onAnswer, pickFolder: async () => empty }
      ;(buttonsOf(host.render(TeamQuestionCard, props))[0]!.props.onClick as () => void)()
      await flush()
      const alert = findElements(host.render(TeamQuestionCard, props), 'p').find(node => node.props.role === 'alert')
      expect(alert && textOf(alert)).toBe(TEAM_TEXT.folderUnavailable)
      expect(onAnswer).not.toHaveBeenCalled()
    }
  })

  it('P73r4：提示出现后再点一次选到路径，提示消失并发出命令', async () => {
    const host = createHookHost()
    const onAnswer = vi.fn(async () => null)
    const results: Array<string | null> = [null, '/sample/projects/demo']
    const props = { question: open2!, onAnswer, pickFolder: async () => results.shift() ?? null }
    ;(buttonsOf(host.render(TeamQuestionCard, props))[0]!.props.onClick as () => void)()
    await flush()
    expect(findElements(host.render(TeamQuestionCard, props), 'p').some(node => node.props.role === 'alert')).toBe(true)
    ;(buttonsOf(host.render(TeamQuestionCard, props))[0]!.props.onClick as () => void)()
    await flush()
    expect(onAnswer).toHaveBeenCalledWith({ setupId: sampleSetup.id, step: 2, choice: 'yes', folderPath: '/sample/projects/demo' })
    expect(findElements(host.render(TeamQuestionCard, props), 'p').some(node => node.props.role === 'alert')).toBe(false)
  })

  it('P73r4：选择窗口一直不返回时，过了等待时间也写出提示（网页沙箱里出现过）', async () => {
    vi.useFakeTimers()
    try {
      const host = createHookHost()
      const onAnswer = vi.fn(async () => null)
      const props = { question: open2!, onAnswer, pickFolder: () => new Promise<string | null>(() => { /* 永不返回 */ }) }
      ;(buttonsOf(host.render(TeamQuestionCard, props))[0]!.props.onClick as () => void)()
      await vi.advanceTimersByTimeAsync(FOLDER_WAIT_MS - 1)
      expect(findElements(host.render(TeamQuestionCard, props), 'p').some(node => node.props.role === 'alert')).toBe(false)
      await vi.advanceTimersByTimeAsync(2)
      const alert = findElements(host.render(TeamQuestionCard, props), 'p').find(node => node.props.role === 'alert')
      expect(alert && textOf(alert)).toBe(TEAM_TEXT.folderUnavailable)
      expect(onAnswer).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('选「暂时没有」不弹选择器，直接发命令', async () => {
    const onAnswer = vi.fn(async () => null)
    const pickFolder = vi.fn(async () => '/x')
    const tree = createHookHost().render(TeamQuestionCard, { question: open2!, onAnswer, pickFolder })
    ;(buttonsOf(tree)[1]!.props.onClick as () => void)()
    await flush()
    expect(pickFolder).not.toHaveBeenCalled()
    expect(onAnswer).toHaveBeenCalledWith({ setupId: sampleSetup.id, step: 2, choice: 'no' })
  })
})

describe('总管私聊输入框占位', () => {
  const chief = fixtureThreads.find(thread => thread.threadId === 'bot-zongguan')!
  const props = (thread: ThreadView) => ({
    threadId: 'bot-zongguan', thread, loading: false, header: null, inputPlaceholderName: '总管', chiefEntry: true, banner: null,
    onBannerDismiss: () => undefined, onLoadEarlier: () => undefined, onSend: async () => undefined, actions: { onPick: async () => null },
    busyInboxId: null, onRetry: () => undefined, error: null, onOpenSession: () => undefined,
    onTogglePause: () => undefined, onInterrupt: () => undefined,
  })
  const placeholderOf = (thread: ThreadView): unknown =>
    findElements(createHookHost().render(ThreadPane, props(thread)), 'textarea')[0]!.props.placeholder

  it('三问进行中（最新一条三问消息的 current 为真）：占位写「点选上面的选项，或写下你的回答」', () => {
    expect(questionInProgress(chief.messages)).toBe(true)
    expect(placeholderOf(chief)).toBe('点选上面的选项，或写下你的回答')
    expect(TEAM_TEXT.questionPlaceholder).toBe('点选上面的选项，或写下你的回答')
  })

  it('三问结束后恢复第一块的占位文字（反例）', () => {
    const answered = { ...chief, messages: chief.messages.map(message => message.teamQuestion ? { ...message, teamQuestion: { ...message.teamQuestion, current: false } } : message) }
    expect(questionInProgress(answered.messages)).toBe(false)
    expect(placeholderOf(answered)).toBe('交代一件事。需要你拿主意的地方，总管会先和你对齐再开工。')
  })

  it('没有三问消息的线程不受影响', () => {
    const other = fixtureThreads.find(thread => thread.threadId === 'bot-tanlu')!
    expect(questionInProgress(other.messages)).toBe(false)
  })
})

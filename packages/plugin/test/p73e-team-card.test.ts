/**
 * P73e 组队卡的组件测试与逻辑测试：
 * 改名（回车、改名按钮、与原名相同不提交）、性格四维二选一拼类型、建议与已改标记、恢复按钮、
 * 模型档位、换一位（置灰项不可点）、不要这位与撤销、按需加人的卡没有「不要这位」、
 * 主按钮文字随视图变化并发 confirmTeamProposal、只读状态没有任何按钮且每位一行来历。
 * 用 hook 宿主渲染真实组件，子组件（头像、性格四句）不展开，只看传给它们的 props。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TeamCard } from '../src/client/components/TeamCard.js'
import { PersonalityLines } from '../src/client/components/PersonalityLines.js'
import { MBTI_AXES, mbtiAxisChoice, mbtiWithAxis, readonlyLine, shouldSubmitRename } from '../src/client/logic/team-card.js'
import {
  sampleAdditionProposal, sampleConfirmedProposal, sampleInitialProposal, sampleViewOfProposal,
} from '../src/shared/fixture-team.js'
import type { TeamCardView } from '../src/shared/views.js'
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
const buttonNamed = (tree: unknown, label: string): StubElement | undefined => buttonsOf(tree).find(node => textOf(node) === label)
const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))
const click = (node: StubElement | undefined): void => { (node!.props.onClick as () => void)() }

const initial: TeamCardView = sampleViewOfProposal(sampleInitialProposal)
const confirmed: TeamCardView = sampleViewOfProposal(sampleConfirmedProposal)
const addition: TeamCardView = sampleViewOfProposal(sampleAdditionProposal)

/** 渲染一次；onEdit、onConfirm 默认成功。 */
function mount(card: TeamCardView, over: Partial<{ onEdit: (input: Record<string, unknown>) => Promise<string | null>; onConfirm: (input: Record<string, unknown>) => Promise<string | null> }> = {}) {
  const onEdit = vi.fn(over.onEdit ?? (async () => null))
  const onConfirm = vi.fn(over.onConfirm ?? (async () => null))
  const host = createHookHost()
  const props = { card, onEdit, onConfirm }
  return { host, props, onEdit, onConfirm, render: () => host.render(TeamCard, props) }
}
const nameInputs = (tree: unknown): StubElement[] => findElements(tree, 'input')
const typeName = (input: StubElement, value: string): void => { (input.props.onChange as (event: unknown) => void)({ target: { value } }) }
const pressEnter = (input: StubElement): void => { (input.props.onKeyDown as (event: unknown) => void)({ key: 'Enter', nativeEvent: { key: 'Enter' }, preventDefault: () => undefined }) }

describe('组队卡：待确认的初始卡', () => {
  it('标签、标题、状态取视图；三位候选各一块，每块有名字输入框和四句性格', () => {
    const tree = mount(initial).render()
    expect(textOf(findElements(tree, 'span').find(node => node.props.className === 'ah-card-type'))).toBe('组队')
    expect(textOf(findElements(tree, 'span').find(node => node.props.className === 'ah-card-title'))).toBe('初始团队')
    expect(textOf(findElements(tree, 'span').find(node => String(node.props.className).startsWith('ah-team-state')))).toBe('待你确认')
    expect(nameInputs(tree).map(input => input.props.value)).toEqual(['工程师', '设计师', '评审员'])
    const lines = findElements(tree, PersonalityLines)
    expect(lines).toHaveLength(3)
    // 四句话原样取自视图。
    expect((lines[1]!.props.lines as Array<{ code: string }>).map(line => line.code)).toEqual(['E', 'S', 'F', 'J'])
  })

  it('每位写「模板：…」「适合做：…」「预计 …」，卡底三行、确认按钮、卡下说明都取视图文字', () => {
    const text = textOf(mount(initial).render())
    expect(text).toContain('模板：工程师　执行')
    expect(text).toContain('模板：评审员　评审，全队一位')
    expect(text).toContain('适合做：')
    expect(text).toContain('预计 ')
    expect(text).toContain(initial.footer.rosterText)
    expect(text).toContain('平时不接活时不消耗额度')
    expect(text).toContain('1 个回合约 110K 到 160K token')
    expect(text).toContain(initial.note!)
    expect(buttonNamed(mount(initial).render(), '确认，3 位入职')).toBeDefined()
  })

  it('性格与模型：没改过标「建议」，改过标「已改」，并显示恢复按钮（设计师的性格已改为 ESFJ）', () => {
    const tree = mount(initial).render()
    const flags = findElements(tree, 'i').map(node => `${node.props.className}|${textOf(node)}`)
    // 三位 × 性格、模型 = 6 个标记，只有设计师的性格是「已改」。
    expect(flags).toHaveLength(6)
    expect(flags.filter(flag => flag.endsWith('已改'))).toHaveLength(1)
    expect(flags.filter(flag => flag.endsWith('建议'))).toHaveLength(5)
    expect(buttonNamed(tree, '恢复为建议值 ISFJ')).toBeDefined()
    // 其余没改的不出现恢复按钮。
    expect(buttonsOf(tree).filter(node => textOf(node).startsWith('恢复为建议值'))).toHaveLength(1)
  })

  it('反例：只读（已确认）卡没有恢复、换一位、不要这位、确认等任何按钮', () => {
    expect(buttonsOf(mount(confirmed).render())).toHaveLength(0)
  })
})

describe('组队卡：改名', () => {
  it('回车提交 rename：带视图里的 rev、候选编号和新名字', async () => {
    const m = mount(initial)
    typeName(nameInputs(m.render())[0]!, '林舟')
    pressEnter(nameInputs(m.render())[0]!)
    await flush()
    expect(m.onEdit).toHaveBeenCalledWith({ proposalId: initial.proposalId, rev: initial.rev, key: 'c1', action: 'rename', value: '林舟' })
  })

  it('名字有改动时出现「改名」按钮，点它同样提交；没有改动时没有这个按钮', async () => {
    const m = mount(initial)
    expect(buttonNamed(m.render(), '改名')).toBeUndefined()
    typeName(nameInputs(m.render())[1]!, '小设')
    const tree = m.render()
    expect(buttonNamed(tree, '改名')).toBeDefined()
    click(buttonNamed(tree, '改名'))
    await flush()
    expect(m.onEdit).toHaveBeenCalledWith({ proposalId: initial.proposalId, rev: initial.rev, key: 'c2', action: 'rename', value: '小设' })
  })

  it('与原名相同、或只有空白时不提交', async () => {
    const m = mount(initial)
    typeName(nameInputs(m.render())[0]!, '工程师')
    pressEnter(nameInputs(m.render())[0]!)
    typeName(nameInputs(m.render())[0]!, '   ')
    pressEnter(nameInputs(m.render())[0]!)
    await flush()
    expect(m.onEdit).not.toHaveBeenCalled()
    expect(shouldSubmitRename('工程师', '工程师')).toBe(false)
    expect(shouldSubmitRename('工程师', '  ')).toBe(false)
    expect(shouldSubmitRename('工程师', ' 林舟 ')).toBe(true)
  })

  it('名字改了没提交就点确认：不确认，提示先提交', async () => {
    const m = mount(initial)
    typeName(nameInputs(m.render())[0]!, '林舟')
    click(buttonNamed(m.render(), '确认，3 位入职'))
    await flush()
    expect(m.onConfirm).not.toHaveBeenCalled()
    const alert = findElements(m.render(), 'p').find(node => node.props.role === 'alert')
    expect(alert && textOf(alert)).toBe('有名字改了还没提交。请先点「改名」或按回车，再确认。')
  })

  it('改名失败：错误显示在卡下，输入框保留你写的名字', async () => {
    const m = mount(initial, { onEdit: async () => '名字：已有同名员工（含已归档的）或卡上已有同名的人，请换一个名字' })
    typeName(nameInputs(m.render())[0]!, '设计师')
    pressEnter(nameInputs(m.render())[0]!)
    await flush()
    const tree = m.render()
    expect(textOf(findElements(tree, 'p').find(node => node.props.role === 'alert'))).toContain('已有同名员工')
    expect(nameInputs(tree)[0]!.props.value).toBe('设计师')
  })
})

describe('组队卡：性格', () => {
  it('四维二选一拼出类型：ISFJ 把第一个维度换成 E 得到 ESFJ', () => {
    expect(mbtiWithAxis('ISFJ', 0, 'E')).toBe('ESFJ')
    expect(mbtiWithAxis('ISTJ', 1, 'N')).toBe('INTJ')
    expect(mbtiWithAxis('ISTJ', 2, 'F')).toBe('ISFJ')
    expect(mbtiWithAxis('ISTJ', 3, 'P')).toBe('ISTP')
    expect(mbtiAxisChoice('ESFJ', 0)).toBe('E')
    expect(MBTI_AXES.map(axis => axis.options.map(option => option.code).join(''))).toEqual(['EI', 'SN', 'TF', 'JP'])
  })

  it('点开性格：四个维度各一组二选一，当前选中的标出；点另一项发 set_mbti（ISTJ 点 E 得到 ESTJ）', async () => {
    const m = mount(initial)
    const open = buttonsOf(m.render()).find(node => node.props['aria-label'] === '修改工程师的性格')!
    expect(open.props['aria-expanded']).toBe(false)
    click(open)
    const tree = m.render()
    const groups = findElements(tree, 'div').filter(node => node.props.role === 'radiogroup')
    expect(groups).toHaveLength(4)
    const radios = buttonsOf(groups[0]!)
    expect(radios.map(node => node.props['aria-checked'])).toEqual([false, true]) // I 当前选中
    click(radios[0])
    await flush()
    expect(m.onEdit).toHaveBeenCalledWith({ proposalId: initial.proposalId, rev: initial.rev, key: 'c1', action: 'set_mbti', value: 'ESTJ' })
  })

  it('点当前已选的维度不重复提交；点恢复按钮发 restore_mbti', async () => {
    const m = mount(initial)
    click(buttonsOf(m.render()).find(node => node.props['aria-label'] === '修改工程师的性格'))
    const groups = findElements(m.render(), 'div').filter(node => node.props.role === 'radiogroup')
    click(buttonsOf(groups[0]!)[1])
    await flush()
    expect(m.onEdit).not.toHaveBeenCalled()
    click(buttonNamed(m.render(), '恢复为建议值 ISFJ'))
    await flush()
    expect(m.onEdit).toHaveBeenCalledWith({ proposalId: initial.proposalId, rev: initial.rev, key: 'c2', action: 'restore_mbti' })
  })
})

describe('组队卡：模型', () => {
  it('点开模型：列出视图给的档位，当前档选中；点另一档发 set_model', async () => {
    const m = mount(initial)
    click(buttonsOf(m.render()).find(node => node.props['aria-label'] === '修改工程师的模型'))
    const group = findElements(m.render(), 'div').find(node => node.props.role === 'radiogroup' && node.props['aria-label'] === '模型')!
    const radios = buttonsOf(group)
    expect(radios.map(textOf)).toEqual(['标准档', '轻档'])
    expect(radios.map(node => node.props['aria-checked'])).toEqual([true, false])
    click(radios[1])
    await flush()
    expect(m.onEdit).toHaveBeenCalledWith({ proposalId: initial.proposalId, rev: initial.rev, key: 'c1', action: 'set_model', value: 'light' })
  })

  it('不可用的档位不可点（轻档不可用时的卡）', () => {
    const noLight: TeamCardView = {
      ...initial,
      candidates: initial.candidates.map(candidate => ({
        ...candidate, model: { ...candidate.model, options: candidate.model.options.map(option => option.tier === 'light' ? { ...option, available: false } : option) },
      })),
    }
    const m = mount(noLight)
    click(buttonsOf(m.render()).find(node => node.props['aria-label'] === '修改评审员的模型'))
    const group = findElements(m.render(), 'div').find(node => node.props.role === 'radiogroup' && node.props['aria-label'] === '模型')!
    const light = buttonsOf(group).find(node => textOf(node).startsWith('轻档'))!
    expect(light.props.disabled).toBe(true)
    expect(textOf(light)).toContain('不可用')
  })
})

describe('组队卡：换一位、不要这位', () => {
  /** P73f：「换一位」是下拉（select），第一项是占位「换一位…」，其后是备选；选了备选后出现「换为这位」按钮才提交。 */
  const swapSelects = (tree: unknown): StubElement[] => findElements(tree, 'select').filter(node => node.props['aria-label'] === '换一位…')
  const choose = (select: StubElement, value: string): void => {
    (select.props.onChange as (event: { target: { value: string } }) => void)({ target: { value } })
  }

  it('P73f：「换一位」是下拉：占位项加备选；选一项后出现「换为这位」，点它才发 swap（带备选序号）', async () => {
    const m = mount(initial)
    const select = swapSelects(m.render())[0]!
    expect(findElements(select, 'option').map(textOf)).toEqual(['换一位…', '工程师，换性格 ESTJ：尽早给出初步结果', '产品经理：先把需求写清楚'])
    expect(buttonsOf(m.render()).some(node => textOf(node) === '换为这位')).toBe(false)
    choose(select, '1')
    // 选择变化时不发命令（写操作只走显式按钮）。
    expect(m.onEdit).not.toHaveBeenCalled()
    click(buttonsOf(m.render()).find(node => textOf(node) === '换为这位'))
    await flush()
    expect(m.onEdit).toHaveBeenCalledWith({ proposalId: initial.proposalId, rev: initial.rev, key: 'c1', action: 'swap', value: 1 })
  })

  it('置灰的备选不可点并显示原因；反例：点了也不发命令', async () => {
    // 评审员已在册后，备选里同模板的以外项置灰：用视图函数生成「产品经理已在册」的卡。
    const taken = sampleViewOfProposal({ ...sampleInitialProposal }) // 取现成视图，再改一项为置灰
    const view: TeamCardView = {
      ...taken, candidates: taken.candidates.map((candidate, index) => index === 0
        ? { ...candidate, alternates: candidate.alternates.map(alternate => alternate.index === 1 ? { ...alternate, disabled: true, reason: '已在册' } : alternate) }
        : candidate),
    }
    const m = mount(view)
    const select = swapSelects(m.render())[0]!
    const grey = findElements(select, 'option')[2]!
    expect(grey.props.disabled).toBe(true)
    expect(textOf(grey)).toContain('已在册')
    // 即使选中值被强行设成置灰项：也不出现「换为这位」，更不发命令。
    choose(select, '1')
    expect(buttonsOf(m.render()).some(node => textOf(node) === '换为这位')).toBe(false)
    await flush()
    expect(m.onEdit).not.toHaveBeenCalled()
  })

  it('「不要这位」发 remove；被去掉的候选整块变淡，显示「已选不要」和「撤销」，撤销发 unremove', async () => {
    const m = mount(initial)
    click(buttonsOf(m.render()).filter(node => textOf(node) === '不要这位')[1])
    await flush()
    expect(m.onEdit).toHaveBeenCalledWith({ proposalId: initial.proposalId, rev: initial.rev, key: 'c2', action: 'remove' })

    const removedView: TeamCardView = { ...initial, candidates: initial.candidates.map(candidate => candidate.key === 'c2' ? { ...candidate, removed: true } : candidate) }
    const m2 = mount(removedView)
    const tree = m2.render()
    expect(findElements(tree, 'div').filter(node => String(node.props.className).includes('is-removed'))).toHaveLength(1)
    expect(textOf(tree)).toContain('已选不要')
    click(buttonNamed(tree, '撤销'))
    await flush()
    expect(m2.onEdit).toHaveBeenCalledWith({ proposalId: initial.proposalId, rev: initial.rev, key: 'c2', action: 'unremove' })
  })

  it('反例：按需加人的卡没有「不要这位」，一位候选；卡下写「不新增」的说明', () => {
    const tree = mount(addition).render()
    expect(buttonNamed(tree, '不要这位')).toBeUndefined()
    expect(textOf(tree)).toContain('不新增也可以：回复「不新增」')
    expect(textOf(findElements(tree, 'span').find(node => node.props.className === 'ah-card-title'))).toBe('新员工：会员定价页')
    expect(nameInputs(tree)).toHaveLength(1)
    expect(buttonNamed(tree, '确认入职，接手这件事')).toBeDefined()
  })

  it('员工说明被总管改过时多一行', () => {
    const view: TeamCardView = { ...addition, candidates: addition.candidates.map(candidate => ({ ...candidate, briefChanged: true })) }
    expect(textOf(mount(view).render())).toContain('员工说明已按你的话修改')
    expect(textOf(mount(addition).render())).not.toContain('员工说明已按你的话修改')
  })
})

describe('组队卡：确认与错误', () => {
  it('主按钮文字随视图变化：不要一位后写「确认，2 位入职」，全部不要写「全部不要」', () => {
    const none: TeamCardView = { ...initial, confirmLabel: '全部不要' }
    expect(buttonNamed(mount(none).render(), '全部不要')).toBeDefined()
    const two: TeamCardView = { ...initial, confirmLabel: '确认，2 位入职' }
    expect(buttonNamed(mount(two).render(), '确认，2 位入职')).toBeDefined()
  })

  it('点主按钮发 confirmTeamProposal：proposalId 与 rev', async () => {
    const m = mount(initial)
    click(buttonNamed(m.render(), '确认，3 位入职'))
    await flush()
    expect(m.onConfirm).toHaveBeenCalledWith({ proposalId: initial.proposalId, rev: initial.rev })
  })

  it('提交中按钮不可点，防重复点击；完成后恢复', async () => {
    let finish: (value: string | null) => void = () => undefined
    const m = mount(initial, { onConfirm: () => new Promise<string | null>(resolve => { finish = resolve }) })
    click(buttonNamed(m.render(), '确认，3 位入职'))
    expect(buttonNamed(m.render(), '确认，3 位入职')!.props.disabled).toBe(true)
    // 连点第二下被挡住。
    click(buttonNamed(m.render(), '确认，3 位入职'))
    expect(m.onConfirm).toHaveBeenCalledTimes(1)
    finish(null)
    await flush()
    expect(buttonNamed(m.render(), '确认，3 位入职')!.props.disabled).toBe(false)
  })

  it('失败显示原因（「卡片已更新」不重试），按钮复位', async () => {
    const m = mount(initial, { onConfirm: async () => '卡片已更新，请在最新内容上确认' })
    click(buttonNamed(m.render(), '确认，3 位入职'))
    await flush()
    const tree = m.render()
    expect(textOf(findElements(tree, 'p').find(node => node.props.role === 'alert'))).toBe('卡片已更新，请在最新内容上确认')
    expect(m.onConfirm).toHaveBeenCalledTimes(1)
    expect(buttonNamed(tree, '确认，3 位入职')!.props.disabled).toBe(false)
  })

  it('卡上没有任何「正在思考」类的提示', () => {
    const text = textOf(mount(initial).render())
    for (const word of ['思考', '正在处理', '正在生成', '请稍候']) expect(text).not.toContain(word)
  })
})

describe('组队卡：只读状态', () => {
  it('确认后：每位一行，来历写在行尾；没有任何按钮和输入框；写状态与在册人数', () => {
    const tree = mount(confirmed).render()
    expect(buttonsOf(tree)).toHaveLength(0)
    expect(nameInputs(tree)).toHaveLength(0)
    const items = findElements(tree, 'li').map(textOf)
    expect(items).toEqual([
      '林舟　执行　ISTJ　由「工程师」改名',
      '设计师　你选了不要',
      '评审员　评审　ISTJ　标准档　模型由建议的「轻档」改为「标准档」',
    ])
    const text = textOf(tree)
    expect(text).toContain(confirmed.stateLabel)
    expect(text).toContain('已入职　11月11日 09:05')
    expect(text).toContain('在册 3 / 6 位')
  })

  it('没改过的候选不写档位和来历，只有名字、角色、类型', () => {
    expect(readonlyLine({ ...confirmed.candidates[0]!, historyText: null })).toBe('林舟　执行　ISTJ')
  })

  it('你选择不新增（declined）也是只读，没有按钮', () => {
    const declined: TeamCardView = { ...confirmed, state: 'declined', stateLabel: '你选择不新增' }
    expect(buttonsOf(mount(declined).render())).toHaveLength(0)
    expect(textOf(mount(declined).render())).toContain('你选择不新增')
  })
})

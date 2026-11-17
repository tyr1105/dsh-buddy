/**
 * P73f：员工配置表单的两处改动——性格（MBTI）改为「类型　改为…」就地选择，执行类员工的自主节奏固定为一行文字。
 *
 * 用 hook 宿主渲染真实组件（子组件不展开，只看传给它们的 props 和这一层的元素）：
 * 1. 性格：点开后四个维度各二选一；选完即时更新四句话（逐字等于 core 的总表）；未设置时四个都选完才算有类型；
 * 2. 自主节奏：执行类（调研、执行、建议）只有固定一行、没有选项；值守类和总管仍是四选一；
 *    保存和新建时执行类不提交 onDemand、autonomy、pace。
 */
import { describe, expect, it, vi } from 'vitest'
import { MBTI_BEHAVIOR_TEXT, mbtiBehaviorLines } from '@agent-hub/core/team'
import { BotConfigFields, FIXED_RHYTHM_TEXT } from '../src/client/components/bot-config-fields.js'
import { PersonalityField } from '../src/client/components/PersonalityField.js'
import { PersonalityLines } from '../src/client/components/PersonalityLines.js'
import {
  buildCreateBotInput, buildProfilePatch, emptyDraft, isFixedRhythmRole, type BotConfigDraft, type MbtiDraft,
} from '../src/client/logic/wizard.js'
import { createHookHost } from './helpers/hook-host.js'
import { findElements, type StubElement } from './helpers/jsx-runtime-stub.js'

vi.mock('react', async () => (await import('./helpers/hook-host.js')).reactFacade)

function textOf(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object' && node !== null && 'props' in node) return textOf((node as StubElement).props.children)
  return ''
}

describe('性格（MBTI）：点开后四个维度各二选一，四句话即时变化', () => {
  /** 一个可以连续渲染的性格项：value 由测试控制，模拟弹窗里草稿的变化。 */
  function mount(initial: MbtiDraft) {
    const host = createHookHost()
    const onChange = vi.fn<(value: MbtiDraft) => void>()
    let value = initial
    const render = (): StubElement => host.render(PersonalityField, { value, onChange: (next: MbtiDraft) => { value = next; onChange(next) } }) as StubElement
    return { render, onChange }
  }
  const lines = (tree: StubElement): Array<{ code: string; text: string }> => findElements(tree, PersonalityLines)[0]!.props.lines as Array<{ code: string; text: string }>
  const chip = (tree: StubElement): StubElement => findElements(tree, 'button').find(node => node.props['aria-expanded'] !== undefined)!
  const radio = (tree: StubElement, code: string): StubElement => findElements(tree, 'button').find(node => node.props.role === 'radio' && textOf(node).startsWith(code))!

  it('已设置：按钮写「ISTJ　改为…」，下面是 ISTJ 的四句话（逐字等于 core 总表），再下面是说明一行', () => {
    const { render } = mount('ISTJ')
    const tree = render()
    expect(textOf(chip(tree))).toBe('ISTJ　改为…')
    expect(lines(tree)).toEqual(mbtiBehaviorLines('ISTJ'))
    expect(lines(tree)[0]).toEqual({ code: 'I', text: MBTI_BEHAVIOR_TEXT.I })
    expect(findElements(tree, 'p').map(textOf)).toContain('改了之后，上面的四句话随之改变。')
  })

  it('ISTJ 把第一个维度改成 E：onChange 收到 ESTJ，重新渲染后四句话的第一句变成 E 的那句', () => {
    const { render, onChange } = mount('ISTJ')
    ;(chip(render()).props.onClick as () => void)()
    ;(radio(render(), 'E').props.onClick as () => void)()
    expect(onChange).toHaveBeenCalledWith('ESTJ')
    const after = render()
    expect(lines(after)[0]).toEqual({ code: 'E', text: '尽早给出初步结果，方便及早纠偏。' })
    // 其余三句不变。
    expect(lines(after).slice(1)).toEqual(mbtiBehaviorLines('ISTJ')!.slice(1))
  })

  it('反例：点已选中的那一项不发变化；没点开之前没有四个维度的选项', () => {
    const { render, onChange } = mount('ISTJ')
    expect(findElements(render(), 'button').some(node => node.props.role === 'radio')).toBe(false)
    ;(chip(render()).props.onClick as () => void)()
    ;(radio(render(), 'I').props.onClick as () => void)()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('未设置：按钮写「未设置　选择…」，没有四句话；四个维度都选完才算有类型，选到一半不发变化', () => {
    const { render, onChange } = mount('')
    const tree = render()
    expect(textOf(chip(tree))).toBe('未设置　选择…')
    expect(findElements(tree, PersonalityLines)).toEqual([])
    ;(chip(tree).props.onClick as () => void)()
    ;(radio(render(), 'E').props.onClick as () => void)()
    ;(radio(render(), 'N').props.onClick as () => void)()
    ;(radio(render(), 'T').props.onClick as () => void)()
    expect(onChange).not.toHaveBeenCalled()
    ;(radio(render(), 'P').props.onClick as () => void)()
    expect(onChange).toHaveBeenCalledWith('ENTP')
  })

  it('已设置的可以点「不设置」回到未设置', () => {
    const { render, onChange } = mount('ISTJ')
    ;(chip(render()).props.onClick as () => void)()
    const clear = findElements(render(), 'button').find(node => textOf(node) === '不设置')!
    ;(clear.props.onClick as () => void)()
    expect(onChange).toHaveBeenCalledWith('')
  })
})

describe('自主节奏：执行类固定一行，值守类保留选项', () => {
  const baseProps = {
    onChange: () => undefined, modelOptions: [], presetSkillOptions: [], dshSkillOptions: [], chiefTaken: false, problem: null,
  }
  const draftOf = (role: BotConfigDraft['role']): BotConfigDraft => ({ ...emptyDraft(), name: '员工', role })
  /** 自主节奏那一项里的内容：返回固定说明的文字和四选一的按钮文字。 */
  function rhythmOf(role: BotConfigDraft['role']): { fixed: string | null; options: string[] } {
    const tree = createHookHost().render(BotConfigFields, { ...baseProps, draft: draftOf(role) }) as StubElement
    const field = findElements(tree, 'div').find(node => findElements(node.props.children, 'span').some(span => span.props.className === 'ah-wizard-label' && textOf(span) === '自主节奏'))!
    const fixed = findElements(field, 'div').find(node => node.props.className === 'ah-fixed-line')
    const group = findElements(field, 'div').find(node => node.props.role === 'group' && node.props['aria-label'] === '自主节奏')
    return { fixed: fixed === undefined ? null : textOf(fixed), options: group === undefined ? [] : findElements(group, 'button').map(button => textOf(findElements(button, 'strong')[0])) }
  }

  it('执行类（调研、执行、建议）：没有节奏选项，只有固定的一行', () => {
    for (const role of ['researcher', 'executor', 'advisor'] as const) {
      expect(rhythmOf(role)).toEqual({ fixed: '听吩咐：执行类员工只在总管安排或你点名时工作。', options: [] })
    }
    expect(FIXED_RHYTHM_TEXT).toBe('听吩咐：执行类员工只在总管安排或你点名时工作。')
  })

  it('值守类（巡检员）和总管：仍有四选一，没有固定一行', () => {
    for (const role of ['sentinel', 'chief'] as const) {
      expect(rhythmOf(role)).toEqual({ fixed: null, options: ['听吩咐', '提建议', '主动做', '全力推进'] })
    }
  })

  it('反例：角色还没选（新建表单刚打开）时不算固定，显示四选一', () => {
    expect(rhythmOf('').options).toHaveLength(4)
    expect(isFixedRhythmRole('')).toBe(false)
  })

  it('切换执行风格时节奏一项随之切换显示方式（改选的角色决定显示什么）', () => {
    expect(rhythmOf('sentinel').options).toHaveLength(4)
    expect(rhythmOf('executor').options).toEqual([])
  })

  it('不再有「试岗」「转正」的说明文字', () => {
    for (const role of ['executor', 'sentinel'] as const) {
      const tree = createHookHost().render(BotConfigFields, { ...baseProps, draft: draftOf(role) }) as StubElement
      const text = textOf(tree)
      for (const word of ['试岗', '转正', '7 天']) expect(text).not.toContain(word)
    }
  })

  it('新建时：执行类的提交参数里没有 onDemand、autonomy、pace；值守类照所选档位提交', () => {
    const executor = buildCreateBotInput({ ...draftOf('executor'), rhythm: 'drive' })
    for (const key of ['onDemand', 'autonomy', 'pace']) expect(executor).not.toHaveProperty(key)
    const sentinel = buildCreateBotInput({ ...draftOf('sentinel'), rhythm: 'drive' })
    expect(sentinel).toMatchObject({ onDemand: false, autonomy: 'L2', pace: 'active' })
  })

  it('保存时：执行类改了节奏草稿也不提交；值守类改了才提交；执行类改成值守类后可以提交', () => {
    const initial = { ...draftOf('executor'), rhythm: 'on_demand' as const }
    expect(buildProfilePatch({ ...initial, rhythm: 'drive' }, initial)).toEqual({})
    const sentinelInitial = { ...draftOf('sentinel'), rhythm: 'advise' as const }
    expect(buildProfilePatch({ ...sentinelInitial, rhythm: 'act' }, sentinelInitial)).toEqual({ autonomy: 'L2', pace: 'normal', onDemand: false })
    expect(buildProfilePatch({ ...initial, role: 'sentinel', rhythm: 'act' }, initial)).toMatchObject({ role: 'sentinel', autonomy: 'L2', onDemand: false })
  })
})

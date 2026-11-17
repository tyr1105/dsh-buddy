/**
 * P73r4 沙箱走查修复里属于界面的测试：
 * 第 1 条：编辑弹窗里归档二次确认框出现期间，「保存」不可用并写「先确认或取消归档」；取消或确认后恢复。
 * 第 3 条：模板有显示标签的员工，左栏行、编辑弹窗标题、对话顶部统一用模板标签；从头配置的照旧。
 * 第 4 条：组队卡入职后在册超过上限时确认按钮不可用并写明原因；回到上限内恢复。
 * （第 2 条的选文件夹测试在 p73e-team-question-card.test.ts 里；第 5 条在 core 测试里。）
 * 用 hook 宿主渲染真实组件，子组件不展开。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TeamCard } from '../src/client/components/TeamCard.js'
import { TeammateEditDialog } from '../src/client/components/TeammateEditDialog.js'
import { displayRoleLabel, roleLineOf } from '../src/client/logic/agreement.js'
import { SAVE_BLOCKED_BY_ARCHIVE_NOTE, saveBlockedByArchive, type ArchiveConfirmInfo } from '../src/client/logic/lifecycle.js'
import { rosterOverflow } from '../src/client/logic/team-card.js'
import { sampleAdditionProposal, sampleInitialProposal, sampleViewOfProposal } from '../src/shared/fixture-team.js'
import { fixtureBots, fixtureOverview } from '../src/shared/fixtures.js'
import type { BotView, TeamCardView } from '../src/shared/views.js'
import { createHookHost } from './helpers/hook-host.js'
import { findElements, type StubElement } from './helpers/jsx-runtime-stub.js'

vi.mock('react', async () => (await import('./helpers/hook-host.js')).reactFacade)
vi.mock('react-dom', () => ({ createPortal: () => null }))

afterEach(() => { vi.unstubAllGlobals() })

function textOf(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object' && node !== null && 'props' in node) return textOf((node as StubElement).props.children)
  return ''
}

// ---------------------------------------------------------------------------
// 第 1 条：归档确认期间保存不可用
// ---------------------------------------------------------------------------

describe('第 1 条：归档确认框出现期间保存不可用', () => {
  const tanlu = fixtureBots['bot-tanlu']!

  function setup(archiveCheck: ArchiveConfirmInfo = { canArchive: true, reason: null, memberProjects: [] }, bot: BotView = tanlu) {
    const exec = vi.fn(async () => true)
    const onClose = vi.fn()
    const props: Parameters<typeof TeammateEditDialog>[0] = {
      bot, roster: fixtureOverview.bots, modelOptions: [], presetSkillOptions: [], dshSkillOptions: [],
      runner: { busy: false, message: null, success: false, exec, setMessage: () => undefined },
      onCheckArchive: async () => archiveCheck, onRefresh: () => undefined, onClose,
    }
    const host = createHookHost()
    const render = (): StubElement => host.render(TeammateEditDialog, props) as StubElement
    return { render, exec, onClose }
  }
  const footerButton = (tree: StubElement, label: string): StubElement => findElements(tree.props.footer, 'button').find(button => textOf(button) === label)!
  const statusButton = (tree: StubElement, label: string): StubElement => {
    const row = findElements(tree.props.children, 'div').find(node => node.props.className === 'ah-choice-row')!
    return findElements(row, 'button').find(button => textOf(button) === label)!
  }
  const confirmBlock = (tree: StubElement): StubElement | undefined => findElements(tree.props.children, 'div').find(node => node.props.className === 'ah-archive-confirm')
  const noteShown = (tree: StubElement): boolean => textOf(tree.props.footer).includes(SAVE_BLOCKED_BY_ARCHIVE_NOTE)

  it('纯逻辑：有确认框时不可保存，没有时可保存', () => {
    expect(saveBlockedByArchive(null)).toBe(false)
    expect(saveBlockedByArchive({ phase: 'checking' })).toBe(true)
    expect(saveBlockedByArchive({ phase: 'ready', info: { canArchive: false, reason: '现在不能归档。' } })).toBe(true)
  })

  it('没选归档时：保存可用，旁边没有说明', () => {
    const tree = setup().render()
    expect(footerButton(tree, '保存').props.disabled).toBe(false)
    expect(noteShown(tree)).toBe(false)
  })

  it('选了归档、确认框出现：保存不可用，旁边写「先确认或取消归档」；点保存不发任何命令', async () => {
    const { render, exec, onClose } = setup()
    ;(statusButton(render(), '归档').props.onClick as () => void)()
    await vi.waitFor(() => expect(confirmBlock(render())).toBeDefined())
    await vi.waitFor(() => expect(textOf(confirmBlock(render()))).toContain('确认归档'))
    const tree = render()
    expect(footerButton(tree, '保存').props.disabled).toBe(true)
    expect(noteShown(tree)).toBe(true)
    // 取消按钮仍可用，方便离开。
    expect(footerButton(tree, '取消').props.disabled).toBe(false)
    expect(exec).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('点确认框里的「取消」后：保存恢复可用，说明消失', async () => {
    const { render } = setup()
    ;(statusButton(render(), '归档').props.onClick as () => void)()
    await vi.waitFor(() => expect(confirmBlock(render())).toBeDefined())
    const cancel = findElements(confirmBlock(render()), 'button').find(button => textOf(button) === '取消')!
    ;(cancel.props.onClick as () => void)()
    const tree = render()
    expect(confirmBlock(tree)).toBeUndefined()
    expect(footerButton(tree, '保存').props.disabled).toBe(false)
    expect(noteShown(tree)).toBe(false)
  })

  it('不能归档（检查不通过）时确认框也在，保存同样不可用，取消后恢复', async () => {
    const { render } = setup({ canArchive: false, reason: '它还有在办的事。' })
    ;(statusButton(render(), '归档').props.onClick as () => void)()
    await vi.waitFor(() => expect(textOf(confirmBlock(render()))).toContain('它还有在办的事。'))
    expect(footerButton(render(), '保存').props.disabled).toBe(true)
    const cancel = findElements(confirmBlock(render()), 'button').find(button => textOf(button) === '取消')!
    ;(cancel.props.onClick as () => void)()
    expect(footerButton(render(), '保存').props.disabled).toBe(false)
  })

  it('点「确认归档」后发 archive 命令并关闭弹窗', async () => {
    const { render, exec, onClose } = setup()
    ;(statusButton(render(), '归档').props.onClick as () => void)()
    await vi.waitFor(() => expect(textOf(confirmBlock(render()))).toContain('确认归档'))
    const confirm = findElements(confirmBlock(render()), 'button').find(button => textOf(button) === '确认归档')!
    ;(confirm.props.onClick as () => void)()
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(exec).toHaveBeenCalledWith('lifecycleAction', { botId: tanlu.card.id, action: 'archive' }, expect.any(String))
  })
})

// ---------------------------------------------------------------------------
// 第 3 条：角色显示统一用模板标签
// ---------------------------------------------------------------------------

describe('第 3 条：角色显示统一用模板标签', () => {
  const base = fixtureBots['bot-tanlu']!
  const reviewer: BotView = { ...base, card: { ...base.card, name: '评审员', role: 'advisor', roleLabel: '建议', templateLabel: '评审' } }
  const scratch: BotView = { ...base, card: { ...base.card, name: '自配', role: 'advisor', roleLabel: '建议', templateLabel: null } }

  it('displayRoleLabel：有模板标签用模板标签；null、空串、缺字段都退回角色标签', () => {
    expect(displayRoleLabel({ roleLabel: '建议', templateLabel: '评审' })).toBe('评审')
    expect(displayRoleLabel({ roleLabel: '建议', templateLabel: null })).toBe('建议')
    expect(displayRoleLabel({ roleLabel: '建议', templateLabel: '' })).toBe('建议')
    expect(displayRoleLabel({ roleLabel: '建议' })).toBe('建议')
  })

  it('左栏员工行：评审员写「评审　在岗」；从头配置的仍写「建议　在岗」', () => {
    const line = (card: BotView['card']): string => roleLineOf({ ...card, staffStatusLabel: '在岗' })
    expect(line(reviewer.card)).toBe('评审　在岗')
    expect(line(scratch.card)).toBe('建议　在岗')
  })

  it('编辑弹窗标题：评审员带「评审」，从头配置的带「建议」', () => {
    const titleOf = (bot: BotView): string => {
      const props: Parameters<typeof TeammateEditDialog>[0] = {
        bot, roster: fixtureOverview.bots, modelOptions: [], presetSkillOptions: [], dshSkillOptions: [],
        runner: { busy: false, message: null, success: false, exec: vi.fn(async () => true), setMessage: () => undefined },
        onCheckArchive: async () => ({ canArchive: true, reason: null }), onRefresh: () => undefined, onClose: () => undefined,
      }
      return String((createHookHost().render(TeammateEditDialog, props) as StubElement).props.title)
    }
    expect(titleOf(reviewer)).toBe('编辑员工：评审员（评审）')
    expect(titleOf(scratch)).toBe('编辑员工：自配（建议）')
  })
})

// ---------------------------------------------------------------------------
// 第 4 条：在册超过上限时确认按钮不可用
// ---------------------------------------------------------------------------

describe('第 4 条：入职后在册超过上限时确认按钮不可用', () => {
  const initial: TeamCardView = sampleViewOfProposal(sampleInitialProposal)
  const addition: TeamCardView = sampleViewOfProposal(sampleAdditionProposal)
  const withRoster = (card: TeamCardView, rosterText: string): TeamCardView => ({ ...card, footer: { ...card.footer, rosterText } })
  const mount = (card: TeamCardView) => createHookHost().render(TeamCard, { card, onEdit: async () => null, onConfirm: async () => null })
  const confirmButton = (tree: unknown, card: TeamCardView): StubElement => findElements(tree, 'button').find(button => textOf(button) === card.confirmLabel)!

  it('rosterOverflow：7 / 6 超限并取实际上限；6 / 6 不超；文字取不到、卡已处理时当作没超', () => {
    expect(rosterOverflow(withRoster(initial, '入职后在册 7 / 6 位（含总管）'))).toEqual({
      limit: 6, text: '入职后在册会超过 6 位。先在卡上去掉一位，或在员工卡片里归档一位。',
    })
    expect(rosterOverflow(withRoster(initial, '入职后在册 6 / 6 位（含总管）'))).toBeNull()
    expect(rosterOverflow(withRoster(initial, '入职后在册 5 / 6 位（含总管）'))).toBeNull()
    // 上限不是 6 时，数字取实际上限。
    expect(rosterOverflow(withRoster(initial, '入职后在册 9 / 8 位（含总管）'))?.limit).toBe(8)
    expect(rosterOverflow(withRoster(initial, '看不懂的文字'))).toBeNull()
    expect(rosterOverflow({ ...withRoster(initial, '入职后在册 7 / 6 位'), state: 'confirmed' })).toBeNull()
  })

  it('超限：确认按钮不可用，旁边写明原因和做法', () => {
    const card = withRoster(initial, '入职后在册 7 / 6 位（含总管）')
    const tree = mount(card)
    expect(confirmButton(tree, card).props.disabled).toBe(true)
    expect(textOf(tree)).toContain('入职后在册会超过 6 位。先在卡上去掉一位，或在员工卡片里归档一位。')
  })

  it('人数回到上限以内：按钮恢复，说明消失', () => {
    const card = withRoster(initial, '入职后在册 6 / 6 位（含总管）')
    const tree = mount(card)
    expect(confirmButton(tree, card).props.disabled).toBe(false)
    expect(textOf(tree)).not.toContain('入职后在册会超过')
  })

  it('按需加人的卡超限：说明里不提「在卡上去掉」，只说归档', () => {
    const card = withRoster(addition, '入职后在册 7 / 6 位')
    const tree = mount(card)
    expect(confirmButton(tree, card).props.disabled).toBe(true)
    expect(textOf(tree)).toContain('入职后在册会超过 6 位。请先在员工卡片里归档一位。')
  })
})

/**
 * P73e：待你处理里的组队条目、员工列表标题与底部入口、第一次打开不弹模板库、模板库四处改动。
 * 用 hook 宿主渲染真实组件，子组件不展开。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InboxCard } from '../src/client/components/Cards.js'
import { itemToCard } from '../src/client/components/InboxPane.js'
import { BotTemplatePicker, TEMPLATE_BANNER_TEXT } from '../src/client/components/bot-template-picker.js'
import { NewBotWizard } from '../src/client/components/NewBotWizard.js'
import { PersonalityLines } from '../src/client/components/PersonalityLines.js'
import { TeammatesGroup, teammatesTitle, type TeammatesGroupProps } from '../src/client/components/sidebar-teammates-group.js'
import { buildTemplateInput, templateBlock, templateById, TEMPLATE_BLOCK_LABELS, type BotTemplate } from '../src/client/logic/bot-templates.js'
import { addTeammatesFromTemplates, type WizardCreateHub } from '../src/client/logic/wizard-create.js'
import { createHubStore } from '../src/client/hub-state.js'
import { HubPage } from '../src/client/pages/HubPage.js'
import { fixtureInbox, fixtureOverview } from '../src/shared/fixtures.js'
import { SAMPLE_ADDITION_PROPOSAL_ID } from '../src/shared/fixture-team.js'
import type { BotCard } from '../src/shared/views.js'
import { createHookHost } from './helpers/hook-host.js'
import { findElements, type StubElement } from './helpers/jsx-runtime-stub.js'

vi.mock('react', async () => (await import('./helpers/hook-host.js')).reactFacade)
vi.mock('react-dom', () => ({ createPortal: () => null }))

beforeEach(() => {
  vi.stubGlobal('fetch', () => new Promise(() => undefined))
  vi.stubGlobal('window', { addEventListener: () => undefined, removeEventListener: () => undefined })
})
afterEach(() => { vi.unstubAllGlobals() })

function textOf(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object' && node !== null && 'props' in node) return textOf((node as StubElement).props.children)
  return ''
}
const buttonsOf = (tree: unknown): StubElement[] => findElements(tree, 'button')
const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

// ---------------------------------------------------------------------------
// 待你处理里的组队条目
// ---------------------------------------------------------------------------

describe('待你处理：组队条目', () => {
  const item = fixtureInbox.items.find(entry => entry.teamProposalId === SAMPLE_ADDITION_PROPOSAL_ID)!
  const render = () => createHookHost().render(InboxCard, { card: itemToCard(item), actions: { onPick: async () => null }, busy: false, priority: item.priority })

  it('只有一个按钮，文字取条目的 options[0]，没有「（默认）」', () => {
    const tree = render()
    const buttons = buttonsOf(tree)
    expect(buttons).toHaveLength(1)
    expect(textOf(buttons[0])).toBe(item.options[0])
    expect(textOf(tree)).not.toContain('默认')
  })

  it('没有自由文本输入，写「不会自动入职」，不显示到期', () => {
    const tree = render()
    expect(findElements(tree, 'input')).toHaveLength(0)
    expect(textOf(tree)).toContain('不会自动入职')
    expect(textOf(tree)).not.toContain('按默认')
    expect(textOf(tree)).not.toContain('前未答复')
  })

  it('点按钮：原样回传按钮文字', async () => {
    const onPick = vi.fn(async () => null)
    const tree = createHookHost().render(InboxCard, { card: itemToCard(item), actions: { onPick }, busy: false })
    ;(buttonsOf(tree)[0]!.props.onClick as () => void)()
    await flush()
    expect(onPick).toHaveBeenCalledTimes(1)
    const [card, option] = onPick.mock.calls[0] as unknown as [{ teamProposalId?: string }, string]
    expect(card.teamProposalId).toBe(SAMPLE_ADDITION_PROPOSAL_ID)
    expect(option).toBe(item.options[0])
  })

  it('反例：普通提问条目仍有自由文本输入、有默认处理和到期说明', () => {
    const normal = fixtureInbox.items.find(entry => entry.id === 'inbox-q1')!
    const tree = createHookHost().render(InboxCard, { card: itemToCard(normal), actions: { onPick: async () => null }, busy: false })
    expect(findElements(tree, 'input').length).toBeGreaterThan(0)
    expect(textOf(tree)).toContain('（默认）')
    expect(textOf(tree)).not.toContain('不会自动入职')
  })
})

// ---------------------------------------------------------------------------
// 员工列表：标题与底部入口
// ---------------------------------------------------------------------------

function groupProps(over: Partial<TeammatesGroupProps> = {}): TeammatesGroupProps {
  return {
    expanded: true, onToggle: () => undefined, totalBots: fixtureOverview.bots.length,
    query: '', onQueryChange: () => undefined, view: 'main', selectedThread: 'bot-tanlu',
    bots: fixtureOverview.bots, archivedBots: [], archivedOpen: false, onToggleArchived: () => undefined,
    notice: null, onBeginDelete: () => undefined,
    onSelectBot: () => undefined, onNewBot: () => undefined, onOpenBotForm: () => undefined,
    onBotFormProjectChange: () => undefined, form: null, botFormProjects: [], formBot: null, formNode: null,
    ...over,
  }
}

describe('员工列表：标题「员工 N / 6」与底部入口', () => {
  it('三位在册：标题写「员工 3 / 6」', () => {
    expect(teammatesTitle(3, 6)).toBe('员工 3 / 6')
    const title = findElements(TeammatesGroup(groupProps()), 'span').find(node => node.props.className === 'ah-nav-group-title')!
    expect(textOf(title)).toBe('员工 3 / 6')
  })

  it('上限可传入；只有总管一位时写「员工 1 / 6」', () => {
    expect(teammatesTitle(1)).toBe('员工 1 / 6')
    expect(teammatesTitle(2, 8)).toBe('员工 2 / 8')
  })

  it('底部入口文字「从模板库添加」，点它打开模板库（与「＋」同一个回调）', () => {
    const onNewBot = vi.fn()
    const tree = TeammatesGroup(groupProps({ onNewBot }))
    const entry = buttonsOf(tree).find(node => textOf(node) === '从模板库添加')!
    expect(entry).toBeDefined()
    ;(entry.props.onClick as () => void)()
    expect(onNewBot).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// 第一次打开不弹出模板库
// ---------------------------------------------------------------------------

describe('第一次打开（名册里只有总管）不弹出模板库', () => {
  it('中心页挂载后没有新建员工弹窗，也没有模板库', () => {
    const chief = fixtureOverview.bots.find(bot => bot.role === 'chief')!
    const hub = createHubStore()
    hub.update(prev => ({ ...prev, overview: { ...fixtureOverview, bots: [chief] }, view: 'main', selectedThread: chief.id }))
    const tree = createHookHost().render(HubPage, { hub, clientCtx: null })
    expect(findElements(tree, NewBotWizard)).toHaveLength(0)
    expect(findElements(tree, BotTemplatePicker)).toHaveLength(0)
  })

  it('反例：主人点了入口（请求打开）之后才出现', () => {
    const chief = fixtureOverview.bots.find(bot => bot.role === 'chief')!
    const hub = createHubStore()
    hub.update(prev => ({ ...prev, overview: { ...fixtureOverview, bots: [chief] }, view: 'main', selectedThread: chief.id }))
    const host = createHookHost()
    host.render(HubPage, { hub, clientCtx: null })
    hub.requestNewBot()
    const tree = host.render(HubPage, { hub, clientCtx: null })
    expect(findElements(tree, NewBotWizard)).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// 模板库四处改动
// ---------------------------------------------------------------------------

/** 一个样例员工：只填模板库用到的字段。 */
function roster(name: string, role: BotCard['role'] = 'executor'): BotCard {
  return { ...fixtureOverview.bots[0]!, id: `bot-${name}`, name, role, lifecycle: 'active', archived: false }
}
const team: BotCard[] = [roster('总管', 'chief'), roster('林舟'), roster('评审员', 'advisor')]

function mountPicker(over: Partial<Parameters<typeof BotTemplatePicker>[0]> = {}) {
  const onAdd = vi.fn()
  const host = createHookHost()
  const props = { existingBots: team, presetSkillOptions: [], submitting: false, error: null, onAdd, onCustom: () => undefined, onClose: () => undefined, ...over }
  return { host, props, onAdd, render: () => host.render(BotTemplatePicker, props) }
}
const cardNamed = (tree: unknown, name: string): StubElement => buttonsOf(tree).find(node => String(node.props.className ?? '').includes('ah-template-card') && textOf(node).startsWith(name))!

describe('模板库：顶部提示、卡片属性、已有标记、底部文字、添加', () => {
  it('弹窗标题「从模板库添加员工」，顶部一行提示把不确定的人引回总管', () => {
    const tree = mountPicker().render()
    expect(textOf(findElements(tree, 'h2')[0])).toBe('从模板库添加员工')
    const banner = findElements(tree, 'p').find(node => node.props.className === 'ah-template-banner')!
    expect(textOf(banner)).toBe('不确定要谁？关掉这里，直接告诉总管你要做什么，由它推荐。')
    expect(TEMPLATE_BANNER_TEXT).toBe(textOf(banner))
  })

  it('卡片底部属性写「角色 · MBTI · 模型档位」', () => {
    const tree = mountPicker().render()
    expect(textOf(cardNamed(tree, '设计师'))).toContain('执行 · ISFJ · 标准档')
    expect(textOf(cardNamed(tree, '产品经理'))).toContain('调研 · INTP · 标准档')
  })

  it('评审员已有：卡片标「全队一位，已有」，不能选；项目经理在已有总管时标「已有总管」', () => {
    const tree = mountPicker().render()
    const reviewer = cardNamed(tree, '评审员')
    expect(textOf(reviewer)).toContain('全队一位，已有')
    expect(reviewer.props['aria-disabled']).toBe(true)
    expect(templateBlock(templateById('reviewer')!, team, [])).toBe('unique_taken')
    expect(TEMPLATE_BLOCK_LABELS.unique_taken).toBe('全队一位，已有')
    // 总管自己：与「已有总管」同一套规则（P73d 遗留：项目经理在有总管时必然失败，所以置灰）。
    expect(templateBlock(templateById('project-manager')!, team, [])).toBe('chief_taken')
    expect(textOf(cardNamed(tree, '项目经理'))).toContain('已有总管')
  })

  it('点已有的评审员不会选中它；点设计师选中，底部写「已选 1 位：设计师。添加后在册 4 / 6 位。不另跑试用，第一件事就是试用。」', () => {
    const m = mountPicker()
    ;(cardNamed(m.render(), '评审员').props.onClick as () => void)()
    expect(textOf(findElements(m.render(), 'p').find(node => node.props.className === 'ah-template-summary'))).toBe('')
    ;(cardNamed(m.render(), '设计师').props.onClick as () => void)()
    const tree = m.render()
    expect(textOf(findElements(tree, 'p').find(node => node.props.className === 'ah-template-summary'))).toBe('已选 1 位：设计师。添加后在册 4 / 6 位。不另跑试用，第一件事就是试用。')
    expect(textOf(tree)).not.toContain('先试跑一次')
    const add = buttonsOf(tree).find(node => textOf(node) === '添加 1 位员工')!
    expect(add.props.disabled).toBe(false)
    ;(add.props.onClick as () => void)()
    expect(m.onAdd).toHaveBeenCalledTimes(1)
    expect((m.onAdd.mock.calls[0]![0] as BotTemplate[]).map(template => template.id)).toEqual(['designer'])
  })

  it('选了两位：在册数按已有加已选算', () => {
    const m = mountPicker()
    ;(cardNamed(m.render(), '设计师').props.onClick as () => void)()
    ;(cardNamed(m.render(), '产品经理').props.onClick as () => void)()
    expect(textOf(findElements(m.render(), 'p').find(node => node.props.className === 'ah-template-summary')))
      .toBe('已选 2 位：设计师、产品经理。添加后在册 5 / 6 位。不另跑试用，第一件事就是试用。')
  })

  it('详情里「MBTI」一行带四句话（PersonalityLines），轻档不可用时卡片写标准档', () => {
    const tree = mountPicker().render()
    const lines = findElements(tree, PersonalityLines)
    expect(lines).toHaveLength(1)
    expect((lines[0]!.props.lines as unknown[]).length).toBe(4)
    expect(textOf(cardNamed(mountPicker({ lightAvailable: true }).render(), '工程师'))).toContain('标准档')
    // 评审员建议轻档，但已有人所以显示已有；换一个没人的名册看档位。
    const noReviewer = mountPicker({ existingBots: [roster('总管', 'chief')], lightAvailable: false }).render()
    expect(textOf(cardNamed(noReviewer, '评审员'))).toContain('评审 · ISTJ · 标准档')
    const withLight = mountPicker({ existingBots: [roster('总管', 'chief')], lightAvailable: true }).render()
    expect(textOf(cardNamed(withLight, '评审员'))).toContain('评审 · ISTJ · 轻档')
  })
})

describe('从模板库添加：createBot 带 templateId', () => {
  it('每位的 createBot 入参里都有它的模板标识', async () => {
    const calls: Array<{ name: string; input: Record<string, unknown> }> = []
    const hub: WizardCreateHub = {
      command: async (name, input) => { calls.push({ name, input }); return { ok: true, data: { id: `b_${calls.length}` } } },
      refreshOverview: async () => undefined,
    }
    await addTeammatesFromTemplates(hub, [templateById('designer')!, templateById('product-manager')!], [{ name: '总管' }])
    const creates = calls.filter(call => call.name === 'createBot')
    expect(creates.map(call => call.input.templateId)).toEqual(['designer', 'product-manager'])
    expect(buildTemplateInput(templateById('engineer')!).templateId).toBe('engineer')
  })
})

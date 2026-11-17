/**
 * P72e 约定界面的组件测试：约定卡四种状态、草图、主题第一层面板、待你处理的约定条目、
 * 员工列表里的总管、总管私聊的输入框占位，以及「定了」命令的接线（真引擎门面与离线样例）。
 *
 * 用 hook 宿主渲染真实组件：只看这一层组件交出了什么元素，子组件不展开；
 * 约定卡把所有块写在同一个文件的普通函数里，所以小标题、选项、按钮都能直接在元素树里找到。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgreementCard } from '../src/client/components/AgreementCard.js'
import { AgreementPanel } from '../src/client/components/AgreementPanel.js'
import { AgreementSketch } from '../src/client/components/AgreementSketch.js'
import { InboxCard } from '../src/client/components/Cards.js'
import { itemToCard } from '../src/client/components/InboxPane.js'
import { TeammatesGroup, type TeammatesGroupProps } from '../src/client/components/sidebar-teammates-group.js'
import { ThreadPane } from '../src/client/components/ThreadPane.js'
import { TopicThreadBody } from '../src/client/components/TopicThreadBody.js'
import { initialChoices } from '../src/client/logic/agreement.js'
import { buildTopicThread } from '../src/client/logic/topics.js'
import { dispatchCommand } from '../src/host/real-hub.js'
import { FixtureHub } from '../src/host/hub-facade.js'
import { fixtureTopicThreads } from '../src/shared/fixture-project.js'
import { sampleAgreementPanel, sampleAgreementV1, sampleAgreementV2 } from '../src/shared/fixture-agreement.js'
import { fixtureInbox, fixtureOverview } from '../src/shared/fixtures.js'
import type { AgreementCardView, BotCard, ThreadView } from '../src/shared/views.js'
import { createHookHost } from './helpers/hook-host.js'
import { findElements, type StubElement } from './helpers/jsx-runtime-stub.js'

vi.mock('react', async () => (await import('./helpers/hook-host.js')).reactFacade)

afterEach(() => { vi.unstubAllGlobals() })

/** 把元素树里的文字拼起来；子组件不展开。 */
function textOf(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object' && node !== null && 'props' in node) return textOf((node as StubElement).props.children)
  return ''
}
const buttonsOf = (tree: unknown): StubElement[] => findElements(tree, 'button')
const buttonNamed = (tree: unknown, label: string): StubElement | undefined => buttonsOf(tree).find(node => textOf(node) === label)
const radiosOf = (tree: unknown): StubElement[] => buttonsOf(tree).filter(node => node.props.role === 'radio')
const classOf = (node: StubElement): string => String(node.props.className ?? '')
/** 等 Promise 链跑完（点击后的 then 回调）。 */
const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

/** 样例第 2 版（待确认）和从它推出的已固定版。 */
const pending: AgreementCardView = sampleAgreementV2
const lockedCard: AgreementCardView = {
  ...pending, state: 'locked', stateLabel: '已固定', agreementState: 'locked', canConfirm: false,
  lockedAt: new Date(2026, 10, 11, 15, 39).getTime(), lockedText: '11月11日 15:39',
  pending: pending.pending.map(item => ({ ...item, chosen: item.suggested })),
  adoption: { adopted: 3, total: 4 }, rapport: { adopted: 17, total: 20 },
}

describe('约定卡：待你确认', () => {
  it('六块小标题都在，建议项初始选中，建议项旁标「建议」', () => {
    // P72g B3：第 2 版起默认只显示改动，这条要看完整版面，所以用 startExpanded 展开全文。
    const tree = createHookHost().render(AgreementCard, { card: pending, onConfirm: async () => null, startExpanded: true })
    const headings = findElements(tree, 'p').filter(node => classOf(node) === 'ah-agr-sec-h').map(textOf)
    for (const title of ['一句话', '草图', '待你定（4 项）', '我已定的（6 项）', '这次做', '这次不做', '怎样算做完']) {
      expect(headings.some(text => text.startsWith(title))).toBe(true)
    }
    // 草图里有圆圈数字，小标题后注明对应关系；怎样算做完带提示。
    expect(headings.find(text => text.startsWith('草图'))).toContain('圆圈数字对应下方待你定的事项')
    expect(headings.find(text => text.startsWith('待你定'))).toContain('已按建议选好，不同意就点别的选项')
    expect(headings.find(text => text.startsWith('我已定的'))).toContain('不同意哪条，直接在输入框说')
    expect(headings.find(text => text.startsWith('怎样算做完'))).toContain('你可以逐条亲自验证')
    // 每个待定项一个单选组；选中的恰好是建议项。
    expect(findElements(tree, 'div').filter(node => node.props.role === 'radiogroup')).toHaveLength(4)
    const checked = radiosOf(tree).filter(node => node.props['aria-checked'] === true).map(textOf)
    expect(checked).toEqual(pending.pending.map(item => `${item.suggested}建议`))
    // 依据标签逐条显示；定了按钮和提示在底部。
    expect(textOf(tree)).toContain('依据：你定过的规矩「非必要不收集个人信息」')
    expect(buttonNamed(tree, '定了')).toBeDefined()
    expect(textOf(tree)).toContain('要改哪里，直接在下方输入框写，我改好后再给你看。')
  })

  it('点「定了」以 (agreementId, version, choices) 调用提交函数，按钮随即禁用', () => {
    const onConfirm = vi.fn(async () => null)
    const host = createHookHost()
    const props = { card: pending, onConfirm }
    const tree = host.render(AgreementCard, props)
    ;(buttonNamed(tree, '定了')!.props.onClick as () => void)()
    expect(onConfirm).toHaveBeenCalledWith(pending.agreementId, 2, initialChoices(pending))
    expect(buttonNamed(host.render(AgreementCard, props), '定了')!.props.disabled).toBe(true)
  })

  it('改了一项再点「定了」：该项是新选项，其余是建议', () => {
    const onConfirm = vi.fn(async () => null)
    const host = createHookHost()
    // P72g B3：没改的待定项默认收起，要改它得先展开全文（startExpanded 等同点了「展开全文」）。
    const props = { card: pending, onConfirm, startExpanded: true }
    const first = host.render(AgreementCard, props)
    const other = radiosOf(first).find(node => textOf(node) === '限制人数，满额后停止报名')!
    ;(other.props.onClick as () => void)()
    const second = host.render(AgreementCard, props)
    // 选中状态跟着变：新选项选中，原建议项不再选中。
    expect(radiosOf(second).find(node => textOf(node) === '限制人数，满额后停止报名')!.props['aria-checked']).toBe(true)
    expect(radiosOf(second).find(node => textOf(node) === '不限建议')!.props['aria-checked']).toBe(false)
    ;(buttonNamed(second, '定了')!.props.onClick as () => void)()
    expect(onConfirm).toHaveBeenCalledWith(pending.agreementId, 2, { ...initialChoices(pending), limit: '限制人数，满额后停止报名' })
  })

  it('提交返回错误：按钮复位，卡片底部显示错误；成功时保持禁用', async () => {
    const host = createHookHost()
    const failing = { card: pending, onConfirm: vi.fn(async () => '这一版已经不是待确认的状态') }
    const first = host.render(AgreementCard, failing)
    ;(buttonNamed(first, '定了')!.props.onClick as () => void)()
    await flush()
    const after = host.render(AgreementCard, failing)
    expect(buttonNamed(after, '定了')!.props.disabled).toBe(false)
    const alert = findElements(after, 'p').find(node => node.props.role === 'alert')
    expect(alert && textOf(alert)).toBe('这一版已经不是待确认的状态')

    const okHost = createHookHost()
    const ok = { card: pending, onConfirm: vi.fn(async () => null) }
    ;(buttonNamed(okHost.render(AgreementCard, ok), '定了')!.props.onClick as () => void)()
    await flush()
    expect(buttonNamed(okHost.render(AgreementCard, ok), '定了')!.props.disabled).toBe(true)
  })

  it('反例：没有提交函数、只读、不可确认时不显示「定了」，选项不可点', () => {
    for (const props of [{ card: pending }, { card: pending, onConfirm: async () => null, readOnly: true }, { card: { ...pending, canConfirm: false }, onConfirm: async () => null }]) {
      const tree = createHookHost().render(AgreementCard, props)
      expect(buttonNamed(tree, '定了')).toBeUndefined()
      expect(radiosOf(tree).every(node => node.props.disabled === true)).toBe(true)
    }
  })
})

describe('约定卡：被取代、已固定、已撤下', () => {
  it('被第 2 版取代：折叠成一行，没有「定了」也没有选项；点一下展开只读全文', () => {
    const host = createHookHost()
    const props = { card: sampleAgreementV1, onConfirm: async () => null }
    const tree = host.render(AgreementCard, props)
    const text = textOf(tree)
    for (const part of ['约定', '活动报名页', '第 1 版', '已由第 2 版取代']) expect(text).toContain(part)
    expect(buttonNamed(tree, '定了')).toBeUndefined()
    expect(radiosOf(tree)).toHaveLength(0)
    expect(text).not.toContain('一句话') // 折叠态没有全文
    const row = buttonsOf(tree).find(node => classOf(node) === 'ah-agr-fold-row')!
    expect(row.props['aria-expanded']).toBe(false)
    ;(row.props.onClick as () => void)()
    const open = host.render(AgreementCard, props)
    expect(textOf(open)).toContain('一句话')
    expect(buttonNamed(open, '定了')).toBeUndefined()
    expect(radiosOf(open).every(node => node.props.disabled === true)).toBe(true)
  })

  it('被替换（replaced）同样折叠，文字是「已被第 M 版替换」', () => {
    const tree = createHookHost().render(AgreementCard, { card: { ...sampleAgreementV1, state: 'replaced', supersededBy: 3 } })
    expect(textOf(tree)).toContain('已被第 3 版替换')
    expect(buttonNamed(tree, '定了')).toBeUndefined()
  })

  it('已固定：没有选项和「定了」，有印章、一句话、你选了：定了，以及采纳句和累计默契度', () => {
    const tree = createHookHost().render(AgreementCard, { card: lockedCard, onConfirm: async () => null })
    expect(radiosOf(tree)).toHaveLength(0)
    expect(buttonNamed(tree, '定了')).toBeUndefined()
    const seal = findElements(tree, 'span').find(node => classOf(node).startsWith('ah-agr-seal'))!
    expect(seal.props.role).toBe('img')
    expect(textOf(seal)).toBe('定11.11')
    const text = textOf(tree)
    expect(text).toContain('已固定 11月11日 15:39')
    expect(text).toContain(lockedCard.summary.text)
    expect(text).toContain('你选了：定了。之后要改约定，直接告诉我，我会出新版本请你确认。')
    expect(text).toContain('这次你采纳了总管 4 条建议中的 3 条。累计默契度 17 / 20。')
    expect(buttonNamed(tree, '展开全文')).toBeDefined()
  })

  it('已固定但没有 adoption（后来的版本）：不显示采纳句；rapport 为 null 时省略累计', () => {
    expect(textOf(createHookHost().render(AgreementCard, { card: { ...lockedCard, adoption: null, rapport: null } }))).not.toContain('采纳了总管')
    const tree = createHookHost().render(AgreementCard, { card: { ...lockedCard, rapport: null } })
    expect(textOf(tree)).toContain('这次你采纳了总管 4 条建议中的 3 条。')
    expect(textOf(tree)).not.toContain('累计默契度')
  })

  it('展开全文：显示六块内容，选中的是 core 记下的选择，选项仍不可点', () => {
    const host = createHookHost()
    const props = { card: lockedCard }
    ;(buttonNamed(host.render(AgreementCard, props), '展开全文')!.props.onClick as () => void)()
    const open = host.render(AgreementCard, props)
    expect(textOf(open)).toContain('待你定（4 项）')
    expect(radiosOf(open).every(node => node.props.disabled === true)).toBe(true)
    expect(buttonNamed(open, '收起全文')).toBeDefined()
  })

  it('印章动效：同一张卡由待确认变已固定时播一次；挂载时已固定不播；减少动效不播', () => {
    const sealOf = (tree: unknown): StubElement => findElements(tree, 'span').find(node => classOf(node).startsWith('ah-agr-seal'))!
    const host = createHookHost()
    host.render(AgreementCard, { card: pending, onConfirm: async () => null })
    expect(classOf(sealOf(host.render(AgreementCard, { card: lockedCard })))).toContain('is-anim')
    // 页面加载时就已经固定：静态印章。
    expect(classOf(sealOf(createHookHost().render(AgreementCard, { card: lockedCard })))).not.toContain('is-anim')
    // 系统要求减少动态效果：即使由待确认变已固定也不播。
    vi.stubGlobal('window', { matchMedia: () => ({ matches: true }) })
    const reduced = createHookHost()
    reduced.render(AgreementCard, { card: pending })
    expect(classOf(sealOf(reduced.render(AgreementCard, { card: lockedCard })))).not.toContain('is-anim')
  })

  it('整份约定已撤下：折叠成一行「已撤下」，没有按钮', () => {
    const tree = createHookHost().render(AgreementCard, { card: { ...pending, agreementState: 'withdrawn', canConfirm: false } })
    expect(textOf(tree)).toContain('已撤下')
    expect(buttonsOf(tree)).toHaveLength(0)
  })
})

describe('约定卡：第 2 版的本版改动', () => {
  it('显示「本版改动」和 changeNote；changed 的条目带改动样式类，未改的不带', () => {
    // P72g B3：看全部条目的改动标记，需要展开全文。
    const tree = createHookHost().render(AgreementCard, { card: pending, onConfirm: async () => null, startExpanded: true })
    const text = textOf(tree)
    expect(text).toContain('本版改动')
    expect(text).toContain(pending.changeNote)
    const questions = findElements(tree, 'div').filter(node => classOf(node).startsWith('ah-agr-q ') || classOf(node) === 'ah-agr-q')
    expect(questions.map(node => classOf(node).includes('ah-agr-changed'))).toEqual([true, false, false, false])
    const doneItems = findElements(tree, 'li').filter(node => pending.doneWhen.some(item => item.text === textOf(node)))
    expect(doneItems.map(node => classOf(node).includes('ah-agr-changed'))).toEqual([false, false, false, true, false])
    // 一句话和草图整体也带改动底色。
    expect(findElements(tree, 'p').some(node => classOf(node).includes('ah-agr-one') && classOf(node).includes('ah-agr-changed'))).toBe(true)
    expect(findElements(tree, AgreementSketch)[0]!.props.changed).toBe(true)
  })

  it('反例：第 1 版没有「本版改动」，也没有改动样式类', () => {
    const v1 = { ...sampleAgreementV1, state: 'pending' as const, canConfirm: true, supersededBy: null }
    const tree = createHookHost().render(AgreementCard, { card: v1, onConfirm: async () => null })
    expect(textOf(tree)).not.toContain('本版改动')
    expect(findElements(tree, 'div').some(node => classOf(node).includes('ah-agr-changed'))).toBe(false)
  })
})

describe('草图：三种版式', () => {
  const pins = (tree: unknown): string[] => findElements(tree, 'span').filter(node => classOf(node) === 'ah-agr-pin').map(textOf)

  it('page：每屏一个线框，输入框必填加 *，mark 显示为对应数字', () => {
    const tree = createHookHost().render(AgreementSketch, { sketch: pending.sketch.value })
    expect(findElements(tree, 'div').filter(node => classOf(node) === 'ah-agr-frame')).toHaveLength(3)
    expect(textOf(tree)).toContain('姓名 *')
    expect(textOf(tree)).toContain('公司名（选填）')
    expect(pins(tree)).toEqual(['4', '1', '2', '3'])
    expect(findElements(tree, 'table')).toHaveLength(1)
  })

  it('flow：步骤成方框，actor 在上、note 在下，箭头只在步骤之间', () => {
    const tree = createHookHost().render(AgreementSketch, {
      sketch: { layout: 'flow', steps: [{ text: '填写报名', actor: '访客', mark: 1 }, { text: '导出名单', actor: '你', note: '表格文件', mark: 3 }] },
    })
    expect(findElements(tree, 'li').filter(node => classOf(node) === 'ah-agr-flow-item')).toHaveLength(2)
    expect(textOf(tree)).toContain('访客')
    expect(textOf(tree)).toContain('表格文件')
    expect(pins(tree)).toEqual(['1', '3'])
    expect(findElements(tree, 'span').filter(node => classOf(node) === 'ah-agr-arrow')).toHaveLength(1)
  })

  it('concept：节点成方框，连线写成「A → B：文字」，mark 显示数字', () => {
    const tree = createHookHost().render(AgreementSketch, {
      sketch: { layout: 'concept', nodes: [{ id: 'a', text: '访客' }, { id: 'b', text: '报名页', mark: 2 }], links: [{ from: 'a', to: 'b', text: '填写' }] },
    })
    expect(findElements(tree, 'li').filter(node => classOf(node) === 'ah-agr-box')).toHaveLength(2)
    expect(textOf(tree)).toContain('访客 → 报名页：填写')
    expect(pins(tree)).toEqual(['2'])
  })
})

describe('主题第一层：约定面板', () => {
  it('当前版本、状态、一句话、查看全文；改过 N 次，展开后每版一行，已固定的标「固定」', () => {
    const panel = { ...sampleAgreementPanel, current: lockedCard, revisions: [
      { no: 2, timeText: '11月11日 15:39', stateLabel: '已固定', text: '报名信息加入「公司名（选填）」', sourceLabel: '来源：你在对齐时的修改', locked: true },
      { no: 1, timeText: '11月11日 15:31', stateLabel: '已被取代', text: '初稿，未固定', sourceLabel: '来源：你在总管私聊里的要求', locked: false },
    ] }
    const tree = createHookHost().render(AgreementPanel, { panel })
    const text = textOf(tree)
    expect(text).toContain('第 2 版')
    expect(text).toContain('已固定 11月11日 15:39')
    expect(text).toContain(lockedCard.summary.text)
    expect(text).toContain('改过 1 次，查看改动')
    const rows = findElements(tree, 'li').map(textOf)
    expect(rows).toEqual([
      '第 2 版 11月11日 15:39 固定 报名信息加入「公司名（选填）」。来源：你在对齐时的修改。',
      '第 1 版 11月11日 15:31 初稿，未固定。来源：你在总管私聊里的要求。',
    ])
  })

  it('「查看全文」展开成只读的约定卡全文', () => {
    const host = createHookHost()
    const props = { panel: sampleAgreementPanel }
    const tree = host.render(AgreementPanel, props)
    expect(findElements(tree, AgreementCard)).toHaveLength(0)
    ;(buttonNamed(tree, '查看全文')!.props.onClick as () => void)()
    const open = host.render(AgreementPanel, props)
    const full = findElements(open, AgreementCard)[0]!
    expect(full.props.readOnly).toBe(true)
    expect(buttonNamed(open, '收起全文')).toBeDefined()
  })

  it('反例：没改过（revisionCount 为 0）不显示「改过 N 次」', () => {
    const tree = createHookHost().render(AgreementPanel, { panel: { ...sampleAgreementPanel, revisions: [sampleAgreementPanel.revisions[0]!], revisionCount: 0 } })
    expect(textOf(tree)).not.toContain('查看改动')
  })

  it('TopicThreadBody：有约定时画面板，第一层不是第一条消息；没有约定时仍是主题卡片', () => {
    const topic = fixtureTopicThreads.find(thread => thread.agreement)!
    const withAgreement = TopicThreadBody({
      model: buildTopicThread(topic.messages, false, { hasAgreement: true }), replying: [], actions: { onPick: async () => null },
      busyInboxId: null, agreement: topic.agreement ?? null,
    })
    expect(findElements(withAgreement, AgreementPanel)).toHaveLength(1)
    expect(findElements(withAgreement, 'section').some(node => node.props['aria-label'] === '主题')).toBe(false)
    // P72g B4：约定卡只在总管私聊里，主题楼层里不再放约定卡（面板已经是第一层）。
    // 楼层组件（TopicFloor，文件内私有）不会被宿主展开，这里取出所有楼层，确认没有一层带约定卡。
    const floors = (function walk(node: unknown): StubElement[] {
      if (Array.isArray(node)) return node.flatMap(walk)
      if (typeof node !== 'object' || node === null || !('props' in node)) return []
      const element = node as StubElement
      const own = typeof element.type === 'function' && element.type.name === 'TopicFloor' ? [element] : []
      return [...own, ...walk(element.props.children)]
    })(withAgreement)
    const agreementFloors = floors.filter(floor => (floor.props.message as { agreement?: unknown }).agreement)
    expect(floors.length).toBeGreaterThan(0)
    expect(agreementFloors).toHaveLength(0)
    expect(findElements(withAgreement, AgreementCard)).toHaveLength(0)
    expect(topic.messages.some(message => message.kind === 'agreement')).toBe(false)
    const plain = fixtureTopicThreads.find(thread => !thread.agreement)!
    const without = TopicThreadBody({ model: buildTopicThread(plain.messages, false), replying: [], actions: { onPick: async () => null }, busyInboxId: null })
    expect(findElements(without, AgreementPanel)).toHaveLength(0)
    expect(findElements(without, 'section').some(node => node.props['aria-label'] === '主题')).toBe(true)
  })
})

describe('待你处理里的约定条目', () => {
  const noopActions = { onPick: async () => null }
  const agreementItem = fixtureInbox.items.find(item => item.agreementId)!
  const plainQuestion = fixtureInbox.items.find(item => item.type === 'question' && !item.agreementId)!

  it('没有自由文本输入框，只有「按建议，定了」，有效期一行是固定的话，按钮不带「（默认）」', () => {
    const tree = createHookHost().render(InboxCard, { card: itemToCard(agreementItem), actions: noopActions, busy: false, priority: agreementItem.priority })
    expect(findElements(tree, 'input')).toHaveLength(0)
    expect(buttonsOf(tree).map(textOf)).toEqual(['按建议，定了'])
    expect(findElements(tree, 'p').find(node => classOf(node) === 'ah-card-expire')).toBeDefined()
    expect(textOf(findElements(tree, 'p').find(node => classOf(node) === 'ah-card-expire'))).toBe('不会自动按建议处理。你确认前不会开工。')
    expect(textOf(tree)).not.toContain('去对话里修改')
  })

  it('点按钮原样回传选项，走 onPick', () => {
    const onPick = vi.fn(async () => null)
    const tree = createHookHost().render(InboxCard, { card: itemToCard(agreementItem), actions: { onPick }, busy: false })
    ;(buttonsOf(tree)[0]!.props.onClick as () => void)()
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ inboxId: agreementItem.id, agreementId: agreementItem.agreementId }), '按建议，定了', undefined)
  })

  it('反例：普通提问仍有自由文本输入，选项旁仍有「（默认）」', () => {
    const tree = createHookHost().render(InboxCard, { card: itemToCard(plainQuestion), actions: noopActions, busy: false })
    expect(findElements(tree, 'input').length).toBeGreaterThan(0)
    expect(textOf(tree)).toContain('（默认）')
  })
})

describe('员工列表与总管私聊', () => {
  const chief = fixtureOverview.bots.find(bot => bot.role === 'chief')!
  const other = fixtureOverview.bots.find(bot => bot.role === 'researcher')!

  function groupProps(bots: BotCard[]): TeammatesGroupProps {
    return {
      expanded: true, onToggle: () => undefined, totalBots: bots.length, query: '', onQueryChange: () => undefined, view: 'main', selectedThread: '',
      bots, archivedBots: [], archivedOpen: false, onToggleArchived: () => undefined, notice: null,
      onBeginDelete: () => undefined, onSelectBot: () => undefined, onNewBot: () => undefined,
      onOpenBotForm: () => undefined, onBotFormProjectChange: () => undefined, form: null, botFormProjects: [], formBot: null, formNode: null,
    }
  }

  it('总管的角色行是「有事先找我」，名字旁有「全队入口」；其他员工沿用角色标签、没有标签', () => {
    const tree = TeammatesGroup(groupProps([chief, other]))
    const rows = findElements(tree, 'button').filter(node => classOf(node).startsWith('ah-bot-row'))
    expect(rows).toHaveLength(2)
    expect(textOf(rows[0]!)).toContain('有事先找我')
    expect(textOf(rows[0]!)).toContain('全队入口')
    expect(textOf(rows[1]!)).toContain(other.roleLabel)
    expect(textOf(rows[1]!)).not.toContain('全队入口')
    expect(textOf(rows[1]!)).not.toContain('有事先找我')
  })

  it('总管私聊的输入框占位是新文案；其他员工仍是「向 名字 发送消息…」', () => {
    const thread: ThreadView = { threadId: 'bot-x', title: '总管', messages: [], hasMore: false, oldestId: null }
    const props = (patch: Partial<Parameters<typeof ThreadPane>[0]>): Parameters<typeof ThreadPane>[0] => ({
      threadId: 'bot-x', thread, loading: false, header: null, inputPlaceholderName: '总管', banner: null, onBannerDismiss: () => undefined,
      onLoadEarlier: () => undefined, onSend: async () => undefined, actions: { onPick: async () => null }, busyInboxId: null,
      onRetry: () => undefined, error: null, onOpenSession: () => undefined, onTogglePause: () => undefined,
      onInterrupt: () => undefined, ...patch,
    })
    const chiefTree = createHookHost().render(ThreadPane, props({ chiefEntry: true }))
    expect(findElements(chiefTree, 'textarea')[0]!.props.placeholder).toBe('交代一件事。需要你拿主意的地方，总管会先和你对齐再开工。')
    const otherTree = createHookHost().render(ThreadPane, props({ inputPlaceholderName: '探路' }))
    expect(findElements(otherTree, 'textarea')[0]!.props.placeholder).toBe('向 探路 发送消息…')
  })

  it('ThreadPane：主题带约定面板时，楼层不再把第一条当主题卡片', () => {
    const topic = fixtureTopicThreads.find(thread => thread.agreement)!
    const tree = createHookHost().render(ThreadPane, {
      threadId: topic.threadId, thread: topic, loading: false, header: null, inputPlaceholderName: '队友', banner: null, onBannerDismiss: () => undefined,
      onLoadEarlier: () => undefined, onSend: async () => undefined, actions: { onPick: async () => null }, busyInboxId: null,
      onRetry: () => undefined, error: null, onOpenSession: () => undefined, onTogglePause: () => undefined,
      onInterrupt: () => undefined,
      topic: { title: topic.title, projectName: '竞品周报自动化', placeholder: 'x', readOnlyText: null, members: [], replying: [] },
    })
    const body = findElements(tree, TopicThreadBody)[0]!
    expect((body.props.model as { opening: unknown }).opening).toBeNull()
    expect(body.props.agreement).toEqual(topic.agreement)
  })

  it('总管的资料区显示默契度一行（没有 rapport 时不显示）在样例里有数据', () => {
    expect(chief.rapport?.text).toBe('默契度 17 / 20')
    expect(other.rapport).toBeUndefined()
  })
})

describe('「定了」命令的接线', () => {
  it('dispatchCommand 把 confirmAgreement 整对象交给 api.confirmAgreement', async () => {
    const calls: unknown[][] = []
    const api = { confirmAgreement: async (...args: unknown[]) => { calls.push(args); return { ok: true, data: { agreementId: 'agr_x', version: 2 } } } }
    const input = { agreementId: 'agr_signuppage', version: 2, choices: { fields: '姓名、手机号' } }
    const result = await dispatchCommand(api as never, 'confirmAgreement', input)
    expect(calls).toEqual([[input]])
    expect(result.ok).toBe(true)
  })

  it('反例：api 抛错时转成中文失败，不冒充成功', async () => {
    const api = { confirmAgreement: async () => { throw new Error('约定不存在') } }
    expect(await dispatchCommand(api as never, 'confirmAgreement', {})).toEqual({ ok: false, error: '约定不存在' })
  })

  it('离线样例：确认后约定卡变为 locked，线程多一条「定了」和一句旁白，待你处理里的约定条目消失，默契度累加', async () => {
    const hub = new FixtureHub()
    const before = await hub.thread('bot-zongguan')
    const card = before.messages.find(m => m.agreement?.state === 'pending')!.agreement!
    expect(card.canConfirm).toBe(true)
    const result = await hub.command('confirmAgreement', { agreementId: card.agreementId, version: card.versionNo, choices: { limit: '限制人数，满额后停止报名' } })
    expect(result.ok).toBe(true)

    const after = await hub.thread('bot-zongguan')
    const locked = after.messages.filter(m => m.agreement).map(m => m.agreement!).find(c => c.versionNo === 2)!
    expect(locked.state).toBe('locked')
    expect(locked.canConfirm).toBe(false)
    expect(locked.pending.find(item => item.key === 'limit')!.chosen).toBe('限制人数，满额后停止报名')
    expect(locked.adoption).toEqual({ adopted: 3, total: 4 })
    expect(locked.rapport).toEqual({ adopted: 20, total: 24 })
    expect(after.messages.at(-2)!.text).toBe('定了')
    expect(after.messages.at(-1)!.text).toContain('约定第 2 版已固定')

    // 主题第一层同步变成已固定，修订行标固定。
    const topic = await hub.thread('ptp_signup')
    expect(topic.agreement!.current.state).toBe('locked')
    expect(topic.agreement!.revisions.find(row => row.no === 2)!.locked).toBe(true)

    const inbox = await hub.inbox()
    expect(inbox.items.some(item => item.agreementId)).toBe(false)
    const overview = await hub.overview()
    expect(overview.inbox.total).toBe(fixtureOverview.inbox.total - 1)
    expect(overview.bots.find(bot => bot.role === 'chief')!.rapport?.text).toBe('默契度 20 / 24')
  })

  it('离线样例：待你处理里点「按建议，定了」等同于全部采纳；再点一次报错不重复固定', async () => {
    const hub = new FixtureHub()
    const item = (await hub.inbox()).items.find(entry => entry.agreementId)!
    expect((await hub.command('answerInbox', { id: item.id, answer: '按建议，定了' })).ok).toBe(true)
    const locked = (await hub.thread('bot-zongguan')).messages.map(m => m.agreement).find(c => c?.versionNo === 2)!
    expect(locked.state).toBe('locked')
    expect(locked.adoption).toEqual({ adopted: 4, total: 4 })
    const again = await hub.command('confirmAgreement', { agreementId: item.agreementId, version: 2 })
    expect(again.ok).toBe(false)
  })

  it('离线样例：版本不对、约定不存在、被取代的旧版都给中文错误', async () => {
    const hub = new FixtureHub()
    expect(await hub.command('confirmAgreement', { agreementId: 'agr_nothing000', version: 1 })).toEqual({ ok: false, error: 'agreementId：约定不存在' })
    expect((await hub.command('confirmAgreement', { agreementId: 'agr_signuppage', version: 1 })).ok).toBe(false)
    expect(await hub.command('confirmAgreement', { agreementId: 'agr_signuppage', version: 0 })).toEqual({ ok: false, error: 'version：必须是大于等于 1 的整数' })
  })
})

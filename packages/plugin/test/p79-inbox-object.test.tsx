/**
 * P79 的测试：「待你处理」里每一条都能当场表示不同意并写一句话。
 *
 * 覆盖：
 * - 第 1 至 3 节：约定确认、组队确认、验收、说明卡四种条目的次要按钮（要修改、有不符、都不合适）：
 *   哪些条目有、发到哪条对话、输入框的名称与占位文字、空输入时「发送」不可点、发送调用的线程编号与文字、
 *   成功后的提示与条目上多出的一行、条目仍在、确认按钮仍可点、失败时错误显示且草稿保留、取消清掉草稿；
 * - 第 4 节（界面一侧）：提议的附言输入框，点「接受」「不做」时附言都交给了核心（核心一侧在 core 的
 *   p79-proposal-note.test.ts）；审批条目的行为与改动前相同；
 * - 第 5 节：审批批准之后的提示写执行的那一位（卡上「由……执行」）；
 * - 别的类型的条目（普通提问、告警、没有进展、回合用到上限等）没有多出按钮。
 *
 * 测试环境没有真 React：只渲染传进来的这一个组件，子组件不执行（见 helpers/hook-host.ts）。
 * 所以「条目上有没有次要按钮」看 InboxPane 的树里有没有 ObjectionHost 元素，
 * 「点开之后的样子」直接渲染 ObjectionHost 来测。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { InboxCard } from '../src/client/components/Cards.js'
import { EscalationCard } from '../src/client/components/JobCard.js'
import { InboxPane, itemToCard } from '../src/client/components/InboxPane.js'
import { ObjectionHost } from '../src/client/components/InboxObjection.js'
import { cardSubmission, type CardPayload } from '../src/client/logic/cards.js'
import { inboxHandledNotice } from '../src/client/logic/inbox-notice.js'
import { OBJECTION_TEXT, clearSentLines, objectionKey, objectionOf, type ObjectionSpec } from '../src/client/logic/inbox-objection.js'
import { fixtureInbox } from '../src/shared/fixtures.js'
import { sampleApprovalInboxEntries, sampleJobInboxEntries } from '../src/shared/fixture-job.js'
import type { InboxItemView } from '../src/shared/views.js'
import { createHookHost } from './helpers/hook-host.js'
import { findElements, type StubElement } from './helpers/jsx-runtime-stub.js'

vi.mock('react', async () => (await import('./helpers/hook-host.js')).reactFacade)

// ---------- 小工具 ----------

function textOf(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object' && node !== null && 'props' in node) return textOf((node as StubElement).props.children)
  return ''
}
const buttons = (tree: unknown): StubElement[] => findElements(tree, 'button')
const buttonByText = (tree: unknown, text: string): StubElement | undefined => buttons(tree).find(node => textOf(node) === text)
const inputsOf = (tree: unknown): StubElement[] => findElements(tree, 'input')
/** 让已经发出的 Promise 回调都跑完。 */
const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

/** 取固定样例里的条目。 */
const fixtureItem = (id: string): InboxItemView => {
  const found = fixtureInbox.items.find(item => item.id === id)
  if (found === undefined) throw new Error(`样例里没有条目 ${id}`)
  return found
}
const agreementWithTopic = fixtureItem('inbox-agr1')
const agreementNoTopic: InboxItemView = { ...agreementWithTopic, id: 'i_agr_notopic', topicId: null, topicTitle: null }
const teamItem = fixtureItem('inbox-team-add')
const proposalItem = fixtureItem('inbox-p1')
const [acceptItem, escalateItem, capItem, stallItem] = sampleJobInboxEntries as [InboxItemView, InboxItemView, InboxItemView, InboxItemView]
const approvalItems = sampleApprovalInboxEntries as InboxItemView[]

const noopActions = { onPick: async () => null }

beforeEach(() => clearSentLines())

// ---------- 哪些条目有次要按钮、发到哪条对话 ----------

describe('objectionOf：哪些条目有次要按钮，话发到哪条对话', () => {
  it('约定确认：总管的私聊（有主题编号和没有主题编号的都是），文字是「要修改」那一组', () => {
    // 约定卡发在 originThread（总管私聊），条目虽带主题编号也发私聊；依据见 logic/inbox-objection.ts 开头。
    expect(agreementWithTopic.topicId).toBeTruthy()
    // P74i-m4（第 3 节）：结果多一项 prefix（话前面由界面拼的「（关于……）」），逐字断言在 p74i-m4-fixes.test.tsx。
    // P74i-m5（第 1 节）改了预期：样例条目带 agreementTitle，前缀由「（关于{条目标题}）」改为「（关于约定「{约定标题}」第 {版本号} 版）」。
    expect(objectionOf(agreementWithTopic)).toEqual({ spec: OBJECTION_TEXT.agreement, threadId: agreementWithTopic.botId, prefix: '（关于约定「活动报名页」第 2 版）' })
    expect(objectionOf(agreementNoTopic)).toEqual({ spec: OBJECTION_TEXT.agreement, threadId: agreementNoTopic.botId, prefix: '（关于约定「活动报名页」第 2 版）' })
  })

  it('组队确认：总管的私聊', () => {
    expect(objectionOf(teamItem)).toEqual({ spec: OBJECTION_TEXT.agreement, threadId: teamItem.botId, prefix: '（关于组队方案）' })
  })

  it('验收：这件事的主题；没有主题编号时没有按钮', () => {
    expect(objectionOf(acceptItem)).toEqual({ spec: OBJECTION_TEXT.accept, threadId: acceptItem.topicId, prefix: '' })
    expect(objectionOf({ ...acceptItem, topicId: null })).toBeNull()
    expect(objectionOf({ ...acceptItem, topicId: '' })).toBeNull()
  })

  it('说明卡：还可以选的卡发总管私聊；已选过或已失效的卡没有按钮；没有卡视图也没有', () => {
    const card = escalateItem.escalationCard!
    expect(card.chosen).toBeNull()
    expect(objectionOf(escalateItem)).toEqual({ spec: OBJECTION_TEXT.escalate, threadId: escalateItem.botId, prefix: `（关于${escalateItem.title}）` })
    expect(objectionOf({ ...escalateItem, escalationCard: { ...card, chosen: 'A', selectable: false } })).toBeNull()
    expect(objectionOf({ ...escalateItem, escalationCard: { ...card, selectable: false } })).toBeNull()
    expect(objectionOf({ ...escalateItem, escalationCard: null })).toBeNull()
  })

  it('别的类型没有：回合用到上限、没有进展、普通提问、审批、提议、告警', () => {
    const question = fixtureItem('inbox-q1')
    const alert = { ...question, id: 'i_alert', type: 'alert' as const, typeLabel: '告警', options: ['知道了'] }
    for (const item of [capItem, stallItem, question, alert, proposalItem, ...approvalItems, fixtureItem('inbox-a1')]) {
      expect(objectionOf(item), item.id).toBeNull()
    }
  })

  it('记忆键 = 条目编号 + 版本号：新一版出来后键不同', () => {
    expect(objectionKey(agreementWithTopic)).not.toBe(objectionKey({ ...agreementWithTopic, agreementVersion: (agreementWithTopic.agreementVersion ?? 0) + 1 }))
    expect(objectionKey(agreementWithTopic)).not.toBe(objectionKey({ ...agreementWithTopic, id: 'i_other' }))
  })
})

// ---------- 点开之后的样子（四种条目各一组，文字逐字） ----------

const specs: Array<[string, ObjectionSpec, { button: string; field: string; pending: string; notice: string }]> = [
  ['约定确认、组队确认', OBJECTION_TEXT.agreement, {
    // P74i-m4（第 1 节）：「已提出……」一行与成功提示只写主人做过的事，不预告别人的下一步。
    button: '要修改', field: '哪里要改，写一句', pending: '你已提出修改。',
    notice: '已把这句话发给总管。',
  }],
  ['验收', OBJECTION_TEXT.accept, {
    button: '有不符', field: '第几条、什么问题', pending: '你已指出不符。',
    notice: '已发到这件事的主题里。',
  }],
  ['说明卡', OBJECTION_TEXT.escalate, {
    button: '都不合适', field: '哪里不合适，写一句', pending: '你已说明都不合适。',
    notice: '已把这句话发给总管。',
  }],
]

/** 渲染一个 ObjectionHost：把按钮和输入区摆在同一个容器里，返回树。 */
function renderHost(host: ReturnType<typeof createHookHost>, props: { spec: ObjectionSpec; itemKey: string; send: (text: string) => Promise<string | null>; onSent: (notice: string) => void }): unknown {
  return host.render(ObjectionHost, {
    ...props,
    children: ({ button, panel }) => ({ type: 'div', props: { children: [button, panel] }, key: null }) as never,
  })
}

describe.each(specs)('%s：次要按钮与输入框', (_name, spec, words) => {
  it('文字逐字：按钮、输入框的名称与占位文字；点开前没有输入框，空输入时「发送」不可点，「取消」可点', () => {
    const host = createHookHost()
    const props = { spec, itemKey: 'k1', send: async () => null, onSent: () => undefined }
    const closed = renderHost(host, props)
    expect(buttons(closed).map(textOf)).toEqual([words.button])
    expect(inputsOf(closed)).toHaveLength(0)
    ;(buttonByText(closed, words.button)!.props.onClick as () => void)()
    const open = renderHost(host, props)
    const input = inputsOf(open)[0]!
    expect(input.props['aria-label']).toBe(words.field)
    expect(input.props.placeholder).toBe(words.field)
    expect(buttons(open).map(textOf)).toEqual([words.button, '发送', '取消'])
    expect(buttonByText(open, '发送')!.props.disabled).toBe(true)
    expect(buttonByText(open, '取消')!.props.disabled).toBe(false)
    // 只有空白也算空：发送仍不可点。
    ;(input.props.onChange as (e: unknown) => void)({ target: { value: '   ' } })
    expect(buttonByText(renderHost(host, props), '发送')!.props.disabled).toBe(true)
  })

  it('发送：把去掉首尾空白的话交给 send；成功后收起输入框、草稿清掉、条目上多一行、通知上层显示提示', async () => {
    const host = createHookHost()
    const send = vi.fn(async () => null)
    const onSent = vi.fn()
    const props = { spec, itemKey: 'k2', send, onSent }
    ;(buttonByText(renderHost(host, props), words.button)!.props.onClick as () => void)()
    const open = renderHost(host, props)
    ;(inputsOf(open)[0]!.props.onChange as (e: unknown) => void)({ target: { value: '  第 2 条不对  ' } })
    const typed = renderHost(host, props)
    expect(buttonByText(typed, '发送')!.props.disabled).toBe(false)
    ;(buttonByText(typed, '发送')!.props.onClick as () => void)()
    await flush()
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('第 2 条不对')
    expect(onSent).toHaveBeenCalledWith(words.notice)
    const after = renderHost(host, props)
    expect(inputsOf(after)).toHaveLength(0)
    expect(textOf(after)).toContain(words.pending)
    // 再点开：草稿已清掉。
    ;(buttonByText(after, words.button)!.props.onClick as () => void)()
    expect(inputsOf(renderHost(host, props))[0]!.props.value).toBe('')
  })

  it('发送失败：错误显示、输入框和草稿都保留，可以再发；再发成功后正常收起', async () => {
    const host = createHookHost()
    const send = vi.fn<(text: string) => Promise<string | null>>().mockResolvedValueOnce('连接中断。点击重试。').mockResolvedValueOnce(null)
    const onSent = vi.fn()
    const props = { spec, itemKey: 'k3', send, onSent }
    ;(buttonByText(renderHost(host, props), words.button)!.props.onClick as () => void)()
    ;(inputsOf(renderHost(host, props))[0]!.props.onChange as (e: unknown) => void)({ target: { value: '改一下' } })
    ;(buttonByText(renderHost(host, props), '发送')!.props.onClick as () => void)()
    await flush()
    const failed = renderHost(host, props)
    expect(findElements(failed, 'p').some(node => node.props.role === 'alert' && textOf(node) === '连接中断。点击重试。')).toBe(true)
    expect(inputsOf(failed)[0]!.props.value).toBe('改一下')
    expect(inputsOf(failed)[0]!.props.disabled).toBe(false)
    expect(onSent).not.toHaveBeenCalled()
    expect(textOf(failed)).not.toContain(words.pending)
    // 再发一次：成功。
    ;(buttonByText(failed, '发送')!.props.onClick as () => void)()
    await flush()
    expect(send).toHaveBeenCalledTimes(2)
    expect(onSent).toHaveBeenCalledWith(words.notice)
    expect(inputsOf(renderHost(host, props))).toHaveLength(0)
  })

  it('发送出现意外异常也按失败处理：错误显示、草稿保留', async () => {
    const host = createHookHost()
    const props = { spec, itemKey: 'k3b', send: async () => { throw new Error('走查模拟：发送失败') }, onSent: () => undefined }
    ;(buttonByText(renderHost(host, props), words.button)!.props.onClick as () => void)()
    ;(inputsOf(renderHost(host, props))[0]!.props.onChange as (e: unknown) => void)({ target: { value: '改一下' } })
    ;(buttonByText(renderHost(host, props), '发送')!.props.onClick as () => void)()
    await flush()
    const failed = renderHost(host, props)
    expect(textOf(failed)).toContain('走查模拟：发送失败')
    expect(inputsOf(failed)[0]!.props.value).toBe('改一下')
  })

  it('取消：收起输入框并清掉草稿，没有发送', () => {
    const host = createHookHost()
    const send = vi.fn(async () => null)
    const props = { spec, itemKey: 'k4', send, onSent: () => undefined }
    ;(buttonByText(renderHost(host, props), words.button)!.props.onClick as () => void)()
    ;(inputsOf(renderHost(host, props))[0]!.props.onChange as (e: unknown) => void)({ target: { value: '写了一半' } })
    ;(buttonByText(renderHost(host, props), '取消')!.props.onClick as () => void)()
    const closed = renderHost(host, props)
    expect(inputsOf(closed)).toHaveLength(0)
    expect(send).not.toHaveBeenCalled()
    ;(buttonByText(closed, words.button)!.props.onClick as () => void)()
    expect(inputsOf(renderHost(host, props))[0]!.props.value).toBe('')
  })

  it('「已提出……」那一行按条目编号加版本号记：同一版重新挂载仍在，新一版（键不同）不显示', async () => {
    const send = async (): Promise<string | null> => null
    const first = createHookHost()
    const props = { spec, itemKey: 'item_a:2', send, onSent: () => undefined }
    ;(buttonByText(renderHost(first, props), words.button)!.props.onClick as () => void)()
    ;(inputsOf(renderHost(first, props))[0]!.props.onChange as (e: unknown) => void)({ target: { value: '改一下' } })
    ;(buttonByText(renderHost(first, props), '发送')!.props.onClick as () => void)()
    await flush()
    // 页面离开再回来（重新挂载）：这一行还在。
    expect(textOf(renderHost(createHookHost(), props))).toContain(words.pending)
    // 约定改出新一版（版本号变了）：不再显示。
    expect(textOf(renderHost(createHookHost(), { ...props, itemKey: 'item_a:3' }))).not.toContain(words.pending)
  })
})

// ---------- 经过 InboxPane：每种条目发到哪条对话、条目仍在、确认按钮仍可点 ----------

/** 渲染「待你处理」，返回宿主、属性与第一轮的树。 */
function renderPane(items: InboxItemView[], onSendMessage?: (threadId: string, text: string) => Promise<string | null>): {
  host: ReturnType<typeof createHookHost>
  props: Parameters<typeof InboxPane>[0]
  tree: unknown
} {
  const host = createHookHost()
  const props = {
    inbox: { items }, loading: false, error: null, onRetry: () => undefined,
    actions: noopActions, busyId: null, onOpenThread: () => undefined,
    ...(onSendMessage !== undefined ? { onSendMessage } : {}),
  }
  return { host, props, tree: host.render(InboxPane, props) }
}

describe('经过 InboxPane：四种条目各自发到哪条对话', () => {
  it.each<[string, InboxItemView, string, string]>([
    ['约定确认（有主题编号）：总管私聊', agreementWithTopic, agreementWithTopic.botId!, '（关于约定「活动报名页」第 2 版）'],
    ['约定确认（没有主题编号）：总管私聊', agreementNoTopic, agreementNoTopic.botId!, '（关于约定「活动报名页」第 2 版）'],
    ['组队确认：总管私聊', teamItem, teamItem.botId!, '（关于组队方案）'],
    ['验收：这件事的主题（话前不加说明）', acceptItem, acceptItem.topicId!, ''],
    ['说明卡：总管私聊', escalateItem, escalateItem.botId!, `（关于${escalateItem.title}）`],
  ])('%s', async (_name, item, expectedThread, expectedPrefix) => {
    const onSendMessage = vi.fn(async () => null)
    const { host, props, tree } = renderPane([item], onSendMessage)
    const hosts = findElements(tree, ObjectionHost)
    expect(hosts).toHaveLength(1)
    // 发送时调用的线程编号和文字（P74i-m4 第 3 节：发到总管私聊的三种在话前带上界面拼的说明）。
    await (hosts[0]!.props.send as (text: string) => Promise<string | null>)('哪里要改')
    expect(onSendMessage).toHaveBeenCalledWith(expectedThread, `${expectedPrefix}哪里要改`)
    // 成功后：页面顶上出现这一组的成功提示，带去那条对话的「查看会话」。
    ;(hosts[0]!.props.onSent as (notice: string) => void)(objectionOf(item)!.spec.successNotice)
    const after = host.render(InboxPane, props)
    const done = findElements(after, 'div').find(node => node.props.className === 'ah-inbox-done')
    expect(textOf(done)).toContain(objectionOf(item)!.spec.successNotice)
    // 条目仍在：卡片还在树里，确认按钮没有被禁用（busy 仍为 false）。
    // 卡片在 ObjectionHost 的渲染函数里（这个测试环境不执行子组件），把它展开来看。
    const afterHost = findElements(after, ObjectionHost)[0]!
    const rendered = (afterHost.props.children as (parts: { button: unknown; panel: unknown }) => unknown)({ button: 'BTN', panel: 'PANEL' })
    const card = findElements(rendered, item.escalationCard != null ? EscalationCard : InboxCard)[0]
    expect(card).toBeDefined()
    // 说明卡本身没有 busy（它自己管提交状态）；普通卡的 busy 为 false：确认按钮仍可点。
    expect(card!.props.busy ?? false).toBe(false)
  })

  it('次要按钮交给卡片放在确认按钮旁边：普通卡走 extra，说明卡走 extraAction', () => {
    const { tree } = renderPane([agreementWithTopic, escalateItem], async () => null)
    const hosts = findElements(tree, ObjectionHost)
    expect(hosts).toHaveLength(2)
    for (const entry of hosts) {
      const rendered = (entry.props.children as (parts: { button: unknown; panel: unknown }) => unknown)({ button: 'BTN', panel: 'PANEL' })
      const cards = findElements(rendered, InboxCard)
      const escalations = findElements(rendered, EscalationCard)
      if (cards.length > 0) expect(cards[0]!.props.extra).toBe('BTN')
      else expect(escalations[0]!.props.extraAction).toBe('BTN')
      expect(textOf(rendered)).toContain('PANEL')
    }
  })

  it('没有接线发送（不传 onSendMessage）时，四种条目都不多出按钮', () => {
    const { tree } = renderPane([agreementWithTopic, teamItem, acceptItem, escalateItem])
    expect(findElements(tree, ObjectionHost)).toHaveLength(0)
    for (const card of findElements(tree, InboxCard)) expect(card.props.extra).toBeNull()
  })

  it('别的类型的条目没有多出按钮：提问、回合用到上限、没有进展、告警、提议、审批', () => {
    const question = fixtureItem('inbox-q1')
    const alert = { ...question, id: 'i_alert', type: 'alert' as const, typeLabel: '告警', options: ['知道了'] }
    const { tree } = renderPane([question, capItem, stallItem, alert, proposalItem, ...approvalItems], async () => null)
    expect(findElements(tree, ObjectionHost)).toHaveLength(0)
    for (const card of findElements(tree, InboxCard)) expect(card.props.extra).toBeNull()
  })

  it('混合列表里只有四种条目各一个按钮，已选过或失效的说明卡没有', () => {
    const chosen = { ...escalateItem, id: 'i_esc_chosen', escalationCard: { ...escalateItem.escalationCard!, chosen: 'A', selectable: false } }
    const { tree } = renderPane([agreementWithTopic, teamItem, acceptItem, escalateItem, chosen, capItem, stallItem, proposalItem], async () => null)
    expect(findElements(tree, ObjectionHost)).toHaveLength(4)
  })

  it('验收条目没有主题编号时没有「有不符」', () => {
    const { tree } = renderPane([{ ...acceptItem, topicId: null }], async () => null)
    expect(findElements(tree, ObjectionHost)).toHaveLength(0)
  })
})

// ---------- 提议的附言（界面一侧） ----------

/** 取一张带「接受」「不做」按钮的提议卡。 */
const proposalCard: CardPayload = { ...itemToCard(proposalItem), options: ['接受', '不做'], defaultOption: null }

describe('提议的附言输入框', () => {
  it('附言输入框存在：可达名称「附言（可不填）」、占位文字「附一句话（可不填）」', () => {
    const tree = createHookHost().render(InboxCard, { card: proposalCard, actions: noopActions, busy: false })
    const note = inputsOf(tree).find(node => node.props.className === 'ah-card-note')!
    expect(note.props['aria-label']).toBe('附言（可不填）')
    expect(note.props.placeholder).toBe('附一句话（可不填）')
    expect(buttons(tree).map(textOf)).toEqual(['接受', '不做'])
  })

  it.each([['不做', '这个方向先放一放'], ['接受', '可以，先核对来源']])('点「%s」时附言一并交出去', async (option, noteText) => {
    const onPick = vi.fn(async () => null)
    const host = createHookHost()
    const props = { card: proposalCard, actions: { onPick }, busy: false }
    const first = host.render(InboxCard, props)
    ;(inputsOf(first).find(node => node.props.className === 'ah-card-note')!.props.onChange as (e: unknown) => void)({ target: { value: noteText } })
    const typed = host.render(InboxCard, props)
    ;(buttonByText(typed, option)!.props.onClick as () => void)()
    expect(onPick).toHaveBeenCalledWith(proposalCard, option, noteText)
  })

  it('空附言照常：点「不做」「接受」仍然交出去（附言为空）', () => {
    for (const option of ['不做', '接受']) {
      const onPick = vi.fn(async () => null)
      const tree = createHookHost().render(InboxCard, { card: proposalCard, actions: { onPick }, busy: false })
      ;(buttonByText(tree, option)!.props.onClick as () => void)()
      expect(onPick).toHaveBeenCalledWith(proposalCard, option, '')
    }
  })

  it('提交规则：有附言时 answerInbox 带 note（去掉首尾空白），没有或只有空白时与改动前一样不带', () => {
    expect(cardSubmission(proposalCard, '不做', '  先放一放 ')).toEqual({ name: 'answerInbox', input: { id: proposalCard.inboxId, answer: '不做', note: '先放一放' } })
    expect(cardSubmission(proposalCard, '不做', '')).toEqual({ name: 'answerInbox', input: { id: proposalCard.inboxId, answer: '不做' } })
    expect(cardSubmission(proposalCard, '接受', '   ')).toEqual({ name: 'answerInbox', input: { id: proposalCard.inboxId, answer: '接受' } })
    expect(cardSubmission(proposalCard, '接受')).toEqual({ name: 'answerInbox', input: { id: proposalCard.inboxId, answer: '接受' } })
    // 非提议（提问）即使带了 note 也不进命令：行为不变。
    const question = itemToCard(fixtureItem('inbox-q1'))
    expect(cardSubmission(question, question.options[0]!, '多余')).toEqual({ name: 'answerInbox', input: { id: question.inboxId, answer: question.options[0] } })
  })

  it('审批条目的行为与改动前相同：只有「审批附言（可不填）」一个附言框，批准时附言交出去；提问不交附言', () => {
    const approvalCard = itemToCard(approvalItems[0]!)
    const onPick = vi.fn(async () => null)
    const host = createHookHost()
    const props = { card: approvalCard, actions: { onPick }, busy: false }
    const first = host.render(InboxCard, props)
    const notes = inputsOf(first).filter(node => node.props.className === 'ah-card-note')
    expect(notes).toHaveLength(1)
    expect(notes[0]!.props['aria-label']).toBe('审批附言（可不填）')
    ;(notes[0]!.props.onChange as (e: unknown) => void)({ target: { value: '注意范围' } })
    ;(buttonByText(host.render(InboxCard, props), '批准')!.props.onClick as () => void)()
    expect(onPick).toHaveBeenCalledWith(approvalCard, '批准', '注意范围')
    // 提问：不带附言（第三个参数是 undefined），也没有附言框。
    const question = itemToCard(fixtureItem('inbox-q1'))
    const onPickQ = vi.fn(async () => null)
    const qTree = createHookHost().render(InboxCard, { card: question, actions: { onPick: onPickQ }, busy: false })
    expect(inputsOf(qTree).some(node => node.props.className === 'ah-card-note')).toBe(false)
    ;(buttons(qTree)[0]!.props.onClick as () => void)()
    expect(onPickQ).toHaveBeenCalledWith(question, question.options[0], undefined)
  })
})

// ---------- 第 5 节：批准之后的提示写执行的那一位 ----------

// P74i-m5（第 3 节）改了预期：本组原来断言「下一步：{执行者}执行……」，提示不再预告别人的下一步，
// 有无「由……执行」一行、有无员工名，批准之后的提示都只写结果。
describe('第 5 节：审批批准之后的提示只写结果（P79 原为写卡上「由……执行」的那一位）', () => {
  const normal = approvalItems.find(item => item.approval?.launch !== true)!
  const launch = approvalItems.find(item => item.approval?.launch === true)!

  it('样例前提：条目归在总管名下，卡上写「由林舟执行」', () => {
    expect(normal.botName).toBe('总管')
    expect(normal.approval?.onBehalfOf).toBe('由林舟执行')
    expect(launch.botName).toBe('总管')
    expect(launch.approval?.onBehalfOf).toBe('由林舟执行')
  })

  it('普通审批批准：已批准。', () => {
    expect(inboxHandledNotice(normal, '批准')).toBe('已批准。')
  })

  it('发布审批批准：已批准发布。', () => {
    expect(inboxHandledNotice(launch, '批准')).toBe('已批准发布。')
  })

  it('有没有「由……执行」这一行、有没有员工名，批准之后的提示都一样；拒绝的两句不受影响', () => {
    const plain = { ...normal, approval: { ...normal.approval!, onBehalfOf: null } }
    expect(inboxHandledNotice(plain, '批准')).toBe('已批准。')
    expect(inboxHandledNotice({ ...launch, approval: { ...launch.approval!, onBehalfOf: null } }, '批准')).toBe('已批准发布。')
    expect(inboxHandledNotice({ ...plain, botName: null }, '批准')).toBe('已批准。')
    expect(inboxHandledNotice({ ...normal, botName: null }, '批准')).toBe('已批准。')
    expect(inboxHandledNotice(normal, '拒绝')).toBe('已拒绝，这一步不会执行。')
    expect(inboxHandledNotice(launch, '拒绝')).toBe('已选择暂不发布，这次不会发布。')
  })
})
